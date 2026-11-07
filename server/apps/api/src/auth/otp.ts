import { otpPrefixCap, smsProvidersFor, type OtpChallenge } from '@app/shared';
import { LimitUnavailableError, SmsRoutingError, hashDomains, ipRateKey, type Limit, type OtpPurpose } from '@app/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpProblem } from '../lib/problem.js';

/**
 * Starting and checking one-time codes, for signing in and for adding a
 * phone to an account. No PostgreSQL on either path: the challenge, the
 * code's HMAC and every limit live in Valkey, and every limit fails closed
 * (Valkey down: no code is sent and none is accepted).
 *
 * Limits on a start, all counted together or not at all (app_config
 * `auth.otp_caps`): the resend wait and a daily count per number, an hourly
 * count per IP (IPv6 per /56), a daily count per install (when the app
 * names it), and an hourly count per country prefix (the longest listed
 * one; unlisted prefixes share `default`). When nothing could be sent they
 * are given back, except the IP's.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DIGITS = new Map<string, string>([...'۰۱۲۳۴۵۶۷۸۹', ...'٠١٢٣٤٥٦٧٨٩'].map((d, i): [string, string] => [d, String(i % 10)]));

/**
 * The number as E.164, or null. Spaces, dashes, dots and brackets are
 * dropped and Persian or Arabic digits read as digits; +98 numbers must be
 * mobile numbers (the only ones that take an SMS there).
 */
export function normalizePhone(input: string): string | null {
  if (input.length > 40) return null;
  const compact = input.replace(/[\s‌‎‏().-]/g, '').replace(/[۰-۹٠-٩]/g, (d) => DIGITS.get(d) ?? d);
  const e164 = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  if (!/^\+[1-9][0-9]{7,14}$/.test(e164)) return null;
  if (e164.startsWith('+98') && !/^\+989[0-9]{9}$/.test(e164)) return null;
  return e164;
}

/** The address limits count by: the client's IP (an IPv6 /56), as a key segment. */
export function ipSegment(request: FastifyRequest): string {
  return ipRateKey(request.clientIp ?? request.ip).replaceAll('/', '_');
}

function utcHour(now: number): string {
  return new Date(now).toISOString().slice(0, 13).replace(/[-T]/g, '');
}

function rateLimited(retryAfterMs: number, detail?: string): HttpProblem {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1_000));
  return new HttpProblem('rate_limited', { detail, retryAfterSeconds, headers: { 'retry-after': String(retryAfterSeconds) } });
}

export interface StartInput {
  phone: string;
  channel?: 'sms' | 'call' | undefined;
  locale: string;
  smsAppHash?: string | undefined;
  installId?: string | undefined;
  purpose: OtpPurpose;
}

