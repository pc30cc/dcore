import { z } from 'zod';
import { many, maybeOne, one, sql, type SqlFragment } from '../query.js';
import { defineQuery } from './define.js';
import { adminEpochMs, adminIdText, adminRefRow, adminRefSql, adminUserKept, msOf } from './adminShared.js';
import { adminUserRefRowSchema } from './adminUsers.js';

/**
 * The admin panel's reads of purchases, plan grants and admin wallet rows
 * (`/v1/admin/purchases*`, `/v1/admin/grants`, `/v1/admin/wallet-adjustments`).
 * People are raw ids here; the API turns them into public ids. Codes stay
 * codes, times are epoch ms (ids as text). Never a purchase token or one of
 * its hashes: the wire never carries them.
 *
 * Every list is keyset-paged from an index with `LIMIT n + 1`; nothing is
 * counted:
 * - a store's purchases newest first: `store_purchases_store_idx` (store, id),
 *   with a state `store_purchases_store_state_idx` (store, state, id);
 * - a purchase's events: `store_events_purchase_idx` (purchase_id, id);
 * - its admin history: `audit_log_target_idx` (target_type 5, target_id, id);
 * - grants: the primary key, `entitlement_grants_user_id_idx` (user_id, id),
 *   the active ones `entitlement_grants_open_idx` (ends_at, id);
 * - admin gifts and corrections: `wallet_ledger_admin_idx` (id) WHERE reason IN (4, 8).
 */

const id = adminIdText;
const epochMs = adminEpochMs;
const ms = msOf;

/** audit_log.target_type of a purchase. */
const PURCHASE_TARGET = 5;
/** The purchase page's admin history: its newest rows. */
export const PURCHASE_HISTORY_ROWS = 20;
/** A search by person: their newest purchases. */
export const PURCHASE_SEARCH_ROWS = 50;

// ─── Purchases ────────────────────────────────────────────────────────────

export const adminPurchaseRowSchema = z.object({
  id,
  store: z.number().int(),
  productRef: z.number().int(),
  productId: z.string(),
  basePlanId: z.string().nullable(),
  kind: z.number().int(),
  /** The plan key of a subscription product. */
  plan: z.string().nullable(),
  period: z.string().nullable(),
  /** A consumable's item and what one unit credits. */
  item: z.number().int().nullable(),
  grantQuantity: z.number().int().nullable(),
  quantity: z.number().int(),
  state: z.number().int(),
  /** Null: unclaimed (no account could be attributed). */
  user: adminUserRefRowSchema.nullable(),
  purchasedAtMs: epochMs,
  expiresAtMs: epochMs.nullable(),
  autoRenew: z.boolean().nullable(),
  orderId: z.string().nullable(),
  isTest: z.boolean(),
  region: z.string().nullable(),
});
export type AdminPurchaseRow = z.infer<typeof adminPurchaseRowSchema>;

/** The columns of one purchase row `p` (with its product `sp`, plan `pl`, person `u`) as JSON. */
const purchaseJson = sql`jsonb_build_object(
    'id', p.id::text, 'store', p.store, 'productRef', p.product_ref, 'productId', sp.product_id, 'basePlanId', sp.base_plan_id,
    'kind', p.kind, 'plan', pl.key, 'period', sp.period, 'item', sp.grant_item, 'grantQuantity', sp.grant_qty,
    'quantity', p.quantity, 'state', p.state, 'user', CASE WHEN u.id IS NULL THEN NULL ELSE admin_user_ref(u) END,
    'purchasedAtMs', ${ms(sql`p.purchased_at`)}, 'expiresAtMs', ${ms(sql`p.expires_at`)}, 'autoRenew', p.auto_renew,
    'orderId', p.order_id, 'isTest', p.is_test, 'region', p.region)`;

const purchaseJoins = sql`JOIN store_products sp ON sp.id = p.product_ref
          LEFT JOIN plans pl ON pl.id = sp.plan_id
          LEFT JOIN users u ON u.id = p.user_id`;

function purchaseRows(rows: { item: unknown }[]): AdminPurchaseRow[] {
  return rows.map((row) => adminPurchaseRowSchema.parse(row.item));
}

