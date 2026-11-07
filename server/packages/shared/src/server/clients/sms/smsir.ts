import { SmsError, type OtpMessage, type SmsReceipt, type SmsSender } from '../sms.js';
import { defaultFetch, fetchWithTimeout, type Fetch } from '../http.js';
import { describe, jsonBody, nationalIr, unreachable } from './common.js';

/**
 * sms.ir's verify API (`POST /v1/send/verify`, key in `X-API-KEY`): a
 * template approved in the sms.ir panel, identified by its numeric id, with
 * our code as one named parameter (`SMS_SMSIR_PARAMETER`, `CODE` unless
 * set). As with the other gateways, the template's own text names the app
 * and carries the play build's fixed SMS Retriever hash.
 *
 * sms.ir answers `{"status": 1, "message", "data": {"messageId", "cost"}}`
 * on success. Its other status numbers are not mapped one by one: every
 * failure makes the next provider worth trying (`unavailable`), which is
 * the safe reading (the number itself was validated before).
 */

export interface SmsIrOptions {
  apiKey: string;
  templateId: number;
  /** The template's parameter that takes the code. */
  parameter?: string | undefined;
  fetch?: Fetch | undefined;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
}

export class SmsIrSender implements SmsSender {
  readonly name = 'smsir' as const;
  readonly channels = ['sms'] as const;
  private readonly options: SmsIrOptions;
  private readonly fetchFn: Fetch;

  constructor(options: SmsIrOptions) {
    if (!/^[A-Za-z0-9+/=_-]{8,200}$/.test(options.apiKey)) throw new Error('SMS_SMSIR_API_KEY is malformed');
    if (!Number.isInteger(options.templateId) || options.templateId <= 0) throw new Error('SMS_SMSIR_TEMPLATE_ID must be a positive integer');
    if (options.parameter !== undefined && !/^[A-Za-z0-9_]{1,40}$/.test(options.parameter)) throw new Error('SMS_SMSIR_PARAMETER must be a parameter name');
    this.options = options;
    this.fetchFn = options.fetch ?? defaultFetch;
  }

  async send(message: OtpMessage): Promise<SmsReceipt> {
    const mobile = nationalIr(message.phone);
    if (mobile === null) throw new SmsError(this.name, 'unavailable', 'serves +98 mobile numbers only');
    if (message.channel === 'call') throw new SmsError(this.name, 'unavailable', 'no voice channel');
    const base = (this.options.baseUrl ?? 'https://api.sms.ir').replace(/\/+$/, '');
    const body = {
      mobile,
      templateId: this.options.templateId,
      parameters: [{ name: this.options.parameter ?? 'CODE', value: message.code }],
    };
    let response: Response;
    try {
      response = await fetchWithTimeout(
        this.fetchFn,
        `${base}/v1/send/verify`,
        {
          method: 'POST',
          headers: { 'x-api-key': this.options.apiKey, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        },
        this.options.timeoutMs ?? 5_000,
      );
    } catch (error) {
      throw unreachable(this.name, error);
    }
    const { json } = await jsonBody(response);
    const answer = json as { status?: unknown; data?: { messageId?: unknown } } | null;
    if (response.ok && answer?.status === 1) {
      const id = answer.data?.messageId;
      return { provider: this.name, messageId: typeof id === 'number' || typeof id === 'string' ? String(id) : undefined };
    }
    throw new SmsError(this.name, 'unavailable', describe(response.status, typeof answer?.status === 'number' ? answer.status : undefined));
  }
}
