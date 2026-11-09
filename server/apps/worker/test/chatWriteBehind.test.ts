import { randomBytes } from 'node:crypto';
import { createPool, deleteDecidedRequests, instrumentPool, requestBox, statementCounter, StatementCounter, type Pool } from '@app/db';
import { idFloor, idTime } from '@app/shared';
import {
  FakePushSender,
  FakeRealtimePublisher,
  IdGenerator,
  VIS_HI,
  VIS_LO,
  cacheChatState,
  chatKeys,
  createKeys,
  createPublicIds,
  largestIdAt,
  moveReceipts,
  takeReadFlushChunk,
  readWatermark,
  sendMessage,
  type ChatState,
  type StoredMessage,
} from '@app/shared/server';
import { DelayedError, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  classifyWriteBehindError,
  closeSocialQueues,
  defaultConsumers,
  loadConfig,
  messageBatchHandler,
  probeDatabase,
  readFlushJob,
  reportEvidenceJob,
  requestsSweepJob,
  startBatchConsumer,
  unsendClearJob,
  UNSEND_HOLD_RECHECK_MS,
  READ_FLUSH_CHUNK,
  type BatchConsumer,
  type JobContext,
  type MessageBatchStats,
} from '../src/index.js';
import { FakePhotoModerator } from '../src/photos/moderation.js';
import type { WorkerServices } from '../src/services.js';
import { ensureGroupRoles, hasDatabase, loginRole, migratedDatabase, type TestDatabase } from './db.js';
import { TEST_REDIS_URL, baseEnv, connect, eventually, hasRedis } from './support.js';

