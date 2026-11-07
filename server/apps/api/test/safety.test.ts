import {
  blockListSchema,
  conversationsPageSchema,
  deckPageSchema,
  likesPageSchema,
  moderationHistorySchema,
  realtimePayloads,
  reportReceiptSchema,
  swipesResponseSchema,
  userChannel,
  type RealtimeEnvelope,
} from '@app/shared';
import { CdnUrlSigner, FakeObjectStorage, FakeRealtimePublisher, cellCentre, homeCell, writeDeck, type MediaStore } from '@app/shared/server';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { ModerationActions } from '../src/services/moderationActions.js';
import { call, json, migratedDatabase, row, seedUser, startHarness, statements, type Harness, type SeededUser, type TestDatabase } from './accountSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * Safety end to end on PostgreSQL and Valkey: the block and report routes
 * with their budgets, the moderation actions the server writes, and the
 * visibility rule on every list: a block, a ban, a snooze, a shadowban and a
 * deletion each take the person out of the deck, the likes, profile reads
 * and the conversation lists on the very next request (no worker run in
 * between), and a block reads exactly like an unmatch to the person
 * blocked.
 */

const CDN_KEY = 'safety-test-cdn-signing-key-0123456789';
const CELL = homeCell({ lat: 41.03, lng: 28.98 });
const NEAR = homeCell({ lat: 41.05, lng: 29.02 });

type Person = SeededUser & { version: number };

