import { afterAll, describe, expect, it } from 'vitest';
import { createPool, many, one, sql, withTransaction, type Pool } from '../src/index.js';

/**
 * The pool behind PgBouncer in transaction mode (infra/dev/native.sh starts
 * one; TEST_PGBOUNCER_URL points at it). Skipped without it, unless
 * REQUIRE_INTEGRATION=1.
 */
const TEST_PGBOUNCER_URL = process.env['TEST_PGBOUNCER_URL'];
if (!TEST_PGBOUNCER_URL && process.env['REQUIRE_INTEGRATION'] === '1') {
  throw new Error('REQUIRE_INTEGRATION=1 but TEST_PGBOUNCER_URL is not set');
}

describe.skipIf(!TEST_PGBOUNCER_URL)('pool behind PgBouncer in transaction mode', () => {
  const pools: Pool[] = [];
  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
  });

  function pool(target: 'postgres' | 'pgbouncer'): Pool {
    const created = createPool({
      connectionString: TEST_PGBOUNCER_URL ?? '',
      applicationName: `bouncer-${target}`,
      target,
      max: 10,
    });
    pools.push(created);
    return created;
  }

  it('connects with only application_name and gets the timeouts from the role', async () => {
    const bouncer = pool('pgbouncer');
    const row = await one<{ timeout: string; idle: string; app: string }>(
      bouncer,
      sql`SELECT current_setting('statement_timeout') AS timeout,
                 current_setting('idle_in_transaction_session_timeout') AS idle,
                 current_setting('application_name') AS app`,
    );
    // infra/dev/native.sh (and infra/postgres/init) set these on the role.
    expect(row).toEqual({ timeout: '5s', idle: '10s', app: 'bouncer-pgbouncer' });
  });

  it('shows why the target matters: PgBouncer refuses timeouts sent as startup parameters', async () => {
    await expect(one(pool('postgres'), sql`SELECT 1 AS one`)).rejects.toThrow(/unsupported startup parameter/);
  });

  it('runs parameterized statements and SET LOCAL transactions through it', async () => {
    const bouncer = pool('pgbouncer');
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => one<{ n: number }>(bouncer, sql`SELECT ${i}::int AS n`)),
    );
    expect(results.map((r) => r.n)).toEqual(Array.from({ length: 40 }, (_, i) => i));

    const inside = await withTransaction(
      bouncer,
      async (tx) => many<{ t: string }>(tx, sql`SELECT current_setting('statement_timeout') AS t`),
      { statementTimeoutMs: 750 },
    );
    expect(inside).toEqual([{ t: '750ms' }]);
    // SET LOCAL ended with the transaction; the server connection is clean for the next client.
    expect((await one<{ t: string }>(bouncer, sql`SELECT current_setting('statement_timeout') AS t`)).t).toBe('5s');
  });
});
