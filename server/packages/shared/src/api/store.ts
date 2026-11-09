import { z } from 'zod';
import { appStores, productBadge, purchaseState, walletItem } from '../codes.js';
import { basePlanIdSchema, entitlementsSchema, idSchema, productIdSchema, timeSchema } from './common.js';

/**
 * The store routes (§3.12): the catalogue of the session's store, purchases
 * sent for verification, restore, and boosts. Prices are never on the wire:
 * the app shows the store SDK's own price. Purchases are granted only after
 * the server verified them with the store.
 */

export const planKeySchema = z.enum(['plus', 'premium']);
export const billingPeriodSchema = z.enum(['P1W', 'P1M', 'P3M', 'P6M', 'P12M']);
export const productBadgeSchema = z.enum(productBadge.publicNames as ['popular', 'best_value', 'new']);
export const purchaseKindSchema = z.enum(['subscription', 'consumable']);
export type PurchaseKind = z.infer<typeof purchaseKindSchema>;

/** Opaque purchase tokens as the stores issue them (Play's are long; Bazaar's short). */
export const purchaseTokenSchema = z.string().min(8).max(4096).regex(/^[\x21-\x7e]+$/, 'must be printable ASCII');

/** `billingRef`: a keyed permutation of the account id, sent as Play's obfuscatedAccountId and Bazaar's payload. Never the user id. */
export const billingRefSchema = z.string().regex(/^[a-z2-7]{13}$/, 'must be a billing reference');

export const subscriptionProductSchema = z.object({
  productId: productIdSchema,
  /** Play only: the tier's base plan. */
  basePlanId: basePlanIdSchema.optional(),
  plan: planKeySchema,
  period: billingPeriodSchema,
  badge: productBadgeSchema.optional(),
  sort: z.number().int(),
});
export type SubscriptionProduct = z.infer<typeof subscriptionProductSchema>;

export const consumableProductSchema = z.object({
  productId: productIdSchema,
  item: walletItem.schema,
  quantity: z.number().int().min(1).max(1_000),
  badge: productBadgeSchema.optional(),
  sort: z.number().int(),
});
export type ConsumableProduct = z.infer<typeof consumableProductSchema>;

/** `GET /v1/store/products`: the active products of the session's store. */
export const storeProductsSchema = z.object({
  store: z.enum(appStores),
  billingRef: billingRefSchema,
  subscriptions: z.array(subscriptionProductSchema),
  consumables: z.array(consumableProductSchema),
});
export type StoreProducts = z.infer<typeof storeProductsSchema>;

/** `POST /v1/store/play/purchases`. */
export const playPurchaseRequestSchema = z.object({
  productId: productIdSchema,
  purchaseToken: purchaseTokenSchema,
  kind: purchaseKindSchema,
});
export type PlayPurchaseRequest = z.infer<typeof playPurchaseRequestSchema>;

/** `POST /v1/store/bazaar/purchases`: Poolakey's `originalJson` and `dataSignature`, checked before any store call. */
export const bazaarPurchaseRequestSchema = z.object({
  productId: productIdSchema,
  purchaseToken: purchaseTokenSchema,
  originalJson: z.string().min(2).max(8_192),
  signature: z.string().min(16).max(2_048).regex(/^[A-Za-z0-9+/=_-]+$/, 'must be base64'),
  kind: purchaseKindSchema,
});
export type BazaarPurchaseRequest = z.infer<typeof bazaarPurchaseRequestSchema>;

/** A purchase body of either store (restore): the Bazaar fields are set for Bazaar purchases only. */
export const restorePurchaseSchema = z.object({
  productId: productIdSchema,
  purchaseToken: purchaseTokenSchema,
  kind: purchaseKindSchema,
  originalJson: z.string().min(2).max(8_192).optional(),
  signature: z
    .string()
    .min(16)
    .max(2_048)
    .regex(/^[A-Za-z0-9+/=_-]+$/)
    .optional(),
});
export type RestorePurchase = z.infer<typeof restorePurchaseSchema>;

/** `POST /v1/store/restore`: only tokens the app does not know the server has; at most 20. */
export const restoreRequestSchema = z.object({ purchases: z.array(restorePurchaseSchema).min(1).max(20) });
export type RestoreRequest = z.infer<typeof restoreRequestSchema>;

/** The purchase states a client may see (store_purchases.state names; `unclaimed` stays on the server). */
export const purchaseStateSchema = z.enum(
  purchaseState.publicNames.filter((name) => name !== 'unclaimed') as [
    'pending',
    'active',
    'canceled',
    'grace',
    'on_hold',
    'paused',
    'expired',
    'revoked',
    'replaced',
    'consumed',
    'purchased',
  ],
);
export type PurchaseStateName = z.infer<typeof purchaseStateSchema>;

export const purchaseRecordSchema = z.object({
  id: idSchema,
  state: purchaseStateSchema,
  productId: productIdSchema,
  expiresAt: timeSchema.optional(),
});
export type PurchaseRecord = z.infer<typeof purchaseRecordSchema>;

/** 200: a verified purchase and the entitlements it left. */
export const purchaseResultSchema = z.object({ purchase: purchaseRecordSchema, entitlements: entitlementsSchema });
export type PurchaseResult = z.infer<typeof purchaseResultSchema>;

/** 202: the store holds the payment (PENDING): nothing is granted until it completes. */
export const purchasePendingSchema = z.object({ purchase: z.object({ state: z.literal('pending') }) });
export type PurchasePending = z.infer<typeof purchasePendingSchema>;

/**
 * One restored token: its purchase state, or why nothing was granted:
 * `invalid` (the store does not know it, or it is not ours), `other_account`
 * (it belongs to another account), `unavailable` (the store could not be
 * asked now: send it again later).
 */
export const restoreStateSchema = z.union([purchaseStateSchema, z.enum(['invalid', 'other_account', 'unavailable'])]);
export type RestoreState = z.infer<typeof restoreStateSchema>;

export const restoreResultSchema = z.object({
  results: z.array(
    z.object({
      purchaseToken: purchaseTokenSchema,
      state: restoreStateSchema,
      /**
       * True only when this restore granted or credited the token for the
       * first time (the server did not know it, or held it as pending, and
       * now it gives access or was credited); false for a token already
       * granted before, and for every state that grants nothing.
       */
      fresh: z.boolean(),
    }),
  ),
  entitlements: entitlementsSchema,
});
export type RestoreResult = z.infer<typeof restoreResultSchema>;

export const boostKindSchema = z.enum(['boost', 'spotlight']);
export type BoostKind = z.infer<typeof boostKindSchema>;
export const boostRequestSchema = z.object({ kind: boostKindSchema });
/** 201: when the boost ends (a boost already running answers with its own end and spends nothing). */
export const boostStartedSchema = z.object({ endsAt: timeSchema });
export type BoostStarted = z.infer<typeof boostStartedSchema>;
