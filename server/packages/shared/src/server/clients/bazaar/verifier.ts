import type { KeyObject } from 'node:crypto';
import { tokenHash } from '../../billing/tokens.js';
import {
  StoreError,
  type PurchaseClaim,
  type PurchaseRef,
  type PurchaseSubmission,
  type StoreActionOutcome,
  type StoreVerifier,
  type VerifiedPurchase,
} from '../../billing/verifier.js';
import { isBazaarApiError, type BazaarApi, type BazaarInappPurchase, type BazaarSubscription } from './api.js';
import type { BazaarPriority } from './meter.js';
import { bazaarPublicKey, parseBazaarPurchaseData, verifyBazaarSignature, type BazaarPurchaseData } from './purchase.js';

/**
 * Cafe Bazaar behind the store-independent `StoreVerifier`.
 *
 * Before any network call (`inspect`, and again inside `verify`): the
 * SHA1withRSA signature over `originalJson` with the app's public key, and in
 * the signed data the package name, the product and the token the app sent,
 * a purchase state that is not refunded, and a developer payload (the
 * session's `billingRef`, compared by the caller). Anything else costs no
 * Bazaar call.
 *
 * Then exactly one call per purchase: a one-time product's status
 * (`validate`), or the subscription's own status by SKU and token (Bazaar
 * documents initial and renewal tokens for it, and it answers ended
 * subscriptions too, so a state is always known). Only when that answers
 * `not_found` is the user's `active-subscriptions` asked (the one endpoint
 * every source says takes renewal tokens).
 *
 * Bazaar sends no notifications: renewals, expiries and refunds are learnt
 * by asking again, one call each time, at times spread per token so a
 * campaign's buyers are not all asked in the same minute a month later:
 *
 * - a live subscription at `validUntil + 1 h + spread` (spread ∈ [0, 2 h),
 *   from the token's hash, the same on every read so the job id is stable);
 *   renewed: extended and asked again at the next period's end; not renewed:
 *   expired at once;
 * - every new purchase once after its refund window (`purchaseTime + 7 days
 *   + 2 h + spread`): a refunded one-time product is reversed once, a
 *   refunded subscription has ended;
 * - while a renewing subscription is being asked again, its access runs on
 *   for {@link BAZAAR_RENEWAL_GRACE_MS} past `validUntil`, so a paying
 *   subscriber never loses access between the charge and the check (its
 *   `expiresAt` is `validUntil` plus that grace; a subscription that does
 *   not renew ends at `validUntil` exactly).
 *
 * Bazaar has no acknowledgement; consume runs after the credit, and
 * `already_consumed` is success. Amounts are never reported, so the core
 * estimates them from the list price of the moment.
 */

export const BAZAAR_RECHECK_DELAY_MS = 3_600_000;
export const BAZAAR_CHECK_SPREAD_MS = 2 * 3_600_000;
export const BAZAAR_RENEWAL_GRACE_MS = 5 * 3_600_000;
export const BAZAAR_REFUND_WINDOW_MS = 7 * 86_400_000;
export const BAZAAR_REFUND_CHECK_DELAY_MS = 2 * 3_600_000;

export interface BazaarVerifierLog {
  error(object: Record<string, unknown>, message: string): void;
}

export interface BazaarVerifierOptions {
  packageName: string;
  /** base64 X.509 SubjectPublicKeyInfo (Pishkhan → In-app billing). */
  rsaPublicKey: string;
  api: BazaarApi;
  log?: BazaarVerifierLog | undefined;
  now?: (() => number) | undefined;
}

/** A token's own offset inside the spread window: the same for every read of the token. */
export function bazaarCheckSpread(token: string, windowMs: number = BAZAAR_CHECK_SPREAD_MS): number {
  return Number.parseInt(tokenHash(`bazaar-spread:${token}`).slice(0, 12), 16) % windowMs;
}

/** When a subscription that runs until `validUntilMs` is asked again. */
export function bazaarRecheckAt(validUntilMs: number, token: string): number {
  return validUntilMs + BAZAAR_RECHECK_DELAY_MS + bazaarCheckSpread(token);
}

/** When a purchase made at `purchasedAtMs` gets its one refund check. */
export function bazaarRefundCheckAt(purchasedAtMs: number, token: string): number {
  return purchasedAtMs + BAZAAR_REFUND_WINDOW_MS + BAZAAR_REFUND_CHECK_DELAY_MS + bazaarCheckSpread(token);
}

type Signed = BazaarPurchaseData & { developerPayload: string };

function invalid(message: string): StoreError {
  return new StoreError('invalid', `bazaar: ${message}`);
}

export class BazaarVerifier implements StoreVerifier {
  readonly store = 'bazaar' as const;
  private readonly key: KeyObject;
  private readonly packageName: string;
  private readonly api: BazaarApi;
  private readonly log: BazaarVerifierLog | undefined;
  private readonly now: () => number;

