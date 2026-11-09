import type { Redis } from 'ioredis';
import type { Entitlements } from '../../api/common.js';
import { userChannel } from '../../api/realtime.js';
import { productKind, purchaseState, store as storeCodes, type AppStore } from '../../codes.js';
import type { RealtimePublisher } from '../clients/centrifugo.js';
import type { PublicIds } from '../ids/publicId.js';
import type { KeyBuilder } from '../kv/keys.js';
import type { StoreCatalog, StoreProductRow } from './catalog.js';
import {
  buildEntitlements,
  entitlementBase,
  entitlementBaseTtl,
  entitlementEnvelope,
  entitlementsChanged,
  mayPrime,
  readEntitlementVersions,
  readQuotaUse,
  type EntitlementBase,
  type EntitlementRowsLike,
  type EntitlementVersions,
  type PlanLike,
} from './entitlements.js';
import { ACK_DEADLINE_MS, iapJobIds, type IapJobSink } from './jobs.js';
import { tokenHash, writeTokenRecord } from './tokens.js';
import type { VerifiedPurchase } from './verifier.js';

/**
 * Applying a purchase state the store returned, the same way from the API
 * (a purchase or a restore) and from the worker (a re-check, a notification):
 *
 * 1. the product is looked up in the catalogue in memory (the store may name
 *    another product than the app asked: a trial SKU, a plan change);
 * 2. the store's account reference is decoded (`billingRef`); one that names
 *    no account of ours is refused (and the purchase revoked by a job);
 * 3. one statement (`store_purchase_apply()`) writes everything;
 * 4. after it is durable: a new entitlements version when the
 *    subscription or the wallet changed (before the token's record, so a
 *    repeat that finds the record never reads a base of the old version),
 *    the token's record (so a repeat costs no statement), the fresh
 *    entitlements cached for the view asked (only under the versions this
 *    write moved to, and only when nobody else moved them since they were
 *    read before the statement) and published as `entitlement`, the same for
 *    the owner of a replaced linked token who is someone else, and the jobs
 *    the purchase needs next (acknowledge, consume, re-check, refund check,
 *    the subscription's end), each with retries.
 */

/** What `store_purchase_apply()` takes; the same shape as `@app/db`'s `PurchaseApply`. */
export interface PurchaseApplyInput {
  id: string;
  eventId: string;
  linkedEventId: string;
  ledgerId: string;
  store: number;
  tokenHash: string;
  token: string;
  linkedTokenHash: string | null;
  callerId: string | null;
  accountUserId: string | null;
  productRef: number;
  kind: 1 | 2;
  state: number;
  purchasedAtMs: number;
  expiresAtMs: number | null;
  autoRenew: boolean | null;
  quantity: number;
  isTest: boolean;
  region: string | null;
  orderId: string | null;
  acknowledged: boolean;
  consumed: boolean;
  eventMs: number;
  nextCheckAtMs: number | null;
  source: number;
  amountMicros: string | null;
  currency: string | null;
}

/** What it answers; the same shape as `@app/db`'s `PurchaseApplied`. */
export type PurchaseApplyOutcome =
  | {
      outcome: 'applied' | 'unchanged';
      purchaseId: string;
      userId: string | null;
      state: number;
      stateFrom: number | null;
      created: boolean;
      event: number | null;
      productRef: number;
      kind: number;
      expiresAtMs: number | null;
      acknowledged: boolean;
      consumed: boolean;
      credited: number;
      debited: number;
      shortfall: number;
      subscriptionChanged: boolean;
      replaced: string | null;
      /** The owner of the replaced linked token when it is someone else, and their rows after the change. */
      replacedUserId: string | null;
      replacedRows: EntitlementRowsLike | null;
      rows: EntitlementRowsLike | null;
    }
  | {
      outcome: 'stale';
      purchaseId: string;
      userId: string | null;
      state: number;
      productRef: number;
      kind: number;
      expiresAtMs: number | null;
      rows: EntitlementRowsLike | null;
    }
  | { outcome: 'foreign_account' };