/** Sends a code (or, for a review account, makes a challenge with none to send). */
export async function startOtp(app: FastifyInstance, request: FastifyRequest, input: StartInput): Promise<OtpChallenge> {
  const e164 = normalizePhone(input.phone);
  if (e164 === null) throw new HttpProblem('phone_invalid');
  const settings = app.authSettings.get();
  const phoneHash = app.otp.phoneKeyHash(e164);
  // Store reviewers' accounts sign in whatever the routing says: nothing is sent to them.
  const review = input.purpose === 'signin' ? settings.reviewAccounts.find((a) => a.phone_hash === phoneHash) : undefined;
  const providers = smsProvidersFor(settings.routing, e164);
  if (providers.length === 0 && !review) throw new HttpProblem('phone_not_allowed');
  const { caps, otp } = settings;
  const now = Date.now();
  const prefix = otpPrefixCap(caps, e164);
  const limits: Limit[] = [
    { name: 'resend_wait', key: app.keys.otpResendWait(phoneHash), cap: 1, windowMs: caps.resend_seconds * 1_000 },
    { name: 'ip_hourly', key: app.keys.otpIpLimit(ipSegment(request)), cap: caps.ip_hourly, windowMs: HOUR_MS },
  ];
  if (!review) {
    limits.push({ name: 'phone_daily', key: app.keys.otpPhoneLimit(phoneHash), cap: caps.phone_daily, windowMs: DAY_MS });
    limits.push({ name: 'prefix_hourly', key: app.keys.otpPrefixLimit(prefix.prefix, utcHour(now)), cap: prefix.cap, windowMs: HOUR_MS + 60_000 });
  }
  if (input.installId) {
    limits.push({ name: 'install_daily', key: app.keys.otpInstallLimit(input.installId), cap: caps.install_daily, windowMs: DAY_MS });
  }

  let challenge;
  try {
    // A refused number (age or a ban) is answered like any other here: a
    // different answer would tell anyone which numbers are refused. Its code
    // is sent, and otp/verify refuses it from device_bans, to its holder only.
    const verdict = await app.limits.take(limits);
    if (!verdict.ok) {
      request.log.info({ limit: verdict.limit.name }, 'otp start refused by a limit');
      throw rateLimited(verdict.retryAfterMs);
    }
    challenge = await app.otp.issue({ e164, purpose: input.purpose, length: otp.length, ttlSeconds: otp.ttl_seconds, reviewHash: review?.otp_hash });
  } catch (error) {
    if (error instanceof HttpProblem || error instanceof TypeError || error instanceof RangeError) throw error;
    // LimitUnavailableError (Valkey): fail closed.
    request.log.error({ err: error, limitsDown: error instanceof LimitUnavailableError }, 'otp start: Valkey unavailable, refused');
    throw new HttpProblem('sms_unavailable', { detail: 'Codes cannot be sent right now.', headers: { 'retry-after': '30' }, cause: error });
  }

  let channel: 'sms' | 'call' = input.channel ?? 'sms';
  if (challenge.code !== null) {
    try {
      const sent = await app.sms.send(providers, {
        phone: e164,
        code: challenge.code,
        appName: '',
        locale: input.locale,
        channel,
        appHash: input.smsAppHash,
      });
      channel = sent.channel;
      request.log.info({ provider: sent.provider, channel, failedOver: sent.failedOver }, 'otp sent');
    } catch (error) {
      await app.otp.discard(e164, challenge.challengeId);
      // Nothing went out: give the number's and the prefix's counts back (not the IP's).
      await app.limits.refund(limits.filter((l) => l.name !== 'ip_hourly').map((l) => l.key));
      if (error instanceof SmsRoutingError) {
        request.log.warn({ attempts: error.attempts }, `otp not sent: ${error.kind}`);
        throw error.kind === 'rejected' ? new HttpProblem('phone_invalid') : new HttpProblem('sms_unavailable', { headers: { 'retry-after': '30' } });
      }
      throw error;
    }
  } else {
    request.log.info('otp challenge for a review account (nothing sent)');
  }
  return {
    challengeId: challenge.challengeId,
    codeLength: otp.length,
    ttlSeconds: otp.ttl_seconds,
    resendAfterSeconds: caps.resend_seconds,
    channel,
  };
}

/**
 * Checks a code; returns the number it was sent to. 5 wrong codes (app_config
 * `auth.otp.max_attempts`) end the challenge; every attempt counts against
 * the IP's hourly verify limit.
 */
export async function verifyOtp(
  app: FastifyInstance,
  request: FastifyRequest,
  input: { challengeId: string; code: string; purpose: OtpPurpose },
): Promise<{ e164: string; review: boolean }> {
  const settings = app.authSettings.get();
  const ipLimit: Limit = { name: 'verify_ip_hourly', key: app.keys.otpVerifyIpLimit(ipSegment(request)), cap: settings.caps.verify_ip_hourly, windowMs: HOUR_MS };
  let check;
  try {
    const phoneHash = await app.otp.phoneHashOf(input.challengeId);
    if (phoneHash === null) {
      const verdict = await app.limits.take([ipLimit]);
      if (!verdict.ok) throw rateLimited(verdict.retryAfterMs);
      throw new HttpProblem('otp_expired');
    }
    check = await app.otp.verify({
      challengeId: input.challengeId,
      phoneHash,
      purpose: input.purpose,
      code: input.code,
      maxAttempts: settings.otp.max_attempts,
      ipKey: ipLimit.key,
      ipCap: ipLimit.cap,
      ipWindowMs: ipLimit.windowMs,
    });
  } catch (error) {
    if (error instanceof HttpProblem) throw error;
    request.log.error({ err: error }, 'otp verify: Valkey unavailable, refused');
    throw new HttpProblem('service_unavailable', { detail: 'Codes cannot be checked right now.', headers: { 'retry-after': '30' }, cause: error });
  }
  switch (check.outcome) {
    case 'ok':
      return { e164: check.phone, review: check.review };
    case 'wrong':
      throw new HttpProblem('otp_invalid', { extensions: { attemptsLeft: check.attemptsLeft } });
    case 'locked':
      throw new HttpProblem('otp_locked');
    case 'ip_limited':
      throw rateLimited(check.retryAfterMs);
    default:
      throw new HttpProblem('otp_expired');
  }
}

/** The keyed hashes of a number under every pepper (current first), for lookups and bans. */
export function phoneHashes(app: FastifyInstance, e164: string) {
  return app.secrets.hasher.hashAll(hashDomains.phone, e164);
}
