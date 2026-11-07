import { SmsError, type OtpMessage, type SmsReceipt, type SmsSender } from '../sms.js';
import { defaultFetch, fetchWithTimeout, type Fetch } from '../http.js';
import { describe, jsonBody, unreachable } from './common.js';

/**
 * Telnyx Verify (`POST /v2/verifications/sms` or `/call`, bearer key). The
 * code is ours (`custom_code`): Telnyx delivers it and we check it, like
 * every other provider; Telnyx's own check endpoint is never used. The
 * verify profile (`SMS_TELNYX_VERIFY_PROFILE_ID`) holds the message
 * template and the app's name.
 *
 * Errors: 400/422 that point at `phone_number` are a number Telnyx refuses
 * (`rejected`); everything else (key, profile, throttling, server) makes the
 * next provider worth trying.
 */

export interface TelnyxOptions {
  apiKey: string;
  verifyProfileId: string;
  /** How long Telnyx keeps the verification (the challenge's lifetime). */
  timeoutSeconds?: number | undefined;
  fetch?: Fetch | undefined;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
}

interface TelnyxError {
  code?: unknown;
  source?: { pointer?: unknown } | undefined;
}

export class TelnyxSender implements SmsSender {
  readonly name = 'telnyx' as const;
  readonly channels = ['sms', 'call'] as const;
  private readonly options: TelnyxOptions;
  private readonly fetchFn: Fetch;

  constructor(options: TelnyxOptions) {
    if (!/^[A-Za-z0-9_=-]{8,300}$/.test(options.apiKey)) throw new Error('SMS_TELNYX_API_KEY is malformed');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(options.verifyProfileId)) throw new Error('SMS_TELNYX_VERIFY_PROFILE_ID is malformed');
    this.options = options;
    this.fetchFn = options.fetch ?? defaultFetch;
  }

  async send(message: OtpMessage): Promise<SmsReceipt> {
    const base = (this.options.baseUrl ?? 'https://api.telnyx.com').replace(/\/+$/, '');
    const path = message.channel === 'call' ? 'call' : 'sms';
    const body: Record<string, unknown> = {
      phone_number: message.phone,
      verify_profile_id: this.options.verifyProfileId,
      custom_code: message.code,
    };
    if (this.options.timeoutSeconds !== undefined) body['timeout_secs'] = this.options.timeoutSeconds;
    let response: Response;
    try {
      response = await fetchWithTimeout(
        this.fetchFn,
        `${base}/v2/verifications/${path}`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        },
        this.options.timeoutMs ?? 5_000,
      );
    } catch (error) {
      throw unreachable(this.name, error);
    }
    const { json } = await jsonBody(response);
    if (response.ok) {
      const id = (json as { data?: { id?: unknown } } | null)?.data?.id;
      return { provider: this.name, messageId: typeof id === 'string' ? id : undefined };
    }
    const errors = ((json as { errors?: TelnyxError[] } | null)?.errors ?? []).filter((e) => e && typeof e === 'object');
    const aboutNumber = errors.some((e) => typeof e.source?.pointer === 'string' && e.source.pointer.includes('phone_number'));
    const kind = (response.status === 400 || response.status === 422) && aboutNumber ? 'rejected' : 'unavailable';
    const code = errors.find((e) => typeof e.code === 'string' || typeof e.code === 'number')?.code as string | number | undefined;
    throw new SmsError(this.name, kind, describe(response.status, code));
  }
}