  constructor(options: BazaarVerifierOptions) {
    this.key = bazaarPublicKey(options.rsaPublicKey);
    this.packageName = options.packageName;
    this.api = options.api;
    this.log = options.log;
    this.now = options.now ?? Date.now;
  }

  /** The signed purchase data, checked; throws `invalid` before anything leaves the process. */
  private signed(submission: PurchaseSubmission): Signed {
    if (submission.store !== 'bazaar') throw invalid('not a Bazaar purchase');
    if (submission.originalJson === undefined || submission.signature === undefined) throw invalid('the signed purchase data is missing');
    if (!verifyBazaarSignature(this.key, submission.originalJson, submission.signature)) throw invalid('the purchase signature does not verify');
    const data = parseBazaarPurchaseData(submission.originalJson);
    if (!data) throw invalid('the signed purchase data is not a purchase');
    if (data.packageName !== this.packageName) throw invalid('the purchase belongs to another package');
    if (data.productId !== submission.productId) throw invalid('the signed product differs from the one sent');
    if (data.purchaseToken !== submission.purchaseToken) throw invalid('the signed token differs from the one sent');
    if (data.refunded) throw invalid('the signed purchase is refunded');
    if (data.developerPayload === null) throw invalid('the purchase carries no developer payload');
    return data as Signed;
  }

  inspect(submission: PurchaseSubmission): PurchaseClaim {
    const data = this.signed(submission);
    return { productId: data.productId, accountRef: data.developerPayload };
  }

  async verify(submission: PurchaseSubmission): Promise<VerifiedPurchase> {
    const data = this.signed(submission);
    const now = this.now();
    if (submission.kind === 'consumable') {
      const p = await this.ask(() => this.api.inappPurchase(data.productId, data.purchaseToken, 'urgent'));
      if (p.developerPayload !== null && p.developerPayload !== data.developerPayload) throw invalid('the store reports another developer payload');
      const purchasedAtMs = data.purchaseTimeMs ?? p.purchaseTimeMs ?? now;
      return this.oneTime(p, { productId: data.productId, token: data.purchaseToken, orderId: data.orderId, accountRef: data.developerPayload, purchasedAtMs }, now, true);
    }
    const sub = await this.subscriptionOf(data.productId, data.purchaseToken, 'urgent');
    if (!sub) throw invalid('no subscription of this product is live for this token');
    const purchasedAtMs = data.purchaseTimeMs ?? sub.startedAtMs;
    return this.recurring(sub, { productId: data.productId, token: data.purchaseToken, orderId: data.orderId, accountRef: data.developerPayload, purchasedAtMs }, now, true);
  }

  async recheck(purchase: PurchaseRef): Promise<VerifiedPurchase> {
    if (purchase.productId === null) throw invalid('a stored Bazaar purchase without its product');
    const now = this.now();
    const base = { productId: purchase.productId, token: purchase.token, orderId: purchase.orderId, accountRef: null };
    if (purchase.kind === 'consumable') {
      const p = await this.ask(() => this.api.inappPurchase(purchase.productId!, purchase.token, 'background'));
      return this.oneTime(p, { ...base, purchasedAtMs: purchase.purchasedAtMs ?? p.purchaseTimeMs ?? now }, now, false);
    }
    const sub = await this.subscriptionOf(purchase.productId, purchase.token, 'background');
    const purchasedAtMs = purchase.purchasedAtMs ?? sub?.startedAtMs ?? now;
    if (!sub) {
      // Nothing of this product is live for the token any more: it ended (or was refunded) by now.
      return this.verified({
        ...base,
        kind: 'subscription',
        state: 'expired',
        purchasedAtMs,
        expiresAtMs: Math.min(purchase.expiresAtMs ?? now, now),
        autoRenew: false,
        eventMs: now,
        consumed: false,
        nextCheckAtMs: null,
        refundCheckAtMs: null,
        needsConsume: false,
      });
    }
    return this.recurring(sub, { ...base, purchasedAtMs }, now, false);
  }

  async acknowledge(): Promise<StoreActionOutcome> {
    // Bazaar has no acknowledgement: nothing is asked.
    return 'already';
  }

  async consume(purchase: PurchaseRef): Promise<StoreActionOutcome> {
    if (purchase.kind !== 'consumable') throw invalid('a subscription is not consumed');
    return this.ask(() => this.api.consume(purchase.token, 'background'));
  }

  async revoke(purchase: PurchaseRef): Promise<StoreActionOutcome> {
    if (purchase.kind === 'consumable') return this.ask(() => this.api.refund(purchase.token, 'background'));
    if (purchase.productId === null) throw invalid('a subscription to cancel without its product');
    // The API documents refunds of one-time products only; a subscription's renewal is stopped.
    return this.ask(() => this.api.cancelSubscription(purchase.productId!, purchase.token, 'background'));
  }

