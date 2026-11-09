import { entitlementRows } from '@app/db';
import { store as storeCodes, userChannel, type AppStore, type Entitlements, type WalletItem } from '@app/shared';
import {
  buildEntitlements,
  entitlementBase,
  entitlementBaseTtl,
  entitlementEnvelope,
  entitlementsChanged,
  entitlementsEtag,
  manageUrlByCode,
  parseEntitlementBase,
  readQuotaUse,
  walletChanged,
  type EntitlementBase,
  type QuotaCounters,
} from '@app/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nextId } from '../auth/sessions.js';
import { HttpProblem } from '../lib/problem.js';
import type { ConfigSnapshot } from './cfg.js';
import { sessionPlan } from './plans.js';

/**
 * `GET /v1/me/entitlements` and what keeps it current.
 *
 * A read is two Valkey round trips in parallel and no statement when warm:
 * kv-core for the quota counters, the running boost and the entitlements
 * version (`entv:<uid>`), kv-cache for the base (`ent:<uid>:<st>`). The
 * ETag is decided from those alone (the version and digest of the base,
 * the configuration's fingerprint, the counters), so a 304 costs no body
 * and no SQL. A miss (no base, or one of an older version) is one statement
 * (`entitlement_rows()`), stored under the version read before it.
 *
 * {@link EntitlementService.changed} is what every write that changes a
 * person's subscriptions or wallet calls once it is durable (a wallet use,
 * a grant; the purchase core does the same for purchases): a new version,
 * and the `entitlement` event with the session store's view.
 */

/** Whether a session's plan includes a feature (incognito, advanced filters): the gates' computation, cached. */
export async function planHasFeature(request: FastifyRequest, cfg: ConfigSnapshot, userId: string, storeCode: number | undefined, feature: string): Promise<boolean> {
  const app = request.server;
  const { plan } = await sessionPlan({ cache: app.cache, keys: app.keys, db: app.pg, log: request.log }, request, cfg, userId, storeCode);
  return plan?.features[feature] === true;
}

export interface SessionEntitlements {
  entitlements: Entitlements;
  etag: string;
  base: EntitlementBase;
  use: QuotaCounters;
  /** Whether the base came from Valkey (no statement). */
  cached: boolean;
}

export class EntitlementService {
  constructor(private readonly app: FastifyInstance) {}

  /** The store's subscription centre for a product (the brand's link, else Play's): the worker's events use the same rule. */
  manageUrl(store: number, productId: string | null): string | undefined {
    return manageUrlByCode(this.app.brand, store, productId);
  }

  /** The base and counters of a session: two Valkey round trips, one statement on a miss (the budget is raised for it). */
  async load(request: FastifyRequest, userId: string, store: number, now: number = Date.now()): Promise<{ base: EntitlementBase; use: QuotaCounters; cached: boolean }> {
    const { app } = this;
    const cfg = app.cfg.get();
    const crossStore = cfg.app['billing.cross_store_entitlements'];
    const key = app.keys.entitlements(userId, store);
    let use: QuotaCounters;
    let raw: string | null;
    try {
      [use, raw] = await Promise.all([
        readQuotaUse(app.redis, app.keys, userId, now),
        app.cache.get(key).catch((error: unknown) => {
          request.log.warn({ err: error }, 'entitlements: cached base unreadable');
          return null;
        }),
      ]);
    } catch (error) {
      request.log.warn({ err: error }, 'entitlements: kv-core unreadable');
      throw new HttpProblem('service_unavailable', { detail: 'Try again in a moment.', headers: { 'retry-after': '5' } });
    }
    const cached = parseEntitlementBase(raw, crossStore, use.version, use.walletVersion, now);
    if (cached) return { base: cached, use, cached: true };
    if (request.pgTally?.budget !== undefined) request.pgTally.budget += 1;
    const rows = await entitlementRows(app.pg, userId);
    const base = entitlementBase(rows, store, crossStore, use.version ?? 0, use.walletVersion, now);
    await app.cache.set(key, JSON.stringify(base), 'EX', entitlementBaseTtl(base, now)).catch((error: unknown) => request.log.warn({ err: error }, 'entitlements: not cached'));
    return { base, use, cached: false };
  }

  async forSession(request: FastifyRequest, userId: string, store: number, now: number = Date.now()): Promise<SessionEntitlements> {
    const cfg = this.app.cfg.get();
    const { base, use, cached } = await this.load(request, userId, store, now);
    const etag = entitlementsEtag(base, cfg.fingerprint, use, now);
    const entitlements = buildEntitlements({ base, plans: cfg.plans, use, manageUrl: (s, p) => this.manageUrl(s, p), now });
    return { entitlements, etag, base, use, cached };
  }

  /**
   * After a write that changed a person's subscriptions or wallet is
   * durable: a new version (the cached bases are not used again), and the
   * `entitlement` event with the view of `store` (the session's; the event
   * names it, so the person's devices of the other build read their own). Costs no
   * statement unless `rows` must be read for the event (then one, raised
   * on the request's budget). Failures are logged: the cache runs out
   * within the hour.
   */
  async changed(request: FastifyRequest | null, userId: string, store: number, options: { publish?: boolean } = {}): Promise<void> {
    const { app } = this;
    const log = request?.log ?? app.log;
    try {
      await entitlementsChanged(app.redis, app.cache, app.keys, userId);
    } catch (error) {
      log.error({ err: error }, 'entitlements: version not moved (cached entitlements run out within the hour)');
      return;
    }
    if (options.publish === false || !app.realtime) return;
    try {
      const view = request ? await this.forSession(request, userId, store) : null;
      if (!view) return;
      const envelope = entitlementEnvelope(nextId(app), Date.now(), view.entitlements, store);
      await app.realtime.publish(userChannel(app.publicIds.user.encode(userId)), envelope);
    } catch (error) {
      log.warn({ err: error }, 'entitlements: event not published');
    }
  }

  /**
   * After a wallet use (a super like, a direct message, a boost) or its
   * give-back is durable: a new wallet version (the cached plan stays usable,
   * so the gates read no statement), and the event built from the session's base with
   * the balance moved, so the path that spent pays no statement for it. The
   * event is a hint (two spends at once may each tell their own balance); the
   * next read rebuilds from PostgreSQL.
   */
  async walletMoved(request: FastifyRequest, userId: string, base: EntitlementBase | null, item: WalletItem, delta: number): Promise<void> {
    const { app } = this;
    try {
      await walletChanged(app.redis, app.keys, userId);
    } catch (error) {
      request.log.error({ err: error }, 'entitlements: wallet version not moved (cached entitlements run out within the hour)');
      return;
    }
    if (!base || !app.realtime) return;
    try {
      const cfg = app.cfg.get();
      const use = await readQuotaUse(app.redis, app.keys, userId);
      const moved: EntitlementBase = { ...base, wallet: { ...base.wallet, [item]: Math.max(0, base.wallet[item] + delta) } };
      const entitlements = buildEntitlements({ base: moved, plans: cfg.plans, use, manageUrl: (s, p) => this.manageUrl(s, p) });
      await app.realtime.publish(userChannel(app.publicIds.user.encode(userId)), entitlementEnvelope(nextId(app), Date.now(), entitlements, base.st));
    } catch (error) {
      request.log.warn({ err: error }, 'entitlements: event not published');
    }
  }

  /** The store of a session as a code (0 when it has none: the grants and gifts only). */
  static storeOf(store: AppStore | undefined): number {
    return store ? storeCodes.code(store) : 0;
  }
}
