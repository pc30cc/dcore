import { z } from 'zod';
import { appStores, productBadge, walletItem } from '../codes.js';
import {
  NEW_PLAN_KEY,
  PLAN_DESCRIPTION_MAX,
  PLAN_NAME_MAX,
  PLAN_QUOTA_MAX,
  planFlagDefaults,
  planFlagKeys,
  planFlagsSchema,
  planQuotaKeys,
  planQuotasSchema,
  type PlanFlag,
  type PlanQuota,
} from '../plans.js';
import { basePlanIdSchema, idSchema, planKeySchema, productIdSchema, timeSchema } from './common.js';
import { billingPeriodSchema, productBadgeSchema, purchaseKindSchema } from './store.js';

/**
 * The admin panel's plan and store-product routes (`/v1/admin/plans*`,
 * `/v1/admin/plan-ranks`, `/v1/admin/store-products*`). Plans are addressed
 * by key (neutral, never changed, never reused); products by id. Ids are
 * decimal strings on the wire.
 *
 * Bodies are strict: a key the schema does not know (a feature the code has
 * no switch for, a locale the product does not ship) is refused.
 */

/** A text people read: trimmed, no control characters. */
function text(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]*$/u, 'must not contain control characters');
}

function localized(max: number) {
  return z.strictObject({ fa: text(max).optional(), en: text(max).optional(), tr: text(max).optional() });
}

/** Names per locale; at least a Persian or an English one (the fallbacks every reader uses). */
export const planNamesInputSchema = localized(PLAN_NAME_MAX).refine((names) => names.fa !== undefined || names.en !== undefined, {
  message: 'a Persian or an English name is required',
});
/** Descriptions per locale; `{}` removes them. */
export const planDescriptionsInputSchema = localized(PLAN_DESCRIPTION_MAX);

export const planFlagsInputSchema = z.strictObject(
  Object.fromEntries(planFlagKeys.map((key) => [key, z.boolean().optional()])) as Record<PlanFlag, z.ZodOptional<z.ZodBoolean>>,
);
export const planQuotasInputSchema = z.strictObject(
  Object.fromEntries(planQuotaKeys.map((key) => [key, z.number().int().min(-1).max(PLAN_QUOTA_MAX).optional()])) as Record<
    PlanQuota,
    z.ZodOptional<z.ZodNumber>
  >,
);

/** Upgrade order of a plan made or moved in the panel (free is 0). */
export const planRankInputSchema = z.number().int().min(1).max(9_999);
/** Display order. */
export const sortInputSchema = z.number().int().min(-32_768).max(32_767);
/** A badge, or null for none. */
export const badgeInputSchema = productBadgeSchema.nullable();

export const adminPlanKeyParamsSchema = z.object({ key: planKeySchema });

const localizedOut = z.object({ fa: z.string().optional(), en: z.string().optional(), tr: z.string().optional() });

export const adminPlanSchema = z.object({
  id: idSchema,
  key: planKeySchema,
  rank: z.number().int().min(0),
  sort: z.number().int(),
  /** On sale (its active products are listed), unless archived. */
  active: z.boolean(),
  archivedAt: timeSchema.nullable(),
  /** active, not archived and not the free plan: what the paywall lists (with an active product of the store). */
  onSale: z.boolean(),
  names: localizedOut,
  descriptions: localizedOut,
  badge: productBadgeSchema.nullable(),
  /** Every switch the code knows; a plan without a row has the default. */
  features: planFlagsSchema,
  /** Every quota the code knows; -1 is unlimited. */
  quotas: planQuotasSchema,
  /** Someone holds the plan now (a store subscription or a grant): it is never deleted, and archiving it keeps them on it. */
  hasLiveSubscriptions: z.boolean(),
  updatedAt: timeSchema,
});
export type AdminPlan = z.infer<typeof adminPlanSchema>;

export const planFeatureCatalogSchema = z.object({
  flags: z.array(z.object({ key: z.enum(planFlagKeys), default: z.boolean() })),
  quotas: z.array(z.object({ key: z.enum(planQuotaKeys), default: z.number().int() })),
});

/** What the panel's plan editor offers, from the code. */
export function planFeatureCatalog(): z.infer<typeof planFeatureCatalogSchema> {
  return {
    flags: planFlagKeys.map((key) => ({ key, default: planFlagDefaults[key] })),
    quotas: planQuotaKeys.map((key) => ({ key, default: 0 })),
  };
}

/** `GET /v1/admin/plans`: every plan (archived ones too) by rank, and the switches and quotas the code knows. */
export const adminPlanListSchema = z.object({ items: z.array(adminPlanSchema), catalog: planFeatureCatalogSchema });

/** `POST /v1/admin/plans`. Features and quotas start from `copyFrom`'s (else the defaults), then the ones given. */
export const adminPlanCreateSchema = z.strictObject({
  key: z.string().regex(NEW_PLAN_KEY, 'must be a new plan key: a lowercase letter, then 1-30 of a-z, 0-9, _'),
  names: planNamesInputSchema,
  descriptions: planDescriptionsInputSchema.optional(),
  /** Default: above every plan. */
  rank: planRankInputSchema.optional(),
  sort: sortInputSchema.optional(),
  /** Default true: the plan shows once one of its products is active. */
  active: z.boolean().optional(),
  badge: badgeInputSchema.optional(),
  copyFrom: planKeySchema.optional(),
  features: planFlagsInputSchema.optional(),
  quotas: planQuotasInputSchema.optional(),
});
export type AdminPlanCreate = z.infer<typeof adminPlanCreateSchema>;

