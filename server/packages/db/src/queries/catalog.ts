import { z } from 'zod';
import { many, maybeOne, one, query, sql, type SqlFragment } from '../query.js';
import { defineQuery } from './define.js';

/**
 * The admin panel's plans and store products (0007, 0022, 0024). Rare
 * writes and the panel's own reads, never on an app request path: apps read
 * the catalogue from the configuration snapshot in memory, which every
 * process loads again after the panel's `cfg:changed`.
 *
 * Codes as in 0007's and 0024's comments: store 1 Play, 2 Cafe Bazaar; kind
 * 1 subscription, 2 consumable; grant_item 1-4; badge 0-3. Times leave as
 * epoch milliseconds. Plan feature values are JSON numbers (quotas, -1
 * unlimited) or booleans (switches).
 */

const ms = (column: SqlFragment) => sql`(extract(epoch FROM ${column}) * 1000)::bigint`;
const epochMs = z.number().int();
const texts = z.record(z.string(), z.unknown());

export const catalogPlanRowSchema = z.object({
  id: z.number().int().positive(),
  key: z.string(),
  rank: z.number().int(),
  sort: z.number().int(),
  active: z.boolean(),
  archivedAtMs: epochMs.nullable(),
  badge: z.number().int(),
  names: texts,
  descriptions: texts,
  features: z.record(z.string(), z.union([z.number(), z.boolean()])),
  /** Someone holds it now (a live subscriptions row, store purchases and grants alike). */
  live: z.boolean(),
  updatedAtMs: epochMs,
});
export type CatalogPlanRow = z.infer<typeof catalogPlanRowSchema>;

/** `p` is the plans row in the surrounding statement. */
const planView = sql`jsonb_build_object(
    'id', p.id, 'key', p.key, 'rank', p.rank, 'sort', p.sort, 'active', p.is_active,
    'archivedAtMs', ${ms(sql`p.archived_at`)}, 'badge', p.badge, 'names', p.names, 'descriptions', p.descriptions,
    'features', (SELECT coalesce(jsonb_object_agg(f.feature, f.value), '{}'::jsonb) FROM plan_features f WHERE f.plan_id = p.id),
    'live', EXISTS (SELECT 1 FROM subscriptions s WHERE s.plan_id = p.id AND s.expires_at > now()),
    'updatedAtMs', ${ms(sql`p.updated_at`)})`;

/** Every plan, archived ones too, by rank. */
export const catalogPlans = defineQuery({ name: 'catalog.plans', statements: 1 }, async (db): Promise<CatalogPlanRow[]> => {
  const rows = await many<{ plan: unknown }>(db, sql`SELECT ${planView} AS plan FROM plans p ORDER BY p.rank, p.id`);
  return rows.map((row) => catalogPlanRowSchema.parse(row.plan));
});

/** One plan by key. */
export const catalogPlan = defineQuery({ name: 'catalog.plan', statements: 1 }, async (db, key: string): Promise<CatalogPlanRow | null> => {
  const row = await maybeOne<{ plan: unknown }>(db, sql`SELECT ${planView} AS plan FROM plans p WHERE p.key = ${key}`);
  return row ? catalogPlanRowSchema.parse(row.plan) : null;
});

/*
 * The locking reads: the row lock in a statement of its own, then the view
 * in the next one. A view read in the locking statement itself would be
 * stale after a wait for the lock: READ COMMITTED fetches the locked row
 * again, but the subqueries of the view (features, live, hasPurchases) keep
 * the snapshot taken before the wait. The next statement takes a new one,
 * after the other transaction committed.
 *
 * Plans are locked FOR NO KEY UPDATE: two edits of the catalogue still wait
 * for each other, but a purchase or grant whose foreign key checks a plan
 * (FOR KEY SHARE) does not wait for an edit that changes no key. A product
 * is locked FOR UPDATE: it waits for a purchase that is writing the first
 * row naming it (FOR KEY SHARE), so its `hasPurchases` is read after it.
 */

/** One plan by key, its row locked FOR NO KEY UPDATE until the transaction ends; null when there is no such plan. */
export const catalogPlanForUpdate = defineQuery({ name: 'catalog.planForUpdate', statements: 2 }, async (tx, key: string): Promise<CatalogPlanRow | null> => {
  const locked = await maybeOne<{ id: number }>(tx, sql`SELECT p.id FROM plans p WHERE p.key = ${key} FOR NO KEY UPDATE`);
  if (!locked) return null;
  const row = await maybeOne<{ plan: unknown }>(tx, sql`SELECT ${planView} AS plan FROM plans p WHERE p.id = ${locked.id}`);
  return row ? catalogPlanRowSchema.parse(row.plan) : null;
});

