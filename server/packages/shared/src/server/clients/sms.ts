import type { SmsProviderName } from '../../appConfig.js';

/**
 * Sending one-time codes. The API makes the code, keeps only its HMAC in
 * Valkey and hands the code to a provider; which provider serves a number
 * is app_config `auth.sms_routing` (by prefix, in order, the next one tried
 * when one is unavailable). The text is neutral: the code and the app's
 * name only.
 *
 * The providers (Kavenegar, sms.ir, Telnyx) implement this interface; the
 * fake records codes so tests can read them back.
 */

export interface OtpMessage {
  /** E.164. */
  phone: string;
  code: string;
  /** The app's name in the person's language, for the template. */
  appName: string;
  locale: string;
  channel: 'sms' | 'call';
  /** The SMS Retriever hash of the play build, appended to the text when given. */
  appHash?: string | undefined;
}

export interface SmsReceipt {
  provider: SmsProviderName;
  /** The provider's message id, when it gives one. */
  messageId?: string | undefined;
}

/**
 * Why a send failed. `unavailable`: the provider is down, out of credit or
 * throttling (try the next provider; the client gets `sms_unavailable` when
 * none is left). `rejected`: the provider refuses this number (invalid, not
 * reachable): trying another provider will not help (`phone_invalid`).
 */
export class SmsError extends Error {
  readonly provider: SmsProviderName;
  readonly kind: 'unavailable' | 'rejected';

  constructor(provider: SmsProviderName, kind: 'unavailable' | 'rejected', message: string, options?: ErrorOptions) {
    super(`${provider}: ${message}`, options);
    this.name = 'SmsError';
    this.provider = provider;
    this.kind = kind;
  }
}

export interface SmsSender {
  readonly name: SmsProviderName;
  /** Which channels the provider can send through. */
  readonly channels: readonly ('sms' | 'call')[];
  send(message: OtpMessage): Promise<SmsReceipt>;
}

/**
 * Keeps codes in memory instead of sending them. `fail` makes the next sends
 * fail the given way; `codeFor` reads back what a number was sent.
 */
export class FakeSmsSender implements SmsSender {
  readonly name: SmsProviderName;
  readonly channels: readonly ('sms' | 'call')[] = ['sms', 'call'];
  readonly sent: OtpMessage[] = [];
  fail: 'unavailable' | 'rejected' | null = null;

  constructor(name: SmsProviderName = 'fake') {
    this.name = name;
  }

  async send(message: OtpMessage): Promise<SmsReceipt> {
    if (this.fail) throw new SmsError(this.name, this.fail, `fake ${this.fail}`);
    this.sent.push(message);
    return { provider: this.name, messageId: `fake-${this.sent.length}` };
  }

  /** The last code sent to `phone`, or undefined. */
  codeFor(phone: string): string | undefined {
    return this.sent.findLast((m) => m.phone === phone)?.code;
  }
}
