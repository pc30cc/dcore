import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LEDGER_TABLE,
  MigrationError,
  MigrationIntegrityError,
  migrationStatus,
  readMigrationFiles,
  runMigrations,
  sha256Hex,
  type MigrationLog,
} from '../src/index.js';
import { createTempDatabase, hasDatabase, type TempDatabase } from './support.js';

const quiet: MigrationLog = { info: () => undefined, warn: () => undefined };

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
}

function write(dir: string, name: string, text: string): void {
  writeFileSync(path.join(dir, name), text);
}

describe('readMigrationFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('orders files by code point and ignores other files', async () => {
    write(dir, '010_c.sql', 'SELECT 3;');
    write(dir, '002_b.sql', 'SELECT 2;');
    write(dir, '002a_b2.sql', 'SELECT 22;');
    write(dir, '001_a.sql', 'SELECT 1;');
    write(dir, 'README.md', '# not a migration');
    write(dir, '.hidden.sql', 'SELECT 0;');
    const files = await readMigrationFiles(dir);
    expect(files.map((file) => file.name)).toEqual(['001_a.sql', '002_b.sql', '002a_b2.sql', '010_c.sql']);
    expect(files[0]?.sha256).toBe(sha256Hex(new TextEncoder().encode('SELECT 1;')));
  });

  it('refuses empty files, odd names and transaction control', async () => {
    write(dir, '001 a.sql', 'SELECT 1;');
    await expect(readMigrationFiles(dir)).rejects.toThrow(/may only use/);
    rmSync(path.join(dir, '001 a.sql'));

    write(dir, '001_empty.sql', '  \n\n');
    await expect(readMigrationFiles(dir)).rejects.toThrow(/empty/);
    rmSync(path.join(dir, '001_empty.sql'));

    write(dir, '001_tx.sql', 'CREATE TABLE a (id int);\nCOMMIT;\n');
    await expect(readMigrationFiles(dir)).rejects.toThrow(/001_tx\.sql: line 2: "COMMIT"/);
    rmSync(path.join(dir, '001_tx.sql'));

    // Function bodies, strings and comments may say BEGIN, COMMIT and END.
    write(
      dir,
      '001_ok.sql',
      [
        "CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END; $$;",
        'CREATE FUNCTION g() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END;',
        "SELECT 'COMMIT;' AS s; -- ROLLBACK;",
        'SELECT CASE WHEN true THEN 1 END;',
      ].join('\n'),
    );
    await expect(readMigrationFiles(dir)).resolves.toHaveLength(1);
  });
});

