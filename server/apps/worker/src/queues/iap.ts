import {
  deferPurchaseCheck,
  entitlementRows,
  overduePurchaseChecks,
  owedPurchaseActions,
  purchaseById,
  recomputeSubscription,
  recordStoreAction,
  uncheckedExpiredPurchases,
  type DuePurchase,
} from '@app/db';
import { storeEventSource, store as storeCodes, userChannel, type AppStore } from '@app/shared';
import {
  ackJobSchema,
  consumeJobSchema,
  entitlementEnvelope,
  entitlementsChanged,
  iapJobIds,
  isStoreError,
  recheckJobSchema,
  refundCheckJobSchema,
  retryPlan,
  revokeJobSchema,
  rtdnJobSchema,
  subEndJobSchema,
  ACK_DEADLINE_MS,
  FOLLOW_UP_ATTEMPTS,
  FOLLOW_UP_BACKOFF_MS,
  type IapJobName,
  type StoreVerifier,
} from '@app/shared/server';
import { DelayedError, type Job } from 'bullmq';
import { billingSettingsOf, purchaseCoreOf, purchaseRefOf } from '../iap/core.js';
import { takeLease } from '../lease.js';
import { requeueJob } from '../social/jobs.js';
import type { JobContext, QueueDefinition } from './types.js';

/**
 * Queue `iap` (store purchases). Every job is idempotent on its own: a
 * re-check applies the store's current state through the purchase core,
 * which writes only a change and ignores a state older than the last one
 * applied; acknowledge and consume are recorded once.
 *
 * - `ack` / `consume`: at the store until it says done (or "already"),
 *   tried again 30 s, 1, 2, 4 ... minutes later (at most 30 minutes apart)
 *   until 60 hours after the store's time of the purchase (Play's window is
 *   three days); each try waits without spending an attempt. Every failure,
 *   the database's included, goes through the same retry.
 * - `recheck` / `refund-check`: the store asked again, its answer applied
 *   (source `scheduled re-check`); a store that cannot be reached is asked
 *   again the same way for up to a day after the check was due (a refund
 *   check's due time, not when it was queued a week before). A purchase the
 *   server ended itself (revoked, replaced) is not asked again; one the
 *   store refuses is asked again in a day.
 * - `revoke`: refunded and revoked at the store (BullMQ's attempts retry it).
 * - `sub-end`: the subscription row recomputed at its expiry; the person
 *   hears `entitlement` when it changed.
 * - `rtdn`, `voided`: Google Play's own (its integration's handlers).
 * - `checks` (hourly, under a lease): what no job is waiting for any more is
 *   queued again: re-checks overdue in the database by 15 minutes (the
 *   store's renewals and ends are never lost with a job: Bazaar sends no
 *   notifications), live subscriptions whose expiry passed without a check,
 *   and acknowledgements and consumes still owed in the last 60 hours. A job
 *   of the same id that still waits is left alone; one that finished (given
 *   up, failed) is replaced. The re-checks are spread over the hour.
 *
 * The follow-up jobs carry BullMQ attempts too (a crash, a Valkey error), so
 * nothing ends on a single failure. A store without an integration in this
 * process leaves its jobs waiting (tried again later), so nothing is lost
 * while credentials are missing.
 */

export const IAP_QUEUE = 'iap';
const HOUR = 3_600_000;
export const RECHECK_RETRY_MS = 24 * HOUR;
/** A re-check the store refuses is asked again after this long (never every hour). */
export const REFUSED_RECHECK_MS = 24 * HOUR;
/** The sweep: re-checks overdue by this much are queued again. */
export const CHECKS_OVERDUE_MS = 15 * 60_000;
/** The sweep: owed actions of purchases younger than this are left to the job the purchase queued. */
const CHECKS_SETTLE_MS = 10 * 60_000;
/** The sweep spreads the re-checks it queues over this window (the next run comes an hour later). */
export const CHECKS_SPREAD_MS = 50 * 60_000;
/** A re-check the sweep queued keeps trying for at least this long after it is due. */
const CHECKS_RETRY_WINDOW_MS = 45 * 60_000;
const CHECKS_PAGE = 500;
/** At most this many rows of each kind per run; the rest waits for the next hour. */
const CHECKS_MAX = 5_000;

type Outcome = { outcome: string } & Record<string, unknown>;

function verifierOf(context: JobContext, store: AppStore): StoreVerifier | undefined {
  return context.services.iap?.verifiers[store];
}

