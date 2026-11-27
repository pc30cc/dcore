import { randomUUID } from 'node:crypto';
import { clearUnsentBody, purgeUnmatched } from '@app/db';
import {
  adminChatListSchema,
  adminChatPageSchema,
  conversationsPageSchema,
  encodeCursor,
  idTime,
  messagesPageSchema,
  problemSchemaFor,
  sentMessageSchema,
  type AdminChatList,
  type AdminChatMessage,
  type AdminChatPage,
} from '@app/shared';
import { encodeCallLineBody, FakePresence, FakeRealtimePublisher, readWatermark } from '@app/shared/server';
import type { LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { STREAM_READ_LIMITS, type StreamReadLimits } from '../src/admin/chats.js';
import { CHAT_PAGES_PER_MINUTE, CHATS_LIST_PER_MINUTE } from '../src/routes/adminUserChats.js';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, migratedDatabase, row, seedUser, statements, type SeededUser, type TestDatabase } from './accountSupport.js';
import { admin, installTableDigest, seedAdmin, signIn, startAdminHarness, tableDigest, type AdminHarness } from './adminSupport.js';
import { matchOf, startChatPipeline, until, type ChatPipeline } from './chatSupport.js';
import { seedAction, seedMatch } from './moderationSupport.js';
import { hasInfrastructure, TEST_REDIS_URL } from './support.js';

/**
 * The admin user page's chats on PostgreSQL and Valkey, with the `wb:msg`
 * writer beside the API: who may read them (superadmin, admin; no other
 * seeded role, and users.* alone is not enough), their shapes, budgets and
 * pages, the messages not stored yet (read from the stream, once), unsends,
 * shadowbans, purged and deleted accounts, the unmatch purge, every kind,
 * the per-admin limits, and the rule the whole feature rests on: reading
 * changes nothing anyone sees and records nothing (no row in any table, no
 * Valkey key the app reads, no event, no job, no message text in a log).
 */

const MARKER = 'zq-chat-marker';

