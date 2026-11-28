import { z } from 'zod';
import { appStoreSchema, productKind, purchaseState, store, storeEventKind, storeEventSource, walletItem } from '../codes.js';
import { pageQuerySchema, pageSchema } from '../pagination.js';
import { auditActionSchema } from './adminRules.js';
import { currencySchema, microsSchema } from './adminStats.js';
import { adminLedgerEntrySchema, adminRefSchema, adminUserRefSchema, sideEffectsSchema } from './adminUsers.js';
import { idSchema, planKeySchema, publicUidSchema, timeSchema } from './common.js';

/**
 * The revenue area of the admin panel: purchases of both stores
 * (`/v1/admin/purchases*`), plan days given (`/v1/admin/grants*`), admin
 * gifts and corrections of the wallet (`/v1/admin/users/{id}/wallet-adjust`,
 * `/v1/admin/wallet-adjustments`).
 *
 * A person is always their public id (`AdminUserRef`; null for a purchase
 * no account could be attributed to). Never a purchase token or one of its
 * hashes: a purchase is shown by every stored column but those, and a
 * token typed in a search travels only in a request body. Money is decimal
 * micros of its currency (`estimated`: the catalogue's list price, not what
 * the store reported).
 */

/** What a purchase page can ask for. `refund_prorated`: a subscription refunded for its unused time. */
export const purchaseActions = ['recheck', 'cancel', 'refund', 'refund_prorated', 'revoke'] as const;
export const purchaseActionSchema = z.enum(purchaseActions);
export type PurchaseAction = z.infer<typeof purchaseActionSchema>;

/** Notes of admin actions (kept in the audit row, a grant or a ledger row; never shown to the person). */
export const REVENUE_NOTE_MAX = 500;
/** Plan days one grant gives, and how far ahead it may start. */
export const GRANT_DAYS_MAX = 366;
export const GRANT_START_AHEAD_DAYS_MAX = 366;
/** A gift's quantity, a correction's size (either way). */
export const WALLET_GIFT_MAX = 1_000;
export const WALLET_CORRECTION_MAX = 10_000;
/** Per admin per hour (fail closed): re-checks, the store actions together (cancel, refund, mark refunded), gifts and corrections together, searches that link a purchase to a person. */
export const PURCHASE_RECHECKS_PER_HOUR = 120;
export const PURCHASE_ACTIONS_PER_HOUR = 60;
export const BILLING_GIFTS_PER_HOUR = 120;
export const PURCHASE_LOOKUPS_PER_HOUR = 120;

const note = z.string().trim().min(1).max(REVENUE_NOTE_MAX);
const quantity = z.number().int();

// ─── Purchases ────────────────────────────────────────────────────────────

export const adminPurchaseSummarySchema = z.object({
  id: idSchema,
  store: store.schema,
  /** The store's sku; with Play's base plan for a subscription. */
  productId: z.string(),
  basePlanId: z.string().nullable(),
  kind: productKind.schema,
  /** A subscription's plan key. */
  plan: z.string().nullable(),
  /** A consumable's item and what one unit credits. */
  item: walletItem.schema.nullable(),
  grantQuantity: quantity.nullable(),
  quantity,
  state: purchaseState.schema,
  /** Null: unclaimed (no account could be attributed yet). */
  user: adminUserRefSchema.nullable(),
  purchasedAt: timeSchema,
  expiresAt: timeSchema.nullable(),
  autoRenew: z.boolean().nullable(),
  orderId: z.string().nullable(),
  isTest: z.boolean(),
  region: z.string().nullable(),
});
export type AdminPurchaseSummary = z.infer<typeof adminPurchaseSummarySchema>;

/** `store`: the tab; `state`: one state only. Newest first. */
export const adminPurchaseListQuerySchema = pageQuerySchema.extend({ store: appStoreSchema, state: purchaseState.schema.optional() });
export type AdminPurchaseListQuery = z.infer<typeof adminPurchaseListQuerySchema>;
/**
 * A row of a store's list: the summary without the order id. The list is
 * unmetered and pages a whole store, so it never pairs order ids with
 * people in bulk; the order id is on the page (one purchase) and in the
 * search's answer (a hit by order id or token is metered and audited).
 */
export const adminPurchaseListItemSchema = adminPurchaseSummarySchema.omit({ orderId: true });
export type AdminPurchaseListItem = z.infer<typeof adminPurchaseListItemSchema>;
/** `connected`: this server holds the store's credentials (false: re-check and the store's own actions are off). */
export const adminPurchaseListSchema = pageSchema(adminPurchaseListItemSchema).extend({ connected: z.boolean() });
export type AdminPurchaseList = z.infer<typeof adminPurchaseListSchema>;

