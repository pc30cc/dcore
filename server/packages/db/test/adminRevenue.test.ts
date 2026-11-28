import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminGiftTarget,
  adminGrantList,
  adminPurchaseEvents,
  adminPurchaseList,
  adminPurchaseSearch,
  adminPurchaseView,
  adminWalletAdjustments,
  creditWallet,
  createPool,
  debitWallet,
  grantPlan,
  grantTimesDue,
  instrumentPool,
  revokePlanGrant,
  runMigrations,
  withTransaction,
  type Pool,
  type Queryable,
} from '../src/index.js';
import { createTempDatabase, hasDatabase, type TempDatabase } from './support.js';

/**
 * Migration 0036 and the revenue area's queries: every list is served by the
 * index it names (a few thousand rows, sequential scans off), a wallet
 * correction never takes a balance below zero, a grant ended early keeps
 * who and why, admin notes stay with their rows, and the file runs again
 * as a no-op.
 */

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const FILE = '0036_admin_revenue.sql';
const DAY = 86_400_000;

describe.skipIf(!hasDatabase)('admin revenue (migration 0036)', () => {
  let db: TempDatabase;
  let client: pg.Client;
  let pool: Pool;
  let admin: number;
  let plus: number;
  let subProduct: number;

  beforeAll(async () => {
    db = await createTempDatabase();
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await runMigrations({ connectionString: db.url, directory: MIGRATIONS, log: { info: () => undefined, warn: () => undefined } });
    pool = instrumentPool(createPool({ connectionString: db.url, applicationName: 'db-test', max: 4 }));
    admin = await value<number>(`INSERT INTO admin_users (email, display_name, password_hash) VALUES ('fin@example.com', 'Finance One', '$argon2id$x') RETURNING id`);
    plus = await value<number>(`SELECT id FROM plans WHERE key = 'plus'`);
    subProduct = await value<number>(`SELECT id FROM store_products WHERE store = 1 AND product_id = 'sub.plus' AND base_plan_id = 'm1'`);
    // A few thousand purchases, grants and ledger rows; the rows each list asks for are the rare ones, as in a large table.
    await client.query(`INSERT INTO users (id, birth_date, status, gender, onboarding_step, country)
                        SELECT id_next(), '1994-01-01', 3, 2, 30, 'IR' FROM generate_series(1, 300)`);
    await client.query(
      `INSERT INTO store_purchases (id, user_id, purchased_at, expires_at, product_ref, store, kind, state, token_hash, token, order_id)
       SELECT id_next(), u.id, now() - interval '1 day', now() + interval '20 days', $1,
              CASE WHEN g % 50 = 0 THEN 1 ELSE 2 END, 1, CASE WHEN g % 50 = 1 THEN 3 ELSE 2 END,
              sha256(convert_to('seed-' || g, 'UTF8')), 'seed-token-' || g, 'GPA.seed-' || g
         FROM generate_series(1, 3000) g
         JOIN LATERAL (SELECT id FROM users ORDER BY id OFFSET (g % 300) LIMIT 1) u ON true`,
      [subProduct],
    );
    await client.query(
      `INSERT INTO entitlement_grants (id, user_id, starts_at, ends_at, plan_id, reason, revoked_at)
       SELECT id_next(), u.id, now() - interval '10 days', now() + make_interval(days => g % 40 - 5), $1, 'seed', CASE WHEN g % 7 = 0 THEN now() END
         FROM generate_series(1, 2000) g
         JOIN LATERAL (SELECT id FROM users ORDER BY id OFFSET (g % 300) LIMIT 1) u ON true`,
      [plus],
    );
    await client.query(
      `INSERT INTO wallet_ledger (id, user_id, delta, balance_after, item, store, reason)
       SELECT id_next(), u.id, 1, 1, 1, 0, CASE WHEN g % 50 = 0 THEN 4 ELSE 2 END
         FROM generate_series(1, 3000) g
         JOIN LATERAL (SELECT id FROM users ORDER BY id OFFSET (g % 300) LIMIT 1) u ON true`,
    );
    await client.query('ANALYZE store_purchases, entitlement_grants, wallet_ledger, store_events');
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await client?.end();
    await db?.drop();
  });

  async function value<T>(text: string, values: unknown[] = []): Promise<T> {
    const { rows } = await client.query(text, values);
    if (rows[0] === undefined) throw new Error(`no row: ${text}`);
    return Object.values(rows[0] as Record<string, T>)[0] as T;
  }

  async function newUser(): Promise<string> {
    return value<string>(`INSERT INTO users (id, birth_date, status, gender, onboarding_step, country) VALUES (id_next(), '1994-01-01', 3, 2, 30, 'IR') RETURNING id::text`);
  }

  async function id(): Promise<string> {
    return value<string>('SELECT id_next()::text');
  }

  /** Runs a query and returns its plan (sequential scans off: the index the query can use is what it names). */
  async function planOf(run: (db: Queryable) => Promise<unknown>): Promise<string> {
    const plans: string[] = [];
    const explaining: Queryable = {
      async query(config) {
        await client.query('SET enable_seqscan = off');
        try {
          const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${config.text}`, config.values);
          plans.push(rows.map((r) => r['QUERY PLAN']).join('\n'));
          return await client.query(config);
        } finally {
          await client.query('SET enable_seqscan = on');
        }
      },
    };
    await run(explaining);
    return plans.join('\n---\n');
  }

  it('serves every list from its index', async () => {
    const anyPurchase = await value<string>('SELECT id::text FROM store_purchases ORDER BY id DESC LIMIT 1');
    const someone = await value<string>('SELECT user_id::text FROM entitlement_grants LIMIT 1');
    expect(await planOf((d) => adminPurchaseList(d, { store: 1, limit: 21 }))).toContain('store_purchases_store_idx');
    expect(await planOf((d) => adminPurchaseList(d, { store: 2, state: 3, beforeId: anyPurchase, limit: 21 }))).toContain('store_purchases_store_state_idx');
    expect(await planOf((d) => adminGrantList(d, { state: 'active', limit: 21 }))).toContain('entitlement_grants_open_idx');
    expect(await planOf((d) => adminGrantList(d, { state: 'all', userId: someone, limit: 21 }))).toContain('entitlement_grants_user_id_idx');
    expect(await planOf((d) => adminGrantList(d, { state: 'all', limit: 21 }))).toContain('entitlement_grants_pkey');
    expect(await planOf((d) => adminWalletAdjustments(d, { limit: 21 }))).toContain('wallet_ledger_admin_idx');
    // The worker's hourly sweep of grant starts and ends.
    const sweep = await planOf((d) => grantTimesDue(d, { fromMs: Date.now() - 7_200_000, beforeMs: Date.now(), limit: 5_000 }));
    expect(sweep).toContain('entitlement_grants_open_start_idx');
    expect(sweep).toContain('entitlement_grants_open_idx');
    const view = await planOf((d) => adminPurchaseView(d, anyPurchase, { events: 50 }));
    expect(view).toContain('store_purchases_linked_idx');
    expect(view).toContain('store_events_purchase_idx');
    // audit_log_target_idx, as each monthly partition names its copy.
    expect(view).toMatch(/audit_log_p\d{8}_target_type_target_id_id_idx/);
    expect(await planOf((d) => adminPurchaseEvents(d, anyPurchase, { limit: 51 }))).toContain('store_events_purchase_idx');
    const search = await planOf((d) => adminPurchaseSearch(d, { id: anyPurchase, userId: someone, orderId: 'GPA.seed-7', tokenHash: Buffer.alloc(32, 1) }));
    expect(search).toContain('store_purchases_pkey');
    expect(search).toContain('store_purchases_user_idx');
    expect(search).toContain('store_purchases_order_idx');
    expect(search).toContain('store_purchases_token_key');
    // The bare (user_id) index of 0007 is gone; subscription_recompute reads through the new one.
    expect(await value<number>(`SELECT count(*)::int FROM pg_indexes WHERE indexname = 'entitlement_grants_user_idx'`)).toBe(0);
  });

  it('finds the purchase by what the text is, unclaimed included', async () => {
    const hits = await adminPurchaseSearch(pool, { id: null, userId: null, orderId: 'GPA.seed-8', tokenHash: null });
    expect(hits.map((h) => h.matched)).toEqual(['order']);
    expect(hits[0]!.row).toMatchObject({ orderId: 'GPA.seed-8', productId: 'sub.plus', plan: 'plus', kind: 1 });
    const token = await adminPurchaseSearch(pool, { id: null, userId: null, orderId: null, tokenHash: Buffer.from(await value<string>(`SELECT encode(sha256(convert_to('seed-9', 'UTF8')), 'hex')`), 'hex') });
    expect(token.map((h) => [h.matched, h.row.orderId])).toEqual([['token', 'GPA.seed-9']]);
    expect(await adminPurchaseSearch(pool, { id: null, userId: null, orderId: null, tokenHash: null })).toEqual([]);
  });

  it('corrects a balance down only as far as it holds, with one ledger row and the note', async () => {
    const user = await newUser();
    await creditWallet(pool, { userId: user, item: 2, store: 1, quantity: 3, reason: 8, ledgerId: await id(), refId: null, adminId: admin, note: 'Up by three' });
    const left = await debitWallet(pool, { userId: user, item: 2, store: 1, quantity: 2, reason: 8, ledgerId: await id(), adminId: admin, note: 'Down by two' });
    expect(left).toBe(1);
    const before = await value<number>('SELECT count(*)::int FROM wallet_ledger WHERE user_id = $1', [user]);
    expect(await debitWallet(pool, { userId: user, item: 2, store: 1, quantity: 2, reason: 8, ledgerId: await id(), adminId: admin, note: 'Too much' })).toBeNull();
    expect(await debitWallet(pool, { userId: user, item: 3, store: 1, quantity: 1, reason: 8, ledgerId: await id(), adminId: admin, note: 'No balance at all' })).toBeNull();
    expect(await value<number>('SELECT count(*)::int FROM wallet_ledger WHERE user_id = $1', [user])).toBe(before);
    expect(await value<number>('SELECT balance FROM wallet_balances WHERE user_id = $1 AND item = 2 AND store = 1', [user])).toBe(1);
    const rows = await adminWalletAdjustments(pool, { limit: 2 });
    expect(rows.map((r) => [r.delta, r.note, r.reason, r.admin?.displayName])).toEqual([
      [-2, 'Down by two', 8, 'Finance One'],
      [3, 'Up by three', 8, 'Finance One'],
    ]);
    await expect(client.query(`INSERT INTO wallet_ledger (id, user_id, delta, balance_after, item, store, reason, note) VALUES (id_next(), $1, 1, 1, 1, 0, 4, '')`, [user])).rejects.toMatchObject({ code: '23514' });
  });

  it('ends a grant early with who and why, once; an ended one and an unknown one say so', async () => {
    const user = await newUser();
    const grantId = await id();
    await withTransaction(pool, (tx) => grantPlan(tx, { id: grantId, userId: user, planId: plus, startsAtMs: Date.now() - 1_000, endsAtMs: Date.now() + 7 * DAY, reason: 'support', adminId: admin }));
    const ended = await withTransaction(pool, (tx) => revokePlanGrant(tx, grantId, { adminId: admin, reason: 'Given by mistake' }));
    expect(ended).toMatchObject({ outcome: 'revoked', userId: user, changed: true, planId: plus });
    const row = await client.query<{ revoked_by: number; revoke_reason: string }>('SELECT revoked_by, revoke_reason FROM entitlement_grants WHERE id = $1', [grantId]);
    expect(row.rows[0]).toEqual({ revoked_by: admin, revoke_reason: 'Given by mistake' });
    expect(await withTransaction(pool, (tx) => revokePlanGrant(tx, grantId, { adminId: admin, reason: 'again' }))).toEqual({ outcome: 'ended' });
    expect(await withTransaction(pool, (tx) => revokePlanGrant(tx, '999999999', { adminId: admin, reason: 'x' }))).toEqual({ outcome: 'not_found' });
    const listed = await adminGrantList(pool, { state: 'all', userId: user, limit: 5 });
    expect(listed.found).toBe(true);
    expect(listed.grants[0]).toMatchObject({ id: grantId, state: 'revoked', revokedBy: { displayName: 'Finance One' }, revokeReason: 'Given by mistake', grantedBy: { displayName: 'Finance One' } });
    expect((await adminGrantList(pool, { state: 'all', userId: '999999999', limit: 5 })).found).toBe(false);
    expect(await adminGiftTarget(pool, user, admin)).toMatchObject({ status: 3, user: { id: user }, admin: { id: String(admin), displayName: 'Finance One' } });
    expect(await adminGiftTarget(pool, '999999999', admin)).toBeNull();
  });

  it('runs again as a no-op, and keeps the new columns from the analytics role', async () => {
    await client.query(readFileSync(new URL(`../migrations/${FILE}`, import.meta.url), 'utf8'));
    const roles = await value<boolean>(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ro')`);
    if (!roles) return;
    for (const [table, column] of [['entitlement_grants', 'revoke_reason'], ['entitlement_grants', 'revoked_by'], ['wallet_ledger', 'note']] as const) {
      expect(await value<boolean>(`SELECT has_column_privilege('app_ro', $1, $2, 'SELECT')`, [table, column]), `${table}.${column}`).toBe(false);
    }
  });
});
