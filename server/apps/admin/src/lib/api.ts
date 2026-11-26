import { refreshSession } from './auth';
import { ApiError, send, sendBlob, type HttpMethod } from './http';
import { accessToken, sessionState } from './session';

/**
 * Calls to the admin API with the signed-in admin's access token. A token
 * about to run out is renewed first (one refresh for every caller at once);
 * a 401 is retried once after a refresh, since the token may have been
 * revoked or rotated meanwhile. When the refresh cookie is refused too, the
 * session is over: the state turns `expired` and the panel asks to sign in.
 */

export { ApiError, asApiError, isAbort, problemError } from './http';

export interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  signal?: AbortSignal | undefined;
  /** Tests pass their own. */
  fetchFn?: typeof fetch;
}

function sessionOver(): ApiError {
  return new ApiError(401, sessionState().status === 'expired' ? 'session_expired' : 'unauthorized', 'Sign in again.');
}

async function currentToken(): Promise<string> {
  const held = accessToken();
  if (held) return held;
  if (!(await refreshSession())) throw sessionOver();
  const renewed = accessToken();
  if (!renewed) throw sessionOver();
  return renewed;
}

/** Runs `call` with the admin's access token; a 401 is retried once after a refresh. */
async function withAccessToken<T>(call: (token: string) => Promise<T>): Promise<T> {
  const token = await currentToken();
  try {
    return await call(token);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    if (!(await refreshSession())) throw sessionOver();
    const renewed = accessToken();
    if (!renewed) throw sessionOver();
    return call(renewed);
  }
}

function sendOptions(token: string, options: RequestOptions) {
  return {
    token,
    ...(options.method ? { method: options.method } : {}),
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  };
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return withAccessToken((token) => send<T>(path, sendOptions(token, options)));
}

/** A file the API answers (an export), as {@link apiRequest} sends it. */
export async function apiFile(path: string, options: RequestOptions = {}): Promise<Blob> {
  return withAccessToken((token) => sendBlob(path, sendOptions(token, options)));
}
