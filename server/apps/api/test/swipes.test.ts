import { conversationSchema, likesPageSchema, swipesResponseSchema, type Conversation } from '@app/shared';
import { FakeRealtimePublisher } from '@app/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, json, migratedDatabase, row, rows, seedUser, startHarness, statements, type Harness, type SeededUser, type TestDatabase } from './accountSupport.js';
import { eventsOf, startPipeline, type Pipeline } from './socialSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * The swipe path end to end: the API (quotas, the like script, the match
 * fast path, the lists) with the worker's stream consumers running beside it
 * on the same database and Valkey prefix. Statement counts are the pool's
 * (`x-pg-statements`), with every route's budget enforced.
 */

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(!hasInfrastructure)('swipes, likes and conversations (PostgreSQL, Valkey)', () => {
  let db: TestDatabase;
  let h: Harness;
  let realtime: FakeRealtimePublisher;
  let jobs: MemoryJobProducer;
  let pipeline: Pipeline;

  beforeAll(async () => {
    db = await migratedDatabase();
    realtime = new FakeRealtimePublisher();
    jobs = new MemoryJobProducer();
    h = await startHarness(db, {}, { realtime, jobs });
    await h.redis.set(h.app.keys.likesReady(), '1');
    pipeline = await startPipeline(h, realtime);
  }, 90_000);

  afterAll(async () => {
    await pipeline?.stop();
    await h?.close();
    await db?.drop();
  });

  const seeded: SeededUser[] = [];

  async function person(name = 'Sam', options: Parameters<typeof seedUser>[1] = {}): Promise<SeededUser> {
    const user = await seedUser(h, { name, ...options });
    seeded.push(user);
    return user;
  }

  async function swipe(user: SeededUser, swipes: unknown[]) {
    return call(h, '/v1/swipes', { method: 'POST', token: user.token, body: { swipes } });
  }

  async function likeOf(user: SeededUser, target: SeededUser, extra: Record<string, unknown> = {}) {
    return swipe(user, [{ target: target.publicUid, action: 'like', ...extra }]);
  }

  function resultOf(response: Awaited<ReturnType<typeof swipe>>, index = 0) {
    expect(response.statusCode, response.body).toBe(200);
    const body = swipesResponseSchema.parse(response.json());
    return body.results[index]!;
  }

  /** The caller's account view and plan cached, as on any request after the first. */
  async function warm(user: SeededUser): Promise<void> {
    const response = await call(h, '/v1/conversations', { token: user.token });
    expect(response.statusCode).toBe(200);
    await swipe(user, [{ target: h.app.publicIds.user.encode(h.app.ids.nextId()), action: 'pass' }]);
  }

  async function setPlanFeature(plan: string, feature: string, value: unknown): Promise<void> {
    await h.db.sql.query(
      `UPDATE plan_features SET value = $3::jsonb FROM plans WHERE plans.id = plan_features.plan_id AND plans.key = $1 AND plan_features.feature = $2`,
      [plan, feature, JSON.stringify(value)],
    );
    const before = h.app.cfg.peek()?.version ?? 0;
    const version = await h.redis.incr(`${h.prefix}cfg:v`);
    await h.redis.publish(`${h.prefix}cfg:changed`, String(version));
    await until(() => (h.app.cfg.peek()?.version ?? before) === version, 5_000);
  }

  async function matchCount(a: SeededUser, b: SeededUser): Promise<number> {
    return Number(
      (await row<{ n: string }>(db, `SELECT count(*)::text AS n FROM matches WHERE user_lo = least($1::bigint, $2::bigint) AND user_hi = greatest($1::bigint, $2::bigint)`, [a.id, b.id])).n,
    );
  }

  describe('budgets', () => {
    it('costs no statement for a pass and none for a like, one for a match, and answers the conversation', async () => {
      const a = await person('Ava');
      const b = await person('Ben');
      await warm(a);
      await warm(b);
      const pass = await swipe(a, [{ target: h.app.publicIds.user.encode(h.app.ids.nextId()), action: 'pass' }]);
      expect(resultOf(pass).result).toBe('passed');
      expect(statements(pass)).toBe(0);

      const liked = await likeOf(a, b, { comment: 'Hi there' });
      expect(resultOf(liked).result).toBe('liked');
      expect(statements(liked)).toBe(0);

      const matched = await likeOf(b, a);
      const result = resultOf(matched);
      expect(statements(matched)).toBe(1);
      expect(result.result).toBe('matched');
      const conversation = conversationSchema.parse(result.conversation);
      expect(conversation).toMatchObject({ peer: { id: a.publicUid, name: 'Ava' }, state: 'active', source: 'like', lastMessage: null, unread: 0 });
      expect(await matchCount(a, b)).toBe(1);
      // The swipe left the deck and the seen filter; the quota counted it.
      expect(json(matched)['quotas']).toMatchObject({ likes: { limit: 25, used: 1 } });

      // The worker announces it to both, once, under the match id.
      await until(() => [a, b].every((u) => eventsOf(realtime, u.publicUid, 'conversation').some((e) => e.id === conversation.id)));
      expect(eventsOf(realtime, a.publicUid, 'conversation').filter((e) => e.id === conversation.id)).toHaveLength(1);
      expect(eventsOf(realtime, b.publicUid, 'conversation').filter((e) => e.id === conversation.id)).toHaveLength(1);
    });

    it('lists conversations from Valkey with no statement, rebuilds a lost list in one, and answers 304 for its version', async () => {
      const a = await person('Cleo');
      const b = await person('Dan');
      await warm(a);
      await warm(b);
      await likeOf(a, b);
      const m = resultOf(await likeOf(b, a));
      const id = m.conversation!.id;

      const first = await call(h, '/v1/conversations', { token: a.token });
      expect(first.statusCode).toBe(200);
      const etag = String(first.headers['etag']);
      const items = (json(first)['items'] as Conversation[]).map((c) => c.id);
      expect(items).toContain(id);
      // Peer summaries were read once; now everything is warm.
      const warmList = await call(h, '/v1/conversations', { token: a.token });
      expect(statements(warmList)).toBe(0);
      const cached = await call(h, '/v1/conversations', { token: a.token, headers: { 'if-none-match': etag } });
      expect(cached.statusCode).toBe(304);
      expect(statements(cached)).toBe(0);

      // Valkey lost the list: rebuilt in one statement (visibility and peer cards included).
      await h.redis.del(h.app.keys.conversationList(a.id));
      const rebuilt = await call(h, '/v1/conversations', { token: a.token });
      expect(statements(rebuilt)).toBe(1);
      expect((json(rebuilt)['items'] as Conversation[]).find((c) => c.id === id)).toMatchObject({ peer: { id: b.publicUid, name: 'Dan' }, lastMessage: null });
      const again = await call(h, '/v1/conversations', { token: a.token });
      expect(statements(again)).toBe(0);
    });

    it('unmatches in one statement: out of both lists, conversation_end to both, the purge queued', async () => {
      const a = await person('Eve');
      const b = await person('Finn');
      const c = await person('Gus');
      await likeOf(a, b);
      const id = resultOf(await likeOf(b, a)).conversation!.id;
      await warm(a);
      const versionBefore = (await call(h, '/v1/conversations', { token: b.token })).headers['etag'];

      const outsider = await call(h, `/v1/conversations/${id}`, { method: 'DELETE', token: c.token });
      expect(outsider.statusCode).toBe(404);
      const gone = await call(h, `/v1/conversations/${id}`, { method: 'DELETE', token: a.token });
      expect(gone.statusCode).toBe(204);
      expect(statements(gone)).toBe(1);
      expect((await row<{ state: number }>(db, `SELECT state FROM matches WHERE id = $1`, [id])).state).toBe(2);
      expect((await call(h, `/v1/conversations/${id}`, { method: 'DELETE', token: b.token })).statusCode).toBe(404);
      for (const u of [a, b]) {
        expect(eventsOf(realtime, u.publicUid, 'conversation_end').map((e) => (e.d as { conversationId: string }).conversationId)).toContain(id);
        const list = await call(h, '/v1/conversations', { token: u.token });
        expect((json(list)['items'] as Conversation[]).map((x) => x.id)).not.toContain(id);
      }
      expect((await call(h, '/v1/conversations', { token: b.token })).headers['etag']).not.toBe(versionBefore);
      const purge = jobs.jobs.find((j) => j.queue === 'account' && j.name === 'unmatch-purge' && j.data['matchId'] === id);
      expect(purge?.options.delayMs).toBe(7 * 86_400_000);
    });

    it('opens a profile in one statement, and answers 404 for a blocked, gone or unknown person', async () => {
      const a = await person('Hana');
      const b = await person('Ivo');
      const c = await person('Jon');
      await warm(a);
      const open = await call(h, `/v1/profiles/${b.publicUid}`, { token: a.token });
      expect(open.statusCode).toBe(200);
      expect(statements(open)).toBe(1);
      expect(json(open)).toMatchObject({ id: b.publicUid, name: 'Ivo', gender: 'man' });
      expect(JSON.stringify(json(open))).not.toContain(b.id);
      const [lo, hi] = BigInt(a.id) < BigInt(c.id) ? [a.id, c.id] : [c.id, a.id];
      await db.sql.query(`INSERT INTO blocks (user_lo, user_hi, blocked_by) VALUES ($1, $2, 1)`, [lo, hi]);
      expect((await call(h, `/v1/profiles/${c.publicUid}`, { token: a.token })).statusCode).toBe(404);
      await db.sql.query(`UPDATE users SET status = 6 WHERE id = $1`, [b.id]);
      expect((await call(h, `/v1/profiles/${b.publicUid}`, { token: a.token })).statusCode).toBe(404);
      expect((await call(h, `/v1/profiles/aaaaaaaaaaaaa`, { token: a.token })).statusCode).toBe(404);
    });
  });

  describe('mutual likes at the same moment', () => {
    it('gives exactly 100 matches for 200 parallel mutual likes over 100 pairs, and one conversation event per person per match', async () => {
      const people = await Promise.all(Array.from({ length: 200 }, (_, i) => person(`P${i}`)));
      const pairs = Array.from({ length: 100 }, (_, i) => [people[2 * i]!, people[2 * i + 1]!] as const);
      const announcedBefore = pipeline.matches.announced;
      const responses = await Promise.all(pairs.flatMap(([a, b]) => [likeOf(a, b), likeOf(b, a)]));
      const results = responses.map((r) => resultOf(r));
      expect(results.filter((r) => r.result === 'matched')).toHaveLength(100);
      expect(results.filter((r) => r.result === 'liked')).toHaveLength(100);
      const matchIds = new Set(results.filter((r) => r.result === 'matched').map((r) => r.conversation!.id));
      expect(matchIds.size).toBe(100);
      for (const [a, b] of pairs) expect(await matchCount(a, b)).toBe(1);

      await until(() => pipeline.matches.announced - announcedBefore >= 100, 30_000);
      for (const p of people) {
        const events = eventsOf(realtime, p.publicUid, 'conversation');
        expect(events, p.publicUid).toHaveLength(1);
        expect(matchIds.has(events[0]!.id)).toBe(true);
        expect(events[0]!.d).toMatchObject({ reason: 'matched' });
      }
      // And a match push for each person.
      await until(async () => {
        const n = await h.redis.eval(`return #redis.call('KEYS', ARGV[1])`, 0, `${h.prefix}bull:push:send.match.*`);
        return Number(n) >= 200;
      });
    }, 60_000);
  });

  describe('quotas', () => {
    it('stops free likes at the plan value with quota and when they come back', async () => {
      await setPlanFeature('free', 'daily_likes', 3);
      try {
        const a = await person('Kit');
        const targets = Array.from({ length: 4 }, () => h.app.publicIds.user.encode(h.app.ids.nextId()));
        const response = await swipe(a, targets.map((target) => ({ target, action: 'like' })));
        const body = swipesResponseSchema.parse(response.json());
        expect(body.results.map((r) => r.result)).toEqual(['liked', 'liked', 'liked', 'quota']);
        const tomorrow = new Date(Math.floor(Date.now() / 86_400_000 + 1) * 86_400_000).toISOString();
        expect(body.quotas.likes).toEqual({ limit: 3, used: 3, resetsAt: tomorrow });
        // A test account is outside quotas.
        const tester = await person('Lex');
        await db.sql.query(`UPDATE users SET flags = 1 WHERE id = $1`, [tester.id]);
        await h.redis.del(h.app.keys.meVersion(tester.id));
        const free = swipesResponseSchema.parse((await swipe(tester, targets.map((target) => ({ target, action: 'like' })))).json());
        expect(free.results.every((r) => r.result === 'liked')).toBe(true);
        expect(free.quotas.likes?.limit).toBe(-1);
      } finally {
        await setPlanFeature('free', 'daily_likes', 25);
      }
    });

    it('takes super likes from the weekly quota, then from the wallet in one transaction, then answers quota', async () => {
      const a = await person('Mia');
      const targets = Array.from({ length: 4 }, () => h.app.publicIds.user.encode(h.app.ids.nextId()));
      await warm(a);
      const first = await swipe(a, [{ target: targets[0], action: 'superlike' }]);
      expect(resultOf(first).result).toBe('liked');
      expect(statements(first)).toBe(0);
      // The weekly one is spent and the wallet is empty: one statement found nothing to spend.
      const empty = await swipe(a, [{ target: targets[1], action: 'superlike' }]);
      expect(resultOf(empty).result).toBe('quota');
      expect(statements(empty)).toBe(1);
      expect(json(empty)['quotas']).toMatchObject({ superlikes: { limit: 1, used: 1 } });

      await db.sql.query(`INSERT INTO wallet_balances (user_id, item, store, balance) VALUES ($1, 1, 2, 2)`, [a.id]);
      const paid = await swipe(a, [{ target: targets[2], action: 'superlike', comment: 'Wow' }]);
      expect(resultOf(paid).result).toBe('liked');
      expect(statements(paid)).toBe(3);
      const target2 = h.app.publicIds.user.decodeId(targets[2]!)!;
      // The like row is durable at once, with its ledger row; the stream's copy inserts nothing later.
      const like = await row<{ id: string; kind: number; comment: string }>(db, `SELECT id::text, kind, comment FROM likes WHERE target_id = $1 AND actor_id = $2`, [target2, a.id]);
      expect(like).toMatchObject({ kind: 2, comment: 'Wow' });
      expect(await rows(db, `SELECT delta, balance_after, reason, store FROM wallet_ledger WHERE user_id = $1 AND ref_id = $2`, [a.id, like.id])).toEqual([
        { delta: -1, balance_after: 1, reason: 2, store: 2 },
      ]);
      await until(async () => Number((await row<{ n: string }>(db, `SELECT count(*)::text AS n FROM likes WHERE actor_id = $1 AND target_id = $2`, [a.id, target2])).n) === 1);
      // A super like already pending is not charged again.
      const repeat = await swipe(a, [{ target: targets[2], action: 'superlike' }]);
      expect(resultOf(repeat).result).toBe('duplicate');
      expect((await row<{ balance: number }>(db, `SELECT balance FROM wallet_balances WHERE user_id = $1`, [a.id])).balance).toBe(1);
    });

    it('refuses a whole request past the hourly cap, and a refused comment before anything happens', async () => {
      const a = await person('Nia');
      const passes = Array.from({ length: 20 }, () => ({ target: h.app.publicIds.user.encode(h.app.ids.nextId()), action: 'pass' }));
      for (let i = 0; i < 30; i += 1) expect((await swipe(a, passes)).statusCode).toBe(200);
      const over = await swipe(a, passes.slice(0, 1));
      expect(over.statusCode).toBe(429);
      expect(json(over)).toMatchObject({ code: 'rate_limited' });
      expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);

      const b = await person('Oli');
      await db.sql.query(`INSERT INTO banned_terms (term, match_kind, severity, scope) VALUES ('scamlink', 1, 3, 8)`);
      const version = await h.redis.incr(`${h.prefix}cfg:v`);
      await h.redis.publish(`${h.prefix}cfg:changed`, String(version));
      await until(() => h.app.cfg.peek()?.version === version, 5_000);
      const refused = await swipe(b, [
        { target: h.app.publicIds.user.encode(h.app.ids.nextId()), action: 'like' },
        { target: h.app.publicIds.user.encode(h.app.ids.nextId()), action: 'like', comment: 'visit scamlink now' },
      ]);
      expect(refused.statusCode).toBe(422);
      expect(json(refused)).toMatchObject({ code: 'text_refused' });
      expect(await h.redis.get(h.app.keys.quota('likes', b.id, new Date().toISOString().slice(0, 10).replaceAll('-', '')))).toBeNull();
    });

    it('lets only active accounts swipe', async () => {
      const snoozed = await person('Pia', { status: 4 });
      const onboarding = await seedUser(h, { status: 1 });
      const target = h.app.publicIds.user.encode(h.app.ids.nextId());
      expect(json(await swipe(snoozed, [{ target, action: 'like' }]))).toMatchObject({ code: 'snoozed' });
      expect(json(await swipe(onboarding, [{ target, action: 'like' }]))).toMatchObject({ code: 'onboarding_incomplete' });
      expect(json(await call(h, '/v1/likes', { token: snoozed.token }))).toMatchObject({ code: 'snoozed' });
    });
  });

  describe('who liked me', () => {
    async function photo(user: SeededUser, blurhash: string): Promise<void> {
      await db.sql.query(`INSERT INTO photos (id, user_id, position, status, width, height, blurhash, blob_ver) VALUES ($1, $2, 0, 3, 1080, 1350, $3, 1)`, [
        h.app.ids.nextId(),
        user.id,
        blurhash,
      ]);
    }

    it('shows a free plan blurhashes, super likes and the day\'s one open like, in one statement; see-likes the cards and comments in two', async () => {
      const me = await person('Quinn');
      const plain = await person('Ray');
      const open = await person('Sia');
      const superLiker = await person('Tom');
      const hidden = await person('Uma');
      await photo(plain, 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH');
      await photo(open, 'L6PZfSi_.AyE_3t7t7R**0o#DgR4');
      await likeOf(plain, me, { comment: 'Hello Quinn' });
      await likeOf(open, me);
      await swipe(superLiker, [{ target: me.publicUid, action: 'superlike', item: { kind: 'prompt', ref: '3' }, comment: 'Great answer' }]);
      await likeOf(hidden, me);
      await db.sql.query(`UPDATE users SET status = 6 WHERE id = $1`, [hidden.id]);
      // The like event reached me, with the super liker named.
      const likeEvents = eventsOf(realtime, me.publicUid, 'like');
      expect(likeEvents.map((e) => (e.d as { kind: string }).kind)).toEqual(['like', 'like', 'superlike', 'like']);
      expect((likeEvents[2]!.d as { from?: { name: string } }).from?.name).toBe('Tom');
      expect((likeEvents[0]!.d as { from?: unknown }).from).toBeUndefined();
      expect(jobs.jobs.filter((j) => j.queue === 'push' && j.data['userId'] === me.id)).toHaveLength(1);
      await warm(me);

      const page = await call(h, '/v1/likes', { token: me.token });
      expect(page.statusCode).toBe(200);
      expect(statements(page)).toBe(1);
      const body = likesPageSchema.parse(page.json());
      expect(body.total).toBe(4);
      expect(body.items).toHaveLength(3);
      // Super likes first, with the card.
      expect(body.items[0]).toMatchObject({ kind: 'superlike', liker: { id: superLiker.publicUid, superliked: true, likesYou: true } });
      expect(body.items[0]!.comment).toBeUndefined();
      const opened = body.items.filter((i) => i.kind === 'like' && i.liker);
      const blurred = body.items.filter((i) => i.kind === 'like' && !i.liker);
      expect(opened).toHaveLength(1);
      expect(blurred).toHaveLength(1);
      expect(blurred[0]!.blurhash).toMatch(/^L/);
      // The reveal stays the same for the day.
      const again = likesPageSchema.parse((await call(h, '/v1/likes', { token: me.token })).json());
      expect(again.items.find((i) => i.kind === 'like' && i.liker)?.liker?.id).toBe(opened[0]!.liker!.id);

      // see-likes (a plus subscription in this store): every card, the liked item and the comment.
      await db.sql.query(`INSERT INTO subscriptions (user_id, started_at, expires_at, plan_id, store, status) VALUES ($1, now(), now() + interval '30 days', 2, 0, 4)`, [me.id]);
      await h.app.cache.del(h.app.keys.entitlements(me.id, 2));
      await until(async () => Number((await row<{ n: string }>(db, `SELECT count(*)::text AS n FROM likes WHERE target_id = $1`, [me.id])).n) === 4);
      await call(h, '/v1/likes', { token: me.token });
      const paid = await call(h, '/v1/likes', { token: me.token });
      expect(statements(paid)).toBe(2);
      const full = likesPageSchema.parse(paid.json());
      expect(full.items.every((i) => i.liker)).toBe(true);
      expect(full.items[0]).toMatchObject({ kind: 'superlike', item: { kind: 'prompt', ref: '3' }, comment: 'Great answer' });
      expect(full.items.find((i) => i.liker?.id === plain.publicUid)).toMatchObject({ comment: 'Hello Quinn', liker: { likesYou: true } });
      // Pages of one follow each other to the end, each liker once.
      const walked: string[] = [];
      let cursor: string | null = null;
      do {
        const pageOfOne = likesPageSchema.parse((await call(h, `/v1/likes?limit=1${cursor ? `&cursor=${cursor}` : ''}`, { token: me.token })).json());
        walked.push(...pageOfOne.items.map((i) => i.liker!.id));
        cursor = pageOfOne.nextCursor;
      } while (cursor);
      expect(walked).toEqual(full.items.map((i) => i.liker!.id));
      expect((await call(h, '/v1/likes?cursor=bad!', { token: me.token })).statusCode).toBe(400);

      // A pass on a liker takes them off the list; a like back is a match.
      await swipe(me, [{ target: plain.publicUid, action: 'pass' }]);
      expect(likesPageSchema.parse((await call(h, '/v1/likes', { token: me.token })).json()).total).toBe(3);
      expect(resultOf(await likeOf(me, open)).result).toBe('matched');
      const after = likesPageSchema.parse((await call(h, '/v1/likes', { token: me.token })).json());
      expect(after.items.map((i) => i.liker?.id)).toEqual([superLiker.publicUid]);
    });
  });

  describe('a Valkey loss in the middle', () => {
    it('falls back to the PostgreSQL look-up until lk:ready is back, losing and duplicating no match', async () => {
      const [a1, b1, a2, b2, a3, b3] = await Promise.all(['A1', 'B1', 'A2', 'B2', 'A3', 'B3'].map((n) => person(n)));
      await likeOf(a1!, b1!);
      await likeOf(a3!, b3!);
      // Both likes are durable before the loss.
      await until(async () => Number((await row<{ n: string }>(db, `SELECT count(*)::text AS n FROM likes WHERE actor_id = ANY ($1::bigint[])`, [[a1!.id, a3!.id]])).n) === 2);
      // The loss: every key of this deployment (the suite shares a server with others, so not FLUSHALL here; the FLUSHALL suite runs on a server of its own).
      const keys = await h.redis.keys(`${h.prefix}*`);
      await h.redis.del(...keys);
      expect(await h.redis.exists(h.app.keys.likesReady())).toBe(0);

      // The like back finds the earlier one in PostgreSQL: a check, then the match.
      const back = await likeOf(b1!, a1!);
      expect(resultOf(back).result).toBe('matched');
      // The account view and the plan were lost too (1 each), the look-up (1), the INSERT (1).
      expect(statements(back)).toBe(4);
      // Two people who like each other after the loss: the second finds the first in the bucket.
      expect(resultOf(await likeOf(a2!, b2!)).result).toBe('liked');
      expect(resultOf(await likeOf(b2!, a2!)).result).toBe('matched');
      for (const [x, y] of [
        [a1!, b1!],
        [a2!, b2!],
      ] as const) {
        expect(await matchCount(x, y)).toBe(1);
      }
    });
  });

  it('never sends a raw user id in any answer of this suite', () => {
    expect(seeded.length).toBeGreaterThan(200);
    const bodies = h.bodies.join('\n');
    for (const user of seeded) expect(bodies.includes(user.id), user.publicUid).toBe(false);
    const published = JSON.stringify(realtime.published);
    for (const user of seeded) expect(published.includes(user.id), user.publicUid).toBe(false);
  });
});
