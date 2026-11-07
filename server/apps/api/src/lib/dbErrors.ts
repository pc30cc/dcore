/**
 * PostgreSQL errors carry the failing row in `detail` ("Failing row contains
 * (...)"), which can hold a push token or a text someone wrote. Errors that
 * leave a request handler are logged, so the account routes pass them
 * through {@link withoutRowData} first: the SQLSTATE, the constraint and
 * the table survive, the values do not.
 */
export interface DbErrorInfo {
  code: string | undefined;
  constraint: string | undefined;
  table: string | undefined;
}

export function dbErrorInfo(error: unknown): DbErrorInfo | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const e = error as { code?: unknown; constraint?: unknown; table?: unknown; severity?: unknown };
  if (typeof e.code !== 'string' || !/^[0-9A-Z]{5}$/.test(e.code) || e.severity === undefined) return undefined;
  return {
    code: e.code,
    constraint: typeof e.constraint === 'string' ? e.constraint : undefined,
    table: typeof e.table === 'string' ? e.table : undefined,
  };
}

export class SanitizedDbError extends Error {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
  readonly table: string | undefined;

  constructor(info: DbErrorInfo) {
    super(`database error ${info.code ?? '?'}${info.constraint ? ` (${info.constraint})` : ''}`);
    this.name = 'SanitizedDbError';
    this.code = info.code;
    this.constraint = info.constraint;
    this.table = info.table;
  }
}

/** The same error without the row values a PostgreSQL error may carry; other errors pass unchanged. */
export function withoutRowData(error: unknown): unknown {
  const info = dbErrorInfo(error);
  return info ? new SanitizedDbError(info) : error;
}

/** Runs `fn`, rethrowing a PostgreSQL error without its row data. */
export async function scrubbed<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw withoutRowData(error);
  }
}
