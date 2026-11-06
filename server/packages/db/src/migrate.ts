import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { SqlState, isDatabaseError } from './errors.js';

/**
 * The migration runner.
 *
 * - Applies `*.sql` files of one directory in lexical (code point) order.
 * - One transaction per file: a file is applied completely, together with its
 *   ledger row, or not at all.
 * - The ledger `public._schema_migrations` holds each applied file's name and
 *   the SHA-256 of its bytes. A file that changed after it was applied, or an
 *   applied file that disappeared, stops the runner before it applies anything.
 * - A session-level advisory lock keeps two runners from racing; the second
 *   one waits, then finds the work done.
 *
 * It needs a direct session to PostgreSQL (advisory locks and SET are session
 * state): point it at the database, not at PgBouncer in transaction mode.
 */

export const LEDGER_TABLE = 'public._schema_migrations';

/** A fixed advisory lock key, derived from a constant so every runner agrees on it. */
export const MIGRATION_LOCK_KEY = BigInt(
  `0x${createHash('sha256').update('schema-migrations-runner').digest('hex').slice(0, 15)}`,
).toString();

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/;

export interface MigrationLog {
  info(message: string): void;
  warn(message: string): void;
}

const consoleLog: MigrationLog = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
};

export interface MigrationOptions {
  /** A direct PostgreSQL URL for a role that may change the schema. */
  connectionString: string;
  /** The directory that holds the `*.sql` files. */
  directory: string;
  /** How long to wait for another runner to finish. */
  lockWaitMs?: number | undefined;
  /**
   * `lock_timeout` while a file runs: a statement that waits longer than this
   * for a table lock fails instead of queueing the app's traffic behind it.
   */
  lockTimeoutMs?: number | undefined;
  /** `statement_timeout` while a file runs; 0 (the default) means none. */
  statementTimeoutMs?: number | undefined;
  applicationName?: string | undefined;
  log?: MigrationLog | undefined;
}

export interface MigrationFile {
  name: string;
  sha256: string;
  sql: string;
}

export interface AppliedMigration {
  name: string;
  sha256: string;
  appliedAt: Date;
  durationMs: number;
}

export interface MigrationStatus {
  applied: AppliedMigration[];
  pending: string[];
  /** Applied files whose bytes differ from what was applied. */
  changed: string[];
  /** Applied files that are no longer in the directory. */
  missing: string[];
}

export interface MigrationReport {
  dryRun: boolean;
  /** Files applied by this run (in a dry run: the files that would be). */
  applied: { name: string; sha256: string; durationMs: number }[];
  /** Files that were already in the ledger. */
  alreadyApplied: number;
}

export class MigrationError extends Error {
  readonly file: string | undefined;

  constructor(message: string, file?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MigrationError';
    this.file = file;
  }
}

/** The ledger does not match the directory; nothing was applied. */
export class MigrationIntegrityError extends MigrationError {
  readonly changed: readonly string[];
  readonly missing: readonly string[];

  constructor(changed: readonly string[], missing: readonly string[]) {
    const lines = [
      ...changed.map((name) => `  - ${name}: changed after it was applied (sha256 differs)`),
      ...missing.map((name) => `  - ${name}: applied, but no longer in the directory`),
    ];
    super(
      `refusing to migrate: the ledger does not match the migration files\n${lines.join('\n')}\n` +
        'An applied migration is never edited or removed: add a new file instead.',
    );
    this.name = 'MigrationIntegrityError';
    this.changed = changed;
    this.missing = missing;
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Reads the directory's migration files in the order they are applied. */
export async function readMigrationFiles(directory: string): Promise<MigrationFile[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new MigrationError(`cannot read the migrations directory ${directory}`, undefined, { cause: error });
  }
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql') && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort(byCodePoint);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const files: MigrationFile[] = [];
  for (const name of names) {
    if (!FILE_NAME.test(name)) {
      throw new MigrationError(`${name}: a migration file name may only use letters, digits, ".", "_" and "-"`, name);
    }
    const bytes = await readFile(path.join(directory, name));
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch (error) {
      throw new MigrationError(`${name}: not valid UTF-8`, name, { cause: error });
    }
    if (text.trim().length === 0) throw new MigrationError(`${name}: the file is empty`, name);
    assertNoTransactionControl(name, text);
    files.push({ name, sha256: sha256Hex(bytes), sql: text });
  }
  return files;
}

/**
 * Blanks out comments, quoted strings, quoted identifiers and dollar-quoted
 * bodies, keeping offsets, so statement keywords can be found safely.
 */
export function maskSqlLiterals(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to; i += 1) if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    if (rest.startsWith('--')) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (rest.startsWith('/*')) {
      // Block comments nest in PostgreSQL.
      let depth = 0;
      let j = i;
      while (j < text.length) {
        if (text.startsWith('/*', j)) {
          depth += 1;
          j += 2;
        } else if (text.startsWith('*/', j)) {
          depth -= 1;
          j += 2;
          if (depth === 0) break;
        } else j += 1;
      }
      blank(i, j);
      i = j;
    } else if (text[i] === "'" || text[i] === '"') {
      const quote = text[i];
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === quote) {
          if (text[j + 1] === quote) j += 2;
          else break;
        } else j += 1;
      }
      blank(i, j + 1);
      i = j + 1;
    } else if (text[i] === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
      if (tag) {
        const end = text.indexOf(tag[0], i + tag[0].length);
        const stop = end === -1 ? text.length : end + tag[0].length;
        blank(i, stop);
        i = stop;
      } else i += 1;
    } else i += 1;
  }
  return out.join('');
}

