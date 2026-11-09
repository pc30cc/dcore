import { z } from 'zod';
import { execute, many, maybeOne, one, sql } from '../query.js';
import { defineQuery } from './define.js';

/**
 * Store purchases, subscriptions, grants and the wallet. Every write is one
 * statement (a function of migration 0022, or one data-modifying CTE), so a
 * purchase, a renewal or a refund is one transaction; the entitlement rows
 * of a person are one read (`entitlement_rows()`), which is what a cache miss
 * of `ent:<uid>:<st>` costs.
 */

const id = z.string().regex(/^[1-9][0-9]{0,18}$/);
const ms = z.number().int();

export const subscriptionRowSchema = z.object({
  /** 0 = admin grants, else the store of the purchase. */
  store: z.number().int().min(0).max(3),
  planId: z.number().int(),
  /** subscriptions.status: 1 renewing, 2 until expiry, 3 grace, 4 granted. */
  status: z.number().int().min(1).max(4),
  autoRenew: z.boolean(),
  startedAtMs: ms,
  expiresAtMs: ms,
  productId: z.string().nullable(),
  basePlanId: z.string().nullable(),
});
export type SubscriptionRow = z.infer<typeof subscriptionRowSchema>;

export const walletRowSchema = z.object({
  item: z.number().int().min(1).max(4),
  store: z.number().int().min(0).max(3),
  balance: z.number().int().nonnegative(),
});
export type WalletRow = z.infer<typeof walletRowSchema>;

export const entitlementRowsSchema = z.object({ subs: z.array(subscriptionRowSchema), wallet: z.array(walletRowSchema) });
export type EntitlementRows = z.infer<typeof entitlementRowsSchema>;

/** `entitlement_rows()`: the live subscription rows (every store) and positive balances (every store). */
export const entitlementRows = defineQuery({ name: 'billing.entitlementRows', statements: 1 }, async (db, userId: string): Promise<EntitlementRows> => {
  const row = await one<{ rows: unknown }>(db, sql`SELECT entitlement_rows(${userId}::bigint) AS rows`);
  return entitlementRowsSchema.parse(row.rows);
});

/** What `store_purchase_apply()` takes (ids as decimal strings, times in epoch ms). */
export interface PurchaseApply {
  id: string;
  eventId: string;
  linkedEventId: string;
  ledgerId: string;
  store: number;
  /** SHA-256 of the token, hex. */
  tokenHash: string;
  token: string;
  linkedTokenHash: string | null;
  /** The signed-in person who sent the token; null in jobs. */
  callerId: string | null;
  /** The account the store's reference decodes to; null when the store gave none. */
  accountUserId: string | null;
  productRef: number;
  /** 1 subscription, 2 consumable. */
  kind: 1 | 2;
  /** store_purchases.state. */
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
  /** store_events.source. */
  source: number;
  /** What the store reported; null: the list price is copied as an estimate. */
  amountMicros: string | null;
  currency: string | null;
}

export const purchaseAppliedSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.enum(['applied', 'unchanged']),
    purchaseId: id,
    userId: id.nullable(),
    state: z.number().int(),
    stateFrom: z.number().int().nullable(),
    created: z.boolean(),
    event: z.number().int().nullable(),
    productRef: z.number().int(),
    kind: z.number().int(),
    expiresAtMs: ms.nullable(),
    acknowledged: z.boolean(),
    consumed: z.boolean(),
    credited: z.number().int(),
    debited: z.number().int(),
    shortfall: z.number().int(),
    subscriptionChanged: z.boolean(),
    replaced: id.nullable(),
    /** The owner of the replaced linked token when it is someone else (their subscription was recomputed too). */
    replacedUserId: id.nullable(),
    replacedRows: entitlementRowsSchema.nullable(),
    rows: entitlementRowsSchema.nullable(),
  }),
  z.object({
    outcome: z.literal('stale'),
    purchaseId: id,
    userId: id.nullable(),
    state: z.number().int(),
    productRef: z.number().int(),
    kind: z.number().int(),
    expiresAtMs: ms.nullable(),
    rows: entitlementRowsSchema.nullable(),
  }),
  z.object({ outcome: z.literal('foreign_account') }),
]);
export type PurchaseApplied = z.infer<typeof purchaseAppliedSchema>;

