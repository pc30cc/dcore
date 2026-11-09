import { randomUUID } from 'node:crypto';
import { chatEligibility } from '@app/db';
import {
  conversationBodySchema,
  conversationSchema,
  conversationsPageSchema,
  idTime,
  messageRequestsPageSchema,
  messagesPageSchema,
  sentMessageSchema,
  sentRequestBodySchema,
  type Conversation,
} from '@app/shared';
import { cacheChatState, chatKeys, dropConversationVisibility, encodeCallLineBody, FakePresence, FakeRealtimePublisher, readVersion } from '@app/shared/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LIST_PRESENCE_EPOCH_MS } from '../src/routes/conversations.js';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, migratedDatabase, row, rows, seedUser, startHarness, statements, type Harness, type SeededUser, type TestDatabase } from './accountSupport.js';
import { eventsOf, matchOf, startChatPipeline, until, type ChatPipeline } from './chatSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * The conversation's cached state against the changes that race it: the
 * fence a settings change leaves, the settings of one conversation written
 * through, a send whose copy vanished between its check and its script, and
 * what the other person is told of a change.
 */

describe.skipIf(!hasInfrastructure)('chat consistency (PostgreSQL, Valkey)', () => {
  let db: TestDatabase;
  let h: Harness;
  let realtime: FakeRealtimePublisher;
  let jobs: MemoryJobProducer;
  let pipeline: ChatPipeline;
  const presence = new FakePresence();

  beforeAll(async () => {
    db = await migratedDatabase();
    realtime = new FakeRealtimePublisher();
    jobs = new MemoryJobProducer();
    h = await startHarness(db, {}, { realtime, jobs, chat: { presence } });
    pipeline = await startChatPipeline(h, realtime, { claimIdleMs: 3_000 });
  }, 90_000);

  afterAll(async () => {
    await pipeline?.stop();
    await h?.close();
    await db?.drop();
  });

  async function pair(a = 'Ava', b = 'Ben') {
    const x = await seedUser(h, { name: a });
    const y = await seedUser(h, { name: b });
    const m = await matchOf(h, x.id, y.id);
    return { a: x, b: y, id: m.id, lo: m.lo, hi: m.hi };
  }

  function send(user: SeededUser, conversationId: string, body: Record<string, unknown>) {
    return call(h, `/v1/conversations/${conversationId}/messages`, { method: 'POST', token: user.token, body: { clientId: randomUUID(), ...body } });
  }

  function patch(user: SeededUser, conversationId: string, body: Record<string, unknown>) {
    return call(h, `/v1/conversations/${conversationId}`, { method: 'PATCH', token: user.token, body });
  }

  async function durable(conversationId: string, n: number): Promise<void> {
    await until(async () => Number((await row<{ n: string }>(db, `SELECT count(*)::text AS n FROM messages WHERE match_id = $1`, [conversationId])).n) >= n);
  }

  /** Runs `before` once, right before the next send script of the conversation. */
  function beforeSendScript(matchId: string, before: () => Promise<void>): () => void {
    const redis = h.app.redis as unknown as { evalsha: (...args: unknown[]) => Promise<unknown> };
    const evalsha = redis.evalsha;
    let armed = true;
    redis.evalsha = async (...args: unknown[]) => {
      const count = Number(args[1]);
      const keys = args.slice(2, 2 + count) as string[];
      if (armed && count === 11 && keys[1] === h.app.keys.matchState(matchId)) {
        armed = false;
        await before();
      }
      return evalsha.apply(h.app.redis, args);
    };
    return () => (redis.evalsha = evalsha);
  }

  const conversationEvents = (user: SeededUser, id: string) =>
    eventsOf(realtime, user.publicUid, 'conversation').filter((e) => (e.d as { conversation?: Conversation }).conversation?.id === id);

  describe('a change of one conversation', () => {
    it('tells the other person nothing while they may not see the person (a shadowbanned person changing call consent)', async () => {
      const { a, b, id } = await pair('Xena', 'Yara');
      expect((await send(a, id, { kind: 'text', body: 'warm' })).statusCode).toBe(201);
      // Xena's plan is cached, as after any list read.
      expect((await call(h, '/v1/conversations', { token: a.token })).statusCode).toBe(200);
      await h.db.sql.query(`UPDATE users SET is_shadowbanned = true WHERE id = $1`, [a.id]);
      await h.redis.hdel(h.app.keys.matchState(id), 'vis');
      const eventsBefore = conversationEvents(b, id).length;
      const versionBefore = await readVersion(h.app.redis, h.app.keys.conversationVersion(b.id));
      const changed = await patch(a, id, { allowCalls: false });
      expect(changed.statusCode, changed.body).toBe(200);
      expect(statements(changed)).toBe(1);
      // The person sees their change applied, as anyone would.
      expect(conversationSchema.parse(changed.json()).callsAllowed).toEqual({ me: false, peer: true });
      expect(conversationEvents(a, id).at(-1)?.d).toMatchObject({ reason: 'updated' });
      // The other person hears of nothing: no event, no list version moved.
      expect(conversationEvents(b, id)).toHaveLength(eventsBefore);
      expect(await readVersion(h.app.redis, h.app.keys.conversationVersion(b.id))).toBe(versionBefore);
      await h.db.sql.query(`UPDATE users SET is_shadowbanned = false WHERE id = $1`, [a.id]);
      // Visible again: the next change reaches them.
      await h.redis.hdel(h.app.keys.matchState(id), 'vis');
      expect((await patch(a, id, { allowCalls: true })).statusCode).toBe(200);
      expect(conversationEvents(b, id)).toHaveLength(eventsBefore + 1);
    });

    it('writes the new flags through to the cached state, so no state read before the change is cached over it', async () => {
      const { a, id, lo } = await pair('Mina', 'Omid');
      await send(a, id, { kind: 'text', body: 'warm' });
      const callBit = a.id === lo ? 1 : 2;
      const muteBit = a.id === lo ? 4 : 8;
      // A reader read the conversation just before the change, and caches it just after.
      const old = await chatEligibility(h.app.pg, id);
      expect(old?.flags).toBe(3);
      const changed = await patch(a, id, { allowCalls: false, muted: true });
      expect(changed.statusCode).toBe(200);
      const expected = (3 & ~callBit) | muteBit;
      expect(await h.redis.hget(h.app.keys.matchState(id), 'fl')).toBe(String(expected));
      expect(await cacheChatState(h.app.redis, h.app.keys, { ...old!, createdMs: idTime(id).getTime() })).toBe('fenced');
      expect(await h.redis.hget(h.app.keys.matchState(id), 'fl')).toBe(String(expected));
      // The conversation keeps working inside the fence.
      expect((await send(a, id, { kind: 'text', body: 'still here' })).statusCode).toBe(201);
    });

    it('leaves no copy with the old flags when another change’s fence already stood', async () => {
      const { a, id } = await pair('Rana', 'Saba');
      await send(a, id, { kind: 'text', body: 'warm' });
      expect(await h.redis.hget(h.app.keys.matchState(id), 'fl')).toBe('3');
      // A visibility change of one of them (a moderation write): the visibility goes, behind a fence.
      expect(await dropConversationVisibility(h.app.redis, h.app.keys, a.id)).toBeGreaterThan(0);
      expect((await patch(a, id, { allowCalls: false })).statusCode).toBe(200);
      const fl = await h.redis.hget(h.app.keys.matchState(id), 'fl');
      expect(fl === null || fl !== '3').toBe(true);
    });

    it('keeps the other person’s change made while this one waited for the row', async () => {
      const { a, id, lo } = await pair('Hana', 'Ivo');
      const peerCallBit = a.id === lo ? 2 : 1;
      const muteBit = a.id === lo ? 4 : 8;
      const client = await db.sql.connect();
      let pending: ReturnType<typeof patch>;
      try {
        await client.query('BEGIN');
        // The other person turns calls off; their transaction holds the row.
        await client.query(`UPDATE matches SET flags = flags & ~$2::smallint WHERE id = $1`, [id, peerCallBit]);
        pending = patch(a, id, { muted: true });
        await until(async () => {
          const waiting = await row<{ n: string }>(
            db,
            `SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%UPDATE matches m%'`,
          );
          return Number(waiting.n) > 0;
        });
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      const answer = await pending;
      expect(answer.statusCode, answer.body).toBe(200);
      const stored = await row<{ flags: number }>(db, `SELECT flags FROM matches WHERE id = $1`, [id]);
      expect(stored.flags & peerCallBit).toBe(0);
      expect(stored.flags & muteBit).toBe(muteBit);
      expect(conversationSchema.parse(answer.json())).toMatchObject({ muted: true, callsAllowed: { me: true, peer: false } });
    });
  });

  describe('sending while the cached state is fenced or gone', () => {
    it('sends at once after either person changed their call settings, and an end inside the fence still wins', async () => {
      const { a, b, id } = await pair('Ava', 'Ben');
      expect((await send(b, id, { kind: 'text', body: 'before' })).statusCode).toBe(201);
      const settings = await call(h, '/v1/me/settings', { method: 'PATCH', token: a.token, body: { acceptCalls: false } });
      expect(settings.statusCode, settings.body).toBe(200);
      expect(await h.redis.exists(h.app.keys.matchState(id))).toBe(0);
      const fromB = await send(b, id, { kind: 'text', body: 'right after' });
      expect(fromB.statusCode, fromB.body).toBe(201);
      const fromA = await send(a, id, { kind: 'text', body: 'me too' });
      expect(fromA.statusCode, fromA.body).toBe(201);
      for (const u of [a, b]) {
        const id2 = sentMessageSchema.parse(fromB.json()).message.id;
        expect(eventsOf(realtime, u.publicUid, 'message').some((e) => e.id === id2)).toBe(true);
      }
      await durable(id, 3);

      // Still inside the fence: B's check finds the conversation open, and A blocks B before B's send script runs.
      expect(await h.redis.exists(h.app.keys.matchState(id))).toBe(0);
      const restore = beforeSendScript(id, async () => {
        expect((await call(h, '/v1/blocks', { method: 'POST', token: a.token, body: { target: b.publicUid } })).statusCode).toBeLessThan(300);
      });
      let late;
      try {
        late = await send(b, id, { kind: 'text', body: 'too late' });
      } finally {
        restore();
      }
      expect(late.statusCode).toBe(404);
      expect(eventsOf(realtime, a.publicUid, 'message').some((e) => (e.d as { body?: string }).body === 'too late')).toBe(false);
    });

    it('appends with the id minted a moment before, reading nothing again, when the copy vanished after the check', async () => {
      const { a, id } = await pair('Gus', 'Lia');
      expect((await send(a, id, { kind: 'text', body: 'warm' })).statusCode).toBe(201);
      const pool = h.app.pg as unknown as { query: (...args: unknown[]) => Promise<unknown> };
      const query = pool.query;
      let expired = false;
      // The copy expires between the check and the send script.
      const restore = beforeSendScript(id, async () => {
        expired = (await h.redis.del(h.app.keys.matchState(id))) === 1;
      });
      // A read of the conversation would wait for a busy pool.
      pool.query = async (...args: unknown[]) => {
        const text = (args[0] as { text?: unknown } | undefined)?.text;
        if (typeof text === 'string' && text.includes('can_see(m.user_hi, m.user_lo, 2)')) await new Promise((resolve) => setTimeout(resolve, 1_500));
        return query.apply(pool, args);
      };
      let sent;
      try {
        sent = await send(a, id, { kind: 'text', body: 'appended at once' });
      } finally {
        restore();
        pool.query = query;
      }
      expect(expired).toBe(true);
      expect(sent.statusCode, sent.body).toBe(201);
      expect(statements(sent)).toBe(0);
      const message = sentMessageSchema.parse(sent.json()).message;
      const entries = (await h.redis.xrevrange(h.app.keys.stream('msg'), '+', '-', 'COUNT', 50)) as [string, string[]][];
      const entry = entries.find(([, flat]) => flat[flat.indexOf('id') + 1] === message.id);
      expect(entry).toBeDefined();
      const appendedAt = Number(entry![0].split('-')[0]);
      expect(appendedAt - idTime(message.id).getTime()).toBeLessThan(1_000);
    });
  });

  describe('message requests both ways', () => {
    const request = async (from: SeededUser, to: SeededUser, body: string) => {
      const sent = await call(h, '/v1/message-requests', { method: 'POST', token: from.token, body: { to: to.publicUid, body, clientId: randomUUID() } });
      expect(sent.statusCode, sent.body).toBe(201);
      return sentRequestBodySchema.parse(sent.json()).request;
    };
    const accept = (user: SeededUser, id: string) => call(h, `/v1/message-requests/${id}/accept`, { method: 'POST', token: user.token });
    const stored = async (matchId: string) => rows<{ id: string; body: string }>(db, `SELECT id::text, body FROM messages WHERE match_id = $1 ORDER BY id`, [matchId]);

    it('keeps the request the other way pending when one is accepted, and stores both bodies', async () => {
      const cleo = await seedUser(h, { name: 'Cleo' });
      const dan = await seedUser(h, { name: 'Dan' });
      const fromCleo = await request(cleo, dan, 'from Cleo');
      const fromDan = await request(dan, cleo, 'from Dan');
      const first = await accept(dan, fromCleo.id);
      expect(first.statusCode, first.body).toBe(201);
      const conversation = conversationBodySchema.parse(first.json()).conversation;
      // Dan's request is still in Cleo's inbox: nothing of it was lost.
      const inbox = messageRequestsPageSchema.parse((await call(h, '/v1/message-requests?box=inbox', { token: cleo.token })).json());
      expect(inbox.items.map((i) => i.id)).toContain(fromDan.id);
      const second = await accept(cleo, fromDan.id);
      expect(second.statusCode, second.body).toBe(201);
      const again = conversationBodySchema.parse(second.json()).conversation;
      expect(again.id).toBe(conversation.id);
      expect(again.lastMessage).toMatchObject({ body: 'from Dan' });
      const messages = await stored(conversation.id);
      expect(messages.map((m) => m.body)).toEqual(['from Cleo', 'from Dan']);
      // Every message anyone was told of is one that exists.
      expect(messages.map((m) => m.id)).toContain(again.lastMessage!.id);
      for (const u of [cleo, dan]) {
        for (const e of eventsOf(realtime, u.publicUid, 'message').filter((x) => (x.d as { conversationId: string }).conversationId === conversation.id)) {
          expect(messages.map((m) => m.id)).toContain(e.id);
        }
      }
    });

    it('accepts both requests at the same moment without a failure, each body stored once', async () => {
      const eva = await seedUser(h, { name: 'Eva' });
      const finn = await seedUser(h, { name: 'Finn' });
      const one = await request(eva, finn, 'hello Finn');
      const two = await request(finn, eva, 'hello Eva');
      const answers = await Promise.all([accept(finn, one.id), accept(eva, two.id)]);
      expect(answers.map((r) => r.statusCode)).toEqual([201, 201]);
      const ids = answers.map((r) => conversationBodySchema.parse(r.json()).conversation.id);
      expect(ids[0]).toBe(ids[1]);
      expect((await stored(ids[0]!)).map((m) => m.body).sort()).toEqual(['hello Eva', 'hello Finn']);
    });

    it('answers an accept repeated after it worked without a message nobody stored', async () => {
      const gil = await seedUser(h, { name: 'Gil' });
      const hope = await seedUser(h, { name: 'Hope' });
      const m = await matchOf(h, gil.id, hope.id);
      // A request marked accepted with the conversation, whose body was never stored (as the old accept left the other way's).
      const requestId = h.app.ids.nextId();
      await h.db.sql.query(`INSERT INTO message_requests (id, from_id, to_id, body, status, decided_at, match_id) VALUES ($1, $2, $3, 'lost words', 2, now(), $4)`, [
        requestId,
        gil.id,
        hope.id,
        m.id,
      ]);
      const before = eventsOf(realtime, hope.publicUid, 'message').length;
      const answer = await accept(hope, requestId);
      expect(answer.statusCode, answer.body).toBe(201);
      const conversation = conversationBodySchema.parse(answer.json()).conversation;
      expect(conversation.id).toBe(m.id);
      expect(conversation.lastMessage ?? null).toBeNull();
      expect(eventsOf(realtime, hope.publicUid, 'message')).toHaveLength(before);
      expect(await stored(m.id)).toEqual([]);
    });

    it('never moves a conversation back in the list when an accept is repeated', async () => {
      const ivy = await seedUser(h, { name: 'Ivy' });
      const jon = await seedUser(h, { name: 'Jon' });
      const req = await request(ivy, jon, 'coffee?');
      const accepted = conversationBodySchema.parse((await accept(jon, req.id)).json()).conversation;
      expect((await send(ivy, accepted.id, { kind: 'text', body: 'later news' })).statusCode).toBe(201);
      const list = h.app.keys.conversationList(jon.id);
      const score = await h.redis.zscore(list, accepted.id);
      expect((await accept(jon, req.id)).statusCode).toBe(201);
      expect(await h.redis.zscore(list, accepted.id)).toBe(score);
    });

    it('pages an inbox past senders it may not show', async () => {
      const me = await seedUser(h, { name: 'Kai' });
      const senders = [];
      for (const name of ['S1', 'S2', 'S3', 'S4']) {
        const sender = await seedUser(h, { name });
        await request(sender, me, `from ${name}`);
        senders.push(sender);
      }
      // The newest one's sender is hidden (a shadowban leaves the request pending).
      await h.db.sql.query(`UPDATE users SET is_shadowbanned = true WHERE id = $1`, [senders[3]!.id]);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
        const box = messageRequestsPageSchema.parse((await call(h, `/v1/message-requests?box=inbox&limit=2${query}`, { token: me.token })).json());
        seen.push(...box.items.map((i) => i.body));
        cursor = box.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toEqual(['from S3', 'from S2', 'from S1']);
    });
  });

  describe('the list as the live state keeps it', () => {
    const listed = async (user: SeededUser, id: string) =>
      conversationsPageSchema.parse((await call(h, '/v1/conversations', { token: user.token })).json()).items.find((c) => c.id === id);
    const read = async (user: SeededUser, id: string, upTo: string) =>
      expect((await call(h, `/v1/conversations/${id}/receipts`, { method: 'POST', token: user.token, body: { readUpTo: upTo } })).statusCode).toBe(204);

    it('clears the reader’s count once they read the newest message counted for them, whatever came after it', async () => {
      // An unsend of the newest message: the preview is the unsend, the count was for the message.
      const one = await pair('Lea', 'Max');
      const taken = sentMessageSchema.parse((await send(one.a, one.id, { kind: 'text', body: 'oops' })).json()).message;
      expect((await send(one.a, one.id, { kind: 'unsend', refId: taken.id })).statusCode).toBe(201);
      expect((await listed(one.b, one.id))?.unread).toBe(1);
      await read(one.b, one.id, taken.id);
      expect((await listed(one.b, one.id))?.unread).toBe(0);
      // A reply of the reader's own after the message they read.
      const two = await pair('Nia', 'Oli');
      const hello = sentMessageSchema.parse((await send(two.a, two.id, { kind: 'text', body: 'hello' })).json()).message;
      expect((await send(two.b, two.id, { kind: 'text', body: 'hi back' })).statusCode).toBe(201);
      await read(two.b, two.id, hello.id);
      expect((await listed(two.b, two.id))?.unread).toBe(0);
      // A read that stops before an unread message keeps the count.
      const three = await pair('Pia', 'Quin');
      const first = sentMessageSchema.parse((await send(three.a, three.id, { kind: 'text', body: 'first' })).json()).message;
      expect((await send(three.a, three.id, { kind: 'text', body: 'second' })).statusCode).toBe(201);
      await read(three.b, three.id, first.id);
      expect((await listed(three.b, three.id))?.unread).toBe(2);
    });

    it('reads back the newest message and the counts by the live rules once the cached state is gone', async () => {
      const { a, b, id } = await pair('Rae', 'Sol');
      const text = sentMessageSchema.parse((await send(a, id, { kind: 'text', body: 'the news' })).json()).message;
      expect((await send(b, id, { kind: 'reaction', refId: text.id, body: '❤️' })).statusCode).toBe(201);
      await durable(id, 2);
      // A quiet week: the preview's copy is gone.
      await h.redis.del(chatKeys(h.app.keys).lastMessage(id));
      expect((await listed(a, id))?.lastMessage).toMatchObject({ id: text.id, kind: 'text' });
      // Call lines the peer placed: a completed one counts nothing, a missed one counts.
      const line = (outcome: 'completed' | 'missed') =>
        h.db.sql.query(`INSERT INTO messages (match_id, id, sender_id, ref_id, kind, flags, body) VALUES ($1, $2, $3, $4, 5, 0, $5)`, [
          id,
          h.app.ids.nextId(),
          a.id,
          h.app.ids.nextId(),
          encodeCallLineBody({ kind: 'audio', outcome, durationSeconds: outcome === 'completed' ? 30 : 0, placedMs: Date.now() }),
        ]);
      await read(b, id, text.id);
      await line('completed');
      await h.db.sql.query(`UPDATE matches SET lo_read_id = $2, hi_read_id = $2 WHERE id = $1`, [id, text.id]);
      await h.redis.del(h.app.keys.conversationList(b.id), chatKeys(h.app.keys).unread(b.id), chatKeys(h.app.keys).lastMessage(id));
      expect((await listed(b, id))?.unread).toBe(0);
      await line('missed');
      await h.redis.del(h.app.keys.conversationList(b.id), chatKeys(h.app.keys).unread(b.id), chatKeys(h.app.keys).lastMessage(id));
      expect((await listed(b, id))?.unread).toBe(1);
      void messagesPageSchema;
    });

    it('serves a 304 for the list only while the presence it showed is at most an epoch old', async () => {
      const { a, b, id } = await pair('Tia', 'Uma');
      presence.onlineUids.add(a.publicUid);
      const first = await call(h, '/v1/conversations', { token: b.token });
      expect(conversationsPageSchema.parse(first.json()).items.find((c) => c.id === id)?.peer.online).toBe(true);
      const etag = String(first.headers['etag']);
      expect((await call(h, '/v1/conversations', { token: b.token, headers: { 'if-none-match': etag } })).statusCode).toBe(304);
      // Tia goes offline; nothing in the list's version moves.
      presence.onlineUids.delete(a.publicUid);
      await h.redis.del(chatKeys(h.app.keys).presence(a.id));
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2 * LIST_PRESENCE_EPOCH_MS + 1_000 });
      try {
        const later = await call(h, '/v1/conversations', { token: b.token, headers: { 'if-none-match': etag } });
        expect(later.statusCode).toBe(200);
        expect(statements(later)).toBe(0);
        expect(conversationsPageSchema.parse(later.json()).items.find((c) => c.id === id)?.peer.online).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
