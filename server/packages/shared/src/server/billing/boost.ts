import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { KeyBuilder } from '../kv/keys.js';
import { luaScript, runScript } from '../kv/scripts.js';
import { boostPeriod } from './entitlements.js';

/**
 * Boosts in Valkey (kv-core), never in PostgreSQL unless the wallet pays:
 *
 * - `boost:<uid>`: the running boost's end (epoch ms), expiring with it;
 * - `bst:<h3_r5>`: the boosted people of a cell (uid → end ms), trimmed of
 *   ended boosts in the same MULTI that adds one; the deck worker reads
 *   `ZRANGEBYSCORE bst:<cell> <now> +inf` over the viewer's cells;
 * - `q:boost:<uid>:<yyyymm>`: the month's allowance used (the plan's
 *   `monthly_boosts`), counted with the shared quota script;
 * - `boost:lock:<uid>`: one start at a time, so two taps never spend twice.
 */

export const BOOST_DURATION_MS = 30 * 60_000;
const LOCK_MS = 15_000;

const quotaScript = luaScript(new URL('../social/quota.lua', import.meta.url), 'quota', 1);

/** The running boost's end, or null. */
export async function runningBoost(redis: Redis, keys: KeyBuilder, userId: string, now: number = Date.now()): Promise<number | null> {
  const value = Number((await redis.get(keys.boostActive(userId))) ?? 0);
  return Number.isFinite(value) && value > now ? value : null;
}

/** Counts one boost of the month's allowance when it fits under `limit` (-1 unlimited, 0 none). */
export async function useBoostAllowance(redis: Redis, keys: KeyBuilder, userId: string, limit: number, now: number = Date.now()): Promise<{ allowed: boolean; used: number }> {
  if (limit === 0) return { allowed: false, used: 0 };
  const period = boostPeriod(now);
  const reply = await runScript(redis, quotaScript, [keys.quota('boost', userId, period.period)], [limit, period.ttlSeconds, 1]);
  if (!Array.isArray(reply) || reply.length !== 2) throw new TypeError('quota script returned an unexpected reply');
  return { allowed: Number(reply[0]) === 1, used: Number(reply[1]) };
}

/** Gives back what `useBoostAllowance` counted (the boost could not start). */
export async function giveBackBoostAllowance(redis: Redis, keys: KeyBuilder, userId: string, now: number = Date.now()): Promise<void> {
  const period = boostPeriod(now);
  await runScript(redis, quotaScript, [keys.quota('boost', userId, period.period)], [-1, period.ttlSeconds, -1]);
}

/** Starts a boost: its end on the person and, when the person's r5 cell is known, in that cell's zset (trimmed in the same MULTI). */
export async function startBoost(redis: Redis, keys: KeyBuilder, userId: string, cellR5: string | null, endMs: number, now: number = Date.now()): Promise<void> {
  const ttl = Math.max(1, endMs - now);
  const multi = redis.multi().set(keys.boostActive(userId), String(endMs), 'PX', ttl);
  if (cellR5 !== null) {
    const cell = keys.boosted(cellR5);
    multi.zadd(cell, endMs, userId).zremrangebyscore(cell, '-inf', now).pexpire(cell, ttl + 60_000, 'GT').pexpire(cell, ttl + 60_000, 'NX');
  }
  const replies = await multi.exec();
  const failed = replies?.find(([error]) => error !== null);
  if (!replies || failed) throw failed?.[0] ?? new Error('boost: MULTI was discarded');
}

export async function lockBoost(redis: Redis, keys: KeyBuilder, userId: string): Promise<string | null> {
  const value = randomBytes(9).toString('base64url');
  return (await redis.set(keys.boostLock(userId), value, 'PX', LOCK_MS, 'NX')) === 'OK' ? value : null;
}

const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

export async function unlockBoost(redis: Redis, keys: KeyBuilder, userId: string, value: string): Promise<void> {
  await redis.eval(RELEASE, 1, keys.boostLock(userId), value);
}
