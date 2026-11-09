import type { FieldIssue } from '@app/shared';
import { runtimeConfig } from './runtimeConfig';
import { accessToken } from './session';

/**
 * Calls to the admin API, at the origin `/config.js` names, with the admin's
 * access token. Errors come back as {@link ApiError}, read from the API's
 * problem documents (RFC 9457): the panel branches on `code`.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly errors: readonly FieldIssue[];

  constructor(status: number, code: string, message: string, errors: readonly FieldIssue[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.errors = errors;
  }
}

/** An error from a problem document's text (or a status alone when the body is not one). */
export function problemError(status: number, text: string): ApiError {
  try {
    const body = JSON.parse(text) as { code?: unknown; detail?: unknown; title?: unknown; errors?: unknown };
    const code = typeof body.code === 'string' ? body.code : `http_${status}`;
    const message = typeof body.detail === 'string' ? body.detail : typeof body.title === 'string' ? body.title : `HTTP ${status}`;
    const errors = Array.isArray(body.errors)
      ? body.errors.filter((e): e is FieldIssue => typeof e === 'object' && e !== null && typeof (e as FieldIssue).pointer === 'string' && typeof (e as FieldIssue).message === 'string')
      : [];
    return new ApiError(status, code, message, errors);
  } catch {
    return new ApiError(status, `http_${status}`, `HTTP ${status}`);
  }
}

export interface RequestOptions {
  method?: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal | undefined;
  /** Tests pass their own. */
  fetchFn?: typeof fetch;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const config = runtimeConfig();
  if (!config.ok) throw new ApiError(0, 'not_configured', config.reason);
  const token = accessToken();
  if (!token) throw new ApiError(401, 'unauthorized', 'Not signed in.');
  const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await (options.fetchFn ?? fetch)(`${config.config.apiOrigin}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      credentials: 'omit',
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'unreachable', 'The API could not be reached.');
  }
  const text = await response.text();
  if (!response.ok) throw problemError(response.status, text);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}
