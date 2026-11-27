import {
  statsPut,
  statsRolledUpDays,
  statsRollupModeration,
  statsRollupMoney,
  statsRollupPeople,
  statsRollupPlaces,
  statsRollupSocial,
  type StatsRow,
} from '@app/db';
import { statsAddDays, statsCounterMetrics, statsCounterNames, statsDay } from '@app/shared';
import { STATS_COUNTER_TTL_SECONDS, bucketActive } from '@app/shared/server';
import { UnrecoverableError } from 'bullmq';
import { takeLease } from '../lease.js';
import type { JobContext } from '../queues/types.js';
import { testAccountsOf } from '../services.js';

/**
 * `stats/rollup` (daily at 00:41 UTC, after the active drain): yesterday,
 * and any of the six days before it that has no `rollup` marker, oldest
 * first. `{ day }` rolls up that day (yesterday or older; today has not
 * ended) and its missing days the same way. Per day:
 *
 * - the Valkey part, no statement: while `la:<day>` exists, its members
 *   (test accounts left out) go into `hll:dau:<day>` and are bucketed by the
 *   day their id was minted: DAU and the day-1, 7 and 30 retention of the
 *   cohorts of day − 1, 7 and 30 (no read of users); WAU and MAU are the
 *   HyperLogLog unions of 7 and 30 days; the day's counters are copied;
 * - the PostgreSQL part, one statement each: sign-up cohorts, social,
 *   money (the subscription snapshot for yesterday only), places
 *   (yesterday only: both read the present state, so an older day keeps the
 *   ones stored that night), moderator decisions, then the Valkey rows with
 *   the day's `rollup` marker. Cohort windows are counted up to the start of
 *   today, so a day run again never shortens one that has closed.
 *
 * About six statements a day. The lease is given back when a run fails, so
 * BullMQ's retry can run; `stats:last` holds the newest day finished.
 */

export const STATS_ROLLUP_LEASE_MS = 30 * 60_000;
export const STATS_CATCH_UP_DAYS = 6;
const SSCAN_COUNT = 5_000;
const ID = /^[1-9][0-9]{0,18}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface StatsRollupDay {
  day: string;
  dau: number | null;
  statements: number;
}

export interface StatsRollupResult {
  leased: boolean;
  days: StatsRollupDay[];
}

/** `YYYY-MM-DD` from `YYYY-MM-DD` or `YYYYMMDD`. */
export function rollupDayOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const day = /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value;
  return DAY.test(day) && statsDay(Date.parse(`${day}T00:00:00Z`)) === day ? day : null;
}

const compact = (day: string) => day.replaceAll('-', '');

/** The Valkey part of one day: rows for stats_daily and the day's DAU (null without `la:<day>`). */
export async function activityRows(context: JobContext, day: string, isTest: (uid: string) => boolean): Promise<{ rows: StatsRow[]; dau: number | null }> {
  const { redis, services } = context;
  const { keys } = services;
  const rows: StatsRow[] = [];
  const counters = await redis.mget(...statsCounterNames.map((name) => keys.statsCounter(name, compact(day))));
  statsCounterNames.forEach((name, i) => {
    const value = Number(counters[i] ?? NaN);
    if (Number.isInteger(value) && value >= 0) rows.push({ metric: statsCounterMetrics[name], day, value });
  });

  const activeKey = keys.activeDay(compact(day));
  if ((await redis.exists(activeKey)) === 0) return { rows, dau: null };
  const hll = keys.statsDau(compact(day));
  // SSCAN may return a member twice (while the set rehashes): the ids are kept once in memory (about 4 MB at 200k).
  const active = new Set<string>();
  let cursor = '0';
  do {
    const [next, members] = await redis.sscan(activeKey, cursor, 'COUNT', SSCAN_COUNT);
    cursor = next;
    const kept = members.filter((m) => ID.test(m) && !isTest(m) && !active.has(m));
    for (const m of kept) active.add(m);
    if (kept.length > 0) await redis.pfadd(hll, ...kept);
  } while (cursor !== '0');
  await redis.expire(hll, STATS_COUNTER_TTL_SECONDS);
  const buckets = bucketActive(active, day, isTest);
  const dau = buckets.dau;
  const back = (n: number) => keys.statsDau(compact(statsAddDays(day, -n)));
  const wau = await redis.pfcount(...Array.from({ length: 7 }, (_, i) => back(i)));
  const mau = await redis.pfcount(...Array.from({ length: 30 }, (_, i) => back(i)));
  rows.push(
    { metric: 'dau', day, value: dau },
    { metric: 'wau', day, value: wau },
    { metric: 'mau', day, value: mau },
    { metric: 'ret_d1', day: statsAddDays(day, -1), value: buckets.cohorts.d1 },
    { metric: 'ret_d7', day: statsAddDays(day, -7), value: buckets.cohorts.d7 },
    { metric: 'ret_d30', day: statsAddDays(day, -30), value: buckets.cohorts.d30 },
  );
  return { rows, dau };
}

export async function statsRollupJob(context: JobContext, data: { day?: unknown } = {}, now: number = Date.now()): Promise<StatsRollupResult> {
  const { services, redis, config, log } = context;
  const { keys, pg } = services;
  const yesterday = statsAddDays(statsDay(now), -1);
  const day = data.day === undefined ? yesterday : rollupDayOf(data.day);
  if (day === null) throw new UnrecoverableError('stats/rollup: day must be YYYY-MM-DD or YYYYMMDD');
  if (day > yesterday) throw new UnrecoverableError('stats/rollup: day must be yesterday or older');
  const lease = keys.jobLease(`stats-rollup-${compact(day)}`);
  if (!(await takeLease(redis, lease, STATS_ROLLUP_LEASE_MS, config.workerId))) return { leased: false, days: [] };
  try {
    const done = new Set(await statsRolledUpDays(pg, statsAddDays(day, -STATS_CATCH_UP_DAYS), statsAddDays(day, -1)));
    const days = Array.from({ length: STATS_CATCH_UP_DAYS }, (_, i) => statsAddDays(day, i - STATS_CATCH_UP_DAYS)).filter((d) => !done.has(d));
    days.push(day);
    const tests = testAccountsOf(services, log);
    const testIds = new Set(await tests.ids());
    const isTest = (uid: string) => testIds.has(uid);
    const result: StatsRollupDay[] = [];
    for (const d of days) {
      // The snapshot and the places describe the present, so only yesterday gets them.
      const newest = d === yesterday;
      const { rows, dau } = await activityRows(context, d, isTest);
      await statsRollupPeople(pg, d);
      await statsRollupSocial(pg, d);
      await statsRollupMoney(pg, d, newest);
      if (newest) await statsRollupPlaces(pg, d);
      await statsRollupModeration(pg, d);
      // The marker last: a day is rolled up once every part is written.
      await statsPut(pg, [...rows, { metric: 'rollup', day: d, value: Math.floor(now / 1000) }]);
      result.push({ day: d, dau, statements: newest ? 6 : 5 });
      log.info({ day: d, dau, newest }, 'stats/rollup: day written');
    }
    const last = await redis.get(keys.statsLastDay());
    if (last === null || last < day) await redis.set(keys.statsLastDay(), day, 'EX', STATS_COUNTER_TTL_SECONDS);
    return { leased: true, days: result };
  } catch (error) {
    // A failed run gives its lease back, so the retry runs.
    if ((await redis.get(lease).catch(() => null)) === config.workerId) await redis.del(lease).catch(() => undefined);
    throw error;
  }
}
