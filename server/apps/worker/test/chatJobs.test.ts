import { randomBytes } from 'node:crypto';
import { createPool, withTransaction, writeLikeNotes, type Pool } from '@app/db';
import { userChannel } from '@app/shared';
import { FakePushSender, FakeRealtimePublisher, IdGenerator, createKeys, createPublicIds } from '@app/shared/server';
import { DelayedError, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { likeNotesJob, loadConfig, unsendClearJob, type JobContext } from '../src/index.js';
import { FakePhotoModerator } from '../src/photos/moderation.js';
import type { WorkerServices } from '../src/services.js';
import { ensureGroupRoles, hasDatabase, loginRole, migratedDatabase, type TestDatabase } from './db.js';
import { TEST_REDIS_URL, baseEnv, connect, hasRedis } from './support.js';

/**
 * The chat jobs against the failures around them: like notes while
 * PostgreSQL is away longer than all their attempts, a note run BullMQ took
 * back from a worker that died between its commit and its publish, and the
 * body of a taken-back like note.
 */

type FakeJob<T> = Job<T> & { delayedUntil?: number };

function fakeJob<T>(name: string, data: T, extra: Partial<Pick<Job, 'attemptsMade' | 'stalledCounter'>> = {}): FakeJob<T> {
  const job = {
    name,
    data,
    id: `${name}.test`,
    attemptsMade: extra.attemptsMade ?? 0,
    stalledCounter: extra.stalledCounter ?? 0,
    async moveToDelayed(timestamp: number) {
      job.delayedUntil = timestamp;
    },
    async updateData(next: T) {
      job.data = next;
    },
  } as unknown as FakeJob<T>;
  return job;
}

describe.skipIf(!hasDatabase || !hasRedis)('chat jobs and their failures (PostgreSQL, Valkey)', () => {
  let db: TestDatabase;
  let pg: Pool;
  let redis: Redis;
  let ids: IdGenerator;
  let realtime: FakeRealtimePublisher;
  let context: JobContext;
  let role: Awaited<ReturnType<typeof loginRole>>;
  const prefix = `t${randomBytes(4).toString('hex')}:`;
  const keys = createKeys(prefix);
  const env = baseEnv();
  const publicIds = createPublicIds(env['ID_PUBLIC_KEY']!, env['ID_BILLING_KEY']!);

  beforeAll(async () => {
    await ensureGroupRoles();
    role = await loginRole(['app_rw']);
    db = await migratedDatabase();
    pg = createPool({ connectionString: db.urlFor(role.name, role.password), applicationName: 'chat-jobs-test', max: 4 });
    redis = connect();
    ids = new IdGenerator({ redis, keyPrefix: prefix });
    await ids.start();
    realtime = new FakeRealtimePublisher();
    const services: WorkerServices = {
      pg,
      cache: redis,
      ids,
      keys,
      publicIds,
      realtime,
      media: null,
      photoModerator: new FakePhotoModerator({ autoApprove: false }),
      push: new FakePushSender(),
    };
    const config = loadConfig({ ...env, DATABASE_URL: db.url, REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix, WORKER_ID: 'chat-jobs-test' });
    context = { config, redis, log: pino({ level: 'silent' }), services, token: 'test-token' };
  }, 90_000);

  afterAll(async () => {
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
  });

  async function person(): Promise<string> {
    const id = ids.nextId();
    await db.admin.query(`INSERT INTO users (id, status, birth_date, gender, country, onboarding_step) VALUES ($1, 3, DATE '1994-05-17', 2, 'IR', 30)`, [id]);
    await db.admin.query(`INSERT INTO profiles (user_id, display_name) VALUES ($1, 'Sam Lee')`, [id]);
    return id;
  }

  /** A match of two people whose first like carried a comment, with the note job's data (the stream durable past it). */
  async function matched(): Promise<{ a: string; b: string; matchId: string; data: Record<string, unknown> }> {
    const a = await person();
    const b = await person();
    const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
    const matchId = ids.nextId();
    await db.admin.query(`INSERT INTO matches (id, user_lo, user_hi, source) VALUES ($1, $2, $3, 1)`, [matchId, lo, hi]);
    await db.admin.query(`INSERT INTO likes (target_id, actor_id, id, kind, comment) VALUES ($1, $2, $3, 1, 'Nice smile')`, [b, a, ids.nextId()]);
    const second = ids.nextId();
    await redis.set(keys.streamWatermark('like'), String(BigInt(second) + 1n));
    return { a, b, matchId, data: { matchId, lo, hi, actorId: b, targetId: a, likeId: second, itemRef: null, comment: 'Thank you!', queuedAtMs: Date.now() } };
  }

  const published = (user: string) => realtime.on(userChannel(publicIds.user.encode(user))).filter((e) => e.t === 'message');
  const count = async (matchId: string) => Number((await db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE match_id = $1`, [matchId])).rows[0]!.n);

  it('waits out a PostgreSQL outage longer than all its attempts, then writes the notes once and tells both', async () => {
    const { a, matchId, data } = await matched();
    const connect = pg.connect;
    let refused = 0;
    // The transaction's connection is refused (the pool's own callback form, used by pool.query, is left alone).
    pg.connect = ((...args: unknown[]) => {
      if (refused < 8 && typeof args[0] !== 'function') {
        refused += 1;
        return Promise.reject(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }));
      }
      return (connect as (...a: unknown[]) => unknown).apply(pg, args);
    }) as typeof connect;
    const job = fakeJob('like-notes', data);
    try {
      // The job has 5 attempts; each try PostgreSQL refuses only puts it off.
      for (let i = 0; i < 8; i += 1) {
        await expect(likeNotesJob(job, context)).rejects.toBeInstanceOf(DelayedError);
        expect(job.delayedUntil).toBeGreaterThan(Date.now());
      }
    } finally {
      pg.connect = connect;
    }
    expect(await count(matchId)).toBe(0);
    expect(await likeNotesJob(job, context)).toMatchObject({ outcome: 'written', notes: 2 });
    expect(await count(matchId)).toBe(2);
    expect(published(a)).toHaveLength(2);
  });

  it('publishes the notes a run that died after its commit wrote, when BullMQ takes the stalled job back', async () => {
    const { a, b, matchId, data } = await matched();
    // The first run committed the notes, then its worker was killed before it told anyone.
    await withTransaction(pg, (tx) =>
      writeLikeNotes(tx, {
        matchId,
        actorId: b,
        targetId: a,
        noteIds: [ids.nextId(), ids.nextId()],
        itemRef: null,
        comment: 'Thank you!',
        windowDays: 30,
      }),
    );
    expect(await count(matchId)).toBe(2);
    expect(published(a)).toHaveLength(0);
    // BullMQ moves a stalled job back to wait without counting an attempt; only its stall counter shows it.
    expect(await likeNotesJob(fakeJob('like-notes', data, { attemptsMade: 0, stalledCounter: 1 }), context)).toMatchObject({ notes: 2 });
    expect(published(a)).toHaveLength(2);
    expect(await redis.hget(`${prefix}lm:${matchId}`, 'k')).toBe('6');
    // A fresh replay of the same match still publishes nothing.
    expect(await likeNotesJob(fakeJob('like-notes', data), context)).toMatchObject({ notes: 0 });
    expect(published(a)).toHaveLength(2);
    expect(await count(matchId)).toBe(2);
  });

  it('clears the body of a like note its sender took back, as it does a text', async () => {
    const { a, b, matchId, data } = await matched();
    expect(await likeNotesJob(fakeJob('like-notes', data), context)).toMatchObject({ notes: 2 });
    const notes = (await db.admin.query(`SELECT id::text, sender_id::text AS sender, body FROM messages WHERE match_id = $1 AND kind = 6 ORDER BY id`, [matchId])).rows as {
      id: string;
      sender: string;
      body: string;
    }[];
    const mine = notes.find((n) => n.sender === a)!;
    expect(mine.body).toBe('Nice smile');
    // a takes it back; once the report window is over, the body goes.
    expect(await unsendClearJob(fakeJob('unsend-clear', { matchId, targetId: mine.id, senderId: a }), context)).toEqual({ outcome: 'cleared' });
    const after = (await db.admin.query(`SELECT body, flags FROM messages WHERE match_id = $1 AND id = $2`, [matchId, mine.id])).rows[0] as { body: string | null; flags: number };
    expect(after.body).toBeNull();
    expect(after.flags & 8).toBe(8);
    // Only its sender's: the other person's note keeps its body.
    const theirs = notes.find((n) => n.sender === b)!;
    expect(await unsendClearJob(fakeJob('unsend-clear', { matchId, targetId: theirs.id, senderId: a }), context)).toEqual({ outcome: 'nothing' });
  });
});
