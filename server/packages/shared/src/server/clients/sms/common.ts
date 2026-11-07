import type { SmsProviderName } from '../../../appConfig.js';
import { SmsError } from '../sms.js';
import { bodySnippet } from '../http.js';

/** Helpers the SMS adapters share. */

/** `+989121234567` → `09121234567`: the national form the +98 gateways expect. */
export function nationalIr(e164: string): string | null {
  return /^\+989[0-9]{9}$/.test(e164) ? `0${e164.slice(3)}` : null;
}

/** Network failures and timeouts: the provider could not be asked, so another one may work. */
export function unreachable(provider: SmsProviderName, error: unknown): SmsError {
  const reason = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timed out' : 'unreachable';
  return new SmsError(provider, 'unavailable', reason, { cause: error });
}

/** Reads a JSON body; null when it is not JSON. Never throws. */
export async function jsonBody(response: Response): Promise<{ json: unknown; text: string }> {
  const text = await bodySnippet(response, 4_000);
  try {
    return { json: JSON.parse(text) as unknown, text };
  } catch {
    return { json: null, text };
  }
}

/** A short, safe description of a provider answer for logs: never the number, the code or a key. */
export function describe(status: number, detail: string | number | undefined): string {
  return detail === undefined ? `HTTP ${status}` : `HTTP ${status} (${String(detail).slice(0, 120)})`;
}