describe.skipIf(!hasInfrastructure)("admin: a person's conversations (users.chats)", () => {
  let db: TestDatabase;
  let h: AdminHarness;
  let pipeline: ChatPipeline;
  const realtime = new FakeRealtimePublisher();
  const jobs = new MemoryJobProducer();
  const presence = new FakePresence();
  const rawIds = new Set<string>();
  const bodies: string[] = [];
  let marks = 0;
  /** The routes' stream read limits, read on every request: a test narrows them and puts them back. */
  const streamLimits: Partial<StreamReadLimits> = {};

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startAdminHarness(db, {}, { realtime, jobs, chat: { presence }, adminChats: { stream: streamLimits } });
    pipeline = await startChatPipeline(h, realtime, { claimIdleMs: 3_000 });
    await installTableDigest(db);
  }, 120_000);

  afterAll(async () => {
    await pipeline?.stop();
    await h?.close();
    await db?.drop();
  });

  /** A text no other suite writes: no log line may ever carry it. */
  const marked = (what = 'text') => `${MARKER}-${(marks += 1)} ${what}`;

  let signIns = 0;
  /** A freshly signed-in admin of `role` (each test its own, so the per-admin limits never meet), each from its own address (the sign-in limit). */
  async function reader(role = 'superadmin'): Promise<string> {
    signIns += 1;
    return (await signIn(h, await seedAdmin(h, { roles: [role] }), `10.77.${Math.floor(signIns / 200)}.${(signIns % 200) + 1}`)).accessToken;
  }

  async function get(url: string, token: string): Promise<LightMyRequestResponse> {
    const res = await admin(h, url, undefined, { token });
    bodies.push(res.body);
    return res;
  }

  async function list(token: string, user: SeededUser, query = ''): Promise<AdminChatList> {
    const res = await get(`/v1/admin/users/${user.publicUid}/chats${query}`, token);
    expect(res.statusCode, res.body).toBe(200);
    return adminChatListSchema.parse(res.json());
  }

  async function page(token: string, user: SeededUser, conversationId: string, query = ''): Promise<AdminChatPage> {
    const res = await get(`/v1/admin/users/${user.publicUid}/chats/${conversationId}${query}`, token);
    expect(res.statusCode, res.body).toBe(200);
    return adminChatPageSchema.parse(res.json());
  }

  /** Every message of a conversation, all pages, oldest first. */
  async function everything(token: string, user: SeededUser, conversationId: string, limit = 50): Promise<AdminChatMessage[]> {
    const pages: AdminChatPage[] = [];
    let cursor: string | null = null;
    do {
      const next: AdminChatPage = await page(token, user, conversationId, `?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
      pages.push(next);
      cursor = next.nextCursor;
    } while (cursor);
    return pages.reverse().flatMap((p) => p.items);
  }

  async function person(name = 'Person', options: Parameters<typeof seedUser>[1] = {}): Promise<SeededUser> {
    const user = await seedUser(h, { name, ...options });
    rawIds.add(user.id);
    return user;
  }

  function send(user: SeededUser, conversationId: string, body: Record<string, unknown>) {
    return call(h, `/v1/conversations/${conversationId}/messages`, { method: 'POST', token: user.token, body: { clientId: randomUUID(), ...body } });
  }

  async function sent(user: SeededUser, conversationId: string, body: Record<string, unknown>): Promise<string> {
    const res = await send(user, conversationId, body);
    expect(res.statusCode, res.body).toBe(201);
    return sentMessageSchema.parse(res.json()).message.id;
  }

  async function stored(conversationId: string, n: number): Promise<void> {
    await until(async () => Number((await row<{ n: string }>(db, `SELECT count(*)::text AS n FROM messages WHERE match_id = $1`, [conversationId])).n) >= n);
  }

  /** Waits until the flush watermark has passed `id` (everything up to it is durable). */
  async function durableUpTo(id: string): Promise<void> {
    await until(async () => {
      const watermark = await readWatermark(h.redis, h.app.keys, 'msg');
      return watermark !== null && watermark > BigInt(id);
    });
  }

  interface Seed {
    sender: string;
    kind?: number;
    body?: string | null;
    ref?: string | null;
    flags?: number;
  }

  /** Messages written as the stream writer leaves them (direct rows), ids minted now in order; their ids. */
  async function seedMessages(matchId: string, seeds: readonly Seed[]): Promise<string[]> {
    const ids: string[] = [];
    for (const s of seeds) {
      const id = h.app.ids.nextId();
      ids.push(id);
      const kind = s.kind ?? 1;
      await db.sql.query(`INSERT INTO messages (match_id, id, sender_id, ref_id, kind, flags, body) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
        matchId,
        id,
        s.sender,
        s.ref ?? null,
        kind,
        s.flags ?? 0,
        s.body === undefined ? (kind === 8 || kind === 2 || kind === 3 ? null : marked()) : s.body,
      ]);
    }
    return ids;
  }

  async function customRole(id: number, key: string, grants: readonly string[]): Promise<string> {
    await db.sql.query(`INSERT INTO admin_roles (id, key, names) VALUES ($1, $2, '{"en": "Custom"}') ON CONFLICT (key) DO NOTHING`, [id, key]);
    for (const grant of grants) await db.sql.query(`INSERT INTO admin_role_permissions (role_id, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, grant]);
    await h.app.adminAuth.roles.reload();
    signIns += 1;
    return (await signIn(h, await seedAdmin(h, { roles: [key] }), `10.78.0.${signIns % 250}`)).accessToken;
  }

  describe('who may read', () => {
    it('lets superadmin and admin in, and no other seeded role, nor users.* without the grant', async () => {
      const subject = await person('Perm Subject');
      const other = await person('Perm Other');
      const m = await seedMatch(h, subject.id, other.id);
      await seedMessages(m, [{ sender: subject.id }]);
      const urls = [`/v1/admin/users/${subject.publicUid}/chats`, `/v1/admin/users/${subject.publicUid}/chats/${m}`];
      for (const role of ['superadmin', 'admin']) {
        const token = await reader(role);
        for (const url of urls) expect((await get(url, token)).statusCode, `${role} ${url}`).toBe(200);
      }
      for (const role of ['moderator', 'support', 'finance', 'marketing', 'analyst']) {
        const token = await reader(role);
        for (const url of urls) {
          const res = await get(url, token);
          expect(res.statusCode, `${role} ${url}`).toBe(403);
          problemSchemaFor('forbidden').parse(res.json());
        }
      }
      for (const url of urls) expect((await admin(h, url, undefined, {})).statusCode).toBe(401);
      // users.* and users.read: every other tab of the page, never the chats (the grant is restricted).
      const users = await customRole(51, 'people_reader', ['users.*', 'users.read']);
      for (const url of urls) expect((await get(url, users)).statusCode, url).toBe(403);
      expect((await get(`/v1/admin/users/${subject.publicUid}`, users)).statusCode).toBe(200);
    });
  });

  describe('shapes, budgets and pages', () => {
    it('answers its schemas in one statement each, never stored, naming people by public id only', async () => {
      const token = await reader();
      const subject = await person('Shape Subject');
      const other = await person('Shape Other');
      const x = await person('Shape X');
      const y = await person('Shape Y');
      const m = await seedMatch(h, subject.id, other.id);
      const theirs = await seedMatch(h, x.id, y.id);
      await seedMessages(m, [{ sender: subject.id }, { sender: other.id }]);
      const l = await get(`/v1/admin/users/${subject.publicUid}/chats`, token);
      const p = await get(`/v1/admin/users/${subject.publicUid}/chats/${m}`, token);
      for (const res of [l, p]) {
        expect(res.statusCode, res.body).toBe(200);
        expect(statements(res)).toBe(1);
        expect(res.headers['cache-control']).toBe('no-store');
      }
      const listed = adminChatListSchema.parse(l.json());
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]).toMatchObject({ id: m, other: { id: other.publicUid, name: 'Shape Other', status: 'active' }, state: 'active', source: 'like', endedAt: null, endedBy: null, held: false });
      expect(listed.items[0]!.messages).toEqual({ count: 2, more: false });
      expect(listed.streamComplete).toBe(true);
      const read = adminChatPageSchema.parse(p.json());
      expect(read.items.map((i) => i.from)).toEqual(['subject', 'other']);
      expect(read.stream).toBe('complete');
      for (const body of [l.body, p.body]) for (const id of [subject.id, other.id]) expect(body).not.toContain(id);
      // An unknown person and someone else's conversation: one statement each, 404.
      const nobody = h.app.publicIds.user.encode('123456789012');
      const unknownUser = await get(`/v1/admin/users/${nobody}/chats`, token);
      expect([unknownUser.statusCode, statements(unknownUser)]).toEqual([404, 1]);
      const unknownUserPage = await get(`/v1/admin/users/${nobody}/chats/${m}`, token);
      expect([unknownUserPage.statusCode, statements(unknownUserPage)]).toEqual([404, 1]);
      const notTheirs = await get(`/v1/admin/users/${subject.publicUid}/chats/${theirs}`, token);
      expect([notTheirs.statusCode, statements(notTheirs)]).toEqual([404, 1]);
      expect(notTheirs.json<{ detail: string }>().detail).toBe('No such conversation.');
      const unknown = await get(`/v1/admin/users/${subject.publicUid}/chats/${h.app.ids.nextId()}`, token);
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json<{ detail: string }>().detail).toBe('No such conversation.');
      expect((await get(`/v1/admin/users/nope/chats`, token)).statusCode).toBe(400);
    });

    it('pages a long conversation newest first, oldest first inside a page, with no gap and no repeat', async () => {
      const token = await reader();
      const subject = await person('Long Subject');
      const other = await person('Long Other');
      const m = await seedMatch(h, subject.id, other.id);
      const ids = await seedMessages(
        m,
        Array.from({ length: 120 }, (_, i) => ({ sender: i % 3 === 0 ? other.id : subject.id })),
      );
      const first = await page(token, subject, m);
      expect(first.items).toHaveLength(50);
      expect(first.items.map((i) => i.id)).toEqual(ids.slice(70));
      expect(first.nextCursor).not.toBeNull();
      const second = await page(token, subject, m, `?cursor=${first.nextCursor}`);
      expect(second.items.map((i) => i.id)).toEqual(ids.slice(20, 70));
      const third = await page(token, subject, m, `?cursor=${second.nextCursor}`);
      expect(third.items.map((i) => i.id)).toEqual(ids.slice(0, 20));
      expect(third.nextCursor).toBeNull();
      // The summary travels on the newest page only.
      expect(first.conversation!.messages).toEqual({ count: 100, more: true });
      expect([second.conversation, third.conversation]).toEqual([null, null]);
      // Cursors are this route's: a list cursor, a tab's cursor or garbage is a 400 at /cursor.
      for (const cursor of [encodeCursor({ c: m }), encodeCursor({ id: ids[5] }), 'not-a-cursor!']) {
        const bad = await get(`/v1/admin/users/${subject.publicUid}/chats/${m}?cursor=${encodeURIComponent(cursor)}`, token);
        expect(bad.statusCode, cursor).toBe(400);
        if (bad.json<{ code: string }>().code === 'validation_failed') {
          const pointers = bad.json<{ errors: { pointer: string }[] }>().errors.map((e) => e.pointer);
          expect(pointers).toContain('/cursor');
        }
      }
      expect((await get(`/v1/admin/users/${subject.publicUid}/chats/abc`, token)).statusCode).toBe(400);
      expect((await get(`/v1/admin/users/${subject.publicUid}/chats/${m}?limit=101`, token)).statusCode).toBe(400);
    });

    it('lists 45 conversations on both sides of their matches in pages of 20, 20 and 5', async () => {
      const token = await reader();
      const lower: SeededUser[] = [];
      for (let i = 0; i < 22; i += 1) lower.push(await person(`Lower ${i}`));
      const subject = await person('Many Subject');
      const higher: SeededUser[] = [];
      for (let i = 0; i < 23; i += 1) higher.push(await person(`Higher ${i}`));
      // Interleaved, so both index branches feed every page.
      const order: SeededUser[] = [];
      for (let i = 0; i < 23; i += 1) {
        if (lower[i]) order.push(lower[i]!);
        order.push(higher[i]!);
      }
      const ids: string[] = [];
      for (const other of order) ids.push(await seedMatch(h, subject.id, other.id));
      const newestFirst = [...ids].sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : -1));
      const p1 = await list(token, subject);
      const p2 = await list(token, subject, `?cursor=${p1.nextCursor}`);
      const p3 = await list(token, subject, `?cursor=${p2.nextCursor}`);
      expect([p1.items.length, p2.items.length, p3.items.length]).toEqual([20, 20, 5]);
      expect(p3.nextCursor).toBeNull();
      expect([...p1.items, ...p2.items, ...p3.items].map((c) => c.id)).toEqual(newestFirst);
      expect(new Set([...p1.items, ...p2.items, ...p3.items].map((c) => c.other.id)).size).toBe(45);
      const bad = await get(`/v1/admin/users/${subject.publicUid}/chats?cursor=${encodeCursor({ m: ids[0] })}`, token);
      expect(bad.statusCode).toBe(400);
      expect(bad.json<{ errors: { pointer: string }[] }>().errors[0]?.pointer).toBe('/cursor');
    });
  });

  describe('messages not stored yet', () => {
    it('reads them from the stream above the watermark, once, and from the database when stored', async () => {
      const token = await reader();
      const a = await person('Stream A');
      const b = await person('Stream B');
      const c = await person('Stream C');
      const m = await matchOf(h, a.id, b.id);
      const elsewhere = await matchOf(h, b.id, c.id);
      const first = await sent(a, m.id, { kind: 'text', body: marked('stored') });
      await stored(m.id, 1);
      await durableUpTo(first);
      await pipeline.pause();
      try {
        const pending = [await sent(b, m.id, { kind: 'text', body: marked() }), await sent(a, m.id, { kind: 'text', body: marked() }), await sent(b, m.id, { kind: 'gif', body: 'gif-123' })];
        await sent(c, elsewhere.id, { kind: 'text', body: marked('elsewhere') });
        // A malformed entry of the same conversation: skipped, never logged.
        const poison = await h.redis.xadd(h.app.keys.stream('msg'), '*', 'id', h.app.ids.nextId(), 'm', m.id, 's', a.id, 'k', '99', 'r', '', 'f', '0', 'b', marked('poison'));
        const read = await page(token, a, m.id);
        expect(read.items.map((i) => [i.id, i.pending])).toEqual([[first, false], ...pending.map((id) => [id, true])]);
        expect(read.items.map((i) => i.from)).toEqual(['subject', 'other', 'subject', 'other']);
        expect(read.stream).toBe('complete');
        expect(read.conversation!.messages.count).toBe(4);
        expect(read.conversation!.lastActivityAt).toBe(read.items.at(-1)!.at);
        const listed = (await list(token, a)).items.find((x) => x.id === m.id)!;
        expect(listed.lastActivityAt).toBe(read.items.at(-1)!.at);
        expect(listed.messages.count).toBe(4);
        // Valkey failing: the stored history, said to be incomplete, and one warning without the error's data.
        const spy = vi.spyOn(h.app.redis, 'xrevrange').mockRejectedValueOnce(new Error('stream down'));
        const degraded = await page(token, a, m.id);
        spy.mockRestore();
        expect(degraded.items.map((i) => i.id)).toEqual([first]);
        expect(degraded.stream).toBe('partial');
        expect(h.logs.some((line) => line.includes('admin chats: the message stream was not read'))).toBe(true);
        if (poison) await h.redis.xdel(h.app.keys.stream('msg'), poison);
      } finally {
        pipeline.resume();
      }
      const all = await page(token, a, m.id);
      const newest = all.items.at(-1)!.id;
      await stored(m.id, 4);
      await durableUpTo(newest);
      const after = await page(token, a, m.id);
      expect(after.items).toHaveLength(4);
      expect(after.items.every((i) => !i.pending)).toBe(true);
      expect(new Set(after.items.map((i) => i.id)).size).toBe(4);
    });

    it('counts every message not stored yet, also below a newer one written straight to the database', async () => {
      const token = await reader();
      const a = await person('Direct A');
      const b = await person('Direct B');
      const m = await matchOf(h, a.id, b.id);
      const first = await sent(a, m.id, { kind: 'text', body: marked('stored') });
      await stored(m.id, 1);
      await durableUpTo(first);
      await pipeline.pause();
      try {
        await sent(b, m.id, { kind: 'text', body: marked() });
        await sent(a, m.id, { kind: 'text', body: marked() });
        // A call line as the calls module writes it: straight to PostgreSQL, its id minted now (above both).
        const [line] = await seedMessages(m.id, [{ sender: a.id, kind: 5, ref: h.app.ids.nextId(), body: encodeCallLineBody({ kind: 'audio', outcome: 'missed', durationSeconds: 0, placedMs: Date.now() }) }]);
        const read = await page(token, a, m.id);
        expect(read.items.map((i) => i.pending)).toEqual([false, true, true, false]);
        expect(read.items.at(-1)!.id).toBe(line);
        expect(read.conversation!.messages.count).toBe(4);
        const listed = (await list(token, a)).items.find((x) => x.id === m.id)!;
        expect(listed.messages.count).toBe(4);
        expect(listed.lastActivityAt).toBe(read.items.at(-1)!.at);
      } finally {
        pipeline.resume();
      }
    });

    it('loses no message the writer stores between the stream read and the database read of the list', async () => {
      const token = await reader();
      const a = await person('Gap A');
      const b = await person('Gap B');
      const m = await matchOf(h, a.id, b.id);
      const first = await sent(a, m.id, { kind: 'text', body: marked('stored') });
      await stored(m.id, 1);
      await durableUpTo(first);
      await pipeline.pause();
      let flushed = false;
      try {
        const text = marked();
        const late = await sent(b, m.id, { kind: 'text', body: text });
        const watermarkKey = h.app.keys.streamWatermark('msg');
        const original = h.app.redis.get.bind(h.app.redis);
        // When the route reads the watermark, the message has just been stored and the watermark moved past it,
        // as the writer does (its row first, then the watermark; the entry is trimmed later).
        const spy = vi.spyOn(h.app.redis, 'get').mockImplementation((async (key: string) => {
          if (key === watermarkKey && !flushed) {
            flushed = true;
            await db.sql.query(`INSERT INTO messages (match_id, id, sender_id, kind, flags, body) VALUES ($1, $2, $3, 1, 0, $4)`, [m.id, late, b.id, text]);
            await h.redis.set(watermarkKey, String(BigInt(late) + 1n));
          }
          return original(key);
        }) as never);
        try {
          const listed = (await list(token, a)).items.find((x) => x.id === m.id)!;
          expect(flushed).toBe(true);
          expect(listed.messages.count).toBe(2);
          expect(listed.lastActivityAt).toBe(new Date(idTime(late)).toISOString());
        } finally {
          spy.mockRestore();
        }
      } finally {
        pipeline.resume();
      }
    }, 60_000);

    it('reads no stream for an older page below the watermark: nothing not stored yet can be there', async () => {
      const token = await reader();
      const a = await person('Older A');
      const b = await person('Older B');
      const m = await matchOf(h, a.id, b.id);
      await seedMessages(m.id, Array.from({ length: 60 }, (_, i) => ({ sender: i % 2 === 0 ? a.id : b.id })));
      const last = await sent(a, m.id, { kind: 'text', body: marked() });
      await stored(m.id, 61);
      await durableUpTo(last);
      const newest = await page(token, a, m.id);
      expect(newest.items).toHaveLength(50);
      const spy = vi.spyOn(h.app.redis, 'xrevrange');
      try {
        const older = await page(token, a, m.id, `?cursor=${newest.nextCursor}`);
        expect(older.items).toHaveLength(11);
        expect(older.nextCursor).toBeNull();
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('pages through a backlog longer than one read: each page stops where its read did and the next goes on, skipping nothing', async () => {
      const token = await reader();
      const a = await person('Backlog A');
      const b = await person('Backlog B');
      const c = await person('Backlog C');
      const m = await matchOf(h, a.id, b.id);
      const elsewhere = await matchOf(h, b.id, c.id);
      const first = await sent(a, m.id, { kind: 'text', body: marked('stored') });
      await stored(m.id, 1);
      await durableUpTo(first);
      await pipeline.pause();
      const stream = h.app.keys.stream('msg');
      const fillers: string[] = [];
      // Reads of 3 entries, stopping after 6 (after 12 at most to get below a cursor); here every id is minted
      // before its XADD on the one clock of this machine, so no margin is needed.
      Object.assign(streamLimits, { pageSize: 3, scanMax: 6, hardMax: 12, mintMarginMs: 0, clockSlackMs: 0 });
      try {
        const early = [await sent(b, m.id, { kind: 'text', body: marked() }), await sent(a, m.id, { kind: 'text', body: marked() })];
        // Twenty entries of another conversation after them, a few milliseconds apart.
        for (let i = 0; i < 20; i += 1) {
          const id = await h.redis.xadd(stream, '*', 'id', h.app.ids.nextId(), 'm', elsewhere.id, 's', c.id, 'k', '1', 'f', '0', 'b', marked('filler'));
          fillers.push(id!);
          await new Promise((resolve) => setTimeout(resolve, 3));
        }
        const late = await sent(a, m.id, { kind: 'text', body: marked() });
        const pages: AdminChatPage[] = [];
        let cursor: string | null = null;
        do {
          const next: AdminChatPage = await page(token, a, m.id, cursor ? `?cursor=${cursor}` : '');
          pages.push(next);
          cursor = next.nextCursor;
        } while (cursor && pages.length < 20);
        // The newest page holds what its read reached; the oldest, read to the watermark, the rest.
        expect(pages[0]!.stream).toBe('backlog');
        expect(pages[0]!.items.map((i) => i.id)).toEqual([late]);
        expect(pages.at(-1)!.stream).toBe('complete');
        expect(pages.at(-1)!.nextCursor).toBeNull();
        expect(pages.slice(0, -1).every((p) => p.stream === 'backlog')).toBe(true);
        const shown = [...pages].reverse().flatMap((p) => p.items.map((i) => i.id));
        expect(shown).toEqual([first, ...early, late]);
        // The list could not count every message not stored yet, and says so.
        expect((await list(token, a)).streamComplete).toBe(false);
        // A read that may take the whole backlog reads it whole.
        for (const key of Object.keys(streamLimits)) delete streamLimits[key as keyof StreamReadLimits];
        const whole = await page(token, a, m.id);
        expect(whole.stream).toBe('complete');
        expect(whole.items.map((i) => i.id)).toEqual([first, ...early, late]);
        expect(whole.conversation!.messages.count).toBe(4);
        expect((await list(token, a)).streamComplete).toBe(true);
      } finally {
        for (const key of Object.keys(streamLimits)) delete streamLimits[key as keyof StreamReadLimits];
        if (fillers.length > 0) await h.redis.xdel(stream, ...fillers);
        pipeline.resume();
      }
    }, 60_000);

    it('reads within its limits: a page of entries at a time, and gives up below a cursor it cannot get under', async () => {
      const { pendingMessagesOf } = await import('../src/admin/chats.js');
      const a = await person('Cap A');
      const b = await person('Cap B');
      const m = await matchOf(h, a.id, b.id);
      expect(STREAM_READ_LIMITS).toMatchObject({ pageSize: 1_000, scanMax: 5_000, hardMax: 10_000 });
      await pipeline.pause();
      try {
        const ids: string[] = [];
        for (let i = 0; i < 5; i += 1) ids.push(await sent(a, m.id, { kind: 'text', body: marked() }));
        const only = new Set([m.id]);
        const capped = await pendingMessagesOf(h.app, h.app.log, { matchIds: only }, { pageSize: 2, scanMax: 2, mintMarginMs: 0, clockSlackMs: 0 });
        expect(capped.read).toBe('backlog');
        expect(capped.cutAt).not.toBeNull();
        const whole = await pendingMessagesOf(h.app, h.app.log, { matchIds: only }, { pageSize: 2 });
        expect(whole).toMatchObject({ read: 'complete', cutAt: null });
        expect(whole.byMatch.get(m.id)!.map((x) => x.id)).toEqual(ids);
        // Below a cursor: only what is older, and the other conversations' bodies are never kept.
        const older = await pendingMessagesOf(h.app, h.app.log, { matchIds: only, before: ids[3]! }, { pageSize: 2 });
        expect(older.byMatch.get(m.id)!.map((x) => x.id)).toEqual(ids.slice(0, 3));
        const everyone = await pendingMessagesOf(h.app, h.app.log, { matchIds: null }, { pageSize: 2 });
        expect(everyone.byMatch.get(m.id)!.every((x) => x.body === null)).toBe(true);
        // A margin wider than the limits allow under the cursor: the read gives up and says so.
        const stuck = await pendingMessagesOf(h.app, h.app.log, { matchIds: only, before: ids[4]! }, { pageSize: 1, scanMax: 1, hardMax: 2, mintMarginMs: 60_000 });
        expect(stuck.read).toBe('partial');
      } finally {
        pipeline.resume();
      }
    });
  });

  describe('what a message shows', () => {
    it('keeps a taken-back body with its unsend time until the clear job removes it, wherever the unsend is', async () => {
      const token = await reader();
      const a = await person('Unsend A');
      const b = await person('Unsend B');
      const m = await matchOf(h, a.id, b.id);
      const text = marked('taken back');
      const target = await sent(a, m.id, { kind: 'text', body: text });
      await stored(m.id, 1);
      await durableUpTo(target);
      await pipeline.pause();
      let unsend: string;
      try {
        unsend = await sent(a, m.id, { kind: 'unsend', refId: target });
        const live = await page(token, b, m.id);
        const shown = live.items.find((i) => i.id === target)!;
        expect(shown).toMatchObject({ body: text, from: 'other', pending: false });
        expect(shown.unsentAt).toBe(live.items.find((i) => i.id === unsend)!.at);
        expect(live.items.find((i) => i.id === unsend)).toMatchObject({ kind: 'unsend', refId: target, pending: true, body: null });
      } finally {
        pipeline.resume();
      }
      await stored(m.id, 2);
      const kept = await page(token, a, m.id);
      expect(kept.items.find((i) => i.id === target)).toMatchObject({ body: text, unsentAt: kept.items.find((i) => i.id === unsend)!.at, flags: [] });
      expect(await clearUnsentBody(h.db.sql, m.id, target, a.id)).toBe('cleared');
      const cleared = await page(token, a, m.id);
      expect(cleared.items.find((i) => i.id === target)).toMatchObject({ body: null, flags: ['body_removed'] });
      expect(cleared.items.find((i) => i.id === target)!.unsentAt).not.toBeNull();
    });

    it('shows a call line as its summary, reactions, a like note, a GIF, and media without any link', async () => {
      const token = await reader();
      const a = await person('Kinds A');
      const b = await person('Kinds B');
      const m = await seedMatch(h, a.id, b.id);
      const callId = h.app.ids.nextId();
      const [note, text] = (await seedMessages(m, [{ sender: b.id, kind: 6 }, { sender: a.id }])) as [string, string];
      const [call, gif, image, voice, reaction, removed, hidden] = (await seedMessages(m, [
        { sender: a.id, kind: 5, ref: callId, body: encodeCallLineBody({ kind: 'video', outcome: 'completed', durationSeconds: 192, placedMs: Date.now() - 300_000 }) },
        { sender: b.id, kind: 4, body: 'provider-gif-42' },
        { sender: b.id, kind: 2, ref: h.app.ids.nextId() },
        { sender: a.id, kind: 3, ref: h.app.ids.nextId() },
        { sender: b.id, kind: 7, ref: text, body: '❤' },
        { sender: b.id, kind: 7, ref: text, body: '' },
        { sender: a.id, flags: 2 },
      ])) as [string, string, string, string, string, string, string];
      const read = await page(token, a, m);
      const by = new Map(read.items.map((i) => [i.id, i]));
      expect(by.get(note)).toMatchObject({ kind: 'like_note', from: 'other' });
      expect(by.get(note)!.body).toContain(MARKER);
      expect(by.get(call)).toMatchObject({ kind: 'call', body: null, refId: callId, call: { kind: 'video', outcome: 'completed', durationSeconds: 192 } });
      expect(by.get(gif)).toMatchObject({ kind: 'gif', body: 'provider-gif-42' });
      expect(by.get(image)).toMatchObject({ kind: 'image', body: null });
      expect(by.get(voice)).toMatchObject({ kind: 'voice', body: null });
      expect(by.get(reaction)).toMatchObject({ kind: 'reaction', body: '❤', refId: text });
      expect(by.get(removed)).toMatchObject({ kind: 'reaction', body: '', refId: text });
      expect(by.get(hidden)).toMatchObject({ flags: ['hidden'] });
      expect(by.get(hidden)!.body).toContain(MARKER);
      expect(JSON.stringify(read)).not.toMatch(/https?:/);
      // Reactions and unsends are not counted.
      expect(read.conversation!.messages.count).toBe(7);
    });

    it('marks what a shadowbanned sender wrote, and the visibility it has now, only for those who may see shadowbans', async () => {
      const token = await reader();
      const a = await person('Shadow A');
      const b = await person('Shadow B');
      const m = await seedMatch(h, a.id, b.id);
      const [before] = await seedMessages(m, [{ sender: a.id }]);
      // A few milliseconds apart, so no message shares the millisecond of the record's start or end.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const action = await seedAction(h, a.id, 4);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const during = await seedMessages(m, [{ sender: a.id }, { sender: b.id }, { sender: a.id }]);
      const standing = await page(token, a, m);
      expect(standing.conversation!.visibility).toEqual({ subjectSeesOther: true, otherSeesSubject: false });
      const lift = await admin(h, `/v1/admin/users/${a.publicUid}/lift`, { actionId: action }, { token: await reader() });
      expect(lift.statusCode, lift.body).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const [afterLift] = await seedMessages(m, [{ sender: a.id }]);
      const read = await page(token, a, m);
      const shadowed = new Map(read.items.map((i) => [i.id, i.shadowed]));
      expect([before, ...during, afterLift].map((id) => shadowed.get(id!))).toEqual([false, true, false, true, false]);
      expect(read.conversation!.visibility).toEqual({ subjectSeesOther: true, otherSeesSubject: true });
      // A role with the chats alone sees no shadowban, nor holds.
      await db.sql.query(`INSERT INTO legal_holds (id, match_id, kind) VALUES ($1, $2, 2)`, [h.app.ids.nextId(), m]);
      const plain = await customRole(52, 'chat_reader', ['users.read', 'users.chats']);
      const narrow = await page(plain, a, m);
      expect(narrow.conversation!.visibility).toBeUndefined();
      expect(narrow.conversation!.held).toBe(false);
      expect(narrow.items.every((i) => i.shadowed === undefined)).toBe(true);
      expect((await list(plain, a)).items[0]!.held).toBe(false);
      expect((await page(token, a, m)).conversation!.held).toBe(true);
    });
  });

  describe('accounts and retention', () => {
    it('reads the conversations of a deleted, a purged and a banned other person, and 404s a purged subject', async () => {
      const token = await reader();
      const subject = await person('Acct Subject');
      const deleted = await person('Acct Deleted');
      const purged = await person('Acct Purged');
      const m1 = await seedMatch(h, subject.id, deleted.id);
      const m2 = await seedMatch(h, subject.id, purged.id);
      await seedMessages(m1, [{ sender: deleted.id }]);
      await seedMessages(m2, [{ sender: purged.id }, { sender: subject.id }]);
      await db.sql.query(`UPDATE users SET status = 7, deleted_at = now() WHERE id = $1`, [deleted.id]);
      await db.sql.query(`UPDATE matches SET state = 4, ended_at = now(), ended_by = 3 WHERE id = ANY($1::bigint[])`, [[m1, m2]]);
      await db.sql.query(`INSERT INTO legal_holds (id, match_id, kind) VALUES ($1, $2, 1)`, [h.app.ids.nextId(), m2]);
      await db.sql.query(`DELETE FROM profiles WHERE user_id = $1`, [purged.id]);
      await db.sql.query(`UPDATE users SET status = 8, deleted_at = now(), birth_date = NULL, gender = NULL, country = NULL WHERE id = $1`, [purged.id]);
      const by = new Map((await list(token, subject)).items.map((c) => [c.id, c]));
      expect(by.get(m1)).toMatchObject({ state: 'account_gone', endedBy: 'system', other: { id: deleted.publicUid, status: 'deleted', name: 'Acct Deleted' } });
      expect(by.get(m2)).toMatchObject({ state: 'account_gone', held: true, retentionDays: null, other: { id: purged.publicUid, status: 'purged', name: null } });
      expect((await page(token, subject, m1)).items).toHaveLength(1);
      expect((await page(token, subject, m2)).items).toHaveLength(2);
      // The subject purged: both routes 404, as every tab.
      await db.sql.query(`DELETE FROM profiles WHERE user_id = $1`, [subject.id]);
      await db.sql.query(`UPDATE users SET status = 8, deleted_at = now(), birth_date = NULL, gender = NULL, country = NULL WHERE id = $1`, [subject.id]);
      for (const url of [`/v1/admin/users/${subject.publicUid}/chats`, `/v1/admin/users/${subject.publicUid}/chats/${m2}`]) {
        const res = await get(url, token);
        expect(res.statusCode).toBe(404);
        expect(res.json<{ detail: string }>().detail).toBe('No such user.');
      }
    });

    it('says when an ended conversation was emptied by the unmatch purge, and not while a hold keeps it', async () => {
      const token = await reader();
      const subject = await person('Purge Subject');
      const gone = await person('Purge Gone');
      const keptOther = await person('Purge Kept');
      const m = await seedMatch(h, subject.id, gone.id);
      const k = await seedMatch(h, subject.id, keptOther.id);
      await seedMessages(m, [{ sender: subject.id }, { sender: gone.id }]);
      await seedMessages(k, [{ sender: keptOther.id }]);
      const days = h.app.cfg.get().app['retention.unmatched_messages_days'];
      await db.sql.query(`UPDATE matches SET state = 2, ended_by = 1, ended_at = now() - make_interval(days => $2) WHERE id = ANY($1::bigint[])`, [[m, k], days + 1]);
      await db.sql.query(`INSERT INTO legal_holds (id, match_id, kind) VALUES ($1, $2, 2)`, [h.app.ids.nextId(), k]);
      expect(await purgeUnmatched(h.db.sql, m)).toBe('purged');
      expect(await purgeUnmatched(h.db.sql, k)).toBe('held');
      const by = new Map((await list(token, subject)).items.map((c) => [c.id, c]));
      expect(by.get(m)).toMatchObject({ state: 'unmatched', endedBy: 'subject', retentionDays: days, messages: { count: 0, more: false }, lastActivityAt: null });
      expect(by.get(k)).toMatchObject({ held: true, retentionDays: null, messages: { count: 1, more: false } });
      const emptied = await page(token, subject, m);
      expect(emptied.items).toEqual([]);
      expect(emptied.nextCursor).toBeNull();
      expect((await page(token, subject, k)).items).toHaveLength(1);
    });
  });

  describe('reading changes nothing anyone sees', () => {
    interface KeyState {
      type: string;
      dump: string | null;
      pttl: number;
    }

    /** Process leases the harness renews on a timer, and the routes' own counters. */
    const OWN = ['rl:', 'idgen:', 'lease:'];
    const own = (key: string) => OWN.some((part) => key.startsWith(`${h.prefix}${part}`));

    async function keyStates(): Promise<Map<string, KeyState>> {
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [next, batch] = await h.redis.scan(cursor, 'MATCH', `${h.prefix}*`, 'COUNT', 1_000);
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0');
      const states = new Map<string, KeyState>();
      for (const key of keys.sort()) {
        const [type, dump, pttl] = await Promise.all([h.redis.type(key), h.redis.dumpBuffer(key), h.redis.pttl(key)]);
        states.set(key, { type, dump: dump ? dump.toString('hex') : null, pttl });
      }
      return states;
    }

    it('writes no row and no key the app reads, sends nothing, and leaves both people their own views as they were', async () => {
      const a = await person('Quiet A');
      const b = await person('Quiet B');
      const m = await matchOf(h, a.id, b.id);
      // Sixty stored messages (as the writer leaves them: a send is limited to 20 per 10 s and conversation).
      const texts = await seedMessages(m.id, Array.from({ length: 60 }, (_, i) => ({ sender: i % 2 === 0 ? a.id : b.id })));
      // B reads up to the 30th, a call line is written as the calls module writes it, A takes one back and B reacts.
      const receipt = await call(h, `/v1/conversations/${m.id}/receipts`, { method: 'POST', token: b.token, body: { readUpTo: texts[29], deliveredUpTo: texts[59] } });
      expect(receipt.statusCode).toBe(204);
      await seedMessages(m.id, [{ sender: a.id, kind: 5, ref: h.app.ids.nextId(), body: encodeCallLineBody({ kind: 'audio', outcome: 'missed', durationSeconds: 0, placedMs: Date.now() }) }]);
      await sent(a, m.id, { kind: 'unsend', refId: texts[58]! });
      await sent(b, m.id, { kind: 'reaction', refId: texts[0]!, body: '👍' });
      await stored(m.id, 63);
      await durableUpTo((await row<{ id: string }>(db, `SELECT max(id)::text AS id FROM messages WHERE match_id = $1`, [m.id])).id);
      await pipeline.pause();
      try {
        // Three news from B not stored yet: A has three unread in Valkey only.
        for (let i = 0; i < 3; i += 1) await sent(b, m.id, { kind: 'text', body: marked('pending') });
        // Each person's own reads, warm (the list twice: built, then cached).
        const views = async (user: SeededUser) => {
          await call(h, '/v1/conversations', { token: user.token });
          const listed = await call(h, '/v1/conversations', { token: user.token });
          const history = await call(h, `/v1/conversations/${m.id}/messages`, { token: user.token });
          expect([listed.statusCode, history.statusCode]).toEqual([200, 200]);
          return { list: conversationsPageSchema.parse(listed.json()), etag: String(listed.headers['etag']), history: messagesPageSchema.parse(history.json()) };
        };
        const before = { a: await views(a), b: await views(b) };
        // The admins sign in first: a sign-in writes its own keys.
        const readers = [await reader('superadmin'), await reader('admin')];

        const tables = await tableDigest(db);
        const keys = await keyStates();
        const published = realtime.published.length;
        const disconnected = realtime.disconnected.length;
        const queued = jobs.jobs.length;
        const audits = (await row<{ n: string }>(db, `SELECT count(*)::text AS n FROM audit_log`)).n;
        const startedAt = Date.now();

        // Every command any client sends under the prefix while the admins read.
        const watcher = new Redis(TEST_REDIS_URL ?? '');
        const monitor = await watcher.monitor();
        const seen: string[][] = [];
        monitor.on('monitor', (_time: string, args: string[]) => {
          if (args.some((arg) => typeof arg === 'string' && arg.startsWith(h.prefix))) seen.push(args);
        });
        for (const token of readers) {
          for (let round = 0; round < 2; round += 1) {
            for (const subject of [a, b]) {
              const listed = await list(token, subject);
              expect(listed.items.map((c) => c.id)).toEqual([m.id]);
              const messages = await everything(token, subject, m.id, 20);
              expect(messages).toHaveLength(66);
              expect(messages.filter((x) => x.pending)).toHaveLength(3);
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        monitor.disconnect();
        watcher.disconnect();

        // No row anywhere: no audit row, no read pointer, no record of the read.
        expect(await tableDigest(db)).toEqual(tables);
        expect((await row<{ n: string }>(db, `SELECT count(*)::text AS n FROM audit_log`)).n).toBe(audits);
        // No event, no disconnect, no job.
        expect(realtime.published.length).toBe(published);
        expect(realtime.disconnected.length).toBe(disconnected);
        expect(jobs.jobs.length).toBe(queued);
        // Every key the app reads is as it was (a key that is gone had run out by itself); none is new.
        const elapsed = Date.now() - startedAt;
        const after = await keyStates();
        for (const [key, state] of keys) {
          if (own(key)) continue;
          const now = after.get(key);
          if (!now) {
            expect(state.pttl, `${key} disappeared`).toBeGreaterThan(0);
            expect(state.pttl, `${key} disappeared`).toBeLessThanOrEqual(elapsed + 1_000);
            continue;
          }
          expect({ key, type: now.type, dump: now.dump }).toEqual({ key, type: state.type, dump: state.dump });
          if (state.pttl > 0) expect(now.pttl, key).toBeLessThanOrEqual(state.pttl);
          else expect(now.pttl, key).toBe(state.pttl);
        }
        const added = [...after.keys()].filter((key) => !keys.has(key) && !own(key));
        expect(added).toEqual([]);
        // The routes' own counters name the route and the admin only.
        const counters = [...after.keys()].filter((key) => key.startsWith(`${h.prefix}rl:`) && key.includes('/chats'));
        expect(counters.length).toBeGreaterThan(0);
        for (const key of counters) {
          for (const id of [a.id, b.id, a.publicUid, b.publicUid, m.id]) expect(key).not.toContain(id);
        }
        // Commands on the app's keys were reads; writes went only to the routes' counters and the harness's leases.
        const READS = new Set(['get', 'mget', 'exists', 'xrevrange', 'type', 'pttl', 'scan', 'dump', 'ttl']);
        const writes = seen.filter((args) => {
          const name = String(args[0]).toLowerCase();
          if (READS.has(name)) return false;
          const named = args.filter((arg) => typeof arg === 'string' && arg.startsWith(h.prefix));
          return !named.every(own);
        });
        expect(writes).toEqual([]);
        expect(seen.some((args) => String(args[0]).toLowerCase() === 'xrevrange')).toBe(true);

        // Both people's own reads answer as before: unread counts, last message, read and delivered pointers, the list's ETag.
        for (const [user, was] of [
          [a, before.a],
          [b, before.b],
        ] as const) {
          const listed = await call(h, '/v1/conversations', { token: user.token });
          expect(conversationsPageSchema.parse(listed.json())).toEqual(was.list);
          const unchanged = await call(h, '/v1/conversations', { token: user.token, headers: { 'if-none-match': was.etag } });
          expect(unchanged.statusCode).toBe(304);
          const history = await call(h, `/v1/conversations/${m.id}/messages`, { token: user.token });
          expect(messagesPageSchema.parse(history.json())).toEqual(was.history);
        }
      } finally {
        pipeline.resume();
      }
    });

    it('leaves no message text in any log line, the error paths included', () => {
      expect(bodies.length).toBeGreaterThan(0);
      const leaked = h.logs.filter((line) => line.includes(MARKER));
      expect(leaked).toEqual([]);
      // And no seeded raw person id in any answer of these routes.
      for (const body of bodies) for (const id of rawIds) expect(body.includes(`"${id}"`), id).toBe(false);
    });
  });

  describe('limits', () => {
    it(`allows ${CHATS_LIST_PER_MINUTE} list reads and ${CHAT_PAGES_PER_MINUTE} page reads a minute per admin`, async () => {
      const subject = await person('Limit Subject');
      const other = await person('Limit Other');
      const m = await seedMatch(h, subject.id, other.id);
      const one = await reader();
      const two = await reader('admin');
      const listUrl = `/v1/admin/users/${subject.publicUid}/chats`;
      const pageUrl = `${listUrl}/${m}`;
      for (let i = 0; i < CHATS_LIST_PER_MINUTE; i += 1) expect((await admin(h, listUrl, undefined, { token: one })).statusCode).toBe(200);
      const refused = await admin(h, listUrl, undefined, { token: one });
      expect(refused.statusCode).toBe(429);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      problemSchemaFor('rate_limited').parse(refused.json());
      // A HEAD runs no handler of its own: no second counter beside the GET's.
      expect((await admin(h, listUrl, undefined, { token: one, method: 'HEAD' })).statusCode).toBe(404);
      for (let i = 0; i < CHAT_PAGES_PER_MINUTE; i += 1) expect((await admin(h, pageUrl, undefined, { token: one })).statusCode).toBe(200);
      expect((await admin(h, pageUrl, undefined, { token: one })).statusCode).toBe(429);
      expect((await admin(h, pageUrl, undefined, { token: one, method: 'HEAD' })).statusCode).toBe(404);
      // Nor for an admin with requests left: HEAD is no route here at all.
      expect((await admin(h, listUrl, undefined, { token: two, method: 'HEAD' })).statusCode).toBe(404);
      // Another admin has their own counters.
      expect((await admin(h, listUrl, undefined, { token: two })).statusCode).toBe(200);
      expect((await admin(h, pageUrl, undefined, { token: two })).statusCode).toBe(200);
    }, 60_000);
  });
});
