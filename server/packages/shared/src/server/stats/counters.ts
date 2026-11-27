import type { Redis } from 'ioredis';
import { utcDay, type KeyBuilder } from '../kv/keys.js';
import type { ProviderHealthName, StatsCounterName } from '../../stats.js';
import { providerHealth } from '../../stats.js';

/**
 * The day counters of the dashboard (`ev:<name>:<yyyymmdd>`, kv-core): one
 * MULTI of INCRBY + EXPIRE NX per call. Counting never decides an answer:
 * callers do not await a failure into their reply (`.catch(log)`), and a
 * lost increment (a Valkey failover, a batch that failed before its count)
 * only undercounts.
 */

/** How long a day counter is kept; stats_daily holds the history. */
export const STATS_COUNTER_TTL_SECONDS = 45 * 86_400;

/** Adds `counts` to today's counters (UTC); zero and negative counts are skipped. */
export async function countEvents(
  redis: Redis,
  keys: KeyBuilder,
  counts: Partial<Record<StatsCounterName, number>>,
  now: number = Date.now(),
): Promise<void> {
  const day = utcDay(now);
  const multi = redis.multi();
  let commands = 0;
  for (const [name, n] of Object.entries(counts) as [StatsCounterName, number][]) {
    if (!Number.isInteger(n) || n <= 0) continue;
    const key = keys.statsCounter(name, day);
    multi.incrby(key, n).expire(key, STATS_COUNTER_TTL_SECONDS, 'NX');
    commands += 1;
  }
  if (commands === 0) return;
  await multi.exec();
}

/** Adds one counter's counts per UTC day (`YYYYMMDD` → n), for writers whose entries span midnight. */
export async function countEventsByDay(redis: Redis, keys: KeyBuilder, name: StatsCounterName, perDay: ReadonlyMap<string, number>): Promise<void> {
  const multi = redis.multi();
  let commands = 0;
  for (const [day, n] of perDay) {
    if (!/^\d{8}$/.test(day) || !Number.isInteger(n) || n <= 0) continue;
    const key = keys.statsCounter(name, day);
    multi.incrby(key, n).expire(key, STATS_COUNTER_TTL_SECONDS, 'NX');
    commands += 1;
  }
  if (commands === 0) return;
  await multi.exec();
}

/** The outcome of one call to a provider, counted as ok or failed for the health card. */
export type ProviderOutcome = (ok: boolean) => void;

/**
 * A provider's outcome counter (`sms`, `push`, `store`): every call is one
 * increment, sent without waiting; a failure to count is passed to
 * `onError` (logged at debug by callers) and never reaches the call.
 */
export function providerOutcome(redis: Redis, keys: KeyBuilder, provider: ProviderHealthName, onError: (error: unknown) => void = () => undefined): ProviderOutcome {
  const names = providerHealth[provider];
  return (ok) => {
    countEvents(redis, keys, { [ok ? names.ok : names.failed]: 1 }).catch(onError);
  };
}
