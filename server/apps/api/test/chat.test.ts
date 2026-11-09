import { randomUUID } from 'node:crypto';
import {
  conversationSchema,
  conversationsPageSchema,
  messagesPageSchema,
  messageRequestsPageSchema,
  sentMessageSchema,
  sentRequestBodySchema,
  conversationBodySchema,
  type Conversation,
} from '@app/shared';
import { chatKeys, FakePresence, FakeRealtimePublisher, readChatState } from '@app/shared/server';
import { reportEvidenceJob } from '@app/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { WRITE_LAG_HEADER } from '../src/routes/chat.js';
import { call, json, migratedDatabase, problemExt, row, seedUser, setAppConfig, startHarness, statements, type Harness, type SeededUser, type TestDatabase } from './accountSupport.js';
import { eventsOf, fakeJob, matchOf, startChatPipeline, until, type ChatPipeline } from './chatSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * The chat end to end: the API (messages, history, receipts, typing,
 * settings, the list, message requests, chat reports) with the `wb:msg`
 * writer running beside it on the same database and Valkey prefix. Every
 * route's budget is enforced; statement counts are the pool's
 * (`x-pg-statements`).
 */

describe.skipIf(!hasInfrastructure)('chat (PostgreSQL, Valkey)', () => {
  let db: TestDatabase;
  let h: Harness;
  let realtime: FakeRealtimePublisher;
  let jobs: MemoryJobProducer;
  let presence: FakePresence;
  let pipeline: ChatPipeline;

  beforeAll(async () => {
    db = await migratedDatabase();
    realtime = new FakeRealtimePublisher();
    jobs = new MemoryJobProducer();
    presence = new FakePresence();
    h = await startHarness(db, {}, { realtime, jobs, chat: { presence } });
    pipeline = await startChatPipeline(h, realtime, { claimIdleMs: 3_000 });
  }, 90_000);

  afterAll(async () => {
    await pipeline?.stop();
    await h?.close();
    await db?.drop();
  });

  const seeded: SeededUser[] = [];

  async function person(name: string, options: Parameters<typeof seedUser>[1] = {}): Promise<SeededUser> {
    const user = await seedUser(h, { name, ...options });
    seeded.push(user);
    return user;
  }

  async function pair(a = 'Ava', b = 'Ben', flags?: number) {
    const x = await person(a);
    const y = await person(b);
    const m = await matchOf(h, x.id, y.id, flags === undefined ? {} : { flags });
    return { a: x, b: y, id: m.id, lo: m.lo, hi: m.hi };
  }

  function send(user: SeededUser, conversationId: string, body: Record<string, unknown>) {
    return call(h, `/v1/conversations/${conversationId}/messages`, { method: 'POST', token: user.token, body: { clientId: randomUUID(), ...body } });
  }

  async function durable(conversationId: string, n: number): Promise<void> {
    await until(async () => Number((await row<{ n: string }>(db, `SELECT count(*)::text AS n FROM messages WHERE match_id = $1`, [conversationId])).n) >= n);
  }

  /** The person's plan is cached (`ent:`), as after any request that needed it. */
  async function warmPlan(user: SeededUser): Promise<void> {
    const list = await call(h, '/v1/conversations', { token: user.token });
    expect(list.statusCode).toBe(200);
  }

  describe('sending', () => {
    it('costs no statement once the conversation is warm, publishes to both, and answers a retry with the same message', async () => {
      const { a, b, id } = await pair();
      const first = await send(a, id, { kind: 'text', body: 'Hello!' });
      expect(first.statusCode, first.body).toBe(201);
      // The conversation's state with each side's visibility, and the sender's name for the push: read once.
      expect(statements(first)).toBeLessThanOrEqual(2);
      const clientId = randomUUID();
      const sent = await send(a, id, { clientId, kind: 'text', body: 'How are you?' });
      expect(sent.statusCode).toBe(201);
      expect(statements(sent)).toBe(0);
      const message = sentMessageSchema.parse(sent.json()).message;
      expect(message).toMatchObject({ conversationId: id, senderId: a.publicUid, clientId, kind: 'text', body: 'How are you?' });
      // Both channels got it, under the message id.
      for (const u of [a, b]) expect(eventsOf(realtime, u.publicUid, 'message').filter((e) => e.id === message.id)).toHaveLength(1);
      // The outbox resends: the same message, 200, nothing appended or published again.
      const retry = await send(a, id, { clientId, kind: 'text', body: 'How are you?' });
      expect(retry.statusCode).toBe(200);
      expect(statements(retry)).toBe(0);
      expect(sentMessageSchema.parse(retry.json()).message.id).toBe(message.id);
      expect(eventsOf(realtime, b.publicUid, 'message').filter((e) => e.id === message.id)).toHaveLength(1);
      await durable(id, 2);
      expect((await row<{ n: string }>(db, `SELECT count(*)::text AS n FROM messages WHERE match_id = $1 AND id = $2`, [id, message.id])).n).toBe('1');
    });

    it('queues one message push per conversation and recipient per 10 minutes, none while they look at it', async () => {
      const { a, b, id } = await pair();
      const before = jobs.jobs.length;
      await send(a, id, { kind: 'text', body: 'one' });
      await send(a, id, { kind: 'text', body: 'two' });
      const pushes = jobs.jobs.slice(before).filter((j) => j.queue === 'push' && j.data['type'] === 'message');
      expect(pushes).toHaveLength(1);
      expect(pushes[0]!.data).toMatchObject({ userId: b.id, conversationId: id, senderName: 'Ava' });
      // Push data names no one: the job carries the raw recipient for the worker, never a phone or an e-mail.
      expect(JSON.stringify(pushes[0]!.data)).not.toMatch(/@|\+98/);
      const { a: c, b: d, id: other } = await pair('Cleo', 'Dan');
      // Dan has the conversation on screen.
      await call(h, `/v1/conversations/${other}/receipts`, { method: 'POST', token: d.token, body: { readUpTo: h.app.ids.nextId() } });
      const mark = jobs.jobs.length;
      await send(c, other, { kind: 'text', body: 'are you there?' });
      expect(jobs.jobs.slice(mark).filter((j) => j.queue === 'push')).toHaveLength(0);
    });

    it('refuses image and voice for now, a refused term, and asks once for a doubtful one', async () => {
      const { a, id } = await pair();
      expect((await send(a, id, { kind: 'image', mediaId: '123' })).statusCode).toBe(422);
      await h.db.sql.query(`INSERT INTO banned_terms (match_kind, severity, scope, term) VALUES (2, 3, 8, 'scamword'), (2, 1, 8, 'doubtword')`);
      await setAppConfig(h, 'chat.max_body_chars', 2_000);
      const refused = await send(a, id, { kind: 'text', body: 'this is a scamword' });
      expect(refused.statusCode).toBe(422);
      expect(json(refused)['code']).toBe('message_refused');
      const clientId = randomUUID();
      const ask = await send(a, id, { clientId, kind: 'text', body: 'a doubtword here' });
      expect(ask.statusCode).toBe(409);
      const ext = problemExt('confirm_required', ask.json());
      const anyway = await send(a, id, { clientId, kind: 'text', body: 'a doubtword here', confirm: ext['confirmToken'] });
      expect(anyway.statusCode).toBe(201);
      const message = sentMessageSchema.parse(anyway.json()).message;
      await durable(id, 1);
      expect((await row<{ flags: number }>(db, `SELECT flags FROM messages WHERE match_id = $1 AND id = $2`, [id, message.id])).flags & 4).toBe(4);
      expect((await send(a, id, { kind: 'text', body: 'x'.repeat(2_001) })).statusCode).toBe(422);
    });

    it('lets only the sender take a message back, and queues the body clean-up for after the report window', async () => {
      const { a, b, id } = await pair();
      const sent = sentMessageSchema.parse((await send(a, id, { kind: 'text', body: 'oops' })).json()).message;
      // Seconds old: still in the stream, found there.
      expect((await send(b, id, { kind: 'unsend', refId: sent.id })).statusCode).toBe(404);
      const unsend = await send(a, id, { kind: 'unsend', refId: sent.id });
      expect(unsend.statusCode).toBe(201);
      const job = jobs.jobs.find((j) => j.queue === 'chat' && j.name === 'unsend-clear' && j.data['targetId'] === sent.id);
      expect(job?.options.delayMs).toBe(24 * 3_600_000);
      // An older message is read by its key (one statement).
      await durable(id, 2);
      const old = sentMessageSchema.parse((await send(a, id, { kind: 'text', body: 'later' })).json()).message;
      await durable(id, 3);
      await h.redis.xtrim(h.app.keys.stream('msg'), 'MAXLEN', 0);
      const back = await send(a, id, { kind: 'unsend', refId: old.id });
      expect(back.statusCode).toBe(201);
      expect(statements(back)).toBe(1);
      // Before the clear job runs, no page hands the body to the other person, wherever the unsend is.
      const backId = sentMessageSchema.parse(back.json()).message.id;
      await durable(id, 4);
      const page = async (query: string) => messagesPageSchema.parse((await call(h, `/v1/conversations/${id}/messages${query}`, { token: b.token })).json()).items;
      const alone = await page(`?before=${backId}&limit=1`);
      expect(alone.map((m) => m.id)).toEqual([old.id]);
      expect(alone[0]?.body).toBeUndefined();
      const first = await page(`?before=${old.id}&limit=2`);
      expect(first.find((m) => m.id === sent.id)?.body).toBeUndefined();
      expect((await page('')).filter((m) => m.kind === 'text').every((m) => m.body === undefined)).toBe(true);
      // A message nobody took back keeps its body.
      const kept = sentMessageSchema.parse((await send(a, id, { kind: 'text', body: 'still here' })).json()).message;
      await durable(id, 5);
      expect((await page(`?after=${backId}`)).find((m) => m.id === kept.id)?.body).toBe('still here');
    });

    it('refuses a client id reused for another conversation instead of answering with the first one’s message', async () => {
      const { a, id } = await pair('Mina', 'Omid');
      const other = await matchOf(h, a.id, (await person('Pari')).id);
      const clientId = randomUUID();
      const first = sentMessageSchema.parse((await send(a, id, { clientId, kind: 'text', body: 'for Omid' })).json()).message;
      expect(first.conversationId).toBe(id);
      const before = eventsOf(realtime, a.publicUid, 'message').length;
      const reused = await send(a, other.id, { clientId, kind: 'text', body: 'for Pari' });
      expect(reused.statusCode).toBe(409);
      expect(json(reused)['code']).toBe('conflict');
      expect(eventsOf(realtime, a.publicUid, 'message')).toHaveLength(before);
      // The retry to the conversation it was made in still gets it back.
      const retry = await send(a, id, { clientId, kind: 'text', body: 'for Omid' });
      expect(retry.statusCode).toBe(200);
      expect(sentMessageSchema.parse(retry.json()).message).toMatchObject({ id: first.id, conversationId: id });
    });

    it('answers 404 to a conversation the person is not in, and after it ended, as after a block', async () => {
      const { a, b, id } = await pair();
      const stranger = await person('Gus');
      expect((await send(stranger, id, { kind: 'text', body: 'hi' })).statusCode).toBe(404);
      await send(a, id, { kind: 'text', body: 'before' });
      expect((await call(h, `/v1/conversations/${id}`, { method: 'DELETE', token: b.token })).statusCode).toBe(204);
      expect((await send(a, id, { kind: 'text', body: 'after' })).statusCode).toBe(404);
      const history = await call(h, `/v1/conversations/${id}/messages`, { token: a.token });
      expect(history.statusCode).toBe(410);
      const blocked = await pair('Hana', 'Ivo');
      await call(h, '/v1/blocks', { method: 'POST', token: blocked.b.token, body: { target: blocked.a.publicUid } });
      expect((await send(blocked.a, blocked.id, { kind: 'text', body: 'after' })).statusCode).toBe(404);
      expect((await call(h, `/v1/conversations/${blocked.id}/messages`, { token: blocked.a.token })).statusCode).toBe(410);
    });

    it('never takes up again a conversation that a block ended while its state was being read', async () => {
      const { a, b, id } = await pair('Rana', 'Saba');
      await send(a, id, { kind: 'text', body: 'warm' });
      // The state copy expired: Saba's next request reads it from PostgreSQL.
      await h.redis.del(h.app.keys.matchState(id));
      const pool = h.app.pg as unknown as { query: (...args: unknown[]) => Promise<unknown> };
      const original = pool.query;
      let readDone!: () => void;
      const read = new Promise<void>((resolve) => (readDone = resolve));
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let armed = true;
      pool.query = async (...args: unknown[]) => {
        const result = await original(...args);
        const text = (args[0] as { text?: unknown } | undefined)?.text;
        if (armed && typeof text === 'string' && text.includes('can_see(m.user_hi, m.user_lo, 2)')) {
          armed = false;
          readDone();
          await held;
        }
        return result;
      };
      let typing;
      try {
        const pending = call(h, `/v1/conversations/${id}/typing`, { method: 'POST', token: b.token });
        await read;
        // Rana blocks Saba between Saba's read (active, both visible) and its cache write.
        expect((await call(h, '/v1/blocks', { method: 'POST', token: a.token, body: { target: b.publicUid } })).statusCode).toBe(204);
        release();
        typing = await pending;
      } finally {
        pool.query = original;
      }
      expect(typing.statusCode).toBe(404);
      expect(await h.redis.exists(h.app.keys.matchState(id))).toBe(0);
      expect(eventsOf(realtime, a.publicUid, 'typing').filter((e) => (e.d as { conversationId: string }).conversationId === id)).toHaveLength(0);
      const receipt = await call(h, `/v1/conversations/${id}/receipts`, { method: 'POST', token: b.token, body: { readUpTo: h.app.ids.nextId() } });
      expect(receipt.statusCode).toBe(404);
      // A copy of the state that is still around after the end (written by a process that missed the tombstone)
      // is never trusted: the tombstone is read with it, and nothing is asked of PostgreSQL.
      const s = await row<{ lo: string; hi: string }>(db, `SELECT user_lo::text AS lo, user_hi::text AS hi FROM matches WHERE id = $1`, [id]);
      await h.redis.hset(h.app.keys.matchState(id), { lo: s.lo, hi: s.hi, st: 1, fl: 3, src: 1, at: Date.now(), vis: 3 });
      const late = await call(h, `/v1/conversations/${id}/receipts`, { method: 'POST', token: b.token, body: { readUpTo: h.app.ids.nextId() } });
      expect(late.statusCode).toBe(404);
      expect(statements(late)).toBe(0);
      expect((await send(b, id, { kind: 'text', body: 'still there?' })).statusCode).toBe(404);
      expect(eventsOf(realtime, a.publicUid, 'receipt').filter((e) => (e.d as { conversationId: string }).conversationId === id)).toHaveLength(0);
      await h.redis.del(h.app.keys.matchState(id));
    });

    it('keeps a shadowbanned sender on their own side: they see it sent, the other person is never told', async () => {
      const { a, b, id } = await pair();
      await send(a, id, { kind: 'text', body: 'warm' });
      await h.db.sql.query(`UPDATE users SET is_shadowbanned = true WHERE id = $1`, [a.id]);
      // The visibility kept with the conversation goes with a moderation write (here: by hand).
      await h.redis.hdel(h.app.keys.matchState(id), 'vis');
      const unreadBefore = await h.redis.hget(chatKeys(h.app.keys).unread(b.id), id);
      const sent = await send(a, id, { kind: 'text', body: 'hidden' });
      expect(sent.statusCode).toBe(201);
      const message = sentMessageSchema.parse(sent.json()).message;
      expect(eventsOf(realtime, a.publicUid, 'message').some((e) => e.id === message.id)).toBe(true);
      expect(eventsOf(realtime, b.publicUid, 'message').some((e) => e.id === message.id)).toBe(false);
      expect(await h.redis.hget(chatKeys(h.app.keys).unread(b.id), id)).toBe(unreadBefore);
      expect((await readChatState(h.app.redis, h.app.keys, id))?.vis).not.toBeNull();
      await h.db.sql.query(`UPDATE users SET is_shadowbanned = false WHERE id = $1`, [a.id]);
    });

    it('allows 20 messages in 10 s per conversation', async () => {
      const { a, id } = await pair();
      const codes: number[] = [];
      for (let i = 0; i < 21; i += 1) codes.push((await send(a, id, { kind: 'text', body: `n${i}` })).statusCode);
      expect(codes.slice(0, 20).every((c) => c === 201)).toBe(true);
      expect(codes[20]).toBe(429);
    });
  });

  describe('history', () => {
    it('reads a page in one statement, oldest first, with the sync cursor and the write-behind lag', async () => {
      const { a, b, id } = await pair();
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) ids.push(sentMessageSchema.parse((await send(i % 2 ? b : a, id, { kind: 'text', body: `m${i}` })).json()).message.id);
      await durable(id, 5);
      await warmPlan(a);
      const page = await call(h, `/v1/conversations/${id}/messages?limit=3`, { token: a.token });
      expect(page.statusCode, page.body).toBe(200);
      expect(statements(page)).toBe(1);
      expect(Number(page.headers[WRITE_LAG_HEADER])).toBeGreaterThanOrEqual(0);
      const body = messagesPageSchema.parse(page.json());
      expect(body.items.map((m) => m.id)).toEqual(ids.slice(2));
      expect(body.hasMore).toBe(true);
      // The sync cursor never claims more than is durable.
      expect(BigInt(body.syncCursor) <= BigInt(ids[4]!)).toBe(true);
      const older = messagesPageSchema.parse((await call(h, `/v1/conversations/${id}/messages?before=${ids[2]}&limit=3`, { token: a.token })).json());
      expect(older.items.map((m) => m.id)).toEqual(ids.slice(0, 2));
      expect(older.hasMore).toBe(false);
      const after = messagesPageSchema.parse((await call(h, `/v1/conversations/${id}/messages?after=${ids[1]}`, { token: a.token })).json());
      expect(after.items.map((m) => m.id)).toEqual(ids.slice(2));
      expect((await call(h, `/v1/conversations/${id}/messages?before=1&after=2`, { token: a.token })).statusCode).toBe(400);
    });

    it('fetches a message that reached the database late, for a client that follows the sync cursor', async () => {
      const { a, b, id } = await pair();
      await send(a, id, { kind: 'text', body: 'early' });
      await durable(id, 1);
      // A worker takes the next message and dies with it (it stays pending in its name), while the live writer is held.
      await pipeline.pause();
      const late = sentMessageSchema.parse((await send(b, id, { kind: 'text', body: 'late' })).json()).message;
      const dead = h.redis.duplicate();
      await dead.xreadgroup('GROUP', 'pg', 'dead-worker', 'COUNT', 100, 'STREAMS', h.app.keys.stream('msg'), '>');
      await dead.quit();
      const newer = sentMessageSchema.parse((await send(a, id, { kind: 'text', body: 'newer' })).json()).message;
      pipeline.resume();
      // The live writer makes the newer message durable at once; the late one waits to be claimed.
      await until(async () => (await row<{ n: string }>(db, `SELECT count(*)::text AS n FROM messages WHERE match_id = $1 AND id = $2`, [id, newer.id])).n === '1');
      const read = messagesPageSchema.parse((await call(h, `/v1/conversations/${id}/messages`, { token: a.token })).json());
      expect(read.items.map((m) => m.body)).toEqual(['early', 'newer']);
      // The cursor stays below the message that is not durable yet, though a newer one was returned.
      expect(BigInt(read.syncCursor) < BigInt(late.id)).toBe(true);
      await durable(id, 3);
      const caught = messagesPageSchema.parse((await call(h, `/v1/conversations/${id}/messages?after=${read.syncCursor}`, { token: a.token })).json());
      // What the client had already may come again (it de-duplicates by id); the late message is there.
      const ids = caught.items.map((m) => m.id);
      expect(ids).toContain(late.id);
      expect(ids).toContain(newer.id);
    });

    it('shows the peer’s read pointer only with read receipts, and their delivered pointer only while they show online', async () => {
      const { a, b, id } = await pair();
      const m = sentMessageSchema.parse((await send(a, id, { kind: 'text', body: 'read me' })).json()).message;
      await call(h, `/v1/conversations/${id}/receipts`, { method: 'POST', token: b.token, body: { readUpTo: m.id } });
      await durable(id, 1);
      const free = messagesPageSchema.parse((await call(h, `/v1/conversations/${id}/messages`, { token: a.token })).json());
      expect(free.readCursors.peer).toBeUndefined();
      expect(free.peerDeliveredId).toBe(m.id);
      await h.db.sql.query(`UPDATE profiles SET show_online = false WHERE user_id = $1`, [b.id]);
      const hidden = messagesPageSchema.parse((await call(h, `/v1/conversations/${id}/messages`, { token: a.token })).json());
      expect(hidden.peerDeliveredId).toBeUndefined();
      await h.db.sql.query(`UPDATE plan_features SET value = 'true' FROM plans WHERE plans.id = plan_features.plan_id AND plans.key = 'free' AND feature = 'read_receipts'`);
      await setAppConfig(h, 'chat.max_body_chars', 2_000);
      const paid = messagesPageSchema.parse((await call(h, `/v1/conversations/${id}/messages`, { token: a.token })).json());
      expect(paid.readCursors.peer).toBe(m.id);
      await h.db.sql.query(`UPDATE plan_features SET value = 'false' FROM plans WHERE plans.id = plan_features.plan_id AND plans.key = 'free' AND feature = 'read_receipts'`);
      await setAppConfig(h, 'chat.max_body_chars', 2_000);
    });
  });

  describe('receipts and typing', () => {
    it('moves pointers with no statement; the reader’s devices always hear it, the other person by the rules', async () => {
      const { a, b, id } = await pair();
      const m = sentMessageSchema.parse((await send(a, id, { kind: 'text', body: 'hi' })).json()).message;
      const read = await call(h, `/v1/conversations/${id}/receipts`, { method: 'POST', token: b.token, body: { readUpTo: m.id } });
      expect(read.statusCode).toBe(204);
      expect(statements(read)).toBe(0);
      expect(eventsOf(realtime, b.publicUid, 'receipt').at(-1)?.d).toEqual({ conversationId: id, by: b.publicUid, readUpTo: m.id });
      // Ava's plan has no read receipts: she is not told.
      expect(eventsOf(realtime, a.publicUid, 'receipt').filter((e) => (e.d as { conversationId: string }).conversationId === id)).toHaveLength(0);
      // A second read pointer within 2 s is refused; a delivered pointer has its own window.
      expect((await call(h, `/v1/conversations/${id}/receipts`, { method: 'POST', token: b.token, body: { readUpTo: m.id } })).statusCode).toBe(429);
      const m2 = sentMessageSchema.parse((await send(a, id, { kind: 'text', body: 'again' })).json()).message;
      const delivered = await call(h, `/v1/conversations/${id}/receipts`, { method: 'POST', token: b.token, body: { deliveredUpTo: m2.id } });
      expect(delivered.statusCode).toBe(204);
      expect(statements(delivered)).toBeLessThanOrEqual(1);
      // Ben shows online: Ava hears the delivery.
      expect(eventsOf(realtime, a.publicUid, 'receipt').at(-1)?.d).toEqual({ conversationId: id, by: b.publicUid, deliveredUpTo: m2.id });
    });

    it('tells the other person of a read only when their plan has read receipts, and of a delivery only while the reader shows online', async () => {
      const { a, b, id } = await pair();
      await h.db.sql.query(`UPDATE plan_features SET value = 'true' FROM plans WHERE plans.id = plan_features.plan_id AND plans.key = 'free' AND feature = 'read_receipts'`);
      await setAppConfig(h, 'chat.max_body_chars', 2_000);
      await warmPlan(a);
      await h.db.sql.query(`UPDATE profiles SET show_online = false WHERE user_id = $1`, [b.id]);
      const m = sentMessageSchema.parse((await send(a, id, { kind: 'text', body: 'hi' })).json()).message;
      await call(h, `/v1/conversations/${id}/receipts`, { method: 'POST', token: b.token, body: { deliveredUpTo: m.id } });
      expect(eventsOf(realtime, a.publicUid, 'receipt').filter((e) => (e.d as { conversationId: string }).conversationId === id)).toHaveLength(0);
      await call(h, `/v1/conversations/${id}/receipts`, { method: 'POST', token: b.token, body: { readUpTo: m.id } });
      expect(eventsOf(realtime, a.publicUid, 'receipt').at(-1)?.d).toEqual({ conversationId: id, by: b.publicUid, readUpTo: m.id });
      await h.db.sql.query(`UPDATE plan_features SET value = 'false' FROM plans WHERE plans.id = plan_features.plan_id AND plans.key = 'free' AND feature = 'read_receipts'`);
      await setAppConfig(h, 'chat.max_body_chars', 2_000);
    });

    it('sends typing to the other person only, with no statement and no history, once per 3 s', async () => {
      const { a, b, id } = await pair();
      await send(a, id, { kind: 'text', body: 'warm' });
      const typing = await call(h, `/v1/conversations/${id}/typing`, { method: 'POST', token: a.token });
      expect(typing.statusCode).toBe(204);
      expect(statements(typing)).toBe(0);
      expect(eventsOf(realtime, b.publicUid, 'typing').at(-1)?.d).toEqual({ conversationId: id, by: a.publicUid });
      expect(eventsOf(realtime, a.publicUid, 'typing')).toHaveLength(0);
      expect((await call(h, `/v1/conversations/${id}/typing`, { method: 'POST', token: a.token })).statusCode).toBe(429);
    });
  });

  describe('settings and the list', () => {
    it('saves mute and call consent in one statement; the other person hears only the consent', async () => {
      const { a, b, id } = await pair();
      await send(b, id, { kind: 'text', body: 'hi' });
      await warmPlan(a);
      const muted = await call(h, `/v1/conversations/${id}`, { method: 'PATCH', token: a.token, body: { muted: true } });
      expect(muted.statusCode, muted.body).toBe(200);
      expect(statements(muted)).toBe(1);
      expect(conversationSchema.parse(muted.json())).toMatchObject({ id, muted: true, callsAllowed: { me: true, peer: true } });
      expect(eventsOf(realtime, b.publicUid, 'conversation').filter((e) => e.d && (e.d as { conversation: Conversation }).conversation.id === id)).toHaveLength(0);
      const calls = await call(h, `/v1/conversations/${id}`, { method: 'PATCH', token: a.token, body: { allowCalls: false } });
      expect(conversationSchema.parse(calls.json()).callsAllowed).toEqual({ me: false, peer: true });
      const theirs = eventsOf(realtime, b.publicUid, 'conversation').at(-1)?.d as { conversation: Conversation; reason: string };
      expect(theirs).toMatchObject({ reason: 'updated', conversation: { id, muted: false, callsAllowed: { me: true, peer: false } } });
      // Call placement reads the flags from the conversation's cached state.
      const state = await readChatState(h.app.redis, h.app.keys, id);
      expect(state && (state.flags & (a.id === state.lo ? 1 : 2))).toBe(0);
      expect((await call(h, `/v1/conversations/${id}`, { method: 'PATCH', token: (await person('Zed')).token, body: { muted: true } })).statusCode).toBe(404);
    });

    it('lists conversations with no statement when warm: the newest message, unread counts, read pointers and presence by the rules', async () => {
      const { a, b, id } = await pair();
      presence.onlineUids.add(a.publicUid);
      await call(h, '/v1/conversations', { token: b.token });
      const m1 = sentMessageSchema.parse((await send(a, id, { kind: 'text', body: 'first' })).json()).message;
      const m2 = sentMessageSchema.parse((await send(a, id, { kind: 'text', body: 'second message of the day' })).json()).message;
      await call(h, '/v1/conversations', { token: b.token });
      const list = await call(h, '/v1/conversations', { token: b.token });
      expect(list.statusCode).toBe(200);
      expect(statements(list)).toBe(0);
      const mine = conversationsPageSchema.parse(list.json()).items.find((c) => c.id === id)!;
      expect(mine).toMatchObject({ unread: 2, lastMessage: { id: m2.id, body: 'second message of the day', senderId: a.publicUid }, peer: { id: a.publicUid, online: true } });
      expect(mine.myReadId).toBeUndefined();
      await call(h, `/v1/conversations/${id}/receipts`, { method: 'POST', token: b.token, body: { readUpTo: m1.id } });
      const read = conversationsPageSchema.parse((await call(h, '/v1/conversations', { token: b.token })).json()).items.find((c) => c.id === id)!;
      expect(read).toMatchObject({ unread: 2, myReadId: m1.id });
      // Ava hides her online status: the list stops showing it.
      await h.db.sql.query(`UPDATE profiles SET show_online = false WHERE user_id = $1`, [a.id]);
      await h.app.account.changed(a.id);
      const quiet = conversationsPageSchema.parse((await call(h, '/v1/conversations', { token: b.token })).json()).items.find((c) => c.id === id)!;
      expect(quiet.peer.online).toBeUndefined();
      // Ava's side: her own message, nothing unread, Ben's read pointer only with read receipts (not on the free plan).
      const hers = conversationsPageSchema.parse((await call(h, '/v1/conversations', { token: a.token })).json()).items.find((c) => c.id === id)!;
      expect(hers).toMatchObject({ unread: 0, lastMessage: { id: m2.id } });
      expect(hers.peerReadId).toBeUndefined();
    });

    it('reads the newest message back from the database once its cached copy expired, in one statement', async () => {
      const { a, b, id } = await pair();
      const m = sentMessageSchema.parse((await send(a, id, { kind: 'text', body: 'quiet week' })).json()).message;
      await durable(id, 1);
      await call(h, '/v1/conversations', { token: b.token });
      await h.redis.del(chatKeys(h.app.keys).lastMessage(id));
      const cold = await call(h, '/v1/conversations', { token: b.token });
      expect(statements(cold)).toBe(1);
      expect(conversationsPageSchema.parse(cold.json()).items.find((c) => c.id === id)?.lastMessage?.id).toBe(m.id);
      expect(statements(await call(h, '/v1/conversations', { token: b.token }))).toBe(0);
      // After a whole list loss, the unread counts come back from the read pointers.
      await h.redis.del(h.app.keys.conversationList(b.id), chatKeys(h.app.keys).unread(b.id));
      const rebuilt = await call(h, '/v1/conversations', { token: b.token });
      expect(conversationsPageSchema.parse(rebuilt.json()).items.find((c) => c.id === id)).toMatchObject({ unread: 1, lastMessage: { id: m.id } });
    });
  });

  describe('message requests', () => {
    it('sends a request once per client id, tells the recipient, and keeps a decline from the sender', async () => {
      const a = await person('Ava');
      const b = await person('Ben');
      const clientId = randomUUID();
      const sent = await call(h, '/v1/message-requests', { method: 'POST', token: a.token, body: { to: b.publicUid, body: 'Hi Ben', clientId } });
      expect(sent.statusCode, sent.body).toBe(201);
      const request = sentRequestBodySchema.parse(sent.json()).request;
      expect(request).toMatchObject({ to: { id: b.publicUid, name: 'Ben' }, body: 'Hi Ben', status: 'pending' });
      expect(eventsOf(realtime, b.publicUid, 'request').at(-1)?.d).toMatchObject({ request: { id: request.id, from: { id: a.publicUid }, body: 'Hi Ben' } });
      expect(jobs.jobs.some((j) => j.queue === 'push' && j.data['type'] === 'request' && j.data['requestId'] === request.id)).toBe(true);
      const replay = await call(h, '/v1/message-requests', { method: 'POST', token: a.token, body: { to: b.publicUid, body: 'Hi Ben', clientId } });
      expect(replay.statusCode).toBe(200);
      expect(sentRequestBodySchema.parse(replay.json()).request.id).toBe(request.id);
      // The same client id for someone else names nothing there: refused, never answered with Ben's request.
      const other = await person('Cleo');
      const reused = await call(h, '/v1/message-requests', { method: 'POST', token: a.token, body: { to: other.publicUid, body: 'Hi Cleo', clientId } });
      expect(reused.statusCode).toBe(409);
      expect(json(reused)['code']).toBe('conflict');
      expect(messageRequestsPageSchema.parse((await call(h, '/v1/message-requests?box=inbox', { token: other.token })).json()).items).toHaveLength(0);
      const again = await call(h, '/v1/message-requests', { method: 'POST', token: a.token, body: { to: b.publicUid, body: 'Hello?', clientId: randomUUID() } });
      expect(again.statusCode).toBe(409);
      expect(json(again)['code']).toBe('already_requested');
      const inbox = messageRequestsPageSchema.parse((await call(h, '/v1/message-requests?box=inbox', { token: b.token })).json());
      expect(inbox.items.map((i) => i.id)).toContain(request.id);
      expect((await call(h, `/v1/message-requests/${request.id}/decline`, { method: 'POST', token: b.token })).statusCode).toBe(204);
      // The sender still reads it as pending, and a new one is answered as for a pending one.
      const box = messageRequestsPageSchema.parse((await call(h, '/v1/message-requests?box=sent', { token: a.token })).json());
      expect(box.items.find((i) => i.id === request.id)?.status).toBe('pending');
      const after = await call(h, '/v1/message-requests', { method: 'POST', token: a.token, body: { to: b.publicUid, body: 'Hello?', clientId: randomUUID() } });
      expect(json(after)['code']).toBe('already_requested');
      expect(messageRequestsPageSchema.parse((await call(h, '/v1/message-requests?box=inbox', { token: b.token })).json()).items).toHaveLength(0);
    });

    it('takes the week’s gift, then the wallet, then answers quota_exceeded', async () => {
      const a = await person('Ava');
      const targets = await Promise.all(['B', 'C', 'D'].map((n) => person(n)));
      const first = await call(h, '/v1/message-requests', { method: 'POST', token: a.token, body: { to: targets[0]!.publicUid, body: 'one', clientId: randomUUID() } });
      expect(first.statusCode).toBe(201);
      const second = await call(h, '/v1/message-requests', { method: 'POST', token: a.token, body: { to: targets[1]!.publicUid, body: 'two', clientId: randomUUID() } });
      expect(second.statusCode).toBe(429);
      expect(problemExt('quota_exceeded', second.json())).toMatchObject({ feature: 'dm', canBuy: true });
      await h.db.sql.query(`INSERT INTO wallet_balances (user_id, item, store, balance) VALUES ($1, 4, 0, 1)`, [a.id]);
      const paid = await call(h, '/v1/message-requests', { method: 'POST', token: a.token, body: { to: targets[2]!.publicUid, body: 'three', clientId: randomUUID() } });
      expect(paid.statusCode).toBe(201);
      expect((await row<{ balance: number }>(db, `SELECT balance FROM wallet_balances WHERE user_id = $1 AND item = 4`, [a.id])).balance).toBe(0);
      expect((await row<{ n: string }>(db, `SELECT count(*)::text AS n FROM wallet_ledger WHERE user_id = $1 AND item = 4 AND delta = -1`, [a.id])).n).toBe('1');
    });

    it('makes a conversation of an accepted request, its body the first message, both people told', async () => {
      const a = await person('Ava');
      const b = await person('Ben');
      const request = sentRequestBodySchema.parse(
        (await call(h, '/v1/message-requests', { method: 'POST', token: a.token, body: { to: b.publicUid, body: 'Coffee?', clientId: randomUUID() } })).json(),
      ).request;
      const accepted = await call(h, `/v1/message-requests/${request.id}/accept`, { method: 'POST', token: b.token });
      expect(accepted.statusCode, accepted.body).toBe(201);
      const conversation = conversationBodySchema.parse(accepted.json()).conversation;
      expect(conversation).toMatchObject({ peer: { id: a.publicUid }, source: 'request', state: 'active', unread: 0, lastMessage: { body: 'Coffee?', senderId: a.publicUid } });
      expect(conversation.myReadId).toBe(conversation.lastMessage!.id);
      expect(eventsOf(realtime, a.publicUid, 'conversation').at(-1)?.d).toMatchObject({ reason: 'accepted', conversation: { id: conversation.id, peer: { id: b.publicUid } } });
      expect(eventsOf(realtime, a.publicUid, 'message').some((e) => e.id === conversation.lastMessage!.id)).toBe(true);
      const history = messagesPageSchema.parse((await call(h, `/v1/conversations/${conversation.id}/messages`, { token: a.token })).json());
      expect(history.items.map((m) => m.body)).toEqual(['Coffee?']);
      // The two can write now; a request between them answers already_matched.
      expect((await send(a, conversation.id, { kind: 'text', body: 'See you' })).statusCode).toBe(201);
      const more = await call(h, '/v1/message-requests', { method: 'POST', token: b.token, body: { to: a.publicUid, body: 'x', clientId: randomUUID() } });
      expect(json(more)['code']).toBe('already_matched');
      expect((await call(h, `/v1/message-requests/${request.id}/accept`, { method: 'POST', token: a.token })).statusCode).toBe(404);
    });
  });

  describe('chat reports', () => {
    it('copies the messages just before a chat report into its evidence once they are durable', async () => {
      const { a, b, id } = await pair();
      const sent: string[] = [];
      for (const body of ['hey', 'you are awful', 'reply now']) sent.push(sentMessageSchema.parse((await send(b, id, { kind: 'text', body })).json()).message.id);
      const filed = await call(h, '/v1/reports', { method: 'POST', token: a.token, body: { target: b.publicUid, context: 'chat', reason: 'harassment', conversationId: id, messageIds: [sent[1]] } });
      expect(filed.statusCode, filed.body).toBe(202);
      const reportId = String(json(filed)['reportId']);
      const job = jobs.jobs.find((j) => j.queue === 'safety' && j.name === 'report-evidence' && j.data['reportId'] === reportId);
      expect(job).toBeDefined();
      await durable(id, 3);
      await until(async () => {
        const wm = await h.redis.get(h.app.keys.streamWatermark('msg'));
        return wm !== null && BigInt(wm) > BigInt(String(job!.data['filingId']));
      });
      const result = await reportEvidenceJob(fakeJob('report-evidence', job!.data), pipeline.context);
      expect(result).toMatchObject({ outcome: 'copied', messages: 3 });
      const evidence = await row<{ evidence: { chat: { messages: { id: string; body: string }[] }[] } }>(db, `SELECT evidence FROM reports WHERE id = $1`, [reportId]);
      expect(evidence.evidence.chat[0]!.messages.map((m) => m.body)).toEqual(['hey', 'you are awful', 'reply now']);
    });
  });

  it('copies the requests of a report made from the requests inbox (there is no conversation to point at)', async () => {
    const a = await person('Ava');
    const b = await person('Ben');
    const request = sentRequestBodySchema.parse(
      (await call(h, '/v1/message-requests', { method: 'POST', token: a.token, body: { to: b.publicUid, body: 'send me money', clientId: randomUUID() } })).json(),
    ).request;
    const filed = await call(h, '/v1/reports', { method: 'POST', token: b.token, body: { target: a.publicUid, context: 'chat', reason: 'scam', block: true } });
    expect(filed.statusCode, filed.body).toBe(202);
    expect((await call(h, `/v1/message-requests/${request.id}/decline`, { method: 'POST', token: b.token })).statusCode).toBe(204);
    const reportId = String(json(filed)['reportId']);
    const job = jobs.jobs.find((j) => j.queue === 'safety' && j.name === 'report-evidence' && j.data['reportId'] === reportId)!;
    expect(job.data['conversationId']).toBeNull();
    await until(async () => {
      const wm = await h.redis.get(h.app.keys.streamWatermark('msg'));
      return wm !== null && BigInt(wm) > BigInt(String(job.data['filingId']));
    });
    expect(await reportEvidenceJob(fakeJob('report-evidence', job.data), pipeline.context)).toMatchObject({ outcome: 'copied', messages: 1 });
    const evidence = await row<{ evidence: { chat: { requests: { requestId: string; body: string }[] }[] } }>(db, `SELECT evidence FROM reports WHERE id = $1`, [reportId]);
    expect(evidence.evidence.chat[0]!.requests).toEqual([expect.objectContaining({ requestId: request.id, body: 'send me money' })]);
  });

  it('waits for a replica after the append when one is configured, and still answers when none confirms', async () => {
    const replicated = await startHarness(db, { WRITE_BEHIND_WAIT_REPLICAS: '1', WRITE_BEHIND_WAIT_MS: '30' }, { realtime, jobs, chat: { presence } });
    try {
      const a = await seedUser(replicated, { name: 'Ava' });
      const b = await seedUser(replicated, { name: 'Ben' });
      const m = await matchOf(replicated, a.id, b.id);
      const started = Date.now();
      const sent = await call(replicated, `/v1/conversations/${m.id}/messages`, { method: 'POST', token: a.token, body: { clientId: randomUUID(), kind: 'text', body: 'hi' } });
      expect(sent.statusCode).toBe(201);
      // This server has no replica: WAIT gives up after its timeout, which is logged, and the send stands.
      expect(Date.now() - started).toBeGreaterThanOrEqual(25);
      expect(replicated.logs.some((line) => line.includes('not on a replica yet'))).toBe(true);
    } finally {
      await replicated.close();
    }
  });

  it('leaks no raw user id in any answer or event of the suite', () => {
    const events = realtime.published.map((p) => JSON.stringify(p.envelope));
    for (const user of seeded) {
      for (const body of h.bodies) expect(body.includes(user.id), 'a response holds a raw user id').toBe(false);
      for (const event of events) expect(event.includes(user.id), 'an event holds a raw user id').toBe(false);
    }
  });
});
