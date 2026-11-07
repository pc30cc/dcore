import { randomInt } from 'node:crypto';
import type { Redis } from 'ioredis';
import { hashDomains, randomToken, type DataSealer, type KeyedHasher } from '../crypto/index.js';
import type { KeyBuilder } from '../kv/keys.js';
import { luaScript, runScript } from '../kv/scripts.js';
import { LimitUnavailableError } from './limits.js';

/**
 * One-time codes in Valkey. A challenge is `otp:<phoneHash>` (one live
 * challenge per number: a new one replaces it) holding the HMAC of the
 * code bound to the challenge id (never the code), the wrong attempts so
 * far, the code length, the number sealed with AES-GCM (so the sign-in can
 * store it without the client sending it twice, and a Valkey dump yields no
 * number), and what the challenge is for. `otp:c:<challengeId>` points
 * from the id the client holds to the number's hash. Both expire with the
 * challenge; a correct code deletes both, and so does the last allowed
 * wrong code.
 *
 * Review accounts (app_config `auth.review_accounts`) get a challenge whose
 * HMAC is their fixed code's (`review:<code>` under the OTP domain), and no
 * message is sent. Their code never changes and their numbers are handed
 * out, so their wrong codes are also counted per number and day
 * (`otp:rl:rv:<phoneHash>`): at {@link REVIEW_WRONG_DAILY} the number is
 * locked until the day ends, the right code included.
 *
 * Every call fails closed: when Valkey cannot be asked,
 * {@link LimitUnavailableError} is thrown.
 */

const issueScript = luaScript(new URL('./otpIssue.lua', import.meta.url), 'otp-issue', 2);
const verifyScript = luaScript(new URL('./otpVerify.lua', import.meta.url), 'otp-verify', 4);

/** Wrong codes a review number takes in a day before it is locked for the rest of it. */
export const REVIEW_WRONG_DAILY = 10;
const REVIEW_WRONG_WINDOW_MS = 86_400_000;

/** What a challenge may be used for: signing in, the web deletion page, or adding a number to an account (`phone:<user id>`). */
export type OtpPurpose = 'signin' | 'deletion' | `phone:${string}`;

const SEALED_PURPOSE = 'otp.phone';

/** A numeric code of `length` digits, uniformly drawn. */
export function otpCode(length: number): string {
  if (!Number.isInteger(length) || length < 4 || length > 8) throw new RangeError('codes have 4 to 8 digits');
  return String(randomInt(0, 10 ** length)).padStart(length, '0');
}

/** The HMAC a review account's fixed code is stored as (app_config `auth.review_accounts[].otp_hash`). */
export function reviewCodeHash(hasher: KeyedHasher, code: string): string {
  return hasher.hex(hashDomains.otp, `review:${code}`);
}

export interface IssuedChallenge {
  challengeId: string;
  /** The code to send; null for a review account (nothing is sent). */
  code: string | null;
}

export type OtpCheck =
  | { outcome: 'ok'; phone: string; review: boolean }
  | { outcome: 'wrong'; attemptsLeft: number }
  | { outcome: 'locked' }
  | { outcome: 'missing' }
  | { outcome: 'ip_limited'; retryAfterMs: number };

export interface OtpStoreOptions {
  redis: Redis;
  keys: KeyBuilder;
  hasher: KeyedHasher;
  sealer: DataSealer;
}

export class OtpStore {
  private readonly redis: Redis;
  private readonly keys: KeyBuilder;
  private readonly hasher: KeyedHasher;
  private readonly sealer: DataSealer;

  constructor(options: OtpStoreOptions) {
    this.redis = options.redis;
    this.keys = options.keys;
    this.hasher = options.hasher;
    this.sealer = options.sealer;
  }

  /** The Valkey form of a number's hash (current pepper, hex). */
  phoneKeyHash(e164: string): string {
    return this.hasher.hex(hashDomains.phone, e164);
  }

  /**
   * Starts a challenge for `e164`. `reviewHash` (a review account's stored
   * code HMAC) makes it a review challenge with no code to send.
   */
  async issue(input: { e164: string; purpose: OtpPurpose; length: number; ttlSeconds: number; reviewHash?: string | undefined }): Promise<IssuedChallenge> {
    const challengeId = randomToken(18);
    const code = input.reviewHash === undefined ? otpCode(input.length) : null;
    const hash = input.reviewHash ?? this.codeHash(challengeId, code ?? '');
    const phoneHash = this.phoneKeyHash(input.e164);
    const sealed = this.sealer.seal(input.e164, SEALED_PURPOSE).toString('base64');
    try {
      await runScript(this.redis, issueScript, [this.keys.otp(phoneHash), this.keys.otpChallenge(challengeId)], [
        challengeId,
        hash,
        input.length,
        sealed,
        input.purpose,
        input.reviewHash === undefined ? 0 : 1,
        input.ttlSeconds * 1_000,
        phoneHash,
      ]);
    } catch (error) {
      throw new LimitUnavailableError({ cause: error });
    }
    return { challengeId, code };
  }

  /** Drops a challenge that could not be delivered. */
  async discard(e164: string, challengeId: string): Promise<void> {
    await this.redis.del(this.keys.otp(this.phoneKeyHash(e164)), this.keys.otpChallenge(challengeId)).catch(() => undefined);
  }

  /** The number's hash a challenge id points at, or null when it is unknown or expired. */
  async phoneHashOf(challengeId: string): Promise<string | null> {
    try {
      return await this.redis.get(this.keys.otpChallenge(challengeId));
    } catch (error) {
      throw new LimitUnavailableError({ cause: error });
    }
  }

  /**
   * Checks `code` for a challenge. Counts the attempt against the caller's
   * IP limit (`ipKey`, `ipCap` per `ipWindowMs`) first; `maxAttempts` wrong
   * codes end the challenge, and a review number's daily wrong codes lock it.
   */
  async verify(input: {
    challengeId: string;
    phoneHash: string;
    purpose: OtpPurpose;
    code: string;
    maxAttempts: number;
    ipKey: string;
    ipCap: number;
    ipWindowMs: number;
  }): Promise<OtpCheck> {
    let reply: unknown;
    try {
      reply = await runScript(
        this.redis,
        verifyScript,
        [this.keys.otp(input.phoneHash), this.keys.otpChallenge(input.challengeId), input.ipKey, this.keys.otpReviewWrong(input.phoneHash)],
        [
          input.challengeId,
          input.purpose,
          input.ipCap,
          input.ipWindowMs,
          input.maxAttempts,
          this.codeHash(input.challengeId, input.code),
          reviewCodeHash(this.hasher, input.code),
          REVIEW_WRONG_DAILY,
          REVIEW_WRONG_WINDOW_MS,
        ],
      );
    } catch (error) {
      throw new LimitUnavailableError({ cause: error });
    }
    const [outcome, a, b] = reply as [string, unknown, unknown];
    switch (outcome) {
      case 'ok':
        return { outcome: 'ok', phone: this.sealer.openText(Buffer.from(String(a), 'base64'), SEALED_PURPOSE), review: b === '1' };
      case 'wrong':
        return { outcome: 'wrong', attemptsLeft: Number(a) };
      case 'locked':
        return { outcome: 'locked' };
      case 'ip_limited':
        return { outcome: 'ip_limited', retryAfterMs: Math.max(0, Number(a)) };
      default:
        return { outcome: 'missing' };
    }
  }

  private codeHash(challengeId: string, code: string): string {
    return this.hasher.hex(hashDomains.otp, `${challengeId}:${code}`);
  }
}