describe.skipIf(!hasInfrastructure)('safety (PostgreSQL, Valkey)', () => {
  let db: TestDatabase;
  let h: Harness;
  const jobs = new MemoryJobProducer();
  const realtime = new FakeRealtimePublisher();
  const media: MediaStore = {
    storage: new FakeObjectStorage(),
    privateBucket: 'uploads',
    mediaBucket: 'media',
    urls: new CdnUrlSigner({ baseUrl: 'https://cdn.test.invalid', signingKey: CDN_KEY, scheme: 'hmac' }),
  };
  const rawIds: string[] = [];

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startHarness(db, {}, { jobs, realtime, media });
    await h.redis.set(h.app.keys.likesReady(), '1');
  }, 90_000);
  afterAll(async () => {
    for (const id of rawIds) for (const body of h?.bodies ?? []) expect(body.includes(`"${id}"`), `raw id ${id} in a response`).toBe(false);
    await h?.close();
    await db?.drop();
  });
  beforeEach(() => {
    jobs.jobs.length = 0;
  });

  /** An active person in discovery: a profile, preferences, a location and two approved photos. */
  async function person(name: string, options: { gender?: number; interestedIn?: number; cell?: string } = {}): Promise<Person> {
    const user = await seedUser(h, { name, gender: options.gender ?? 1, interestedIn: options.interestedIn ?? 4, country: 'TR' });
    rawIds.push(user.id);
    const cell = options.cell ?? NEAR;
    const centre = cellCentre(cell);
    await db.sql.query(`UPDATE profiles SET text_state = 2, about = 'Hello' WHERE user_id = $1`, [user.id]);
    await db.sql.query(
      `INSERT INTO user_locations (user_id, home_h3, source, country, home_geo) VALUES ($1, $2, 1, 'TR', ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography)`,
      [user.id, cell, centre.lng, centre.lat],
    );
    for (let position = 0; position < 2; position += 1) {
      await db.sql.query(
        `INSERT INTO photos (id, user_id, position, status, width, height, blurhash, blob_ver) VALUES ($1, $2, $3, 3, 1080, 1350, 'L6PZfSi_.AyE', 1)`,
        [h.app.ids.nextId(), user.id, position],
      );
    }
    const { version } = await row<{ version: number }>(db, `SELECT version FROM profiles WHERE user_id = $1`, [user.id]);
    return { ...user, version };
  }

  /** A man looking for women, near the women of {@link person}. */
  async function viewer(name: string): Promise<Person> {
    return person(name, { gender: 2, interestedIn: 2, cell: CELL });
  }

  async function swipe(user: SeededUser, target: SeededUser, action: 'like' | 'superlike' | 'pass') {
    const response = await call(h, '/v1/swipes', { method: 'POST', token: user.token, body: { swipes: [{ target: target.publicUid, action }] } });
    expect(response.statusCode, response.body).toBe(200);
    return swipesResponseSchema.parse(response.json()).results[0]!;
  }

  async function matchOf(a: SeededUser, b: SeededUser): Promise<string> {
    await swipe(a, b, 'like');
    const result = await swipe(b, a, 'like');
    expect(result.result).toBe('matched');
    return result.conversation!.id;
  }

  async function deckIds(user: SeededUser): Promise<string[]> {
    const response = await call(h, '/v1/deck?limit=20', { token: user.token });
    expect(response.statusCode, response.body).toBe(200);
    return deckPageSchema.parse(response.json()).cards.map((c) => c.id);
  }

  async function likers(user: SeededUser): Promise<string[]> {
    const response = await call(h, '/v1/likes', { token: user.token });
    expect(response.statusCode, response.body).toBe(200);
    return likesPageSchema.parse(response.json()).items.flatMap((i) => (i.liker ? [i.liker.id] : []));
  }

  async function peers(user: SeededUser, etag?: string): Promise<{ status: number; ids: string[]; etag: string }> {
    const response = await call(h, '/v1/conversations', { token: user.token, ...(etag ? { headers: { 'if-none-match': etag } } : {}) });
    const ids = response.statusCode === 200 ? conversationsPageSchema.parse(response.json()).items.map((c) => c.peer.id) : [];
    return { status: response.statusCode, ids, etag: String(response.headers['etag']) };
  }

  async function profileStatus(viewerUser: SeededUser, target: SeededUser): Promise<number> {
    return (await call(h, `/v1/profiles/${target.publicUid}`, { token: viewerUser.token })).statusCode;
  }

  function events(user: SeededUser, type?: RealtimeEnvelope['t']): RealtimeEnvelope[] {
    return realtime.on(userChannel(user.publicUid)).filter((e) => type === undefined || e.t === type);
  }

  // ─── Removal on the next request ──────────────────────────────────────

  type Cause = 'block' | 'ban' | 'snooze' | 'shadowban' | 'deletion';

  /**
   * `seer` has the target queued in their deck and among their likers (a
   * super like, always shown open); `partner` is in a conversation with the
   * target. Both lists and both profile reads are warm before the change.
   */
  async function scene(cause: Cause) {
    const target = await person(`T-${cause}`);
    const seer = await viewer(`S-${cause}`);
    const partner = await viewer(`P-${cause}`);
    await writeDeck(h.app.cache, h.app.keys, seer.id, {
      kept: [],
      front: [],
      back: [{ userId: target.id, version: target.version, km: 3, flags: 0 }],
      builtAt: Date.now() - 5_000,
      cursor: null,
      exhaustedAt: null,
    });
    expect((await swipe(target, seer, 'superlike')).result).toBe('liked');
    const conversation = await matchOf(partner, target);
    // Everything warm: the deck card, the likes page, the profile, the list and its visibility verdicts.
    expect(await deckIds(seer)).toEqual([target.publicUid]);
    expect(await likers(seer)).toEqual([target.publicUid]);
    expect(await profileStatus(seer, target)).toBe(200);
    expect(await profileStatus(partner, target)).toBe(200);
    const before = await peers(partner);
    expect(before.ids).toEqual([target.publicUid]);
    expect((await peers(partner)).ids).toEqual([target.publicUid]);
    expect((await peers(partner, before.etag)).status).toBe(304);
    return { target, seer, partner, conversation, etag: before.etag };
  }

  async function apply(cause: Cause, s: Awaited<ReturnType<typeof scene>>): Promise<void> {
    const actions = new ModerationActions(h.app);
    switch (cause) {
      case 'block': {
        // The seer blocks the target; the target blocks the partner (the partner is the one blocked).
        expect((await call(h, '/v1/blocks', { method: 'POST', token: s.seer.token, body: { target: s.target.publicUid } })).statusCode).toBe(204);
        expect((await call(h, '/v1/blocks', { method: 'POST', token: s.target.token, body: { target: s.partner.publicUid } })).statusCode).toBe(204);
        return;
      }
      case 'ban':
        expect((await actions.apply({ userId: s.target.id, kind: 3, reasonCode: 2, reasonText: 'Harassment of other members.' })).outcome.outcome).toBe('applied');
        return;
      case 'shadowban':
        expect((await actions.apply({ userId: s.target.id, kind: 4, reasonCode: 7, reasonText: 'Spam pattern.' })).outcome.outcome).toBe('applied');
        return;
      case 'snooze': {
        const response = await call(h, '/v1/me/settings', { method: 'PATCH', token: s.target.token, body: { snoozed: true } });
        expect(response.statusCode, response.body).toBe(200);
        return;
      }
      case 'deletion': {
        const response = await call(h, '/v1/me/deletion', { method: 'POST', token: s.target.token, body: {} });
        expect(response.statusCode, response.body).toBe(202);
        return;
      }
    }
  }

  describe.each<Cause>(['block', 'ban', 'snooze', 'shadowban', 'deletion'])('a %s', (cause) => {
    it('takes the person out of the deck, the likes, profile reads and conversation lists on the next request', async () => {
      const s = await scene(cause);
      await apply(cause, s);
      expect(await deckIds(s.seer)).toEqual([]);
      expect(await likers(s.seer)).toEqual([]);
      expect(await profileStatus(s.seer, s.target)).toBe(404);
      const after = await peers(s.partner, s.etag);
      if (cause === 'snooze') {
        // A snoozed person keeps their existing conversations (visibility context 2).
        expect(after.status === 304 || after.ids.join() === s.target.publicUid).toBe(true);
        expect((await peers(s.partner)).ids).toEqual([s.target.publicUid]);
        expect(await profileStatus(s.partner, s.target)).toBe(200);
      } else {
        expect(after.status).toBe(200);
        expect(after.ids).toEqual([]);
        expect(await profileStatus(s.partner, s.target)).toBe(404);
        // And it stays out on the reads after (the kept verdicts, the next page).
        expect((await peers(s.partner)).ids).toEqual([]);
      }
    });
  });

  it('keeps a shadowbanned person’s own lists as they were: nothing tells them', async () => {
    const s = await scene('shadowban');
    const own = await peers(s.target);
    await apply('shadowban', s);
    const after = await peers(s.target);
    expect(after.ids).toEqual(own.ids);
    expect(after.ids).toEqual([s.partner.publicUid]);
    expect(events(s.target, 'account')).toEqual([]);
    expect(events(s.partner, 'conversation_end')).toEqual([]);
    const me = await call(h, '/v1/me', { token: s.target.token });
    expect(me.statusCode).toBe(200);
    expect(me.body).not.toMatch(/"shadow|isShadow/i);
  });

  // ─── Blocks ───────────────────────────────────────────────────────────

  describe('blocks', () => {
    it('blocks in one statement, lists the people blocked in one, lifts in one; answers 404 for nobody and for oneself', async () => {
      const me = await viewer('Blocker');
      const other = await person('Blocked');
      const blocked = await call(h, '/v1/blocks', { method: 'POST', token: me.token, body: { target: other.publicUid } });
      expect(blocked.statusCode).toBe(204);
      expect(statements(blocked)).toBe(1);
      const again = await call(h, '/v1/blocks', { method: 'POST', token: me.token, body: { target: other.publicUid } });
      expect(again.statusCode).toBe(204);

      const list = await call(h, '/v1/blocks', { token: me.token });
      expect(list.statusCode).toBe(200);
      expect(statements(list)).toBe(1);
      const body = blockListSchema.strict().parse(list.json());
      expect(body.items).toHaveLength(1);
      expect(body.items[0]!.user).toMatchObject({ id: other.publicUid, name: 'Blocked', verified: false });
      expect(CdnUrlSigner.verifyHmac(body.items[0]!.user.photo!.url, CDN_KEY)).toBe(true);
      expect(Math.abs(Date.parse(body.items[0]!.blockedAt) - Date.now())).toBeLessThan(60_000);
      expect(body.nextCursor).toBeNull();
      // The other side sees nobody: a block made by someone else is never listed.
      expect(blockListSchema.parse((await call(h, '/v1/blocks', { token: other.token })).json()).items).toEqual([]);

      const lifted = await call(h, `/v1/blocks/${other.publicUid}`, { method: 'DELETE', token: me.token });
      expect(lifted.statusCode).toBe(204);
      expect(statements(lifted)).toBe(1);
      expect(blockListSchema.parse((await call(h, '/v1/blocks', { token: me.token })).json()).items).toEqual([]);
      const nobody = await call(h, '/v1/blocks/not-a-person', { method: 'DELETE', token: me.token });
      expect(nobody.statusCode).toBe(204);
      expect(statements(nobody)).toBe(0);

      const unknown = h.app.publicIds.user.encode(h.app.ids.nextId());
      expect((await call(h, '/v1/blocks', { method: 'POST', token: me.token, body: { target: unknown } })).statusCode).toBe(404);
      expect((await call(h, '/v1/blocks', { method: 'POST', token: me.token, body: { target: me.publicUid } })).statusCode).toBe(404);
      expect((await call(h, '/v1/blocks', { method: 'POST', body: { target: other.publicUid } })).statusCode).toBe(401);
    });

    it('pages the block list by when each block was made', async () => {
      const me = await viewer('Pager');
      const people: Person[] = [];
      for (let i = 0; i < 5; i += 1) {
        const p = await person(`B${i}`);
        people.push(p);
        await call(h, '/v1/blocks', { method: 'POST', token: me.token, body: { target: p.publicUid } });
        await new Promise((resolve) => setTimeout(resolve, 3));
      }
      const first = blockListSchema.parse((await call(h, '/v1/blocks?limit=2', { token: me.token })).json());
      expect(first.items.map((i) => i.user.name)).toEqual(['B4', 'B3']);
      const second = blockListSchema.parse((await call(h, `/v1/blocks?limit=2&cursor=${first.nextCursor}`, { token: me.token })).json());
      const third = blockListSchema.parse((await call(h, `/v1/blocks?limit=2&cursor=${second.nextCursor}`, { token: me.token })).json());
      expect([...second.items, ...third.items].map((i) => i.user.name)).toEqual(['B2', 'B1', 'B0']);
      expect(third.nextCursor).toBeNull();
      expect((await call(h, '/v1/blocks?cursor=nonsense', { token: me.token })).statusCode).toBe(400);
    });

    it('reads exactly like an unmatch to the person blocked', async () => {
      // A is blocked by B; C is unmatched by D. A and C must see the same things.
      const a = await viewer('A');
      const b = await person('B');
      const c = await viewer('C');
      const d = await person('D');
      const ab = await matchOf(a, b);
      const cd = await matchOf(c, d);
      const seenBefore = { a: realtime.on(userChannel(a.publicUid)).length, c: realtime.on(userChannel(c.publicUid)).length };

      const block = await call(h, '/v1/blocks', { method: 'POST', token: b.token, body: { target: a.publicUid } });
      expect(block.statusCode).toBe(204);
      const unmatch = await call(h, `/v1/conversations/${cd}`, { method: 'DELETE', token: d.token });
      expect(unmatch.statusCode).toBe(204);

      // The same events: one conversation_end with only the conversation id, to both people.
      const newOf = (u: SeededUser, from: number) => realtime.on(userChannel(u.publicUid)).slice(from);
      const forA = newOf(a, seenBefore.a);
      const forC = newOf(c, seenBefore.c);
      expect(forA.map((e) => [e.t, Object.keys(e.d).sort()])).toEqual(forC.map((e) => [e.t, Object.keys(e.d).sort()]));
      expect(forA).toHaveLength(1);
      expect(realtimePayloads.conversation_end.strict().parse(forA[0]!.d)).toEqual({ conversationId: ab });
      expect(realtimePayloads.conversation_end.strict().parse(forC[0]!.d)).toEqual({ conversationId: cd });
      expect(events(b, 'conversation_end').some((e) => (e.d as { conversationId: string }).conversationId === ab)).toBe(true);

      // The same lists, the same profile answer, the same swipe answer.
      expect((await peers(a)).ids).toEqual([]);
      expect((await peers(c)).ids).toEqual([]);
      const pa = await call(h, `/v1/profiles/${b.publicUid}`, { token: a.token });
      const pc = await call(h, `/v1/profiles/${d.publicUid}`, { token: c.token });
      const shape = (r: LightMyRequestResponse) => {
        const body = json(r);
        delete body['requestId'];
        delete body['instance'];
        return [r.statusCode, body];
      };
      expect(shape(pa)).toEqual(shape(pc));
      expect(pa.statusCode).toBe(404);
      expect((await swipe(a, b, 'like')).result).toBe((await swipe(c, d, 'like')).result);
      expect(await likers(a)).toEqual(await likers(c));
      expect(blockListSchema.parse((await call(h, '/v1/blocks', { token: a.token })).json()).items).toEqual([]);
      // The same clean-up later: the messages purge of an ended conversation.
      expect(jobs.jobs.filter((j) => j.name === 'unmatch-purge').map((j) => j.data['matchId']).sort()).toEqual([ab, cd].sort());
      expect(Number(await row<{ s: number }>(db, `SELECT state AS s FROM matches WHERE id = $1`, [ab]).then((r) => r.s))).toBe(3);
    });

    it('drops the pair from each other’s deck again after a refill that was running, and answers 503 when Valkey cannot take its side', async () => {
      const me = await viewer('Racer');
      const other = await person('Raced');
      await h.app.cache.set(h.app.keys.deckLock(me.id), 'refill', 'PX', 30_000);
      expect((await call(h, '/v1/blocks', { method: 'POST', token: me.token, body: { target: other.publicUid } })).statusCode).toBe(204);
      const redrop = jobs.jobs.find((j) => j.queue === 'safety' && j.name === 'block-deck');
      expect(redrop?.data).toEqual({ a: me.id, b: other.id });
      expect(redrop?.options.delayMs).toBeGreaterThan(30_000);
      await h.app.cache.del(h.app.keys.deckLock(me.id));

      const third = await person('Third');
      jobs.failWith = new Error('valkey down');
      try {
        await h.app.cache.set(h.app.keys.deckLock(me.id), 'refill', 'PX', 30_000);
        const failed = await call(h, '/v1/blocks', { method: 'POST', token: me.token, body: { target: third.publicUid } });
        expect(failed.statusCode).toBe(503);
        expect(failed.headers['retry-after']).toBe('2');
      } finally {
        jobs.failWith = null;
      }
      // The retry finishes it (the write is idempotent).
      expect((await call(h, '/v1/blocks', { method: 'POST', token: me.token, body: { target: third.publicUid } })).statusCode).toBe(204);
      await h.app.cache.del(h.app.keys.deckLock(me.id));
    });
  });

  // ─── Reports ──────────────────────────────────────────────────────────

  describe('reports', () => {
    it('files a report in one statement and answers 202 with its id; a second one adds to it', async () => {
      const reporter = await viewer('Reporter');
      const target = await person('Reported');
      const response = await call(h, '/v1/reports', {
        method: 'POST',
        token: reporter.token,
        body: { target: target.publicUid, context: 'profile', reason: 'fake', details: 'Stock photos.' },
      });
      expect(response.statusCode, response.body).toBe(202);
      expect(statements(response)).toBe(1);
      const { reportId } = reportReceiptSchema.strict().parse(response.json());
      const again = await call(h, '/v1/reports', { method: 'POST', token: reporter.token, body: { target: target.publicUid, context: 'profile', reason: 'scam' } });
      expect(reportReceiptSchema.parse(again.json()).reportId).toBe(reportId);
      const stored = await row<{ reason: number; items: number; reporter: string }>(
        db,
        `SELECT reason, jsonb_array_length(evidence -> 'items') AS items, reporter_id::text AS reporter FROM reports WHERE id = $1`,
        [reportId],
      );
      expect(stored).toEqual({ reason: 4, items: 2, reporter: reporter.id });
    });

    it('blocks with the report when asked, as a block does', async () => {
      const reporter = await viewer('Reports and blocks');
      const target = await person('Harasser');
      const conversation = await matchOf(reporter, target);
      const response = await call(h, '/v1/reports', {
        method: 'POST',
        token: reporter.token,
        body: { target: target.publicUid, context: 'chat', reason: 'harassment', conversationId: conversation, messageIds: ['1287390234923417600'], block: true },
      });
      expect(response.statusCode, response.body).toBe(202);
      expect(statements(response)).toBe(1);
      expect((await peers(reporter)).ids).toEqual([]);
      expect((await peers(target)).ids).toEqual([]);
      expect(events(target, 'conversation_end').map((e) => (e.d as { conversationId: string }).conversationId)).toContain(conversation);
      expect(blockListSchema.parse((await call(h, '/v1/blocks', { token: reporter.token })).json()).items.map((i) => i.user.id)).toEqual([target.publicUid]);
    });

    it('answers 404 for a photo that is not the person’s, a conversation that is not theirs, nobody and oneself; refuses an invalid body', async () => {
      const reporter = await viewer('Careful');
      const target = await person('Somebody');
      const stranger = await person('Stranger');
      const photo = await row<{ id: string }>(db, `SELECT id::text FROM photos WHERE user_id = $1 LIMIT 1`, [stranger.id]);
      const strangers = await matchOf(stranger, await viewer('Their match'));
      const post = (body: Record<string, unknown>) => call(h, '/v1/reports', { method: 'POST', token: reporter.token, body: { target: target.publicUid, reason: 'other', ...body } });
      expect((await post({ context: 'photo', photoId: photo.id })).statusCode).toBe(404);
      expect((await post({ context: 'chat', conversationId: strangers })).statusCode).toBe(404);
      expect((await post({ context: 'profile', target: h.app.publicIds.user.encode(h.app.ids.nextId()) })).statusCode).toBe(404);
      expect((await post({ context: 'profile', target: reporter.publicUid })).statusCode).toBe(404);
      expect((await post({ context: 'photo' })).statusCode).toBe(400);
      expect((await post({ context: 'profile', messageIds: ['1287390234923417600'] })).statusCode).toBe(400);
      const own = await row<{ id: string }>(db, `SELECT id::text FROM photos WHERE user_id = $1 LIMIT 1`, [target.id]);
      expect((await post({ context: 'photo', photoId: own.id })).statusCode).toBe(202);
    });

    it('takes at most ten reports a day from one person', async () => {
      const reporter = await viewer('Busy reporter');
      const codes: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        const target = await person(`R${i}`);
        codes.push((await call(h, '/v1/reports', { method: 'POST', token: reporter.token, body: { target: target.publicUid, context: 'profile', reason: 'spam' } })).statusCode);
      }
      expect(codes.slice(0, 10).every((c) => c === 202)).toBe(true);
      expect(codes[10]).toBe(429);
    });
  });

  // ─── Moderation actions ───────────────────────────────────────────────

  describe('moderation actions written by the server', () => {
    it('bans: the old tokens stop, the person hears the reason, sees it with an appeal, and their conversations end for the peer', async () => {
      const target = await person('To be banned');
      const peer = await viewer('Their peer');
      const conversation = await matchOf(peer, target);
      const result = await new ModerationActions(h.app).apply({ userId: target.id, kind: 3, reasonCode: 2, reasonText: 'Repeated harassment reports.' });
      expect(result.effects).toMatchObject({ hidden: true, revoked: true, published: 2, disconnected: true });
      expect((await call(h, '/v1/conversations', { token: target.token })).statusCode).toBe(401);
      expect(realtime.disconnected).toContain(target.publicUid);
      const account = events(target, 'account').at(-1)!;
      expect(realtimePayloads.account.parse(account.d)).toMatchObject({ status: 'banned', moderation: { kind: 'ban', reasonText: 'Repeated harassment reports.' } });
      expect(events(peer, 'conversation_end').map((e) => (e.d as { conversationId: string }).conversationId)).toContain(conversation);

      // The refreshed session is restricted (tokens issued in the second of the revocation count as before it).
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const session = await h.app.tokens.issue({ kind: 'app', subject: target.publicUid, sessionId: target.sessionId, deviceId: target.deviceId, storeCode: 2, scope: 'restricted' });
      const history = await call(h, '/v1/me/moderation', { token: session.token });
      expect(history.statusCode, history.body).toBe(200);
      const body = moderationHistorySchema.parse(history.json());
      expect(body.active.map((a) => [a.kind, a.reasonText])).toEqual([['ban', 'Repeated harassment reports.']]);
      const blocked = await call(h, '/v1/deck', { token: session.token });
      expect(blocked.statusCode).toBe(403);
      expect(json(blocked)).toMatchObject({ code: 'account_banned', reasonText: 'Repeated harassment reports.', appealable: true });
      const appeal = await call(h, '/v1/appeals', { method: 'POST', token: session.token, body: { actionId: body.active[0]!.id, body: 'It was a misunderstanding.' } });
      expect(appeal.statusCode, appeal.body).toBe(201);
      const appealId = (json(appeal)['appeal'] as { id: string }).id;

      // The appeal is overturned: the ban is lifted, the person hears it; the conversation stays ended.
      const decided = await new ModerationActions(h.app).decide(appealId, true, { text: 'We looked again.' });
      expect(decided.outcome).toMatchObject({ outcome: 'overturned', after: { status: 3 } });
      expect(realtimePayloads.account.parse(events(target, 'account').at(-1)!.d)).toMatchObject({
        status: 'active',
        moderation: { kind: 'ban', appeal: { id: appealId, status: 'overturned', decisionText: 'We looked again.' } },
      });
      expect(Number((await row<{ s: number }>(db, `SELECT state AS s FROM matches WHERE id = $1`, [conversation])).s)).toBe(4);
      expect(await profileStatus(peer, target)).toBe(404);
    });

    it('suspends with an end: queues the end, hides the person from their peers while it lasts, and they come back when it is lifted', async () => {
      const target = await person('Suspended');
      const peer = await viewer('Waiting peer');
      await matchOf(peer, target);
      expect((await peers(peer)).ids).toEqual([target.publicUid]);
      const endsAt = new Date(Date.now() + 3_600_000);
      const result = await new ModerationActions(h.app).apply({ userId: target.id, kind: 2, reasonCode: 2, reasonText: 'A week to cool down.', endsAt });
      if (result.outcome.outcome !== 'applied') throw new Error('not applied');
      const end = jobs.jobs.find((j) => j.queue === 'safety' && j.name === 'moderation-end');
      expect(end).toMatchObject({ id: `moderation-end.${result.outcome.actionId}`, data: { actionId: result.outcome.actionId, userId: target.id } });
      expect(end!.options.delayMs).toBeGreaterThan(3_500_000);
      expect((await peers(peer)).ids).toEqual([]);
      expect((await peers(peer)).ids).toEqual([]);
      expect(realtimePayloads.account.parse(events(target, 'account').at(-1)!.d)).toMatchObject({ status: 'suspended', moderation: { kind: 'suspension', endsAt: endsAt.toISOString() } });

      await new ModerationActions(h.app).revoke(result.outcome.actionId, { reasonText: 'Lifted early.' });
      expect((await peers(peer)).ids).toEqual([target.publicUid]);
      expect(await profileStatus(peer, target)).toBe(200);
    });

    it('keeps a hidden peer out of the list on the reads after its check, long after the hide', async () => {
      const target = await person('Hidden a while');
      const peer = await viewer('Reading peer');
      await matchOf(peer, target);
      await new ModerationActions(h.app).apply({ userId: target.id, kind: 4, reasonCode: 7, reasonText: 'Spam pattern.' });
      // The hide is older than any clock slack by now; the list checks the person once, then keeps the verdict.
      await h.redis.zadd(h.app.keys.accountsHidden(), Date.now() - 30_000, target.id);
      await h.app.cache.del(h.app.keys.conversationListChecked(peer.id));
      const first = await call(h, '/v1/conversations', { token: peer.token });
      expect(statements(first)).toBe(1);
      expect(conversationsPageSchema.parse(first.json()).items).toEqual([]);
      const second = await call(h, '/v1/conversations', { token: peer.token });
      expect(statements(second)).toBe(0);
      expect(conversationsPageSchema.parse(second.json()).items).toEqual([]);
    });

    it('warns without changing anything but the person’s own record', async () => {
      const target = await person('Warned');
      const result = await new ModerationActions(h.app).apply({ userId: target.id, kind: 1, reasonCode: 7, reasonText: 'Please keep it friendly.' });
      expect(result.effects).toMatchObject({ hidden: false, revoked: false, published: 1, disconnected: false });
      expect((await call(h, '/v1/conversations', { token: target.token })).statusCode).toBe(200);
      const history = moderationHistorySchema.parse((await call(h, '/v1/me/moderation', { token: target.token })).json());
      expect(history.history.map((a) => [a.kind, a.reasonText])).toEqual([['warning', 'Please keep it friendly.']]);
    });
  });
});