describe.skipIf(!hasDatabase)('runMigrations (PostgreSQL)', () => {
  let db: TempDatabase;
  let dir: string;

  beforeEach(async () => {
    db = await createTempDatabase();
    dir = tempDir();
  });

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db.drop();
  });

  async function select<R extends pg.QueryResultRow>(text: string): Promise<R[]> {
    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      return (await client.query<R>(text)).rows;
    } finally {
      await client.end();
    }
  }

  const run = (extra: { dryRun?: boolean; lockWaitMs?: number } = {}) =>
    runMigrations({ connectionString: db.url, directory: dir, log: quiet, ...extra });

  it('applies files in lexical order, records them, and is a no-op the second time', async () => {
    // 10 sorts after 2 only with zero padding; the runner does not parse numbers.
    write(dir, '001_create.sql', 'CREATE TABLE steps (n int PRIMARY KEY, at timestamptz DEFAULT clock_timestamp());');
    write(dir, '002_insert.sql', 'INSERT INTO steps (n) VALUES (2);\nINSERT INTO steps (n) VALUES (3);');
    write(dir, '010_depends_on_002.sql', 'INSERT INTO steps (n) SELECT max(n) + 1 FROM steps;');

    const first = await run();
    expect(first.applied.map((file) => file.name)).toEqual(['001_create.sql', '002_insert.sql', '010_depends_on_002.sql']);
    expect(first.alreadyApplied).toBe(0);
    expect(await select('SELECT n FROM steps ORDER BY at, n')).toEqual([{ n: 2 }, { n: 3 }, { n: 4 }]);

    const ledger = await select<{ file_name: string; sha256: string }>(
      `SELECT file_name, sha256 FROM ${LEDGER_TABLE} ORDER BY file_name`,
    );
    expect(ledger).toHaveLength(3);
    expect(ledger[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);

    const second = await run();
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toBe(3);
  });

  it('keeps earlier files when one fails, and leaves nothing of the failed one', async () => {
    write(dir, '001_ok.sql', 'CREATE TABLE a (id int);');
    write(dir, '002_bad.sql', 'CREATE TABLE b (id int);\nINSERT INTO b VALUES (1);\nSELECT * FROM no_such_table;');
    write(dir, '003_never.sql', 'CREATE TABLE c (id int);');

    const error = await run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).file).toBe('002_bad.sql');
    expect((error as MigrationError).message).toMatch(/002_bad\.sql \(line 3\): relation "no_such_table" does not exist/);

    const tables = await select<{ name: string }>(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    expect(tables.map((t) => t.name)).toEqual(['_schema_migrations', 'a']);
    expect(await select(`SELECT file_name FROM ${LEDGER_TABLE}`)).toEqual([{ file_name: '001_ok.sql' }]);
  });

  it('refuses to run when an applied file changed, and applies nothing', async () => {
    write(dir, '001_a.sql', 'CREATE TABLE a (id int);');
    await run();
    write(dir, '001_a.sql', 'CREATE TABLE a (id bigint);');
    write(dir, '002_b.sql', 'CREATE TABLE b (id int);');

    const error = await run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationIntegrityError);
    expect((error as MigrationIntegrityError).changed).toEqual(['001_a.sql']);
    expect(await select("SELECT to_regclass('public.b') AS b")).toEqual([{ b: null }]);

    const status = await migrationStatus({ connectionString: db.url, directory: dir });
    expect(status).toMatchObject({ changed: ['001_a.sql'], missing: [], pending: ['002_b.sql'] });
  });

  it('refuses to run when an applied file is missing', async () => {
    write(dir, '001_a.sql', 'CREATE TABLE a (id int);');
    write(dir, '002_b.sql', 'CREATE TABLE b (id int);');
    await run();
    unlinkSync(path.join(dir, '002_b.sql'));
    await expect(run()).rejects.toMatchObject({ missing: ['002_b.sql'] });
  });

  it('lets two runners race without applying anything twice', async () => {
    write(dir, '001_slow.sql', 'SELECT pg_sleep(0.4);\nCREATE TABLE once (id int);');
    write(dir, '002_next.sql', 'INSERT INTO once VALUES (1);');

    const [a, b] = await Promise.all([run(), run()]);
    expect(a.applied.length + b.applied.length).toBe(2);
    expect([a.applied.length, b.applied.length].sort()).toEqual([0, 2]);
    expect(await select('SELECT count(*)::int AS n FROM once')).toEqual([{ n: 1 }]);
    expect(await select(`SELECT count(*)::int AS n FROM ${LEDGER_TABLE}`)).toEqual([{ n: 2 }]);
  });

  it('gives up waiting for the lock after lockWaitMs', async () => {
    write(dir, '001_a.sql', 'SELECT 1;');
    const holder = new pg.Client({ connectionString: db.url });
    await holder.connect();
    const { MIGRATION_LOCK_KEY } = await import('../src/index.js');
    await holder.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
    try {
      await expect(run({ lockWaitMs: 300 })).rejects.toThrow(/held the lock/);
    } finally {
      await holder.end();
    }
    await expect(run()).resolves.toMatchObject({ applied: [{ name: '001_a.sql' }] });
  });

  it('dry-runs the pending files and rolls everything back', async () => {
    write(dir, '001_a.sql', 'CREATE TABLE a (id int);');
    const report = await run({ dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.applied.map((file) => file.name)).toEqual(['001_a.sql']);
    expect(await select(`SELECT to_regclass('public.a') AS a, to_regclass('${LEDGER_TABLE}') AS ledger`)).toEqual([
      { a: null, ledger: null },
    ]);
  });

  it('explains statements that cannot run in a transaction', async () => {
    write(dir, '001_t.sql', 'CREATE TABLE t (id int);');
    write(dir, '002_idx.sql', 'CREATE INDEX CONCURRENTLY t_id_idx ON t (id);');
    await expect(run()).rejects.toThrow(/002_idx\.sql.*run it by hand before the migration/s);
    expect(await select(`SELECT file_name FROM ${LEDGER_TABLE}`)).toEqual([{ file_name: '001_t.sql' }]);
  });
});