/**
 * The chat's write-behind against PostgreSQL and Valkey, as the worker's own
 * role (app_rw): `wb:msg` in batch mode at its defaults (one INSERT per
 * batch, the trim, the watermark), replays, the read-pointer flush, the
 * unsend clean-up, the report evidence that waits for the stream, and the
 * message request sweep.
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

describe.skipIf(!hasDatabase || !hasRedis)('the chat write-behind (PostgreSQL, Valkey)', () => {
  let db: TestDatabase;
  let pg: Pool;
  let redis: Redis;
  let ids: IdGenerator;
  let services: WorkerServices;
  let context: JobContext;
  let role: Awaited<ReturnType<typeof loginRole>>;
  const prefix = `t${randomBytes(4).toString('hex')}:`;
  const keys = createKeys(prefix);
  const c = chatKeys(keys);
  const env = baseEnv();
  const publicIds = createPublicIds(env['ID_PUBLIC_KEY']!, env['ID_BILLING_KEY']!);
  const extra: Redis[] = [];

  beforeAll(async () => {
    await ensureGroupRoles();
    role = await loginRole(['app_rw']);
    db = await migratedDatabase();
    pg = instrumentPool(createPool({ connectionString: db.urlFor(role.name, role.password), applicationName: 'chat-wb-test', max: 6 }), statementCounter);
    redis = connect();
    ids = new IdGenerator({ redis, keyPrefix: prefix });
    await ids.start();
    services = {
      pg,
      cache: redis,
      ids,
      keys,
      publicIds,
      realtime: new FakeRealtimePublisher(),
      media: null,
      photoModerator: new FakePhotoModerator({ autoApprove: false }),
      push: new FakePushSender(),
    };
    const config = loadConfig({ ...env, DATABASE_URL: db.url, REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix, WORKER_ID: 'chat-wb-test' });
    context = { config, redis, log: pino({ level: 'silent' }), services, token: 'test-token' };
  }, 90_000);

  afterAll(async () => {
    await closeSocialQueues(redis);
    await Promise.allSettled(extra.map((x) => x.quit()));
    await ids?.stop();
    await pg?.end();
    const left = await redis.keys(`${prefix}*`);
    if (left.length > 0) await redis.del(...left);
    await redis?.quit();
    await db?.drop();
    await role?.drop();
  });

  function connection(): Redis {
    const x = connect();
    extra.push(x);
    return x;
  }

  async function value<T>(text: string, values: unknown[] = []): Promise<T> {
    const { rows } = await db.admin.query(text, values);
    return Object.values(rows[0] as Record<string, T>)[0] as T;
  }

  async function person(name = 'Sam Lee'): Promise<string> {
    const id = ids.nextId();
    await db.admin.query(`INSERT INTO users (id, status, birth_date, gender, country, onboarding_step) VALUES ($1, 3, DATE '1994-05-17', 2, 'IR', 30)`, [id]);
    await db.admin.query(`INSERT INTO profiles (user_id, display_name) VALUES ($1, $2)`, [id, name]);
    return id;
  }

  async function conversation(): Promise<ChatState> {
    const [a, b] = [await person('Ava'), await person('Ben')];
    const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
    const id = ids.nextId();
    await db.admin.query(`INSERT INTO matches (id, user_lo, user_hi, source, flags) VALUES ($1, $2, $3, 1, 3)`, [id, lo, hi]);
    const state: ChatState = { id, lo, hi, state: 1, flags: 3, source: 1, createdMs: idTime(id).getTime(), vis: VIS_LO | VIS_HI };
    await cacheChatState(redis, keys, state);
    return state;
  }

  function writer(stats: MessageBatchStats, options: { claimIdleMs?: number; lingerMs?: number } = {}): BatchConsumer {
    return startBatchConsumer({
      redis: connection(),
      stream: keys.stream('msg'),
      group: 'pg',
      consumer: 'chat-wb-test',
      handler: messageBatchHandler(context, stats),
      blockMs: 100,
      watermarkKey: keys.streamWatermark('msg'),
      classify: classifyWriteBehindError,
      probe: () => probeDatabase(context),
      maxDeliveries: 0,
      redactFields: ['b'],
      ...options,
    });
  }

  const messageStats = (): MessageBatchStats => ({ batches: 0, rows: 0, inserted: 0, statements: 0 });

  it('is one of the consumers every worker runs, its dead letters without bodies', () => {
    const config = loadConfig({ ...env, REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix });
    const msg = defaultConsumers(config).find((d) => d.stream === keys.stream('msg'));
    expect(msg).toMatchObject({ kind: 'batch', group: 'pg', watermarkKey: keys.streamWatermark('msg'), maxDeliveries: 0, redactFields: ['b'] });
  });

  it('writes 10,000 messages in at most 40 INSERT statements at the default linger, then trims the stream and moves the watermark past them', async () => {
    const conversations = await Promise.all(Array.from({ length: 50 }, () => conversation()));
    const s = messageStats();
    const tally = StatementCounter.tally();
    const consumer = statementCounter.run(tally, () =>
      startBatchConsumer({
        redis: connection(),
        stream: keys.stream('msg'),
        group: 'pg',
        consumer: 'chat-wb-defaults',
        handler: messageBatchHandler(context, s),
        watermarkKey: keys.streamWatermark('msg'),
        classify: classifyWriteBehindError,
        probe: () => probeDatabase(context),
        maxDeliveries: 0,
        redactFields: ['b'],
      }),
    );
    const producers = Array.from({ length: 8 }, () => connection());
    const all: StoredMessage[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      const conv = conversations[i % conversations.length]!;
      all.push({ id: ids.nextId(), matchId: conv.id, senderId: i % 2 === 0 ? conv.lo : conv.hi, refId: null, kind: 1, flags: 0, body: `message ${i}` });
    }
    const started = Date.now();
    await Promise.all(
      producers.map(async (p, n) => {
        for (let i = n; i < all.length; i += producers.length) {
          const m = all[i]!;
          const conv = conversations.find((x) => x.id === m.matchId)!;
          const out = await sendMessage(p, keys, conv.lo, conv.hi, { message: m, clientId: randomBytes(8).toString('hex'), deliver: true });
          expect(out.outcome).toBe('sent');
        }
      }),
    );
    const produced = Date.now() - started;
    await eventually(() => s.inserted === 10_000, 60_000);
    // The watermark trails Valkey's clock by its 5 s margin while nothing is pending; the idle writer moves it on.
    const lastId = BigInt(all.at(-1)!.id);
    await eventually(async () => {
      const watermark = await readWatermark(redis, keys, 'msg');
      return watermark !== null && watermark > lastId;
    }, 15_000);
    await consumer.stop();
    expect(s.inserted).toBe(10_000);
    expect(tally.statements).toBeLessThanOrEqual(40);
    expect(tally.texts.every((t) => t.startsWith('INSERT INTO messages'))).toBe(true);
    expect(Number(await value<string>(`SELECT count(*)::text FROM messages`))).toBeGreaterThanOrEqual(10_000);
    // Trimmed by MINID once acknowledged.
    expect(await redis.xlen(keys.stream('msg'))).toBe(0);
    if (process.env['CHAT_TEST_REPORT'] === '1') process.stdout.write(`10,000 messages: ${tally.statements} INSERT statements, produced in ${produced} ms\n`);
  }, 120_000);

  it('inserts nothing for a replayed batch, and nothing twice for a message appended twice', async () => {
    const conv = await conversation();
    const s = messageStats();
    const consumer = writer(s);
    const m: StoredMessage = { id: ids.nextId(), matchId: conv.id, senderId: conv.lo, refId: null, kind: 1, flags: 0, body: 'only once' };
    await sendMessage(redis, keys, conv.lo, conv.hi, { message: m, clientId: 'twice-1', deliver: true });
    await eventually(async () => Number(await value<string>(`SELECT count(*)::text FROM messages WHERE match_id = $1`, [conv.id])) === 1);
    await consumer.stop();
    // The same batch delivered again (a worker that died after its INSERT, an XAUTOCLAIM): appended as it was.
    const fields = ['id', m.id, 'm', m.matchId, 's', m.senderId, 'k', '1', 'r', '', 'f', '0', 'b', m.body!];
    await redis.xadd(keys.stream('msg'), '*', ...fields);
    await redis.xadd(keys.stream('msg'), '*', ...fields);
    const replay = messageStats();
    const tally = StatementCounter.tally();
    const again = statementCounter.run(tally, () => writer(replay));
    await eventually(() => replay.rows === 2);
    await again.stop();
    expect(replay.inserted).toBe(0);
    expect(tally.statements).toBe(1);
    expect(await value<string>(`SELECT count(*)::text FROM messages WHERE match_id = $1`, [conv.id])).toBe('1');
  });

  it('dead-letters a malformed entry without its body and writes the rest of its batch', async () => {
    const conv = await conversation();
    const s = messageStats();
    const good = ids.nextId();
    await redis.xadd(keys.stream('msg'), '*', 'id', good, 'm', conv.id, 's', conv.lo, 'k', '1', 'r', '', 'f', '0', 'b', 'fine');
    await redis.xadd(keys.stream('msg'), '*', 'id', ids.nextId(), 'm', conv.id, 's', conv.lo, 'k', '7', 'r', '', 'f', '0', 'b', 'a secret');
    const consumer = writer(s);
    await eventually(async () => (await redis.xlen(keys.streamDead('msg'))) === 1);
    await eventually(async () => (await value<string>(`SELECT count(*)::text FROM messages WHERE match_id = $1`, [conv.id])) === '1');
    await consumer.stop();
    const letters = (await redis.xrange(keys.streamDead('msg'), '-', '+')) as [string, string[]][];
    const dead: string[] = letters[0]?.[1] ?? [];
    expect(dead).toContain('malformed');
    expect(dead.join(' ')).not.toContain('a secret');
  });

  it('flushes 1,000 receipts of a conversation within a minute with one UPDATE, only forward', async () => {
    const conv = await conversation();
    const maxId = largestIdAt(Date.now() + 5_000);
    let last = '';
    for (let i = 0; i < 1_000; i += 1) {
      last = ids.nextId();
      await moveReceipts(redis, keys, { matchId: conv.id, readerId: i % 2 === 0 ? conv.lo : conv.hi, side: i % 2 === 0 ? 'lo' : 'hi', readUpTo: last, maxId });
    }
    await redis.del(keys.jobLease('chat-read-flush'));
    const { result, tally } = await statementCounter.measure(() => readFlushJob(context));
    expect(result).toMatchObject({ leased: true, statements: 1 });
    expect(tally.statements).toBe(1);
    expect(tally.texts[0]).toContain('matches_flush_read');
    const row = await db.admin.query(`SELECT lo_read_id::text AS lo, hi_read_id::text AS hi FROM matches WHERE id = $1`, [conv.id]);
    expect(row.rows[0]).toEqual({ lo: (await redis.hget(c.readPointers(conv.id), 'lo'))!, hi: last });
    // Nothing moved since: the next minute writes nothing (and its lease stops a second run inside the minute).
    expect((await readFlushJob(context)).leased).toBe(false);
    await redis.del(keys.jobLease('chat-read-flush'));
    const idle = await statementCounter.measure(() => readFlushJob(context));
    expect(idle.tally.statements).toBe(0);
  });

  it('keeps the conversations of a flush that cannot be written, and writes them first on the next run', async () => {
    const conv = await conversation();
    const read = ids.nextId();
    await moveReceipts(redis, keys, { matchId: conv.id, readerId: conv.lo, side: 'lo', readUpTo: read, maxId: largestIdAt(Date.now() + 5_000) });
    await redis.del(keys.jobLease('chat-read-flush'));
    const broken = createPool({ connectionString: 'postgres://nobody:nothing@127.0.0.1:1/none', applicationName: 'broken', max: 1, connectTimeoutMs: 300 });
    try {
      await expect(readFlushJob({ ...context, services: { ...services, pg: broken } })).rejects.toThrow();
    } finally {
      await broken.end();
    }
    expect(await redis.sismember(c.readFlushing(), conv.id)).toBe(1);
    await redis.del(keys.jobLease('chat-read-flush'));
    expect((await readFlushJob(context)).written).toBeGreaterThanOrEqual(1);
    expect(await value<string>(`SELECT lo_read_id::text FROM matches WHERE id = $1`, [conv.id])).toBe(read);
    expect(await redis.scard(c.readFlushing())).toBe(0);
  });

  it('loses no read pointer when a flush dies between taking its chunk and writing it', async () => {
    const convs = [await conversation(), await conversation(), await conversation()];
    const reads = convs.map(() => ids.nextId());
    for (const [i, conv] of convs.entries()) {
      await moveReceipts(redis, keys, { matchId: conv.id, readerId: conv.hi, side: 'hi', readUpTo: reads[i]!, maxId: largestIdAt(Date.now() + 5_000) });
    }
    // A run takes its chunk and is killed (a deploy, an out-of-memory kill) before it writes anything.
    const taken = await takeReadFlushChunk(redis, keys, READ_FLUSH_CHUNK);
    expect(taken.left).toBe(false);
    expect(taken.ids).toEqual(expect.arrayContaining(convs.map((x) => x.id)));
    expect(await redis.sismember(c.readDirty(), convs[0]!.id)).toBe(0);
    // A receipt after the take moves one pointer further: it waits in rp:dirty.
    const later = ids.nextId();
    await moveReceipts(redis, keys, { matchId: convs[0]!.id, readerId: convs[0]!.hi, side: 'hi', readUpTo: later, maxId: largestIdAt(Date.now() + 5_000) });
    // The next run writes what the dead one left, then the rest.
    await redis.del(keys.jobLease('chat-read-flush'));
    await readFlushJob(context);
    expect(await value<string>(`SELECT hi_read_id::text FROM matches WHERE id = $1`, [convs[0]!.id])).toBe(later);
    for (const [i, conv] of convs.entries()) if (i > 0) expect(await value<string>(`SELECT hi_read_id::text FROM matches WHERE id = $1`, [conv.id])).toBe(reads[i]);
    expect(await redis.scard(c.readFlushing())).toBe(0);
    expect(await redis.scard(c.readDirty())).toBe(0);
  });

  it('clears an unsent body once its window is over, only the sender’s, and its preview with it', async () => {
    const conv = await conversation();
    const target = ids.nextId();
    await db.admin.query(`INSERT INTO messages (match_id, id, sender_id, kind, flags, body) VALUES ($1, $2, $3, 1, 0, 'oops')`, [conv.id, target, conv.lo]);
    await redis.hset(c.lastMessage(conv.id), { id: target, s: conv.lo, k: 1, r: '', f: 0, p: 'oops' });
    expect(await unsendClearJob(fakeJob('unsend-clear', { matchId: conv.id, targetId: target, senderId: conv.hi }), context)).toEqual({ outcome: 'nothing' });
    expect(await unsendClearJob(fakeJob('unsend-clear', { matchId: conv.id, targetId: target, senderId: conv.lo }), context)).toEqual({ outcome: 'cleared' });
    const row = await db.admin.query(`SELECT body, flags FROM messages WHERE match_id = $1 AND id = $2`, [conv.id, target]);
    expect(row.rows[0]).toEqual({ body: null, flags: 8 });
    expect(await redis.hget(c.lastMessage(conv.id), 'p')).toBe('');
    expect(await unsendClearJob(fakeJob('unsend-clear', { matchId: conv.id, targetId: target, senderId: conv.lo }), context)).toEqual({ outcome: 'nothing' });
  });

  it('keeps an unsent body while a legal hold names the conversation or either person, and clears it once released', async () => {
    for (const on of ['match', 'lo', 'hi'] as const) {
      const conv = await conversation();
      const target = ids.nextId();
      await db.admin.query(`INSERT INTO messages (match_id, id, sender_id, kind, flags, body) VALUES ($1, $2, $3, 1, 0, 'evidence')`, [conv.id, target, conv.hi]);
      await redis.hset(c.lastMessage(conv.id), { id: target, s: conv.hi, k: 1, r: '', f: 0, p: 'evidence' });
      const hold = ids.nextId();
      if (on === 'match') await db.admin.query(`INSERT INTO legal_holds (id, match_id, kind) VALUES ($1, $2, 3)`, [hold, conv.id]);
      else await db.admin.query(`INSERT INTO legal_holds (id, user_id, kind) VALUES ($1, $2, 1)`, [hold, on === 'lo' ? conv.lo : conv.hi]);
      const job = fakeJob('unsend-clear', { matchId: conv.id, targetId: target, senderId: conv.hi });
      const before = Date.now();
      await expect(unsendClearJob(job, { ...context, token: 'test-token' })).rejects.toBeInstanceOf(DelayedError);
      // The body stays in PostgreSQL; the job looks again a day later; the preview is gone all the same.
      expect((await db.admin.query(`SELECT body, flags FROM messages WHERE match_id = $1 AND id = $2`, [conv.id, target])).rows[0]).toEqual({ body: 'evidence', flags: 0 });
      expect(job.delayedUntil).toBeGreaterThanOrEqual(before + UNSEND_HOLD_RECHECK_MS);
      expect(await redis.hget(c.lastMessage(conv.id), 'p')).toBe('');
      // Released: the next look clears it.
      await db.admin.query(`UPDATE legal_holds SET released_at = now() WHERE id = $1`, [hold]);
      expect(await unsendClearJob(fakeJob('unsend-clear', { matchId: conv.id, targetId: target, senderId: conv.hi }), context)).toEqual({ outcome: 'cleared' });
      expect((await db.admin.query(`SELECT body, flags FROM messages WHERE match_id = $1 AND id = $2`, [conv.id, target])).rows[0]).toEqual({ body: null, flags: 8 });
    }
  });

  it('copies a chat report’s messages once the stream is durable past it, and after ten minutes from the stream itself', async () => {
    const conv = await conversation();
    const s = messageStats();
    const sent: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const m: StoredMessage = { id: ids.nextId(), matchId: conv.id, senderId: conv.hi, refId: null, kind: 1, flags: 0, body: `rude ${i}` };
      await sendMessage(redis, keys, conv.lo, conv.hi, { message: m, clientId: `ev-${i}`, deliver: true });
      sent.push(m.id);
    }
    const filingId = ids.nextId();
    await db.admin.query(`INSERT INTO reports (id, target_id, reporter_id, match_id, context, reason) VALUES ($1, $2, $3, $4, 2, 2)`, [filingId, conv.hi, conv.lo, conv.id]);
    const data = { reportId: filingId, filingId, reporterId: conv.lo, targetId: conv.hi, conversationId: conv.id, messageIds: [sent[1]!], queuedAtMs: Date.now() };
    // The writer has not run: the watermark is not past the report, so the job waits.
    await redis.set(keys.streamWatermark('msg'), idFloor(Date.now() - 60_000).toString());
    const waiting = fakeJob('report-evidence', data);
    await expect(reportEvidenceJob(waiting, context)).rejects.toBeInstanceOf(DelayedError);
    expect(waiting.delayedUntil).toBeGreaterThan(Date.now());
    const consumer = writer(s);
    await eventually(async () => {
      const wm = await readWatermark(redis, keys, 'msg');
      return wm !== null && wm > BigInt(filingId);
    }, 15_000);
    await consumer.stop();
    const done = await reportEvidenceJob(fakeJob('report-evidence', data), context);
    expect(done).toMatchObject({ outcome: 'copied', messages: 3, fromStream: 0 });
    const evidence = (await db.admin.query(`SELECT evidence, evidence_at FROM reports WHERE id = $1`, [filingId])).rows[0] as { evidence: { chat: { filingId: string; messages: { id: string; body: string }[] }[] }; evidence_at: Date | null };
    expect(evidence.evidence_at).not.toBeNull();
    expect(evidence.evidence.chat).toHaveLength(1);
    expect(evidence.evidence.chat[0]!.messages.map((m) => m.body)).toEqual(['rude 0', 'rude 1', 'rude 2']);
    // A replay copies nothing again.
    expect(await reportEvidenceJob(fakeJob('report-evidence', data), context)).toMatchObject({ messages: 0 });

    // The stream stuck (a writer that cannot write): after ten minutes the evidence comes from the stream itself.
    const stuck = await conversation();
    const late: StoredMessage = { id: ids.nextId(), matchId: stuck.id, senderId: stuck.hi, refId: null, kind: 1, flags: 0, body: 'still in the stream' };
    await sendMessage(redis, keys, stuck.lo, stuck.hi, { message: late, clientId: 'ev-late', deliver: true });
    const filing2 = ids.nextId();
    await db.admin.query(`INSERT INTO reports (id, target_id, reporter_id, match_id, context, reason) VALUES ($1, $2, $3, $4, 2, 2)`, [filing2, stuck.hi, stuck.lo, stuck.id]);
    await redis.set(keys.streamWatermark('msg'), idFloor(Date.now() - 60_000).toString());
    const data2 = { reportId: filing2, filingId: filing2, reporterId: stuck.lo, targetId: stuck.hi, conversationId: stuck.id, messageIds: [], queuedAtMs: Date.now() - 11 * 60_000 };
    expect(await reportEvidenceJob(fakeJob('report-evidence', data2), context)).toMatchObject({ outcome: 'copied', messages: 1, fromStream: 1 });
    const second = (await db.admin.query(`SELECT evidence FROM reports WHERE id = $1`, [filing2])).rows[0] as { evidence: { chat: { messages: { body: string; fromStream?: boolean }[] }[] } };
    expect(second.evidence.chat[0]!.messages).toEqual([expect.objectContaining({ body: 'still in the stream', fromStream: true })]);
    const drain = writer(messageStats());
    await eventually(async () => (await redis.xlen(keys.stream('msg'))) === 0, 15_000);
    await drain.stop();
  }, 60_000);

  it('takes the messages right before a report from the stream, however large the backlog before them', async () => {
    const conv = await conversation();
    const stream = keys.stream('msg');
    const send = async (body: string): Promise<string> => {
      const m: StoredMessage = { id: ids.nextId(), matchId: conv.id, senderId: conv.hi, refId: null, kind: 1, flags: 0, body };
      await sendMessage(redis, keys, conv.lo, conv.hi, { message: m, clientId: `bk-${m.id}`, deliver: true });
      return m.id;
    };
    const early: string[] = [];
    for (let i = 0; i < 3; i += 1) early.push(await send(`early ${i}`));
    // An outage's backlog of other conversations between them and the report: more than any one read.
    const filler: string[] = [];
    for (let batch = 0; batch < 25; batch += 1) {
      const pipeline = redis.pipeline();
      for (let i = 0; i < 1_000; i += 1) pipeline.xadd(stream, '*', 'm', '1', 'id', '1');
      for (const [, id] of (await pipeline.exec()) ?? []) filler.push(String(id));
    }
    const late: string[] = [];
    for (let i = 0; i < 60; i += 1) late.push(await send(`late ${i}`));
    const filingId = ids.nextId();
    await db.admin.query(`INSERT INTO reports (id, target_id, reporter_id, match_id, context, reason) VALUES ($1, $2, $3, $4, 2, 2)`, [filingId, conv.hi, conv.lo, conv.id]);
    await redis.set(keys.streamWatermark('msg'), idFloor(Date.now() - 60_000).toString());
    try {
      const data = { reportId: filingId, filingId, reporterId: conv.lo, targetId: conv.hi, conversationId: conv.id, messageIds: [early[1]!], queuedAtMs: Date.now() - 11 * 60_000 };
      const done = await reportEvidenceJob(fakeJob('report-evidence', data), context);
      // The 50 just before the report and the one it names.
      expect(done).toMatchObject({ outcome: 'copied', fromStream: 51 });
      const evidence = (await db.admin.query(`SELECT evidence FROM reports WHERE id = $1`, [filingId])).rows[0] as { evidence: { chat: { messages: { id: string; body: string }[] }[] } };
      expect(evidence.evidence.chat[0]!.messages.map((m) => m.body)).toEqual(['early 1', ...late.slice(10).map((_, i) => `late ${i + 10}`)]);
    } finally {
      for (let i = 0; i < filler.length; i += 1_000) await redis.xdel(stream, ...filler.slice(i, i + 1_000));
    }
  }, 60_000);

  it('expires pending requests after 14 days and deletes decided ones after their retention', async () => {
    const [a, b, x] = [await person(), await person(), await person()];
    const old = idFloor(Date.now() - 15 * 86_400_000).toString();
    const fresh = ids.nextId();
    await db.admin.query(`INSERT INTO message_requests (id, from_id, to_id, body) VALUES ($1, $2, $3, 'hello')`, [old, a, b]);
    await db.admin.query(`INSERT INTO message_requests (id, from_id, to_id, body) VALUES ($1, $2, $3, 'hi')`, [fresh, x, b]);
    // Sent 45 days ago, declined after a day: its retention ran out (from when it would have expired, day 14).
    const decided = idFloor(Date.now() - 45 * 86_400_000).toString();
    await db.admin.query(`INSERT INTO message_requests (id, from_id, to_id, body, status, decided_at) VALUES ($1, $2, $3, 'no', 3, now() - interval '44 days')`, [decided, b, a]);
    await redis.del(keys.jobLease('requests-sweep'));
    const result = await requestsSweepJob(context);
    expect(result).toEqual({ leased: true, expired: 1, deleted: 1 });
    const rows = (await db.admin.query(`SELECT id::text, status FROM message_requests WHERE id = ANY ($1::bigint[]) ORDER BY id`, [[old, fresh, decided]])).rows;
    expect(rows).toEqual([
      { id: old, status: 4 },
      { id: fresh, status: 1 },
    ]);
  });

  it('keeps a declined request in the sender’s box exactly as long as an ignored one, so its end reveals nothing', async () => {
    const [a, b, c, d] = [await person(), await person(), await person(), await person()];
    // Both sent 32 days ago: one declined the next day, one left alone (it expired on day 14, the sweep wrote that then).
    const sent = (offsetMs: number) => idFloor(Date.now() - 32 * 86_400_000 + offsetMs).toString();
    const declined = sent(0);
    const ignored = sent(1_000);
    await db.admin.query(`INSERT INTO message_requests (id, from_id, to_id, body, status, decided_at) VALUES ($1, $2, $3, 'no thanks', 3, now() - interval '31 days')`, [declined, a, b]);
    await db.admin.query(`INSERT INTO message_requests (id, from_id, to_id, body, status, decided_at) VALUES ($1, $2, $3, 'hello?', 4, now() - interval '18 days')`, [ignored, c, d]);
    await redis.del(keys.jobLease('requests-sweep'));
    expect(await requestsSweepJob(context)).toMatchObject({ deleted: 0 });
    // Each sender's box reads the same: expired.
    expect((await requestBox(pg, a, 'sent', 10, null)).map((r) => r.status)).toEqual([4]);
    expect((await requestBox(pg, c, 'sent', 10, null)).map((r) => r.status)).toEqual([4]);
    // Both go once 30 days have passed since day 14 (the sweep uses the same clock for both).
    expect(await deleteDecidedRequests(pg, 100, 17)).toBeGreaterThanOrEqual(2);
    expect(await value<string>(`SELECT count(*)::text FROM message_requests WHERE id = ANY ($1::bigint[])`, [[declined, ignored]])).toBe('0');
  });
});
