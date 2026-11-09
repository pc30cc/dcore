import { purchaseByToken, type KnownPurchase } from '@app/db';
import { storeEventSource } from '@app/shared';
import {
  PlayDeveloperApi,
  PlayStoreVerifier,
  decodeRtdn,
  isStoreError,
  subscriptionNotificationType,
  tokenHash,
  voidedRefundType,
  type RtdnJob,
  type VerifiedPurchase,
} from '@app/shared/server';
import { takeLease } from '../lease.js';
import type { JobContext } from '../queues/types.js';
import { billingSettingsOf, purchaseCoreOf } from './core.js';
import type { IapIntegration, IapIntegrationFactory } from './verifiers.js';

/**
 * Google Play in the worker: the same `StoreVerifier` as the API (the
 * core's ack, consume, re-check and revoke jobs use it), plus the two jobs
 * only Play has.
 *
 * `rtdn` (one per Pub/Sub message, deduplicated by the API): the
 * notification names a token; the purchase is read from the Developer API
 * (`subscriptionsv2` or `productsv2`, one call) and applied through the
 * purchase core: one statement, which writes only a change and ignores a
 * state older than the last one applied. A REVOKED notification turns the
 * EXPIRED state into `revoked`; a voided purchase is reversed (below).
 *
 * `voided` (daily, under a lease): `voidedpurchases.list` with
 * subscriptions (`type=1`) from the last window's end (less two hours of
 * overlap, at most 30 days back) to now; every entry is applied as a
 * voided purchase. The window's end is kept in `iap:vd:wm` once a run had
 * no failure.
 *
 * A voided purchase: the stored row is looked up by its token (one read; a
 * token never stored was never granted, nothing to do; an already revoked
 * one is left alone). A consumable becomes `revoked`, and the core takes
 * the credit back once, never below zero. A subscription becomes `revoked`
 * when the voided order is its latest one (the paid period was refunded);
 * an earlier renewal's refund leaves Google's current state in place. A
 * quantity-based partial refund is not reversed (multi-quantity purchases
 * are off) and is logged for a person to look at.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Google refuses a start older than 30 days and an end after its own now. */
const VOIDED_LOOKBACK_MS = 30 * DAY - 10 * 60_000;
const VOIDED_OVERLAP_MS = 2 * HOUR;
const VOIDED_END_MARGIN_MS = 60_000;
const VOIDED_MAX_PAGES = 50;
const VOIDED_LEASE_MS = 30 * 60_000;

type Source = 'rtdn' | 'voided';

export interface VoidedEntry {
  token: string;
  orderId: string | null;
  refundType: number | null;
}

/** A stored purchase as a verified state (when Google no longer answers for its token). */
function fromRow(row: KnownPurchase, state: VerifiedPurchase['state'], nowMs: number): VerifiedPurchase {
  const subscription = row.kind === 1;
  return {
    kind: subscription ? 'subscription' : 'consumable',
    productId: row.productId,
    basePlanId: row.basePlanId,
    state,
    purchasedAtMs: row.purchasedAtMs,
    expiresAtMs: row.expiresAtMs,
    autoRenew: subscription ? false : null,
    accountRef: null,
    orderId: row.orderId,
    linkedPurchaseToken: null,
    quantity: row.quantity,
    isTest: false,
    region: null,
    acknowledged: row.acknowledged,
    consumed: row.consumed,
    eventMs: nowMs,
    amount: null,
    nextCheckAtMs: null,
    refundCheckAtMs: null,
    needsAcknowledge: false,
    needsConsume: false,
  };
}

export class PlayJobs {
  constructor(
    readonly verifier: PlayStoreVerifier,
    private readonly packageName: string,
    private readonly now: () => number = Date.now,
  ) {}

  integration(): IapIntegration {
    return { verifier: this.verifier, rtdn: (job, context) => this.rtdn(job, context), voided: (context) => this.voided(context) };
  }

  async rtdn(job: RtdnJob, context: JobContext): Promise<Record<string, unknown>> {
    const { log } = context;
    const decoded = decodeRtdn(job.data);
    if (!decoded) {
      log.warn({ messageId: job.messageId }, 'play rtdn: not a developer notification; dropped');
      return { result: 'undecodable' };
    }
    if (decoded.packageName !== this.packageName) return { result: 'other_package' };
    const event = decoded.event;
    switch (event.kind) {
      case 'subscription': {
        const revoked = event.notificationType === subscriptionNotificationType.REVOKED ? 'if_expired' : undefined;
        return this.applyRead(context, event.token, 'rtdn', async () => (await this.verifier.subscription(event.token, { revoked })).verified);
      }
      case 'one_time':
        return this.applyRead(context, event.token, 'rtdn', async () => (await this.verifier.product(event.token, { productId: event.productId ?? undefined })).verified);
      case 'voided':
        return this.applyVoided(context, { token: event.token, orderId: event.orderId, refundType: event.refundType }, 'rtdn');
      case 'refund_review':
        log.info({ messageId: job.messageId }, 'play rtdn: a chargeback awaits review in Play Console (not answered by the server)');
        return { result: 'refund_review' };
      default:
        return { result: event.kind };
    }
  }

