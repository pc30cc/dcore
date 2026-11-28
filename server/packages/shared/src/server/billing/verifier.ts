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

/**
 * What an admin may ask a store to do with a purchase, beyond reading it:
 * stop the renewal of a subscription (access runs to its expiry), refund it
 * (access ends now), or refund a subscription for its unused time only.
 */
export type AdminStoreAction = 'cancel' | 'refund' | 'refund_prorated';

/** The admin actions a store integration offers, per kind of purchase: only what its API documents and this build has confirmed. */
export type AdminStoreActions = Readonly<Record<PurchaseKindName, readonly AdminStoreAction[]>>;

export interface StoreReadOptions {
  /** Someone waits for the answer (an admin's re-check): stores that pace their calls let it go first. */
  urgent?: boolean | undefined;
}

export interface StoreVerifier {
  readonly store: AppStore;
  /** The admin actions this integration offers (the panel shows no other). */
  readonly adminActions: AdminStoreActions;
  /** Checks that need no network (Bazaar's SHA1withRSA signature over originalJson, the package); throws `invalid`. */
  inspect(submission: PurchaseSubmission): PurchaseClaim;
  /** The purchase's state from the store: one call. */
  verify(submission: PurchaseSubmission): Promise<VerifiedPurchase>;
  /** A stored purchase (or a notified token) asked again. */
  recheck(purchase: PurchaseRef, options?: StoreReadOptions): Promise<VerifiedPurchase>;
  acknowledge(purchase: PurchaseRef): Promise<StoreActionOutcome>;
  /** `already` when the store says it was consumed before (Bazaar's `already_consumed`). */
  consume(purchase: PurchaseRef): Promise<StoreActionOutcome>;
  /** Refunds and revokes a purchase that may not be granted (bound to no account of ours). */
  revoke(purchase: PurchaseRef): Promise<StoreActionOutcome>;
  /**
   * An admin's refund: the money back and access ended now; a subscription
   * refunded for its unused time with `prorated`. Throws `invalid` for an
   * action not in {@link adminActions} (nothing is asked). Never retried by
   * the integration: a lost answer may have taken effect, so the caller
   * reads the purchase again, and a repeat of a done refund is `already`.
   */
  refund(purchase: PurchaseRef, options: { prorated: boolean }): Promise<StoreActionOutcome>;
  /** An admin's stop of a subscription's renewal (access runs to its expiry); `already` when it had stopped or ended. */
  cancel(purchase: PurchaseRef): Promise<StoreActionOutcome>;
}

/** Whether `verifier` offers `action` for purchases of `kind`. */
export function offersAdminAction(verifier: Pick<StoreVerifier, 'adminActions'>, kind: PurchaseKindName, action: AdminStoreAction): boolean {
  return verifier.adminActions[kind].includes(action);
}

/** Every admin action, for stores that offer all of them (the fake). */
export const ALL_ADMIN_STORE_ACTIONS: AdminStoreActions = { subscription: ['cancel', 'refund', 'refund_prorated'], consumable: ['refund'] };

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
  method: 'verify' | 'recheck' | 'acknowledge' | 'consume' | 'revoke' | 'refund' | 'cancel';
  token: string;
  /** `recheck`: asked urgently; `refund`: for the unused time only. */
  urgent?: boolean | undefined;
  prorated?: boolean | undefined;
}

/**
 * A store in memory (tests): purchases by token, every call recorded,
 * failures on demand. `inspect` accepts a submission whose signature is
 * `fake-sig-<accountRef>` or that carries no signature; anything else
 * is `invalid`, like a bad Bazaar signature.
 */
export class FakeStoreVerifier implements StoreVerifier {
  readonly store: AppStore;
  /** Every admin action by default; a test narrows it to a store's own. */
  adminActions: AdminStoreActions = ALL_ADMIN_STORE_ACTIONS;
  readonly purchases = new Map<string, FakeStorePurchase>();
  readonly calls: FakeStoreCall[] = [];
  /** The next calls fail with these errors, in order. */
  readonly failures: StoreError[] = [];
  /** Tokens the store has acknowledged or consumed. */
  readonly acknowledged = new Set<string>();
  readonly consumed = new Set<string>();
  readonly revoked = new Set<string>();
  /** Tokens an admin refunded or stopped the renewal of. */
  readonly refunded = new Set<string>();
  readonly canceled = new Set<string>();
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

  private take(method: FakeStoreCall['method'], token: string, extra: Pick<FakeStoreCall, 'urgent' | 'prorated'> = {}): void {
    this.calls.push({ method, token, ...extra });
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

  async recheck(purchase: PurchaseRef, options: StoreReadOptions = {}): Promise<VerifiedPurchase> {
    this.take('recheck', purchase.token, options.urgent === undefined ? {} : { urgent: options.urgent });
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

  async refund(purchase: PurchaseRef, options: { prorated: boolean }): Promise<StoreActionOutcome> {
    const action: AdminStoreAction = options.prorated ? 'refund_prorated' : 'refund';
    if (!offersAdminAction(this, purchase.kind, action)) throw new StoreError('invalid', `the store offers no ${action} of a ${purchase.kind}`);
    this.take('refund', purchase.token, { prorated: options.prorated });
    if (this.refunded.has(purchase.token)) return 'already';
    this.refunded.add(purchase.token);
    const p = this.purchases.get(purchase.token);
    if (p) {
      // As Google shows it: a refunded subscription reads EXPIRED (only a notification or the voided list says refunded).
      p.state = p.kind === 'subscription' ? 'expired' : 'revoked';
      p.autoRenew = p.kind === 'subscription' ? false : null;
      p.eventMs = this.now();
    }
    return 'done';
  }

  async cancel(purchase: PurchaseRef): Promise<StoreActionOutcome> {
    if (!offersAdminAction(this, purchase.kind, 'cancel')) throw new StoreError('invalid', `the store offers no cancel of a ${purchase.kind}`);
    this.take('cancel', purchase.token);
    const p = this.purchases.get(purchase.token);
    const state = p?.state;
    if (this.canceled.has(purchase.token) || (state !== undefined && state !== 'active' && state !== 'grace')) return 'already';
    this.canceled.add(purchase.token);
    if (p) {
      p.state = 'canceled';
      p.autoRenew = false;
      p.eventMs = this.now();
    }
    return 'done';
  }
}
