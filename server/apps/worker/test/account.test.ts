import { randomBytes } from 'node:crypto';
import { createPool, deleteAccount, instrumentPool, statementCounter, type Pool } from '@app/db';
import { userChannel } from '@app/shared';
import {
  FakeObjectStorage,
  FakeRealtimePublisher,
  IdGenerator,
  accountJobIds,
  createKeys,
  createPublicIds,
  photoUploadKey,
  photoVariantKeys,
  queuePrefix,
  readVersion,
  type DeletionFanoutData,
  type MediaStore,
  type PurgeData,
} from '@app/shared/server';
import { DelayedError, Queue, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, startWorker, type JobContext } from '../src/index.js';
import { FakePhotoModerator } from '../src/photos/moderation.js';
import { SWEEP_RECENT_MS, accountQueue, deletionFanoutJob, deletionSweepJob, purgeJob } from '../src/queues/account.js';
import type { WorkerServices } from '../src/services.js';
import { ensureGroupRoles, hasDatabase, loginRole, migratedDatabase, type TestDatabase } from './db.js';
import { TEST_REDIS_URL, baseEnv, connect, eventually, hasRedis } from './support.js';

/**
 * The account jobs against PostgreSQL and Valkey: the deletion fan-out,
 * the purge at the end of the grace (a fake clock moves 30 days on), legal
 * holds, the photo blobs, and the sweep that queues lost jobs again.
 */

const DAY_MS = 86_400_000;
const CELL = '608692970769612799';
const POINT = 'ST_SetSRID(ST_MakePoint(-122.42, 37.77), 4326)::geography';

type FakeJob<T> = Job<T> & { delayedUntil?: number };

function fakeJob<T>(name: string, data: T): FakeJob<T> {
  const job = {
    name,
    data,
    id: `${name}.test`,
    async updateData(next: T) {
      job.data = next;
    },
    async moveToDelayed(timestamp: number) {
      job.delayedUntil = timestamp;
    },
  } as unknown as FakeJob<T>;
  return job;
}