/** A purchase id, a person's public id, an order id or a purchase token: in the body, never in an address. */
export const adminPurchaseSearchSchema = z.strictObject({ q: z.string().trim().min(1).max(4096) });
export type AdminPurchaseSearch = z.infer<typeof adminPurchaseSearchSchema>;
export const purchaseMatchSchema = z.enum(['id', 'person', 'order', 'token']);
export type PurchaseMatch = z.infer<typeof purchaseMatchSchema>;
/** `matchedBy`: what the text was (null: nothing matched). A person's newest 50. */
export const adminPurchaseSearchResultSchema = z.object({ items: z.array(adminPurchaseSummarySchema), matchedBy: purchaseMatchSchema.nullable() });
export type AdminPurchaseSearchResult = z.infer<typeof adminPurchaseSearchResultSchema>;

export const adminPurchaseEventSchema = z.object({
  id: idSchema,
  at: timeSchema,
  event: storeEventKind.schema,
  source: storeEventSource.schema,
  stateFrom: purchaseState.schema.nullable(),
  stateTo: purchaseState.schema,
  expiresAt: timeSchema.nullable(),
  /** A payment or a refund: what the store reported, or the list price (`estimated`). */
  amount: z.object({ micros: microsSchema, currency: currencySchema, estimated: z.boolean() }).nullable(),
  orderId: z.string().nullable(),
});
export type AdminPurchaseEvent = z.infer<typeof adminPurchaseEventSchema>;
export const adminPurchaseEventPageSchema = pageSchema(adminPurchaseEventSchema);
export type AdminPurchaseEventPage = z.infer<typeof adminPurchaseEventPageSchema>;

/**
 * An admin row of the purchase's own history: who re-checked, refunded,
 * stopped the renewal or marked it refunded, and why. `error` (a
 * `purchase.action_failed` row): the store refused, or could not be
 * reached; `failed` names the action.
 */
export const adminPurchaseHistorySchema = z.object({
  id: idSchema,
  at: timeSchema,
  action: auditActionSchema,
  admin: adminRefSchema.nullable(),
  note: z.string().nullable(),
  error: z.enum(['refused', 'unavailable']).nullable(),
  failed: purchaseActionSchema.nullable(),
});
export type AdminPurchaseHistory = z.infer<typeof adminPurchaseHistorySchema>;

export const adminPurchaseDetailSchema = adminPurchaseSummarySchema.extend({
  /** ISO 8601 period of a subscription product (`P1M`). */
  period: z.string().nullable(),
  acknowledgedAt: timeSchema.nullable(),
  consumedAt: timeSchema.nullable(),
  creditedAt: timeSchema.nullable(),
  nextCheckAt: timeSchema.nullable(),
  updatedAt: timeSchema,
  /** The person's plan of this store comes from this purchase now. */
  counts: z.boolean(),
  /** The purchase this one replaced (an upgrade, a plan change) and the one that replaced it. */
  replaces: idSchema.nullable(),
  replacedBy: idSchema.nullable(),
  /** Consumables: what was credited and taken back (a refund takes back what is left, never below zero). */
  wallet: z.object({ credited: quantity, takenBack: quantity }).nullable(),
  /** Newest first, the first page (50); `GET …/events` pages on. */
  events: adminPurchaseEventPageSchema,
  /** The newest 20 admin rows about this purchase. */
  history: z.array(adminPurchaseHistorySchema),
  /** This server holds the store's credentials. */
  connected: z.boolean(),
  /** What the caller may do now: the store's capability, the state, the caller's permissions and the connection together. */
  available: z.array(purchaseActionSchema),
});
export type AdminPurchaseDetail = z.infer<typeof adminPurchaseDetailSchema>;

/** `note`: optional for a re-check. */
export const adminPurchaseRecheckSchema = z.strictObject({ note: note.optional() });
export type AdminPurchaseRecheck = z.infer<typeof adminPurchaseRecheckSchema>;
/** `from`: the state the admin saw (another one now: 409 `purchase_changed`). */
export const adminPurchaseCancelSchema = z.strictObject({ from: purchaseState.schema, note });
export type AdminPurchaseCancel = z.infer<typeof adminPurchaseCancelSchema>;
export const adminPurchaseRefundSchema = z.strictObject({ from: purchaseState.schema, prorated: z.boolean().default(false), note });
export type AdminPurchaseRefund = z.input<typeof adminPurchaseRefundSchema>;
export const adminPurchaseRevokeSchema = z.strictObject({ from: purchaseState.schema, note });
export type AdminPurchaseRevoke = z.infer<typeof adminPurchaseRevokeSchema>;

/**
 * - `done`: the store did it (or the server's state moved);
 * - `already`: the store had done it before;
 * - `unchanged`: a re-check found nothing new;
 * - `pending`: the store did it; the server learns it from the re-check it queued.
 */
