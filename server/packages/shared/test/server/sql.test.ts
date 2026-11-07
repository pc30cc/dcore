import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appConfigKeys, codeTables, parseAppConfig } from '../../src/index.js';

/**
 * The code tables and the app_config schemas against the migrations
 * themselves (read as text: no database needed). A code added in SQL without
 * its constant here, or the other way round, fails.
 */

const MIGRATIONS = new URL('../../../db/migrations/', import.meta.url);
const sql = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(new URL(name, MIGRATIONS), 'utf8'))
  .join('\n');

const unquote = (literal: string) => literal.replaceAll("''", "'");
const tableComments = new Map<string, string>();
for (const m of sql.matchAll(/COMMENT ON TABLE (\w+) IS\s*'((?:[^']|'')*)'/g)) tableComments.set(m[1]!, unquote(m[2]!));
const columnComments = new Map<string, string>();
for (const m of sql.matchAll(/COMMENT ON COLUMN (\w+)\.(\w+) IS\s*'((?:[^']|'')*)'/g)) {
  columnComments.set(`${m[1]}.${m[2]}`, unquote(m[3]!));
}

/**
 * Reads `1 label, 2 other label (a note), 99 last` from `text` at `start`:
 * a label ends at a comma, semicolon, colon, closing parenthesis or full
 * stop; notes in parentheses are skipped; the list ends at the first item
 * that does not start with a number.
 */
function parseList(text: string, start: number): Map<number, string> {
  const out = new Map<number, string>();
  let i = start;
  for (;;) {
    const head = /^\s*(\d+) /.exec(text.slice(i));
    if (!head) return out;
    i += head[0].length;
    let label = '';
    let end: string | undefined;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === '(') {
        let depth = 0;
        for (; i < text.length; i += 1) {
          if (text[i] === '(') depth += 1;
          else if (text[i] === ')' && --depth === 0) break;
        }
        i += 1;
        continue;
      }
      if (ch === ',' || ch === ';' || ch === ':' || ch === ')' || (ch === '.' && (i + 1 >= text.length || text[i + 1] === ' '))) {
        end = ch;
        break;
      }
      label += ch;
      i += 1;
    }
    out.set(Number(head[1]), label.trim());
    i += 1;
    if (end !== ',') return out;
  }
}

function sqlCodes(table: string, key: string): Map<number, string> {
  const column = columnComments.get(`${table}.${key}`);
  if (column !== undefined) {
    const first = /\d+ \w/.exec(column);
    if (!first) throw new Error(`${table}.${key}: no list in the column comment`);
    return parseList(column, first.index);
  }
  const comment = tableComments.get(table);
  if (comment === undefined) throw new Error(`no COMMENT ON TABLE ${table}`);
  const at = new RegExp(`(?<![\\w])${key}(?:\\s*\\([^)]*\\))?:`).exec(comment);
  if (!at) throw new Error(`${table}: the comment does not document ${key}`);
  const rest = comment.slice(at.index + at[0].length);
  const first = /\d+ \S/.exec(rest);
  if (!first) throw new Error(`${table}.${key}: no list`);
  return parseList(rest, first.index);
}

describe('code tables against the SQL comments', () => {
  for (const table of codeTables) {
    const { table: name, key } = table.source;
    it(`${name}.${key}`, () => {
      const expected = sqlCodes(name, key);
      const actual = new Map(table.names.map((n) => [table.entries[n]!.code, table.entries[n]!.sql]));
      expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(expected));
    });
  }

  it('reads the lists the way they are written', () => {
    expect(parseList('a: 1 x (note, more), 2 y z. next: 3 w', 3)).toEqual(new Map([[1, 'x'], [2, 'y z']]));
    expect(parseList('(1 a, 2 b)', 1)).toEqual(new Map([[1, 'a'], [2, 'b']]));
  });

  it('round-trips names and codes', () => {
    for (const table of codeTables) {
      for (const name of table.names) expect(table.name(table.code(name))).toBe(name);
      expect(() => table.name(32_000)).toThrow(RangeError);
    }
  });
});

describe('app_config seeds', () => {
  const rows: { key: string; value: unknown }[] = [];
  for (const insert of sql.matchAll(/INSERT INTO app_config \(key, value\) VALUES([\s\S]*?);/g)) {
    for (const m of insert[1]!.matchAll(/\('([a-z0-9_.]+)',\s*'((?:[^']|'')*)'\)/g)) {
      rows.push({ key: m[1]!, value: JSON.parse(unquote(m[2]!)) });
    }
  }

  it('seeds every typed key once, and every seed parses', () => {
    const keys = rows.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
    const { config, unknown } = parseAppConfig(rows);
    expect(unknown).toEqual([]);
    expect(Object.keys(config).sort()).toEqual([...appConfigKeys].sort());
  });

  it('seeds the keys of migration 0010', () => {
    const { config } = parseAppConfig(rows);
    expect(config['retention.unmatched_messages_days']).toBe(7);
    expect(config['auth.sms_routing'].default).toEqual(['telnyx']);
    expect(config['auth.otp_caps'].resend_seconds).toBe(60);
  });
});
