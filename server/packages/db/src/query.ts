import type pg from 'pg';

/**
 * A SQL statement built with the {@link sql} tag. Interpolated values become
 * `$n` parameters, never text, so a value cannot change the statement.
 */
export class SqlFragment {
  readonly strings: readonly string[];
  readonly values: readonly unknown[];

  /** Use the {@link sql} tag; this constructor trusts `strings` as SQL text. */
  constructor(strings: readonly string[], values: readonly unknown[]) {
    if (strings.length !== values.length + 1) {
      throw new TypeError('a SQL fragment needs exactly one more string than values');
    }
    this.strings = strings;
    this.values = values;
  }

  /** The text and parameters to send, with nested fragments inlined and renumbered. */
  toQuery(): { text: string; values: unknown[] } {
    const values: unknown[] = [];
    const text = compile(this, values);
    return { text, values };
  }
}

function compile(fragment: SqlFragment, values: unknown[]): string {
  let text = fragment.strings[0] ?? '';
  fragment.values.forEach((value, index) => {
    if (value instanceof SqlFragment) {
      text += compile(value, values);
    } else {
      values.push(value);
      text += `$${values.length}`;
    }
    text += fragment.strings[index + 1] ?? '';
  });
  return text;
}

/**
 * Tags a SQL statement:
 *
 *     sql`SELECT id FROM profiles WHERE city_id = ${cityId} AND id > ${after}`
 *
 * A nested fragment is inlined, which is how optional clauses are composed:
 *
 *     sql`SELECT ... WHERE ${onlyVerified ? sql`verified AND ` : sql``} id > ${after}`
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment {
  return new SqlFragment(strings, values);
}

/** Joins fragments with a separator (a comma by default). */
export function joinSql(fragments: readonly SqlFragment[], separator: SqlFragment = sql`, `): SqlFragment {
  if (fragments.length === 0) return sql``;
  const strings: string[] = [''];
  const values: unknown[] = [];
  fragments.forEach((fragment, index) => {
    if (index > 0) {
      values.push(separator);
      strings.push('');
    }
    values.push(fragment);
    strings.push('');
  });
  return new SqlFragment(strings, values);
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * A quoted identifier (table or column name) for the rare statement that needs
 * one chosen at run time. Only plain lowercase names are accepted, and only
 * from a list the code controls, never from a request.
 */
export function identifier(...parts: string[]): SqlFragment {
  if (parts.length === 0) throw new TypeError('identifier() needs at least one part');
  for (const part of parts) {
    if (!IDENTIFIER.test(part)) throw new TypeError(`"${part}" is not a plain lowercase identifier`);
  }
  return new SqlFragment([parts.map((part) => `"${part}"`).join('.')], []);
}

/** Anything that runs a query: the pool or a client inside a transaction. */
export interface Queryable {
  query<R extends pg.QueryResultRow>(config: pg.QueryConfig): Promise<pg.QueryResult<R>>;
}

export class RowCountError extends Error {
  readonly expected: string;
  readonly received: number;

  constructor(expected: string, received: number) {
    super(`expected ${expected} row(s), received ${received}`);
    this.name = 'RowCountError';
    this.expected = expected;
    this.received = received;
  }
}

/** Runs a statement and returns the full result (rows, rowCount, fields). */
export async function query<R extends pg.QueryResultRow>(db: Queryable, statement: SqlFragment): Promise<pg.QueryResult<R>> {
  // Deliberately no `name`: statements stay unnamed (see UnnamedStatementClient).
  return db.query<R>(statement.toQuery());
}

/** All rows. */
export async function many<R extends pg.QueryResultRow>(db: Queryable, statement: SqlFragment): Promise<R[]> {
  return (await query<R>(db, statement)).rows;
}

/** The only row, or `null`; more than one row is a bug and throws. */
export async function maybeOne<R extends pg.QueryResultRow>(db: Queryable, statement: SqlFragment): Promise<R | null> {
  const { rows } = await query<R>(db, statement);
  if (rows.length > 1) throw new RowCountError('0 or 1', rows.length);
  return rows[0] ?? null;
}

/** Exactly one row, or a {@link RowCountError}. */
export async function one<R extends pg.QueryResultRow>(db: Queryable, statement: SqlFragment): Promise<R> {
  const { rows } = await query<R>(db, statement);
  if (rows.length !== 1 || rows[0] === undefined) throw new RowCountError('exactly 1', rows.length);
  return rows[0];
}

/** Runs a statement for its effect and returns the number of rows it touched. */
export async function execute(db: Queryable, statement: SqlFragment): Promise<number> {
  return (await query(db, statement)).rowCount ?? 0;
}
