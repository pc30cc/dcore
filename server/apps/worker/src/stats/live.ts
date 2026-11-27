import { statsLive } from '@app/db';
import { STATS_QUEUE_CAP } from '@app/shared';
import {
  STATS_LIVE_TTL_SECONDS,
  STATS_TEST_IDS_TTL_SECONDS,
  centrifugoOnlineUsers,
  streamHealth,
  utcDay,
  type StatsLiveSnapshot,
} from '@app/shared/server';
import type { Redis } from 'ioredis';
import { takeLease } from '../lease.js';
import type { JobContext } from '../queues/types.js';
import { testAccountsOf } from '../services.js';
import { queueCounts } from './queueCounts.js';

/**
 * `stats/live` (every minute, under a 50 s lease): the dashboard's snapshot
 * `stats:live` (10 minutes): today's counts and the review queues from
 * PostgreSQL (one statement), the people connected to Centrifugo, how many
 * of today's active set are test accounts, the write-behind streams and the
 * job queues. The API adds its real-time counters to it on each read. It
 * also keeps the test-account ids in `stats:testids`, so the API leaves them
 * out of today's active people the moment they open the app.
 */

export const STATS_LIVE_LEASE_MS = 50_000;
const SMISMEMBER_CHUNK = 1_000;
let lastOnlineWarnMs = 0;
const writtenIds = new WeakMap<Redis, readonly string[]>();

/**
 * `stats:testids` from the loaded list: rewritten (under a temporary name,
 * then renamed) when the list was reloaded or the key is about to expire;
 * no test account: no key.
 */
async function keepTestIds(redis: Redis, key: string, ids: readonly string[]): Promise<void> {
  if (writtenIds.get(redis) === ids && (await redis.ttl(key)) > STATS_TEST_IDS_TTL_SECONDS / 3) return;
  if (ids.length === 0) {
    await redis.del(key);
  } else {
    const temporary = `${key}:next`;
    const multi = redis.multi().del(temporary);
    for (let i = 0; i < ids.length; i += SMISMEMBER_CHUNK) multi.sadd(temporary, ...ids.slice(i, i + SMISMEMBER_CHUNK));
    await multi.expire(temporary, STATS_TEST_IDS_TTL_SECONDS).rename(temporary, key).exec();
  }
  writtenIds.set(redis, ids);
}

export interface StatsLiveResult {
  leased: boolean;
  online?: number | null;
  testActive?: number;
}

export async function statsLiveJob(context: JobContext, now: number = Date.now()): Promise<StatsLiveResult> {
  const { services, redis, config, log } = context;
  const { keys } = services;
  if (!(await takeLease(redis, keys.jobLease('stats-live'), STATS_LIVE_LEASE_MS, config.workerId))) return { leased: false };
  const testIds = await testAccountsOf(services, log).ids();
  const db = await statsLive(services.pg, STATS_QUEUE_CAP);
  await keepTestIds(redis, keys.statsTestIds(), testIds);

  let online: number | null = null;
  if (config.realtime) {
    try {
      online = await centrifugoOnlineUsers({ apiUrl: config.realtime.apiUrl, apiKey: config.realtime.apiKey, timeoutMs: 2_000 });
    } catch (error) {
      if (now - lastOnlineWarnMs >= 60_000) {
        lastOnlineWarnMs = now;
        log.warn({ err: error }, 'stats/live: online count unavailable');
      }
    }
  }

  const activeKey = keys.activeDay(utcDay(now));
  let testActive = 0;
  for (let i = 0; i < testIds.length; i += SMISMEMBER_CHUNK) {
    const flags = await redis.smismember(activeKey, ...testIds.slice(i, i + SMISMEMBER_CHUNK));
    testActive += flags.filter((flag) => flag === 1).length;
  }

  const streams = (await streamHealth(redis, keys, now)).map(({ name, length, pending, dead, lagMs }) => ({ name, length, pending, dead, lagMs }));
  const jobs = await queueCounts(redis, config.queuePrefix);
  const { day, ...counts } = db;
  const snapshot: StatsLiveSnapshot = { at: new Date(now).toISOString(), day, online, testActive, db: counts, streams, jobs };
  await redis.set(keys.statsLive(), JSON.stringify(snapshot), 'EX', STATS_LIVE_TTL_SECONDS);
  return { leased: true, online, testActive };
}
