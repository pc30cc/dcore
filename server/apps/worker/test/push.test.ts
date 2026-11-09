import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createPool, instrumentPool, statementCounter, type Pool } from '@app/db';
import { pushDataSchema } from '@app/shared';
import {
  FcmEndpointFake,
  FcmSender,
  FakeRealtimePublisher,
  IdGenerator,
  acceptCall,
  callKeys,
  cancelCall,
  chatKeys,
  createKeys,
  createPublicIds,
  parseServiceAccount,
  placeCall,
  readCall,
  type CallJobQueue,
} from '@app/shared/server';
import { DelayedError, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MESSAGE_PUSH_SETTLE_MS, PushRetryError, callsQueue, loadConfig, sendPushJob, type JobContext, type PushJobRun } from '../src/index.js';
import { FakePhotoModerator } from '../src/photos/moderation.js';
import { firstName, pushPreview } from '../src/push/texts.js';
import type { WorkerServices } from '../src/services.js';
import { ensureGroupRoles, hasDatabase, loginRole, migratedDatabase, type TestDatabase } from './db.js';
import { TEST_REDIS_URL, baseEnv, connect, hasRedis } from './support.js';

/**
 * The push sender against PostgreSQL, Valkey and the real FCM client (FCM's
 * HTTP v1 endpoint and Google's token endpoint faked in process): every
 * kind of push the worker sends, the re-checks before a message push, the
 * retry that never alerts a phone twice, dead tokens, the ring and its stop
 * in order at FCM, and a scan of every request FCM received for anything
 * that names a person.
 */

interface StandInJob extends PushJobRun {
  delayedUntil?: number;
}

function standIn(data: Record<string, unknown>, options: { attempts?: number; attemptsMade?: number } = {}): StandInJob {
  const job: StandInJob = {
    name: 'send',
    data,
    attemptsMade: options.attemptsMade ?? 0,
    opts: { attempts: options.attempts ?? 3 },
    async moveToDelayed(timestamp: number) {
      job.delayedUntil = timestamp;
    },
    async updateData(next: unknown) {
      job.data = next;
    },
  };
  return job;
}

describe('push text rules', () => {
  it('shows a text only when it holds no link, e-mail address or phone number, on one line, cut short', () => {
    expect(pushPreview('Hello there!\nHow are you?')).toBe('Hello there! How are you?');
    expect(pushPreview('x'.repeat(300))).toHaveLength(100);
    for (const risky of [
      'call me +98 912 123 4567',
      'شماره‌ام ۰۹۱۲۱۲۳۴۵۶۷ است',
      'رقمي ٠٩١٢١٢٣٤٥٦٧',
      'write to ava@example.com',
      'see https://example.com/x',
      'my page www.example.org',
      'tg: example.me',
    ]) {
      expect(pushPreview(risky), risky).toBeUndefined();
    }
    expect(pushPreview('   ')).toBeUndefined();
    expect(firstName('Negar Ahmadi')).toBe('Negar');
    expect(firstName('+989121234567')).toBe('');
    expect(firstName('ava@example.com')).toBe('');
    expect(firstName('+98 912 765 4321')).toBe('');
    expect(firstName('علی‌رضا کریمی')).toBe('علی‌رضا');
    expect(firstName("O'Neil")).toBe("O'Neil");
  });
});