/** Every plan by rank, every row locked FOR NO KEY UPDATE (in id order) until the transaction ends (a reorder). */
export const catalogPlansForUpdate = defineQuery({ name: 'catalog.plansForUpdate', statements: 2 }, async (tx): Promise<CatalogPlanRow[]> => {
  await many(tx, sql`SELECT p.id FROM plans p ORDER BY p.id FOR NO KEY UPDATE`);
  const rows = await many<{ plan: unknown }>(tx, sql`SELECT ${planView} AS plan FROM plans p ORDER BY p.rank, p.id`);
  return rows.map((row) => catalogPlanRowSchema.parse(row.plan));
});

export interface CatalogPlanRef {
  id: number;
  key: string;
  archived: boolean;
}

/** A plan a product names, held FOR SHARE (an archive of it waits for this transaction, then also turns the product off). */
export const catalogPlanRef = defineQuery({ name: 'catalog.planRef', statements: 1 }, async (db, key: string): Promise<CatalogPlanRef | null> => {
  const row = await maybeOne<{ id: number; key: string; archived: boolean }>(
    db,
    sql`SELECT p.id::integer AS id, p.key, p.archived_at IS NOT NULL AS archived FROM plans p WHERE p.key = ${key} FOR SHARE`,
  );
  return row ? { id: Number(row.id), key: row.key, archived: row.archived } : null;
});

export interface CatalogPlanInsert {
  key: string;
  /** null: above every plan. */
  rank: number | null;
  sort: number;
  active: boolean;
  badge: number;
  names: Record<string, string>;
  descriptions: Record<string, string>;
  /** Every value the plan starts with (feature → number or boolean). */
  features: Record<string, number | boolean>;
}

/** A new plan and its feature rows in one statement; null when the key is taken. */
export const catalogPlanCreate = defineQuery({ name: 'catalog.planCreate', statements: 1 }, async (tx, input: CatalogPlanInsert): Promise<number | null> => {
  const row = await maybeOne<{ id: number }>(
    tx,
    sql`WITH p AS (
          INSERT INTO plans (rank, sort, is_active, key, names, descriptions, badge)
          VALUES (coalesce(${input.rank}::smallint, (SELECT coalesce(max(rank), 0) + 1 FROM plans)::smallint), ${input.sort}::smallint,
                  ${input.active}::boolean, ${input.key}::text, ${JSON.stringify(input.names)}::jsonb, ${JSON.stringify(input.descriptions)}::jsonb,
                  ${input.badge}::smallint)
          ON CONFLICT (key) DO NOTHING
          RETURNING id),
        f AS (
          INSERT INTO plan_features (plan_id, feature, value)
          SELECT p.id, e.key, e.value FROM p, jsonb_each(${JSON.stringify(input.features)}::jsonb) e)
        SELECT id::integer AS id FROM p`,
  );
  return row ? Number(row.id) : null;
});

export interface CatalogPlanPatch {
  names?: Record<string, string> | undefined;
  descriptions?: Record<string, string> | undefined;
  rank?: number | undefined;
  sort?: number | undefined;
  active?: boolean | undefined;
  badge?: number | undefined;
  /** Merged into the plan's rows (each given feature is written). */
  features?: Record<string, number | boolean> | undefined;
}

const jsonOrNull = (value: unknown) => (value === undefined ? null : JSON.stringify(value));
const orNull = <T>(value: T | undefined): T | null => value ?? null;

/** Changes what `patch` gives (one statement); false when the plan is gone. A rank another plan holds fails at the end of the statement (plans_rank_key). */
export const catalogPlanUpdate = defineQuery({ name: 'catalog.planUpdate', statements: 1 }, async (tx, id: number, patch: CatalogPlanPatch): Promise<boolean> => {
  const rows = await many(
    tx,
    sql`WITH u AS (
          UPDATE plans
             SET names = coalesce(${jsonOrNull(patch.names)}::jsonb, names),
                 descriptions = coalesce(${jsonOrNull(patch.descriptions)}::jsonb, descriptions),
                 rank = coalesce(${orNull(patch.rank)}::smallint, rank),
                 sort = coalesce(${orNull(patch.sort)}::smallint, sort),
                 is_active = coalesce(${orNull(patch.active)}::boolean, is_active),
                 badge = coalesce(${orNull(patch.badge)}::smallint, badge),
                 updated_at = now()
           WHERE id = ${id}
           RETURNING id),
        f AS (
          INSERT INTO plan_features (plan_id, feature, value)
          SELECT u.id, e.key, e.value FROM u, jsonb_each(coalesce(${jsonOrNull(patch.features)}::jsonb, '{}'::jsonb)) e
          ON CONFLICT (plan_id, feature) DO UPDATE SET value = EXCLUDED.value)
        SELECT id FROM u`,
  );
  return rows.length === 1;
});

