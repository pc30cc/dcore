import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { idFloor, providerHealth, signupStages, statsAddDays, statsCounterMetrics, statsCounterNames, statsDaysBetween } from '../../src/index.js';
import {
  ACTIVE_DAY_TTL_SECONDS,
  DailyMarks,
  FakeGooglePlay,
  FakeSmsSender,
  PardakhtClient,
  SmsRouter,
  SmsRoutingError,
  STATS_COUNTER_TTL_SECONDS,
  STATS_TEST_IDS_NONE,
  STATS_TEST_IDS_TTL_SECONDS,
  TestAccounts,
  announceTestAccount,
  WATERMARK_MARGIN_MS,
  bucketActive,
  centrifugoOnlineUsers,
  countEvents,
  countEventsByDay,
  createKeys,
  providerOutcome,
  streamHealth,
  utcDay,
} from '../../src/server/index.js';
import { dropPrefix, hasRedis, testPrefix, testRedis } from './support.js';

/**
 * The dashboard's server helpers: the per-process "active today" marks, the
 * retention buckets (from the ids alone), the test-account set, the day
 * counters and provider outcomes, Centrifugo's online count, the
 * write-behind stream health, and the outcome hooks of the SMS router and
 * the store clients.
 */

const DAY_MS = 86_400_000;
const idOn = (day: string, n: number) => (idFloor(Date.parse(`${day}T12:00:00Z`)) + BigInt(n)).toString();

describe('DailyMarks', () => {
  it('marks a person once a day and again on a new day, after a failed write, or past the cap', () => {
    const marks = new DailyMarks({ cap: 2 });
    expect(marks.mark('20261120', '1')).toBe(true);
    expect(marks.mark('20261120', '1')).toBe(false);
    marks.forget('20261120', '1');
    expect(marks.mark('20261120', '1')).toBe(true);
    expect(marks.mark('20261121', '1')).toBe(true);
    expect(marks.mark('20261121', '2')).toBe(true);
    expect(marks.mark('20261121', '3')).toBe(true);
    expect(marks.size).toBe(1);
    expect(ACTIVE_DAY_TTL_SECONDS).toBe(3 * 86_400);
  });
});

describe('bucketActive', () => {
  it('buckets ids by the day they were minted; test accounts and members that are not ids are left out', () => {
    const day = '2026-11-20';
    const ids = [idOn(statsAddDays(day, -1), 1), idOn(statsAddDays(day, -1), 2), idOn(statsAddDays(day, -7), 3), idOn(statsAddDays(day, -30), 4), idOn(day, 5), '99', 'x', '0'];
    const test = idOn(statsAddDays(day, -1), 9);
    const result = bucketActive([...ids, test], day, (uid) => uid === test);
    expect(result).toEqual({ dau: 6, cohorts: { d1: 2, d7: 1, d30: 1 } });
  });
});

