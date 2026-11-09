import { randomBytes } from 'node:crypto';
import { createMatch, createPool, instrumentPool, statementCounter, StatementCounter, type Pool } from '@app/db';
import { idFloor, userChannel, type RealtimeEnvelope } from '@app/shared';
import {
  FakePushSender,
  FakeRealtimePublisher,
  IdGenerator,
  createKeys,
  directWritesKey,
  createPublicIds,
  forgetMatch,
  readWatermark,
  runLikeScript,
  type LikeScriptInput,
} from '@app/shared/server';
import { DelayedError, Queue, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeSocialQueues,
  classifyWriteBehindError,
  defaultConsumers,
  likeBatchHandler,
  likeNotesJob,
  loadConfig,
  probeDatabase,
  matchEntryHandler,
  nextStreamId,
  sendPushJob,
  startBatchConsumer,
  startStreamConsumer,
  streamPosition,
  trimPoint,
  unwrittenSince,
  type BatchConsumer,
  type JobContext,
  type LikeBatchStats,
  type MatchStats,
} from '../src/index.js';
import { deckSettingsOf } from '../src/deck/settings.js';
import { FakePhotoModerator } from '../src/photos/moderation.js';
import { unmatchPurgeJob } from '../src/queues/unmatch.js';
import type { WorkerServices } from '../src/services.js';
import { ensureGroupRoles, hasDatabase, loginRole, migratedDatabase, type TestDatabase } from './db.js';
import { TEST_REDIS_URL, baseEnv, connect, eventually, hasRedis } from './support.js';

/**
 * The write-behind pipeline of likes and matches against PostgreSQL and
 * Valkey: the batch mode of the stream consumer (one INSERT per batch, the
 * trim and the watermark), the `wb:like` writer, the `wb:match` consumer,
 * and the jobs they queue (pushes, like notes), plus the unmatch purge. The
 * code under test runs as the worker's own role (app_rw).
 */

type FakeJob<T> = Job<T> & { delayedUntil?: number };

function fakeJob<T>(name: string, data: T): FakeJob<T> {
  const job = {
    name,
    data,
    id: `${name}.test`,
    async moveToDelayed(timestamp: number) {
      job.delayedUntil = timestamp;
    },
  } as unknown as FakeJob<T>;
  return job;
}