/** `store_purchase_apply()`: one statement, so one transaction. */
export const applyStorePurchase = defineQuery({ name: 'billing.applyPurchase', statements: 1 }, async (db, p: PurchaseApply): Promise<PurchaseApplied> => {
  const row = await one<{ out: unknown }>(db, sql`SELECT store_purchase_apply(${JSON.stringify(p)}::jsonb) AS out`);
  return purchaseAppliedSchema.parse(row.out);
});

export interface KnownPurchase {
  id: string;
  userId: string | null;
  store: number;
  kind: number;
  state: number;
  productRef: number;
  productId: string;
  basePlanId: string | null;
  token: string;
  tokenHash: string;
  quantity: number;
  purchasedAtMs: number;
  expiresAtMs: number | null;
  acknowledged: boolean;
  consumed: boolean;
  credited: boolean;
  orderId: string | null;
  lastEventMs: number | null;
  nextCheckAtMs: number | null;
}

const knownSchema = z.object({
  id,
  user_id: id.nullable(),
  store: z.number().int(),
  kind: z.number().int(),
  state: z.number().int(),
  product_ref: z.number().int(),
  product_id: z.string(),
  base_plan_id: z.string().nullable(),
  token: z.string(),
  token_hash: z.string(),
  quantity: z.number().int(),
  purchased_ms: z.string(),
  expires_ms: z.string().nullable(),
  acknowledged: z.boolean(),
  consumed: z.boolean(),
  credited: z.boolean(),
  order_id: z.string().nullable(),
  last_event_ms: z.string().nullable(),
  next_check_ms: z.string().nullable(),
});

function known(row: unknown): KnownPurchase {
  const r = knownSchema.parse(row);
  return {
    id: r.id,
    userId: r.user_id,
    store: r.store,
    kind: r.kind,
    state: r.state,
    productRef: r.product_ref,
    productId: r.product_id,
    basePlanId: r.base_plan_id,
    token: r.token,
    tokenHash: r.token_hash,
    quantity: r.quantity,
    purchasedAtMs: Number(r.purchased_ms),
    expiresAtMs: r.expires_ms === null ? null : Number(r.expires_ms),
    acknowledged: r.acknowledged,
    consumed: r.consumed,
    credited: r.credited,
    orderId: r.order_id,
    lastEventMs: r.last_event_ms === null ? null : Number(r.last_event_ms),
    nextCheckAtMs: r.next_check_ms === null ? null : Number(r.next_check_ms),
  };
}

const KNOWN_COLUMNS = sql`p.id::text AS id, p.user_id::text AS user_id, p.store::integer AS store, p.kind::integer AS kind,
       p.state::integer AS state, p.product_ref::integer AS product_ref, sp.product_id, sp.base_plan_id, p.token,
       encode(p.token_hash, 'hex') AS token_hash, p.quantity::integer AS quantity,
       (extract(epoch FROM p.purchased_at) * 1000)::bigint::text AS purchased_ms,
       (extract(epoch FROM p.expires_at) * 1000)::bigint::text AS expires_ms,
       p.acknowledged_at IS NOT NULL AS acknowledged, p.consumed_at IS NOT NULL AS consumed, p.credited_at IS NOT NULL AS credited,
       p.order_id, p.last_event_ms::text AS last_event_ms, (extract(epoch FROM p.next_check_at) * 1000)::bigint::text AS next_check_ms`;

