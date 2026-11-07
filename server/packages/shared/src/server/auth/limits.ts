import type { Redis } from 'ioredis';
import { luaScript, runScript } from '../kv/scripts.js';

/**
 * Fixed-window limits that fail closed: several counters checked and
 * counted in one atomic script, so a request either counts against all of
 * them or against none (a refused request uses up nothing). When Valkey
 * cannot be asked, {@link LimitUnavailableError} is thrown and the caller
 * refuses the request: sign-in and OTP limits must hold during an outage.
 */

const limitsScript = luaScript(new URL('./limits.lua', import.meta.url), 'limits', null);
const refundScript = luaScript(new URL('./refund.lua', import.meta.url), 'limits-refund', null);

export interface Limit {
  /** Full key name (deployment prefix included). */
  key: string;
  cap: number;
  windowMs: number;
  /** A name for logs and answers (`phone_daily`, `ip_hourly`, ...). */
  name: string;
}

export type LimitVerdict = { ok: true } | { ok: false; limit: Limit; retryAfterMs: number };

export class LimitUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('limits unavailable: Valkey could not be asked', options);
    this.name = 'LimitUnavailableError';
  }
}

export class FailClosedLimits {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /** Checks every limit and, when all allow it, counts it against each. */
  async take(limits: readonly Limit[]): Promise<LimitVerdict> {
    return this.run(limits, true);
  }

  /** Checks without counting. */
  async check(limits: readonly Limit[]): Promise<LimitVerdict> {
    return this.run(limits, false);
  }

  /** Gives one count back on each (nothing was sent after all). Best effort: a failure is ignored. */
  async refund(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    await runScript(this.redis, refundScript, keys, []).catch(() => undefined);
  }

  private async run(limits: readonly Limit[], count: boolean): Promise<LimitVerdict> {
    if (limits.length === 0) return { ok: true };
    for (const limit of limits) {
      if (!Number.isInteger(limit.cap) || limit.cap < 1 || !Number.isInteger(limit.windowMs) || limit.windowMs < 1) {
        throw new RangeError(`limit ${limit.name}: cap and window must be positive integers`);
      }
    }
    let reply: unknown;
    try {
      reply = await runScript(
        this.redis,
        limitsScript,
        limits.map((l) => l.key),
        [count ? 1 : 0, ...limits.flatMap((l) => [l.cap, l.windowMs])],
      );
    } catch (error) {
      throw new LimitUnavailableError({ cause: error });
    }
    const [index, ttl] = reply as [number, number];
    if (index === 0) return { ok: true };
    const limit = limits[index - 1];
    if (!limit) throw new LimitUnavailableError();
    return { ok: false, limit, retryAfterMs: Math.max(0, Number(ttl)) };
  }
}
