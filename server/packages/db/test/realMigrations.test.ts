import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEDGER_TABLE, migrationStatus, runMigrations, type MigrationLog } from '../src/index.js';
import { createTempDatabase, hasDatabase, requireSetup, type TempDatabase } from './support.js';

/**
 * The real migration files on an empty database, as a deploy runs them:
 * `dry-run` applies every file and rolls everything back, then `up` applies
 * them all, and a second `up` applies nothing.
 */

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const FILES = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort();
const quiet: MigrationLog = { info: () => undefined, warn: () => undefined };

describe.skipIf(!hasDatabase)('the real migrations: dry-run, up, up again', () => {
  let db: TempDatabase;
  let client: pg.Client;
  let ready = false;

  beforeAll(async () => {
    db = await createTempDatabase();
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      // What a superuser does once per database before the first migration.
      await client.query('CREATE EXTENSION IF NOT EXISTS postgis');
      ready = true;
    } catch {
      ready = false;
    }
    requireSetup(ready, 'PostGIS cannot be created in a new database');
  }, 60_000);

  afterAll(async () => {
    await client?.end();
    await db?.drop();
  });

  const tables = async () =>
    (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`)).rows[0]!.n;

  it('runs in order: dry-run changes nothing, up applies every file, a second up applies none', async (ctx) => {
    if (!ready) ctx.skip();
    expect(FILES.slice(0, 10)).toEqual([
      '0001_init.sql',
      '0002_accounts.sql',
      '0003_config.sql',
      '0004_profiles.sql',
      '0005_social.sql',
      '0006_discovery.sql',
      '0007_billing.sql',
      '0008_moderation_admin.sql',
      '0009_partitions_grants.sql',
      '0010_account.sql',
    ]);
    const before = await tables();

    const dry = await runMigrations({ connectionString: db.url, directory: MIGRATIONS, log: quiet, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.applied.map((file) => file.name)).toEqual(FILES);
    expect(await tables()).toBe(before);
    expect((await client.query(`SELECT to_regclass('${LEDGER_TABLE}') AS ledger, to_regclass('public.users') AS users`)).rows[0]).toEqual({ ledger: null, users: null });
    expect((await migrationStatus({ connectionString: db.url, directory: MIGRATIONS })).pending).toEqual(FILES);

    const up = await runMigrations({ connectionString: db.url, directory: MIGRATIONS, log: quiet });
    expect(up.dryRun).toBe(false);
    expect(up.applied.map((file) => file.name)).toEqual(FILES);
    expect(up.alreadyApplied).toBe(0);
    expect(await tables()).toBeGreaterThan(before + 30);

    const again = await runMigrations({ connectionString: db.url, directory: MIGRATIONS, log: quiet });
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toBe(FILES.length);
    const status = await migrationStatus({ connectionString: db.url, directory: MIGRATIONS });
    expect(status).toMatchObject({ pending: [], changed: [], missing: [] });
    expect(status.applied).toHaveLength(FILES.length);
  });
});
