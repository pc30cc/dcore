import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, type MigrationLog } from '../src/index.js';
import { createTempDatabase, hasDatabase, requireSetup, type TempDatabase } from './support.js';

/**
 * Migration 0025 on a database that already holds data (0001-0024 applied,
 * an account with a profile): the dry run changes nothing, the real run
 * keeps every row and gives the profile the `default` choice, account_view()
 * carries it, and running the file again changes nothing (an edited panel
 * value stays). Then what it promises: the CHECK on new writes, the seeded
 * setting and the analytics grant.
 */

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const FILE = '0025_ui_templates.sql';
const quiet: MigrationLog = { info: () => undefined, warn: () => undefined };

describe.skipIf(!hasDatabase)('migration 0025: visual templates', () => {
  let db: TempDatabase;
  let client: pg.Client;
  let before = '';
  let user = '';
  let ready = false;
  const dir = mkdtempSync(join(tmpdir(), 'mig-0025-'));

  async function value<T>(text: string, values: unknown[] = []): Promise<T> {
    const { rows } = await client.query(text, values);
    if (rows[0] === undefined) throw new Error(`no row: ${text}`);
    return Object.values(rows[0] as Record<string, T>)[0] as T;
  }

  /** The rows 0025 must keep, as text (the view without the new key). */
  async function data(): Promise<string> {
    const parts: unknown[] = [];
    for (const text of [
      `SELECT user_id, version, display_name, incognito, hide_age, hide_distance, show_online, accept_calls, mode_match, updated_at FROM profiles ORDER BY user_id`,
      `SELECT key, value FROM app_config WHERE key <> 'ui.templates' ORDER BY key`,
      `SELECT account_view(id) #- '{profile,uiTemplate}' AS view FROM users ORDER BY id`,
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
    user = await value<string>(`INSERT INTO users (id, birth_date, status, gender, onboarding_step, country) VALUES (id_next(), '1994-01-01', 3, 2, 30, 'IR') RETURNING id::text`);
    await client.query(`INSERT INTO profiles (user_id, display_name, hide_age) VALUES ($1, 'Sam', true)`, [user]);
    before = await data();
  }, 90_000);

  afterAll(async () => {
    await client?.end();
    await db?.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  const column = () => value<boolean>(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'ui_template')`);

  it('dry-runs without a change, applies without losing a row, and runs again without effect', async (ctx) => {
    if (!ready) ctx.skip();
    copyFileSync(join(MIGRATIONS, FILE), join(dir, FILE));
    const dry = await runMigrations({ connectionString: db.url, directory: dir, log: quiet, dryRun: true });
    expect(dry.applied.map((f) => f.name)).toEqual([FILE]);
    expect(await column()).toBe(false);
    expect(await value<number>(`SELECT count(*)::int FROM app_config WHERE key = 'ui.templates'`)).toBe(0);
    expect(await data()).toBe(before);

    const up = await runMigrations({ connectionString: db.url, directory: dir, log: quiet });
    expect(up.applied.map((f) => f.name)).toEqual([FILE]);
    expect(await column()).toBe(true);
    expect(await data()).toBe(before);
    expect(await value<number>(`SELECT ui_template FROM profiles WHERE user_id = $1`, [user])).toBe(0);
    expect(await value<unknown>(`SELECT account_view($1::bigint) -> 'profile' -> 'uiTemplate'`, [user])).toBe(0);
    expect(await value<unknown>(`SELECT value FROM app_config WHERE key = 'ui.templates'`)).toEqual({ default: 'neon', offered: ['neon', 'white'] });

    // The panel changes the setting and a person picks a template; the same file again keeps both.
    await client.query(`UPDATE public.app_config SET value = '{"default": "white", "offered": ["white"]}' WHERE key = 'ui.templates'`);
    await client.query(`UPDATE profiles SET ui_template = 2 WHERE user_id = $1`, [user]);
    const sql = readFileSync(join(MIGRATIONS, FILE), 'utf8');
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    expect(await value<unknown>(`SELECT value FROM app_config WHERE key = 'ui.templates'`)).toEqual({ default: 'white', offered: ['white'] });
    expect(await value<unknown>(`SELECT account_view($1::bigint) -> 'profile' -> 'uiTemplate'`, [user])).toBe(2);
    expect(await value<number>(`SELECT count(*)::int FROM pg_constraint WHERE conname = 'profiles_ui_template'`)).toBe(1);
  });

  it('refuses a code outside the table on every write, and lets the analytics role read the column', async (ctx) => {
    if (!ready) ctx.skip();
    await expect(client.query(`UPDATE profiles SET ui_template = 3 WHERE user_id = $1`, [user])).rejects.toThrow(/profiles_ui_template/);
    await expect(client.query(`UPDATE profiles SET ui_template = -1 WHERE user_id = $1`, [user])).rejects.toThrow(/profiles_ui_template/);
    await client.query(`UPDATE profiles SET ui_template = 1 WHERE user_id = $1`, [user]);
    // A template change is not a change of the card: the version stays.
    const version = await value<number>(`SELECT version FROM profiles WHERE user_id = $1`, [user]);
    await client.query(`UPDATE profiles SET ui_template = 0 WHERE user_id = $1`, [user]);
    expect(await value<number>(`SELECT version FROM profiles WHERE user_id = $1`, [user])).toBe(version);
    const roles = await value<boolean>(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ro')`);
    if (roles) expect(await value<boolean>(`SELECT has_column_privilege('app_ro', 'profiles', 'ui_template', 'SELECT')`)).toBe(true);
  });
});