/**
 * Archives a plan (off sale for good: is_active false, archived_at now, and
 * every active product of it turned off) or brings it back (archived_at
 * cleared, still inactive). The free plan is never archived (CHECK
 * plans_archived). Answers the products it turned off.
 */
export const catalogPlanArchive = defineQuery(
  { name: 'catalog.planArchive', statements: 1 },
  async (tx, id: number, archive: boolean): Promise<{ found: boolean; deactivated: number[] }> => {
    const row = await one<{ found: boolean; deactivated: number[] }>(
      tx,
      sql`WITH p AS (
            UPDATE plans
               SET archived_at = CASE WHEN ${archive}::boolean THEN now() END, is_active = false, updated_at = now()
             WHERE id = ${id}
             RETURNING id),
          d AS (
            UPDATE store_products sp SET is_active = false, updated_at = now()
              FROM p
             WHERE ${archive}::boolean AND sp.plan_id = p.id AND sp.is_active
            RETURNING sp.id)
          SELECT EXISTS (SELECT 1 FROM p) AS found,
                 coalesce((SELECT array_agg(d.id::integer ORDER BY d.id) FROM d), '{}') AS deactivated`,
    );
    return { found: row.found, deactivated: row.deactivated.map(Number) };
  },
);

/** New ranks in one statement (plans_rank_key is checked at its end, so ranks can swap). Answers the ids that moved. */
export const catalogPlanRanks = defineQuery(
  { name: 'catalog.planRanks', statements: 1 },
  async (tx, ranks: readonly { id: number; rank: number }[]): Promise<number[]> => {
    const rows = await many<{ id: number }>(
      tx,
      sql`UPDATE plans p SET rank = v.rank, updated_at = now()
            FROM jsonb_to_recordset(${JSON.stringify(ranks)}::jsonb) AS v(id smallint, rank smallint)
           WHERE p.id = v.id AND p.rank <> v.rank
          RETURNING p.id::integer AS id`,
    );
    return rows.map((row) => Number(row.id)).sort((a, b) => a - b);
  },
);

export interface RankDependent {
  userId: string;
  /** 0: admin grants, else the store. */
  store: number;
}

/**
 * The (person, store) pairs whose subscriptions row a change of plan ranks
 * can move: more than one live counted purchase (store 1-3) or grant
 * (store 0) of different plans, which is when subscription_recompute() had a
 * choice to make by rank. Each person's advisory lock (the one
 * subscription_recompute() and store_purchase_apply() take) is taken here,
 * in person order and before the ranks change: the recompute after the
 * change then waits for no purchase of theirs, and no purchase of theirs is
 * left waiting on a plan row the change locks while holding that lock.
 *
 * Run in the rank change's transaction, after the plans are locked. A scan
 * of the live purchases and grants: rank changes are rare admin writes.
 */
export const catalogRankDependents = defineQuery({ name: 'catalog.rankDependents', statements: 1 }, async (tx): Promise<RankDependent[]> => {
  const rows = await many<{ user_id: string; store: number }>(
    tx,
    sql`WITH d AS MATERIALIZED (
          SELECT x.user_id, x.store FROM (
            SELECT p.user_id, p.store
              FROM store_purchases p
              JOIN store_products sp ON sp.id = p.product_ref
             WHERE p.user_id IS NOT NULL AND p.kind = 1 AND p.state IN (2, 3, 4) AND p.expires_at > now() AND sp.plan_id IS NOT NULL
             GROUP BY p.user_id, p.store
            HAVING count(DISTINCT sp.plan_id) > 1
            UNION ALL
            SELECT g.user_id, 0::smallint
              FROM entitlement_grants g
             WHERE g.revoked_at IS NULL AND g.starts_at <= now() AND g.ends_at > now()
             GROUP BY g.user_id
            HAVING count(DISTINCT g.plan_id) > 1) x
           ORDER BY x.user_id, x.store)
        SELECT d.user_id::text AS user_id, d.store::integer AS store, pg_advisory_xact_lock(1937008737, hashtext(d.user_id::text)) AS locked
          FROM d`,
  );
  return rows.map((row) => ({ userId: row.user_id, store: Number(row.store) }));
});