/** One store's purchases newest first, optionally in one state (`store_purchases_store_idx` / `_store_state_idx`). */
export const adminPurchaseList = defineQuery(
  { name: 'adminRevenue.purchases', statements: 1 },
  async (db, q: { store: number; state?: number | undefined; beforeId?: string | null | undefined; limit: number }): Promise<AdminPurchaseRow[]> => {
    const state = q.state === undefined ? sql`` : sql` AND p.state = ${q.state}::smallint`;
    const before = q.beforeId ? sql` AND p.id < ${q.beforeId}::bigint` : sql``;
    const rows = await many<{ item: unknown }>(
      db,
      sql`SELECT ${purchaseJson} AS item
            FROM store_purchases p
            ${purchaseJoins}
           WHERE p.store = ${q.store}::smallint${state}${before}
           ORDER BY p.id DESC
           LIMIT ${q.limit}`,
    );
    return purchaseRows(rows);
  },
);

export type PurchaseMatch = 'id' | 'person' | 'order' | 'token';

export interface PurchaseSearch {
  /** A purchase id (the text is a decimal id). */
  id: string | null;
  /** A person (the text is a public id that decodes). */
  userId: string | null;
  /** The text as an order id of either store. */
  orderId: string | null;
  /** SHA-256 of the text as a purchase token (texts of 20 characters or more). */
  tokenHash: Buffer | null;
}

/**
 * Purchases the text names, in one statement: by id (primary key), by
 * person (their newest 50, `store_purchases_user_idx`), by order id
 * (`store_purchases_order_idx`) and by token (the `(store, token_hash)`
 * key), unclaimed purchases included. Each row says what matched; the
 * caller keeps the first kind that has hits, in that order.
 */
export const adminPurchaseSearch = defineQuery(
  { name: 'adminRevenue.search', statements: 1 },
  async (db, s: PurchaseSearch): Promise<{ matched: PurchaseMatch; row: AdminPurchaseRow }[]> => {
    const branches: SqlFragment[] = [];
    const branch = (matched: PurchaseMatch, where: SqlFragment, limit: number) =>
      sql`(SELECT ${matched}::text AS matched, p.id, ${purchaseJson} AS item
             FROM store_purchases p
             ${purchaseJoins}
            WHERE ${where}
            ORDER BY p.id DESC
            LIMIT ${limit})`;
    if (s.id !== null) branches.push(branch('id', sql`p.id = ${s.id}::bigint`, 1));
    if (s.userId !== null) branches.push(branch('person', sql`p.user_id = ${s.userId}::bigint`, PURCHASE_SEARCH_ROWS));
    if (s.orderId !== null) branches.push(branch('order', sql`p.store IN (1, 2) AND p.order_id = ${s.orderId}`, PURCHASE_SEARCH_ROWS));
    if (s.tokenHash !== null) branches.push(branch('token', sql`p.store IN (1, 2) AND p.token_hash = ${s.tokenHash}::bytea`, 2));
    if (branches.length === 0) return [];
    let union = branches[0]!;
    for (const next of branches.slice(1)) union = sql`${union} UNION ALL ${next}`;
    const rows = await many<{ matched: PurchaseMatch; item: unknown }>(db, sql`SELECT x.matched, x.item FROM (${union}) x ORDER BY x.id DESC`);
    return rows.map((row) => ({ matched: row.matched, row: adminPurchaseRowSchema.parse(row.item) }));
  },
);

export const adminPurchaseEventRowSchema = z.object({
  id,
  atMs: epochMs,
  event: z.number().int(),
  source: z.number().int(),
  stateFrom: z.number().int().nullable(),
  stateTo: z.number().int(),
  expiresAtMs: epochMs.nullable(),
  /** Decimal micros (never a float). */
  amountMicros: z.string().regex(/^-?[0-9]{1,19}$/).nullable(),
  currency: z.string().nullable(),
  estimated: z.boolean(),
  orderId: z.string().nullable(),
});
export type AdminPurchaseEventRow = z.infer<typeof adminPurchaseEventRowSchema>;

const eventJson = sql`jsonb_build_object(
    'id', e.id::text, 'atMs', ${ms(sql`e.occurred_at`)}, 'event', e.event, 'source', e.source,
    'stateFrom', e.state_from, 'stateTo', e.state_to, 'expiresAtMs', ${ms(sql`e.expires_at`)},
    'amountMicros', e.amount_micros::text, 'currency', e.currency, 'estimated', e.amount_estimated, 'orderId', e.order_id)`;

export const adminPurchaseHistoryRowSchema = z.object({
  id,
  action: z.string(),
  admin: adminRefRow.nullable(),
  note: z.string().nullable(),
  error: z.string().nullable(),
  /** `purchase.action_failed`: the action that failed. */
  failed: z.string().nullable(),
});
export type AdminPurchaseHistoryRow = z.infer<typeof adminPurchaseHistoryRowSchema>;