/** `PATCH /v1/admin/plans/:key`: only what is given changes; `names` and `descriptions` replace the whole map; features and quotas merge. */
export const adminPlanUpdateSchema = z.strictObject({
  names: planNamesInputSchema.optional(),
  descriptions: planDescriptionsInputSchema.optional(),
  rank: planRankInputSchema.optional(),
  sort: sortInputSchema.optional(),
  active: z.boolean().optional(),
  badge: badgeInputSchema.optional(),
  features: planFlagsInputSchema.optional(),
  quotas: planQuotasInputSchema.optional(),
});
export type AdminPlanUpdate = z.infer<typeof adminPlanUpdateSchema>;

/** `PUT /v1/admin/plan-ranks`: every plan but free, best last; they get ranks 1..n in this order. */
export const adminPlanRanksSchema = z.strictObject({ order: z.array(planKeySchema).min(1).max(200) });

// ─── Store products ───────────────────────────────────────────────────────

export const listPriceSchema = z.strictObject({
  /** ISO 4217 minor units of `currency` (IRR: rials × 100). An estimate for revenue reports; never sent to apps. */
  amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(/^[A-Z]{3}$/, 'must be an ISO 4217 code'),
});

export const adminStoreSchema = z.enum(appStores);
/** The periods the apps know (Cafe Bazaar has no weekly period). */
export const adminPeriodSchema = billingPeriodSchema;

export const adminProductSchema = z.object({
  id: idSchema,
  store: adminStoreSchema,
  kind: purchaseKindSchema,
  productId: productIdSchema,
  basePlanId: basePlanIdSchema.nullable(),
  /** A subscription's plan key. */
  plan: planKeySchema.nullable(),
  period: z
    .string()
    .regex(/^P[1-9][0-9]?[DWMY]$/)
    .nullable(),
  /** A consumable's wallet item and quantity. */
  item: walletItem.schema.nullable(),
  quantity: z.number().int().positive().nullable(),
  badge: productBadgeSchema.nullable(),
  sort: z.number().int(),
  /** Listed to apps (with its plan on sale). */
  active: z.boolean(),
  listPrice: z.object({ amountMinor: z.number().int().nonnegative(), currency: z.string() }).nullable(),
  /** A purchase names it: what it grants (product id, base plan, plan, period, item, quantity) is fixed. */
  hasPurchases: z.boolean(),
  updatedAt: timeSchema,
});
export type AdminProduct = z.infer<typeof adminProductSchema>;

export const adminProductListQuerySchema = z.object({ store: adminStoreSchema.optional() });
export const adminProductListSchema = z.object({ items: z.array(adminProductSchema) });
export const adminProductIdParamsSchema = z.object({
  id: z
    .string()
    .regex(/^[1-9][0-9]{0,4}$/, 'must be a product id')
    .refine((value) => Number(value) <= 32_767, 'must be a product id'),
});

const productCommon = {
  store: adminStoreSchema,
  productId: productIdSchema,
  badge: badgeInputSchema.optional(),
  sort: sortInputSchema.optional(),
  /** Default false: a row goes on once the product exists in that store's console. */
  active: z.boolean().optional(),
  listPrice: listPriceSchema.nullable().optional(),
};

/** `POST /v1/admin/store-products`. Play subscriptions name their base plan; Cafe Bazaar rows never do. */
export const adminProductCreateSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('subscription'),
    ...productCommon,
    basePlanId: basePlanIdSchema.optional(),
    plan: planKeySchema,
    period: adminPeriodSchema,
  }),
  z.strictObject({
    kind: z.literal('consumable'),
    ...productCommon,
    item: walletItem.schema,
    quantity: z.number().int().min(1).max(1_000),
  }),
]);
export type AdminProductCreate = z.infer<typeof adminProductCreateSchema>;

/** `PATCH /v1/admin/store-products/:id`: store and kind never change; what it grants only while no purchase names it. */
export const adminProductUpdateSchema = z.strictObject({
  productId: productIdSchema.optional(),
  basePlanId: basePlanIdSchema.nullable().optional(),
  plan: planKeySchema.optional(),
  period: adminPeriodSchema.optional(),
  item: walletItem.schema.optional(),
  quantity: z.number().int().min(1).max(1_000).optional(),
  badge: badgeInputSchema.optional(),
  sort: sortInputSchema.optional(),
  active: z.boolean().optional(),
  listPrice: listPriceSchema.nullable().optional(),
});
export type AdminProductUpdate = z.infer<typeof adminProductUpdateSchema>;

/** The badge code of a wire badge (null: none). */
export function badgeCode(badge: z.infer<typeof productBadgeSchema> | null): number {
  return badge === null ? 0 : productBadge.code(badge);
}
