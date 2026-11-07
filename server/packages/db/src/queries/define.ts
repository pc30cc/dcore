import type { Queryable } from '../query.js';

/**
 * Query modules: `src/queries/<area>.ts`, one exported query per statement
 * shape the apps run, so the SQL a route costs can be read in one place.
 *
 * - A query is defined with {@link defineQuery}: a name, the number of
 *   statements it sends (asserted by its tests with the statement counter),
 *   and an async function whose first argument is a `Queryable` (the pool, or
 *   the client of a transaction the caller opened), so the caller decides
 *   whether it runs alone or inside a transaction.
 * - SQL is written with the `sql` tag; values are always parameters.
 * - Row ids are bigints, which node-pg returns as decimal strings: they stay
 *   strings (never `Number`). Ids inside jsonb are emitted as text by the SQL.
 * - Lists are keyset-paginated: no `OFFSET`, no `count(*)` on a request path
 *   (a test scans the modules for both).
 * - A query does nothing outside PostgreSQL (no Valkey, no network): caching
 *   and side effects belong to the caller.
 * - A query that reads a JSON shape validates it before handing it on.
 */

export interface QueryInfo {
  /** `area.what`, e.g. `account.view`; shows up in budget failures and logs. */
  readonly name: string;
  /** Statements the query sends (transaction control excluded). */
  readonly statements: number;
}

export type DefinedQuery<A extends unknown[], R> = ((db: Queryable, ...args: A) => Promise<R>) & { readonly info: QueryInfo };

export function defineQuery<A extends unknown[], R>(info: QueryInfo, run: (db: Queryable, ...args: A) => Promise<R>): DefinedQuery<A, R> {
  if (!/^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/.test(info.name)) throw new TypeError(`query name "${info.name}" must be area.what`);
  if (!Number.isInteger(info.statements) || info.statements < 1) throw new RangeError('a query sends at least one statement');
  return Object.assign(run, { info });
}