export const purchaseOutcomeSchema = z.enum(['done', 'already', 'unchanged', 'pending']);
export type PurchaseOutcome = z.infer<typeof purchaseOutcomeSchema>;
export const adminPurchaseActionResultSchema = z.object({ purchase: adminPurchaseDetailSchema, outcome: purchaseOutcomeSchema, sideEffects: sideEffectsSchema });
export type AdminPurchaseActionResult = z.infer<typeof adminPurchaseActionResultSchema>;

// ─── Plan days ────────────────────────────────────────────────────────────

/** `revoked`: ended early by an admin. */
export const grantStateSchema = z.enum(['scheduled', 'active', 'ended', 'revoked']);
export type GrantState = z.infer<typeof grantStateSchema>;

export const adminGrantSchema = z.object({
  id: idSchema,
  user: adminUserRefSchema,
  plan: z.string(),
  startsAt: timeSchema,
  endsAt: timeSchema,
  state: grantStateSchema,
  reason: z.string(),
  grantedBy: adminRefSchema.nullable(),
  revokedAt: timeSchema.nullable(),
  revokedBy: adminRefSchema.nullable(),
  revokeReason: z.string().nullable(),
});
export type AdminGrant = z.infer<typeof adminGrantSchema>;

/** `all`: newest first; `active`: running or to come, soonest end first. `user`: one person's. */
export const adminGrantListQuerySchema = pageQuerySchema.extend({ state: z.enum(['active', 'all']).default('all'), user: publicUidSchema.optional() });
export type AdminGrantListQuery = z.infer<typeof adminGrantListQuerySchema>;
export const adminGrantListSchema = pageSchema(adminGrantSchema);
export type AdminGrantList = z.infer<typeof adminGrantListSchema>;

/**
 * Days of a plan, from now or from a later instant (`startsAt`, at most
 * {@link GRANT_START_AHEAD_DAYS_MAX} days ahead). `requestId`: made once per
 * dialog; a repeat is 409 `duplicate_request` (the first one was done).
 */
export const adminGrantCreateSchema = z.strictObject({
  requestId: z.uuid(),
  user: publicUidSchema,
  plan: planKeySchema,
  days: z.number().int().min(1).max(GRANT_DAYS_MAX),
  startsAt: timeSchema.optional(),
  reason: note,
});
export type AdminGrantCreate = z.infer<typeof adminGrantCreateSchema>;
export const adminGrantRevokeSchema = z.strictObject({ reason: note });
export type AdminGrantRevoke = z.infer<typeof adminGrantRevokeSchema>;
export const adminGrantResultSchema = z.object({ grant: adminGrantSchema, sideEffects: sideEffectsSchema });
export type AdminGrantResult = z.infer<typeof adminGrantResultSchema>;

// ─── Wallet ───────────────────────────────────────────────────────────────

/** The balance a correction moves: gifts (the server's own), or a store's. */
export const walletBalanceSchema = z.enum(['gifts', 'play', 'bazaar']);
export type WalletBalance = z.infer<typeof walletBalanceSchema>;

/**
 * A gift (`quantity` to the gifts balance) or a correction (`delta` on one
 * balance, either way, never below zero: 422 `insufficient_balance` and
 * nothing written). `requestId` as for a grant.
 */
export const adminWalletAdjustSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('gift'), requestId: z.uuid(), item: walletItem.schema, quantity: z.number().int().min(1).max(WALLET_GIFT_MAX), note }),
  z.strictObject({
    kind: z.literal('correction'),
    requestId: z.uuid(),
    item: walletItem.schema,
    balance: walletBalanceSchema.default('gifts'),
    delta: z
      .number()
      .int()
      .min(-WALLET_CORRECTION_MAX)
      .max(WALLET_CORRECTION_MAX)
      .refine((d) => d !== 0, 'must not be zero'),
    note,
  }),
]);
export type AdminWalletAdjust = z.input<typeof adminWalletAdjustSchema>;

/** An admin gift or correction, with the person it moved. */
export const adminWalletAdjustmentSchema = adminLedgerEntrySchema.extend({ user: adminUserRefSchema });
export type AdminWalletAdjustment = z.infer<typeof adminWalletAdjustmentSchema>;
export const adminWalletAdjustResultSchema = z.object({ entry: adminWalletAdjustmentSchema, sideEffects: sideEffectsSchema });
export type AdminWalletAdjustResult = z.infer<typeof adminWalletAdjustResultSchema>;
export const adminWalletAdjustmentListSchema = pageSchema(adminWalletAdjustmentSchema);
export type AdminWalletAdjustmentList = z.infer<typeof adminWalletAdjustmentListSchema>;