describe('TestAccounts', () => {
  it('loads once while fresh, keeps the last set when a reload fails, and answers from what is loaded', async () => {
    let now = 0;
    let calls = 0;
    let fail = false;
    const errors: unknown[] = [];
    const set = new TestAccounts({
      load: async () => {
        calls += 1;
        if (fail) throw new Error('down');
        return ['7', '8'];
      },
      maxAgeMs: 1_000,
      checkMs: 500,
      now: () => now,
      onError: (e) => errors.push(e),
    });
    expect(set.has('7')).toBe(false);
    expect(await set.ids()).toEqual(['7', '8']);
    expect(set.has('7')).toBe(true);
    await set.ids();
    expect(calls).toBeLessThanOrEqual(2);
    const before = calls;
    now = 2_000;
    fail = true;
    expect(await set.ids()).toEqual(['7', '8']);
    expect(calls).toBe(before + 1);
    expect(errors).toHaveLength(1);
    expect(set.has('8')).toBe(true);
    // A failed reload is tried again only after checkMs.
    expect(await set.ids()).toEqual(['7', '8']);
    expect(calls).toBe(before + 1);
    now = 2_500;
    fail = false;
    await set.ids();
    expect(calls).toBe(before + 2);
  });

  it('reloads when the version moved, looking at it at most every checkMs; an unreadable version keeps the set', async () => {
    let now = 0;
    let version: string | null = null;
    let versionFails = false;
    let reads = 0;
    let ids = ['7'];
    let loads = 0;
    const set = new TestAccounts({
      load: async () => {
        loads += 1;
        return ids;
      },
      version: async () => {
        reads += 1;
        if (versionFails) throw new Error('valkey down');
        return version;
      },
      checkMs: 1_000,
      now: () => now,
    });
    expect(await set.ids()).toEqual(['7']);
    expect(set.version).toBeNull();
    expect([reads, loads]).toEqual([1, 1]);
    // Within checkMs nothing is read; after it, one GET and no reload while the version stands.
    now = 500;
    await set.ids();
    expect([reads, loads]).toEqual([1, 1]);
    now = 1_000;
    await set.ids();
    expect([reads, loads]).toEqual([2, 1]);
    // A flip: the next look reloads.
    ids = ['7', '9'];
    version = '1';
    expect(set.has('9')).toBe(false);
    now = 2_000;
    expect(await set.ids()).toEqual(['7', '9']);
    expect(set.has('9')).toBe(true);
    expect(set.version).toBe('1');
    expect([reads, loads]).toEqual([3, 2]);
    // Valkey down: the set stays and the database is not read.
    versionFails = true;
    now = 3_000;
    expect(await set.ids()).toEqual(['7', '9']);
    expect([reads, loads]).toEqual([4, 2]);
    // has() starts the look itself when one is due.
    versionFails = false;
    version = '2';
    ids = ['9'];
    now = 4_000;
    expect(set.has('7')).toBe(true);
    for (let i = 0; i < 20 && set.has('7'); i += 1) await new Promise((r) => setTimeout(r, 1));
    expect(set.has('7')).toBe(false);
    expect([reads, loads]).toEqual([5, 3]);
  });

  it('a reload with the version unreadable keeps the value read last; with none read the version stays unknown', async () => {
    let now = 0;
    let version: string | null = 'a1';
    let versionFails = false;
    let loads = 0;
    const set = new TestAccounts({
      load: async () => {
        loads += 1;
        return ['7'];
      },
      version: async () => {
        if (versionFails) throw new Error('valkey down');
        return version;
      },
      maxAgeMs: 10_000,
      checkMs: 1_000,
      now: () => now,
    });
    expect(set.followsFlips).toBe(true);
    await set.ids();
    expect(set.version).toBe('a1');
    // Stale and Valkey down: reloaded, still under the value read before (a later flip can never match it).
    versionFails = true;
    now = 10_000;
    await set.ids();
    expect(loads).toBe(2);
    expect(set.version).toBe('a1');
    // Readable again and moved meanwhile: reloaded.
    versionFails = false;
    version = 'b2';
    now = 11_000;
    await set.ids();
    expect([loads, set.version]).toEqual([3, 'b2']);

    const first = new TestAccounts({
      load: async () => ['7'],
      version: async () => {
        throw new Error('valkey down');
      },
    });
    await first.ids();
    expect(first.loaded).toBe(true);
    expect(first.version).toBeUndefined();
    expect(new TestAccounts({ load: async () => [] }).followsFlips).toBe(false);
  });
});

