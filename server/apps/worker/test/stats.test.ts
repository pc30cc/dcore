import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPool, instrumentPool, statementCounter, statsPut, type Pool } from '@app/db';
import { idFloor, statsAddDays, statsDay } from '@app/shared';
import {
  FakeRealtimePublisher,
  IdGenerator,
  TestAccounts,
  createKeys,
  createPublicIds,
  messageEntryFields,
  statsLiveSnapshotSchema,
  utcDay,
  type StoredMessage,
} from '@app/shared/server';
import { UnrecoverableError } from 'bullmq';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { heartbeatKey, loadConfig, messageBatchHandler, type JobContext } from '../src/index.js';
import { FakePhotoModerator } from '../src/photos/moderation.js';
import { activityRows, rollupDayOf, statsRollupJob } from '../src/stats/rollup.js';
import { closeStatsQueues } from '../src/stats/queueCounts.js';
import { statsLiveJob } from '../src/stats/live.js';
import type { WorkerServices } from '../src/services.js';
import { ensureGroupRoles, hasDatabase, loginRole, migratedDatabase, type TestDatabase } from './db.js';
import { TEST_REDIS_URL, baseEnv, connect, hasRedis } from './support.js';

/**
 * The dashboard's worker jobs on the real migrations and Valkey: retention
 * and DAU from `la:<day>` with no statement (W7 AC4), WAU and MAU as unions,
 * the rollup's catch-up, lease and statement count (the subscription
 * snapshot and places for yesterday only; today and later refused), the live
 * snapshot (schema, test accounts in today's set and their ids for the API,
 * Centrifugo's online count), the message counter (waiting for the
 * test-account set after a start), and the heartbeat's name.
 */

function untouchable<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get(_target, property) {
      if (property === 'then') return undefined;
      throw new Error(`reached ${what}.${String(property)}`);
    },
  });
}

/** An id minted at `day` (`YYYY-MM-DD`) noon plus `n`. */
function idOn(day: string, n: number): string {
  return (idFloor(Date.parse(`${day}T12:00:00Z`)) + BigInt(n)).toString();
}

const compact = (day: string) => day.replaceAll('-', '');