describe.skipIf(!hasDatabase || !hasRedis)('the write-behind pipeline of likes and matches (PostgreSQL, Valkey)', () => {
  let db: TestDatabase;
  let pg: Pool;
  let redis: Redis;
  let ids: IdGenerator;
  let realtime: FakeRealtimePublisher;
  let push: FakePushSender;
  let services: WorkerServices;
  let context: JobContext;
  let role: Awaited<ReturnType<typeof loginRole>>;
  const prefix = `t${randomBytes(4).toString('hex')}:`;
  const keys = createKeys(prefix);
  const env = baseEnv();
  const publicIds = createPublicIds(env['ID_PUBLIC_KEY']!, env['ID_BILLING_KEY']!);
  const extra: Redis[] = [];

  beforeAll(async () => {
    await ensureGroupRoles();
    role = await loginRole(['app_rw']);
    db = await migratedDatabase();
    pg = instrumentPool(createPool({ connectionString: db.urlFor(role.name, role.password), applicationName: 'wb-test', max: 6 }), statementCounter);
    redis = connect();
    ids = new IdGenerator({ redis, keyPrefix: prefix });
    await ids.start();
    realtime = new FakeRealtimePublisher();
    push = new FakePushSender();
    services = {
      pg,
      cache: redis,
      ids,
      keys,
      publicIds,
      realtime,
      media: null,
      photoModerator: new FakePhotoModerator({ autoApprove: false }),
      push,
    };
    const config = loadConfig({ ...env, DATABASE_URL: db.url, REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix, WORKER_ID: 'wb-test' });
    context = { config, redis, log: pino({ level: 'silent' }), services, token: 'test-token' };
    await redis.set(keys.likesReady(), '1');
  }, 90_000);

  afterAll(async () => {
    await closeSocialQueues(redis);
    await Promise.allSettled(extra.map((c) => c.quit()));
    await ids?.stop();
    await pg?.end();
    const left = await redis.keys(`${prefix}*`);
    if (left.length > 0) await redis.del(...left);
    await redis?.quit();
    await db?.drop();
    await role?.drop();
  });

  beforeEach(() => {
    realtime.published.length = 0;
    push.sent.length = 0;
  });

  function connection(): Redis {
    const c = connect();
    extra.push(c);
    return c;
  }

  async function value<T>(text: string, values: unknown[] = []): Promise<T> {
    const { rows } = await db.admin.query(text, values);
    return Object.values(rows[0] as Record<string, T>)[0] as T;
  }

  async function person(options: { name?: string; status?: number; acceptCalls?: boolean } = {}): Promise<string> {
    const id = ids.nextId();
    await db.admin.query(`INSERT INTO users (id, status, birth_date, gender, country, onboarding_step) VALUES ($1, $2, DATE '1994-05-17', 2, 'IR', 30)`, [
      id,
      options.status ?? 3,
    ]);
    await db.admin.query(`INSERT INTO profiles (user_id, display_name, accept_calls) VALUES ($1, $2, $3)`, [id, options.name ?? 'Sam Lee', options.acceptCalls ?? true]);
    return id;
  }

  function like(actorId: string, targetId: string, extraInput: Partial<LikeScriptInput> = {}): LikeScriptInput {
    return {
      actorId,
      targetId,
      likeId: ids.nextId(),
      kind: 1,
      itemKind: 0,
      matchId: ids.nextId(),
      noteIds: [ids.nextId(), ids.nextId()],
      prepaid: false,
      bucketCap: 3_000,
      ...extraInput,
    };
  }

  /** The like writer as the worker runs it (its failure handling included), on a stream of the test's choice. */
  function likeConsumer(
    stream: string,
    stats: LikeBatchStats,
    options: { lingerMs?: number; claimIdleMs?: number; maxDeliveries?: number; classify?: typeof classifyWriteBehindError } = {},
  ): BatchConsumer {
    return startBatchConsumer({
      redis: connection(),
      stream,
      group: 'pg',
      consumer: 'wb-test',
      handler: likeBatchHandler(context, stats),
      blockMs: 100,
      watermarkKey: keys.streamWatermark('like'),
      classify: classifyWriteBehindError,
      probe: () => probeDatabase(context),
      maxDeliveries: 0,
      redactFields: ['c'],
      ...options,
    });
  }

  const stats = (): LikeBatchStats => ({ batches: 0, rows: 0, inserted: 0, checked: 0, matched: 0, told: 0 });

  describe('the batch mode and the wb:like writer', () => {
    it('writes 10,000 likes in at most 40 INSERT statements at the default linger, then trims the stream and moves the watermark past them', async () => {
      const stream = keys.stream('like');
      const s = stats();
      // The settings the writer reads (the likes window) are loaded once per process, before the count starts.
      await deckSettingsOf(services, redis, context.log).get();
      const tally = StatementCounter.tally();
      // Everything the consumer starts runs inside this tally (AsyncLocalStorage follows it).
      const consumer = statementCounter.run(tally, () => likeConsumer(stream, s));
      const producers = Array.from({ length: 8 }, () => connection());
      const actors = Array.from({ length: 40 }, () => ids.nextId());
      const targets = Array.from({ length: 250 }, () => ids.nextId());
      const all: LikeScriptInput[] = [];
      for (const actor of actors) for (const target of targets) all.push(like(actor, target));
      expect(all).toHaveLength(10_000);
      let next = 0;
      const started = Date.now();
      await Promise.all(
        producers.map(async (producer) => {
          while (next < all.length) {
            const input = all[next]!;
            next += 1;
            expect(await runLikeScript(producer, keys, input)).toBe('liked');
          }
        }),
      );
      const producedMs = Date.now() - started;
      await eventually(async () => Number(await value<string>(`SELECT count(*)::text FROM likes`)) >= 10_000, 30_000);
      await consumer.stop();
      expect(Number(await value<string>(`SELECT count(*)::text FROM likes`))).toBe(10_000);
      expect(s.rows).toBe(10_000);
      expect(s.inserted).toBe(10_000);
      expect(s.batches).toBeLessThanOrEqual(40);
      // Every statement the writer sent was one batch INSERT with the check of who may be told (`WITH batch AS (... INSERT INTO likes ...)`; the tally keeps first lines).
      expect(tally.statements).toBe(s.batches);
      expect(tally.texts.every((t) => t.startsWith('WITH batch AS ('))).toBe(true);
      expect(await redis.xlen(stream)).toBe(0);
      // Nothing is pending: the watermark is Valkey's clock minus the margin, past every like made more than 5 s ago.
      const watermark = await readWatermark(redis, keys, 'like');
      expect(watermark).not.toBeNull();
      expect(watermark! >= idFloor(started - 5_000)).toBe(true);
      if (process.env['SHOW_STATS']) console.log('10k likes', { producedMs, batches: s.batches });
    }, 60_000);

    it('replays a batch without a second row, and moves a malformed entry to the dead letters at once', async () => {
      const stream = `${prefix}wb:replay`;
      const s = stats();
      const [a, b] = [ids.nextId(), ids.nextId()];
      const fields = (likeId: string) => ['id', likeId, 't', b, 'a', a, 'k', '1', 'ik', '0', 'ir', '', 'c', 'hi', 'x', '0', 'w', '0'];
      const likeId = ids.nextId();
      await redis.xadd(stream, '*', ...fields(likeId));
      await redis.xadd(stream, '*', ...fields(likeId));
      await redis.xadd(stream, '*', 'id', 'not-an-id', 't', b, 'a', a, 'k', '1', 'ik', '0');
      const consumer = likeConsumer(stream, s, { lingerMs: 0 });
      await eventually(async () => (await redis.xlen(`${stream}:dead`)) === 1);
      await eventually(() => s.rows === 2);
      await consumer.stop();
      expect(await value<string>(`SELECT count(*)::text FROM likes WHERE id = $1`, [likeId])).toBe('1');
      expect(s.inserted).toBe(1);
      const dead = ((await redis.xrange(`${stream}:dead`, '-', '+')) as [string, string[]][])[0]?.[1];
      expect(dead).toEqual(expect.arrayContaining(['reason', 'malformed']));
    });

    it('retries a failing batch entry by entry, writes the rest, and dead-letters at once the entry the database refuses, without its comment', async () => {
      const stream = `${prefix}wb:poison`;
      const s = stats();
      const [a, b, c] = [ids.nextId(), ids.nextId(), ids.nextId()];
      const good = [ids.nextId(), ids.nextId(), ids.nextId()];
      await redis.xadd(stream, '*', 'id', good[0]!, 't', b, 'a', a, 'k', '1', 'ik', '0', 'ir', '', 'c', '', 'x', '0', 'w', '0');
      // A like of oneself breaks the table's CHECK (a data error): the INSERT of any batch holding it fails.
      const refused = ids.nextId();
      await redis.xadd(stream, '*', 'id', refused, 't', a, 'a', a, 'k', '1', 'ik', '0', 'ir', '', 'c', 'my secret words', 'x', '0', 'w', '0');
      await redis.xadd(stream, '*', 'id', good[1]!, 't', c, 'a', b, 'k', '1', 'ik', '0', 'ir', '', 'c', '', 'x', '0', 'w', '0');
      // A comment PostgreSQL would refuse (NUL, past 300 characters), from before the API refused them: the like is kept without it.
      await redis.xadd(stream, '*', 'id', good[2]!, 't', c, 'a', a, 'k', '1', 'ik', '0', 'ir', '', 'c', 'hi\u0000there', 'x', '0', 'w', '0');
      // No claim and no delivery count is needed for a refused entry.
      const consumer = likeConsumer(stream, s, { lingerMs: 0, claimIdleMs: 60_000 });
      await eventually(async () => (await redis.xlen(`${stream}:dead`)) === 1, 10_000);
      await eventually(async () => ((await redis.xpending(stream, 'pg')) as [number])[0] === 0, 10_000);
      await consumer.stop();
      expect(await value<string>(`SELECT count(*)::text FROM likes WHERE id = ANY ($1::bigint[])`, [good])).toBe('3');
      expect(await value<string | null>(`SELECT comment FROM likes WHERE id = $1`, [good[2]])).toBeNull();
      const dead = ((await redis.xrange(`${stream}:dead`, '-', '+')) as [string, string[]][])[0]?.[1];
      expect(dead).toEqual(expect.arrayContaining(['reason', 'rejected', 'id']));
      // The dead letter keeps the entry, not what the person wrote.
      expect(JSON.stringify(dead)).toContain(refused);
      expect(JSON.stringify(dead)).not.toContain('my secret words');
    });

    it('still dead-letters by delivery count where a stream asks for it (no classification)', async () => {
      const stream = `${prefix}wb:counted`;
      const s = stats();
      const a = ids.nextId();
      await redis.xadd(stream, '*', 'id', ids.nextId(), 't', a, 'a', a, 'k', '1', 'ik', '0', 'ir', '', 'c', '', 'x', '0', 'w', '0');
      const consumer = likeConsumer(stream, s, { lingerMs: 0, claimIdleMs: 200, maxDeliveries: 2, classify: () => 'failed' });
      await eventually(async () => (await redis.xlen(`${stream}:dead`)) === 1, 10_000);
      await consumer.stop();
      const dead = ((await redis.xrange(`${stream}:dead`, '-', '+')) as [string, string[]][])[0]?.[1];
      expect(dead).toEqual(expect.arrayContaining(['reason', 'deliveries']));
      expect(((await redis.xpending(stream, 'pg')) as [number])[0]).toBe(0);
    });

    it('trims only below the oldest pending entry and the last delivered one, and keeps the watermark below what is unwritten', async () => {
      const stream = `${prefix}wb:trim`;
      await redis.xgroup('CREATE', stream, 'pg', '0', 'MKSTREAM');
      // No consumer yet: nothing delivered, nothing may go.
      const written: string[] = [];
      for (let i = 0; i < 5; i += 1) written.push((await redis.xadd(stream, '*', 'n', String(i)))!);
      let position = await streamPosition(redis, stream, 'pg');
      expect(position).toMatchObject({ pending: 0, oldestPending: null, lastDelivered: '0-0', lastEntry: written[4] });
      expect(trimPoint(position)).toBe('0-1');
      expect(unwrittenSince(position!)).toBe(0);
      // Three delivered, one of them acknowledged: the two others stay pending.
      await redis.xreadgroup('GROUP', 'pg', 'c1', 'COUNT', 3, 'STREAMS', stream, '>');
      await redis.xack(stream, 'pg', written[0]!);
      position = await streamPosition(redis, stream, 'pg');
      expect(position).toMatchObject({ pending: 2, oldestPending: written[1], lastDelivered: written[2] });
      expect(trimPoint(position)).toBe(written[1]);
      await redis.xtrim(stream, 'MINID', trimPoint(position)!);
      expect((await redis.xrange(stream, '-', '+')).map(([id]) => id)).toEqual(written.slice(1));
      expect(unwrittenSince(position!)).toBe(Number(written[1]!.split('-')[0]));
      // All acknowledged, two not delivered yet: the trim stops at the next undelivered one.
      await redis.xack(stream, 'pg', written[1]!, written[2]!);
      position = await streamPosition(redis, stream, 'pg');
      expect(trimPoint(position)).toBe(nextStreamId(written[2]!));
      await redis.xtrim(stream, 'MINID', trimPoint(position)!);
      expect((await redis.xrange(stream, '-', '+')).map(([id]) => id)).toEqual(written.slice(3));
      // A group that cannot be read: no trim at all.
      expect(trimPoint(await streamPosition(redis, stream, 'nobody'))).toBeNull();
    });

    it('finds the mutual like of a popular person that was still in the stream when the API looked', async () => {
      const stream = `${prefix}wb:check`;
      const matchStream = keys.stream('match');
      const s = stats();
      const popular = await person({ name: 'Popular' });
      const fan = await person({ name: 'Fan' });
      const other = await person();
      // The popular person's bucket is at its cap (1): the fan's like is not in it.
      const scripts = { ...keys, stream: (name: 'like' | 'match' | 'msg') => (name === 'like' ? stream : keys.stream(name)) };
      expect(await runLikeScript(redis, scripts, like(other, popular, { bucketCap: 1 }))).toBe('liked');
      expect(await runLikeScript(redis, scripts, like(fan, popular, { bucketCap: 1 }))).toBe('liked');
      const back = like(popular, fan, { bucketCap: 1 });
      expect(await runLikeScript(redis, scripts, back)).toBe('check');
      const before = await redis.xlen(matchStream);
      const consumer = likeConsumer(stream, s, { lingerMs: 0 });
      await eventually(() => s.matched === 1);
      await consumer.stop();
      expect(s.checked).toBe(1);
      const entries = await redis.xrange(matchStream, '-', '+');
      expect(entries.length).toBe(before + 1);
      const fields = entries.at(-1)![1];
      expect(fields).toEqual(expect.arrayContaining(['a', popular, 't', fan, 'l', back.likeId]));
    });
  });

  describe('who hears of a like', () => {
    async function pushJobsFor(userId: string): Promise<Job[]> {
      const q = new Queue('push', { connection: redis, prefix: context.config.queuePrefix });
      try {
        return (await q.getJobs(['delayed', 'waiting', 'active', 'completed', 'failed'])).filter(
          (j) => (j.data as { type?: string; userId?: string }).type === 'like' && (j.data as { userId?: string }).userId === userId,
        );
      } finally {
        await q.close();
      }
    }

    function likeEvents(userId: string): RealtimeEnvelope[] {
      return realtime.on(userChannel(publicIds.user.encode(userId))).filter((e) => e.t === 'like');
    }

    it('tells the target of a like only when the pair is clear: not after a block, from a shadowbanned or test account, or an ex', async () => {
      const stream = `${prefix}wb:tell`;
      const scripts = { ...keys, stream: (name: 'like' | 'match' | 'msg') => (name === 'like' ? stream : keys.stream(name)) };
      const s = stats();
      const target = await person({ name: 'Tara Moon' });
      const fan = await person({ name: 'Finn Gray' });
      const superFan = await person({ name: 'Sami Reed' });
      const blocked = await person({ name: 'Blake Doe' });
      const shadow = await person({ name: 'Shay Low' });
      const tester = await person({ name: 'Test Person' });
      const ex = await person({ name: 'Ex Friend' });
      const pair = (a: string, b: string) => (BigInt(a) < BigInt(b) ? [a, b] : [b, a]);
      // The block's row only (as after a Valkey loss took its marker): the writer checks the pair itself.
      await db.admin.query(`INSERT INTO blocks (user_lo, user_hi, blocked_by) VALUES ($1, $2, 3)`, pair(target, blocked));
      await db.admin.query(`UPDATE users SET is_shadowbanned = true WHERE id = $1`, [shadow]);
      await db.admin.query(`UPDATE users SET flags = flags | 1 WHERE id = $1`, [tester]);
      await db.admin.query(`INSERT INTO matches (id, user_lo, user_hi, source, state, ended_at, ended_by) VALUES ($1, $2, $3, 1, 2, now(), 1)`, [
        ids.nextId(),
        ...pair(target, ex),
      ]);
      const plain = like(fan, target);
      const loud = like(superFan, target, { kind: 2 });
      expect(await runLikeScript(redis, scripts, plain)).toBe('liked');
      expect(await runLikeScript(redis, scripts, loud)).toBe('liked');
      for (const quiet of [blocked, shadow, tester, ex]) expect(await runLikeScript(redis, scripts, like(quiet, target, { kind: 2 }))).toBe('liked');
      // Someone the people above liked, who hears nothing at all.
      const other = await person();
      for (const quiet of [shadow, tester]) expect(await runLikeScript(redis, scripts, like(quiet, other, { kind: 2 }))).toBe('liked');
      await db.admin.query(`INSERT INTO blocks (user_lo, user_hi, blocked_by) VALUES ($1, $2, 1)`, pair(other, blocked));
      expect(await runLikeScript(redis, scripts, like(blocked, other))).toBe('liked');

      const consumer = likeConsumer(stream, s, { lingerMs: 50 });
      await eventually(() => s.rows === 9);
      await consumer.stop();
      expect(s.inserted).toBe(9);
      expect(s.told).toBe(2);
      const events = likeEvents(target);
      expect(events.map((e) => e.id).sort()).toEqual([plain.likeId, loud.likeId].sort());
      const superEvent = events.find((e) => e.id === loud.likeId)!;
      expect(superEvent.d).toMatchObject({ kind: 'superlike', from: { id: publicIds.user.encode(superFan), name: 'Sami Reed' } });
      expect((events.find((e) => e.id === plain.likeId)!.d as { from?: unknown }).from).toBeUndefined();
      // `total` counts the bucket, where the quiet likes still sit (never shown: the likes page applies the visibility rule).
      expect((superEvent.d as { total: number }).total).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(events)).not.toContain(target);
      expect(await pushJobsFor(target)).toHaveLength(1);
      expect(likeEvents(other)).toHaveLength(0);
      expect(await pushJobsFor(other)).toHaveLength(0);
    });

    it('tells a like sent again once, and a like that made a match not at all', async () => {
      const stream = `${prefix}wb:tell-once`;
      const scripts = { ...keys, stream: (name: 'like' | 'match' | 'msg') => (name === 'like' ? stream : keys.stream(name)) };
      const s = stats();
      const target = await person();
      const fan = await person();
      const first = like(fan, target);
      expect(await runLikeScript(redis, scripts, first)).toBe('liked');
      const consumer = likeConsumer(stream, s, { lingerMs: 0 });
      await eventually(() => s.rows === 1);
      // The same pair again with a new id (the bucket missed it: a resend to a bucket at its cap, a pass in between).
      const again = ids.nextId();
      await redis.xadd(stream, '*', 'id', again, 't', target, 'a', fan, 'k', '1', 'ik', '0', 'ir', '', 'c', '', 'x', '0', 'w', '0', 'm', '0');
      // A like that made a match: the match is announced, not the like.
      const [a, b] = [await person(), await person()];
      expect(await runLikeScript(redis, scripts, like(a, b))).toBe('liked');
      const back = like(b, a);
      expect(await runLikeScript(redis, scripts, back)).toBe('match');
      await eventually(() => s.rows === 4);
      await consumer.stop();
      expect(likeEvents(target).map((e) => e.id)).toEqual([first.likeId]);
      expect(likeEvents(a)).toHaveLength(0);
      expect(likeEvents(b).map((e) => e.id)).toHaveLength(1);
    });
  });

  describe('a PostgreSQL outage', () => {
    it('loses nothing when the database refuses connections for longer than maxDeliveries × claimIdleMs: nothing is dead-lettered, every like and match is written once it is back', async () => {
      const outPrefix = `t${randomBytes(4).toString('hex')}:`;
      const outKeys = createKeys(outPrefix);
      const outConfig = loadConfig({ ...env, DATABASE_URL: db.url, REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: outPrefix, WORKER_ID: 'wb-outage' });
      const refusing = createPool({ connectionString: 'postgres://nobody:nothing@127.0.0.1:1/none', applicationName: 'wb-outage', max: 2, connectTimeoutMs: 200 });
      const outServices: WorkerServices = { ...services, keys: outKeys, realtime: new FakeRealtimePublisher() };
      const outContext: JobContext = { ...context, config: outConfig, services: outServices };
      // The writer's settings are loaded while the database is up (they stay in memory).
      await deckSettingsOf(outServices, redis, context.log).get();
      await redis.set(outKeys.likesReady(), '1');
      outServices.pg = refusing;
      const consumers: { stop(): Promise<void> }[] = [];
      try {
        const people = await Promise.all(Array.from({ length: 6 }, () => person()));
        const made: LikeScriptInput[] = [];
        for (let i = 0; i < people.length; i += 2) {
          const [x, y] = [people[i]!, people[i + 1]!];
          const first = like(x, y);
          const back = like(y, x);
          expect(await runLikeScript(redis, outKeys, first)).toBe('liked');
          expect(await runLikeScript(redis, outKeys, back)).toBe('match');
          made.push(first, back);
        }
        for (let i = 0; i < 4; i += 1) {
          const l = like(ids.nextId(), people[0]!);
          expect(await runLikeScript(redis, outKeys, l)).toBe('liked');
          made.push(l);
        }
        // The worker's own consumers, with short timings and a delivery limit that an outage would exhaust many times over.
        const timings = { claimIdleMs: 100, claimIntervalMs: 100, maxDeliveries: 3, blockMs: 50, consumer: 'wb-outage' };
        for (const definition of defaultConsumers(outConfig)) {
          const probeOf = definition.probe;
          const probe = probeOf ? () => probeOf(outContext) : undefined;
          if (definition.kind === 'batch') {
            consumers.push(
              startBatchConsumer({ ...definition, ...timings, lingerMs: 0, redis: connection(), probe, handler: (entries) => definition.handler(entries, outContext) }),
            );
          } else {
            consumers.push(startStreamConsumer({ ...definition, ...timings, redis: connection(), probe, handler: (entry) => definition.handler(entry, outContext) }));
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        for (const name of ['like', 'match'] as const) expect(await redis.xlen(outKeys.streamDead(name))).toBe(0);
        expect(await value<string>(`SELECT count(*)::text FROM likes WHERE id = ANY ($1::bigint[])`, [made.map((l) => l.likeId)])).toBe('0');

        outServices.pg = pg;
        await eventually(async () => Number(await value<string>(`SELECT count(*)::text FROM likes WHERE id = ANY ($1::bigint[])`, [made.map((l) => l.likeId)])) === made.length, 20_000);
        const matchIds = made.filter((_, i) => i < 6 && i % 2 === 1).map((l) => l.matchId);
        await eventually(async () => Number(await value<string>(`SELECT count(*)::text FROM matches WHERE id = ANY ($1::bigint[])`, [matchIds])) === 3, 20_000);
        for (const name of ['like', 'match'] as const) {
          expect(await redis.xlen(outKeys.streamDead(name))).toBe(0);
          await eventually(async () => ((await redis.xpending(outKeys.stream(name), 'pg')) as [number])[0] === 0, 10_000);
        }
      } finally {
        await Promise.allSettled(consumers.map((c) => c.stop()));
        await refusing.end().catch(() => undefined);
        const left = await redis.keys(`${outPrefix}*`);
        if (left.length > 0) await redis.del(...left);
      }
    }, 60_000);

    it('sorts failures: an unreachable database waits, a refused row is dead-lettered, anything else is retried', async () => {
      const refusing = createPool({ connectionString: 'postgres://nobody:nothing@127.0.0.1:1/none', applicationName: 'wb-classify', max: 1, connectTimeoutMs: 200 });
      try {
        const down = await refusing.query('SELECT 1').catch((error: unknown) => error);
        expect(classifyWriteBehindError(down)).toBe('unavailable');
        const nul = await pg.query(`SELECT $1::text`, ['a\u0000b']).catch((error: unknown) => error);
        expect(classifyWriteBehindError(nul)).toBe('rejected');
        const check = await pg.query(`INSERT INTO likes (target_id, actor_id, id, kind) VALUES (1, 1, $1, 1)`, [ids.nextId()]).catch((error: unknown) => error);
        expect(classifyWriteBehindError(check)).toBe('rejected');
        expect(classifyWriteBehindError(new Error('something else'))).toBe('failed');
      } finally {
        await refusing.end().catch(() => undefined);
      }
    });
  });

  describe('the wb:match consumer', () => {
    function matchConsumer(stats: MatchStats) {
      return startStreamConsumer({
        redis: connection(),
        stream: keys.stream('match'),
        group: 'pg',
        consumer: 'wb-test',
        startId: '0',
        blockMs: 100,
        concurrency: 8,
        handler: matchEntryHandler(context, { graceMs: 0, stats }),
      });
    }

    function conversationEvents(userId: string): RealtimeEnvelope[] {
      return realtime.on(userChannel(publicIds.user.encode(userId))).filter((e) => e.t === 'conversation');
    }

    async function queuedJobs(queue: string): Promise<Job[]> {
      const q = new Queue(queue, { connection: redis, prefix: context.config.queuePrefix });
      try {
        return await q.getJobs(['delayed', 'waiting', 'active', 'completed', 'failed']);
      } finally {
        await q.close();
      }
    }

    it('makes the match when the API died right after the like script answered match, exactly once', async () => {
      const a = await person({ name: 'Ava Stone', acceptCalls: false });
      const b = await person({ name: 'Ben Hart' });
      expect(await runLikeScript(redis, keys, like(a, b, { comment: 'Your hike photo!' }))).toBe('liked');
      const back = like(b, a, { kind: 2, comment: 'Hi Ava' });
      expect(await runLikeScript(redis, keys, back)).toBe('match');
      // No INSERT by the API: it "died". The worker makes it.
      const s: MatchStats = { entries: 0, announced: 0, skipped: 0 };
      const consumer = matchConsumer(s);
      await eventually(() => s.announced >= 1);
      await consumer.stop();
      expect(await value<string>(`SELECT count(*)::text FROM matches WHERE user_lo = least($1::bigint, $2::bigint) AND user_hi = greatest($1::bigint, $2::bigint)`, [a, b])).toBe('1');
      expect(await value<string>(`SELECT id::text FROM matches WHERE user_lo = least($1::bigint, $2::bigint) AND user_hi = greatest($1::bigint, $2::bigint)`, [a, b])).toBe(back.matchId);
      // Super like, and only b allows calls.
      expect(await value<number>(`SELECT source FROM matches WHERE id = $1`, [back.matchId])).toBe(2);
      const toA = conversationEvents(a);
      const toB = conversationEvents(b);
      expect(toA).toHaveLength(1);
      expect(toB).toHaveLength(1);
      expect(toA[0]!.id).toBe(back.matchId);
      expect(toA[0]!.d).toMatchObject({ reason: 'matched', conversation: { id: back.matchId, peer: { id: publicIds.user.encode(b), name: 'Ben Hart' }, source: 'super_like', callsAllowed: { me: false, peer: true }, lastMessage: null } });
      expect(toB[0]!.d).toMatchObject({ conversation: { peer: { name: 'Ava Stone' }, callsAllowed: { me: true, peer: false } } });
      // Nothing in the events names a raw id.
      expect(JSON.stringify([toA, toB])).not.toContain(a);
      // The lists and the state know it; nobody is the other's pending liker.
      expect(await redis.zscore(keys.conversationList(a), back.matchId)).not.toBeNull();
      expect(await redis.hget(keys.matchState(back.matchId), 'st')).toBe('1');
      const pushes = (await queuedJobs('push')).filter((j) => (j.data as { conversationId?: string }).conversationId === back.matchId);
      expect(pushes.map((j) => (j.data as { userId: string }).userId).sort()).toEqual([a, b].sort());
      const notes = (await queuedJobs('chat')).filter((j) => (j.data as { matchId?: string }).matchId === back.matchId);
      expect(notes).toHaveLength(1);
    });

    it('agrees with the fast path: the API\'s INSERT first, one announcement, no second row', async () => {
      const a = await person();
      const b = await person();
      expect(await runLikeScript(redis, keys, like(a, b))).toBe('liked');
      const back = like(b, a);
      expect(await runLikeScript(redis, keys, back)).toBe('match');
      const row = await createMatch(pg, { matchId: back.matchId, actorId: b, targetId: a, source: 1 });
      expect(row).toMatchObject({ id: back.matchId, created: true });
      const s: MatchStats = { entries: 0, announced: 0, skipped: 0 };
      const consumer = matchConsumer(s);
      await eventually(() => conversationEvents(a).length === 1);
      await consumer.stop();
      expect(await value<string>(`SELECT count(*)::text FROM matches WHERE id = $1`, [back.matchId])).toBe('1');
      expect(conversationEvents(b)).toHaveLength(1);
    });

    it('announces nothing for a match whose conversation ended after its row was read (the end\'s tombstone)', async () => {
      const a = await person();
      const b = await person();
      expect(await runLikeScript(redis, keys, like(a, b))).toBe('liked');
      const back = like(b, a);
      expect(await runLikeScript(redis, keys, back)).toBe('match');
      // The match is in PostgreSQL and still active when the worker reads it; the unmatch's Valkey side ran just before the announcement.
      expect(await createMatch(pg, { matchId: back.matchId, actorId: b, targetId: a, source: 1 })).toMatchObject({ created: true, state: 1 });
      const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
      await forgetMatch(redis, keys, { id: back.matchId, lo, hi });
      const s: MatchStats = { entries: 0, announced: 0, skipped: 0 };
      const consumer = matchConsumer(s);
      await eventually(() => s.skipped >= 1);
      await consumer.stop();
      expect(s.announced).toBe(0);
      expect(conversationEvents(a)).toHaveLength(0);
      expect(conversationEvents(b)).toHaveLength(0);
      expect(await redis.zscore(keys.conversationList(a), back.matchId)).toBeNull();
      expect(await redis.exists(keys.matchState(back.matchId))).toBe(0);
    });

    it('announces nothing for a pair that may not match (a block) or that matched before', async () => {
      const a = await person();
      const b = await person();
      const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
      await db.admin.query(`INSERT INTO blocks (user_lo, user_hi, blocked_by) VALUES ($1, $2, 1)`, [lo, hi]);
      expect(await runLikeScript(redis, keys, like(a, b))).toBe('liked');
      expect(await runLikeScript(redis, keys, like(b, a))).toBe('match');
      const c = await person();
      const d = await person();
      const [clo, chi] = BigInt(c) < BigInt(d) ? [c, d] : [d, c];
      await db.admin.query(`INSERT INTO matches (id, user_lo, user_hi, source, state, ended_at, ended_by) VALUES ($1, $2, $3, 1, 2, now(), 1)`, [ids.nextId(), clo, chi]);
      expect(await runLikeScript(redis, keys, like(c, d))).toBe('liked');
      expect(await runLikeScript(redis, keys, like(d, c))).toBe('match');
      const s: MatchStats = { entries: 0, announced: 0, skipped: 0 };
      const consumer = matchConsumer(s);
      await eventually(() => s.skipped >= 2);
      await consumer.stop();
      expect(await value<string>(`SELECT count(*)::text FROM matches WHERE user_lo = $1 AND user_hi = $2`, [lo, hi])).toBe('0');
      expect(await value<string>(`SELECT count(*)::text FROM matches WHERE user_lo = $1 AND user_hi = $2`, [clo, chi])).toBe('1');
      for (const u of [a, b, c, d]) expect(conversationEvents(u)).toHaveLength(0);
    });
  });

  describe('the jobs the pipeline queues', () => {
    async function device(userId: string, token: string, locale = 'en'): Promise<string> {
      const deviceId = ids.nextId();
      await db.admin.query(
        `INSERT INTO devices (id, user_id, app_version, platform, store, locale, push_token, push_token_hash) VALUES ($1, $2, 100, 1, 2, $3, $4::text, sha256(convert_to($4::text, 'UTF8')))`,
        [deviceId, userId, locale, token],
      );
      await db.admin.query(`INSERT INTO sessions (id, user_id, device_id, expires_at, store, refresh_hash) VALUES ($1, $2, $3, now() + interval '30 days', 2, $4)`, [
        ids.nextId(),
        userId,
        deviceId,
        randomBytes(32),
      ]);
      return deviceId;
    }

    it('sends a match push in each device\'s language, names the peer only with previews, and clears a dead token', async () => {
      const a = await person();
      await device(a, 'token-fa-1', 'fa');
      const dead = await device(a, 'token-dead-1', 'en');
      push.deadTokens.add('token-dead-1');
      const conversationId = ids.nextId();
      const { result, tally } = await statementCounter.measure(() =>
        sendPushJob(fakeJob('send', { type: 'match', userId: a, conversationId, peerName: 'Negar Ahmadi' }), context),
      );
      expect(result).toEqual({ outcome: 'sent', devices: 2, failed: 1, cleared: 1 });
      // The targets (1) and the dead token (1).
      expect(tally.statements).toBe(2);
      expect(push.sent).toHaveLength(1);
      expect(push.sent[0]!.payload).toMatchObject({ type: 'match', channel: 'matches', tag: `m:${conversationId}`, title: 'مچ تازه دارید', body: 'تا داغ است سلام کنید.', data: { type: 'match', conversationId } });
      expect(push.sent[0]!.payload.body).not.toContain('Negar');
      expect(await value<string | null>(`SELECT push_token FROM devices WHERE id = $1`, [dead])).toBeNull();

      await db.admin.query(`UPDATE users SET notify_flags = notify_flags | 32 WHERE id = $1`, [a]);
      await sendPushJob(fakeJob('send', { type: 'match', userId: a, conversationId, peerName: 'Negar Ahmadi' }), context);
      expect(push.sent.at(-1)!.payload.body).toBe('شما و Negar مچ شدید.');
      await db.admin.query(`UPDATE users SET notify_flags = notify_flags & ~2 WHERE id = $1`, [a]);
      expect(await sendPushJob(fakeJob('send', { type: 'match', userId: a, conversationId }), context)).toEqual({ outcome: 'skipped', reason: 'switched_off' });
    });

    it('says how many likes wait when the like push runs, and sends nothing when none wait', async () => {
      const target = await person();
      await device(target, 'token-like-1', 'tr');
      expect(await sendPushJob(fakeJob('send', { type: 'like', userId: target }), context)).toEqual({ outcome: 'skipped', reason: 'nothing_pending' });
      for (let i = 0; i < 3; i += 1) await runLikeScript(redis, keys, like(ids.nextId(), target));
      expect(await sendPushJob(fakeJob('send', { type: 'like', userId: target }), context)).toMatchObject({ outcome: 'sent', devices: 1 });
      expect(push.sent.at(-1)!.payload).toMatchObject({ type: 'like', tag: 'likes', data: { type: 'like', total: '3' }, title: 'Yeni beğeni', body: '3 kişi seni beğendi.' });
      // A push never carries an id of a person or a name of a liker.
      expect(JSON.stringify(push.sent.at(-1))).not.toContain(target);
    });

    it('writes the like notes once wb:like is durable past the second like, once, and publishes them', async () => {
      const a = await person();
      const b = await person();
      const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
      const matchId = ids.nextId();
      await db.admin.query(`INSERT INTO matches (id, user_lo, user_hi, source) VALUES ($1, $2, $3, 4)`, [matchId, lo, hi]);
      const first = ids.nextId();
      await db.admin.query(`INSERT INTO likes (target_id, actor_id, id, item_ref, kind, item_kind, comment) VALUES ($1, $2, $3, 55, 1, 1, 'That view')`, [b, a, first]);
      const second = ids.nextId();
      const noteIds = [ids.nextId(), ids.nextId()] as [string, string];
      const data = { matchId, lo, hi, actorId: b, targetId: a, noteIds, likeId: second, itemRef: null, comment: 'Thanks!', queuedAtMs: Date.now() };
      await redis.set(keys.streamWatermark('like'), String(BigInt(second) - 1n));
      const waiting = fakeJob('like-notes', data);
      await expect(likeNotesJob(waiting, context)).rejects.toBeInstanceOf(DelayedError);
      expect(waiting.delayedUntil).toBeGreaterThan(Date.now());
      await redis.set(keys.streamWatermark('like'), String(BigInt(second) + 1n));
      const mintedBefore = ids.nextId();
      const { result, tally } = await statementCounter.measure(() => likeNotesJob(fakeJob('like-notes', data), context));
      expect(result).toMatchObject({ outcome: 'written', notes: 2 });
      // The settings (first use in this process), then the note lock and the notes, in one transaction.
      expect(tally.statements).toBeLessThanOrEqual(3);
      const notes = (await db.admin.query(`SELECT id::text, sender_id::text, ref_id::text, kind, body FROM messages WHERE match_id = $1 ORDER BY id`, [matchId])).rows as {
        id: string;
        sender_id: string;
        ref_id: string | null;
        kind: number;
        body: string;
      }[];
      expect(notes.map(({ id: _id, ...rest }) => rest)).toEqual([
        { sender_id: a, ref_id: '55', kind: 6, body: 'That view' },
        { sender_id: b, ref_id: null, kind: 6, body: 'Thanks!' },
      ]);
      // Minted by the job right before its write, not when the match was made.
      for (const note of notes) expect(BigInt(note.id) > BigInt(mintedBefore)).toBe(true);
      expect(await redis.zcard(directWritesKey(keys))).toBe(0);
      const toA = realtime.on(userChannel(publicIds.user.encode(a))).filter((e) => e.t === 'message');
      expect(toA.map((e) => e.id)).toEqual(notes.map((n) => n.id));
      expect(toA[0]!.d).toMatchObject({ kind: 'like_note', body: 'That view', refId: '55', senderId: publicIds.user.encode(a) });
      // A replay writes and publishes nothing, though it minted ids of its own.
      expect(await likeNotesJob(fakeJob('like-notes', data), context)).toMatchObject({ notes: 0 });
      expect(realtime.on(userChannel(publicIds.user.encode(a))).filter((e) => e.t === 'message')).toHaveLength(2);
      expect(await value<string>(`SELECT count(*)::text FROM messages WHERE match_id = $1`, [matchId])).toBe('2');
      // A retry whose earlier try committed and died before its publish: the same notes, published again.
      const retry = Object.assign(fakeJob('like-notes', data), { attemptsMade: 1 });
      expect(await likeNotesJob(retry, context)).toMatchObject({ notes: 2 });
      expect(realtime.on(userChannel(publicIds.user.encode(a))).filter((e) => e.t === 'message').map((e) => e.id)).toEqual([...notes.map((n) => n.id), ...notes.map((n) => n.id)]);
      expect(await value<string>(`SELECT count(*)::text FROM messages WHERE match_id = $1`, [matchId])).toBe('2');
    });

    it('writes like notes that come after a sync cursor handed out while the like stream lagged, and once when two tries race', async () => {
      const a = await person();
      const b = await person();
      const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
      const matchId = ids.nextId();
      await db.admin.query(`INSERT INTO matches (id, user_lo, user_hi, source) VALUES ($1, $2, $3, 1)`, [matchId, lo, hi]);
      await db.admin.query(`INSERT INTO likes (target_id, actor_id, id, kind, comment) VALUES ($1, $2, $3, 1, 'Hi there')`, [b, a, ids.nextId()]);
      const second = ids.nextId();
      // The ids the match entry carried, minted at the swipe; the like stream then lagged while wb:msg moved on.
      const staleIds = [ids.nextId(), ids.nextId()] as [string, string];
      const data = { matchId, lo, hi, actorId: b, targetId: a, noteIds: staleIds, likeId: second, itemRef: null, comment: 'Hello!', queuedAtMs: Date.now() };
      const cursor = ids.nextId();
      await redis.set(keys.streamWatermark('like'), String(BigInt(second) + 1n));
      // Two tries at once (a stalled job run again while the first still runs): the notes are written once.
      const [one, two] = await Promise.all([likeNotesJob(fakeJob('like-notes', data), context), likeNotesJob(fakeJob('like-notes', data), context)]);
      expect([one.notes, two.notes].sort()).toEqual([0, 2]);
      const notes = (await db.admin.query(`SELECT id::text FROM messages WHERE match_id = $1 AND kind = 6 ORDER BY id`, [matchId])).rows as { id: string }[];
      expect(notes).toHaveLength(2);
      // Every note sorts after the cursor a client held before the job ran: its next after= read returns them.
      for (const note of notes) {
        expect(BigInt(note.id) > BigInt(cursor)).toBe(true);
        expect(staleIds).not.toContain(note.id);
      }
    });

    it('writes and publishes no like note once the conversation ended (an unmatch or a block before the job ran)', async () => {
      const a = await person();
      const b = await person();
      const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
      const matchId = ids.nextId();
      await db.admin.query(`INSERT INTO matches (id, user_lo, user_hi, source) VALUES ($1, $2, $3, 1)`, [matchId, lo, hi]);
      await db.admin.query(`INSERT INTO likes (target_id, actor_id, id, kind, comment) VALUES ($1, $2, $3, 1, 'You again')`, [b, a, ids.nextId()]);
      const second = ids.nextId();
      // Ended by a block before the notes job ran.
      await db.admin.query(`UPDATE matches SET state = 3, ended_at = now(), ended_by = 1 WHERE id = $1`, [matchId]);
      await redis.set(keys.streamWatermark('like'), String(BigInt(second) + 1n));
      const data = { matchId, lo, hi, actorId: b, targetId: a, noteIds: [ids.nextId(), ids.nextId()], likeId: second, itemRef: null, comment: 'Hey', queuedAtMs: Date.now() };
      expect(await likeNotesJob(fakeJob('like-notes', data), context)).toMatchObject({ outcome: 'written', notes: 0 });
      expect(await value<string>(`SELECT count(*)::text FROM messages WHERE match_id = $1`, [matchId])).toBe('0');
      for (const u of [a, b]) expect(realtime.on(userChannel(publicIds.user.encode(u))).filter((e) => e.t === 'message')).toHaveLength(0);
    });

    it('purges an unmatched conversation\'s messages and calls, keeps the match, and waits while a hold names it', async () => {
      const a = await person();
      const b = await person();
      const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
      const matchId = ids.nextId();
      await db.admin.query(`INSERT INTO matches (id, user_lo, user_hi, source, state, ended_at, ended_by) VALUES ($1, $2, $3, 1, 2, now(), 1)`, [matchId, lo, hi]);
      await db.admin.query(`INSERT INTO messages (match_id, id, sender_id, kind, body) VALUES ($1, $2, $3, 1, 'hello')`, [matchId, ids.nextId(), a]);
      const holdId = ids.nextId();
      await db.admin.query(`INSERT INTO legal_holds (id, match_id, kind) VALUES ($1, $2, 1)`, [holdId, matchId]);
      const held = fakeJob('unmatch-purge', { matchId });
      await expect(unmatchPurgeJob(held, context)).rejects.toBeInstanceOf(DelayedError);
      expect(await value<string>(`SELECT count(*)::text FROM messages WHERE match_id = $1`, [matchId])).toBe('1');
      await db.admin.query(`UPDATE legal_holds SET released_at = now() WHERE id = $1`, [holdId]);
      const { result, tally } = await statementCounter.measure(() => unmatchPurgeJob(fakeJob('unmatch-purge', { matchId }), context));
      expect(result).toEqual({ outcome: 'purged' });
      expect(tally.statements).toBe(1);
      expect(await value<string>(`SELECT count(*)::text FROM messages WHERE match_id = $1`, [matchId])).toBe('0');
      expect(await value<string>(`SELECT count(*)::text FROM matches WHERE id = $1`, [matchId])).toBe('1');
    });
  });
});