  /**
   * The subscription's state: its own status (one call); only when Bazaar
   * says `not_found` there, the user's live subscriptions, of which the one
   * of this product counts. Null: nothing of this product is live.
   */
  private async subscriptionOf(productId: string, token: string, priority: BazaarPriority): Promise<BazaarSubscription | null> {
    try {
      return await this.api.subscription(productId, token, priority);
    } catch (error) {
      if (!isBazaarApiError(error, 'not_found')) throw this.mapped(error);
    }
    const live = await this.ask(() => this.api.activeSubscriptions(token, priority));
    const mine = live.filter((s) => s.sku === productId);
    if (mine.length === 0) return null;
    return mine.find((s) => s.chainToken === token) ?? mine.reduce((a, b) => (b.validUntilMs > a.validUntilMs ? b : a));
  }

  private oneTime(
    p: BazaarInappPurchase,
    base: { productId: string; token: string; orderId: string | null; accountRef: string | null; purchasedAtMs: number },
    now: number,
    fresh: boolean,
  ): VerifiedPurchase {
    const refundAt = bazaarRefundCheckAt(base.purchasedAtMs, base.token);
    return this.verified({
      ...base,
      kind: 'consumable',
      state: p.refunded ? 'revoked' : p.consumed ? 'consumed' : 'purchased',
      expiresAtMs: null,
      autoRenew: null,
      eventMs: now,
      consumed: p.consumed,
      nextCheckAtMs: null,
      refundCheckAtMs: fresh && refundAt > now ? refundAt : null,
      needsConsume: !p.consumed && !p.refunded,
    });
  }

  private recurring(
    sub: BazaarSubscription,
    base: { productId: string; token: string; orderId: string | null; accountRef: string | null; purchasedAtMs: number },
    now: number,
    fresh: boolean,
  ): VerifiedPurchase {
    const live = sub.validUntilMs > now;
    const refundAt = bazaarRefundCheckAt(base.purchasedAtMs, base.token);
    return this.verified({
      ...base,
      kind: 'subscription',
      state: live ? (sub.autoRenewing ? 'active' : 'canceled') : 'expired',
      expiresAtMs: live && sub.autoRenewing ? sub.validUntilMs + BAZAAR_RENEWAL_GRACE_MS : sub.validUntilMs,
      autoRenew: live ? sub.autoRenewing : false,
      eventMs: now,
      consumed: false,
      nextCheckAtMs: live ? bazaarRecheckAt(sub.validUntilMs, base.token) : null,
      refundCheckAtMs: fresh && live && refundAt > now ? refundAt : null,
      needsConsume: false,
    });
  }

  private verified(
    v: Pick<
      VerifiedPurchase,
      'kind' | 'productId' | 'state' | 'purchasedAtMs' | 'expiresAtMs' | 'autoRenew' | 'accountRef' | 'orderId' | 'consumed' | 'eventMs' | 'nextCheckAtMs' | 'refundCheckAtMs' | 'needsConsume'
    >,
  ): VerifiedPurchase {
    return {
      kind: v.kind,
      productId: v.productId,
      basePlanId: null,
      state: v.state,
      purchasedAtMs: v.purchasedAtMs,
      expiresAtMs: v.expiresAtMs,
      autoRenew: v.autoRenew,
      accountRef: v.accountRef,
      orderId: v.orderId,
      // Bazaar's linkedSubscriptionToken names the subscription itself, not a token it replaced.
      linkedPurchaseToken: null,
      quantity: 1,
      isTest: false,
      region: null,
      acknowledged: false,
      consumed: v.consumed,
      eventMs: v.eventMs,
      amount: null,
      nextCheckAtMs: v.nextCheckAtMs,
      refundCheckAtMs: v.refundCheckAtMs,
      needsAcknowledge: false,
      needsConsume: v.needsConsume,
    };
  }

  /** A Bazaar call with its errors as the core's: refusals are `invalid`, everything else `unavailable`. */
  private async ask<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw this.mapped(error);
    }
  }

  private mapped(error: unknown): unknown {
    if (!isBazaarApiError(error)) return error;
    if (error.kind === 'not_found' || error.kind === 'invalid' || error.kind === 'refunded') return new StoreError('invalid', error.message);
    if (error.kind === 'config' || error.kind === 'auth') {
      this.log?.error(
        { store: 'bazaar', kind: error.kind, status: error.status, code: error.code },
        'bazaar: the developer API refuses our package or credentials (BAZAAR_PACKAGE_NAME, BAZAAR_PISHKHAN_API_TOKEN)',
      );
    }
    const retry = error.retryAfterSeconds ?? (error.kind === 'config' || error.kind === 'auth' ? 300 : undefined);
    return new StoreError('unavailable', error.message, { retryAfterSeconds: retry });
  }
}