/** A purchase by its token (restore of a token whose record left the cache; jobs). */
export const purchaseByToken = defineQuery(
  { name: 'billing.purchaseByToken', statements: 1 },
  async (db, store: number, tokenHash: string): Promise<KnownPurchase | null> => {
    const row = await maybeOne(
      db,
      sql`SELECT ${KNOWN_COLUMNS}
            FROM store_purchases p JOIN store_products sp ON sp.id = p.product_ref
           WHERE p.store = ${store}::smallint AND p.token_hash = decode(${tokenHash}, 'hex')`,
    );
    return row ? known(row) : null;
  },
);

/** A purchase by its id (the worker's jobs). */
export const purchaseById = defineQuery({ name: 'billing.purchaseById', statements: 1 }, async (db, purchaseId: string): Promise<KnownPurchase | null> => {
  const row = await maybeOne(
    db,
    sql`SELECT ${KNOWN_COLUMNS}
          FROM store_purchases p JOIN store_products sp ON sp.id = p.product_ref
         WHERE p.id = ${purchaseId}::bigint`,
  );
  return row ? known(row) : null;
});

/** A purchase by the store's order id (a voided-purchases entry, the panel). */
export const purchaseByOrder = defineQuery(
  { name: 'billing.purchaseByOrder', statements: 1 },
  async (db, store: number, orderId: string): Promise<KnownPurchase | null> => {
    const row = await maybeOne(
      db,
      sql`SELECT ${KNOWN_COLUMNS}
            FROM store_purchases p JOIN store_products sp ON sp.id = p.product_ref
           WHERE p.store = ${store}::smallint AND p.order_id = ${orderId}
           ORDER BY p.id DESC LIMIT 1`,
    );
    return row ? known(row) : null;
  },
);

export interface StoreAction {
  purchaseId: string;
  /** What the server did at the store: acknowledged or consumed the purchase. */
  action: 'acknowledged' | 'consumed';
  eventId: string;
  /** store_events.source of the job that did it. */
  source: number;
}

/**
 * Records that the purchase was acknowledged or consumed at the store: the
 * time on the row and its event, once (a second call changes nothing). A
 * consumed consumable moves to state 10. True when it wrote.
 */
export const recordStoreAction = defineQuery({ name: 'billing.recordStoreAction', statements: 1 }, async (db, a: StoreAction): Promise<boolean> => {
  const consumed = a.action === 'consumed';
  const n = await execute(
    db,
    sql`WITH moved AS (
          UPDATE store_purchases p
             SET acknowledged_at = coalesce(p.acknowledged_at, now()),
                 consumed_at = CASE WHEN ${consumed}::boolean THEN coalesce(p.consumed_at, now()) ELSE p.consumed_at END,
                 state = CASE WHEN ${consumed}::boolean AND p.kind = 2 AND p.state = 12 THEN 10 ELSE p.state END,
                 updated_at = now()
           WHERE p.id = ${a.purchaseId}::bigint
             AND (CASE WHEN ${consumed}::boolean THEN p.consumed_at IS NULL ELSE p.acknowledged_at IS NULL END)
          RETURNING p.id, p.user_id, p.store, p.state, p.expires_at, p.order_id,
                    (SELECT q.state FROM store_purchases q WHERE q.id = p.id) AS state_from
        )
        INSERT INTO store_events (id, purchase_id, user_id, occurred_at, expires_at, store, event, source, state_from, state_to, order_id)
        SELECT ${a.eventId}::bigint, m.id, m.user_id, now(), m.expires_at, m.store,
               CASE WHEN ${consumed}::boolean THEN 13 ELSE 12 END, ${a.source}::smallint, m.state_from, m.state, m.order_id
          FROM moved m`,
  );
  return n === 1;
});

/**
 * Recomputes one store's subscriptions row of a person (`subscription_recompute()`):
 * at a subscription's expiry, after a grant changes. True when it changed.
 */
export const recomputeSubscription = defineQuery(
  { name: 'billing.recomputeSubscription', statements: 1 },
  async (db, userId: string, store: number): Promise<boolean> => {
    const row = await one<{ changed: boolean }>(db, sql`SELECT subscription_recompute(${userId}::bigint, ${store}::smallint) AS changed`);
    return row.changed;
  },
);

