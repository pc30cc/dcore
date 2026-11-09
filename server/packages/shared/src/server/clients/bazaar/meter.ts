import type { Redis } from 'ioredis';
import { store as storeCodes } from '../../../codes.js';
import { utcDay, type KeyBuilder } from '../../kv/keys.js';
import { luaScript, runScript } from '../../kv/scripts.js';
import { BAZAAR_DAILY_QUOTA, BazaarApiError } from './api.js';

/**
 * Bazaar allows 50,000 API requests a day per developer. Every call is
 * counted in Valkey (kv-core) per UTC day and per minute, by the API and the
 * worker alike:
 *
 * - `urgent` calls (a purchase or a restore the person waits for) always go;
 * - `background` calls (re-checks, refund checks, consumes, revokes) are held
 *   back while the minute already carries {@link BAZAAR_BACKGROUND_PER_MINUTE}
 *   calls (no burst, whatever the schedule) or the day
 *   {@link BAZAAR_BACKGROUND_DAILY_CAP} (the rest of the quota stays for
 *   purchases). A held-back call fails as `unavailable` with a retry time,
 *   and its job tries again later.
 *
 * When Bazaar itself answers `quota_exceeded`, the day's counter is raised to
 * the quota, so background work stops until the next day. A Valkey that
 * cannot be reached holds nothing back (purchases must not fail for it).
 */

export type BazaarPriority = 'urgent' | 'background';

export const BAZAAR_BACKGROUND_PER_MINUTE = 60;
export const BAZAAR_BACKGROUND_DAILY_CAP = 40_000;

export interface BazaarCallMeter {
  /** Counts one call; throws `unavailable` (with `retryAfterSeconds`) when a background call must wait. */
  take(priority: BazaarPriority): Promise<void>;
  /** Bazaar said the quota is spent: background calls wait for the next day. */
  exhausted(): Promise<void>;
}

export interface BazaarMeterLimits {
  perMinute?: number | undefined;
  daily?: number | undefined;
}

const METER = luaScript(new URL('./meter.lua', import.meta.url), 'bazaarMeter', 2);
const BAZAAR = storeCodes.code('bazaar');
const DAY_TTL_SECONDS = 3 * 86_400;
const MINUTE_TTL_SECONDS = 180;

function held(nowMs: number, dayFull: boolean): BazaarApiError {
  const nextMinute = 60 - Math.floor((nowMs % 60_000) / 1000);
  const nextDay = new Date(nowMs);
  nextDay.setUTCHours(24, 0, 0, 0);
  const seconds = dayFull ? Math.ceil((nextDay.getTime() - nowMs) / 1000) : nextMinute;
  return new BazaarApiError('unavailable', dayFull ? 'background calls wait for the next day (quota kept for purchases)' : 'background calls paced', {
    retryAfterSeconds: Math.max(1, seconds),
  });
}

export class RedisBazaarCallMeter implements BazaarCallMeter {
  private readonly perMinute: number;
  private readonly daily: number;

  constructor(
    private readonly redis: Redis,
    private readonly keys: KeyBuilder,
    limits: BazaarMeterLimits = {},
    private readonly now: () => number = Date.now,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {
    this.perMinute = limits.perMinute ?? BAZAAR_BACKGROUND_PER_MINUTE;
    this.daily = limits.daily ?? BAZAAR_BACKGROUND_DAILY_CAP;
  }

  private names(nowMs: number): [string, string] {
    return [this.keys.iapStoreCalls(BAZAAR, `d${utcDay(nowMs)}`), this.keys.iapStoreCalls(BAZAAR, `m${Math.floor(nowMs / 60_000)}`)];
  }

  async take(priority: BazaarPriority): Promise<void> {
    const nowMs = this.now();
    let out: unknown;
    try {
      out = await runScript(this.redis, METER, this.names(nowMs), [priority === 'urgent' ? 1 : 0, this.daily, this.perMinute, DAY_TTL_SECONDS, MINUTE_TTL_SECONDS]);
    } catch (error) {
      this.onError(error);
      return;
    }
    const [allowed, day] = out as [number, number, number];
    if (allowed !== 1) throw held(nowMs, day >= this.daily);
  }

  async exhausted(): Promise<void> {
    const [day] = this.names(this.now());
    const current = Number((await this.redis.get(day)) ?? '0');
    if (current < BAZAAR_DAILY_QUOTA) await this.redis.set(day, String(BAZAAR_DAILY_QUOTA), 'EX', DAY_TTL_SECONDS);
  }

  /** Calls counted today (for health and stats). */
  async today(): Promise<number> {
    return Number((await this.redis.get(this.names(this.now())[0])) ?? '0');
  }
}

/** The same rules in memory, on a clock the caller gives (tests, simulations). */
export class MemoryBazaarCallMeter implements BazaarCallMeter {
  readonly days = new Map<string, number>();
  readonly minutes = new Map<number, number>();
  readonly backgroundMinutes = new Map<number, number>();
  heldBack = 0;
  private readonly perMinute: number;
  private readonly daily: number;

  constructor(
    private readonly now: () => number,
    limits: BazaarMeterLimits = {},
  ) {
    this.perMinute = limits.perMinute ?? BAZAAR_BACKGROUND_PER_MINUTE;
    this.daily = limits.daily ?? BAZAAR_BACKGROUND_DAILY_CAP;
  }

  async take(priority: BazaarPriority): Promise<void> {
    const nowMs = this.now();
    const day = utcDay(nowMs);
    const minute = Math.floor(nowMs / 60_000);
    const dayCount = this.days.get(day) ?? 0;
    const minuteCount = this.minutes.get(minute) ?? 0;
    if (priority === 'background' && (dayCount >= this.daily || minuteCount >= this.perMinute)) {
      this.heldBack += 1;
      throw held(nowMs, dayCount >= this.daily);
    }
    this.days.set(day, dayCount + 1);
    this.minutes.set(minute, minuteCount + 1);
    if (priority === 'background') this.backgroundMinutes.set(minute, (this.backgroundMinutes.get(minute) ?? 0) + 1);
  }

  async exhausted(): Promise<void> {
    const day = utcDay(this.now());
    this.days.set(day, Math.max(this.days.get(day) ?? 0, BAZAAR_DAILY_QUOTA));
  }
}
