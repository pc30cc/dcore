import type { Redis } from 'ioredis';
import { utcDay, type KeyBuilder } from '../kv/keys.js';
import { luaScript, runScript } from '../kv/scripts.js';

/**
 * Free quotas of the swipe path, counted in Valkey (kv-core), never in
 * PostgreSQL: daily likes (`q:likes:<uid>:<yyyymmdd>`, UTC days) and weekly
 * super likes (`q:sl:<uid>:<yyyyww>`, ISO weeks, Monday 00:00 UTC). The
 * limits are plan features (`daily_likes`, `weekly_superlikes`; -1 is
 * unlimited); what is paid for beyond them lives in the wallet.
 */

export type QuotaKind = 'likes' | 'superlikes';

const quotaScript = luaScript(new URL('./quota.lua', import.meta.url), 'quota', 1);

const DAY_MS = 86_400_000;

/** ISO 8601 week of a time, `yyyyww` (the year is the ISO week-numbering year). */
export function isoWeek(time: Date | number): string {
  const date = new Date(typeof time === 'number' ? time : time.getTime());
  const day = Math.floor(date.getTime() / DAY_MS);
  // Thursday of this ISO week decides its year.
  const weekday = (new Date(day * DAY_MS).getUTCDay() + 6) % 7;
  const thursday = day - weekday + 3;
  const year = new Date(thursday * DAY_MS).getUTCFullYear();
  const jan4 = Math.floor(Date.UTC(year, 0, 4) / DAY_MS);
  const jan4Weekday = (new Date(jan4 * DAY_MS).getUTCDay() + 6) % 7;
  const week = Math.floor((thursday - (jan4 - jan4Weekday)) / 7) + 1;
  return `${year}${String(week).padStart(2, '0')}`;
}

export interface QuotaPeriod {
  /** The key's period part. */
  period: string;
  /** When the counter starts again (epoch ms). */
  resetsAtMs: number;
  /** The counter's lifetime: the period and a margin. */
  ttlSeconds: number;
}

export function quotaPeriod(kind: QuotaKind, now: number = Date.now()): QuotaPeriod {
  const day = Math.floor(now / DAY_MS);
  if (kind === 'likes') return { period: utcDay(now), resetsAtMs: (day + 1) * DAY_MS, ttlSeconds: 2 * 86_400 };
  const weekday = (new Date(day * DAY_MS).getUTCDay() + 6) % 7;
  return { period: isoWeek(now), resetsAtMs: (day - weekday + 7) * DAY_MS, ttlSeconds: 8 * 86_400 };
}

const FEATURE: Record<QuotaKind, string> = { likes: 'likes', superlikes: 'sl' };

export function quotaKey(keys: KeyBuilder, kind: QuotaKind, userId: string, now: number = Date.now()): string {
  return keys.quota(FEATURE[kind], userId, quotaPeriod(kind, now).period);
}

export interface QuotaUse {
  allowed: boolean;
  /** Used in the period after the call. */
  used: number;
  limit: number;
  resetsAtMs: number;
}

/**
 * Counts `amount` against a quota when it fits under `limit` (-1 unlimited);
 * a negative amount gives back what an answer did not use (a duplicate).
 */
export async function useQuota(
  redis: Redis,
  keys: KeyBuilder,
  kind: QuotaKind,
  userId: string,
  limit: number,
  amount = 1,
  now: number = Date.now(),
): Promise<QuotaUse> {
  if (!Number.isInteger(limit) || limit < -1) throw new RangeError('limit must be -1 or more');
  if (!Number.isInteger(amount) || amount === 0) throw new RangeError('amount must be a non-zero integer');
  const period = quotaPeriod(kind, now);
  const reply = await runScript(redis, quotaScript, [keys.quota(FEATURE[kind], userId, period.period)], [limit, period.ttlSeconds, amount]);
  if (!Array.isArray(reply) || reply.length !== 2) throw new TypeError('quota script returned an unexpected reply');
  return { allowed: Number(reply[0]) === 1, used: Number(reply[1]), limit, resetsAtMs: period.resetsAtMs };
}

/** What has been used in the current periods, in one round trip. */
export async function readQuotas(redis: Redis, keys: KeyBuilder, userId: string, now: number = Date.now()): Promise<Record<QuotaKind, number>> {
  const [likes, superlikes] = await redis.mget(quotaKey(keys, 'likes', userId, now), quotaKey(keys, 'superlikes', userId, now));
  return { likes: Number(likes ?? 0) || 0, superlikes: Number(superlikes ?? 0) || 0 };
}

/** Swipes a person may send in an hour (the bot rule); past it a whole request is refused. */
export const SWIPES_PER_HOUR = 600;

/**
 * Counts `amount` swipes in the current UTC hour (`q:swipes:<uid>:<yyyymmddhh>`)
 * when they fit under the hourly cap; nothing is counted otherwise.
 */
export async function useHourlySwipes(
  redis: Redis,
  keys: KeyBuilder,
  userId: string,
  amount: number,
  now: number = Date.now(),
  cap: number = SWIPES_PER_HOUR,
): Promise<{ allowed: boolean; used: number; resetsAtMs: number }> {
  const hour = Math.floor(now / 3_600_000);
  const period = `${utcDay(now)}${String(new Date(now).getUTCHours()).padStart(2, '0')}`;
  const reply = await runScript(redis, quotaScript, [keys.quota('swipes', userId, period)], [cap, 2 * 3_600, amount]);
  if (!Array.isArray(reply) || reply.length !== 2) throw new TypeError('quota script returned an unexpected reply');
  return { allowed: Number(reply[0]) === 1, used: Number(reply[1]), resetsAtMs: (hour + 1) * 3_600_000 };
}