export interface WalletUse {
  userId: string;
  /** wallet item code: 1 super like, 2 boost, 3 spotlight, 4 direct message. */
  item: number;
  /** The session's store: its balance is spent first, then store 0. */
  store: number;
  crossStore: boolean;
  ledgerId: string;
  /** What the use was for (a boost id). */
  refId: string;
}

/**
 * One item from the wallet (`balance >= 1`): the session store's balance
 * first, then gifts (store 0), every store's with cross-store entitlements;
 * the debit and its ledger row in one statement. Null when there was none.
 */
export const useWalletItem = defineQuery(
  { name: 'billing.useWalletItem', statements: 1 },
  async (db, w: WalletUse): Promise<{ store: number; balance: number } | null> => {
    const row = await maybeOne<{ store: number; balance: number }>(
      db,
      sql`WITH pick AS (
            SELECT s.store FROM wallet_balances s
             WHERE s.user_id = ${w.userId}::bigint AND s.item = ${w.item}::smallint AND s.balance >= 1
               AND (${w.crossStore}::boolean OR s.store = 0 OR s.store = ${w.store}::smallint)
             ORDER BY (s.store = ${w.store}::smallint) DESC, s.store DESC
             LIMIT 1
             FOR UPDATE
          ), debit AS (
            UPDATE wallet_balances b SET balance = b.balance - 1, updated_at = now()
              FROM pick
             WHERE b.user_id = ${w.userId}::bigint AND b.item = ${w.item}::smallint AND b.store = pick.store AND b.balance >= 1
            RETURNING b.store, b.balance
          ), led AS (
            INSERT INTO wallet_ledger (id, user_id, ref_id, delta, balance_after, item, store, reason)
            SELECT ${w.ledgerId}::bigint, ${w.userId}::bigint, ${w.refId}::bigint, -1, d.balance, ${w.item}::smallint, d.store, 2
              FROM debit d
            RETURNING store, balance_after
          )
          SELECT store::integer AS store, balance_after AS balance FROM led`,
    );
    return row ? { store: Number(row.store), balance: Number(row.balance) } : null;
  },
);

export interface WalletCredit {
  userId: string;
  item: number;
  /** The balance credited: 0 for gifts, rewards and allowances; a use given back goes to the store it came from. */
  store: number;
  quantity: number;
  /** wallet_ledger.reason: 4 admin gift, 5 referral reward, 6 plan allowance, 8 admin correction, 9 restored. */
  reason: 4 | 5 | 6 | 8 | 9;
  ledgerId: string;
  refId: string | null;
  adminId: number | null;
}

/** Credits the wallet (not a purchase: those go through `applyStorePurchase`), with its ledger row, in one statement. */
export const creditWallet = defineQuery({ name: 'billing.creditWallet', statements: 1 }, async (db, c: WalletCredit): Promise<number> => {
  if (!Number.isInteger(c.quantity) || c.quantity < 1 || c.quantity > 10_000) throw new RangeError('quantity must be 1-10000');
  const row = await one<{ balance: number }>(
    db,
    sql`WITH up AS (
          INSERT INTO wallet_balances AS b (user_id, item, store, balance)
          VALUES (${c.userId}::bigint, ${c.item}::smallint, ${c.store}::smallint, ${c.quantity}::integer)
          ON CONFLICT (user_id, item, store) DO UPDATE SET balance = b.balance + EXCLUDED.balance, updated_at = now()
          RETURNING b.balance
        ), led AS (
          INSERT INTO wallet_ledger (id, user_id, ref_id, delta, balance_after, admin_id, item, store, reason)
          SELECT ${c.ledgerId}::bigint, ${c.userId}::bigint, ${c.refId}::bigint, ${c.quantity}::integer, up.balance,
                 ${c.adminId}::integer, ${c.item}::smallint, ${c.store}::smallint, ${c.reason}::smallint
            FROM up
          RETURNING balance_after
        )
        SELECT balance_after AS balance FROM led`,
  );
  return Number(row.balance);
});

