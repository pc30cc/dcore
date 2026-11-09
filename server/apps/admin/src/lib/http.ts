import type { FieldIssue } from '@app/shared';
import { runtimeConfig } from './runtimeConfig';

/**
 * One request to the API at the origin `/config.js` names. Errors come back
 * as {@link ApiError}, read from the API's problem documents (RFC 9457): the
 * panel branches on `code`, never on the English `detail`.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly errors: readonly FieldIssue[];
  /** `otp_invalid`: wrong codes left before the account locks. */
  readonly attemptsLeft: number | undefined;
  /** `rate_limited`: seconds until a retry may succeed. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    errors: readonly FieldIssue[] = [],
    extra: { attemptsLeft?: number | undefined; retryAfterSeconds?: number | undefined } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.errors = errors;
    this.attemptsLeft = extra.attemptsLeft;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** An error from a problem document's text (or a status alone when the body is not one). */
export function problemError(status: number, text: string, retryAfterHeader?: string | null): ApiError {
  const headerSeconds = retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : undefined;
  try {
    const body = JSON.parse(text) as { code?: unknown; detail?: unknown; title?: unknown; errors?: unknown; attemptsLeft?: unknown; retryAfterSeconds?: unknown };
    const code = typeof body.code === 'string' ? body.code : `http_${status}`;
    const message = typeof body.detail === 'string' ? body.detail : typeof body.title === 'string' ? body.title : `HTTP ${status}`;
    const errors = Array.isArray(body.errors)
      ? body.errors.filter((e): e is FieldIssue => typeof e === 'object' && e !== null && typeof (e as FieldIssue).pointer === 'string' && typeof (e as FieldIssue).message === 'string')
      : [];
    return new ApiError(status, code, message, errors, {
      attemptsLeft: count(body.attemptsLeft),
      retryAfterSeconds: count(body.retryAfterSeconds) ?? headerSeconds,
    });
  } catch {
    return new ApiError(status, `http_${status}`, `HTTP ${status}`, [], { retryAfterSeconds: headerSeconds });
  }
}

/** Anything thrown, as an ApiError (aborts excepted: callers check {@link isAbort} first). */
export function asApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError(0, 'unexpected', error instanceof Error ? error.message : String(error));
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export type HttpMethod = 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE';

export interface SendOptions {
  method?: HttpMethod;
  body?: unknown;
  /** The admin access token, when the route needs one. */
  token?: string | null | undefined;
  /** The refresh cookie travels only to the sign-in routes (its Path is /v1/admin/auth). */
  withCookie?: boolean;
  signal?: AbortSignal | undefined;
  /** Tests pass their own. */
  fetchFn?: typeof fetch;
}

let defaultFetch: typeof fetch | null = null;

/** Tests route every request of the panel through their own fetch. */
export function setFetchForTests(fn: typeof fetch | null): void {
  defaultFetch = fn;
}

export async function send<T>(path: string, options: SendOptions = {}): Promise<T> {
  const config = runtimeConfig();
  if (!config.ok) throw new ApiError(0, 'not_configured', config.reason);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const fetchFn = options.fetchFn ?? defaultFetch ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(`${config.config.apiOrigin}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      credentials: options.withCookie ? 'include' : 'omit',
      cache: 'no-store',
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ApiError(0, 'unreachable', 'The API could not be reached.');
  }
  const text = await response.text();
  if (!response.ok) throw problemError(response.status, text, response.headers.get('retry-after'));
  return (text === '' ? undefined : JSON.parse(text)) as T;
}
