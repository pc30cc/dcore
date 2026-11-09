import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, type MigrationLog } from '../src/index.js';
import { createTempDatabase, hasDatabase, requireSetup, type TempDatabase } from './support.js';

/**
 * Migration 0024 on a database that already holds data (0001-0023 applied,
 * a subscription, a product, an edited plan): the dry run changes nothing,
 * the real run keeps every row as it was and adds what the panel edits,
 * and running the file again changes nothing more. Then what it promises:
 * ids for new plans, ranks that swap in one statement, no deleted plan, no
 * archived free plan, the product index and the admin role's grant.
 */

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const FILE = '0024_plan_catalog.sql';
const quiet: MigrationLog = { info: () => undefined, warn: () => undefined };

describe.skipIf(!hasDatabase)('migration 0024: plans and products edited in the panel', () => {
  let db: TempDatabase;
  let client: pg.Client;
  let before = '';
  let ready = false;
  const dir = mkdtempSync(join(tmpdir(), 'mig-0024-'));

  async function value<T>(text: string, values: unknown[] = []): Promise<T> {
    const { rows } = await client.query(text, values);
    if (rows[0] === undefined) throw new Error(`no row: ${text}`);
    return Object.values(rows[0] as Record<string, T>)[0] as T;
  }

  /** The rows 0024 must keep, as text. */
  async function data(): Promise<string> {
    const parts: unknown[] = [];
    for (const text of [
      `SELECT id, rank, sort, is_active, key, names FROM plans ORDER BY id`,
      `SELECT plan_id, feature, value FROM plan_features ORDER BY plan_id, feature`,
      `SELECT id, store, kind, plan_id, period, grant_item, grant_qty, product_id, base_plan_id, badge, sort, is_active, list_price_minor, list_currency FROM store_products ORDER BY id`,
      `SELECT user_id, plan_id, store, status, expires_at FROM subscriptions ORDER BY user_id, store`,
      `SELECT role_id, permission FROM admin_role_permissions WHERE permission <> 'billing.catalog' ORDER BY role_id, permission`,
    ]) {
      parts.push((await client.query(text)).rows);
    }
    return JSON.stringify(parts);
  }

  beforeAll(async () => {
    db = await createTempDatabase();
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS postgis');
      ready = true;
    } catch {
      ready = false;
    }
    requireSetup(ready, 'PostGIS cannot be created in a new database');
    if (!ready) return;
    for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n < FILE)) copyFileSync(join(MIGRATIONS, name), join(dir, name));
    await runMigrations({ connectionString: db.url, directory: dir, log: quiet });
    // Data from before: a person on a granted plan, an edited plan, a priced product.
    const user = await value<string>(`INSERT INTO users (id, birth_date, status, gender, onboarding_step, country) VALUES (id_next(), '1994-01-01', 3, 2, 30, 'IR') RETURNING id::text`);
    await client.query(
      `INSERT INTO entitlement_grants (id, user_id, starts_at, ends_at, plan_id, reason) VALUES (id_next(), $1, now() - interval '1 day', now() + interval '9 days', 2, 'support')`,
      [user],
    );
    await client.query(`SELECT subscription_recompute($1::bigint, 0::smallint)`, [user]);
    await client.query(`UPDATE plan_features SET value = '150' WHERE plan_id = 2 AND feature = 'daily_likes'`);
    await client.query(`UPDATE store_products SET is_active = true, list_price_minor = 499, list_currency = 'USD' WHERE store = 1 AND product_id = 'sub.plus' AND base_plan_id = 'm1'`);
    before = await data();
  }, 90_000);

  afterAll(async () => {
    await client?.end();
    await db?.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  const column = (name: string) => value<boolean>(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'plans' AND column_name = $1)`, [name]);

  it('dry-runs without a change, applies without losing a row, and runs again without effect', async (ctx) => {
    if (!ready) ctx.skip();
    copyFileSync(join(MIGRATIONS, FILE), join(dir, FILE));
    const dry = await runMigrations({ connectionString: db.url, directory: dir, log: quiet, dryRun: true });
    expect(dry.applied.map((f) => f.name)).toEqual([FILE]);
    expect(await column('archived_at')).toBe(false);
    expect(await data()).toBe(before);

    const up = await runMigrations({ connectionString: db.url, directory: dir, log: quiet });
    expect(up.applied.map((f) => f.name)).toEqual([FILE]);
    expect(await data()).toBe(before);
    for (const name of ['archived_at', 'badge', 'descriptions']) expect(await column(name), name).toBe(true);
    expect(await value<unknown>(`SELECT jsonb_agg(jsonb_build_object('a', archived_at, 'b', badge, 'd', descriptions) ORDER BY id) FROM plans`)).toEqual(
      [0, 1, 2].map(() => ({ a: null, b: 0, d: {} })),
    );

    // The same file again (every statement guarded): nothing changes, nothing fails.
    const sql = readFileSync(join(MIGRATIONS, FILE), 'utf8');
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    expect(await data()).toBe(before);
    expect(await value<number>(`SELECT count(*)::int FROM admin_role_permissions WHERE permission = 'billing.catalog'`)).toBe(1);
  });

  it('gives new plans the next id, swaps ranks in one statement, and keeps every plan', async (ctx) => {
    if (!ready) ctx.skip();
    expect(await value<number>(`INSERT INTO plans (rank, key) VALUES (3, 'gold') RETURNING id`)).toBe(4);
    await client.query(`UPDATE plans SET rank = CASE key WHEN 'plus' THEN 2 WHEN 'premium' THEN 1 ELSE rank END WHERE key IN ('plus', 'premium')`);
    expect(await value<string>(`SELECT string_agg(key, ',' ORDER BY rank) FROM plans`)).toBe('free,premium,plus,gold');
    await expect(client.query(`UPDATE plans SET rank = 2 WHERE key = 'gold'`)).rejects.toThrow(/plans_rank_key/);
    await expect(client.query(`DELETE FROM plans WHERE key = 'gold'`)).rejects.toThrow(/never deleted/);
    await expect(client.query(`UPDATE plans SET archived_at = now(), is_active = false WHERE key = 'free'`)).rejects.toThrow(/plans_archived/);
    await expect(client.query(`UPDATE plans SET archived_at = now() WHERE key = 'gold'`)).rejects.toThrow(/plans_archived/);
    await client.query(`UPDATE plans SET archived_at = now(), is_active = false WHERE key = 'gold'`);
    await expect(client.query(`UPDATE plans SET badge = 4 WHERE key = 'gold'`)).rejects.toThrow(/plans_badge/);
    await expect(client.query(`UPDATE plans SET descriptions = '[]' WHERE key = 'gold'`)).rejects.toThrow(/plans_descriptions/);
  });

  it('indexes purchases by product and gives the admin role the catalogue permission', async (ctx) => {
    if (!ready) ctx.skip();
    expect(await value<string | null>(`SELECT to_regclass('public.store_purchases_product_idx')::text`)).toBe('store_purchases_product_idx');
    expect(await value<string[]>(`SELECT array_agg(r.key ORDER BY r.key) FROM admin_role_permissions p JOIN admin_roles r ON r.id = p.role_id WHERE p.permission = 'billing.catalog'`)).toEqual(['admin']);
  });
});
