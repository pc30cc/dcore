import { statsLive } from '@app/db';
import { STATS_QUEUE_CAP } from '@app/shared';
import {
  STATS_LIVE_TTL_SECONDS,
  STATS_TEST_IDS_NONE,
  STATS_TEST_IDS_TTL_SECONDS,
  centrifugoOnlineUsers,
  streamHealth,
  streamWaiting,
  utcDay,
  type KeyBuilder,
  type StatsLiveSnapshot,
  type TestAccounts,
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
 * out of today's active people the moment they open the app (a flip moves
 * that set itself, at once; see `announceTestAccount`).
 */

export const STATS_LIVE_LEASE_MS = 50_000;
const SMISMEMBER_CHUNK = 1_000;
let lastOnlineWarnMs = 0;
const writtenIds = new WeakMap<Redis, readonly string[]>();

/**
 * KEYS: `stats:testids`, `stats:testv`; ARGV: the version the list was
 * loaded under ('' no key, '*' any), the life in seconds, then the members.
 * One step: the set is replaced only while no flip has moved the version
 * since; a flip has already changed `stats:testids` itself, and an older
 * list must not undo it.
 */
const WRITE_TEST_IDS = `if ARGV[1] ~= '*' and (redis.call('GET', KEYS[2]) or '') ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
for i = 3, #ARGV, ${SMISMEMBER_CHUNK} do redis.call('SADD', KEYS[1], unpack(ARGV, i, math.min(i + ${SMISMEMBER_CHUNK - 1}, #ARGV))) end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1`;

/**
 * `stats:testids` from the loaded list (and STATS_TEST_IDS_NONE, so it
 * exists with no test account), when the list was reloaded or the key is
 * about to expire. `version`: what `stats:testv` must still read ('*' any,
 * null no key); undefined (not known): nothing is written, as if it moved.
 * Answers whether the set was written.
 */
export async function keepTestIds(redis: Redis, keys: KeyBuilder, ids: readonly string[], version: string | null | undefined): Promise<boolean> {
  if (version === undefined) return false;
  const key = keys.statsTestIds();
  if (writtenIds.get(redis) === ids && (await redis.ttl(key)) > STATS_TEST_IDS_TTL_SECONDS / 3) return false;
  const written = await redis.eval(WRITE_TEST_IDS, 2, key, keys.statsTestVersion(), version ?? '', STATS_TEST_IDS_TTL_SECONDS, STATS_TEST_IDS_NONE, ...ids);
  if (written !== 1) return false;
  writtenIds.set(redis, ids);
  return true;
}

/** The version a write of this set's list must find: '*' with no version source; undefined when none was read, or before a load. */
function writeGuard(tests: TestAccounts): string | null | undefined {
  if (!tests.loaded) return undefined;
  return tests.followsFlips ? tests.version : '*';
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
  const tests = testAccountsOf(services, log);
  const testIds = await tests.ids();
  const guard = writeGuard(tests);
  const db = await statsLive(services.pg, STATS_QUEUE_CAP);
  await keepTestIds(redis, keys, testIds, guard);

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

  const streams = (await streamHealth(redis, keys, now)).map((h) => ({ name: h.name, length: h.length, waiting: streamWaiting(h), pending: h.pending, dead: h.dead, lagMs: h.lagMs }));
  const jobs = await queueCounts(redis, config.queuePrefix);
  const { day, ...counts } = db;
  const snapshot: StatsLiveSnapshot = { at: new Date(now).toISOString(), day, online, testActive, db: counts, streams, jobs };
  await redis.set(keys.statsLive(), JSON.stringify(snapshot), 'EX', STATS_LIVE_TTL_SECONDS);
  return { leased: true, online, testActive };
}
