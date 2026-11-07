import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from './pool.js';

/**
 * Counts the statements a unit of work (an HTTP request, a job, a batch)
 * sends to PostgreSQL, for the load budget: every route declares how many
 * statements it may cost, and tests fail a request that sends more.
 *
 * The count follows the async context of the caller, not the connection:
 * statements are recorded when `pool.query()` or a checked-out client's
 * `query()` is called, so a request waiting for a pooled connection is never
 * charged for another request's work. Transaction control (BEGIN, COMMIT,
 * ROLLBACK, SAVEPOINT, SET LOCAL, SET CONSTRAINTS) is not counted: a
 * `tx(3)` budget means three statements inside one transaction.
 */

export interface StatementTally {
  /** Statements counted against the budget. */
  statements: number;
  /** Transaction control statements seen (not counted). */
  control: number;
  /** The first line of each counted statement (SQL text only: values are parameters and never appear). */
  texts: string[];
  /** When set, the statement that goes past it is refused with {@link StatementBudgetError}. */
  budget?: number | undefined;
  /** Set when the budget was exceeded, even if the caller caught the error. */
  exceeded?: boolean | undefined;
}

export class StatementBudgetError extends Error {
  readonly budget: number;
  readonly texts: readonly string[];

  constructor(budget: number, texts: readonly string[]) {
    super(`statement budget of ${budget} exceeded by: ${texts.map((t) => `"${t}"`).join(', ')}`);
    this.name = 'StatementBudgetError';
    this.budget = budget;
    this.texts = texts;
  }
}

const CONTROL = /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|SET\s+(?:LOCAL|CONSTRAINTS|TRANSACTION))\b/i;

/** Transaction control, which a budget does not count. */
export function isControlStatement(text: string): boolean {
  return CONTROL.test(text);
}

const MAX_TEXTS = 50;

function firstLine(text: string): string {
  const line = text.trim().split('\n', 1)[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

export class StatementCounter {
  private readonly storage = new AsyncLocalStorage<StatementTally>();

  /** A fresh tally, optionally with a budget. */
  static tally(budget?: number): StatementTally {
    return { statements: 0, control: 0, texts: [], budget };
  }

  /** Runs `fn` (and everything it starts) against `tally`. */
  run<T>(tally: StatementTally, fn: () => T): T {
    return this.storage.run(tally, fn);
  }

  /** The tally of the current async context, if any. */
  current(): StatementTally | undefined {
    return this.storage.getStore();
  }

  /** Runs `fn` and returns its result with the statements it sent. */
  async measure<T>(fn: () => Promise<T>, budget?: number): Promise<{ result: T; tally: StatementTally }> {
    const tally = StatementCounter.tally(budget);
    const result = await this.run(tally, fn);
    return { result, tally };
  }

  /**
   * Records one statement in the current context. Returns the error to
   * reject with when the statement would exceed the budget.
   */
  record(text: string): StatementBudgetError | undefined {
    const tally = this.storage.getStore();
    if (!tally) return undefined;
    if (isControlStatement(text)) {
      tally.control += 1;
      return undefined;
    }
    tally.statements += 1;
    if (tally.texts.length < MAX_TEXTS) tally.texts.push(firstLine(text));
    if (tally.budget !== undefined && tally.statements > tally.budget) {
      tally.exceeded = true;
      return new StatementBudgetError(tally.budget, tally.texts);
    }
    return undefined;
  }
}

/** The process's counter: the pool instrumentation and the API's budget plugin share it. */
export const statementCounter = new StatementCounter();

const INSTRUMENTED = Symbol.for('app.db.statementCounter');

function statementText(config: unknown): string {
  if (typeof config === 'string') return config;
  if (config !== null && typeof config === 'object' && 'text' in config && typeof config.text === 'string') return config.text;
  return '';
}

type Query = (...args: unknown[]) => unknown;

function counted(counter: StatementCounter, query: Query, self: unknown, args: unknown[]): unknown {
  const refused = counter.record(statementText(args[0]));
  if (refused) {
    const callback = args.find((arg) => typeof arg === 'function') as ((error: Error) => void) | undefined;
    if (callback) {
      process.nextTick(() => callback(refused));
      return undefined;
    }
    return Promise.reject(refused);
  }
  return query.apply(self, args);
}

function countingClient(client: PoolClient, counter: StatementCounter): PoolClient {
  const query = client.query.bind(client) as Query;
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'query') return (...args: unknown[]) => counted(counter, query, target, args);
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value as Query).bind(target) : value;
    },
  });
}

/**
 * Makes a pool count its statements into `counter` (idempotent). Statements
 * sent through `pool.query()` and through clients from `await pool.connect()`
 * are counted; the pool's own internal use of `connect(callback)` is not
 * counted twice.
 */
export function instrumentPool(pool: Pool, counter: StatementCounter = statementCounter): Pool {
  const marked = pool as Pool & { [INSTRUMENTED]?: StatementCounter };
  if (marked[INSTRUMENTED] !== undefined) return pool;
  marked[INSTRUMENTED] = counter;

  const query = pool.query.bind(pool) as Query;
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  Object.defineProperty(pool, 'query', {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => counted(counter, query, pool, args),
  });
  Object.defineProperty(pool, 'connect', {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => {
      // pg-pool's own query() checks a client out with a callback: that statement was already counted.
      if (typeof args[0] === 'function') return connect(...args);
      return (connect() as Promise<PoolClient>).then((client) => countingClient(client, counter));
    },
  });
  return pool;
}