/** Moves the running job back to delayed with its next try counted (and `extra` kept in its data), or says it is time to give up. */
async function later(job: Job, context: JobContext, tries: number, deadlineMs: number, now: number, extra: Record<string, unknown> = {}): Promise<'give_up'> {
  const plan = retryPlan(tries, now, deadlineMs);
  if (plan.action === 'give_up') return 'give_up';
  if (!context.token || typeof job.moveToDelayed !== 'function') throw new Error('iap: cannot delay the job (no lock token)');
  await job.updateData({ ...(job.data as Record<string, unknown>), ...extra, tries: tries + 1 });
  await job.moveToDelayed(plan.atMs, context.token);
  throw new DelayedError();
}

class NoIntegrationError extends Error {
  constructor(store: AppStore) {
    super(`no ${store} integration in this process; the job waits for it`);
    this.name = 'NoIntegrationError';
  }
}

function integrationOf(context: JobContext, store: AppStore): StoreVerifier {
  const verifier = verifierOf(context, store);
  if (!verifier) throw new NoIntegrationError(store);
  return verifier;
}

async function storeAction(job: Job, context: JobContext, action: 'acknowledged' | 'consumed', now: number): Promise<Outcome> {
  const { services, log } = context;
  const ack = action === 'acknowledged' ? ackJobSchema.parse(job.data) : null;
  const consume = ack ? null : consumeJobSchema.parse(job.data);
  const data: { purchaseId: string; store: AppStore; tries: number } = (ack ?? consume)!;
  const verb = action === 'acknowledged' ? 'acknowledge' : 'consume';
  // The store's time of the purchase + 60 h, carried by the job; a job without it: the row's (read below), else its own time.
  let deadlineMs: number = ack?.deadlineMs ?? consume?.deadlineMs ?? job.timestamp + ACK_DEADLINE_MS;
  try {
    const purchase = await purchaseById(services.pg, data.purchaseId);
    if (!purchase) return { outcome: 'missing' };
    if (action === 'acknowledged' ? purchase.acknowledged : purchase.consumed) return { outcome: 'already' };
    if (!ack && consume?.deadlineMs === undefined) deadlineMs = purchase.purchasedAtMs + ACK_DEADLINE_MS;
    const verifier = integrationOf(context, data.store);
    const ref = purchaseRefOf(purchase, data.store);
    const result = action === 'acknowledged' ? await verifier.acknowledge(ref) : await verifier.consume(ref);
    await recordStoreAction(services.pg, { purchaseId: purchase.id, action, eventId: services.ids.nextId(), source: storeEventSource.code('recheck') });
    return { outcome: result };
  } catch (error) {
    if (error instanceof DelayedError) throw error;
    if (isStoreError(error, 'invalid')) {
      log.error({ err: error, purchaseId: data.purchaseId }, `iap: the store refuses the ${action === 'acknowledged' ? 'acknowledgement' : 'consume'}`);
      return { outcome: 'refused' };
    }
    log.warn({ err: error, purchaseId: data.purchaseId, tries: data.tries }, `iap: ${verb} failed; trying again`);
    if ((await later(job, context, data.tries, deadlineMs, now)) === 'give_up') {
      log.error({ purchaseId: data.purchaseId }, `iap: gave up on the ${action === 'acknowledged' ? 'acknowledgement' : 'consume'} at the deadline`);
      return { outcome: 'gave_up' };
    }
    throw error;
  }
}

/** States the server ended itself (revoked, replaced): the store is not asked about them again. */
const SERVER_FINAL = new Set([8, 9]);