export interface PlanGrant {
  id: string;
  userId: string;
  planId: number;
  startsAtMs: number;
  endsAtMs: number;
  reason: string;
  adminId: number | null;
}

/**
 * Days of a plan given in the panel: the grant row, then the store-0
 * subscription recomputed (two statements; run it in a transaction).
 * True when the person's grant subscription changed.
 */
export const grantPlan = defineQuery({ name: 'billing.grantPlan', statements: 2 }, async (tx, g: PlanGrant): Promise<boolean> => {
  await execute(
    tx,
    sql`INSERT INTO entitlement_grants (id, user_id, starts_at, ends_at, granted_by, plan_id, reason)
        VALUES (${g.id}::bigint, ${g.userId}::bigint, to_timestamp(${g.startsAtMs}::double precision / 1000),
                to_timestamp(${g.endsAtMs}::double precision / 1000), ${g.adminId}::integer, ${g.planId}::smallint, ${g.reason})`,
  );
  const row = await one<{ changed: boolean }>(tx, sql`SELECT subscription_recompute(${g.userId}::bigint, 0::smallint) AS changed`);
  return row.changed;
});

/** Revokes a grant and recomputes the store-0 subscription (two statements; in a transaction). */
export const revokePlanGrant = defineQuery(
  { name: 'billing.revokePlanGrant', statements: 2 },
  async (tx, grantId: string): Promise<{ userId: string; changed: boolean } | null> => {
    const rows = await many<{ user_id: string }>(
      tx,
      sql`UPDATE entitlement_grants SET revoked_at = now() WHERE id = ${grantId}::bigint AND revoked_at IS NULL RETURNING user_id::text`,
    );
    const first = rows[0];
    if (!first) return null;
    const row = await one<{ changed: boolean }>(tx, sql`SELECT subscription_recompute(${first.user_id}::bigint, 0::smallint) AS changed`);
    return { userId: first.user_id, changed: row.changed };
  },
);

// ─── The worker's hourly sweep ──────────────────────────────────────────────

export interface DuePurchase {
  id: string;
  store: number;
  kind: number;
  /** next_check_at (overdue re-checks), expires_at (live rows without a check) or purchased_at (owed actions). */
  atMs: number;
}

const dueSchema = z.object({ id, store: z.number().int(), kind: z.number().int(), at_ms: z.string() });

function due(rows: unknown[]): DuePurchase[] {
  return rows.map((row) => {
    const r = dueSchema.parse(row);
    return { id: r.id, store: r.store, kind: r.kind, atMs: Number(r.at_ms) };
  });
}

const toTime = (ms: number) => sql`to_timestamp(${ms}::double precision / 1000)`;

export interface DuePage {
  /** Rows due before this time (epoch ms). */
  beforeMs: number;
  /** The last row of the previous page (keyset), or null for the first. */
  after: { atMs: number; id: string } | null;
  limit: number;
}

/** Re-checks that should have run before `beforeMs` (`store_purchases_check_idx`), oldest first. */
export const overduePurchaseChecks = defineQuery({ name: 'billing.overdueChecks', statements: 1 }, async (db, q: DuePage): Promise<DuePurchase[]> => {
  const after = q.after ? sql`AND (p.next_check_at, p.id) > (${toTime(q.after.atMs)}, ${q.after.id}::bigint)` : sql``;
  const rows = await many(
    db,
    sql`SELECT p.id::text AS id, p.store::integer AS store, p.kind::integer AS kind,
               (extract(epoch FROM p.next_check_at) * 1000)::bigint::text AS at_ms
          FROM store_purchases p
         WHERE p.next_check_at IS NOT NULL AND p.next_check_at < ${toTime(q.beforeMs)} ${after}
         ORDER BY p.next_check_at, p.id
         LIMIT ${q.limit}`,
  );
  return due(rows);
});

