import pg from 'pg';

/** SQLSTATE codes the code branches on. https://www.postgresql.org/docs/17/errcodes-appendix.html */
export const SqlState = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  notNullViolation: '23502',
  exclusionViolation: '23P01',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
  lockNotAvailable: '55P03',
  queryCanceled: '57014',
  activeSqlTransaction: '25001',
  idleInTransactionSessionTimeout: '25P03',
} as const;

export type SqlStateCode = (typeof SqlState)[keyof typeof SqlState];

export function isDatabaseError(error: unknown): error is pg.DatabaseError {
  return error instanceof pg.DatabaseError;
}

export function hasSqlState(error: unknown, code: SqlStateCode): error is pg.DatabaseError {
  return isDatabaseError(error) && error.code === code;
}

/** Errors after which running the same transaction again may succeed. */
export function isRetryableTransactionError(error: unknown): boolean {
  return hasSqlState(error, SqlState.serializationFailure) || hasSqlState(error, SqlState.deadlockDetected);
}

/** Node and pg connection failures: the server is unreachable, not the statement wrong. */
const UNREACHABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']);
const UNREACHABLE_MESSAGES = [
  'timeout exceeded when trying to connect',
  'connection terminated',
  'connection timeout',
  'cannot use a pool after calling end',
  'client has encountered a connection error',
  'query read timeout',
];

/**
 * Errors that say PostgreSQL (or the pooler) cannot take work right now,
 * whatever the statement: connection failures (class 08, a refused or
 * dropped socket, a pool that could not connect in time), the server
 * shutting down or starting (57P01-57P03) and insufficient resources (class
 * 53, e.g. too many connections). The same statement succeeds once the
 * server is back, so a writer that meets one waits for it and never gives
 * the work up. A statement's own failures (a timeout, a deadlock, a bad
 * value) are not among them.
 */
export function isTransientDatabaseError(error: unknown): boolean {
  if (isDatabaseError(error)) {
    const code = error.code ?? '';
    return code.startsWith('08') || code.startsWith('53') || code === '57P01' || code === '57P02' || code === '57P03';
  }
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === 'string' && UNREACHABLE.has(code)) return true;
  if (error instanceof AggregateError) return error.errors.some((inner) => isTransientDatabaseError(inner));
  const message = error.message.toLowerCase();
  return UNREACHABLE_MESSAGES.some((text) => message.includes(text));
}

/**
 * Errors that say the data itself can never be stored as it is: class 22
 * (data exception: a value out of range, an invalid byte sequence such as
 * NUL in text) and class 23 (integrity constraint violation). Retrying the
 * same row is pointless.
 */
export function isDataError(error: unknown): boolean {
  if (!isDatabaseError(error)) return false;
  const code = error.code ?? '';
  return code.startsWith('22') || code.startsWith('23');
}