async function recheck(job: Job, context: JobContext, now: number): Promise<Outcome> {
  const { services, log } = context;
  const scheduled = job.name === 'recheck' ? recheckJobSchema.parse(job.data) : null;
  const refund = scheduled ? null : refundCheckJobSchema.parse(job.data);
  const data: { purchaseId: string; store: AppStore } = (scheduled ?? refund)!;
  const tries = Number((job.data as { tries?: unknown }).tries ?? 0) || 0;
  // When the check was due: a refund check is queued a week before it runs, so its retry window starts at its due time.
  const dueMs: number = scheduled?.atMs ?? refund?.atMs ?? job.timestamp + (job.opts?.delay ?? 0);
  const untilMs = scheduled?.untilMs ?? dueMs + RECHECK_RETRY_MS;
  try {
    const purchase = await purchaseById(services.pg, data.purchaseId);
    if (!purchase) return { outcome: 'missing' };
    if (SERVER_FINAL.has(purchase.state)) return { outcome: 'final', state: purchase.state };
    const verifier = integrationOf(context, data.store);
    const verified = await verifier.recheck(purchaseRefOf(purchase, data.store));
    const settings = await billingSettingsOf(services, context.redis, log).get();
    const applied = await purchaseCoreOf(context, settings).apply(verified, {
      store: data.store,
      token: purchase.token,
      callerId: null,
      source: storeEventSource.code('recheck'),
      ownerHint: purchase.userId,
    });
    return { outcome: applied.outcome, ...('state' in applied ? { state: applied.state, changed: applied.changed } : {}) };
  } catch (error) {
    if (error instanceof DelayedError) throw error;
    if (isStoreError(error, 'invalid')) {
      log.error({ err: error, purchaseId: data.purchaseId }, 'iap: the store no longer recognises a stored purchase; left as it is for a person to look at (asked again in a day)');
      await deferPurchaseCheck(services.pg, data.purchaseId, now + REFUSED_RECHECK_MS).catch((e: unknown) => log.warn({ err: e }, 'iap: refused re-check not deferred'));
      return { outcome: 'refused' };
    }
    log.warn({ err: error, purchaseId: data.purchaseId, tries }, 'iap: re-check failed; trying again');
    if ((await later(job, context, tries, untilMs, now, refund ? { atMs: dueMs } : {})) === 'give_up') {
      log.error({ purchaseId: data.purchaseId }, 'iap: re-check still failing past its retry window; the hourly sweep queues it again');
      return { outcome: 'gave_up' };
    }
    throw error;
  }
}

/** Every page of a keyset query, up to `max` rows. */
async function pages(read: (after: { atMs: number; id: string } | null) => Promise<DuePurchase[]>, max: number): Promise<DuePurchase[]> {
  const out: DuePurchase[] = [];
  let after: { atMs: number; id: string } | null = null;
  while (out.length < max) {
    const page = await read(after);
    out.push(...page);
    const last = page.at(-1);
    if (page.length < CHECKS_PAGE || !last) break;
    after = { atMs: last.atMs, id: last.id };
  }
  return out.slice(0, max);
}

/** The hourly sweep (`checks`): jobs the database says are owed but no job may be waiting for any more. */
export async function checksJob(context: JobContext, now: number): Promise<Outcome> {
  const { services, redis, config, log } = context;
  if (!(await takeLease(redis, services.keys.jobLease('iap-checks'), HOUR - 60_000, config.workerId))) return { outcome: 'leased_elsewhere' };
  const counts = { rechecks: 0, actions: 0, queued: 0, pending: 0, noIntegration: 0 };
  const storeOf = (row: DuePurchase): AppStore | null => {
    const name = storeCodes.nameOrUndefined(row.store);
    if (name !== 'play' && name !== 'bazaar') return null;
    if (!verifierOf(context, name)) {
      counts.noIntegration += 1;
      return null;
    }
    return name;
  };
  const requeue = async (name: IapJobName, id: string, data: Record<string, unknown>, delayMs: number) => {
    const out = await requeueJob(redis, config.queuePrefix, {
      queue: 'iap',
      name,
      id,
      data,
      delayMs,
      attempts: FOLLOW_UP_ATTEMPTS,
      backoffMs: FOLLOW_UP_BACKOFF_MS,
    });
    counts[out] += 1;
  };

  const overdue = await pages((after) => overduePurchaseChecks(services.pg, { beforeMs: now - CHECKS_OVERDUE_MS, after, limit: CHECKS_PAGE }), CHECKS_MAX);
  const unchecked = await uncheckedExpiredPurchases(services.pg, now - CHECKS_OVERDUE_MS, CHECKS_PAGE);
  const rechecks = [...overdue, ...unchecked];
  for (const [i, row] of rechecks.entries()) {
    const store = storeOf(row);
    if (!store) continue;
    // Spread over the hour (Bazaar's background calls are paced per minute); each keeps trying until past the delay.
    const delayMs = Math.floor((i * CHECKS_SPREAD_MS) / rechecks.length);
    const untilMs = Math.max(row.atMs + RECHECK_RETRY_MS, now + delayMs + CHECKS_RETRY_WINDOW_MS);
    await requeue('recheck', iapJobIds.recheck(row.id, row.atMs), { purchaseId: row.id, store, atMs: row.atMs, untilMs }, delayMs);
    counts.rechecks += 1;
  }

  const owed = await pages(
    (after) => owedPurchaseActions(services.pg, { fromMs: now - ACK_DEADLINE_MS, beforeMs: now - CHECKS_SETTLE_MS, after, limit: CHECKS_PAGE }),
    CHECKS_MAX,
  );
  for (const row of owed) {
    const store = storeOf(row);
    if (!store) continue;
    const data = { purchaseId: row.id, store, deadlineMs: row.atMs + ACK_DEADLINE_MS };
    if (row.kind === 1) await requeue('ack', iapJobIds.ack(row.id), data, 0);
    else await requeue('consume', iapJobIds.consume(row.id), data, 0);
    counts.actions += 1;
  }
  if (counts.queued > 0) log.warn(counts, 'iap: the hourly sweep queued store jobs again that no job was waiting for');
  return { outcome: 'swept', ...counts };
}