describe.skipIf(!hasDatabase || !hasRedis)('stats jobs (PostgreSQL, Valkey)', () => {
  let db: TestDatabase;
  let worker: Awaited<ReturnType<typeof loginRole>>;
  let pool: Pool;
  let redis: Redis;
  let ids: IdGenerator;
  let context: JobContext;
  let services: WorkerServices;
  let centrifugo: Server;
  let centrifugoAnswer: () => { status: number; body: unknown } = () => ({ status: 200, body: { result: { nodes: [] } } });
  const prefix = `t${randomBytes(4).toString('hex')}:`;
  const keys = createKeys(prefix);
  const today = statsDay(Date.now());
  const testId = idOn(statsAddDays(today, -40), 7);

  beforeAll(async () => {
    await ensureGroupRoles();
    worker = await loginRole(['app_rw', 'app_maint']);
    db = await migratedDatabase();
    pool = instrumentPool(createPool({ connectionString: db.urlFor(worker.name, worker.password), applicationName: 'stats-test', max: 3 }), statementCounter);
    redis = connect();
    ids = new IdGenerator({ redis, keyPrefix: prefix });
    await ids.start();
    centrifugo = createServer((request, response) => {
      const answer = centrifugoAnswer();
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
      request.resume();
    });
    await new Promise<void>((resolve) => centrifugo.listen(0, '127.0.0.1', resolve));
    const port = (centrifugo.address() as AddressInfo).port;
    const env = baseEnv();
    services = {
      pg: pool,
      cache: redis,
      ids,
      keys,
      publicIds: createPublicIds(env['ID_PUBLIC_KEY']!, env['ID_BILLING_KEY']!),
      realtime: new FakeRealtimePublisher(),
      media: null,
      photoModerator: new FakePhotoModerator({ autoApprove: false }),
      testAccounts: new TestAccounts({ load: async () => [testId] }),
    };
    await services.testAccounts!.ids();
    const config = loadConfig({
      ...env,
      DATABASE_URL: db.url,
      REDIS_URL: TEST_REDIS_URL ?? '',
      REDIS_KEY_PREFIX: prefix,
      WORKER_ID: 'stats-test',
      CENTRIFUGO_API_URL: `http://127.0.0.1:${port}`,
      CENTRIFUGO_API_KEY: 'test-key-0123456789abcdef',
    });
    context = { config, redis, log: pino({ level: 'silent' }), services };
  }, 90_000);

  afterAll(async () => {
    await closeStatsQueues(redis);
    await ids?.stop();
    await pool?.end();
    await new Promise<void>((resolve) => centrifugo?.close(() => resolve()));
    const left = await redis.keys(`${prefix}*`);
    if (left.length > 0) await redis.del(...left);
    await redis?.quit();
    await db?.drop();
    await worker?.drop();
  });

  async function stored(metrics: string[], day?: string): Promise<Record<string, number>> {
    const { rows } = await db.admin.query<{ k: string; v: string }>(
      `SELECT metric || '|' || day::text || '|' || dim AS k, value::text AS v FROM stats_daily
        WHERE metric = ANY ($1) AND ($2::date IS NULL OR day = $2) ORDER BY 1`,
      [metrics, day ?? null],
    );
    return Object.fromEntries(rows.map((r) => [r.k, Number(r.v)]));
  }

  it('counts DAU and day 1, 7 and 30 retention from la: alone, without one statement (AC4)', async () => {
    const day = statsAddDays(today, -3);
    const members = [
      idOn(statsAddDays(day, -1), 1),
      idOn(statsAddDays(day, -1), 2),
      idOn(statsAddDays(day, -7), 3),
      idOn(statsAddDays(day, -30), 4),
      idOn(statsAddDays(day, -3), 5),
      testId,
      'not-an-id',
    ];
    await redis.sadd(keys.activeDay(compact(day)), ...members);
    // No users row exists for these ids, and the database is out of reach of this part.
    const offline: JobContext = { ...context, services: { ...services, pg: untouchable<Pool>('pg') } };
    const { tally, result } = await statementCounter.measure(() => activityRows(offline, day, (uid) => uid === testId));
    expect(tally.statements).toBe(0);
    expect(result.dau).toBe(5);
    await statsPut(pool, result.rows);
    expect(await stored(['dau', 'ret_d1', 'ret_d7', 'ret_d30'])).toEqual({
      [`dau|${day}|`]: 5,
      [`ret_d1|${statsAddDays(day, -1)}|`]: 2,
      [`ret_d7|${statsAddDays(day, -7)}|`]: 1,
      [`ret_d30|${statsAddDays(day, -30)}|`]: 1,
    });
  });

  it('counts weekly and monthly people once across days, copies the day counters, and writes no DAU without la:', async () => {
    const first = statsAddDays(today, -12);
    const second = statsAddDays(today, -11);
    const [x, y, z] = [idOn(first, 11), idOn(first, 12), idOn(first, 13)];
    await redis.sadd(keys.activeDay(compact(first)), x, y);
    await redis.sadd(keys.activeDay(compact(second)), y, z);
    await redis.set(keys.statsCounter('like', compact(second)), '4');
    await redis.set(keys.statsCounter('push_fail', compact(second)), '2');
    await activityRows(context, first, () => false);
    const { rows, dau } = await activityRows(context, second, () => false);
    expect(dau).toBe(2);
    const byMetric = Object.fromEntries(rows.filter((r) => r.day === second).map((r) => [r.metric, r.value]));
    expect(byMetric).toMatchObject({ dau: 2, wau: 3, mau: 3, likes: 4, push_fail: 2 });
    const empty = await activityRows(context, statsAddDays(today, -20), () => false);
    expect(empty.dau).toBeNull();
    expect(empty.rows.map((r) => r.metric)).not.toContain('dau');
  });

  it('rolls up yesterday and the missing days of the week before, oldest first, about six statements a day; a second run is held', async () => {
    const yesterday = statsAddDays(today, -1);
    const marked = [6, 5, 4, 3, 1].map((back) => ({ metric: 'rollup', day: statsAddDays(yesterday, -back), value: 1 }));
    await statsPut(pool, marked);
    const { tally, result } = await statementCounter.measure(() => statsRollupJob(context, {}, Date.now()));
    expect(result.leased).toBe(true);
    expect(result.days.map((d) => d.day)).toEqual([statsAddDays(yesterday, -2), yesterday]);
    // The marker read, then 5 for a caught-up day and 6 for the newest (places).
    expect(tally.statements).toBe(1 + 5 + 6);
    const markers = await stored(['rollup']);
    expect(Object.keys(markers)).toContain(`rollup|${yesterday}|`);
    expect(Object.keys(markers)).toContain(`rollup|${statsAddDays(yesterday, -2)}|`);
    expect(await redis.get(keys.statsLastDay())).toBe(yesterday);
    expect((await statsRollupJob(context, {}, Date.now())).leased).toBe(false);
  });

  it('gives the lease back when a run fails, so the retry runs', async () => {
    const day = statsAddDays(today, -30);
    const broken: JobContext = {
      ...context,
      services: {
        ...services,
        pg: { query: async () => Promise.reject(new Error('database down')) } as unknown as Pool,
      },
    };
    await expect(statsRollupJob(broken, { day })).rejects.toThrow('database down');
    expect(await redis.exists(keys.jobLease(`stats-rollup-${compact(day)}`))).toBe(0);
    const again = await statsRollupJob(context, { day: compact(day) });
    expect(again.leased).toBe(true);
    expect(again.days.at(-1)?.day).toBe(day);
    expect(await redis.get(keys.statsLastDay())).toBe(statsAddDays(today, -1));
  });

  it('gives only yesterday the subscription snapshot and the places; refuses today and later', async () => {
    const older = statsAddDays(today, -9);
    const yesterday = statsAddDays(today, -1);
    // What the night of `older` stored: the snapshot and places of that day stay as they were.
    const night = [
      { metric: 'subs', day: older, dim: '1:1', value: 7 },
      { metric: 'subs_renewing', day: older, dim: '1:1', value: 6 },
      { metric: 'mrr', day: older, dim: '1:USD', value: 35_000_000 },
      { metric: 'active_city', day: older, dim: '101:1', value: 12 },
      { metric: 'active_country', day: older, dim: 'TR:1', value: 12 },
    ];
    await statsPut(pool, night);
    await statsPut(pool, Array.from({ length: 6 }, (_, i) => ({ metric: 'rollup', day: statsAddDays(older, -1 - i), value: 1 })));
    const { tally, result } = await statementCounter.measure(() => statsRollupJob(context, { day: older }));
    expect(result.days).toEqual([{ day: older, dau: null, statements: 5 }]);
    expect(tally.statements).toBe(1 + 5);
    expect(await stored(['subs', 'subs_renewing', 'mrr', 'active_city', 'active_country'], older)).toEqual({
      [`active_city|${older}|101:1`]: 12,
      [`active_country|${older}|TR:1`]: 12,
      [`mrr|${older}|1:USD`]: 35_000_000,
      [`subs_renewing|${older}|1:1`]: 6,
      [`subs|${older}|1:1`]: 7,
    });
    expect(Object.keys(await stored(['rollup'], older))).toEqual([`rollup|${older}|`]);

    for (const day of [today, statsAddDays(today, 1)]) {
      await expect(statsRollupJob(context, { day })).rejects.toBeInstanceOf(UnrecoverableError);
      expect(await redis.exists(keys.jobLease(`stats-rollup-${compact(day)}`))).toBe(0);
      expect(await stored(['rollup'], day)).toEqual({});
    }
    // Asked for by name, yesterday is the newest day and gets them.
    await redis.del(keys.jobLease(`stats-rollup-${compact(yesterday)}`));
    const again = await statsRollupJob(context, { day: yesterday });
    expect(again.days.at(-1)).toMatchObject({ day: yesterday, statements: 6 });
  });

  it('reads the day of a run as YYYY-MM-DD or YYYYMMDD only', () => {
    expect(rollupDayOf('2026-11-20')).toBe('2026-11-20');
    expect(rollupDayOf('20261120')).toBe('2026-11-20');
    expect(rollupDayOf('2026-02-30')).toBeNull();
    expect(rollupDayOf('yesterday')).toBeNull();
    expect(rollupDayOf(20261120)).toBeNull();
  });

  it('writes a live snapshot of the schema the API reads, with test accounts in today’s set and the online count', async () => {
    await redis.sadd(keys.activeDay(utcDay(Date.now())), testId, idOn(today, 21));
    centrifugoAnswer = () => ({ status: 200, body: { result: { nodes: [{ num_users: 3 }, { num_users: 2 }] } } });
    const first = await statsLiveJob(context);
    expect(first).toEqual({ leased: true, online: 5, testActive: 1 });
    // The test-account ids for the API's exact subtraction.
    expect(await redis.smembers(keys.statsTestIds())).toEqual([testId]);
    expect(await redis.ttl(keys.statsTestIds())).toBeGreaterThan(600);
    const snapshot = statsLiveSnapshotSchema.parse(JSON.parse((await redis.get(keys.statsLive()))!));
    expect(snapshot.day).toBe(today);
    expect(snapshot.streams.map((s) => s.name)).toEqual(['like', 'match', 'msg']);
    expect(snapshot.jobs.map((j) => j.queue)).toContain('stats');
    expect(await redis.ttl(keys.statsLive())).toBeGreaterThan(500);
    expect((await statsLiveJob(context)).leased).toBe(false);

    await redis.del(keys.jobLease('stats-live'));
    centrifugoAnswer = () => ({ status: 500, body: {} });
    expect((await statsLiveJob(context)).online).toBeNull();
  });

  it('counts a fresh batch’s people’s messages once per day, test senders and other kinds out; a replay adds nothing', async () => {
    const handler = messageBatchHandler(context);
    const sender = idOn(today, 31);
    const matchId = idOn(today, 32);
    const message = (kind: number, from: string, refId: string | null = null): StoredMessage => ({
      id: ids.nextId(),
      matchId,
      senderId: from,
      refId,
      kind,
      flags: 0,
      body: kind === 2 ? null : 'x',
    });
    const target = ids.nextId();
    const batch = [message(1, sender), message(2, sender, ids.nextId()), message(7, sender, target), message(8, sender, target), message(1, testId)];
    const entries = (source: 'new' | 'pending') =>
      batch.map((m, i) => {
        const pairs = messageEntryFields(m);
        const fields: Record<string, string> = {};
        for (let j = 0; j + 1 < pairs.length; j += 2) fields[pairs[j]!] = pairs[j + 1]!;
        return { id: `${Date.now()}-${i}`, fields, source };
      });
    const counter = keys.statsCounter('msg', utcDay(Date.now()));
    const before = Number((await redis.get(counter)) ?? 0);
    await handler(entries('new'));
    for (let i = 0; i < 50 && Number((await redis.get(counter)) ?? 0) === before; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(Number(await redis.get(counter))).toBe(before + 2);
    await handler(entries('pending'));
    await new Promise((r) => setTimeout(r, 50));
    expect(Number(await redis.get(counter))).toBe(before + 2);
    expect(await redis.ttl(counter)).toBeGreaterThan(40 * 86_400);
  });

  it('counts no message of a test sender right after a start, before the test-account set has loaded', async () => {
    const sender = idOn(today, 41);
    const tester = idOn(today, 42);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fresh = new TestAccounts({ load: async () => (await gate, [tester]) });
    const started: JobContext = { ...context, services: { ...services, testAccounts: fresh } };
    const handler = messageBatchHandler(started);
    const matchId = idOn(today, 43);
    const batch = [sender, tester].map((from) => ({ id: ids.nextId(), matchId, senderId: from, refId: null, kind: 1, flags: 0, body: 'x' }) satisfies StoredMessage);
    const counter = keys.statsCounter('msg', utcDay(Date.now()));
    const before = Number((await redis.get(counter)) ?? 0);
    await handler(
      batch.map((m, i) => {
        const pairs = messageEntryFields(m);
        const fields: Record<string, string> = {};
        for (let j = 0; j + 1 < pairs.length; j += 2) fields[pairs[j]!] = pairs[j + 1]!;
        return { id: `${Date.now()}-${i}`, fields, source: 'new' as const };
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(Number((await redis.get(counter)) ?? 0)).toBe(before);
    release();
    for (let i = 0; i < 50 && Number((await redis.get(counter)) ?? 0) === before; i += 1) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 30));
    expect(Number(await redis.get(counter))).toBe(before + 1);
  });

  it('reads the worker heartbeat under the name the worker writes', () => {
    expect(keys.workerHeartbeat()).toBe(heartbeatKey(prefix));
  });
});