const TRANSACTION_CONTROL =
  /(?:^|;)\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT)(?:\s+(?:WORK|TRANSACTION))?\s*(?:;|$)/i;

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}

/** A file must not open or end transactions: the runner owns the one it runs in. */
function assertNoTransactionControl(name: string, text: string): void {
  // SQL-standard function bodies (BEGIN ATOMIC ... END) are not transaction control.
  const masked = maskSqlLiterals(text).replace(/\bBEGIN\s+ATOMIC\b[\s\S]*?;\s*END\b/gi, (body) =>
    body.replace(/[^\n]/g, ' '),
  );
  const match = TRANSACTION_CONTROL.exec(masked);
  if (match?.[1]) {
    const offset = match.index + match[0].indexOf(match[1]);
    throw new MigrationError(
      `${name}: line ${lineOf(text, offset)}: "${match[1]?.toUpperCase()}" is not allowed; ` +
        'the runner wraps each file in its own transaction',
      name,
    );
  }
}

async function ledgerExists(client: pg.Client): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    `SELECT to_regclass('${LEDGER_TABLE}') IS NOT NULL AS present`,
  );
  return rows[0]?.present === true;
}

/** Creates the ledger; called with the advisory lock held, so two runners cannot race here. */
async function ensureLedger(client: pg.Client): Promise<void> {
  if (await ledgerExists(client)) return;
  await client.query(`
    CREATE TABLE ${LEDGER_TABLE} (
      file_name   text        PRIMARY KEY,
      sha256      text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer     NOT NULL CHECK (duration_ms >= 0),
      applied_by  text        NOT NULL DEFAULT current_user
    )`);
  await client.query(`COMMENT ON TABLE ${LEDGER_TABLE} IS 'Applied migration files; written by the migration runner only.'`);
}

async function readLedger(client: pg.Client): Promise<AppliedMigration[]> {
  if (!(await ledgerExists(client))) return [];
  const { rows } = await client.query<{ file_name: string; sha256: string; applied_at: Date; duration_ms: number }>(
    `SELECT file_name, sha256, applied_at, duration_ms FROM ${LEDGER_TABLE} ORDER BY file_name COLLATE "C"`,
  );
  return rows.map((row) => ({
    name: row.file_name,
    sha256: row.sha256,
    appliedAt: row.applied_at,
    durationMs: row.duration_ms,
  }));
}

function compare(files: readonly MigrationFile[], applied: readonly AppliedMigration[]): MigrationStatus {
  const byName = new Map(files.map((file) => [file.name, file]));
  const appliedNames = new Set(applied.map((row) => row.name));
  const changed: string[] = [];
  const missing: string[] = [];
  for (const row of applied) {
    const file = byName.get(row.name);
    if (!file) missing.push(row.name);
    else if (file.sha256 !== row.sha256) changed.push(row.name);
  }
  return {
    applied: [...applied],
    pending: files.filter((file) => !appliedNames.has(file.name)).map((file) => file.name),
    changed,
    missing,
  };
}

function connect(options: MigrationOptions): pg.Client {
  return new pg.Client({
    connectionString: options.connectionString,
    application_name: options.applicationName ?? 'migrate',
    connectionTimeoutMillis: 10_000,
  });
}

/** Reports what is applied and pending without changing anything. */
export async function migrationStatus(options: MigrationOptions): Promise<MigrationStatus> {
  const files = await readMigrationFiles(options.directory);
  const client = connect(options);
  await client.connect();
  try {
    return compare(files, await readLedger(client));
  } finally {
    await client.end();
  }
}

async function acquireLock(client: pg.Client, waitMs: number, log: MigrationLog): Promise<void> {
  const deadline = Date.now() + waitMs;
  let warned = false;
  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS locked', [
      MIGRATION_LOCK_KEY,
    ]);
    if (rows[0]?.locked) return;
    if (Date.now() >= deadline) {
      throw new MigrationError(`another migration runner held the lock for more than ${waitMs} ms`);
    }
    if (!warned) {
      log.info('another migration runner is active; waiting for it to finish');
      warned = true;
    }
    await sleep(250);
  }
}