describe.skipIf(!hasDatabase || !hasRedis)('the push sender (PostgreSQL, Valkey, FCM faked at its HTTP API)', () => {
  let db: TestDatabase;
  let pg: Pool;
  let redis: Redis;
  let ids: IdGenerator;
  let fcm: FcmEndpointFake;
  let services: WorkerServices;
  let context: JobContext;
  let role: Awaited<ReturnType<typeof loginRole>>;
  const prefix = `t${randomBytes(4).toString('hex')}:`;
  const keys = createKeys(prefix);
  const c = chatKeys(keys);
  const env = baseEnv();
  const publicIds = createPublicIds(env['ID_PUBLIC_KEY']!, env['ID_BILLING_KEY']!);
  /** Everyone seeded, for the privacy scan at the end. */
  const people: { id: string; name: string }[] = [];
  const tokens: string[] = [];

  beforeAll(async () => {
    await ensureGroupRoles();
    role = await loginRole(['app_rw']);
    db = await migratedDatabase();
    pg = instrumentPool(createPool({ connectionString: db.urlFor(role.name, role.password), applicationName: 'push-test', max: 4 }), statementCounter);
    redis = connect();
    ids = new IdGenerator({ redis, keyPrefix: prefix });
    await ids.start();
    fcm = new FcmEndpointFake();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const account = parseServiceAccount(
      JSON.stringify({
        project_id: 'push-test-project',
        client_email: 'sender@push-test-project.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
    )!;
    services = {
      pg,
      cache: redis,
      ids,
      keys,
      publicIds,
      realtime: new FakeRealtimePublisher(),
      media: null,
      photoModerator: new FakePhotoModerator({ autoApprove: false }),
      push: new FcmSender({ account, fetch: fcm.fetch, tokenUrl: 'https://oauth.test/token', apiBase: 'https://fcm.test' }),
    };
    const config = loadConfig({ ...env, DATABASE_URL: db.url, REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix, WORKER_ID: 'push-test' });
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

  /** Every request FCM received in this suite, for the privacy scan at the end. */
  const collected: FcmEndpointFake['requests'] = [];
  beforeEach(() => {
    collected.push(...fcm.requests);
    fcm.requests.length = 0;
  });

  async function person(name = 'Ava Moradi', options: { flags?: number; locale?: string } = {}): Promise<string> {
    const id = ids.nextId();
    await db.admin.query(
      `INSERT INTO users (id, status, birth_date, gender, country, onboarding_step, notify_flags, locale) VALUES ($1, 3, DATE '1994-05-17', 2, 'IR', 30, $2, $3)`,
      [id, options.flags ?? 15, options.locale ?? 'en'],
    );
    await db.admin.query(`INSERT INTO profiles (user_id, display_name) VALUES ($1, $2)`, [id, name]);
    people.push({ id, name });
    return id;
  }

  async function device(userId: string, token: string, locale: string | null = 'en'): Promise<string> {
    const deviceId = ids.nextId();
    await db.admin.query(
      `INSERT INTO devices (id, user_id, app_version, platform, store, push_token, push_token_hash, locale) VALUES ($1, $2, 100, 1, 2, $3::text, sha256(convert_to($3::text, 'UTF8')), $4)`,
      [deviceId, userId, token, locale],
    );
    await db.admin.query(`INSERT INTO sessions (id, user_id, device_id, expires_at, store, refresh_hash) VALUES ($1, $2, $3, now() + interval '30 days', 2, $4)`, [
      ids.nextId(),
      userId,
      deviceId,
      randomBytes(32),
    ]);
    tokens.push(token);
    return deviceId;
  }

  /** A conversation's cached state, as the chat paths leave it. */
  async function conversation(a: string, b: string): Promise<{ id: string; lo: string; hi: string }> {
    const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
    const id = ids.nextId();
    await redis.hset(keys.matchState(id), { lo, hi, st: 1, fl: 3, src: 1, at: Date.now() });
    return { id, lo, hi };
  }

  function messagePush(userId: string, conversationId: string, extra: Record<string, unknown> = {}) {
    return { type: 'message', userId, conversationId, messageId: ids.nextId(), ...extra };
  }

  /** Runs a message push as if its message were old enough (the settle wait is tested on its own). */
  function settled(job: PushJobRun) {
    return sendPushJob(job, context, { now: () => Date.now() + MESSAGE_PUSH_SETTLE_MS + 1 });
  }

  function notificationOf(index = 0): Record<string, unknown> {
    const android = fcm.requests[index]!.body.message.android as { notification?: Record<string, unknown> };
    return android.notification ?? {};
  }

  describe('a message push', () => {
    it('is generic and PRIVATE without the previews switch, and costs one statement', async () => {
      const ava = await person('Ava Moradi');
      const ben = await person('Ben Karimi');
      await device(ben, 'tok-msg-ben-1');
      const conv = await conversation(ava, ben);
      const data = messagePush(ben, conv.id, { senderName: 'Ava', preview: 'Are you free on Friday?' });
      const { result, tally } = await statementCounter.measure(() => settled(standIn(data)));
      expect(result).toEqual({ outcome: 'sent', devices: 1, failed: 0, cleared: 0 });
      expect(tally.statements).toBe(1);
      expect(fcm.requests).toHaveLength(1);
      const sent = fcm.requests[0]!.body.message;
      expect(sent.data).toEqual({ type: 'message', conversationId: conv.id, messageId: data.messageId });
      expect(sent.android).toMatchObject({ priority: 'HIGH', ttl: '86400s' });
      expect(notificationOf()).toEqual({
        title: 'New message',
        body: 'You have a new message.',
        sound: 'default',
        channel_id: 'messages',
        tag: `c:${conv.id}`,
        visibility: 'PRIVATE',
      });
      expect(JSON.stringify(fcm.requests)).not.toContain('Friday');
      expect(JSON.stringify(fcm.requests)).not.toContain('Ava');
    });

    it('names the sender by first name and shows the text with previews on, in each device\'s language', async () => {
      const ava = await person('Ava Moradi');
      const ben = await person('Ben Karimi', { flags: 15 | 32 });
      await device(ben, 'tok-msg-prev-fa', 'fa');
      await device(ben, 'tok-msg-prev-tr', 'tr');
      const conv = await conversation(ava, ben);
      await settled(standIn(messagePush(ben, conv.id, { senderName: 'Ava', preview: 'Are you free\non Friday?' })));
      const byToken = new Map(fcm.requests.map((r) => [r.token, r.body.message.android as { notification: Record<string, unknown> }]));
      expect(byToken.get('tok-msg-prev-fa')!.notification).toMatchObject({ title: 'Ava', body: 'Are you free on Friday?', visibility: 'PRIVATE' });
      expect(byToken.get('tok-msg-prev-tr')!.notification).toMatchObject({ title: 'Ava', body: 'Are you free on Friday?' });
      // A text with a phone number is never shown, previews or not.
      fcm.requests.length = 0;
      await settled(standIn(messagePush(ben, conv.id, { senderName: 'Ava', preview: 'call me 0912 345 6789' })));
      const shown = fcm.requests.map((r) => (r.body.message.android as { notification: Record<string, unknown> }).notification['body']);
      expect(shown.sort()).toEqual(['Sana bir mesaj gönderdi.', 'برای شما پیام فرستاد.'].sort());
      expect(JSON.stringify(fcm.requests)).not.toContain('0912');
    });

    it('waits until its message has settled, then skips a conversation on screen and gives the collapse window back', async () => {
      const ava = await person();
      const ben = await person();
      await device(ben, 'tok-msg-view');
      const conv = await conversation(ava, ben);
      const data = messagePush(ben, conv.id);
      const early = standIn(data);
      await expect(sendPushJob(early, context)).rejects.toBeInstanceOf(DelayedError);
      expect(early.delayedUntil).toBeGreaterThan(Date.now());
      expect(early.delayedUntil).toBeLessThanOrEqual(Date.now() + MESSAGE_PUSH_SETTLE_MS + 50);
      expect(fcm.requests).toHaveLength(0);
      // The reader opened the thread meanwhile (the app's read receipt set view:<uid>).
      await redis.set(c.messagePush(conv.id, ben), '1', 'EX', 600);
      await redis.set(c.viewing(ben), conv.id, 'EX', 30);
      const { result, tally } = await statementCounter.measure(() => settled(standIn(data)));
      expect(result).toEqual({ outcome: 'skipped', reason: 'viewing' });
      expect(tally.statements).toBe(0);
      expect(fcm.requests).toHaveLength(0);
      expect(await redis.exists(c.messagePush(conv.id, ben))).toBe(0);
      // Another conversation on screen does not count.
      await redis.set(c.viewing(ben), ids.nextId(), 'EX', 30);
      expect(await settled(standIn(messagePush(ben, conv.id)))).toMatchObject({ outcome: 'sent' });
    });

    it('skips a message the person already read on another device, and one of a conversation that ended', async () => {
      const ava = await person();
      const ben = await person();
      await device(ben, 'tok-msg-read');
      const conv = await conversation(ava, ben);
      const data = messagePush(ben, conv.id);
      await redis.hset(c.readPointers(conv.id), conv.lo === ben ? 'lo' : 'hi', ids.nextId());
      await redis.set(c.messagePush(conv.id, ben), '1', 'EX', 600);
      expect(await settled(standIn(data))).toEqual({ outcome: 'skipped', reason: 'read' });
      expect(await redis.exists(c.messagePush(conv.id, ben))).toBe(0);
      // The other person's pointer says nothing about this reader.
      await redis.del(c.readPointers(conv.id));
      await redis.hset(c.readPointers(conv.id), conv.lo === ben ? 'hi' : 'lo', ids.nextId());
      expect(await settled(standIn(messagePush(ben, conv.id)))).toMatchObject({ outcome: 'sent' });
      await redis.set(keys.matchEnded(conv.id), '1', 'EX', 3_600);
      expect(await settled(standIn(messagePush(ben, conv.id)))).toEqual({ outcome: 'skipped', reason: 'ended' });
    });

    it('respects the messages switch', async () => {
      const ava = await person();
      const ben = await person('Ben', { flags: 15 & ~1 });
      await device(ben, 'tok-msg-off');
      const conv = await conversation(ava, ben);
      expect(await settled(standIn(messagePush(ben, conv.id)))).toEqual({ outcome: 'skipped', reason: 'switched_off' });
      expect(fcm.requests).toHaveLength(0);
    });
  });

  describe('a message request push', () => {
    it('is always generic and private', async () => {
      const cleo = await person('Cleo', { flags: 15 | 32, locale: 'fa' });
      await device(cleo, 'tok-req-1', null);
      const requestId = ids.nextId();
      expect(await sendPushJob(standIn({ type: 'request', userId: cleo, requestId }), context)).toMatchObject({ outcome: 'sent', devices: 1 });
      const sent = fcm.requests[0]!.body.message;
      expect(sent.data).toEqual({ type: 'request', requestId });
      expect(notificationOf()).toMatchObject({ title: 'درخواست پیام جدید', channel_id: 'messages', tag: `r:${requestId}`, visibility: 'PRIVATE' });
    });
  });

  describe('delivery', () => {
    it('retries only the devices FCM did not take, so no phone is alerted twice, and drops the text before a last failure is kept', async () => {
      const ava = await person();
      const ben = await person('Ben', { flags: 15 | 32 });
      const first = await device(ben, 'tok-retry-ok');
      await device(ben, 'tok-retry-busy');
      fcm.answer('tok-retry-busy', 'unavailable');
      const conv = await conversation(ava, ben);
      const job = standIn(messagePush(ben, conv.id, { senderName: 'Ava', preview: 'hello' }), { attempts: 3 });
      await expect(settled(job)).rejects.toBeInstanceOf(PushRetryError);
      expect((job.data as { sent: string[] }).sent).toEqual([first]);
      expect((job.data as { preview?: string }).preview).toBe('hello');
      // BullMQ runs it again with the recorded progress.
      job.attemptsMade = 1;
      expect(await settled(job)).toEqual({ outcome: 'sent', devices: 2, failed: 0, cleared: 0 });
      expect(fcm.requests.filter((r) => r.token === 'tok-retry-ok')).toHaveLength(1);
      expect(fcm.requests.filter((r) => r.token === 'tok-retry-busy')).toHaveLength(2);

      // The last attempt: nothing it would have shown stays in the failed job.
      fcm.answer('tok-retry-busy', 'unavailable');
      const last = standIn(messagePush(ben, conv.id, { senderName: 'Ava', preview: 'secret plans' }), { attempts: 1 });
      await expect(settled(last)).rejects.toBeInstanceOf(PushRetryError);
      expect(last.data).not.toHaveProperty('preview');
      expect(last.data).not.toHaveProperty('senderName');
      expect(JSON.stringify(last.data)).not.toContain('secret');
    });

    it('clears dead tokens (unregistered, another project\'s, invalid) with their fingerprints, one statement each', async () => {
      const dan = await person('Dan');
      const live = await device(dan, 'tok-dead-live');
      const gone = await device(dan, 'tok-dead-unregistered');
      const other = await device(dan, 'tok-dead-mismatch');
      const broken = await device(dan, 'tok-dead-invalid');
      fcm.answerAlways('tok-dead-unregistered', 'unregistered');
      fcm.answerAlways('tok-dead-mismatch', 'sender_mismatch');
      fcm.answerAlways('tok-dead-invalid', 'invalid_token');
      for (const d of [live, gone, other, broken]) await redis.set(keys.device(d), 'fingerprint', 'EX', 600);
      const { result, tally } = await statementCounter.measure(() => sendPushJob(standIn({ type: 'match', userId: dan, conversationId: ids.nextId() }), context));
      expect(result).toEqual({ outcome: 'sent', devices: 4, failed: 3, cleared: 3 });
      // The targets, then one UPDATE per dead token.
      expect(tally.statements).toBe(4);
      const { rows } = await db.admin.query<{ id: string; push_token: string | null }>(`SELECT id::text, push_token FROM devices WHERE user_id = $1 ORDER BY id`, [dan]);
      expect(Object.fromEntries(rows.map((r) => [r.id, r.push_token]))).toEqual({ [live]: 'tok-dead-live', [gone]: null, [other]: null, [broken]: null });
      // The app's next registration of those devices writes again.
      expect(await redis.exists(keys.device(gone), keys.device(other), keys.device(broken))).toBe(0);
      expect(await redis.exists(keys.device(live))).toBe(1);
      // Nothing is sent to them again.
      fcm.requests.length = 0;
      await sendPushJob(standIn({ type: 'match', userId: dan, conversationId: ids.nextId() }), context);
      expect(fcm.requests.map((r) => r.token)).toEqual(['tok-dead-live']);
    });
  });

  describe('the ring and its stop at FCM', () => {
    const jobs: CallJobQueue = { add: async () => undefined };
    const calls = callsQueue({ livekit: null, identitySecret: null, jobs });

    function callJob(name: string, data: Record<string, unknown>) {
      const job = {
        name,
        data,
        attemptsMade: 0,
        attemptsStarted: 1,
        delayedUntil: 0,
        async moveToDelayed(timestamp: number) {
          job.delayedUntil = timestamp;
        },
        async updateData(next: Record<string, unknown>) {
          job.data = next;
        },
      };
      return job as unknown as Job & { delayedUntil: number };
    }

    async function ringingCall(): Promise<{ callId: string; caller: string; callee: string; phones: string[] }> {
      const caller = await person('Ava');
      const callee = await person('Ben');
      const phones = [await device(callee, `tok-ring-${randomBytes(3).toString('hex')}`), await device(callee, `tok-ring-${randomBytes(3).toString('hex')}`)];
      const callId = ids.nextId();
      const verdict = await placeCall(redis, keys, {
        id: callId,
        callerId: caller,
        calleeId: callee,
        matchId: ids.nextId(),
        kind: 'video',
        now: Date.now(),
        maxLive: null,
        shadow: false,
        fakeRingMs: 10_000,
        callerName: 'Ava',
      });
      expect(verdict).toBe('placed');
      return { callId, caller, callee, phones };
    }

    const lifecycle = () => ({ redis, keys, mintId: () => ids.nextId() });

    it('keeps a stop behind its ring in flight, sends it only to the phones rung but the one that answered', async () => {
      const { callId, phones } = await ringingCall();
      const release = fcm.hold((r) => r.body.message.data?.['type'] === 'call_incoming' && r.body.message.data['callId'] === callId);
      const ring = calls.process(callJob('ring-push', { callId, peerName: 'Ava' }), context);
      // The first phone's ring is in flight (the job rings the phones one after another).
      while (fcm.ofType('call_incoming').filter((r) => r.body.message.data?.['callId'] === callId).length < 1) await new Promise((r) => setTimeout(r, 5));
      // The callee answers on the first phone while the ring is still on its way to FCM.
      const call = (await readCall(redis, keys, callId))!;
      expect(await acceptCall(lifecycle(), call, phones[0], Date.now())).not.toBeNull();
      const stop = callJob('ring-stop', { callId, reason: 'answered_elsewhere' });
      await expect(calls.process(stop, context)).rejects.toBeInstanceOf(DelayedError);
      expect(stop.delayedUntil).toBeGreaterThan(0);
      expect(fcm.ofType('call_cancel')).toHaveLength(0);
      release();
      expect(await ring).toEqual({ outcome: 'rung', devices: 2 });
      expect(await calls.process(callJob('ring-stop', { callId, reason: 'answered_elsewhere' }), context)).toEqual({ outcome: 'stopped', devices: 1 });
      const rings = fcm.ofType('call_incoming').filter((r) => r.body.message.data?.['callId'] === callId);
      const stops = fcm.ofType('call_cancel').filter((r) => r.body.message.data?.['callId'] === callId);
      expect(stops).toHaveLength(1);
      // FCM had answered every ring before the stop reached it.
      for (const r of rings) expect(r.answered!).toBeLessThan(stops[0]!.arrived);
      const { rows } = await db.admin.query<{ id: string; push_token: string }>(`SELECT id::text, push_token FROM devices WHERE id = ANY($1::bigint[])`, [phones]);
      const tokenOf = new Map(rows.map((r) => [r.id, r.push_token]));
      expect(stops[0]!.token).toBe(tokenOf.get(phones[1]!));
      expect(stops[0]!.body.message).toMatchObject({ data: { type: 'call_cancel', callId, reason: 'answered_elsewhere' }, android: { priority: 'HIGH', ttl: '45s', collapse_key: `call:${callId}` } });
      // A ring is data-only: the app draws it (no notification block, no text).
      expect(rings[0]!.body.message.android).toEqual({ priority: 'HIGH', ttl: '45s', collapse_key: `call:${callId}` });
    });

    it('rings with a first name only, never one that is really a phone number or an e-mail address', async () => {
      for (const [given, shown] of [
        ['Ava Moradi', 'Ava'],
        ['+98 912 765 4321', '…'],
        ['ava.k@example.com', '…'],
      ] as const) {
        const { callId } = await ringingCall();
        expect(await calls.process(callJob('ring-push', { callId, peerName: given }), context)).toEqual({ outcome: 'rung', devices: 2 });
        const rings = fcm.ofType('call_incoming').filter((r) => r.body.message.data?.['callId'] === callId);
        expect(rings.map((r) => r.body.message.data?.['peerName'])).toEqual([shown, shown]);
      }
    });

    it('looks at the call again just before ringing: nothing is sent for a call that stopped ringing, and its stop needs nothing', async () => {
      const { callId } = await ringingCall();
      const call = (await readCall(redis, keys, callId))!;
      expect(await cancelCall(lifecycle(), call, Date.now())).not.toBeNull();
      expect(await calls.process(callJob('ring-push', { callId, peerName: 'Ava' }), context)).toMatchObject({ outcome: 'skipped' });
      expect(await calls.process(callJob('ring-stop', { callId, reason: 'cancelled' }), context)).toEqual({ outcome: 'stopped', devices: 0 });
      expect(fcm.requests.filter((r) => r.body.message.data?.['callId'] === callId)).toHaveLength(0);
      expect(await redis.hget(callKeys(keys).call(callId), 'rp')).toBe('stopped');
    });
  });

  // The fixtures themselves are scanned in packages/shared (pushPrivacy.test.ts).
  describe('privacy of every payload (criterion 6)', () => {
    it('nothing FCM received in this suite carries a user id, a public id, an e-mail address, a phone number or another device\'s token', async () => {
      // Two people whose "names" are contact details: a push never shows them.
      const phoneName = await person('+98 912 765 4321');
      const mailName = await person('ava.k@example.com');
      await device(phoneName, 'tok-scan-1');
      await device(mailName, 'tok-scan-2');
      await db.admin.query(`UPDATE users SET notify_flags = 63 WHERE id = ANY($1::bigint[])`, [[phoneName, mailName]]);
      const conv = await conversation(phoneName, mailName);
      await settled(standIn(messagePush(mailName, conv.id, { senderName: '+98 912 765 4321', preview: 'mail me at ava.k@example.com' })));
      await sendPushJob(standIn({ type: 'match', userId: phoneName, conversationId: conv.id, peerName: 'ava.k@example.com' }), context);
      expect(fcm.requests).toHaveLength(2);
      for (const r of fcm.requests) {
        const notification = (r.body.message.android as { notification: { title: string; body: string } }).notification;
        expect([notification.title, notification.body]).not.toContain('');
      }
      collected.push(...fcm.requests);
      expect(collected.length).toBeGreaterThan(10);
      const kinds = new Set(collected.map((r) => r.body.message.data?.['type']));
      for (const kind of ['message', 'request', 'match', 'call_incoming', 'call_cancel']) expect(kinds, kind).toContain(kind);
      for (const request of collected) {
        const { token, data, android } = request.body.message;
        // The device's own token, and only in its place.
        expect(tokens).toContain(token);
        const rest = JSON.stringify({ data, android });
        for (const other of tokens) expect(rest).not.toContain(other);
        scan(rest, `${data?.['type']} to a device`);
        for (const p of people) {
          expect(rest, 'a raw user id').not.toContain(p.id);
          expect(rest, 'a public id').not.toContain(publicIds.user.encode(p.id));
        }
        // Only the keys the contract lists for the type.
        expect(() => pushDataSchema.parse(data)).not.toThrow();
      }
    });
  });

  /** No e-mail address, no phone-like number (ids are 19 digits, counts short), no name of a user field. */
  function scan(text: string, where: string): void {
    expect(text, `${where}: an e-mail address`).not.toMatch(/[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i);
    expect(text, `${where}: a phone number`).not.toMatch(/\+\d|(?<![0-9])0?9\d{9}(?![0-9])|\b\d{3}[ -]\d{3}[ -]\d{4}\b/);
    expect(text, `${where}: a field naming a person`).not.toMatch(/"(user|uid|userId|publicUid|email|phone|callerId|calleeId|senderId|peerId)"/i);
  }
});
