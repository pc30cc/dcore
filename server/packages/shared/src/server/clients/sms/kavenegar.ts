import { SmsError, type OtpMessage, type SmsReceipt, type SmsSender } from '../sms.js';
import { defaultFetch, fetchWithTimeout, type Fetch } from '../http.js';
import { describe, jsonBody, nationalIr, unreachable } from './common.js';

/**
 * Kavenegar's Verify Lookup (`/v1/<api key>/verify/lookup.json`): a
 * template stored in the Kavenegar panel, with our code as `token`. The
 * template's text names the app; for the play build's SMS Retriever it ends
 * with the build's app hash, which is fixed per signing key, so it is part
 * of the template rather than of each request. `type=call` reads the code
 * out in a voice call.
 *
 * The API key is part of the URL path: the URL never leaves this module
 * (errors name the status only).
 *
 * Kavenegar answers `{"return": {"status", "message"}, "entries": [...]}`
 * with the same status as HTTP. 200 is sent; 411 is a receptor it refuses
 * (another provider will refuse it too); every other status (credit,
 * template, key, IP restriction, throttling, server) makes the next
 * provider worth trying.
 */

export interface KavenegarOptions {
  apiKey: string;
  /** The template's name in the Kavenegar panel (`SMS_KAVENEGAR_TEMPLATE`). */
  template: string;
  fetch?: Fetch | undefined;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
}

const REJECTED = new Set([411]);

export class KavenegarSender implements SmsSender {
  readonly name = 'kavenegar' as const;
  readonly channels = ['sms', 'call'] as const;
  private readonly options: KavenegarOptions;
  private readonly fetchFn: Fetch;

  constructor(options: KavenegarOptions) {
    if (!/^[A-Za-z0-9+/=_-]{8,200}$/.test(options.apiKey)) throw new Error('SMS_KAVENEGAR_API_KEY is malformed');
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(options.template)) throw new Error('SMS_KAVENEGAR_TEMPLATE must be a template name');
    this.options = options;
    this.fetchFn = options.fetch ?? defaultFetch;
  }

  async send(message: OtpMessage): Promise<SmsReceipt> {
    const receptor = nationalIr(message.phone);
    // The +98 gateway: a number elsewhere goes to the next provider.
    if (receptor === null) throw new SmsError(this.name, 'unavailable', 'serves +98 mobile numbers only');
    const base = (this.options.baseUrl ?? 'https://api.kavenegar.com').replace(/\/+$/, '');
    const url = `${base}/v1/${encodeURIComponent(this.options.apiKey)}/verify/lookup.json`;
    const form = new URLSearchParams({ receptor, token: message.code, template: this.options.template });
    if (message.channel === 'call') form.set('type', 'call');
    let response: Response;
    try {
      response = await fetchWithTimeout(
        this.fetchFn,
        url,
        { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString() },
        this.options.timeoutMs ?? 5_000,
      );
    } catch (error) {
      throw unreachable(this.name, error);
    }
    const { json } = await jsonBody(response);
    const ret = (json as { return?: { status?: unknown } } | null)?.return;
    const status = typeof ret?.status === 'number' ? ret.status : response.status;
    if (response.ok && status === 200) {
      const entry = (json as { entries?: { messageid?: unknown }[] }).entries?.[0];
      const id = entry?.messageid;
      return { provider: this.name, messageId: typeof id === 'number' || typeof id === 'string' ? String(id) : undefined };
    }
    throw new SmsError(this.name, REJECTED.has(status) ? 'rejected' : 'unavailable', describe(response.status, status));
  }
}
