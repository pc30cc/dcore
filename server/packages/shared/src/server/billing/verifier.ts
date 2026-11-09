import type { AppStore } from '../../codes.js';

/**
 * What a store integration implements (Google Play, Cafe Bazaar): the
 * store-independent purchase core calls it to verify a purchase the app
 * sent, to read a stored purchase again, and to acknowledge, consume or
 * revoke it. Everything the core grants comes from a {@link VerifiedPurchase}
 * the store's own API returned; a client's word is never enough.
 *
 * Errors are {@link StoreError}s: `invalid` (the store does not know the
 * token, the signature or package is wrong: 422 `purchase_invalid`, nothing
 * written), `unavailable` (the store could not be asked now: 503
 * `store_unavailable`, a job retries), `not_configured`.
 */

export type PurchaseKindName = 'subscription' | 'consumable';

/** The states a verified purchase can be in (store_purchases.state names; `replaced` and `unclaimed` are the server's own). */
export type VerifiedState = 'pending' | 'active' | 'canceled' | 'grace' | 'on_hold' | 'paused' | 'expired' | 'revoked' | 'purchased' | 'consumed';

/** A purchase as the app sent it (Bazaar's signed `originalJson` and `signature` included). */
export interface PurchaseSubmission {
  store: AppStore;
  productId: string;
  purchaseToken: string;
  kind: PurchaseKindName;
  originalJson?: string | undefined;
  signature?: string | undefined;
}

/** What a submission says about itself, read without any network call. */
export interface PurchaseClaim {
  productId: string;
  /** The account reference the purchase carries (Play obfuscatedAccountId, Bazaar developer payload); null when it has none. */
  accountRef: string | null;
}

/** A purchase to ask the store about again (a stored row, or a token a notification named). */
export interface PurchaseRef {
  /** The stored row's id; null for a token not stored yet. */
  purchaseId: string | null;
  store: AppStore;
  kind: PurchaseKindName;
  token: string;
  /** Null when the notification did not say (Play reads it from the token). */
  productId: string | null;
  basePlanId: string | null;
  orderId: string | null;
  purchasedAtMs: number | null;
  expiresAtMs: number | null;
  quantity: number;
}

export interface VerifiedPurchase {
  kind: PurchaseKindName;
  /** The product the store says was bought (it can differ from what the app asked: a trial SKU, a plan change). */
  productId: string;
  /** Play subscriptions: the base plan of the line item; null elsewhere. */
  basePlanId: string | null;
  state: VerifiedState;
  purchasedAtMs: number;
  /** Subscriptions: until when access runs (Play expiryTime, Bazaar validUntil); null for consumables. */
  expiresAtMs: number | null;
  autoRenew: boolean | null;
  accountRef: string | null;
  orderId: string | null;
  /** Play: the token this one replaces (upgrade, downgrade, re-signup). */
  linkedPurchaseToken: string | null;
  quantity: number;
  isTest: boolean;
  /** ISO 3166-1 alpha-2 when the store says. */
  region: string | null;
  acknowledged: boolean;
  consumed: boolean;
  /** The store's time of this state (Play eventTimeMillis or the read's time): an older one never overwrites a newer. */
  eventMs: number;
  /** What the store reported the buyer paid, in micros of `currency`; null: the list price is copied as an estimate. */
  amount: { micros: string; currency: string } | null;
  /** When the worker should ask the store again (Play: a missed notification; Bazaar: validUntil + 1 h). */
  nextCheckAtMs: number | null;
  /** One refund check at this time (Bazaar's refund window: day 7); null: none. */
  refundCheckAtMs: number | null;
  /** The server must acknowledge it (Play, until acknowledged, within three days). */
  needsAcknowledge: boolean;
  /** The server consumes it once it is credited (consumables). */
  needsConsume: boolean;
}

export type StoreActionOutcome = 'done' | 'already';

export interface StoreVerifier {
  readonly store: AppStore;
  /** Checks that need no network (Bazaar's SHA1withRSA signature over originalJson, the package); throws `invalid`. */
  inspect(submission: PurchaseSubmission): PurchaseClaim;
  /** The purchase's state from the store: one call. */
  verify(submission: PurchaseSubmission): Promise<VerifiedPurchase>;
  /** A stored purchase (or a notified token) asked again. */
  recheck(purchase: PurchaseRef): Promise<VerifiedPurchase>;
  acknowledge(purchase: PurchaseRef): Promise<StoreActionOutcome>;
  /** `already` when the store says it was consumed before (Bazaar's `already_consumed`). */
  consume(purchase: PurchaseRef): Promise<StoreActionOutcome>;
  /** Refunds and revokes a purchase that may not be granted (bound to no account of ours). */
  revoke(purchase: PurchaseRef): Promise<StoreActionOutcome>;
}

export type StoreErrorKind = 'invalid' | 'unavailable' | 'not_configured';

export class StoreError extends Error {
  readonly kind: StoreErrorKind;
  /** Seconds before asking again (a quota, a 429), when the store said. */
  readonly retryAfterSeconds: number | undefined;

