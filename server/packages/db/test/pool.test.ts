import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NamedStatementError,
  RowCountError,
  SqlState,
  createPool,
  execute,
  hasSqlState,
  many,
  maybeOne,
  one,
  sql,
  withTransaction,
  type Pool,
} from '../src/index.js';
import { createTempDatabase, hasDatabase, type TempDatabase } from './support.js';

describe.skipIf(!hasDatabase)('pool, queries and transactions (PostgreSQL)', () => {
  let db: TempDatabase;
  let pool: Pool;

  beforeAll(async () => {
    db = await createTempDatabase();
    pool = createPool({
      connectionString: db.url,
      applicationName: 'db-test',
      max: 4,
      statementTimeoutMs: 300,
      idleInTransactionTimeoutMs: 2_000,
    });
    await execute(pool, sql`CREATE TABLE items (id integer PRIMARY KEY, label text NOT NULL)`);
  });

  afterAll(async () => {
    await pool?.end();
    await db?.drop();
  });

  it('applies the per-connection settings', async () => {
    const row = await one<{ statement_timeout: string; idle: string; app: string }>(
      pool,
      sql`SELECT current_setting('statement_timeout') AS statement_timeout,
                 current_setting('idle_in_transaction_session_timeout') AS idle,
                 current_setting('application_name') AS app`,
    );
    expect(row).toEqual({ statement_timeout: '300ms', idle: '2s', app: 'db-test' });
  });

  it('enforces the statement timeout on the server', async () => {
    const error = await one(pool, sql`SELECT pg_sleep(2)`).catch((caught: unknown) => caught);
    expect(hasSqlState(error, SqlState.queryCanceled)).toBe(true);
  });

  it('refuses named prepared statements', async () => {
    await expect(pool.query({ name: 'by-id', text: 'SELECT 1' })).rejects.toBeInstanceOf(NamedStatementError);
  });

  it('runs typed helpers', async () => {
    expect(await execute(pool, sql`INSERT INTO items VALUES (${1}, ${'one'}), (${2}, ${'two'})`)).toBe(2);
    expect(await many<{ id: number }>(pool, sql`SELECT id FROM items ORDER BY id`)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await maybeOne(pool, sql`SELECT id FROM items WHERE id = ${99}`)).toBeNull();
    await expect(one(pool, sql`SELECT id FROM items`)).rejects.toBeInstanceOf(RowCountError);
    await expect(maybeOne(pool, sql`SELECT id FROM items`)).rejects.toBeInstanceOf(RowCountError);
  });

  it('commits on success and rolls back on failure', async () => {
    await withTransaction(pool, async (tx) => {
      await execute(tx, sql`INSERT INTO items VALUES (${10}, ${'kept'})`);
    });
    await expect(
      withTransaction(pool, async (tx) => {
        await execute(tx, sql`INSERT INTO items VALUES (${11}, ${'dropped'})`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const ids = await many<{ id: number }>(pool, sql`SELECT id FROM items WHERE id >= 10 ORDER BY id`);
    expect(ids).toEqual([{ id: 10 }]);
  });

  it('applies SET LOCAL timeouts and read-only mode to one transaction only', async () => {
    const inside = await withTransaction(
      pool,
      async (tx) => one<{ t: string; ro: string }>(tx, sql`SELECT current_setting('statement_timeout') AS t, current_setting('transaction_read_only') AS ro`),
      { statementTimeoutMs: 1_500, readOnly: true, isolationLevel: 'repeatable read' },
    );
    expect(inside).toEqual({ t: '1500ms', ro: 'on' });
    const after = await one<{ t: string }>(pool, sql`SELECT current_setting('statement_timeout') AS t`);
    expect(after.t).toBe('300ms');
  });

  it('retries a serialization failure when asked to', async () => {
    let attempts = 0;
    const result = await withTransaction(
      pool,
      async () => {
        attempts += 1;
        if (attempts < 3) {
          // The same error PostgreSQL raises for a serialization conflict.
          await execute(pool, sql`DO $$ BEGIN RAISE EXCEPTION 'conflict' USING ERRCODE = '40001'; END $$`);
        }
        return 'done';
      },
      { isolationLevel: 'serializable', retries: 3 },
    );
    expect(result).toBe('done');
    expect(attempts).toBe(3);
  });
});