describe.skipIf(!hasDatabase || !hasRedis)('the account jobs (PostgreSQL, Valkey)', () => {
  let db: TestDatabase;
  let pg: Pool;
  let redis: Redis;
  let ids: IdGenerator;
  let storage: FakeObjectStorage;
  let media: MediaStore;
  let realtime: FakeRealtimePublisher;
  let services: WorkerServices;
  let context: JobContext;
  const prefix = `t${randomBytes(4).toString('hex')}:`;
  const keys = createKeys(prefix);
  const env = baseEnv();
  const publicIds = createPublicIds(env['ID_PUBLIC_KEY']!, env['ID_BILLING_KEY']!);

  let workerRole: Awaited<ReturnType<typeof loginRole>>;
  let analystRole: Awaited<ReturnType<typeof loginRole>>;

  beforeAll(async () => {
    // The jobs run as the worker's own role (app_rw), as in production; the grants of 0012 are made at migration time.
    await ensureGroupRoles();
    workerRole = await loginRole(['app_rw', 'app_maint']);
    analystRole = await loginRole(['app_ro']);
    db = await migratedDatabase();
    pg = instrumentPool(createPool({ connectionString: db.urlFor(workerRole.name, workerRole.password), applicationName: 'worker-test', max: 4 }), statementCounter);
    redis = connect();
    ids = new IdGenerator({ redis, keyPrefix: prefix });
    await ids.start();
    storage = new FakeObjectStorage();
    media = { storage, privateBucket: 'uploads', mediaBucket: 'media', urls: null };
    realtime = new FakeRealtimePublisher();
    services = { pg, cache: redis, ids, keys, publicIds, realtime, media, photoModerator: new FakePhotoModerator({ autoApprove: false }) };
    const config = loadConfig({ ...env, DATABASE_URL: db.url, REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix, WORKER_ID: 'account-test' });
    context = { config, redis, log: pino({ level: 'silent' }), services, token: 'test-token' };
  }, 90_000);

  afterAll(async () => {
    await ids?.stop();
    await pg?.end();
    const left = await redis.keys(`${prefix}*`);
    if (left.length > 0) await redis.del(...left);
    await redis?.quit();
    await db?.drop();
    await workerRole?.drop();
    await analystRole?.drop();
  });

  async function value<T>(text: string, values: unknown[] = []): Promise<T> {
    const { rows } = await db.admin.query(text, values);
    return Object.values(rows[0] as Record<string, T>)[0] as T;
  }

  async function person(status = 3): Promise<string> {
    const id = ids.nextId();
    await db.admin.query(
      `INSERT INTO users (id, status, birth_date, gender, country, onboarding_step) VALUES ($1, $2, DATE '1994-05-17', 2, 'IR', 30)`,
      [id, status],
    );
    await db.admin.query(`INSERT INTO profiles (user_id, display_name) VALUES ($1, 'Sam')`, [id]);
    return id;
  }

  async function match(a: string, b: string): Promise<string> {
    const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
    const id = ids.nextId();
    await db.admin.query(`INSERT INTO matches (id, user_lo, user_hi, source) VALUES ($1, $2, $3, 1)`, [id, lo, hi]);
    return id;
  }

  /** The conversation as Valkey holds it for both people. */
  async function listed(matchId: string, a: string, b: string): Promise<void> {
    await redis
      .multi()
      .hset(keys.raw('mt', matchId), 'lo', a, 'hi', b)
      .hset(keys.raw('lm', matchId), 'id', '1', 'p', 'hello')
      .zadd(keys.raw('cl', a), Date.now(), matchId)
      .zadd(keys.raw('cl', b), Date.now(), matchId)
      .hset(keys.raw('unr', b), matchId, '2')
      .exec();
  }

  async function deleted(userId: string): Promise<number> {
    const outcome = await deleteAccount(pg, { userId }, 1);
    if (outcome.kind !== 'deleted') throw new Error(`not deleted: ${outcome.kind}`);
    return outcome.deletedAtMs;
  }

  async function photo(userId: string, position: number, blobVer: number): Promise<string> {
    const id = ids.nextId();
    await db.admin.query(`INSERT INTO photos (id, user_id, position, status, width, height, blob_ver) VALUES ($1, $2, $3, 3, 10, 10, $4)`, [id, userId, position, blobVer]);
    for (const key of photoVariantKeys(id, blobVer)) await storage.putObject('media', key, new Uint8Array([1]), { contentType: 'image/webp' });
    await storage.putObject('uploads', photoUploadKey(id), new Uint8Array([1]), { contentType: 'image/jpeg' });
    return id;
  }

  async function stored(bucket: string, key: string): Promise<boolean> {
    return (await storage.getObject(bucket, key)) !== null;
  }

  describe('deletion-fanout', () => {
    it('takes the conversations out of both people\'s lists, tells each peer, hides the person and closes their connections', async () => {
      const a = await person();
      const b = await person();
      const c = await person();
      const ab = await match(a, b);
      const ca = await match(c, a);
      await listed(ab, a, b);
      await listed(ca, c, a);
      const version = await value<number>(`SELECT version FROM profiles WHERE user_id = $1`, [a]);
      await redis.set(keys.raw('card', a, version, 0), 'card');
      await redis.rpush(keys.raw('deck', a), b);
      const deletedAtMs = await deleted(a);

      const job = fakeJob<DeletionFanoutData>('deletion-fanout', { userId: a, deletedAtMs });
      const { result, tally } = await statementCounter.measure(() => deletionFanoutJob(job, context));
      expect(tally.statements).toBe(1);
      expect(result).toEqual({ outcome: 'done', ended: 2, hidden: true, published: 2, disconnected: true });

      for (const m of [ab, ca]) {
        expect(await redis.exists(keys.raw('mt', m), keys.raw('lm', m))).toBe(0);
      }
      expect(await redis.zscore(keys.raw('cl', b), ab)).toBeNull();
      expect(await redis.zscore(keys.raw('cl', c), ca)).toBeNull();
      expect(await redis.hget(keys.raw('unr', b), ab)).toBeNull();
      expect(await redis.exists(keys.raw('cl', a))).toBe(0);
      expect(await redis.zscore(keys.accountsHidden(), a)).not.toBeNull();
      expect(await redis.exists(keys.raw('card', a, version, 0), keys.raw('deck', a))).toBe(0);
      expect(await readVersion(redis, keys.raw('cv', b))).toBeGreaterThan(0);

      const toB = realtime.on(userChannel(publicIds.user.encode(b)));
      const toC = realtime.on(userChannel(publicIds.user.encode(c)));
      expect(toB.map((e) => [e.t, (e.d as { conversationId: string }).conversationId])).toEqual([['conversation_end', ab]]);
      expect(toC.map((e) => [e.t, (e.d as { conversationId: string }).conversationId])).toEqual([['conversation_end', ca]]);
      expect(realtime.disconnected).toContain(publicIds.user.encode(a));
      // Nothing about the person who left: the event carries the conversation only.
      expect(JSON.stringify(toB)).not.toContain(a);

      // A retry publishes under the same event ids (Centrifugo's idempotency key).
      const firstIds = toB.map((e) => e.id);
      await deletionFanoutJob(job, context);
      expect(realtime.on(userChannel(publicIds.user.encode(b))).map((e) => e.id)).toEqual([...firstIds, ...firstIds]);
    });

    it('drops the card and the deck queue from kv-cache when that is an instance of its own (REDIS_CACHE_URL)', async () => {
      const cacheUrl = new URL(TEST_REDIS_URL ?? '');
      cacheUrl.pathname = '/14';
      const cache = new Redis(cacheUrl.toString());
      try {
        const a = await person();
        const version = await value<number>(`SELECT version FROM profiles WHERE user_id = $1`, [a]);
        await cache.set(keys.raw('card', a, version, 0), 'card');
        await cache.rpush(keys.raw('deck', a), '1');
        // The same names in kv-core are not this job's: they stay.
        await redis.set(keys.raw('card', a, version, 0), 'other');
        const deletedAtMs = await deleted(a);
        const split = { ...context, services: { ...services, cache } };
        expect(await deletionFanoutJob(fakeJob<DeletionFanoutData>('deletion-fanout', { userId: a, deletedAtMs }), split)).toMatchObject({ hidden: true });
        expect(await cache.exists(keys.raw('card', a, version, 0), keys.raw('deck', a))).toBe(0);
        expect(await redis.get(keys.raw('card', a, version, 0))).toBe('other');
        expect(await redis.zscore(keys.accountsHidden(), a)).not.toBeNull();
        await redis.del(keys.raw('card', a, version, 0));
      } finally {
        const left = await cache.keys(`${prefix}*`);
        if (left.length > 0) await cache.del(...left);
        await cache.quit();
      }
    });

    it('still ends the conversations, but hides nobody, when the account was restored first', async () => {
      const a = await person();
      const b = await person();
      const ab = await match(a, b);
      await listed(ab, a, b);
      const deletedAtMs = await deleted(a);
      await db.admin.query(`UPDATE users SET status = 3, deleted_at = NULL, deleted_via = NULL, restore_status = NULL WHERE id = $1`, [a]);
      const result = await deletionFanoutJob(fakeJob<DeletionFanoutData>('deletion-fanout', { userId: a, deletedAtMs }), context);
      expect(result).toMatchObject({ outcome: 'done', ended: 1, hidden: false, disconnected: false });
      expect(await redis.zscore(keys.raw('cl', b), ab)).toBeNull();
      expect(await redis.zscore(keys.accountsHidden(), a)).toBeNull();
    });
  });

  describe('purge', () => {
    it('waits until the purge time, then leaves the tombstone and deletes the photos from storage', async () => {
      const a = await person();
      await db.admin.query(`INSERT INTO preferences (user_id, interested_in) VALUES ($1, 2)`, [a]);
      await db.admin.query(`INSERT INTO user_locations (user_id, home_h3, source, country, home_geo) VALUES ($1, $2, 1, 'IR', ${POINT})`, [a, CELL]);
      const p1 = await photo(a, 0, 1);
      const p2 = await photo(a, 1, 3);
      const device = ids.nextId();
      await db.admin.query(`INSERT INTO devices (id, user_id, app_version, platform, store) VALUES ($1, $2, 100, 1, 2)`, [device, a]);
      await db.admin.query(`INSERT INTO user_consents (user_id, kind, version) VALUES ($1, 1, 1)`, [a]);
      await redis.set(keys.location(a), 'cell');
      await redis.set(keys.device(device), 'fingerprint');
      await redis.set(keys.entitlements(a, 2), '{}');
      const deletedAtMs = await deleted(a);
      const purgeAtMs = deletedAtMs + 30 * DAY_MS;
      const data: PurgeData = { userId: a, deletedAtMs, purgeAtMs };

      // Day 29 on the fake clock: back to the delayed set until the purge time.
      const early = fakeJob<PurgeData>('purge', data);
      const day29 = deletedAtMs + 29 * DAY_MS;
      const before = Date.now();
      await expect(purgeJob(early, context, () => day29)).rejects.toBeInstanceOf(DelayedError);
      expect(early.delayedUntil! - before).toBeGreaterThanOrEqual(DAY_MS - 1_000);
      expect(early.delayedUntil! - before).toBeLessThanOrEqual(DAY_MS + 60_000);
      expect(await value<number>(`SELECT status FROM users WHERE id = $1`, [a])).toBe(7);

      // Day 31: the tombstone.
      const job = fakeJob<PurgeData>('purge', data);
      const version = await readVersion(redis, keys.meVersion(a));
      const { result, tally } = await statementCounter.measure(() => purgeJob(job, context, () => deletedAtMs + 31 * DAY_MS));
      expect(tally.statements).toBe(2);
      expect(result).toEqual({ outcome: 'purged', matches: 0, heldMatches: 0, photos: 2, objects: 3 + 9 + 2 });
      const tomb = await db.admin.query<{ status: number }>(`SELECT status, birth_date, gender, country FROM users WHERE id = $1`, [a]);
      expect(tomb.rows[0]).toEqual({
        status: 8,
        birth_date: null,
        gender: null,
        country: null,
      });
      for (const table of ['profiles', 'preferences', 'user_locations', 'devices', 'photos']) {
        expect(await value<string>(`SELECT count(*)::text FROM ${table} WHERE user_id = $1`, [a]), table).toBe('0');
      }
      expect(await value<string>(`SELECT count(*)::text FROM user_consents WHERE user_id = $1`, [a])).toBe('1');
      for (const [id, blobVer] of [[p1, 1], [p2, 3]] as const) {
        for (const key of photoVariantKeys(id, blobVer)) expect(await stored('media', key), key).toBe(false);
        expect(await stored('uploads', photoUploadKey(id))).toBe(false);
      }
      expect(await redis.exists(keys.location(a), keys.device(device), keys.entitlements(a, 2))).toBe(0);
      expect(await readVersion(redis, keys.meVersion(a))).toBeGreaterThan(version);

      // Run again (a retried job): nothing left, nothing changes.
      const again = await purgeJob(fakeJob<PurgeData>('purge', data), context, () => deletedAtMs + 31 * DAY_MS);
      expect(again).toEqual({ outcome: 'purged', matches: 0, heldMatches: 0, photos: 0, objects: 0 });
    });

    it('keeps the photo rows, and waits, while no object storage is configured', async () => {
      const a = await person();
      const p = await photo(a, 0, 1);
      const deletedAtMs = await deleted(a);
      const data: PurgeData = { userId: a, deletedAtMs, purgeAtMs: deletedAtMs + 30 * DAY_MS };
      const later = deletedAtMs + 31 * DAY_MS;
      const without: JobContext = { ...context, services: { ...services, media: null } };
      await expect(purgeJob(fakeJob<PurgeData>('purge', data), without, () => later)).rejects.toBeInstanceOf(DelayedError);
      expect(await value<number>(`SELECT status FROM users WHERE id = $1`, [a])).toBe(8);
      expect(await value<string>(`SELECT count(*)::text FROM photos WHERE id = $1`, [p])).toBe('1');
      expect(await stored('uploads', photoUploadKey(p))).toBe(true);
      await purgeJob(fakeJob<PurgeData>('purge', data), context, () => later);
      expect(await value<string>(`SELECT count(*)::text FROM photos WHERE id = $1`, [p])).toBe('0');
      expect(await stored('uploads', photoUploadKey(p))).toBe(false);
    });

    it('respects legal holds: a held account waits whole, a held conversation stays until released', async () => {
      const a = await person();
      const p = await photo(a, 0, 1);
      const deletedAtMs = await deleted(a);
      const hold = ids.nextId();
      await db.admin.query(`INSERT INTO legal_holds (id, user_id, kind) VALUES ($1, $2, 1)`, [hold, a]);
      const data: PurgeData = { userId: a, deletedAtMs, purgeAtMs: deletedAtMs + 30 * DAY_MS };
      const later = deletedAtMs + 31 * DAY_MS;
      const held = fakeJob<PurgeData>('purge', data);
      const before = Date.now();
      await expect(purgeJob(held, context, () => later)).rejects.toBeInstanceOf(DelayedError);
      expect(held.delayedUntil! - before).toBeGreaterThanOrEqual(DAY_MS - 1_000);
      expect(await value<number>(`SELECT status FROM users WHERE id = $1`, [a])).toBe(7);
      expect(await stored('uploads', photoUploadKey(p))).toBe(true);
      await db.admin.query(`UPDATE legal_holds SET released_at = now() WHERE id = $1`, [hold]);

      const b = await person();
      const c = await person();
      const ab = await match(a, b);
      const ac = await match(a, c);
      await db.admin.query(`INSERT INTO messages (match_id, id, sender_id, kind, body) VALUES ($1, $2, $3, 1, 'kept')`, [ac, ids.nextId(), c]);
      await db.admin.query(`INSERT INTO legal_holds (id, match_id, kind) VALUES ($1, $2, 2)`, [ids.nextId(), ac]);
      const partial = fakeJob<PurgeData>('purge', data);
      // The tombstone is made; the job looks again tomorrow for the held conversation.
      await expect(purgeJob(partial, context, () => later)).rejects.toBeInstanceOf(DelayedError);
      expect(await value<number>(`SELECT status FROM users WHERE id = $1`, [a])).toBe(8);
      expect(await value<string>(`SELECT count(*)::text FROM matches WHERE id = $1`, [ab])).toBe('0');
      expect(await value<string>(`SELECT count(*)::text FROM messages WHERE match_id = $1`, [ac])).toBe('1');
      expect(await stored('uploads', photoUploadKey(p))).toBe(false);
    });

    it('is the worker\'s: the analytics role may not run it', async () => {
      const a = await person();
      await deleted(a);
      const analyst = createPool({ connectionString: db.urlFor(analystRole.name, analystRole.password), applicationName: 'worker-test-ro', max: 1 });
      try {
        await expect(analyst.query(`SELECT account_purge($1::bigint, now() + interval '40 days')`, [a])).rejects.toMatchObject({ code: '42501' });
        await expect(analyst.query(`SELECT account_purge_photos($1::bigint, '{}')`, [a])).rejects.toMatchObject({ code: '42501' });
      } finally {
        await analyst.end();
      }
      expect(await value<number>(`SELECT status FROM users WHERE id = $1`, [a])).toBe(7);
    });

    it('does nothing to an account that was restored', async () => {
      const a = await person();
      const deletedAtMs = await deleted(a);
      await db.admin.query(`UPDATE users SET status = 3, deleted_at = NULL, deleted_via = NULL, restore_status = NULL WHERE id = $1`, [a]);
      const result = await purgeJob(fakeJob<PurgeData>('purge', { userId: a, deletedAtMs, purgeAtMs: deletedAtMs + 30 * DAY_MS }), context, () => deletedAtMs + 31 * DAY_MS);
      expect(result).toEqual({ outcome: 'not_deleted' });
      expect(await value<string>(`SELECT count(*)::text FROM profiles WHERE user_id = $1`, [a])).toBe('1');
    });
  });

  describe('deletion-sweep', () => {
    it('queues a lost purge and an unqueued fan-out, once per period (lease)', async () => {
      const due = await person();
      const dueAt = await deleted(due);
      const recent = await person();
      const recentAt = await deleted(recent);
      const now = Math.max(dueAt, recentAt) + 30 * DAY_MS + 60_000;
      // `recent` is due by then too; move its deletion so it is recent at `now`.
      await db.admin.query(`UPDATE users SET deleted_at = to_timestamp($2::double precision / 1000) WHERE id = $1`, [recent, now - SWEEP_RECENT_MS / 2]);
      const recentMs = Number(await value<string>(`SELECT floor(extract(epoch FROM deleted_at) * 1000)::bigint::text FROM users WHERE id = $1`, [recent]));

      const result = await deletionSweepJob(context, () => now);
      expect(result.leased).toBe(true);
      const queue = new Queue('account', { connection: redis, prefix: queuePrefix(prefix) });
      try {
        const purge = await queue.getJob(accountJobIds.purge(due, dueAt));
        expect(purge?.name).toBe('purge');
        expect(purge?.data).toEqual({ userId: due, deletedAtMs: dueAt, purgeAtMs: dueAt + 30 * DAY_MS });
        expect(purge?.opts.removeOnComplete).toEqual({ age: 3_600, count: 10_000 });
        const fanout = await queue.getJob(accountJobIds.fanout(recent, recentMs));
        expect(fanout?.name).toBe('deletion-fanout');
        // A second run inside the period takes no lease and queues nothing.
        expect(await deletionSweepJob(context, () => now)).toEqual({ leased: false, purges: 0, fanouts: 0 });
      } finally {
        await queue.obliterate({ force: true });
        await queue.close();
      }
      await redis.del(keys.jobLease('deletion-sweep'));
    });
  });

  describe('in the running worker', () => {
    it('runs a fan-out queued by name, as the API queues it', async () => {
      const a = await person();
      const b = await person();
      const ab = await match(a, b);
      await listed(ab, a, b);
      const deletedAtMs = await deleted(a);
      const runtime = await startWorker(context.config, { logger: pino({ level: 'silent' }), queues: [accountQueue()], services });
      const queue = new Queue('account', { connection: redis, prefix: queuePrefix(prefix) });
      try {
        await queue.add('deletion-fanout', { userId: a, deletedAtMs }, { jobId: accountJobIds.fanout(a, deletedAtMs), removeOnComplete: { age: 3_600 } });
        await eventually(async () => (await redis.zscore(keys.raw('cl', b), ab)) === null && (await redis.zscore(keys.accountsHidden(), a)) !== null, 10_000);
        await eventually(() => realtime.disconnected.includes(publicIds.user.encode(a)), 5_000);
      } finally {
        await runtime.stop();
        await queue.obliterate({ force: true });
        await queue.close();
      }
    });
  });
});
