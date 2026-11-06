import { setTimeout as sleep } from 'node:timers/promises';
import { isRetryableTransactionError } from './errors.js';
import type { Pool, PoolClient } from './pool.js';

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

export interface TransactionOptions {
  isolationLevel?: IsolationLevel | undefined;
  readOnly?: boolean | undefined;
  /**
   * A statement timeout for this transaction only (`SET LOCAL`), which is safe
   * behind PgBouncer in transaction mode: it ends with the transaction.
   */
  statementTimeoutMs?: number | undefined;
  /**
   * Runs the body again after a serialization failure or a deadlock, up to
   * this many times. Only for bodies with no effect outside the database.
   */
  retries?: number | undefined;
}

const ISOLATION: Readonly<Record<IsolationLevel, string>> = {
  'read committed': 'READ COMMITTED',
  'repeatable read': 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
};

/** The statement that opens the transaction, settings included, so it costs one round trip. */
export function beginStatement(options: TransactionOptions = {}): string {
  let begin = 'BEGIN';
  if (options.isolationLevel) begin += ` ISOLATION LEVEL ${ISOLATION[options.isolationLevel]}`;
  if (options.readOnly) begin += ' READ ONLY';
  const timeout = options.statementTimeoutMs;
  if (timeout !== undefined) {
    if (!Number.isInteger(timeout) || timeout < 0) throw new RangeError('statementTimeoutMs must be a non-negative integer');
    // A validated integer, so it is safe in the text (SET does not take parameters).
    begin += `; SET LOCAL statement_timeout = ${timeout}`;
  }
  return begin;
}

/**
 * Runs `body` in a transaction on one pooled connection: COMMIT when it
 * resolves, ROLLBACK when it throws. Keep transactions short: behind PgBouncer
 * in transaction mode each one holds a server connection until it ends.
 */
export async function withTransaction<T>(
  pool: Pool,
  body: (tx: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const begin = beginStatement(options);
  const retries = options.retries ?? 0;
  for (let attempt = 0; ; attempt += 1) {
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      await client.query(begin);
      const result = await body(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        // The connection is in an unknown state: drop it instead of pooling it.
        broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      if (attempt < retries && isRetryableTransactionError(error)) {
        await sleep(Math.min(1_000, 20 * 2 ** attempt) * (0.5 + Math.random() / 2));
        continue;
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }
}
