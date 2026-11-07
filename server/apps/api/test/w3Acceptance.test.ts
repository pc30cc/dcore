import {
  blockListSchema,
  conversationsPageSchema,
  deckPageSchema,
  likesPageSchema,
  swipesResponseSchema,
  type ProfileCard,
} from '@app/shared';
import { CdnUrlSigner, FakeObjectStorage, FakeRealtimePublisher, cellCentre, homeCell, readDeck, type MediaStore } from '@app/shared/server';
import { deckQueue } from '@app/worker';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import {
  call,
  migratedDatabase,
  row,
  rows,
  seedUser,
  setAppConfig,
  startHarness,
  statements,
  type Harness,
  type SeededUser,
  type TestDatabase,
} from './accountSupport.js';
import { eventsOf, startPipeline, type Pipeline } from './socialSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * W3 across its tracks, on one API with the worker's halves beside it (the
 * `wb:like` writer, the `wb:match` consumer and the deck queue's processor)
 * on the same database and Valkey prefix: the deck the worker's refill
 * builds is what `GET /v1/deck` serves, the like script's buckets are what
 * the refill injects, the swipe route's seen filter and deck drops are what
 * the next refill honours, a match made by the swipe route is out of the
 * next deck and out of the likes, and a block takes the person out of both.
 * The statement counts are the pool's (`x-pg-statements`, budgets enforced).
 */

const CDN_KEY = 'w3-acceptance-cdn-signing-key-0123456';
const CELL = homeCell({ lat: 41.03, lng: 28.98 });
const NEAR = homeCell({ lat: 41.05, lng: 29.02 });
/** About 350 km away, in the same country: outside the default 50 km. */
const FAR = homeCell({ lat: 39.93, lng: 32.86 });

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type Person = SeededUser & { name: string };
type RefillJob = Parameters<ReturnType<typeof deckQueue>['process']>[0];

interface PersonOptions {
  gender?: number;
  interestedIn?: number;
  cell?: string;
  incognito?: boolean;
  testAccount?: boolean;
}

describe.skipIf(!hasInfrastructure)('W3 acceptance (PostgreSQL, Valkey, the worker beside the API)', () => {
  let db: TestDatabase;
  let h: Harness;
  let pipeline: Pipeline;
  const realtime = new FakeRealtimePublisher();
  const jobs = new MemoryJobProducer();
  const media: MediaStore = {
    storage: new FakeObjectStorage(),
    privateBucket: 'uploads',
    mediaBucket: 'media',
    urls: new CdnUrlSigner({ baseUrl: 'https://cdn.test.invalid', signingKey: CDN_KEY, scheme: 'hmac' }),
  };
  const rawIds: string[] = [];

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startHarness(db, {}, { realtime, jobs, media });
    await h.redis.set(h.app.keys.likesReady(), '1');
    pipeline = await startPipeline(h, realtime);
  }, 90_000);
  afterAll(async () => {
    const bodies = h?.bodies.join('\n') ?? '';
    const published = JSON.stringify(realtime.published);
    for (const id of rawIds) {
      expect(bodies.includes(`"${id}"`), `raw id ${id} in a response`).toBe(false);
      expect(published.includes(`"${id}"`), `raw id ${id} in an event`).toBe(false);
    }
    await pipeline?.stop();
    await h?.close();
    await db?.drop();
  });
  beforeEach(() => {
    jobs.jobs.length = 0;
  });

  /** An active person in discovery: basics, a profile, preferences, a location and two approved photos. */
  async function person(name: string, options: PersonOptions = {}): Promise<Person> {
    const user = await seedUser(h, { name, gender: options.gender ?? 1, interestedIn: options.interestedIn ?? 4, country: 'TR' });
    rawIds.push(user.id);
    if (options.testAccount) await db.sql.query(`UPDATE users SET flags = flags | 1 WHERE id = $1`, [user.id]);
    await db.sql.query(`UPDATE profiles SET text_state = 2, about = 'Hello', incognito = $2 WHERE user_id = $1`, [user.id, options.incognito ?? false]);
    const cell = options.cell ?? NEAR;
    const centre = cellCentre(cell);
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
    return { ...user, name };
  }

  /** A man looking for women, a few kilometres from the women of {@link person}. */
  async function viewer(name: string): Promise<Person> {
    return person(name, { gender: 2, interestedIn: 2, cell: CELL });
  }

  async function swipe(user: SeededUser, swipes: unknown[]) {
    return call(h, '/v1/swipes', { method: 'POST', token: user.token, body: { swipes } });
  }

  /** The account view and the session's plan cached, as on every request after a person's first in an hour. */
  async function warm(user: SeededUser): Promise<void> {
    expect((await call(h, '/v1/conversations', { token: user.token })).statusCode).toBe(200);
    expect(resultOf(await swipe(user, [{ target: h.app.publicIds.user.encode(h.app.ids.nextId()), action: 'pass' }])).result).toBe('passed');
  }

  function resultOf(response: LightMyRequestResponse, index = 0) {
    expect(response.statusCode, response.body).toBe(200);
    return swipesResponseSchema.parse(response.json()).results[index]!;
  }

  async function deck(user: SeededUser, limit = 30): Promise<{ response: LightMyRequestResponse; cards: ProfileCard[] }> {
    const response = await call(h, `/v1/deck?limit=${limit}`, { token: user.token });
    expect(response.statusCode, response.body).toBe(200);
    return { response, cards: deckPageSchema.parse(response.json()).cards };
  }

  /** Runs the refill jobs the API queued for this person through the worker's deck queue, as the worker would. */
  async function runQueuedRefill(user: SeededUser): Promise<unknown> {
    const queued = jobs.jobs.filter((j) => j.queue === 'deck' && j.name === 'refill' && j.data['userId'] === user.id);
    expect(queued, 'a refill was queued').toHaveLength(1);
    jobs.jobs.splice(jobs.jobs.indexOf(queued[0]!), 1);
    return refill(queued[0]!.data);
  }

  async function refill(data: Record<string, unknown>): Promise<unknown> {
    const job = { name: 'refill', id: 'refill.test', data, opts: {}, attemptsMade: 0, timestamp: Date.now() } as unknown as RefillJob;
    return deckQueue().process(job, pipeline.context);
  }

  /** The deck queue as it expired (3 h): the next refill builds it from nothing. */
  async function expireDeck(user: SeededUser): Promise<void> {
    await h.app.cache.del(h.app.keys.deckQueue(user.id), h.app.keys.deckMeta(user.id));
  }

  async function queueOf(user: SeededUser): Promise<string[]> {
    return (await readDeck(h.app.cache, h.app.keys, user.id)).ids;
  }

  function ids(people: readonly Person[]): string[] {
    return people.map((p) => p.publicUid).sort();
  }

  async function likesDurable(actor: SeededUser, target: SeededUser): Promise<number> {
    return Number((await row<{ n: string }>(db, `SELECT count(*)::text AS n FROM likes WHERE actor_id = $1 AND target_id = $2`, [actor.id, target.id])).n);
  }

  async function matchesOf(a: SeededUser, b: SeededUser): Promise<{ id: string; state: number }[]> {
    return rows(
      db,
      `SELECT id::text, state FROM matches WHERE user_lo = least($1::bigint, $2::bigint) AND user_hi = greatest($1::bigint, $2::bigint)`,
      [a.id, b.id],
    );
  }

  it('serves the worker\'s deck from Valkey, honours swipes, likes, matches and blocks in the next refill, at the budgets of criterion 1', async () => {
    const v = await viewer('Vince');
    const [w1, w2, w3, w4, w5, w6] = await Promise.all(['Wren', 'Willa', 'Wanda', 'Wendy', 'Wilma', 'Winnie'].map((n) => person(n)));
    const likerIncognito = await person('Iris', { incognito: true });
    const quietIncognito = await person('Ivy', { incognito: true });
    const far = await person('Fay', { cell: FAR });
    const notForMen = await person('Nell', { interestedIn: 2 });
    const tester = await person('Tess', { testAccount: true });
    const otherMan = await viewer('Uri');
    const budgets: Record<string, number> = {};

    // A first deck request: no queue yet, so a refill is asked for (the account view is read once).
    const first = await deck(v);
    expect(first.cards).toEqual([]);
    expect(deckPageSchema.parse(first.response.json())).toMatchObject({ remaining: 0, exhausted: false });

    // Before the worker runs: a super like, a like, and a like from someone in incognito, all through the API.
    for (const liker of [v, w1!, w2!, likerIncognito]) await warm(liker);
    const superLike = await swipe(w1!, [{ target: v.publicUid, action: 'superlike' }]);
    expect(resultOf(superLike).result).toBe('liked');
    budgets['super like (weekly quota)'] = statements(superLike);
    const like = await swipe(w2!, [{ target: v.publicUid, action: 'like' }]);
    expect(resultOf(like).result).toBe('liked');
    budgets['like'] = statements(like);
    expect(resultOf(await swipe(likerIncognito, [{ target: v.publicUid, action: 'like' }])).result).toBe('liked');

    // The worker's refill, from the job the API queued.
    expect(await runQueuedRefill(v)).toMatchObject({ outcome: 'refilled', lkReady: true });
    const built = await deck(v);
    budgets['GET /v1/deck, warm'] = statements(built.response);
    // Everyone near who may see him and whom he may see; nobody far, nobody not looking for men, no test account,
    // and of the two in incognito only the one who liked him.
    expect(built.cards.map((c) => c.id).sort()).toEqual(ids([w1!, w2!, w3!, w4!, w5!, w6!, likerIncognito]));
    for (const hidden of [far, notForMen, tester, quietIncognito]) expect(built.cards.map((c) => c.id)).not.toContain(hidden.publicUid);
    // The super liker comes first and says so; a plain like is not revealed on a free plan.
    expect(built.cards[0]).toMatchObject({ id: w1!.publicUid, superliked: true, likesYou: true });
    expect(built.cards.find((c) => c.id === w2!.publicUid)?.likesYou).toBeUndefined();
    for (const card of built.cards) expect(card.photos.length).toBe(2);

    // Swipes from the deck: a pass, a like, and the like back that makes a match.
    const pass = await swipe(v, [{ target: w3!.publicUid, action: 'pass' }]);
    expect(resultOf(pass).result).toBe('passed');
    budgets['pass'] = statements(pass);
    const likeFromDeck = await swipe(v, [{ target: w4!.publicUid, action: 'like', comment: 'Hi Wendy' }]);
    expect(resultOf(likeFromDeck).result).toBe('liked');
    budgets['like from the deck'] = statements(likeFromDeck);
    const back = await swipe(v, [{ target: w1!.publicUid, action: 'like' }]);
    const matched = resultOf(back);
    expect(matched.result).toBe('matched');
    budgets['match'] = statements(back);
    const conversationId = matched.conversation!.id;

    // The swiped people left the queue at once.
    const after = await deck(v);
    expect(after.cards.map((c) => c.id).sort()).toEqual(ids([w2!, w5!, w6!, likerIncognito]));
    expect(statements(after.response)).toBe(0);

    // The worker announces the match to both, once each, under the match id, and writes the likes.
    await until(() => [v, w1!].every((p) => eventsOf(realtime, p.publicUid, 'conversation').some((e) => e.id === conversationId)));
    for (const p of [v, w1!]) expect(eventsOf(realtime, p.publicUid, 'conversation').filter((e) => e.id === conversationId)).toHaveLength(1);
    await until(async () => (await likesDurable(v, w4!)) === 1 && (await likesDurable(w2!, v)) === 1 && (await likesDurable(w1!, v)) === 1);
    expect(await matchesOf(v, w1!)).toEqual([{ id: conversationId, state: 1 }]);

    // Who liked him: the matched super liker is gone; two likes wait (free plan: blurred but the day's one open like).
    const likes = await call(h, '/v1/likes', { token: v.token });
    expect(likes.statusCode).toBe(200);
    budgets['GET /v1/likes'] = statements(likes);
    const likesPage = likesPageSchema.parse(likes.json());
    expect(likesPage.total).toBe(2);
    expect(likesPage.items).toHaveLength(2);
    expect(likesPage.items.flatMap((i) => (i.liker ? [i.liker.id] : []))).not.toContain(w1!.publicUid);

    // The conversation list knows the match; read again, it costs nothing.
    const list = await call(h, '/v1/conversations', { token: v.token });
    expect(conversationsPageSchema.parse(list.json()).items.map((c) => c.id)).toEqual([conversationId]);
    const listAgain = await call(h, '/v1/conversations', { token: v.token });
    expect(listAgain.statusCode).toBe(200);
    budgets['GET /v1/conversations, warm'] = statements(listAgain);

    // The next deck from nothing: the match stays out (matches row), the pass and the like stay out (seen filter),
    // the likers waiting and the people not swiped come back.
    await expireDeck(v);
    expect(await refill({ userId: v.id, store: 2 })).toMatchObject({ outcome: 'refilled' });
    expect((await queueOf(v)).map((id) => h.app.publicIds.user.encode(id)).sort()).toEqual(ids([w2!, w5!, w6!, likerIncognito]));

    // A block from the deck: one statement, out of this queue now and out of the next one.
    const block = await call(h, '/v1/blocks', { method: 'POST', token: v.token, body: { target: w5!.publicUid } });
    expect(block.statusCode, block.body).toBe(204);
    budgets['block'] = statements(block);
    expect((await deck(v)).cards.map((c) => c.id).sort()).toEqual(ids([w2!, w6!, likerIncognito]));
    await expireDeck(v);
    expect(await refill({ userId: v.id, store: 2 })).toMatchObject({ outcome: 'refilled' });
    expect((await queueOf(v)).map((id) => h.app.publicIds.user.encode(id)).sort()).toEqual(ids([w2!, w6!, likerIncognito]));
    const blocks = blockListSchema.parse((await call(h, '/v1/blocks', { token: v.token })).json());
    expect(blocks.items.map((b) => b.user.id)).toEqual([w5!.publicUid]);
    // And the person blocked no longer gets him in her own deck either: only the other man near her.
    jobs.jobs.length = 0;
    await deck(w5!);
    expect(await runQueuedRefill(w5!)).toMatchObject({ outcome: 'refilled' });
    expect((await deck(w5!)).cards.map((c) => c.id)).toEqual([otherMan.publicUid]);

    // Criterion 1, as measured on this one app.
    expect(budgets).toEqual({
      'super like (weekly quota)': 0,
      like: 0,
      'GET /v1/deck, warm': 0,
      pass: 0,
      'like from the deck': 0,
      match: 1,
      'GET /v1/likes': 1,
      'GET /v1/conversations, warm': 0,
      block: 1,
    });
  }, 60_000);

  it('answers a like sent again after it made the match (an outbox resend) with no second effect', async () => {
    const a = await viewer('Abe');
    const b = await person('Bea');
    expect(resultOf(await swipe(b, [{ target: a.publicUid, action: 'like' }])).result).toBe('liked');
    const firstBack = resultOf(await swipe(a, [{ target: b.publicUid, action: 'like' }]));
    expect(firstBack.result).toBe('matched');
    await until(() => eventsOf(realtime, b.publicUid, 'conversation').length === 1);
    const likeEvents = () => [a, b].map((p) => eventsOf(realtime, p.publicUid, 'like').length);
    const likePushes = () => [a, b].map((p) => jobs.jobs.filter((j) => j.queue === 'push' && j.data['userId'] === p.id).length);
    const eventsBefore = likeEvents();
    const pushesBefore = likePushes();
    // B's like told A; A's like back made the match and told nobody about a like.
    expect(eventsBefore).toEqual([1, 0]);

    // Both people send their like again, as an outbox does when the first answer was lost.
    const again = await swipe(a, [{ target: b.publicUid, action: 'like' }]);
    expect(['duplicate', 'skipped']).toContain(resultOf(again).result);
    const againB = await swipe(b, [{ target: a.publicUid, action: 'like' }]);
    expect(['duplicate', 'skipped']).toContain(resultOf(againB).result);

    // Nobody is told about a new like, nothing waits in a bucket, and no further like row is written.
    expect(likeEvents()).toEqual(eventsBefore);
    expect(likePushes()).toEqual(pushesBefore);
    for (const p of [a, b]) expect(likesPageSchema.parse((await call(h, '/v1/likes', { token: p.token })).json()).total).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await likesDurable(a, b)) + (await likesDurable(b, a))).toBe(2);
    expect(await matchesOf(a, b)).toHaveLength(1);
  });

  it('stops a popular person\'s bucket at likes.bucket_cap, and still finds their likes back: in PostgreSQL (check) or in the bucket', async () => {
    await setAppConfig(h, 'likes.bucket_cap', 2);
    try {
      const popular = await viewer('Pat');
      const fans = await Promise.all(['Fia', 'Flo', 'Fern'].map((n) => person(n)));
      for (const fan of fans) expect(resultOf(await swipe(fan, [{ target: popular.publicUid, action: 'like' }])).result).toBe('liked');
      await warm(popular);
      const page = likesPageSchema.parse((await call(h, '/v1/likes', { token: popular.token })).json());
      // Two in the bucket, which is full: the third like is only in the stream and PostgreSQL.
      expect(page).toMatchObject({ total: 2, totalPlus: true });
      await until(async () => (await likesDurable(fans[2]!, popular)) === 1);

      const fromDatabase = await swipe(popular, [{ target: fans[2]!.publicUid, action: 'like' }]);
      expect(resultOf(fromDatabase).result).toBe('matched');
      // The look-up of the mutual like and the INSERT.
      expect(statements(fromDatabase)).toBe(2);
      const fromBucket = await swipe(popular, [{ target: fans[0]!.publicUid, action: 'like' }]);
      expect(resultOf(fromBucket).result).toBe('matched');
      // Found in the bucket: the INSERT only.
      expect(statements(fromBucket)).toBe(1);
      for (const fan of [fans[0]!, fans[2]!]) expect(await matchesOf(popular, fan)).toHaveLength(1);
      expect(await matchesOf(popular, fans[1]!)).toHaveLength(0);
    } finally {
      await setAppConfig(h, 'likes.bucket_cap', 3000);
    }
  });

  it('leaves exactly one match when the API fails right after the like script answered match', async () => {
    const a = await viewer('Cal');
    const b = await person('Cora');
    expect(resultOf(await swipe(b, [{ target: a.publicUid, action: 'like', comment: 'Hello Cal' }])).result).toBe('liked');
    await call(h, '/v1/conversations', { token: a.token });

    // PostgreSQL goes away for the API between the script and its INSERT (what a crash or a timeout leaves behind).
    const pool = h.app.pg as unknown as { query: (...args: unknown[]) => unknown };
    const original = pool.query;
    let refused = 0;
    pool.query = function (this: unknown, ...args: unknown[]) {
      const first = args[0];
      const text = typeof first === 'string' ? first : (first as { text?: string } | undefined)?.text ?? '';
      if (text.includes('INSERT INTO matches')) {
        refused += 1;
        return Promise.reject(new Error('Connection terminated unexpectedly'));
      }
      return original.apply(this, args);
    };
    let failed: LightMyRequestResponse;
    try {
      failed = await swipe(a, [{ target: b.publicUid, action: 'like', comment: 'Hi Cora' }]);
    } finally {
      pool.query = original;
    }
    expect(refused).toBe(1);
    expect(failed.statusCode).toBeGreaterThanOrEqual(500);
    expect(await matchesOf(a, b)).toHaveLength(0);

    // The wb:match consumer makes it with the pre-minted id, once, and tells both.
    await until(async () => (await matchesOf(a, b)).length === 1);
    await until(() => [a, b].every((p) => eventsOf(realtime, p.publicUid, 'conversation').length === 1));
    const [made] = await matchesOf(a, b);
    for (const p of [a, b]) {
      const events = eventsOf(realtime, p.publicUid, 'conversation');
      expect(events).toHaveLength(1);
      expect(events[0]!.id).toBe(made!.id);
    }
    const list = conversationsPageSchema.parse((await call(h, '/v1/conversations', { token: a.token })).json());
    expect(list.items.map((c) => c.id)).toEqual([made!.id]);
    // The like notes are queued for the chat queue, as for a match made on the fast path.
    expect(await h.redis.exists(`${h.prefix}bull:chat:like-notes.${made!.id}`)).toBe(1);

    // The client sends the like again after its error: still one match, and nobody is told about a new like.
    const retry = await swipe(a, [{ target: b.publicUid, action: 'like', comment: 'Hi Cora' }]);
    expect(['duplicate', 'skipped', 'matched']).toContain(resultOf(retry).result);
    expect(await matchesOf(a, b)).toHaveLength(1);
    expect(eventsOf(realtime, b.publicUid, 'like')).toHaveLength(0);
  }, 40_000);
});
