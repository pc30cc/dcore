import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, type MigrationLog } from '../src/index.js';
import { createTempDatabase, hasDatabase, requireSetup, type TempDatabase } from './support.js';

/**
 * Migration 0034 on a database at 0033: audit_log.target_type takes the
 * kinds up to 63 (19 profile field, 20 prompt, 21 support reply and 22
 * support tag included; the shared code table holds the names against the
 * column's COMMENT), on the parent and on every partition, under the CHECK's
 * old name; rows already written stay; a partition made afterwards copies
 * the new CHECK.
 */

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const FILE = '0034_admin_audit_targets.sql';
const CHECK = 'audit_log_target_type_check';
const quiet: MigrationLog = { info: () => undefined, warn: () => undefined };

describe.skipIf(!hasDatabase)('migration 0034: audit target kinds', () => {
  let db: TempDatabase;
  let client: pg.Client;
  let ready = false;
  const dir = mkdtempSync(join(tmpdir(), 'mig-0034-'));

  /** Writes one audit row of `type`; the SQLSTATE of a refusal, or undefined. */
  async function write(type: number): Promise<string | undefined> {
    try {
      await client.query(`INSERT INTO audit_log (id, target_type, action) VALUES (id_next(), $1, 'audit.export')`, [type]);
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    }
  }

  /** The CHECK on the parent and each partition: table → definition. */
  async function checks(): Promise<Record<string, string>> {
    const { rows } = await client.query<{ rel: string; def: string }>(
      `SELECT c.conrelid::regclass::text AS rel, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
        WHERE c.conname = $1 AND c.convalidated
          AND (c.conrelid = 'audit_log'::regclass OR c.conrelid IN (SELECT inhrelid FROM pg_inherits WHERE inhparent = 'audit_log'::regclass))`,
      [CHECK],
    );
    return Object.fromEntries(rows.map((row) => [row.rel, row.def]));
  }

  const partitions = async () =>
    (await client.query<{ rel: string }>(`SELECT inhrelid::regclass::text AS rel FROM pg_inherits WHERE inhparent = 'audit_log'::regclass ORDER BY 1`)).rows.map((row) => row.rel);

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
  }, 90_000);

  afterAll(async () => {
    await client?.end();
    await db?.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('widens the kinds on the parent and every partition, keeping the rows and the name', async (ctx) => {
    if (!ready) ctx.skip();
    // 0008's CHECK: 0 to 20.
    expect(await write(18)).toBeUndefined();
    expect(await write(21)).toBe('23514');
    const before = (await client.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log')).rows[0]!.n;

    copyFileSync(join(MIGRATIONS, FILE), join(dir, FILE));
    const result = await runMigrations({ connectionString: db.url, directory: dir, log: quiet });
    expect(result.applied.map((file) => file.name)).toEqual([FILE]);

    const tables = await partitions();
    expect(tables.length).toBeGreaterThan(0);
    const defs = await checks();
    expect(Object.keys(defs).sort()).toEqual(['audit_log', ...tables].sort());
    for (const def of Object.values(defs)) expect(def).toBe('CHECK (((target_type >= 0) AND (target_type <= 63)))');

    expect((await client.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log')).rows[0]!.n).toBe(before);
    for (const type of [19, 20, 21, 22, 63]) expect(await write(type), String(type)).toBeUndefined();
    expect(await write(64)).toBe('23514');
    expect(await write(-1)).toBe('23514');
  });

  it('gives a partition made afterwards the same CHECK', async (ctx) => {
    if (!ready) ctx.skip();
    const made = (await client.query<{ name: string }>(`SELECT partition_create('audit_log', now() + interval '9 months') AS name`)).rows[0]!.name;
    const defs = await checks();
    expect(defs[`part.${made}`]).toBe('CHECK (((target_type >= 0) AND (target_type <= 63)))');
  });
});