/** subscription_recompute() of each pair, after the ranks changed (one statement); answers the pairs whose row changed. */
export const catalogRecomputeSubscriptions = defineQuery(
  { name: 'catalog.recomputeSubscriptions', statements: 1 },
  async (tx, pairs: readonly RankDependent[]): Promise<RankDependent[]> => {
    const rows = await many<{ user_id: string; store: number }>(
      tx,
      sql`SELECT r."userId"::text AS user_id, r.store::integer AS store
            FROM jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS r("userId" bigint, store smallint)
           WHERE subscription_recompute(r."userId", r.store)`,
    );
    return rows.map((row) => ({ userId: row.user_id, store: Number(row.store) }));
  },
);

// ─── Store products ───────────────────────────────────────────────────────

export const catalogProductRowSchema = z.object({
  id: z.number().int().positive(),
  store: z.number().int(),
  kind: z.number().int(),
  planId: z.number().int().nullable(),
  planKey: z.string().nullable(),
  period: z.string().nullable(),
  item: z.number().int().nullable(),
  quantity: z.number().int().nullable(),
  productId: z.string(),
  basePlanId: z.string().nullable(),
  badge: z.number().int(),
  sort: z.number().int(),
  active: z.boolean(),
  listPriceMinor: z.number().int().nonnegative().nullable(),
  listCurrency: z.string().nullable(),
  /** A purchase names the row (store_purchases_product_idx). */
  hasPurchases: z.boolean(),
  updatedAtMs: epochMs,
});
export type CatalogProductRow = z.infer<typeof catalogProductRowSchema>;

/** `sp` is the store_products row in the surrounding statement. */
const productView = sql`jsonb_build_object(
    'id', sp.id, 'store', sp.store, 'kind', sp.kind, 'planId', sp.plan_id,
    'planKey', (SELECT p.key FROM plans p WHERE p.id = sp.plan_id),
    'period', sp.period, 'item', sp.grant_item, 'quantity', sp.grant_qty, 'productId', sp.product_id, 'basePlanId', sp.base_plan_id,
    'badge', sp.badge, 'sort', sp.sort, 'active', sp.is_active, 'listPriceMinor', sp.list_price_minor, 'listCurrency', sp.list_currency,
    'hasPurchases', EXISTS (SELECT 1 FROM store_purchases pu WHERE pu.product_ref = sp.id),
    'updatedAtMs', ${ms(sql`sp.updated_at`)})`;

/** Every product of a store (every store when null), by store, sort and id. */
export const catalogProducts = defineQuery({ name: 'catalog.products', statements: 1 }, async (db, store: number | null): Promise<CatalogProductRow[]> => {
  const rows = await many<{ product: unknown }>(
    db,
    sql`SELECT ${productView} AS product FROM store_products sp
         WHERE ${store}::smallint IS NULL OR sp.store = ${store}::smallint
         ORDER BY sp.store, sp.sort, sp.id`,
  );
  return rows.map((row) => catalogProductRowSchema.parse(row.product));
});

/** One product. */
export const catalogProduct = defineQuery({ name: 'catalog.product', statements: 1 }, async (db, id: number): Promise<CatalogProductRow | null> => {
  const row = await maybeOne<{ product: unknown }>(db, sql`SELECT ${productView} AS product FROM store_products sp WHERE sp.id = ${id}`);
  return row ? catalogProductRowSchema.parse(row.product) : null;
});

/** One product, its row locked FOR UPDATE until the transaction ends (see the locking reads above); null when there is none. */
export const catalogProductForUpdate = defineQuery({ name: 'catalog.productForUpdate', statements: 2 }, async (tx, id: number): Promise<CatalogProductRow | null> => {
  const locked = await maybeOne<{ id: number }>(tx, sql`SELECT sp.id FROM store_products sp WHERE sp.id = ${id} FOR UPDATE`);
  if (!locked) return null;
  const row = await maybeOne<{ product: unknown }>(tx, sql`SELECT ${productView} AS product FROM store_products sp WHERE sp.id = ${id}`);
  return row ? catalogProductRowSchema.parse(row.product) : null;
});