export interface PurchaseLog {
  warn(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
}

export interface BillingSettings {
  plans: readonly PlanLike[];
  crossStore: boolean;
  catalog: StoreCatalog;
}

export interface PurchaseCoreDeps {
  /** `store_purchase_apply()` on the process's pool. */
  apply(input: PurchaseApplyInput): Promise<PurchaseApplyOutcome>;
  /** kv-core: entitlement versions, quota counters, jobs' locks. */
  redis: Redis;
  /** kv-cache: entitlements and token records. */
  cache: Redis;
  keys: KeyBuilder;
  publicIds: PublicIds;
  realtime: RealtimePublisher | null;
  ids: { nextId(): string };
  jobs: IapJobSink;
  settings(): BillingSettings;
  /** The store's subscription centre for a product (undefined: none to link). */
  manageUrl(store: number, productId: string | null): string | undefined;
  log: PurchaseLog;
  now?: (() => number) | undefined;
}

export interface ApplyContext {
  store: AppStore;
  token: string;
  /** The signed-in person who sent the token; null in jobs. */
  callerId: string | null;
  /** store_events.source code. */
  source: number;
  /** The session store whose view of the entitlements is wanted (default: the purchase's store). */
  viewStore?: number | undefined;
  /** Who the purchase is expected to belong to (a job: the stored row's owner); default: the account reference, else the caller. */
  ownerHint?: string | null | undefined;
}

export type AppliedPurchase =
  | {
      outcome: 'applied' | 'unchanged' | 'stale';
      purchaseId: string;
      userId: string | null;
      /** store_purchases.state */
      state: number;
      product: StoreProductRow;
      expiresAtMs: number | null;
      /** The subscription or the wallet changed (a new entitlements version). */
      changed: boolean;
      /**
       * This write gave access or credited for the first time: the token was
       * new, pending or unclaimed before and now grants (a subscription) or
       * was credited (a consumable), and has an owner.
       */
      firstGrant: boolean;
      /** The view asked for (`viewStore`), when the purchase has an owner. */
      entitlements: Entitlements | null;
      base: EntitlementBase | null;
    }
  | { outcome: 'foreign_account' }
  | { outcome: 'unknown_product'; productId: string; basePlanId: string | null };

const STATE: Record<VerifiedPurchase['state'], number> = {
  pending: purchaseState.code('pending'),
  active: purchaseState.code('active'),
  canceled: purchaseState.code('canceled'),
  grace: purchaseState.code('grace'),
  on_hold: purchaseState.code('on_hold'),
  paused: purchaseState.code('paused'),
  expired: purchaseState.code('expired'),
  revoked: purchaseState.code('revoked'),
  purchased: purchaseState.code('purchased'),
  consumed: purchaseState.code('consumed'),
};

/** The verified state as store_purchases.state. */
export function stateCode(state: VerifiedPurchase['state']): number {
  return STATE[state];
}

/** States that give access (a subscription until its expiry) or were credited (a consumable). */
const GRANTING = new Set([2, 3, 4, 10, 12]);
/** States of a row that never granted: pending (1), unclaimed (11). */
const NOT_YET_GRANTED = new Set([1, 11]);

/** Follow-up jobs survive a crash or a Valkey error in the worker: BullMQ tries them again (a store failure is retried inside the job). */
export const FOLLOW_UP_ATTEMPTS = 8;
export const FOLLOW_UP_BACKOFF_MS = 60_000;

export class PurchaseCore {
  constructor(private readonly deps: PurchaseCoreDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async apply(verified: VerifiedPurchase, ctx: ApplyContext): Promise<AppliedPurchase> {
    const { deps } = this;
    const settings = deps.settings();
    const store = storeCodes.code(ctx.store);
    const product = settings.catalog.find(store, verified.productId, verified.basePlanId);
    const kind = verified.kind === 'subscription' ? productKind.code('subscription') : productKind.code('consumable');
    if (product?.kind !== kind) {
      deps.log.error({ store: ctx.store, productId: verified.productId, basePlanId: verified.basePlanId }, 'store: a verified purchase names a product the catalogue does not have');
      return { outcome: 'unknown_product', productId: verified.productId, basePlanId: verified.basePlanId };
    }
    const hash = tokenHash(ctx.token);
    let accountUserId: string | null = null;
    if (verified.accountRef !== null) {
      accountUserId = deps.publicIds.billing.decodeId(verified.accountRef);
      if (accountUserId === null) return this.foreign(ctx, verified, product, hash);
    }
    const linked = verified.linkedPurchaseToken ? tokenHash(verified.linkedPurchaseToken) : null;
    // The versions before the statement: the base built from its rows may be cached only if this write is the one
    // move of both (see mayPrime).
    const hint = ctx.ownerHint ?? accountUserId ?? ctx.callerId;
    const before = hint ? await readEntitlementVersions(deps.redis, deps.keys, hint).catch(() => null) : null;
    const out = await deps.apply({
      id: deps.ids.nextId(),
      eventId: deps.ids.nextId(),
      linkedEventId: deps.ids.nextId(),
      ledgerId: deps.ids.nextId(),
      store,
      tokenHash: hash,
      token: ctx.token,
      linkedTokenHash: linked,
      callerId: ctx.callerId,
      accountUserId,
      productRef: product.id,
      kind: kind as 1 | 2,
      state: stateCode(verified.state),
      purchasedAtMs: verified.purchasedAtMs,
      expiresAtMs: verified.expiresAtMs,
      autoRenew: verified.autoRenew,
      quantity: verified.quantity,
      isTest: verified.isTest,
      region: verified.region,
      orderId: verified.orderId,
      acknowledged: verified.acknowledged,
      consumed: verified.consumed,
      eventMs: verified.eventMs,
      nextCheckAtMs: verified.nextCheckAtMs,
      source: ctx.source,
      amountMicros: verified.amount?.micros ?? null,
      currency: verified.amount?.currency ?? null,
    });
    if (out.outcome === 'foreign_account') return this.foreign(ctx, verified, product, hash);

    const userId = out.userId;
    // Whatever the purchase row did: the subscription row, the wallet or a replaced linked token may have moved.
    const changed = out.outcome !== 'stale' && (out.subscriptionChanged || out.credited > 0 || out.debited > 0 || out.replaced !== null);
    const firstGrant =
      out.outcome !== 'stale' &&
      userId !== null &&
      GRANTING.has(out.state) &&
      (out.created || (out.stateFrom !== null && NOT_YET_GRANTED.has(out.stateFrom)) || out.credited > 0);
    let moved: EntitlementVersions | null = null;
    if (changed && userId) moved = await this.moveVersions(userId);
    await writeTokenRecord(deps.cache, deps.keys, store, hash, { p: out.purchaseId, u: userId, s: out.state, r: out.productRef, x: out.expiresAtMs }).catch(
      (error: unknown) => deps.log.warn({ err: error }, 'store: token record not kept'),
    );
    let entitlements: Entitlements | null = null;
    let base: EntitlementBase | null = null;
    if (userId && out.rows) {
      const view = ctx.viewStore ?? store;
      const built = await this.view(userId, out.rows, view, settings, hint === userId && mayPrime(before, moved) ? moved : null);
      entitlements = built.entitlements;
      base = built.base;
      if (changed && entitlements) await this.publish(userId, entitlements, view);
    }
    if (out.outcome !== 'stale' && out.replacedUserId && out.replacedUserId !== userId) {
      // The replaced token was someone else's: their subscription of this store was recomputed in the same statement.
      const other = out.replacedUserId;
      await this.moveVersions(other);
      if (out.replacedRows) {
        const built = await this.view(other, out.replacedRows, store, settings, null);
        if (built.entitlements) await this.publish(other, built.entitlements, store);
      }
    }
    if (out.outcome !== 'stale') await this.followUps(verified, ctx, out, product);
    return {
      outcome: out.outcome,
      purchaseId: out.purchaseId,
      userId,
      state: out.state,
      product,
      expiresAtMs: out.expiresAtMs,
      changed,
      firstGrant,
      entitlements,
      base,
    };
  }

  /** New entitlement versions of a person after a durable change; null when kv-core could not be written (logged). */
  private async moveVersions(userId: string): Promise<EntitlementVersions | null> {
    const { deps } = this;
    return entitlementsChanged(deps.redis, deps.cache, deps.keys, userId).catch((error: unknown) => {
      deps.log.error({ err: error }, 'store: entitlements version not moved (cached entitlements run out within the hour)');
      return null;
    });
  }

  private async publish(userId: string, entitlements: Entitlements, viewStore: number): Promise<void> {
    const { deps } = this;
    if (!deps.realtime) return;
    await deps.realtime
      .publish(userChannel(deps.publicIds.user.encode(userId)), entitlementEnvelope(deps.ids.nextId(), this.now(), entitlements, viewStore))
      .catch((error: unknown) => deps.log.warn({ err: error }, 'store: entitlement event not published'));
  }

  /**
   * The entitlements of `userId` as a session of `store` sees them, from
   * rows just read. With `prime`, the base is cached under exactly those
   * versions (the ones the writer's own change moved to, never read again
   * afterwards): a later change moves them and the cached value is not used.
   */
  async view(
    userId: string,
    rows: EntitlementRowsLike,
    store: number,
    settings: BillingSettings,
    prime: EntitlementVersions | null,
  ): Promise<{ entitlements: Entitlements | null; base: EntitlementBase | null }> {
    const { deps } = this;
    const now = this.now();
    try {
      const use = await readQuotaUse(deps.redis, deps.keys, userId, now);
      const base = entitlementBase(rows, store, settings.crossStore, prime?.version ?? use.version ?? 0, prime?.walletVersion ?? use.walletVersion, now);
      if (prime) {
        await deps.cache.set(deps.keys.entitlements(userId, store), JSON.stringify(base), 'EX', entitlementBaseTtl(base, now)).catch(() => undefined);
      }
      return { base, entitlements: buildEntitlements({ base, plans: settings.plans, use, manageUrl: (s, p) => deps.manageUrl(s, p), now }) };
    } catch (error) {
      deps.log.warn({ err: error }, 'store: entitlements not built (quota counters unreadable)');
      return { entitlements: null, base: null };
    }
  }

  private async foreign(ctx: ApplyContext, verified: VerifiedPurchase, product: StoreProductRow, hash: string): Promise<AppliedPurchase> {
    const { deps } = this;
    deps.log.warn({ store: ctx.store, productId: product.productId }, 'store: a purchase bound to no account of ours is refused and revoked');
    await deps.jobs
      .add(
        'revoke',
        iapJobIds.revoke(ctx.store, hash),
        { store: ctx.store, kind: verified.kind, productId: verified.productId, token: ctx.token, tokenHash: hash },
        { attempts: 8, backoffMs: 60_000 },
      )
      .catch((error: unknown) => deps.log.error({ err: error }, 'store: revoke not queued'));
    return { outcome: 'foreign_account' };
  }

  /** The jobs a purchase needs after this state: each id is deterministic, so a repeat adds nothing. */
  private async followUps(
    verified: VerifiedPurchase,
    ctx: ApplyContext,
    out: Extract<PurchaseApplyOutcome, { outcome: 'applied' | 'unchanged' }>,
    product: StoreProductRow,
  ): Promise<void> {
    const { deps } = this;
    const now = this.now();
    const add = (name: Parameters<IapJobSink['add']>[0], id: string, data: Record<string, unknown>, delayMs?: number) =>
      deps.jobs
        .add(name, id, data, { ...(delayMs && delayMs > 0 ? { delayMs } : {}), attempts: FOLLOW_UP_ATTEMPTS, backoffMs: FOLLOW_UP_BACKOFF_MS })
        .catch((error: unknown) => deps.log.warn({ err: error, job: name }, 'store: follow-up job not queued (the hourly sweep or the app finds it again)'));
    const owned = out.userId !== null;
    const granting = GRANTING.has(out.state);
    if (owned && granting && verified.needsAcknowledge && !out.acknowledged) {
      await add('ack', iapJobIds.ack(out.purchaseId), { purchaseId: out.purchaseId, store: ctx.store, deadlineMs: verified.purchasedAtMs + ACK_DEADLINE_MS });
    }
    if (owned && product.kind === 2 && verified.needsConsume && !out.consumed && out.state === purchaseState.code('purchased')) {
      // The window starts when the store completed the purchase (a pending one: later than the row was first written).
      await add('consume', iapJobIds.consume(out.purchaseId), { purchaseId: out.purchaseId, store: ctx.store, deadlineMs: verified.purchasedAtMs + ACK_DEADLINE_MS });
    }
    if (verified.nextCheckAtMs !== null) {
      await add('recheck', iapJobIds.recheck(out.purchaseId, verified.nextCheckAtMs), { purchaseId: out.purchaseId, store: ctx.store, atMs: verified.nextCheckAtMs }, verified.nextCheckAtMs - now);
    }
    if (out.created && verified.refundCheckAtMs !== null) {
      await add(
        'refund-check',
        iapJobIds.refundCheck(out.purchaseId),
        { purchaseId: out.purchaseId, store: ctx.store, atMs: verified.refundCheckAtMs },
        verified.refundCheckAtMs - now,
      );
    }
    if (owned && product.kind === 1 && out.expiresAtMs !== null && out.expiresAtMs > now && granting) {
      const store = storeCodes.code(ctx.store);
      const at = out.expiresAtMs + 1_000;
      await add('sub-end', iapJobIds.subEnd(out.userId!, store, at), { userId: out.userId, store, atMs: at }, at - now);
    }
  }
}