function describeFailure(file: MigrationFile, error: unknown): MigrationError {
  if (isDatabaseError(error)) {
    const position = error.position ? Number(error.position) : NaN;
    const where = Number.isFinite(position) ? ` (line ${lineOf(file.sql, position - 1)})` : '';
    let hint = error.hint ? ` Hint: ${error.hint}` : '';
    if (error.code === SqlState.activeSqlTransaction) {
      hint +=
        ' This statement cannot run inside a transaction (CREATE INDEX CONCURRENTLY, VACUUM, ...):' +
        ' run it by hand before the migration and keep IF NOT EXISTS in the file.';
    }
    return new MigrationError(`${file.name}${where}: ${error.message} [${error.code}].${hint}`, file.name, {
      cause: error,
    });
  }
  return new MigrationError(`${file.name}: ${String(error)}`, file.name, { cause: error });
}

async function currentXid(client: pg.Client): Promise<string> {
  const { rows } = await client.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid');
  return rows[0]?.xid ?? '';
}

async function runFile(client: pg.Client, file: MigrationFile): Promise<number> {
  const started = performance.now();
  const xid = await currentXid(client);
  try {
    // No parameters: the simple query protocol, so a file may hold many statements.
    await client.query(file.sql);
  } catch (error) {
    throw describeFailure(file, error);
  }
  if ((await currentXid(client)) !== xid) {
    throw new MigrationError(
      `${file.name}: the file ended the runner's transaction; check by hand what it committed`,
      file.name,
    );
  }
  const durationMs = Math.round(performance.now() - started);
  await client.query(`INSERT INTO ${LEDGER_TABLE} (file_name, sha256, duration_ms) VALUES ($1, $2, $3)`, [
    file.name,
    file.sha256,
    durationMs,
  ]);
  return durationMs;
}

function beginWith(options: MigrationOptions): string {
  const lockTimeout = options.lockTimeoutMs ?? 5_000;
  const statementTimeout = options.statementTimeoutMs ?? 0;
  for (const [label, value] of [
    ['lockTimeoutMs', lockTimeout],
    ['statementTimeoutMs', statementTimeout],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative integer`);
  }
  return `BEGIN; SET LOCAL lock_timeout = ${lockTimeout}; SET LOCAL statement_timeout = ${statementTimeout}`;
}

/**
 * Applies the pending files, each in its own transaction. With `dryRun`, runs
 * them all in one transaction and rolls it back, so nothing changes but every
 * file is proven to run against the real schema.
 */
export async function runMigrations(options: MigrationOptions & { dryRun?: boolean }): Promise<MigrationReport> {
  const log = options.log ?? consoleLog;
  const dryRun = options.dryRun ?? false;
  const begin = beginWith(options);
  const files = await readMigrationFiles(options.directory);
  const client = connect(options);
  await client.connect();
  // A failure on an idle client must not crash the process; the next query reports it.
  client.on('error', (error) => log.warn(`migration connection failed: ${error.message}`));
  let locked = false;
  try {
    await acquireLock(client, options.lockWaitMs ?? 60_000, log);
    locked = true;
    if (!dryRun) await ensureLedger(client);

    const status = compare(files, await readLedger(client));
    if (status.changed.length > 0 || status.missing.length > 0) {
      throw new MigrationIntegrityError(status.changed, status.missing);
    }
    const lastApplied = status.applied.map((row) => row.name).sort(byCodePoint).at(-1);
    const pending = files.filter((file) => status.pending.includes(file.name));
    for (const file of pending) {
      if (lastApplied !== undefined && byCodePoint(file.name, lastApplied) < 0) {
        log.warn(`${file.name} sorts before ${lastApplied}, which is already applied; applying it now`);
      }
    }
    const report: MigrationReport = { dryRun, applied: [], alreadyApplied: status.applied.length };
    if (pending.length === 0) {
      log.info(`nothing to apply (${status.applied.length} applied)`);
      return report;
    }

    if (dryRun) {
      await client.query(begin);
      try {
        await ensureLedger(client);
        for (const file of pending) {
          const durationMs = await runFile(client, file);
          report.applied.push({ name: file.name, sha256: file.sha256, durationMs });
          log.info(`dry run: ${file.name} ran in ${durationMs} ms`);
        }
      } finally {
        await client.query('ROLLBACK');
      }
      log.info(`dry run: ${pending.length} file(s) would be applied; everything was rolled back`);
      return report;
    }

    for (const file of pending) {
      await client.query(begin);
      try {
        const durationMs = await runFile(client, file);
        await client.query('COMMIT');
        report.applied.push({ name: file.name, sha256: file.sha256, durationMs });
        log.info(`applied ${file.name} in ${durationMs} ms`);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
    return report;
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]);
    } finally {
      await client.end();
    }
  }
}
