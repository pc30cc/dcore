import { describe, expect, it } from 'vitest';
import { NamedStatementError, beginStatement, clientConfig, identifier, joinSql, maskSqlLiterals, sql } from '../src/index.js';

describe('sql tag', () => {
  it('turns values into numbered parameters', () => {
    const id = "x'; DROP TABLE users; --";
    expect(sql`SELECT * FROM users WHERE id = ${id} AND age > ${18}`.toQuery()).toEqual({
      text: 'SELECT * FROM users WHERE id = $1 AND age > $2',
      values: [id, 18],
    });
  });

  it('inlines nested fragments and renumbers their parameters', () => {
    const verified = sql`verified = ${true} AND `;
    const statement = sql`SELECT 1 FROM p WHERE ${verified}city = ${'ist'} AND ${sql`id > ${5}`}`;
    expect(statement.toQuery()).toEqual({
      text: 'SELECT 1 FROM p WHERE verified = $1 AND city = $2 AND id > $3',
      values: [true, 'ist', 5],
    });
    expect(sql`SELECT ${sql``}1`.toQuery()).toEqual({ text: 'SELECT 1', values: [] });
  });

  it('joins fragments', () => {
    const rows = [sql`(${1}, ${'a'})`, sql`(${2}, ${'b'})`];
    expect(sql`INSERT INTO t (n, s) VALUES ${joinSql(rows)}`.toQuery()).toEqual({
      text: 'INSERT INTO t (n, s) VALUES ($1, $2), ($3, $4)',
      values: [1, 'a', 2, 'b'],
    });
    expect(joinSql([]).toQuery()).toEqual({ text: '', values: [] });
    expect(joinSql([sql`a = ${1}`, sql`b = ${2}`], sql` AND `).toQuery().text).toBe('a = $1 AND b = $2');
  });

  it('quotes only plain identifiers', () => {
    expect(sql`SELECT * FROM ${identifier('public', 'profiles')}`.toQuery().text).toBe('SELECT * FROM "public"."profiles"');
    expect(() => identifier('profiles"; DROP')).toThrow(TypeError);
    expect(() => identifier('Profiles')).toThrow(TypeError);
  });
});

describe('pool settings', () => {
  const base = { connectionString: 'postgres://u:p@localhost:5432/db', applicationName: 'api' };

  it('sends the timeouts as startup parameters to PostgreSQL', () => {
    const config = clientConfig({ ...base, statementTimeoutMs: 4_000, idleInTransactionTimeoutMs: 9_000 });
    expect(config).toMatchObject({ application_name: 'api', statement_timeout: 4_000, idle_in_transaction_session_timeout: 9_000 });
  });

  it('sends only application_name to PgBouncer in transaction mode', () => {
    const config = clientConfig({ ...base, target: 'pgbouncer', statementTimeoutMs: 4_000 });
    expect(config.application_name).toBe('api');
    expect(config).not.toHaveProperty('statement_timeout');
    expect(config).not.toHaveProperty('idle_in_transaction_session_timeout');
  });

  it('builds BEGIN statements from validated options only', () => {
    expect(beginStatement()).toBe('BEGIN');
    expect(beginStatement({ isolationLevel: 'serializable', readOnly: true, statementTimeoutMs: 250 })).toBe(
      'BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY; SET LOCAL statement_timeout = 250',
    );
    expect(() => beginStatement({ statementTimeoutMs: 1.5 })).toThrow(RangeError);
  });

  it('names the guard error', () => {
    expect(new NamedStatementError('q1').message).toContain('PgBouncer');
  });
});

describe('maskSqlLiterals', () => {
  it('blanks comments, strings and dollar-quoted bodies but keeps offsets', () => {
    const text = "SELECT 'a;COMMIT;' -- COMMIT;\n/* BEGIN; /* nested */ */ $f$ COMMIT; $f$ \"COMMIT\"";
    const masked = maskSqlLiterals(text);
    expect(masked).toHaveLength(text.length);
    expect(masked).not.toMatch(/COMMIT|BEGIN/);
    expect(masked.startsWith('SELECT ')).toBe(true);
    expect(masked.split('\n')).toHaveLength(2);
  });
});
