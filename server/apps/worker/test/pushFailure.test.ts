import { randomBytes } from 'node:crypto';
import { createPool, type Pool } from '@app/db';
import { FakePushSender, FakeRealtimePublisher, IdGenerator, createKeys, createPublicIds, placeCall } from '@app/shared/server';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callsQueue, loadConfig, sendPushJob, type CallJob, type JobContext, type PushJobRun } from '../src/index.js';
import { FakePhotoModerator } from '../src/photos/moderation.js';
import type { WorkerServices } from '../src/services.js';
import { TEST_REDIS_URL, baseEnv, connect, hasRedis } from './support.js';

/**
 * A push job that fails for good while PostgreSQL is away keeps no word of
 * what it would have shown: the message text, the sender's or caller's name,
 * the caller's photo link. PostgreSQL is a pool on a port nobody listens on.
 */

describe.skipIf(!hasRedis)('a push that fails for good (Valkey; PostgreSQL unreachable)', () => {
  let redis: Redis;
  let ids: IdGenerator;
  let dead: Pool;
  let context: JobContext;
  const prefix = `t${randomBytes(4).toString('hex')}:`;
  const keys = createKeys(prefix);
  const env = baseEnv();

  beforeAll(async () => {
    redis = connect();
    ids = new IdGenerator({ redis, keyPrefix: prefix });
    await ids.start();
    dead = createPool({ connectionString: 'postgres://nobody:nobody@127.0.0.1:1/none', applicationName: 'push-failure-test', max: 1, connectTimeoutMs: 500 });
    const services: WorkerServices = {
      pg: dead,
      cache: redis,
      ids,
      keys,
      publicIds: createPublicIds(env['ID_PUBLIC_KEY']!, env['ID_BILLING_KEY']!),
      realtime: new FakeRealtimePublisher(),
      media: null,
      photoModerator: new FakePhotoModerator({ autoApprove: false }),
      push: new FakePushSender(),
    };
    const config = loadConfig({ ...env, DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:1/none', REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix, WORKER_ID: 'push-failure' });
    context = { config, redis, log: pino({ level: 'silent' }), services, token: 'test-token' };
  });

  afterAll(async () => {
    await ids?.stop();
    await dead?.end();
    const left = await redis.keys(`${prefix}*`);
    if (left.length > 0) await redis.del(...left);
    await redis?.quit();
  });

  function standIn(data: Record<string, unknown>, attempts: number, attemptsMade: number): PushJobRun {
    const job: PushJobRun = {
      name: 'send',
      data,
      attemptsMade,
      opts: { attempts },
      async updateData(next: unknown) {
        job.data = next;
      },
    };
    return job;
  }

  it('drops the message text and the sender’s name when the last attempt cannot read where the push goes', async () => {
    const data = { type: 'message', userId: ids.nextId(), conversationId: ids.nextId(), messageId: ids.nextId(), senderName: 'Ava', preview: 'secret plans for Friday' };
    // An attempt with more to come keeps them for its retry.
    const early = standIn({ ...data }, 3, 0);
    await expect(sendPushJob(early, context, { settleMs: 0 })).rejects.toThrow();
    expect(early.data).toMatchObject({ senderName: 'Ava', preview: 'secret plans for Friday' });
    // The last one does not.
    const last = standIn({ ...data }, 3, 2);
    await expect(sendPushJob(last, context, { settleMs: 0 })).rejects.toThrow();
    expect(last.data).toEqual({ type: 'message', userId: data.userId, conversationId: data.conversationId, messageId: data.messageId });
    expect(JSON.stringify(last.data)).not.toContain('Friday');
  });

  it('drops the matched person’s name from a match push that failed for good', async () => {
    const job = standIn({ type: 'match', userId: ids.nextId(), conversationId: ids.nextId(), peerName: 'Negar' }, 3, 2);
    await expect(sendPushJob(job, context)).rejects.toThrow();
    expect(job.data).not.toHaveProperty('peerName');
  });

  it('drops the caller’s name and photo link from a ring that failed for good', async () => {
    const callId = ids.nextId();
    const [caller, callee] = [ids.nextId(), ids.nextId()];
    expect(await placeCall(redis, keys, { id: callId, matchId: ids.nextId(), callerId: caller, calleeId: callee, kind: 'audio', now: Date.now(), maxLive: null, shadow: false })).toBe('placed');
    const queue = callsQueue({ livekit: null, identitySecret: null });
    const ring = (attemptsMade: number): CallJob => {
      const job: CallJob = {
        name: 'ring-push',
        data: { callId, peerName: 'Ava', peerPhotoUrl: 'https://cdn.example.test/p/1/320.webp?sig=abc' },
        attemptsMade,
        attemptsStarted: attemptsMade + 1,
        opts: { attempts: 2 },
        moveToDelayed: async () => undefined,
        async updateData(next: unknown) {
          job.data = next;
        },
      };
      return job;
    };
    const first = ring(0);
    await expect(queue.process(first as never, context)).rejects.toThrow();
    expect(first.data).toMatchObject({ peerName: 'Ava' });
    const last = ring(1);
    await expect(queue.process(last as never, context)).rejects.toThrow();
    expect(last.data).toEqual({ callId });
  });
});
