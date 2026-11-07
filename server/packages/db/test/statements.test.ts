import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  StatementBudgetError,
  StatementCounter,
  createPool,
  defineQuery,
  execute,
  instrumentPool,
  isControlStatement,
  many,
  one,
  sql,
  statementCounter,
  withTransaction,
  type Pool,
} from '../src/index.js';
import { createTempDatabase, hasDatabase, type TempDatabase } from './support.js';

describe('statement classes', () => {
  it('leaves transaction control out of the count', () => {
    for (const text of ['BEGIN', 'BEGIN ISOLATION LEVEL SERIALIZABLE; SET LOCAL statement_timeout = 5', 'COMMIT', 'rollback', 'SAVEPOINT a', 'RELEASE a', 'SET CONSTRAINTS photos_user_position_key DEFERRED']) {
      expect(isControlStatement(text), text).toBe(true);
    }
    for (const text of ['SELECT 1', 'UPDATE sessions SET x = 1', 'SET search_path = x', 'WITH a AS (SELECT 1) SELECT * FROM a', 'begin_stuff()']) {
      expect(isControlStatement(text), text).toBe(false);
    }
  });

  it('defines queries with a name and a statement count', () => {
    const q = defineQuery({ name: 'area.thing', statements: 1 }, async () => 1);
    expect(q.info).toEqual({ name: 'area.thing', statements: 1 });
    expect(() => defineQuery({ name: 'nodot', statements: 1 }, async () => 1)).toThrow(TypeError);
    expect(() => defineQuery({ name: 'a.b', statements: 0 }, async () => 1)).toThrow(RangeError);
  });

  it('keeps OFFSET and count(*) out of the query modules', () => {
    const dir = new URL('../src/queries/', import.meta.url);
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const text = readFileSync(new URL(name, dir), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      expect(text, name).not.toMatch(/\bOFFSET\b/i);
      expect(text, name).not.toMatch(/count\s*\(\s*\*\s*\)/i);
    }
  });
});

describe.skipIf(!hasDatabase)('statement counter (PostgreSQL)', () => {
  let db: TempDatabase;
  let pool: Pool;

  beforeAll(async () => {
    db = await createTempDatabase();
    // One connection: concurrent work queues for it, the case where a
    // connection-based count would charge the wrong caller.
    pool = instrumentPool(createPool({ connectionString: db.url, applicationName: 'db-test', max: 1 }));
    await execute(pool, sql`CREATE TABLE t (id integer PRIMARY KEY)`);
  });

  afterAll(async () => {
    await pool?.end();
    await db?.drop();
  });

  it('counts pool queries and transaction statements, not the control around them', async () => {
    const { tally } = await statementCounter.measure(async () => {
      await one(pool, sql`SELECT 1 AS v`);
      await withTransaction(pool, async (tx) => {
        await execute(tx, sql`INSERT INTO t VALUES (1)`);
        await execute(tx, sql`UPDATE t SET id = 2 WHERE id = 1`);
        await execute(tx, sql`SET CONSTRAINTS ALL DEFERRED`);
      }, { statementTimeoutMs: 1_000 });
    });
    expect(tally.statements).toBe(3);
    expect(tally.control).toBe(3);
    expect(tally.texts).toEqual(['SELECT 1 AS v', 'INSERT INTO t VALUES (1)', 'UPDATE t SET id = 2 WHERE id = 1']);
  });

  it('charges each caller for its own statements while they wait for one connection', async () => {
    const work = (n: number) =>
      statementCounter.measure(async () => {
        for (let i = 0; i < n; i += 1) await many(pool, sql`SELECT ${i}::int AS v`);
        await withTransaction(pool, async (tx) => {
          for (let i = 0; i < n; i += 1) await one(tx, sql`SELECT ${i}::int AS v`);
        });
      });
    const results = await Promise.all([work(1), work(2), work(3), work(4), work(5)]);
    expect(results.map((r) => r.tally.statements)).toEqual([2, 4, 6, 8, 10]);
  });

  it('refuses the statement past a budget, and says which ones were sent', async () => {
    const counter = new StatementCounter();
    const own = instrumentPool(createPool({ connectionString: db.url, applicationName: 'db-test', max: 2 }), counter);
    try {
      const tally = StatementCounter.tally(1);
      const error = await counter.run(tally, async () => {
        await one(own, sql`SELECT 1 AS v`);
        return one(own, sql`SELECT 2 AS v`).catch((e: unknown) => e);
      });
      expect(error).toBeInstanceOf(StatementBudgetError);
      expect((error as StatementBudgetError).texts).toEqual(['SELECT 1 AS v', 'SELECT 2 AS v']);
      expect(tally.exceeded).toBe(true);
      // The refused statement never reached the server, and a transaction client is refused the same way.
      const inTx = StatementCounter.tally(0);
      await expect(counter.run(inTx, () => withTransaction(own, (tx) => one(tx, sql`SELECT 3 AS v`)))).rejects.toBeInstanceOf(StatementBudgetError);
      // Outside a tally nothing is counted or refused.
      await one(own, sql`SELECT 4 AS v`);
    } finally {
      await own.end();
    }
  });

  it('instruments a pool once', async () => {
    expect(instrumentPool(pool)).toBe(pool);
    const { tally } = await statementCounter.measure(() => one(pool, sql`SELECT 1 AS v`));
    expect(tally.statements).toBe(1);
  });
});
