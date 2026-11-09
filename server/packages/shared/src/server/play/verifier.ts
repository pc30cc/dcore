import { PlayApiError, type PlayDeveloperApi, type ProductPurchaseV2, type SubscriptionPurchaseV2 } from '../clients/playDeveloper.js';
import {
  StoreError,
  type PurchaseClaim,
  type PurchaseRef,
  type PurchaseSubmission,
  type StoreActionOutcome,
  type StoreVerifier,
  type VerifiedPurchase,
} from '../billing/verifier.js';
import { verifiedProduct, verifiedSubscription, type PlayReadOptions } from './state.js';

/**
 * Google Play behind the purchase core's `StoreVerifier`, on the Play
 * Developer API: a subscription is read with `subscriptionsv2.get`, a
 * one-time product (consumable) with `productsv2`; acknowledge, consume and
 * revoke (subscriptions: `subscriptionsv2.revoke` with a full refund;
 * one-time products: `orders.refund` with `revoke=true`).
 *
 * A Play token is opaque, so nothing is checked before the call; the
 * account reference (`obfuscatedExternalAccountId`) comes from Google's
 * answer. A token of another package, or one Google does not know, is
 * refused by Google (4xx → `invalid`). An action Google refuses (4xx) is
 * looked up again: a purchase that is already acknowledged, consumed or
 * refunded answers `already`.
 *
 * Errors: 400, 404 and 410 → `invalid`; a network failure, a timeout, 408,
 * 429, 5xx, 401 and 403 (credentials or permissions: the server's problem,
 * never the buyer's) → `unavailable`; a key that cannot be read →
 * `not_configured`.
 */

export interface PlayStoreVerifierOptions {
  api: PlayDeveloperApi;
  now?: (() => number) | undefined;
}

export interface PlaySubscriptionRead {
  verified: VerifiedPurchase;
  raw: SubscriptionPurchaseV2;
}

export interface PlayProductRead {
  verified: VerifiedPurchase;
  raw: ProductPurchaseV2;
}

const REFUSED = new Set([400, 404, 410]);

/** A Play API failure as the purchase core's error; the message names the call and the status only. */
export function storeErrorOf(error: unknown): StoreError {
  if (error instanceof StoreError) return error;
  if (error instanceof PlayApiError) {
    if (REFUSED.has(error.status)) return new StoreError('invalid', error.message, { cause: error });
    if (error.status === 0 && !error.retryable) return new StoreError('not_configured', error.message, { cause: error });
    return new StoreError('unavailable', error.message, { cause: error, retryAfterSeconds: error.retryAfterSeconds });
  }
  return new StoreError('unavailable', 'Google Play could not be asked', { cause: error });
}

/** Google refused the action itself (not the network, not the server's credentials). */
function refused(error: unknown): boolean {
  return error instanceof PlayApiError && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 403 && error.status !== 408 && error.status !== 429;
}

export class PlayStoreVerifier implements StoreVerifier {
  readonly store = 'play' as const;
  readonly api: PlayDeveloperApi;
  private readonly now: () => number;

  constructor(options: PlayStoreVerifierOptions) {
    this.api = options.api;
    this.now = options.now ?? Date.now;
  }

  inspect(submission: PurchaseSubmission): PurchaseClaim {
    if (submission.store !== 'play') throw new StoreError('invalid', 'not a Google Play purchase');
    return { productId: submission.productId, accountRef: null };
  }

  async verify(submission: PurchaseSubmission): Promise<VerifiedPurchase> {
    if (submission.kind === 'subscription') return (await this.subscription(submission.purchaseToken, { productId: submission.productId })).verified;
    return (await this.product(submission.purchaseToken, { productId: submission.productId })).verified;
  }

  async recheck(purchase: PurchaseRef): Promise<VerifiedPurchase> {
    const productId = purchase.productId ?? undefined;
    if (purchase.kind === 'subscription') return (await this.subscription(purchase.token, { productId })).verified;
    return (await this.product(purchase.token, { productId })).verified;
  }

  /** `subscriptionsv2.get`, mapped by the state table. */
  async subscription(token: string, options: Omit<PlayReadOptions, 'readAtMs'> = {}): Promise<PlaySubscriptionRead> {
    let raw: SubscriptionPurchaseV2;
    try {
      raw = await this.api.getSubscription(token);
    } catch (error) {
      throw storeErrorOf(error);
    }
    return { raw, verified: verifiedSubscription(raw, { ...options, readAtMs: this.now() }) };
  }

  /** `productsv2.getproductpurchasev2`. */
  async product(token: string, options: { productId?: string | undefined; revoked?: boolean | undefined } = {}): Promise<PlayProductRead> {
    let raw: ProductPurchaseV2;
    try {
      raw = await this.api.getProduct(token);
    } catch (error) {
      throw storeErrorOf(error);
    }
    return { raw, verified: verifiedProduct(raw, { ...options, readAtMs: this.now() }) };
  }

  async acknowledge(purchase: PurchaseRef): Promise<StoreActionOutcome> {
    if (purchase.kind === 'subscription') {
      const productId = purchase.productId ?? (await this.subscription(purchase.token)).verified.productId;
      try {
        await this.api.acknowledgeSubscription(productId, purchase.token);
        return 'done';
      } catch (error) {
        if (!refused(error)) throw storeErrorOf(error);
        if ((await this.subscription(purchase.token, { productId })).raw.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED') return 'already';
        throw storeErrorOf(error);
      }
    }
    const productId = purchase.productId ?? (await this.product(purchase.token)).verified.productId;
    try {
      await this.api.acknowledgeProduct(productId, purchase.token);
      return 'done';
    } catch (error) {
      if (!refused(error)) throw storeErrorOf(error);
      if ((await this.product(purchase.token, { productId })).verified.acknowledged) return 'already';
      throw storeErrorOf(error);
    }
  }

  async consume(purchase: PurchaseRef): Promise<StoreActionOutcome> {
    if (purchase.kind !== 'consumable') throw new StoreError('invalid', 'only one-time products are consumed');
    const productId = purchase.productId ?? (await this.product(purchase.token)).verified.productId;
    try {
      await this.api.consumeProduct(productId, purchase.token);
      return 'done';
    } catch (error) {
      if (!refused(error)) throw storeErrorOf(error);
      if ((await this.product(purchase.token, { productId })).verified.consumed) return 'already';
      throw storeErrorOf(error);
    }
  }

  /** Refunds in full and ends access now: a purchase that may not be granted. */
  async revoke(purchase: PurchaseRef): Promise<StoreActionOutcome> {
    if (purchase.kind === 'subscription') {
      try {
        await this.api.revokeSubscription(purchase.token, 'full');
        return 'done';
      } catch (error) {
        if (!refused(error)) throw storeErrorOf(error);
        if ((await this.subscription(purchase.token)).raw.subscriptionState === 'SUBSCRIPTION_STATE_EXPIRED') return 'already';
        throw storeErrorOf(error);
      }
    }
    const read = purchase.orderId === null ? await this.product(purchase.token) : null;
    const orderId = purchase.orderId ?? read?.verified.orderId ?? null;
    if (orderId === null) throw new StoreError('invalid', 'the purchase has no order to refund');
    if (read?.verified.state === 'revoked') return 'already';
    try {
      await this.api.refundOrder(orderId, { revoke: true });
      return 'done';
    } catch (error) {
      if (!refused(error)) throw storeErrorOf(error);
      if ((await this.product(purchase.token)).verified.state === 'revoked') return 'already';
      throw storeErrorOf(error);
    }
  }
}