export interface CatalogProductSibling {
  id: number;
  kind: number;
  planId: number | null;
}

/** The rows of one product id in one store (Play: one per base plan). */
export const catalogProductSiblings = defineQuery(
  { name: 'catalog.productSiblings', statements: 1 },
  async (db, store: number, productId: string): Promise<CatalogProductSibling[]> => {
    const rows = await many<{ id: number; kind: number; plan_id: number | null }>(
      db,
      sql`SELECT id::integer AS id, kind::integer AS kind, plan_id::integer AS plan_id FROM store_products WHERE store = ${store}::smallint AND product_id = ${productId}`,
    );
    return rows.map((row) => ({ id: Number(row.id), kind: Number(row.kind), planId: row.plan_id === null ? null : Number(row.plan_id) }));
  },
);

export interface CatalogProductInsert {
  store: number;
  kind: number;
  planId: number | null;
  period: string | null;
  item: number | null;
  quantity: number | null;
  productId: string;
  basePlanId: string | null;
  badge: number;
  sort: number;
  active: boolean;
  listPriceMinor: number | null;
  listCurrency: string | null;
}

/** A new product row; null when (store, product id, base plan) exists. */
export const catalogProductCreate = defineQuery({ name: 'catalog.productCreate', statements: 1 }, async (tx, input: CatalogProductInsert): Promise<number | null> => {
  const row = await maybeOne<{ id: number }>(
    tx,
    sql`INSERT INTO store_products (list_price_minor, store, kind, plan_id, grant_item, grant_qty, sort, badge, is_active, list_currency, product_id, base_plan_id, period)
        VALUES (${input.listPriceMinor}::bigint, ${input.store}::smallint, ${input.kind}::smallint, ${input.planId}::smallint, ${input.item}::smallint,
                ${input.quantity}::smallint, ${input.sort}::smallint, ${input.badge}::smallint, ${input.active}::boolean, ${input.listCurrency}::char(3),
                ${input.productId}::text, ${input.basePlanId}::text, ${input.period}::text)
        ON CONFLICT ON CONSTRAINT store_products_key DO NOTHING
        RETURNING id::integer AS id`,
  );
  return row ? Number(row.id) : null;
});

export interface CatalogProductPatch {
  productId?: string | undefined;
  /** null clears it. */
  basePlanId?: string | null | undefined;
  planId?: number | undefined;
  period?: string | undefined;
  item?: number | undefined;
  quantity?: number | undefined;
  badge?: number | undefined;
  sort?: number | undefined;
  active?: boolean | undefined;
  /** null clears the list price. */
  listPrice?: { amountMinor: number; currency: string } | null | undefined;
}

/** Changes what `patch` gives (one statement); false when the row is gone. A key another row holds fails (store_products_key). */
export const catalogProductUpdate = defineQuery({ name: 'catalog.productUpdate', statements: 1 }, async (tx, id: number, patch: CatalogProductPatch): Promise<boolean> => {
  const setBasePlan = patch.basePlanId !== undefined;
  const setPrice = patch.listPrice !== undefined;
  const result = await query(
    tx,
    sql`UPDATE store_products
           SET product_id = coalesce(${orNull(patch.productId)}::text, product_id),
               base_plan_id = CASE WHEN ${setBasePlan}::boolean THEN ${orNull(patch.basePlanId)}::text ELSE base_plan_id END,
               plan_id = coalesce(${orNull(patch.planId)}::smallint, plan_id),
               period = coalesce(${orNull(patch.period)}::text, period),
               grant_item = coalesce(${orNull(patch.item)}::smallint, grant_item),
               grant_qty = coalesce(${orNull(patch.quantity)}::smallint, grant_qty),
               badge = coalesce(${orNull(patch.badge)}::smallint, badge),
               sort = coalesce(${orNull(patch.sort)}::smallint, sort),
               is_active = coalesce(${orNull(patch.active)}::boolean, is_active),
               list_price_minor = CASE WHEN ${setPrice}::boolean THEN ${patch.listPrice?.amountMinor ?? null}::bigint ELSE list_price_minor END,
               list_currency = CASE WHEN ${setPrice}::boolean THEN ${patch.listPrice?.currency ?? null}::char(3) ELSE list_currency END,
               updated_at = now()
         WHERE id = ${id}`,
  );
  return result.rowCount === 1;
});