export const adminPurchaseViewSchema = adminPurchaseRowSchema.extend({
  acknowledgedAtMs: epochMs.nullable(),
  consumedAtMs: epochMs.nullable(),
  creditedAtMs: epochMs.nullable(),
  nextCheckAtMs: epochMs.nullable(),
  updatedAtMs: epochMs,
  lastEventMs: z.number().int().nullable(),
  /** The person's subscriptions row of this store names this purchase now. */
  counts: z.boolean(),
  replaces: id.nullable(),
  replacedBy: id.nullable(),
  /** Consumables: what was credited (reason 1) and taken back (reason 3). */
  credited: z.number().int().nullable(),
  takenBack: z.number().int().nullable(),
  /** Newest first, `events` + 1 rows read (the caller pages them). */
  events: z.array(adminPurchaseEventRowSchema),
  history: z.array(adminPurchaseHistoryRowSchema),
});
export type AdminPurchaseView = z.infer<typeof adminPurchaseViewSchema>;

/**
 * Everything the purchase page shows, in one statement: the row with its
 * product, plan and person; whether the person's subscription names it;
 * the purchase it replaced (its linked token, by the `(store, token_hash)`
 * key) and the one that replaced it (`store_purchases_linked_idx`); the
 * consumable's credit and reversal (`wallet_ledger_once_idx`); the newest
 * events; the newest admin rows about it. Null for an unknown id.
 */
export const adminPurchaseView = defineQuery(
  { name: 'adminRevenue.purchase', statements: 1 },
  async (db, purchaseId: string, options: { events: number; history?: number | undefined }): Promise<AdminPurchaseView | null> => {
    const row = await maybeOne<{ item: unknown }>(
      db,
      sql`SELECT ${purchaseJson} || jsonb_build_object(
                 'acknowledgedAtMs', ${ms(sql`p.acknowledged_at`)}, 'consumedAtMs', ${ms(sql`p.consumed_at`)},
                 'creditedAtMs', ${ms(sql`p.credited_at`)}, 'nextCheckAtMs', ${ms(sql`p.next_check_at`)},
                 'updatedAtMs', ${ms(sql`p.updated_at`)}, 'lastEventMs', p.last_event_ms,
                 'counts', EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = p.user_id AND s.store = p.store AND s.purchase_id = p.id),
                 'replaces', (SELECT q.id::text FROM store_purchases q WHERE q.store = p.store AND q.token_hash = p.linked_token_hash),
                 'replacedBy', (SELECT q.id::text FROM store_purchases q
                                 WHERE q.store = p.store AND q.linked_token_hash = p.token_hash AND q.id <> p.id
                                 ORDER BY q.id DESC LIMIT 1),
                 'credited', (SELECT l.delta FROM wallet_ledger l WHERE l.reason = 1 AND l.ref_id = p.id),
                 'takenBack', (SELECT -l.delta FROM wallet_ledger l WHERE l.reason = 3 AND l.ref_id = p.id),
                 'events', coalesce((SELECT jsonb_agg(x.item ORDER BY x.id DESC)
                                       FROM (SELECT e.id, ${eventJson} AS item FROM store_events e
                                              WHERE e.purchase_id = p.id ORDER BY e.id DESC LIMIT ${options.events + 1}) x), '[]'::jsonb),
                 'history', coalesce((SELECT jsonb_agg(x.item ORDER BY x.id DESC)
                                        FROM (SELECT al.id, jsonb_build_object(
                                                       'id', al.id::text, 'action', al.action, 'admin', ${adminRefSql(sql`al.admin_id`)},
                                                       'note', al.detail->>'note', 'error', al.detail->>'error', 'failed', al.detail->>'action') AS item
                                                FROM audit_log al
                                               WHERE al.target_type = ${PURCHASE_TARGET}::smallint AND al.target_id = p.id
                                               ORDER BY al.id DESC LIMIT ${options.history ?? PURCHASE_HISTORY_ROWS}) x), '[]'::jsonb)) AS item
            FROM store_purchases p
            ${purchaseJoins}
           WHERE p.id = ${purchaseId}::bigint`,
    );
    return row ? adminPurchaseViewSchema.parse(row.item) : null;
  },
);

