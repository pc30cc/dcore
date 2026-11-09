import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createPool, type Pool } from '@app/db';
import { sentMessageSchema } from '@app/shared';
import {
  FakePresence,
  FakeRealtimePublisher,
  FcmEndpointFake,
  FcmSender,
  chatKeys,
  parseServiceAccount,
  queueJobs,
  queuePrefix,
  queueRetention,
  type ActiveQueueName,
} from '@app/shared/server';
import { loadConfig, pushQueue, startWorker, type WorkerRuntime } from '@app/worker';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, migratedDatabase, seedUser, startHarness, statements, type Harness, type SeededUser, type TestDatabase } from './accountSupport.js';
import { matchOf, until } from './chatSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * Message pushes end to end, as production runs them: the API (sends,
 * receipts, its BullMQ producer on Valkey) and a real worker process
 * (BullMQ worker on the same prefix, the push queue) with the real FCM
 * client against FCM's HTTP API faked in process. A burst of messages makes
 * one push; a person with the conversation on screen gets none; reading
 * reopens the window; every job either side left in Valkey carries its
 * queue's retention.
 */

describe.skipIf(!hasInfrastructure)('message pushes, API to FCM (PostgreSQL, Valkey, BullMQ)', () => {
  let db: TestDatabase;
  let h: Harness;
  let realtime: FakeRealtimePublisher;
  let fcm: FcmEndpointFake;
  let runtime: WorkerRuntime;
  let pool: Pool;
  let cache: Redis;

  beforeAll(async () => {
    db = await migratedDatabase();
    realtime = new FakeRealtimePublisher();
    // The API's own producer (BullMQ on its Valkey connection), not a stand-in.
    h = await startHarness(db, {}, { realtime, chat: { presence: new FakePresence() } });
    fcm = new FcmEndpointFake();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const account = parseServiceAccount(
      JSON.stringify({
        project_id: 'e2e-push-project',
        client_email: 'sender@e2e-push-project.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
    )!;
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: db.url,
      REDIS_URL: h.app.config.redis.url,
      REDIS_KEY_PREFIX: h.prefix,
      ID_PUBLIC_KEY: h.app.config.ids.publicKey,
      ID_BILLING_KEY: h.app.config.ids.billingKey,
      WORKER_ID: 'push-e2e',
    });
    pool = createPool({ connectionString: db.url, applicationName: 'push-e2e-worker', max: 3 });
    cache = new Redis(h.app.config.redis.url, { maxRetriesPerRequest: null });
    runtime = await startWorker(config, {
      logger: pino({ level: 'silent' }),
      queues: [pushQueue],
      consumers: [],
      services: {
        pg: pool,
        cache,
        ids: h.app.ids,
        keys: h.app.keys,
        publicIds: h.app.publicIds,
        realtime,
        media: null,
        photoModerator: { moderate: async () => ({ decision: 'review' }) } as never,
        push: new FcmSender({ account, fetch: fcm.fetch, tokenUrl: 'https://oauth.test/token', apiBase: 'https://fcm.test' }),
      },
    });
  }, 90_000);

  afterAll(async () => {
    await runtime?.stop();
    await pool?.end();
    await cache?.quit();
    await h?.close();
    await db?.drop();
  });

  const people: SeededUser[] = [];

  async function person(name: string, token: string): Promise<SeededUser> {
    const user = await seedUser(h, { name });
    people.push(user);
    // The app registers its token as it does on a phone.
    const registered = await call(h, '/v1/devices/current', {
      method: 'PUT',
      token: user.token,
      body: { pushToken: token, notificationsEnabled: true, appVersion: '1.0.0', locale: 'en' },
    });
    expect(registered.statusCode, registered.body).toBe(204);
    return user;
  }

  async function send(user: SeededUser, conversationId: string, body: string): Promise<string> {
    const response = await call(h, `/v1/conversations/${conversationId}/messages`, { method: 'POST', token: user.token, body: { clientId: randomUUID(), kind: 'text', body } });
    expect(response.statusCode, response.body).toBe(201);
    return sentMessageSchema.parse(response.json()).message.id;
  }

  const messagePushesTo = (token: string) => fcm.ofType('message').filter((r) => r.token === token);

  /** Nothing more reaches FCM for a while (the settle wait and a margin). */
  async function quiet(ms = 2_500): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  it('collapses a burst of messages into one push, generic and PRIVATE, at no statement on the send path', async () => {
    const ava = await person('Ava', 'e2e-token-ava');
    const ben = await person('Ben', 'e2e-token-ben');
    const conversation = await matchOf(h, ava.id, ben.id);
    const sent: string[] = [];
    for (let i = 0; i < 12; i += 1) sent.push(await send(ava, conversation.id, `message ${i}`));
    await until(() => messagePushesTo('e2e-token-ben').length >= 1);
    await quiet();
    const pushes = messagePushesTo('e2e-token-ben');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.body.message.data).toEqual({ type: 'message', conversationId: conversation.id, messageId: sent[0] });
    expect(pushes[0]!.body.message.android).toMatchObject({
      priority: 'HIGH',
      notification: { title: 'New message', body: 'You have a new message.', channel_id: 'messages', tag: `c:${conversation.id}`, visibility: 'PRIVATE' },
    });
    // The sender is never pushed about their own messages.
    expect(messagePushesTo('e2e-token-ava')).toHaveLength(0);
    // The send path itself stayed at zero statements once warm.
    const response = await call(h, `/v1/conversations/${conversation.id}/messages`, {
      method: 'POST',
      token: ava.token,
      body: { clientId: randomUUID(), kind: 'text', body: 'still free' },
    });
    expect(statements(response)).toBe(0);
    await quiet(500);
    expect(messagePushesTo('e2e-token-ben')).toHaveLength(1);
  });

  it('sends nothing while the person has the conversation on screen; once they read and look away, the next message is pushed', async () => {
    const cleo = await person('Cleo', 'e2e-token-cleo');
    const dan = await person('Dan', 'e2e-token-dan');
    const conversation = await matchOf(h, cleo.id, dan.id);
    const first = await send(cleo, conversation.id, 'hi Dan');
    await until(() => messagePushesTo('e2e-token-dan').length === 1);
    // Dan opens the thread: the app's read receipt marks it on screen.
    const read = await call(h, `/v1/conversations/${conversation.id}/receipts`, { method: 'POST', token: dan.token, body: { readUpTo: first } });
    expect(read.statusCode).toBe(204);
    expect(statements(read)).toBe(0);
    await send(cleo, conversation.id, 'are you there?');
    await quiet();
    expect(messagePushesTo('e2e-token-dan')).toHaveLength(1);
    // Dan leaves the app (the on-screen mark runs out after 30 s): the read reopened the window.
    await h.redis.del(chatKeys(h.app.keys).viewing(dan.id));
    const later = await send(cleo, conversation.id, 'ok, talk later');
    await until(() => messagePushesTo('e2e-token-dan').length === 2);
    expect(messagePushesTo('e2e-token-dan')[1]!.body.message.data).toMatchObject({ messageId: later });
  });

  it('leaves no job in Valkey without its queue\'s retention, and keeps completed pushes only briefly (criterion 8)', async () => {
    const prefix = queuePrefix(h.prefix);
    let seen = 0;
    for (const name of Object.keys(queueJobs) as ActiveQueueName[]) {
      const queue = new Queue(name, { connection: h.redis, prefix });
      try {
        const jobs = await queue.getJobs(['completed', 'failed', 'waiting', 'delayed', 'active', 'prioritized', 'waiting-children']);
        for (const job of jobs) {
          seen += 1;
          const retention = queueRetention(name);
          expect(job.opts.removeOnComplete, `${name}/${job.id}`).toEqual(retention.removeOnComplete);
          expect(job.opts.removeOnFail, `${name}/${job.id}`).toEqual(retention.removeOnFail);
        }
        if (name === 'push') {
          const completed = await queue.getJobs(['completed']);
          expect(completed.length).toBeGreaterThanOrEqual(3);
          for (const job of completed) expect(job.opts.removeOnComplete).toEqual({ age: 600 });
        }
      } finally {
        await queue.close();
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('never carried a user id, a public id, an e-mail address or a phone number to FCM', () => {
    expect(fcm.requests.length).toBeGreaterThanOrEqual(3);
    const rest = JSON.stringify(fcm.requests.map((r) => ({ data: r.body.message.data, android: r.body.message.android })));
    expect(rest).not.toMatch(/@|\+\d/);
    for (const key of ['userId', 'senderName', 'preview', 'publicUid']) expect(rest).not.toContain(key);
    for (const p of people) {
      expect(rest).not.toContain(p.id);
      expect(rest).not.toContain(p.publicUid);
    }
  });
});