describe('statistics names', () => {
  it('map every counter to a stored metric, name provider counters, and keep the sign-up stages in step order', () => {
    expect(Object.keys(statsCounterMetrics).sort()).toEqual([...statsCounterNames].sort());
    for (const { ok, failed } of Object.values(providerHealth)) {
      expect(statsCounterNames).toContain(ok);
      expect(statsCounterNames).toContain(failed);
    }
    const froms = signupStages.map((s) => s.from);
    expect(froms).toEqual([...froms].sort((a, b) => a - b));
    expect(froms.at(-1)).toBe(30);
    expect(statsDaysBetween('2026-11-01', '2026-11-30')).toBe(30);
    expect(statsDaysBetween('2026-11-02', '2026-11-01')).toBe(0);
    expect(statsAddDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('centrifugoOnlineUsers', () => {
  it('sums the users of every node, and throws when Centrifugo cannot tell', async () => {
    const seen: { url: string; key: string | null }[] = [];
    const answer = (status: number, body: unknown) => async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: url instanceof Request ? url.url : url.toString(), key: new Headers(init?.headers).get('x-api-key') });
      return new Response(JSON.stringify(body), { status });
    };
    expect(await centrifugoOnlineUsers({ apiUrl: 'http://c:8000/', apiKey: 'k', fetch: answer(200, { result: { nodes: [{ num_users: 4 }, { num_users: 3 }, {}] } }) })).toBe(7);
    expect(seen[0]).toEqual({ url: 'http://c:8000/api/info', key: 'k' });
    await expect(centrifugoOnlineUsers({ apiUrl: 'http://c', apiKey: 'k', fetch: answer(500, {}) })).rejects.toThrow(/info answered 500/);
    await expect(centrifugoOnlineUsers({ apiUrl: 'http://c', apiKey: 'k', fetch: answer(200, { error: { code: 1 } }) })).rejects.toThrow(/without nodes/);
  });
});

describe('the SMS router outcome hook', () => {
  it('tells a send and an unavailable provider, never a refused number', async () => {
    const down = new FakeSmsSender('kavenegar');
    down.fail = 'unavailable';
    const up = new FakeSmsSender('smsir');
    const told: [boolean, string][] = [];
    const router = new SmsRouter([down, up], { onAttempt: (ok, provider) => told.push([ok, provider]) });
    await router.send(['kavenegar', 'smsir'], { phone: '+989120000000', code: '123456', appName: '', locale: 'fa', channel: 'sms' });
    expect(told).toEqual([
      [false, 'kavenegar'],
      [true, 'smsir'],
    ]);
    up.fail = 'rejected';
    told.length = 0;
    const strict = new SmsRouter([up], { onAttempt: (ok, provider) => told.push([ok, provider]) });
    await expect(strict.send(['smsir'], { phone: '+989120000000', code: '1', appName: '', locale: 'fa', channel: 'sms' })).rejects.toBeInstanceOf(SmsRoutingError);
    expect(told).toEqual([]);
  });
});

describe('the store clients outcome hooks', () => {
  it('Bazaar: an answer about a purchase is ok; 5xx, auth and the network are failures', async () => {
    const told: boolean[] = [];
    let status = 200;
    let body: unknown = { consumptionState: 1, purchaseState: 0, developerPayload: '', purchaseTime: 1 };
    const client = new PardakhtClient({
      packageName: 'com.example.app',
      auth: { kind: 'pishkhan', token: 'pishkhan-token-0123456789' },
      fetch: async () => {
        if (status === 0) throw new TypeError('fetch failed');
        return new Response(JSON.stringify(body), { status });
      },
      onOutcome: (ok) => told.push(ok),
    });
    await client.inappPurchase('cons.superlike.5', 'token-1', 'urgent');
    status = 404;
    body = { error: 'not_found', error_description: 'not found' };
    await expect(client.inappPurchase('cons.superlike.5', 'token-1', 'urgent')).rejects.toThrow();
    status = 503;
    body = {};
    await expect(client.inappPurchase('cons.superlike.5', 'token-1', 'urgent')).rejects.toThrow();
    status = 401;
    await expect(client.inappPurchase('cons.superlike.5', 'token-1', 'urgent')).rejects.toThrow();
    status = 0;
    await expect(client.inappPurchase('cons.superlike.5', 'token-1', 'urgent')).rejects.toThrow();
    expect(told).toEqual([true, true, false, false, false]);
  });

  it('Play: an answer is ok; each failed attempt of a retried call is told', async () => {
    const play = await new FakeGooglePlay().start();
    try {
      const told: boolean[] = [];
      const api = play.api({ onOutcome: (ok) => told.push(ok), retries: 1 });
      play.putProduct('token-2', { productId: 'cons.superlike.5' });
      await api.getProduct('token-2').catch(() => undefined);
      expect(told).toEqual([true]);
      told.length = 0;
      play.failNext('productsv2.get', 503, { times: 2 });
      await expect(api.getProduct('token-2')).rejects.toThrow();
      expect(told).toEqual([false, false]);
      told.length = 0;
      play.failNext('productsv2.get', 400);
      await expect(api.getProduct('token-2')).rejects.toThrow();
      expect(told).toEqual([true]);
    } finally {
      await play.stop();
    }
  });
});

describe.skipIf(!hasRedis)('day counters and stream health (Valkey)', () => {
  let redis: Redis;
  const prefix = testPrefix();
  const keys = createKeys(prefix);

  beforeAll(() => {
    redis = testRedis();
  });
  afterAll(async () => {
    await dropPrefix(redis, prefix);
    await redis.quit();
  });

  it('moves stats:testids and stats:testv at once on a flip; the set outlives its last test account', async () => {
    const ids = keys.statsTestIds();
    const versions: (string | null)[] = [];
    await announceTestAccount(redis, keys, '41', true);
    versions.push(await redis.get(keys.statsTestVersion()));
    expect((await redis.smembers(ids)).sort()).toEqual(['41', STATS_TEST_IDS_NONE].sort());
    expect(await redis.ttl(ids)).toBeGreaterThan(STATS_TEST_IDS_TTL_SECONDS - 10);
    await redis.expire(ids, 100);
    await announceTestAccount(redis, keys, '42', true);
    versions.push(await redis.get(keys.statsTestVersion()));
    // An existing set keeps its life (stats/live renews it).
    expect(await redis.ttl(ids)).toBeLessThanOrEqual(100);
    await announceTestAccount(redis, keys, '41', false);
    versions.push(await redis.get(keys.statsTestVersion()));
    await announceTestAccount(redis, keys, '42', false);
    versions.push(await redis.get(keys.statsTestVersion()));
    expect(await redis.smembers(ids)).toEqual([STATS_TEST_IDS_NONE]);
    // A new value on every flip, never one written before.
    for (const version of versions) expect(version).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(versions).size).toBe(4);
    // Taking someone out of a set that is not there makes none.
    await redis.del(ids);
    await announceTestAccount(redis, keys, '41', false);
    expect(await redis.exists(ids)).toBe(0);
  });

  it('a flip after stats:testv was lost never repeats the value a set loaded under: the set reloads', async () => {
    const version = keys.statsTestVersion();
    await redis.del(version);
    let loads = 0;
    let now = 0;
    const set = new TestAccounts({
      load: async () => {
        loads += 1;
        return [];
      },
      version: () => redis.get(version),
      checkMs: 1_000,
      now: () => now,
    });
    await announceTestAccount(redis, keys, '43', true);
    await set.ids();
    const loadedUnder = set.version;
    // The key is lost (FLUSHALL, an older copy restored), then as many flips as before it: a counter would read the same value again.
    await redis.del(version);
    await announceTestAccount(redis, keys, '43', false);
    now = 1_000;
    await set.ids();
    expect(set.version).not.toBe(loadedUnder);
    expect(loads).toBe(2);
    await redis.del(keys.statsTestIds());
  });

  it('adds counts to today’s counters with a 45-day life, per day for writers whose entries span midnight', async () => {
    const now = Date.parse('2026-11-20T10:00:00Z');
    await countEvents(redis, keys, { like: 2, pass: 0, superlike: -1, msg: 3 }, now);
    await countEvents(redis, keys, { like: 1 }, now);
    expect(await redis.get(keys.statsCounter('like', '20261120'))).toBe('3');
    expect(await redis.get(keys.statsCounter('msg', '20261120'))).toBe('3');
    expect(await redis.exists(keys.statsCounter('pass', '20261120'))).toBe(0);
    expect(await redis.exists(keys.statsCounter('superlike', '20261120'))).toBe(0);
    const ttl = await redis.ttl(keys.statsCounter('like', '20261120'));
    expect(ttl).toBeGreaterThan(STATS_COUNTER_TTL_SECONDS - 10);
    await countEventsByDay(redis, keys, 'msg', new Map([['20261119', 2], ['20261120', 1], ['bad', 5]]));
    expect(await redis.get(keys.statsCounter('msg', '20261119'))).toBe('2');
    expect(await redis.get(keys.statsCounter('msg', '20261120'))).toBe('4');
  });

  it('counts provider outcomes without waiting; a failure to count goes to its handler only', async () => {
    const outcome = providerOutcome(redis, keys, 'store');
    outcome(true);
    outcome(false);
    outcome(false);
    const day = utcDay(Date.now());
    for (let i = 0; i < 50 && (await redis.get(keys.statsCounter('store_err', day))) !== '2'; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(await redis.get(keys.statsCounter('store_ok', day))).toBe('1');
    expect(await redis.get(keys.statsCounter('store_err', day))).toBe('2');
    const errors: unknown[] = [];
    const broken = { multi: () => ({ incrby: () => ({ expire: () => undefined }), exec: () => Promise.reject(new Error('down')) }) } as unknown as Redis;
    providerOutcome(broken, keys, 'sms', (e) => errors.push(e))(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(errors).toHaveLength(1);
  });

  it('reads each stream’s length, dead letters, pending, undelivered and lag; a missing stream or group reads null', async () => {
    const now = Date.now();
    // like: two entries, one delivered and pending, one undelivered.
    const like = keys.stream('like');
    const first = await redis.xadd(like, `${now - 9_000}-0`, 'a', '1');
    await redis.xadd(like, `${now - 4_000}-0`, 'a', '2');
    await redis.xgroup('CREATE', like, 'pg', '0');
    await redis.xreadgroup('GROUP', 'pg', 'w1', 'COUNT', 1, 'STREAMS', like, '>');
    await redis.xadd(keys.streamDead('like'), '*', 'a', '0');
    await redis.set(keys.streamWatermark('like'), idFloor(now - 20_000).toString());
    // msg: one entry, read and acknowledged, one undelivered.
    const msg = keys.stream('msg');
    const read = await redis.xadd(msg, `${now - 8_000}-0`, 'm', '1');
    await redis.xgroup('CREATE', msg, 'pg', '0');
    await redis.xreadgroup('GROUP', 'pg', 'w1', 'COUNT', 1, 'STREAMS', msg, '>');
    await redis.xack(msg, 'pg', read!);
    await redis.xadd(msg, `${now - 3_000}-0`, 'm', '2');
    // match: no stream at all.

    const health = Object.fromEntries((await streamHealth(redis, keys, now)).map((h) => [h.name, h]));
    expect(health['like']).toMatchObject({ length: 2, pending: 1, dead: 1, group: true, consumers: 1, undelivered: 1, lagMs: 9_000, oldestPendingAtMs: now - 9_000 });
    expect(health['like']!.lastDeliveredAtMs).toBe(Number(first!.split('-')[0]));
    expect(health['like']!.watermarkLagMs).toBe(20_000 - WATERMARK_MARGIN_MS);
    expect(health['msg']).toMatchObject({ length: 2, pending: 0, dead: 0, group: true, undelivered: 1, lagMs: 3_000, oldestPendingAtMs: null, watermarkLagMs: null });
    expect(health['match']).toEqual({
      name: 'match',
      length: 0,
      pending: 0,
      dead: 0,
      lagMs: null,
      group: false,
      consumers: 0,
      undelivered: null,
      oldestPendingAtMs: null,
      lastDeliveredAtMs: null,
      watermarkLagMs: null,
    });

    // Everything delivered and acknowledged: no lag.
    await redis.xreadgroup('GROUP', 'pg', 'w1', 'COUNT', 10, 'STREAMS', msg, '>');
    const pending = (await redis.xpending(msg, 'pg', '-', '+', 10)) as [string][];
    for (const [id] of pending) await redis.xack(msg, 'pg', id);
    const caughtUp = (await streamHealth(redis, keys, now)).find((h) => h.name === 'msg')!;
    expect(caughtUp).toMatchObject({ pending: 0, undelivered: 0, lagMs: 0 });
    expect(DAY_MS).toBe(86_400_000);
  });
});