  private async applyRead(context: JobContext, token: string, source: Source, read: () => Promise<VerifiedPurchase>): Promise<Record<string, unknown>> {
    let verified: VerifiedPurchase;
    try {
      verified = await read();
    } catch (error) {
      if (isStoreError(error, 'invalid')) {
        context.log.warn({ err: error }, 'play: Google does not know the notified token; nothing applied');
        return { result: 'refused' };
      }
      throw error;
    }
    return this.apply(context, verified, token, source);
  }

  private async apply(context: JobContext, verified: VerifiedPurchase, token: string, source: Source): Promise<Record<string, unknown>> {
    const settings = await billingSettingsOf(context.services, context.redis, context.log).get();
    const applied = await purchaseCoreOf(context, settings, this.now).apply(verified, { store: 'play', token, callerId: null, source: storeEventSource.code(source) });
    return { result: applied.outcome, ...('state' in applied ? { state: applied.state, changed: applied.changed } : {}) };
  }

  /** A refund or chargeback Google reported (notification or list). */
  async applyVoided(context: JobContext, entry: VoidedEntry, source: Source): Promise<Record<string, unknown>> {
    const { services, log } = context;
    if (entry.refundType === voidedRefundType.QUANTITY_BASED_PARTIAL) {
      log.error({ orderId: entry.orderId }, 'play: a quantity-based partial refund is not reversed (multi-quantity purchases are off); look at it in Play Console');
      return { result: 'partial_refund' };
    }
    const row = await purchaseByToken(services.pg, 1, tokenHash(entry.token));
    if (!row) return { result: 'unknown_purchase' };
    if (row.state === 8) return { result: 'already' };
    const now = this.now();
    let verified: VerifiedPurchase;
    if (row.kind === 1) {
      const read = await this.verifier.subscription(entry.token, { productId: row.productId }).catch((error: unknown) => {
        if (isStoreError(error, 'invalid')) return null;
        throw error;
      });
      if (!read) verified = fromRow(row, 'revoked', now);
      else {
        const latest = read.verified.orderId;
        const current = entry.orderId === null || latest === null || latest === entry.orderId;
        if (!current) log.info({ orderId: entry.orderId }, 'play: an earlier renewal was refunded; the current period stays as Google shows it');
        verified = current ? { ...read.verified, state: 'revoked', nextCheckAtMs: null } : read.verified;
      }
    } else {
      const read = await this.verifier.product(entry.token, { productId: row.productId, revoked: true }).catch((error: unknown) => {
        if (isStoreError(error, 'invalid')) return null;
        throw error;
      });
      verified = read ? read.verified : fromRow(row, 'revoked', now);
    }
    return this.apply(context, verified, entry.token, source);
  }

  /** The daily sweep of `voidedpurchases.list`. */
  async voided(context: JobContext): Promise<Record<string, unknown>> {
    const { redis, services, config, log } = context;
    if (!(await takeLease(redis, services.keys.jobLease('iap-voided'), VOIDED_LEASE_MS, config.workerId))) return { leased: false };
    const now = this.now();
    const end = now - VOIDED_END_MARGIN_MS;
    const oldest = now - VOIDED_LOOKBACK_MS;
    const mark = Number(await redis.get(services.keys.playVoidedMark())) || null;
    const start = Math.max(oldest, mark === null ? oldest : mark - VOIDED_OVERLAP_MS);
    let pageToken: string | null = null;
    let pages = 0;
    let entries = 0;
    let revoked = 0;
    let failed = 0;
    do {
      const page = await this.verifier.api.listVoided(pageToken ? { pageToken, type: 1 } : { startTimeMs: start, endTimeMs: end, type: 1 });
      pages += 1;
      for (const item of page.purchases) {
        entries += 1;
        try {
          const out = await this.applyVoided(context, { token: item.purchaseToken, orderId: item.orderId ?? null, refundType: null }, 'voided');
          if (out['state'] === 8 && out['changed'] === true) revoked += 1;
        } catch (error) {
          failed += 1;
          log.warn({ err: error, orderId: item.orderId }, 'play voided: entry not applied; the next run takes it again');
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken !== null && pages < VOIDED_MAX_PAGES);
    const complete = pageToken === null && failed === 0;
    if (complete) await redis.set(services.keys.playVoidedMark(), String(end));
    const summary = { leased: true, fromMs: start, toMs: end, pages, entries, revoked, failed, complete };
    log.info(summary, 'play voided: swept');
    if (failed > 0) throw new Error(`play voided: ${failed} of ${entries} entries not applied`);
    return summary;
  }
}

/** The worker's Google Play integration, from `PLAY_*`: reads may wait longer than in the API (no person waits). */
export const playIntegrationFactory: IapIntegrationFactory = (config) => {
  const play = config.store.play;
  if (!play) return null;
  const api = new PlayDeveloperApi({ packageName: play.packageName, account: play.serviceAccount, timeoutMs: 10_000, totalTimeoutMs: 30_000, retries: 2 });
  return new PlayJobs(new PlayStoreVerifier({ api }), play.packageName).integration();
};
