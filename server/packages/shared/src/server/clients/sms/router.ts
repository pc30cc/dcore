import type { SmsProviderName } from '../../../appConfig.js';
import { SmsError, type OtpMessage, type SmsReceipt, type SmsSender } from '../sms.js';

/**
 * Sends one code through the providers app_config `auth.sms_routing` names
 * for the number, in order: a provider that is down (`unavailable`) hands
 * over to the next; a provider that refuses the number (`rejected`) ends
 * the attempt, since the others would refuse it too. A provider that is not
 * configured in this process is skipped. A call (`channel: "call"`) is
 * tried with the providers that can call, then as an SMS.
 *
 * A provider that just failed as unavailable is skipped for `coolDownMs`
 * (unless it is the last one left), so an outage does not cost every
 * request a timeout.
 */

export interface RoutedSms extends SmsReceipt {
  channel: 'sms' | 'call';
  /** The providers that failed before this one, in order. */
  failedOver: SmsProviderName[];
}

export class SmsRoutingError extends Error {
  /** `rejected`: the number is refused (phone_invalid); `unavailable`: nobody could send (sms_unavailable). */
  readonly kind: 'rejected' | 'unavailable';
  readonly attempts: readonly { provider: SmsProviderName; reason: string }[];

  constructor(kind: 'rejected' | 'unavailable', attempts: readonly { provider: SmsProviderName; reason: string }[]) {
    super(`sms ${kind}: ${attempts.map((a) => `${a.provider} ${a.reason}`).join('; ') || 'no provider configured'}`);
    this.name = 'SmsRoutingError';
    this.kind = kind;
    this.attempts = attempts;
  }
}

export interface SmsRouterOptions {
  coolDownMs?: number | undefined;
  now?: (() => number) | undefined;
  /**
   * Development only: the sender used when none of a number's providers is
   * configured in this process (the `fake` one), so a machine without
   * provider keys still signs in.
   */
  fallback?: SmsSender | undefined;
}

export class SmsRouter {
  private readonly senders: ReadonlyMap<SmsProviderName, SmsSender>;
  private readonly coolDownMs: number;
  private readonly now: () => number;
  private readonly downUntil = new Map<SmsProviderName, number>();
  private readonly fallback: SmsSender | undefined;

  constructor(senders: Iterable<SmsSender>, options: SmsRouterOptions = {}) {
    this.senders = new Map([...senders].map((sender) => [sender.name, sender]));
    this.coolDownMs = options.coolDownMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.fallback = options.fallback;
  }

  /** The providers configured in this process. */
  get configured(): SmsProviderName[] {
    return [...this.senders.keys()];
  }

  has(name: SmsProviderName): boolean {
    return this.senders.has(name);
  }

  async send(providers: readonly SmsProviderName[], message: OtpMessage): Promise<RoutedSms> {
    const attempts: { provider: SmsProviderName; reason: string }[] = [];
    const configured = providers.map((name) => this.senders.get(name)).filter((sender): sender is SmsSender => sender !== undefined);
    const available = configured.length === 0 && this.fallback ? [this.fallback] : configured;
    const passes: ('sms' | 'call')[] = message.channel === 'call' ? ['call', 'sms'] : ['sms'];
    for (const channel of passes) {
      const candidates = available.filter((sender) => sender.channels.includes(channel));
      const now = this.now();
      const fresh = candidates.filter((sender) => (this.downUntil.get(sender.name) ?? 0) <= now);
      // Every one cooling down: try them anyway rather than refuse outright.
      const order = fresh.length > 0 ? fresh : candidates;
      for (const sender of order) {
        try {
          const receipt = await sender.send({ ...message, channel });
          this.downUntil.delete(sender.name);
          return { ...receipt, channel, failedOver: attempts.map((a) => a.provider) };
        } catch (error) {
          const smsError = error instanceof SmsError ? error : new SmsError(sender.name, 'unavailable', 'failed', { cause: error });
          attempts.push({ provider: sender.name, reason: smsError.message });
          if (smsError.kind === 'rejected') throw new SmsRoutingError('rejected', attempts);
          this.downUntil.set(sender.name, this.now() + this.coolDownMs);
        }
      }
    }
    throw new SmsRoutingError('unavailable', attempts);
  }
}

/**
 * Development only: writes the code to the log instead of sending it, with
 * the number shortened to its last two digits. Never configured in
 * production (the API refuses it there).
 */
export class LoggingSmsSender implements SmsSender {
  readonly name = 'fake' as const;
  readonly channels = ['sms', 'call'] as const;
  private readonly log: (line: string) => void;
  private count = 0;

  constructor(log: (line: string) => void) {
    this.log = log;
  }

  async send(message: OtpMessage): Promise<SmsReceipt> {
    this.count += 1;
    this.log(`development code for …${message.phone.slice(-2)}: ${message.code}`);
    return { provider: this.name, messageId: `log-${this.count}` };
  }
}