async function revoke(job: Job, context: JobContext): Promise<Outcome> {
  const data = revokeJobSchema.parse(job.data);
  const verifier = verifierOf(context, data.store);
  if (!verifier) throw new Error(`iap: no ${data.store} integration to revoke with`);
  try {
    const result = await verifier.revoke({
      purchaseId: null,
      store: data.store,
      kind: data.kind,
      token: data.token,
      productId: data.productId,
      basePlanId: null,
      orderId: null,
      purchasedAtMs: null,
      expiresAtMs: null,
      quantity: 1,
    });
    return { outcome: result };
  } catch (error) {
    if (isStoreError(error, 'invalid')) return { outcome: 'refused' };
    throw error;
  }
}

/** The subscription row of one store at its expiry (or a grant's start); the person hears the change. */
export async function subEndJob(job: Pick<Job, 'data'>, context: JobContext): Promise<Outcome> {
  const { services, redis, log } = context;
  const data = subEndJobSchema.parse(job.data);
  const changed = await recomputeSubscription(services.pg, data.userId, data.store);
  if (!changed) return { outcome: 'unchanged' };
  // A grant (store 0) shows in the build the person used lately: the store whose cached view exists (read before the
  // change removes them); none, nothing is sent.
  let view = data.store;
  if (view === 0) {
    const [play, bazaar] = await services.cache.mget(services.keys.entitlements(data.userId, 1), services.keys.entitlements(data.userId, 2));
    view = play ? 1 : bazaar ? 2 : 0;
  }
  // The versions this change moved to; the rows below are read after it, so a base of them is cached under exactly
  // these (a later change moves them again and the cached base is not used).
  const moved = await entitlementsChanged(redis, services.cache, services.keys, data.userId);
  if (!services.realtime || view === 0) return { outcome: 'changed', published: false };
  const settings = await billingSettingsOf(services, redis, log).get();
  const rows = await entitlementRows(services.pg, data.userId);
  const { entitlements } = await purchaseCoreOf(context, settings).view(data.userId, rows, view, settings, moved);
  if (!entitlements) return { outcome: 'changed', published: false };
  await services.realtime.publish(userChannel(services.publicIds.user.encode(data.userId)), entitlementEnvelope(services.ids.nextId(), Date.now(), entitlements, view));
  return { outcome: 'changed', published: true, store: storeCodes.nameOrUndefined(view) ?? 'grant' };
}

export function iapQueue(options: { now?: () => number } = {}): QueueDefinition<unknown, Outcome> {
  const now = () => (options.now ?? Date.now)();
  return {
    name: IAP_QUEUE,
    // Google Play's voided purchases, once a day (a run without Play credentials does nothing).
    schedules: [
      { id: 'voided', name: 'voided', repeat: { pattern: '43 4 * * *', tz: 'UTC' }, opts: { attempts: 4, backoff: { type: 'exponential', delay: 3_600_000 } } },
      // What the database says is owed and no job may be waiting for, every hour.
      { id: 'checks', name: 'checks', repeat: { pattern: '17 * * * *', tz: 'UTC' }, opts: { attempts: 3, backoff: { type: 'exponential', delay: 300_000 } } },
    ],
    async process(job, context) {
      switch (job.name) {
        case 'ack':
          return storeAction(job as Job, context, 'acknowledged', now());
        case 'consume':
          return storeAction(job as Job, context, 'consumed', now());
        case 'recheck':
        case 'refund-check':
          return recheck(job as Job, context, now());
        case 'revoke':
          return revoke(job as Job, context);
        case 'sub-end':
          return subEndJob(job, context);
        case 'rtdn': {
          const data = rtdnJobSchema.parse(job.data);
          const handler = context.services.iap?.rtdn;
          if (!handler) throw new Error('iap: no Google Play integration handles notifications in this process');
          return { outcome: 'handled', ...(await handler(data, context)) };
        }
        case 'voided': {
          const handler = context.services.iap?.voided;
          if (!handler) return { outcome: 'skipped', reason: 'no_play_integration' };
          return { outcome: 'handled', ...(await handler(context)) };
        }
        case 'checks':
          return checksJob(context, now());
        default:
          throw new Error(`the iap queue has no job named "${job.name}"`);
      }
    },
  };
}
