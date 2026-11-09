import type { ProductPurchaseV2, SubscriptionPurchaseV2 } from '../clients/playDeveloper.js';
import { StoreError, type VerifiedPurchase, type VerifiedState } from '../billing/verifier.js';

/**
 * Google Play's purchase resources as the purchase core's `VerifiedPurchase`.
 *
 * Subscriptions (`SubscriptionPurchaseV2.subscriptionState`): the table
 * below. Access is decided by the database (`subscription_recompute()`):
 * states active, canceled and grace count while `expiryTime` is in the
 * future (Google extends `expiryTime` through a grace period; during account
 * hold it is in the past), every other state grants nothing.
 *
 * | subscriptionState                          | state     | access              |
 * |--------------------------------------------|-----------|---------------------|
 * | SUBSCRIPTION_STATE_ACTIVE                  | active    | until expiryTime    |
 * | SUBSCRIPTION_STATE_CANCELED                | canceled  | until expiryTime    |
 * | SUBSCRIPTION_STATE_IN_GRACE_PERIOD         | grace     | until expiryTime    |
 * | SUBSCRIPTION_STATE_ON_HOLD                 | on_hold   | none                |
 * | SUBSCRIPTION_STATE_PAUSED                  | paused    | none                |
 * | SUBSCRIPTION_STATE_EXPIRED                 | expired   | none (revoked when  |
 * |                                            |           | a REVOKED RTDN or a |
 * |                                            |           | voided order says)  |
 * | SUBSCRIPTION_STATE_PENDING                 | pending   | none                |
 * | SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED | expired | none (never paid)   |
 * | anything else (UNSPECIFIED, a new value)   | refused as `unavailable`: nothing written, asked again |
 *
 * One-time products (`ProductPurchaseV2`): PENDING → pending; PURCHASED →
 * purchased, or consumed once `consumptionState` says so, or revoked when
 * `refundableQuantity` is 0 (fully refunded); CANCELLED → revoked when it
 * had completed (`purchaseCompletionTime`), else expired (a pending payment
 * that never arrived).
 *
 * The time of a state (`eventMs`) is when Google's answer was read: the
 * resource is the current state, so a read that finishes after another one
 * is never overwritten by it (`last_event_ms`).
 */

export type PlayAccess = 'until_expiry' | 'none';