/** A page of a purchase's events, newest first; `found` false for an unknown purchase. */
export const adminPurchaseEvents = defineQuery(
  { name: 'adminRevenue.events', statements: 1 },
  async (db, purchaseId: string, q: { beforeId?: string | null | undefined; limit: number }): Promise<{ found: boolean; events: AdminPurchaseEventRow[] }> => {
    const before = q.beforeId ? sql` AND e.id < ${q.beforeId}::bigint` : sql``;
    const row = await one<{ found: boolean; events: unknown }>(
      db,
      sql`SELECT EXISTS (SELECT 1 FROM store_purchases p WHERE p.id = ${purchaseId}::bigint) AS found,
                 coalesce((SELECT jsonb_agg(x.item ORDER BY x.id DESC)
                             FROM (SELECT e.id, ${eventJson} AS item FROM store_events e
                                    WHERE e.purchase_id = ${purchaseId}::bigint${before}
                                    ORDER BY e.id DESC LIMIT ${q.limit}) x), '[]'::jsonb) AS events`,
    );
    return { found: row.found, events: z.array(adminPurchaseEventRowSchema).parse(row.events) };
  },
);

/** The row an admin action holds while its audit row is written: its state as it is now, locked (`FOR UPDATE`). */
export const adminLockPurchase = defineQuery(
  { name: 'adminRevenue.lockPurchase', statements: 1 },
  async (tx, purchaseId: string): Promise<{ state: number; autoRenew: boolean | null } | null> => {
    const row = await maybeOne<{ state: number; auto_renew: boolean | null }>(
      tx,
      sql`SELECT p.state::integer AS state, p.auto_renew FROM store_purchases p WHERE p.id = ${purchaseId}::bigint FOR UPDATE`,
    );
    return row ? { state: Number(row.state), autoRenew: row.auto_renew } : null;
  },
);

// ─── Grants ───────────────────────────────────────────────────────────────

export const adminGrantRowSchema = z.object({
  id,
  user: adminUserRefRowSchema,
  plan: z.string(),
  startsAtMs: epochMs,
  endsAtMs: epochMs,
  /** scheduled, active, ended, revoked (ended early), as of the statement's now(). */
  state: z.enum(['scheduled', 'active', 'ended', 'revoked']),
  reason: z.string(),
  grantedBy: adminRefRow.nullable(),
  revokedAtMs: epochMs.nullable(),
  revokedBy: adminRefRow.nullable(),
  revokeReason: z.string().nullable(),
});
export type AdminGrantRow = z.infer<typeof adminGrantRowSchema>;

const grantJson = sql`jsonb_build_object(
    'id', g.id::text, 'user', admin_user_ref(u), 'plan', pl.key,
    'startsAtMs', ${ms(sql`g.starts_at`)}, 'endsAtMs', ${ms(sql`g.ends_at`)},
    'state', CASE WHEN g.revoked_at IS NOT NULL THEN 'revoked' WHEN g.ends_at <= now() THEN 'ended'
                  WHEN g.starts_at > now() THEN 'scheduled' ELSE 'active' END,
    'reason', g.reason, 'grantedBy', ${adminRefSql(sql`g.granted_by`)},
    'revokedAtMs', ${ms(sql`g.revoked_at`)}, 'revokedBy', ${adminRefSql(sql`g.revoked_by`)}, 'revokeReason', g.revoke_reason)`;

/** The keyset of a grants page: `{ id }` for every grant, `{ e, id }` (end, id) for the active ones. */
export type GrantCursor = { id: string } | { e: number; id: string };

export interface GrantListQuery {
  state: 'all' | 'active';
  /** One person's grants; the answer's `found` is false when the account does not exist or is purged. */
  userId?: string | null | undefined;
  after?: GrantCursor | null | undefined;
  limit: number;
}

/**
 * Grants newest first (all), or the ones still running or to come
 * (active: not ended early, end after now) soonest end first; every
 * person's or one person's.
 */
