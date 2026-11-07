import { deckPageSchema, profileCardSchema } from '@app/shared';
import {
  CdnUrlSigner,
  DeckFlag,
  FakeObjectStorage,
  cellCentre,
  homeCell,
  readDeckHead,
  writeDeck,
  type DeckEntry,
  type MediaStore,
} from '@app/shared/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, migratedDatabase, problemExt, row, seedUser, setAppConfig, startHarness, statements, type Harness, type TestDatabase } from './accountSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * GET /v1/deck against PostgreSQL and Valkey: the head of the prepared
 * queue with no statement when the cards are cached, one when some must be
 * built, people hidden since the queue was built skipped, the refill asked
 * for when the queue runs low, and the account states that may not see a deck.
 */

const CDN_KEY = 'deck-test-cdn-signing-key-0123456789';
const CELL = homeCell({ lat: 41.03, lng: 28.98 });
const NEAR = homeCell({ lat: 41.05, lng: 29.02 });

describe.skipIf(!hasInfrastructure)('GET /v1/deck', () => {
  let db: TestDatabase;
  let h: Harness;
  const jobs = new MemoryJobProducer();
  const storage = new FakeObjectStorage();
  const media: MediaStore = {
    storage,
    privateBucket: 'uploads',
    mediaBucket: 'media',
    urls: new CdnUrlSigner({ baseUrl: 'https://cdn.test.invalid', signingKey: CDN_KEY, scheme: 'hmac' }),
  };
  const rawIds: string[] = [];

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startHarness(db, {}, { jobs, media });
  }, 60_000);
  afterAll(async () => {
    for (const id of rawIds) for (const body of h?.bodies ?? []) expect(body.includes(`"${id}"`), `raw id ${id} in a response`).toBe(false);
    await h?.close();
    await db?.drop();
  });
  beforeEach(() => {
    jobs.jobs.length = 0;
  });

  /** An active person with a location, preferences and two approved photos (in discovery). */
  async function person(options: { name: string; gender?: number; interestedIn?: number; cell?: string; hideDistance?: boolean; showOnline?: boolean }) {
    const user = await seedUser(h, { name: options.name, gender: options.gender ?? 1, interestedIn: options.interestedIn ?? 4, country: 'TR' });
    rawIds.push(user.id);
    const cell = options.cell ?? NEAR;
    const centre = cellCentre(cell);
    await db.sql.query(
      `UPDATE profiles SET text_state = 2, about = 'Hello', hide_distance = $2, show_online = $3 WHERE user_id = $1`,
      [user.id, options.hideDistance ?? false, options.showOnline ?? true],
    );
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

  async function viewer(name = 'Viewer') {
    return person({ name, gender: 2, interestedIn: 2, cell: CELL });
  }

  async function queue(owner: string, entries: DeckEntry[], options: { builtAt?: number; exhaustedAt?: number | null } = {}) {
    await writeDeck(h.app.cache, h.app.keys, owner, {
      kept: [],
      front: [],
      back: entries,
      builtAt: options.builtAt ?? Date.now(),
      cursor: null,
      exhaustedAt: options.exhaustedAt ?? null,
    });
  }

  it('answers the states that may not see a deck with their own problem', async () => {
    const onboarding = await seedUser(h, { status: 1 });
    expect(problemExt('onboarding_incomplete', (await call(h, '/v1/deck', { token: onboarding.token })).json())).toBeTruthy();
    const snoozed = await seedUser(h, { status: 4, name: 'Zed', interestedIn: 2 });
    const res = await call(h, '/v1/deck', { token: snoozed.token });
    expect(res.statusCode).toBe(403);
    expect(problemExt('snoozed', res.json())).toBeTruthy();
    const nowhere = await seedUser(h, { name: 'Lost', interestedIn: 2 });
    expect(problemExt('location_required', (await call(h, '/v1/deck', { token: nowhere.token })).json())).toBeTruthy();
    const noPreferences = await seedUser(h, { name: 'Undecided' });
    expect(problemExt('onboarding_incomplete', (await call(h, '/v1/deck', { token: noPreferences.token })).json())).toBeTruthy();
    expect((await call(h, '/v1/deck')).statusCode).toBe(401);
    expect(jobs.jobs).toEqual([]);
  });

  it('asks for a refill and says "not exhausted" while there is no queue yet, with no statement once the account is cached', async () => {
    const me = await viewer();
    const first = await call(h, '/v1/deck', { token: me.token });
    expect(first.statusCode).toBe(200);
    expect(statements(first)).toBe(1); // the own-account view, cold
    expect(deckPageSchema.parse(first.json())).toEqual({ cards: [], remaining: 0, exhausted: false });
    expect(jobs.jobs).toHaveLength(1);
    expect(jobs.jobs[0]).toMatchObject({ queue: 'deck', name: 'refill', data: { userId: me.id, store: 2 } });
    expect(jobs.jobs[0]!.id).toMatch(new RegExp(`^refill\\.${me.id}\\.[0-9]+$`));
    const again = await call(h, '/v1/deck', { token: me.token });
    expect(statements(again)).toBe(0);
    // One refill per person per 30-second slot.
    expect(jobs.jobs.length).toBeLessThanOrEqual(2);
  });

  it('serves the head from Valkey: the page misses in one statement, then none, with what the viewer may see', async () => {
    const me = await viewer();
    const near = await person({ name: 'Near', showOnline: true });
    const hidden = await person({ name: 'Hides', hideDistance: true, showOnline: false });
    const far = await person({ name: 'Far' });
    await queue(me.id, [
      { userId: near.id, version: near.version, km: 1.3, flags: DeckFlag.superliked | DeckFlag.likesYou | DeckFlag.activeRecently },
      { userId: hidden.id, version: hidden.version, km: 4.4, flags: DeckFlag.activeRecently },
      { userId: far.id, version: far.version, km: 23.6, flags: DeckFlag.likesYou },
    ]);
    await call(h, '/v1/deck', { token: me.token, client: 'play/120' }); // warms the own-account view
    await h.redis.del(h.app.keys.card(near.id, near.version, 0), h.app.keys.card(hidden.id, hidden.version, 0), h.app.keys.card(far.id, far.version, 0));
    jobs.jobs.length = 0;

    const cold = await call(h, '/v1/deck?limit=10', { token: me.token, client: 'play/120' });
    expect(cold.statusCode).toBe(200);
    expect(statements(cold)).toBe(1);
    expect(cold.headers['cache-control']).toBe('private, no-store');
    const page = deckPageSchema.parse(cold.json());
    for (const card of page.cards) profileCardSchema.strict().parse(card);
    expect(page.cards.map((c) => c.name)).toEqual(['Near', 'Hides', 'Far']);
    expect(page.remaining).toBe(0);
    expect(page.exhausted).toBe(false);
    const [a, b, c] = page.cards;
    expect(a).toMatchObject({ id: near.publicUid, v: near.version, gender: 'woman', distance: { km: 2, lessThan: true }, superliked: true, likesYou: true, activeRecently: true });
    // Hide distance and show online off: no distance, no activity, whatever the queue says.
    expect(b!.distance).toBeUndefined();
    expect(b!.activeRecently).toBeUndefined();
    expect(c).toMatchObject({ distance: { km: 24 }, likesYou: true });
    expect(c!.superliked).toBeUndefined();
    expect(a!.photos).toHaveLength(2);
    expect(a!.photos.every((p) => CdnUrlSigner.verifyHmac(p.url, CDN_KEY) && p.url.includes('/1080.webp'))).toBe(true);
    // Internal fields never leave the server.
    expect(cold.body).not.toMatch(/"hd"|"so"|"bv"|"bh"/);
    // The queue ran low: a refill was asked for.
    expect(jobs.jobs.map((j) => j.name)).toEqual(['refill']);

    const warm = await call(h, '/v1/deck?limit=10', { token: me.token, client: 'play/120' });
    expect(statements(warm)).toBe(0);
    expect(warm.json()).toEqual(cold.json());

    const one = deckPageSchema.parse((await call(h, '/v1/deck?limit=1', { token: me.token })).json());
    expect(one.cards.map((x) => x.name)).toEqual(['Near']);
    expect(one.remaining).toBe(2);
  });

  it('follows a profile edited since the queue was built: the newer card once, then no statement', async () => {
    const me = await viewer();
    const edited = await person({ name: 'Before edit' });
    await queue(me.id, [{ userId: edited.id, version: edited.version, km: 3, flags: 0 }]);
    await call(h, '/v1/deck', { token: me.token });
    await db.sql.query(`UPDATE profiles SET display_name = 'After edit' WHERE user_id = $1`, [edited.id]);
    await h.redis.del(h.app.keys.card(edited.id, edited.version, 0));
    const first = await call(h, '/v1/deck', { token: me.token });
    expect(statements(first)).toBe(1);
    const card = deckPageSchema.parse(first.json()).cards[0]!;
    expect(card).toMatchObject({ name: 'After edit', v: edited.version + 1 });
    await expect.poll(async () => (await readDeckHead(h.app.cache, h.app.keys, me.id, 5)).entries[0]?.version).toBe(edited.version + 1);
    const second = await call(h, '/v1/deck', { token: me.token });
    expect(statements(second)).toBe(0);
    expect(deckPageSchema.parse(second.json()).cards[0]!.name).toBe('After edit');
  });

  it('skips and drops people hidden since the queue was built and people who left the pool', async () => {
    const me = await viewer();
    const stays = await person({ name: 'Stays' });
    const snoozedLater = await person({ name: 'Later' });
    const hiddenBefore = await person({ name: 'Before' });
    const banned = await person({ name: 'Banned' });
    const builtAt = Date.now() - 10 * 60_000;
    await queue(
      me.id,
      [stays, snoozedLater, hiddenBefore, banned].map((p) => ({ userId: p.id, version: p.version, km: 3, flags: 0 })),
      { builtAt },
    );
    // Hidden after the build (a snooze now): skipped. Hidden an hour before the build: the refill saw it, kept.
    await h.redis.zadd(h.app.keys.accountsHidden(), Date.now(), snoozedLater.id, builtAt - 3_600_000, hiddenBefore.id);
    // Banned in the database; its card is not cached, so the build finds nobody.
    await db.sql.query(`UPDATE users SET status = 6 WHERE id = $1`, [banned.id]);
    await h.redis.del(h.app.keys.card(banned.id, banned.version, 0));
    await call(h, '/v1/deck', { token: me.token });

    const page = deckPageSchema.parse((await call(h, '/v1/deck', { token: me.token })).json());
    expect(page.cards.map((c) => c.name)).toEqual(['Stays', 'Before']);
    await expect.poll(async () => (await readDeckHead(h.app.cache, h.app.keys, me.id, 10)).entries.map((e) => e.userId)).toEqual([stays.id, hiddenBefore.id]);
  });

  it('says exhausted only after a refill found nobody, with what could change it, and asks again after a while', async () => {
    const me = await viewer();
    await db.sql.query(`UPDATE preferences SET age_min = 25, age_max = 35 WHERE user_id = $1`, [me.id]);
    await queue(me.id, [], { exhaustedAt: Date.now() - 60_000 });
    await call(h, '/v1/deck', { token: me.token });
    jobs.jobs.length = 0;
    const page = deckPageSchema.parse((await call(h, '/v1/deck', { token: me.token })).json());
    expect(page).toEqual({ cards: [], remaining: 0, exhausted: true, suggestions: ['widen_distance', 'widen_age', 'boost'] });
    expect(jobs.jobs).toEqual([]);

    await db.sql.query(`UPDATE preferences SET flags = 1 WHERE user_id = $1`, [me.id]);
    await h.app.account.changed(me.id);
    const whole = deckPageSchema.parse((await call(h, '/v1/deck', { token: me.token })).json());
    expect(whole.suggestions).toEqual(['widen_age', 'boost']);

    await queue(me.id, [], { exhaustedAt: Date.now() - 11 * 60_000 });
    const later = deckPageSchema.parse((await call(h, '/v1/deck', { token: me.token })).json());
    expect(later.exhausted).toBe(false);
    expect(jobs.jobs.map((j) => j.name)).toEqual(['refill']);
  });

  it('asks for a refill only once fewer than refill_below cards are left after the page', async () => {
    await setAppConfig(h, 'deck.refill', { queue_size: 200, refill_below: 3, fetch_limit: 600, max_idle_days: 45, idle_steps: [3, 14] });
    try {
      const me = await viewer();
      const people = [];
      for (let i = 0; i < 5; i += 1) people.push(await person({ name: `Q${i}` }));
      await queue(me.id, people.map((p) => ({ userId: p.id, version: p.version, km: 2, flags: 0 })));
      await call(h, '/v1/deck?limit=1', { token: me.token });
      jobs.jobs.length = 0;
      const two = deckPageSchema.parse((await call(h, '/v1/deck?limit=2', { token: me.token })).json());
      expect(two.remaining).toBe(3);
      expect(jobs.jobs).toEqual([]);
      const three = deckPageSchema.parse((await call(h, '/v1/deck?limit=3', { token: me.token })).json());
      expect(three.remaining).toBe(2);
      expect(jobs.jobs.map((j) => j.name)).toEqual(['refill']);
    } finally {
      await setAppConfig(h, 'deck.refill', { queue_size: 200, refill_below: 30, fetch_limit: 600, max_idle_days: 45, idle_steps: [3, 14] });
    }
  });

  it('answers when the refill cannot be queued, and refuses limits out of range', async () => {
    const me = await viewer();
    const p = await person({ name: 'Solo' });
    await queue(me.id, [{ userId: p.id, version: p.version, km: 5, flags: 0 }]);
    jobs.failWith = new Error('valkey down');
    try {
      const res = await call(h, '/v1/deck', { token: me.token });
      expect(res.statusCode).toBe(200);
      expect(deckPageSchema.parse(res.json()).cards).toHaveLength(1);
    } finally {
      jobs.failWith = null;
    }
    expect((await call(h, '/v1/deck?limit=0', { token: me.token })).statusCode).toBe(400);
    expect((await call(h, '/v1/deck?limit=31', { token: me.token })).statusCode).toBe(400);
  });
});