export const PLAY_SUBSCRIPTION_STATES: Readonly<Record<string, { state: VerifiedState; access: PlayAccess }>> = {
  SUBSCRIPTION_STATE_ACTIVE: { state: 'active', access: 'until_expiry' },
  SUBSCRIPTION_STATE_CANCELED: { state: 'canceled', access: 'until_expiry' },
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: { state: 'grace', access: 'until_expiry' },
  SUBSCRIPTION_STATE_ON_HOLD: { state: 'on_hold', access: 'none' },
  SUBSCRIPTION_STATE_PAUSED: { state: 'paused', access: 'none' },
  SUBSCRIPTION_STATE_EXPIRED: { state: 'expired', access: 'none' },
  SUBSCRIPTION_STATE_PENDING: { state: 'pending', access: 'none' },
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: { state: 'expired', access: 'none' },
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A missed notification is caught this long after the expiry. */
export const PLAY_RECHECK_AFTER_EXPIRY_MS = 2 * HOUR;

/**
 * The first of `fromMs`, `fromMs + step`, `fromMs + 2·step`, ... that is
 * after `nowMs`: the same answer for every read inside one step, so a
 * repeated read schedules the same re-check (one job id) and writes no new
 * `next_check_at`.
 */
export function nextStep(fromMs: number, stepMs: number, nowMs: number): number {
  if (fromMs > nowMs) return fromMs;
  return fromMs + (Math.floor((nowMs - fromMs) / stepMs) + 1) * stepMs;
}

function ms(value: string | undefined): number | null {
  if (value === undefined) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

type LineItem = SubscriptionPurchaseV2['lineItems'][number];

/** The line item a purchase is about: the product asked for when it is there, else the one that runs longest. */
function lineItemOf(items: readonly LineItem[], productId: string | undefined): LineItem | undefined {
  const asked = productId === undefined ? [] : items.filter((i) => i.productId === productId);
  const pool = asked.length > 0 ? asked : items;
  return [...pool].sort((a, b) => (ms(b.expiryTime) ?? 0) - (ms(a.expiryTime) ?? 0))[0];
}

export interface PlayReadOptions {
  /** When the answer was read (epoch ms). */
  readAtMs: number;
  /** The product the app or the stored row names (several line items: that one). */
  productId?: string | undefined;
  /**
   * `if_expired`: an EXPIRED subscription is `revoked` (after a REVOKED
   * notification); `always`: the state is `revoked` whatever Google shows
   * (the current order was refunded).
   */
  revoked?: 'if_expired' | 'always' | undefined;
}

/** `SubscriptionPurchaseV2` → `VerifiedPurchase`. */
export function verifiedSubscription(purchase: SubscriptionPurchaseV2, options: PlayReadOptions): VerifiedPurchase {
  const entry = PLAY_SUBSCRIPTION_STATES[purchase.subscriptionState];
  if (!entry) throw new StoreError('unavailable', `Google Play reports a subscription state this server does not know (${purchase.subscriptionState.slice(0, 60)})`);
  const item = lineItemOf(purchase.lineItems, options.productId);
  if (!item) throw new StoreError('invalid', 'the subscription has no line item');
  const now = options.readAtMs;
  const expiresAtMs = ms(item.expiryTime);
  let state = entry.state;
  if (options.revoked === 'always' || (options.revoked === 'if_expired' && state === 'expired' && purchase.subscriptionState === 'SUBSCRIPTION_STATE_EXPIRED')) state = 'revoked';
  if (entry.access === 'until_expiry' && state !== 'revoked' && expiresAtMs === null) {
    throw new StoreError('unavailable', 'Google Play reports an active subscription without an expiry time');
  }
  // The table keeps an end for every subscription that is not pending; one Google never gave (a pending payment that
  // was canceled) ends when it was read, and grants nothing either way.
  const endMs = expiresAtMs ?? (state === 'pending' ? null : now);
  const accountRef =
    nonEmpty(purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId) ??
    nonEmpty(purchase.outOfAppPurchaseContext?.expiredExternalAccountIdentifiers?.obfuscatedExternalAccountId);
  const pending = purchase.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING';
  const trial = item.offerPhase?.freeTrial !== undefined;
  const currency = item.autoRenewingPlan?.recurringPrice?.currencyCode;
  return {
    kind: 'subscription',
    productId: item.productId,
    basePlanId: nonEmpty(item.offerDetails?.basePlanId),
    state,
    purchasedAtMs: ms(purchase.startTime) ?? now,
    expiresAtMs: endMs,
    autoRenew: item.autoRenewingPlan ? (item.autoRenewingPlan.autoRenewEnabled ?? false) : item.prepaidPlan ? false : null,
    accountRef,
    orderId: nonEmpty(item.latestSuccessfulOrderId),
    // A re-signup after expiry from the Play Store names the expired token instead (outOfAppPurchaseContext).
    linkedPurchaseToken: nonEmpty(purchase.linkedPurchaseToken) ?? nonEmpty(purchase.outOfAppPurchaseContext?.expiredPurchaseToken),
    quantity: 1,
    isTest: purchase.testPurchase !== undefined,
    region: nonEmpty(purchase.regionCode)?.toUpperCase() ?? null,
    acknowledged: purchase.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    consumed: false,
    eventMs: now,
    // Google's answer carries no amount paid (recurringPrice leaves out discounts and taxes): the list price is the
    // estimate, except a free trial, which costs nothing.
    amount: trial && currency ? { micros: '0', currency } : null,
    nextCheckAtMs: subscriptionNextCheck(state, endMs, ms(purchase.pausedStateContext?.autoResumeTime), now),
    refundCheckAtMs: null,
    needsAcknowledge: pending,
    needsConsume: false,
  };
}

/**
 * When to ask Google again if no notification came: after the expiry (a
 * renewal or an end that was not heard), every 3 days in account hold or a
 * pause, every 6 hours while pending; never once it is over.
 */
export function subscriptionNextCheck(state: VerifiedState, expiresAtMs: number | null, autoResumeAtMs: number | null, nowMs: number): number | null {
  switch (state) {
    case 'active':
    case 'canceled':
    case 'grace':
      return expiresAtMs === null ? nextStep(0, 6 * HOUR, nowMs) : nextStep(expiresAtMs + PLAY_RECHECK_AFTER_EXPIRY_MS, 6 * HOUR, nowMs);
    case 'on_hold':
      return nextStep((expiresAtMs ?? 0) + PLAY_RECHECK_AFTER_EXPIRY_MS, 3 * DAY, nowMs);
    case 'paused':
      return autoResumeAtMs !== null ? nextStep(autoResumeAtMs + PLAY_RECHECK_AFTER_EXPIRY_MS, DAY, nowMs) : nextStep((expiresAtMs ?? 0) + PLAY_RECHECK_AFTER_EXPIRY_MS, 3 * DAY, nowMs);
    case 'pending':
      return nextStep(0, 6 * HOUR, nowMs);
    default:
      return null;
  }
}

/** `ProductPurchaseV2` → `VerifiedPurchase` (a consumable). */
export function verifiedProduct(purchase: ProductPurchaseV2, options: Omit<PlayReadOptions, 'revoked'> & { revoked?: boolean | undefined }): VerifiedPurchase {
  const lines = purchase.productLineItem;
  const line = (options.productId !== undefined ? lines.find((l) => l.productId === options.productId) : undefined) ?? lines[0];
  if (!line) throw new StoreError('invalid', 'the purchase has no product line item');
  const now = options.readAtMs;
  const offer = line.productOfferDetails;
  const quantity = Math.max(1, offer?.quantity ?? 1);
  const consumed = offer?.consumptionState === 'CONSUMPTION_STATE_CONSUMED';
  const completedAtMs = ms(purchase.purchaseCompletionTime);
  const purchaseState = purchase.purchaseStateContext?.purchaseState;
  let state: VerifiedState;
  if (options.revoked) state = 'revoked';
  else if (purchaseState === 'PENDING') state = 'pending';
  else if (purchaseState === 'CANCELLED') state = completedAtMs !== null ? 'revoked' : 'expired';
  // `refundableQuantity` "reflects quantity-based partial refunds and full refunds": 0 is read as fully refunded (how a
  // refund shows in `purchaseState` is not documented).
  else if (purchaseState === 'PURCHASED') state = offer?.refundableQuantity === 0 ? 'revoked' : consumed ? 'consumed' : 'purchased';
  else throw new StoreError('unavailable', `Google Play reports a purchase state this server does not know (${String(purchaseState).slice(0, 60)})`);
  return {
    kind: 'consumable',
    productId: line.productId,
    basePlanId: null,
    state,
    purchasedAtMs: completedAtMs ?? now,
    expiresAtMs: null,
    autoRenew: null,
    accountRef: nonEmpty(purchase.obfuscatedExternalAccountId),
    orderId: nonEmpty(purchase.orderId),
    linkedPurchaseToken: null,
    quantity,
    isTest: purchase.testPurchaseContext !== undefined,
    region: nonEmpty(purchase.regionCode)?.toUpperCase() ?? null,
    acknowledged: purchase.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' || consumed,
    consumed,
    eventMs: now,
    amount: null,
    nextCheckAtMs: state === 'pending' ? nextStep(0, 6 * HOUR, now) : null,
    refundCheckAtMs: null,
    // Consuming acknowledges too: a consumable is consumed once it is credited, never acknowledged on its own.
    needsAcknowledge: false,
    needsConsume: state === 'purchased',
  };
}

function nonEmpty(value: string | undefined | null): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