/**
 * Subscriptions in a granting state, without a next check, whose expiry
 * passed before `beforeMs` (at most 30 days before it; `store_purchases_unchecked_idx`).
 */
export const uncheckedExpiredPurchases = defineQuery({ name: 'billing.uncheckedExpired', statements: 1 }, async (db, beforeMs: number, limit: number): Promise<DuePurchase[]> => {
  const rows = await many(
    db,
    sql`SELECT p.id::text AS id, p.store::integer AS store, p.kind::integer AS kind,
               (extract(epoch FROM p.expires_at) * 1000)::bigint::text AS at_ms
          FROM store_purchases p
         WHERE p.kind = 1 AND p.state IN (2, 3, 4) AND p.next_check_at IS NULL
           AND p.expires_at < ${toTime(beforeMs)} AND p.expires_at > ${toTime(beforeMs - 30 * 86_400_000)}
         ORDER BY p.expires_at, p.id
         LIMIT ${limit}`,
  );
  return due(rows);
});

/**
 * Owned purchases whose acknowledgement (Play subscriptions) or consume
 * (credited consumables) the server may still owe, bought in
 * [`fromMs`, `beforeMs`) (`store_purchases_owed_idx`), oldest first.
 */
export const owedPurchaseActions = defineQuery(
  { name: 'billing.owedActions', statements: 1 },
  async (db, q: DuePage & { fromMs: number }): Promise<DuePurchase[]> => {
    const after = q.after ? sql`AND (p.purchased_at, p.id) > (${toTime(q.after.atMs)}, ${q.after.id}::bigint)` : sql``;
    const rows = await many(
      db,
      sql`SELECT p.id::text AS id, p.store::integer AS store, p.kind::integer AS kind,
                 (extract(epoch FROM p.purchased_at) * 1000)::bigint::text AS at_ms
            FROM store_purchases p
           WHERE ((p.kind = 1 AND p.store = 1 AND p.acknowledged_at IS NULL) OR (p.kind = 2 AND p.consumed_at IS NULL))
             AND p.purchased_at >= ${toTime(q.fromMs)} AND p.purchased_at < ${toTime(q.beforeMs)}
             AND p.user_id IS NOT NULL AND ((p.kind = 1 AND p.state IN (2, 3, 4)) OR (p.kind = 2 AND p.state = 12)) ${after}
           ORDER BY p.purchased_at, p.id
           LIMIT ${q.limit}`,
    );
    return due(rows);
  },
);

/**
 * A re-check the store refused: the row is asked again at `toMs` instead
 * of every hour (a row whose expiry is more than 30 days past is no longer
 * asked). Only a check that is due (or a live subscription without one)
 * moves; true when it wrote.
 */
export const deferPurchaseCheck = defineQuery({ name: 'billing.deferCheck', statements: 1 }, async (db, purchaseId: string, toMs: number): Promise<boolean> => {
  const n = await execute(
    db,
    sql`UPDATE store_purchases p
           SET next_check_at = CASE WHEN p.expires_at IS NOT NULL AND p.expires_at < now() - interval '30 days' THEN NULL ELSE ${toTime(toMs)} END,
               updated_at = now()
         WHERE p.id = ${purchaseId}::bigint AND (p.next_check_at IS NULL OR p.next_check_at <= now())
           AND (p.next_check_at IS NOT NULL OR (p.kind = 1 AND p.state IN (2, 3, 4)))`,
  );
  return n === 1;
});

/** The r5 cell a person is found in (their discovery row), for a boost; null when they are not discoverable. */
export const discoveryCell = defineQuery({ name: 'billing.discoveryCell', statements: 1 }, async (db, userId: string): Promise<string | null> => {
  const row = await maybeOne<{ cell: string }>(db, sql`SELECT h3_r5::text AS cell FROM discovery WHERE user_id = ${userId}::bigint`);
  return row?.cell ?? null;
});