export const adminGrantList = defineQuery(
  { name: 'adminRevenue.grants', statements: 1 },
  async (db, q: GrantListQuery): Promise<{ found: boolean; grants: AdminGrantRow[] }> => {
    const person = q.userId ? sql` AND g.user_id = ${q.userId}::bigint` : sql``;
    let where: SqlFragment;
    let order: SqlFragment;
    let again: SqlFragment;
    if (q.state === 'active') {
      const after = q.after && 'e' in q.after ? sql` AND (g.ends_at, g.id) > (to_timestamp(${q.after.e}::double precision / 1000), ${q.after.id}::bigint)` : sql``;
      where = sql`g.revoked_at IS NULL AND g.ends_at > now()${person}${after}`;
      order = sql`g.ends_at, g.id`;
      again = sql`x.ends_at, x.id`;
    } else {
      const after = q.after ? sql` AND g.id < ${q.after.id}::bigint` : sql``;
      where = sql`true${person}${after}`;
      order = sql`g.id DESC`;
      again = sql`x.id DESC`;
    }
    const found = q.userId ? adminUserKept(q.userId) : sql`true`;
    const row = await one<{ found: boolean; grants: unknown }>(
      db,
      sql`SELECT ${found} AS found,
                 coalesce((SELECT jsonb_agg(x.item ORDER BY ${again})
                             FROM (SELECT g.id, g.ends_at, ${grantJson} AS item
                                     FROM entitlement_grants g
                                     JOIN users u ON u.id = g.user_id
                                     JOIN plans pl ON pl.id = g.plan_id
                                    WHERE ${where}
                                    ORDER BY ${order}
                                    LIMIT ${q.limit}) x), '[]'::jsonb) AS grants`,
    );
    return { found: row.found, grants: z.array(adminGrantRowSchema).parse(row.grants) };
  },
);

/** One grant as the panel shows it (after a write). */
export const adminGrantById = defineQuery({ name: 'adminRevenue.grant', statements: 1 }, async (db, grantId: string): Promise<AdminGrantRow | null> => {
  const row = await maybeOne<{ item: unknown }>(
    db,
    sql`SELECT ${grantJson} AS item
          FROM entitlement_grants g JOIN users u ON u.id = g.user_id JOIN plans pl ON pl.id = g.plan_id
         WHERE g.id = ${grantId}::bigint`,
  );
  return row ? adminGrantRowSchema.parse(row.item) : null;
});

// ─── Wallet ───────────────────────────────────────────────────────────────

export const adminWalletAdjustmentRowSchema = z.object({
  id,
  atMs: epochMs,
  user: adminUserRefRowSchema,
  item: z.number().int(),
  store: z.number().int(),
  delta: z.number().int(),
  balanceAfter: z.number().int(),
  reason: z.number().int(),
  admin: adminRefRow.nullable(),
  note: z.string().nullable(),
});
export type AdminWalletAdjustmentRow = z.infer<typeof adminWalletAdjustmentRowSchema>;

/** Every admin gift (4) and correction (8), newest first (`wallet_ledger_admin_idx`). */
export const adminWalletAdjustments = defineQuery(
  { name: 'adminRevenue.walletAdjustments', statements: 1 },
  async (db, q: { beforeId?: string | null | undefined; limit: number }): Promise<AdminWalletAdjustmentRow[]> => {
    const before = q.beforeId ? sql` AND l.id < ${q.beforeId}::bigint` : sql``;
    const rows = await many<{ item: unknown }>(
      db,
      sql`SELECT jsonb_build_object(
                   'id', l.id::text, 'atMs', ${ms(sql`id_time(l.id)`)}, 'user', admin_user_ref(u), 'item', l.item, 'store', l.store,
                   'delta', l.delta, 'balanceAfter', l.balance_after, 'reason', l.reason,
                   'admin', ${adminRefSql(sql`l.admin_id`)}, 'note', l.note) AS item
            FROM wallet_ledger l
            JOIN users u ON u.id = l.user_id
           WHERE l.reason IN (4, 8)${before}
           ORDER BY l.id DESC
           LIMIT ${q.limit}`,
    );
    return rows.map((row) => adminWalletAdjustmentRowSchema.parse(row.item));
  },
);

// ─── People ───────────────────────────────────────────────────────────────

export const adminGiftTargetSchema = z.object({
  /** users.status (8: purged, a tombstone). */
  status: z.number().int(),
  user: adminUserRefRowSchema,
  /** The acting admin, as a grant or a ledger row names them. */
  admin: adminRefRow.nullable(),
});
export type AdminGiftTarget = z.infer<typeof adminGiftTargetSchema>;

/**
 * The person a grant or a wallet write is for (null: no such account) and
 * the acting admin, in one statement: the write's answer is built from them
 * without reading its row back.
 */
export const adminGiftTarget = defineQuery(
  { name: 'adminRevenue.giftTarget', statements: 1 },
  async (db, userId: string, adminId: number | null): Promise<AdminGiftTarget | null> => {
    const row = await maybeOne<{ item: unknown }>(
      db,
      sql`SELECT jsonb_build_object('status', u.status, 'user', admin_user_ref(u), 'admin', ${adminRefSql(sql`${adminId}::integer`)}) AS item
            FROM users u WHERE u.id = ${userId}::bigint`,
    );
    return row ? adminGiftTargetSchema.parse(row.item) : null;
  },
);