  constructor(kind: StoreErrorKind, message: string, options: { cause?: unknown; retryAfterSeconds?: number | undefined } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StoreError';
    this.kind = kind;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function isStoreError(error: unknown, kind?: StoreErrorKind): error is StoreError {
  return error instanceof StoreError && (kind === undefined || error.kind === kind);
}

/** A purchase the fake store knows. */
export interface FakeStorePurchase extends Partial<Omit<VerifiedPurchase, 'kind' | 'productId'>> {
  kind: PurchaseKindName;
  productId: string;
}

export interface FakeStoreCall {
  method: 'verify' | 'recheck' | 'acknowledge' | 'consume' | 'revoke';
  token: string;
}

/**
 * A store in memory (tests): purchases by token, every call recorded,
 * failures on demand. `inspect` accepts a submission whose signature is
 * `fake-sig-<accountRef>` or that carries no signature; anything else
 * is `invalid`, like a bad Bazaar signature.
 */
export class FakeStoreVerifier implements StoreVerifier {
  readonly store: AppStore;
  readonly purchases = new Map<string, FakeStorePurchase>();
  readonly calls: FakeStoreCall[] = [];
  /** The next calls fail with these errors, in order. */
  readonly failures: StoreError[] = [];
  /** Tokens the store has acknowledged or consumed. */
  readonly acknowledged = new Set<string>();
  readonly consumed = new Set<string>();
  readonly revoked = new Set<string>();
  now: () => number = () => Date.now();

  constructor(store: AppStore) {
    this.store = store;
  }

  put(token: string, purchase: FakeStorePurchase): this {
    this.purchases.set(token, purchase);
    return this;
  }

  /** Calls of one kind (to count store calls). */
  count(method?: FakeStoreCall['method']): number {
    return method ? this.calls.filter((c) => c.method === method).length : this.calls.length;
  }

  inspect(submission: PurchaseSubmission): PurchaseClaim {
    if (submission.signature !== undefined) {
      const prefix = 'fake-sig-';
      if (!submission.signature.startsWith(prefix)) throw new StoreError('invalid', 'signature does not verify');
      const ref = submission.signature.slice(prefix.length);
      return { productId: submission.productId, accountRef: ref.length > 0 ? ref : null };
    }
    return { productId: submission.productId, accountRef: null };
  }

  private take(method: FakeStoreCall['method'], token: string): void {
    this.calls.push({ method, token });
    const failure = this.failures.shift();
    if (failure) throw failure;
  }

  private state(token: string): VerifiedPurchase {
    const p = this.purchases.get(token);
    if (!p) throw new StoreError('invalid', 'the store does not know this token');
    const now = this.now();
    return {
      kind: p.kind,
      productId: p.productId,
      basePlanId: p.basePlanId ?? null,
      state: p.state ?? (p.kind === 'consumable' ? 'purchased' : 'active'),
      purchasedAtMs: p.purchasedAtMs ?? now,
      expiresAtMs: p.expiresAtMs ?? (p.kind === 'subscription' ? now + 30 * 86_400_000 : null),
      autoRenew: p.autoRenew ?? (p.kind === 'subscription' ? true : null),
      accountRef: p.accountRef ?? null,
      orderId: p.orderId ?? null,
      linkedPurchaseToken: p.linkedPurchaseToken ?? null,
      quantity: p.quantity ?? 1,
      isTest: p.isTest ?? true,
      region: p.region ?? null,
      acknowledged: this.acknowledged.has(token) || (p.acknowledged ?? false),
      consumed: this.consumed.has(token) || (p.consumed ?? false),
      eventMs: p.eventMs ?? now,
      amount: p.amount ?? null,
      nextCheckAtMs: p.nextCheckAtMs ?? null,
      refundCheckAtMs: p.refundCheckAtMs ?? null,
      needsAcknowledge: p.needsAcknowledge ?? false,
      needsConsume: p.needsConsume ?? p.kind === 'consumable',
    };
  }

  async verify(submission: PurchaseSubmission): Promise<VerifiedPurchase> {
    this.take('verify', submission.purchaseToken);
    return this.state(submission.purchaseToken);
  }

  async recheck(purchase: PurchaseRef): Promise<VerifiedPurchase> {
    this.take('recheck', purchase.token);
    return this.state(purchase.token);
  }

  async acknowledge(purchase: PurchaseRef): Promise<StoreActionOutcome> {
    this.take('acknowledge', purchase.token);
    if (this.acknowledged.has(purchase.token)) return 'already';
    this.acknowledged.add(purchase.token);
    return 'done';
  }

  async consume(purchase: PurchaseRef): Promise<StoreActionOutcome> {
    this.take('consume', purchase.token);
    if (this.consumed.has(purchase.token)) return 'already';
    this.consumed.add(purchase.token);
    this.acknowledged.add(purchase.token);
    return 'done';
  }

  async revoke(purchase: PurchaseRef): Promise<StoreActionOutcome> {
    this.take('revoke', purchase.token);
    if (this.revoked.has(purchase.token)) return 'already';
    this.revoked.add(purchase.token);
    const p = this.purchases.get(purchase.token);
    if (p) p.state = 'revoked';
    return 'done';
  }
}
