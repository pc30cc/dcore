/**
 * The one HTTP seam of the provider clients: each takes a `fetch` (the
 * global one by default), so tests point them at a local fake server or a
 * stub and no test ever reaches a real provider.
 */
export type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const defaultFetch: Fetch = (input, init) => fetch(input, init);

/** Reads at most `limit` characters of a body for an error message; never throws. */
export async function bodySnippet(response: Response, limit = 300): Promise<string> {
  try {
    return (await response.text()).slice(0, limit);
  } catch {
    return '';
  }
}

/** A provider call that failed: `retryable` says whether trying again later may succeed. */
export class ProviderError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(provider: string, message: string, options: { status?: number; retryable: boolean; cause?: unknown }) {
    super(`${provider}: ${message}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = options.status ?? 0;
    this.retryable = options.retryable;
  }
}

/** 408, 429 and 5xx are worth another try; other statuses are not. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** fetch with a deadline. */
export async function fetchWithTimeout(fetchFn: Fetch, url: string | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
