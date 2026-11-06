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
