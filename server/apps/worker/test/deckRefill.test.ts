import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createPool, instrumentPool, statementCounter, type Pool } from '@app/db';
import {
  DeckFlag,
  IdGenerator,
  addSeen,
  cellCentre,
  cellDisk,
  createKeys,
  createPublicIds,
  homeCell,
  likeWeek,
  parentCell,
  readDeck,
  takeDeckLock,
  type DeckEntry,
} from '@app/shared/server';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeQueues } from '../src/deck/enqueue.js';
import { lkRebuildJob } from '../src/deck/likeBuckets.js';
import { refillDeck, type RefillResult } from '../src/deck/refill.js';
import { loadConfig, type JobContext } from '../src/index.js';
import { FakePhotoModerator } from '../src/photos/moderation.js';
import type { WorkerServices } from '../src/services.js';
import { cardViolations, generateDataset, rng } from './deckData.js';
import { ensureGroupRoles, hasDatabase, loginRole, migratedDatabase, type TestDatabase } from './db.js';
import { TEST_REDIS_URL, baseEnv, connect, hasRedis } from './support.js';

/**
 * The deck refill against PostgreSQL 17 + PostGIS and Valkey, on the
 * generated 40,000-person dataset of docs/16 §18: every queued card keeps
 * every rule (checked again from the source tables), the refill's SQL stays
 * within 50 ms at p95 (also for a viewer with 600 hidden peers), and the
 * soft parts (seen people, advanced filters, likers, super likers, boosts,
 * the cursor, the like-bucket rebuild) do what they say.
 */

const PEOPLE = Number(process.env['DECK_TEST_PEOPLE'] ?? 40_000);
const SQL_P95_MS = 50;

interface Timed {
  text: string;
  ms: number;
}

/** Records the duration of every statement the pool runs (after the statement counter). */
function timeStatements(pool: Pool, sink: Timed[]): Pool {
  const inner = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
  Object.defineProperty(pool, 'query', {
    configurable: true,
    writable: true,
    value: async (...args: unknown[]) => {
      const started = performance.now();
      try {
        return await inner(...args);
      } finally {
        const first = args[0] as { text?: string } | string;
        const text = typeof first === 'string' ? first : (first?.text ?? '');
        sink.push({ text, ms: performance.now() - started });
      }
    },
  });
  return pool;
}

function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

describe.skipIf(!hasDatabase || !hasRedis)(`the deck refill on ${PEOPLE} generated people (PostgreSQL, Valkey)`, () => {
  let db: TestDatabase;
  let pg: Pool;
  let redis: Redis;
  let ids: IdGenerator;
  let services: WorkerServices;
  let context: JobContext;
  let role: Awaited<ReturnType<typeof loginRole>>;
  const prefix = `t${randomBytes(4).toString('hex')}:`;
  const keys = createKeys(prefix);
  const env = baseEnv();
  const publicIds = createPublicIds(env['ID_PUBLIC_KEY']!, env['ID_BILLING_KEY']!);
  const timings: Timed[] = [];
  let choiceField = 0;
  let heightField = 0;
  const CHOICE_SLOT = 1;

  /** A context with services of their own: the deck settings are loaded afresh (after an app_config change). */
  function freshContext(): JobContext {
    return { ...context, services: { ...services } };
  }

  async function sql<T>(text: string, values: unknown[] = []): Promise<T[]> {
    return (await db.admin.query(text, values)).rows as T[];
  }

  /** Forgets every cached card (the next refill builds them). */
  async function clearCards(): Promise<void> {
    let cursor = '0';
    do {
      const [next, found] = await redis.scan(cursor, 'MATCH', `${prefix}card:*`, 'COUNT', 2000);
      cursor = next;
      if (found.length > 0) await redis.del(...found);
    } while (cursor !== '0');
  }

  async function clearDeck(userId: string): Promise<void> {
    await redis.del(keys.deckQueue(userId), keys.deckMeta(userId), keys.deckLock(userId));
  }

  async function refill(userId: string, ctx: JobContext = context): Promise<Extract<RefillResult, { outcome: 'refilled' }>> {
    const result = await refillDeck(ctx, { userId, store: 2 });
    if (result.outcome !== 'refilled') throw new Error(`refill of ${userId}: ${JSON.stringify(result)}`);
    return result;
  }

  /** A refill measured: statements, the SQL time (sum of the refill's statements) and the candidate statement's time. */
  async function measured(userId: string, ctx: JobContext = context) {
    const from = timings.length;
    const { result, tally } = await statementCounter.measure(() => refill(userId, ctx));
    const mine = timings.slice(from);
    return {
      result,
      statements: tally.statements,
      sqlMs: mine.reduce((sum, t) => sum + t.ms, 0),
      candidatesMs: mine.filter((t) => t.text.includes('deck_candidates')).reduce((sum, t) => sum + t.ms, 0),
      texts: tally.texts,
    };
  }

  /** A new active person in a cell, with preferences (triggers on: discovery follows). */
  async function person(options: {
    cell: string;
    gender?: number;
    interestedIn?: number;
    birthDate?: string;
    ageMin?: number;
    ageMax?: number;
    radiusKm?: number;
    prefFlags?: number;
    activeDaysAgo?: number;
    incognito?: boolean;
    flags?: number;
    verified?: boolean;
  }): Promise<string> {
    const id = ids.nextId();
    const centre = cellCentre(options.cell);
    await db.admin.query(
      `INSERT INTO users (id, status, birth_date, gender, country, onboarding_step, last_active_on, flags, is_verified)
       VALUES ($1, 3, $2, $3, 'TR', 50, current_date - $4::integer, $5, $6)`,
      [id, options.birthDate ?? '1996-03-01', options.gender ?? 1, options.activeDaysAgo ?? 0, options.flags ?? 0, options.verified ?? false],
    );
    await db.admin.query(`INSERT INTO profiles (user_id, display_name, completeness, text_state, incognito) VALUES ($1, 'N', 90, 2, $2)`, [
      id,
      options.incognito ?? false,
    ]);
    await db.admin.query(
      `INSERT INTO preferences (user_id, interested_in, age_min, age_max, max_distance_km, flags) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, options.interestedIn ?? 4, options.ageMin ?? 18, options.ageMax ?? 99, options.radiusKm ?? 50, options.prefFlags ?? 0],
    );
    await db.admin.query(
      `INSERT INTO user_locations (user_id, home_h3, source, country, home_geo) VALUES ($1, $2, 1, 'TR', ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography)`,
      [id, options.cell, centre.lng, centre.lat],
    );
    await db.admin.query(
      `INSERT INTO photos (id, user_id, position, status, width, height, blurhash, blob_ver)
       VALUES ($1, $3, 0, 3, 1080, 1350, 'L6PZfSi_', 1), ($2, $3, 1, 3, 1080, 1350, 'L6PZfSi_', 1)`,
      [ids.nextId(), ids.nextId(), id],
    );
    return id;
  }

  async function like(actor: string, target: string, kind: 1 | 2 = 1): Promise<void> {
    await db.admin.query(`INSERT INTO likes (target_id, actor_id, id, kind) VALUES ($1, $2, $3, $4)`, [target, actor, ids.nextId(), kind]);
    const w = likeWeek(Date.now());
    await redis.sadd(keys.likesIn(target, w), actor);
    if (kind === 2) await redis.sadd(keys.likesInSuper(target, w), actor);
  }

  async function queueOf(userId: string): Promise<{ ids: string[]; meta: Map<string, DeckEntry> }> {
    const deck = await readDeck(redis, keys, userId);
    return { ids: deck.ids, meta: deck.meta };
  }

  /** A sample of dataset people (stable). */
  async function sampleViewers(n: number, where = 'true'): Promise<string[]> {
    const rows = await sql<{ id: string }>(
      `SELECT u.id::text AS id FROM users u JOIN discovery d ON d.user_id = u.id WHERE ${where} ORDER BY hashint8(u.id) LIMIT $1`,
      [n],
    );
    return rows.map((r) => r.id);
  }

  const ISTANBUL = homeCell({ lat: 41.015, lng: 28.979 });

  beforeAll(async () => {
    await ensureGroupRoles();
    role = await loginRole(['app_rw']);
    db = await migratedDatabase();
    const [choice] = await sql<{ id: number }>(
      `INSERT INTO profile_field_defs (type, key, filter_slot, is_filterable, options)
       VALUES (1, 'pets', ${CHOICE_SLOT}, true, '[{"id": 1}, {"id": 2}, {"id": 3}]') RETURNING id`,
    );
    const [height] = await sql<{ id: number }>(
      `INSERT INTO profile_field_defs (type, key, discovery_column, is_filterable) VALUES (4, 'height', 'height_cm', true) RETURNING id`,
    );
    choiceField = choice!.id;
    heightField = height!.id;
    await generateDataset(db.admin, { count: PEOPLE, fields: { choiceFieldId: choiceField, heightFieldId: heightField } });
    pg = timeStatements(
      instrumentPool(createPool({ connectionString: db.urlFor(role.name, role.password), applicationName: 'deck-test', max: 4 }), statementCounter),
      timings,
    );
    redis = connect();
    ids = new IdGenerator({ redis, keyPrefix: prefix });
    await ids.start();
    services = { pg, cache: redis, ids, keys, publicIds, realtime: null, media: null, photoModerator: new FakePhotoModerator({ autoApprove: false }) };
    const config = loadConfig({ ...env, DATABASE_URL: db.url, REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix, WORKER_ID: 'deck-test' });
    context = { config, redis, log: pino({ level: 'silent' }), services };
    await redis.set(keys.likesReady(), '1');
    // Warm the settings and the database's caches once.
    const [warm] = await sampleViewers(1);
    await refill(warm!);
  }, 600_000);

  afterAll(async () => {
    await closeQueues(redis);
    await ids?.stop();
    await pg?.end();
    if (redis) {
      const left = await redis.keys(`${prefix}*`);
      for (let i = 0; i < left.length; i += 1000) await redis.del(...left.slice(i, i + 1000));
      await redis.quit();
    }
    await db?.drop();
    await role?.drop();
  });

  it('gives every viewer a queue of up to 200 in which every card keeps every rule', async () => {
    // Whole-country and verified-only searchers, and test accounts, among ordinary viewers.
    const whole = await sampleViewers(5, 'u.flags = 0 AND u.id % 7 = 1');
    await db.admin.query(`UPDATE preferences SET flags = flags | 1 WHERE user_id = ANY ($1::bigint[])`, [whole]);
    const verifiedOnly = await sampleViewers(5, `EXISTS (SELECT 1 FROM preferences p WHERE p.user_id = u.id AND (p.flags & 2) <> 0)`);
    const testers = await sampleViewers(5, 'u.flags & 1 = 1');
    const viewers = [...new Set([...(await sampleViewers(65)), ...whole, ...verifiedOnly, ...testers])];
    const sizes: number[] = [];
    for (const viewer of viewers) {
      await clearDeck(viewer);
      const result = await refill(viewer);
      const { ids: queued } = await queueOf(viewer);
      expect(queued.length, viewer).toBe(result.kept + result.added);
      expect(queued.length).toBeLessThanOrEqual(200);
      expect(new Set(queued).size).toBe(queued.length);
      expect(await cardViolations(db.admin, viewer, queued), `viewer ${viewer}`).toEqual([]);
      sizes.push(queued.length);
    }
    // The dataset is dense enough that most viewers get a full queue; test accounts see only each other (few).
    expect(sizes.filter((n) => n === 200).length).toBeGreaterThan(viewers.length / 3);
    for (const tester of testers) {
      const { ids: queued } = await queueOf(tester);
      if (queued.length === 0) continue;
      const others = await sql<{ n: number }>(`SELECT count(*)::integer AS n FROM users WHERE id = ANY ($1::bigint[]) AND flags & 1 = 0`, [queued]);
      expect(others[0]!.n).toBe(0);
    }
  }, 300_000);

  it(`takes at most ${SQL_P95_MS} ms of SQL at p95 for a refill, over 200 viewers`, async () => {
    const viewers = await sampleViewers(200, 'u.id % 3 = 0');
    const sqlMs: number[] = [];
    const candidatesMs: number[] = [];
    const statements: number[] = [];
    for (const viewer of viewers) {
      await clearDeck(viewer);
      const run = await measured(viewer);
      sqlMs.push(run.sqlMs);
      candidatesMs.push(run.candidatesMs);
      statements.push(run.statements);
    }
    const report = { viewers: viewers.length, sqlP95: p95(sqlMs), candidatesP95: p95(candidatesMs), statementsMax: Math.max(...statements) };
    console.info('deck refill SQL', JSON.stringify(report));
    expect(report.sqlP95).toBeLessThanOrEqual(SQL_P95_MS);
    // A refill: the viewer, one statement per pool page (up to the activity windows and one wrap), the missing cards.
    expect(report.statementsMax).toBeLessThanOrEqual(6);
  }, 300_000);

  it(`keeps 600 hidden peers (400 matches, 200 blocks) out, within ${SQL_P95_MS} ms of SQL at p95`, async () => {
    const viewer = await person({ cell: ISTANBUL, gender: 2, interestedIn: 2, radiusKm: 60 });
    await refill(viewer);
    // Hide people the deck would otherwise offer: 400 matches and 200 blocks among the viewer's candidates.
    const pool = await sql<{ id: string }>(
      `SELECT user_id::text AS id FROM deck_candidates($1, 5, $2::bigint[], 'TR', ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, 60000,
                                                     '{}', 45, 1, NULL, NULL, 5000)`,
      [viewer, cellDisk(parentCell(ISTANBUL, 5), 6), cellCentre(ISTANBUL).lng, cellCentre(ISTANBUL).lat],
    );
    expect(pool.length).toBeGreaterThan(1_000);
    const shuffled = pool.map((p) => p.id).sort((a, b) => (BigInt(a) % 9973n < BigInt(b) % 9973n ? -1 : 1));
    const matched = shuffled.slice(0, 400);
    const blocked = shuffled.slice(400, 600);
    for (const peer of matched) {
      const [lo, hi] = BigInt(peer) < BigInt(viewer) ? [peer, viewer] : [viewer, peer];
      await db.admin.query(`INSERT INTO matches (id, user_lo, user_hi, source) VALUES ($1, $2, $3, 1)`, [ids.nextId(), lo, hi]);
    }
    for (const peer of blocked) {
      const [lo, hi] = BigInt(peer) < BigInt(viewer) ? [peer, viewer] : [viewer, peer];
      await db.admin.query(`INSERT INTO blocks (user_lo, user_hi, blocked_by) VALUES ($1, $2, 1)`, [lo, hi]);
    }
    await db.admin.query('ANALYZE matches, blocks');
    const hidden = new Set([...matched, ...blocked]);
    const sqlMs: number[] = [];
    const candidatesMs: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      await clearDeck(viewer);
      const run = await measured(viewer);
      sqlMs.push(run.sqlMs);
      candidatesMs.push(run.candidatesMs);
      const { ids: queued } = await queueOf(viewer);
      expect(queued.length).toBe(200);
      expect(queued.filter((id) => hidden.has(id))).toEqual([]);
      if (i === 0) expect(await cardViolations(db.admin, viewer, queued)).toEqual([]);
    }
    const report = { runs: sqlMs.length, sqlP95: p95(sqlMs), candidatesP95: p95(candidatesMs), candidatesAfterIndex: pool.length };
    console.info('deck refill SQL, 600 hidden peers', JSON.stringify(report));
    expect(report.sqlP95).toBeLessThanOrEqual(SQL_P95_MS);
  }, 300_000);

  it('gives two viewers in the same area different first pages (the seeded order)', async () => {
    // Viewer ids (and so the seeds) are random: one pair's overlap varies (3-11 of 20 measured),
    // so the bound applies to the mean of several pairs, and every pair must differ.
    const PAIRS = 3;
    const overlaps: number[] = [];
    for (let i = 0; i < PAIRS; i += 1) {
      const a = await person({ cell: ISTANBUL, gender: 2, interestedIn: 2 });
      const b = await person({ cell: ISTANBUL, gender: 2, interestedIn: 2 });
      await refill(a);
      await refill(b);
      const first = (await queueOf(a)).ids.slice(0, 20);
      const second = (await queueOf(b)).ids.slice(0, 20);
      expect(first).toHaveLength(20);
      expect(first).not.toEqual(second);
      overlaps.push(first.filter((id) => second.includes(id)).length);
    }
    const mean = overlaps.reduce((sum, n) => sum + n, 0) / overlaps.length;
    console.info('deck first pages of two viewers with the same search', JSON.stringify({ overlaps, of: 20, mean }));
    expect(mean).toBeLessThanOrEqual(10);
    expect(Math.max(...overlaps)).toBeLessThan(20);
  });

  it('drops people the viewer swiped (seen filter) and continues the pool where the last refill stopped', async () => {
    const viewer = await person({ cell: ISTANBUL, gender: 2, interestedIn: 2, radiusKm: 60 });
    const first = await refill(viewer);
    const q1 = (await queueOf(viewer)).ids;
    expect(q1).toHaveLength(200);
    expect(first.pages).toBe(1);
    // Every card swiped: each leaves the queue and enters the seen filter.
    await addSeen(redis, keys, viewer, q1, { returnDays: 30 });
    for (const id of q1) await redis.lrem(keys.deckQueue(viewer), 0, id);
    const second = await refill(viewer);
    const q2 = (await queueOf(viewer)).ids;
    expect(q2.length).toBeGreaterThan(150);
    expect(q2.filter((id) => q1.includes(id))).toEqual([]);
    // The second page started after the first: hardly anything of it had been seen.
    expect(second.seenDropped).toBeLessThan(20);
    // Without the cursor (a fresh queue), the pool starts over and the seen filter drops what was swiped.
    await clearDeck(viewer);
    await addSeen(redis, keys, viewer, q2, { returnDays: 30 });
    const third = await refill(viewer);
    const q3 = (await queueOf(viewer)).ids;
    expect(third.seenDropped).toBeGreaterThan(150);
    expect(q3.filter((id) => q1.includes(id) || q2.includes(id))).toEqual([]);
  });

  it('applies advanced filters on field answers and height, people who did not answer included out', async () => {
    const viewer = await person({ cell: ISTANBUL, gender: 2, interestedIn: 2, radiusKm: 60 });
    await db.admin.query(`UPDATE preferences SET filters = $2::jsonb WHERE user_id = $1`, [viewer, JSON.stringify({ pets: [2], height: [170, 185] })]);
    const result = await refill(viewer);
    const queued = (await queueOf(viewer)).ids;
    expect(queued.length).toBeGreaterThan(20);
    expect(result.filteredOut).toBeGreaterThan(0);
    const rows = await sql<{ id: string; opt: number | null; num: number | null }>(
      `SELECT u.id::text AS id,
              (SELECT v.opt FROM profile_field_values v WHERE v.user_id = u.id AND v.field_id = $2) AS opt,
              (SELECT v.num FROM profile_field_values v WHERE v.user_id = u.id AND v.field_id = $3) AS num
         FROM unnest($1::bigint[]) AS u(id)`,
      [queued, choiceField, heightField],
    );
    expect(rows.filter((r) => r.opt !== 2 || r.num === null || r.num < 170 || r.num > 185)).toEqual([]);
    expect(await cardViolations(db.admin, viewer, queued)).toEqual([]);
  });

  it('puts super likers first, injects likers and boosted people whatever their place, and marks the cards', async () => {
    const viewer = await person({ cell: ISTANBUL, gender: 2, interestedIn: 2, radiusKm: 30 });
    const near = homeCell({ lat: 41.02, lng: 28.99 });
    // Active 40 days ago: far down the activity order, out of reach of a short pool page.
    const superLiker = await person({ cell: near, interestedIn: 4, activeDaysAgo: 40 });
    const incognitoLiker = await person({ cell: near, interestedIn: 4, activeDaysAgo: 40, incognito: true });
    const boosted = await person({ cell: near, interestedIn: 4, activeDaysAgo: 40 });
    const incognitoStranger = await person({ cell: near, interestedIn: 4, incognito: true });
    // Injected, but against the rules: a man (the viewer wants women), and a super liker the viewer blocked.
    const wrongGender = await person({ cell: near, gender: 2, interestedIn: 4 });
    const blockedSuper = await person({ cell: near, interestedIn: 4 });
    await like(superLiker, viewer, 2);
    await like(incognitoLiker, viewer, 1);
    await like(wrongGender, viewer, 1);
    await like(blockedSuper, viewer, 2);
    {
      const [lo, hi] = BigInt(blockedSuper) < BigInt(viewer) ? [blockedSuper, viewer] : [viewer, blockedSuper];
      await db.admin.query(`INSERT INTO blocks (user_lo, user_hi, blocked_by) VALUES ($1, $2, 1)`, [lo, hi]);
    }
    await redis.zadd(keys.boosted(parentCell(near, 5)), Date.now() + 3_600_000, boosted);
    await db.admin.query(`UPDATE public.app_config SET value = $1::jsonb WHERE key = 'deck.refill'`, [
      JSON.stringify({ queue_size: 200, refill_below: 30, fetch_limit: 40, max_idle_days: 45, idle_steps: [3, 14] }),
    ]);
    try {
      const ctx = freshContext();
      const result = await refill(viewer, ctx);
      const { ids: queued, meta } = await queueOf(viewer);
      expect(result.injectedRows).toBeGreaterThanOrEqual(3);
      expect(queued[0]).toBe(superLiker);
      expect(meta.get(superLiker)!.flags & (DeckFlag.superliked | DeckFlag.likesYou)).toBe(DeckFlag.superliked | DeckFlag.likesYou);
      expect(queued).toContain(incognitoLiker);
      // Without see-likes a like is not shown on the card (a super like is).
      expect(meta.get(incognitoLiker)!.flags & DeckFlag.likesYou).toBe(0);
      expect(queued).toContain(boosted);
      expect(meta.get(boosted)!.flags & DeckFlag.boosted).toBe(DeckFlag.boosted);
      expect(queued).not.toContain(incognitoStranger);
      expect(queued).not.toContain(wrongGender);
      expect(queued).not.toContain(blockedSuper);
      expect(await cardViolations(db.admin, viewer, queued)).toEqual([]);

      // With see-likes (an admin grant of the premium plan), likes are shown.
      await db.admin.query(
        `INSERT INTO subscriptions (user_id, started_at, expires_at, plan_id, store, status) VALUES ($1, now(), now() + interval '30 days', 3, 0, 4)`,
        [viewer],
      );
      await clearDeck(viewer);
      await refill(viewer, ctx);
      expect((await queueOf(viewer)).meta.get(incognitoLiker)!.flags & DeckFlag.likesYou).toBe(DeckFlag.likesYou);

      // While Valkey's like buckets are being rebuilt, the likers come from PostgreSQL, and the rebuild is queued.
      await redis.del(keys.likesReady(), keys.likesIn(viewer, likeWeek(Date.now())), keys.likesInSuper(viewer, likeWeek(Date.now())));
      await clearDeck(viewer);
      const fallback = await refill(viewer, ctx);
      expect(fallback.lkReady).toBe(false);
      const after = await queueOf(viewer);
      expect(after.ids[0]).toBe(superLiker);
      expect(after.ids).toContain(incognitoLiker);
      expect(after.ids).not.toContain(incognitoStranger);
      const maint = new Queue('maint', { connection: redis, prefix: context.config.queuePrefix });
      try {
        const waiting = await maint.getJobs(['waiting', 'delayed', 'prioritized']);
        expect(waiting.some((job) => job.name === 'lk-rebuild')).toBe(true);
      } finally {
        await maint.close();
      }
    } finally {
      await db.admin.query(`UPDATE public.app_config SET value = $1::jsonb WHERE key = 'deck.refill'`, [
        JSON.stringify({ queue_size: 200, refill_below: 30, fetch_limit: 600, max_idle_days: 45, idle_steps: [3, 14] }),
      ]);
      await redis.set(keys.likesReady(), '1');
    }
  });

  it('rebuilds the like buckets from likes, leaving matched pairs out and stopping at the cap', async () => {
    const target = await person({ cell: ISTANBUL, gender: 2, interestedIn: 2 });
    const likers: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const liker = await person({ cell: ISTANBUL, interestedIn: 4 });
      likers.push(liker);
      await db.admin.query(`INSERT INTO likes (target_id, actor_id, id, kind) VALUES ($1, $2, $3, $4)`, [target, liker, ids.nextId(), i === 0 ? 2 : 1]);
    }
    // The last liker matched with the target: not pending any more.
    const matched = likers[11]!;
    const [lo, hi] = BigInt(matched) < BigInt(target) ? [matched, target] : [target, matched];
    await db.admin.query(`INSERT INTO matches (id, user_lo, user_hi, source) VALUES ($1, $2, $3, 1)`, [ids.nextId(), lo, hi]);
    const lonely = await person({ cell: ISTANBUL, gender: 2, interestedIn: 2 });
    await db.admin.query(`INSERT INTO likes (target_id, actor_id, id, kind) VALUES ($1, $2, $3, 1)`, [lonely, likers[0], ids.nextId()]);
    await db.admin.query(`UPDATE public.app_config SET value = '10'::jsonb WHERE key = 'likes.bucket_cap'`);
    try {
      await redis.del(keys.likesReady());
      const week = likeWeek(Date.now());
      await redis.del(keys.likesIn(target, week), keys.likesInFull(target, week), keys.likesInSuper(target, week), keys.likesIn(lonely, week));
      const ctx = freshContext();
      const result = await lkRebuildJob(ctx, { chunk: 7 });
      expect(result.outcome).toBe('rebuilt');
      expect(await redis.exists(keys.likesReady())).toBe(1);
      const bucket = await redis.smembers(keys.likesIn(target, week));
      expect(bucket).toHaveLength(10);
      expect(bucket).not.toContain(matched);
      expect(bucket.every((id) => likers.includes(id))).toBe(true);
      expect(await redis.exists(keys.likesInFull(target, week))).toBe(1);
      expect(await redis.smembers(keys.likesInSuper(target, week))).toEqual([likers[0]]);
      expect(await redis.smembers(keys.likesIn(lonely, week))).toEqual([likers[0]]);
      expect(await redis.ttl(keys.likesIn(lonely, week))).toBeGreaterThan(28 * 86_400);
      // While the buckets are complete, the job costs one EXISTS and nothing else.
      const { tally } = await statementCounter.measure(() => lkRebuildJob(ctx));
      expect(tally.statements).toBe(0);
    } finally {
      await db.admin.query(`UPDATE public.app_config SET value = '3000'::jsonb WHERE key = 'likes.bucket_cap'`);
      await redis.set(keys.likesReady(), '1');
    }
  });

  it('re-checks the queued people on every refill: a block or a ban since takes them out', async () => {
    const viewer = await person({ cell: ISTANBUL, gender: 2, interestedIn: 2, radiusKm: 60 });
    await refill(viewer);
    const queued = (await queueOf(viewer)).ids;
    const [blocked, banned] = [queued[3]!, queued[7]!];
    const [lo, hi] = BigInt(blocked) < BigInt(viewer) ? [blocked, viewer] : [viewer, blocked];
    await db.admin.query(`INSERT INTO blocks (user_lo, user_hi, blocked_by) VALUES ($1, $2, 1)`, [lo, hi]);
    await db.admin.query(`UPDATE users SET status = 6 WHERE id = $1`, [banned]);
    // A few swipes later the queue is topped up.
    for (const id of queued.slice(20, 60)) await redis.lrem(keys.deckQueue(viewer), 0, id);
    await addSeen(redis, keys, viewer, queued.slice(20, 60), { returnDays: 30 });
    const result = await refill(viewer);
    const after = (await queueOf(viewer)).ids;
    expect(after).not.toContain(blocked);
    expect(after).not.toContain(banned);
    expect(result.dropped).toBeGreaterThanOrEqual(2);
    expect(after.slice(0, 3)).toEqual(queued.slice(0, 3));
    expect(after).toHaveLength(200);
  });

  it('costs the viewer, one pool page and the missing cards; cached cards cost nothing', async () => {
    const viewer = await person({ cell: ISTANBUL, gender: 2, interestedIn: 2, radiusKm: 60 });
    await clearCards();
    const cold = await measured(viewer);
    expect(cold.result.cardsBuilt).toBeGreaterThan(0);
    expect(cold.statements).toBe(3);
    expect(cold.texts.join('\n')).toMatch(/deck_viewer/);
    expect(cold.texts.join('\n')).toMatch(/AS injected/);
    expect(cold.texts.join('\n')).toMatch(/profile_cards/);
    await clearDeck(viewer);
    const warm = await measured(viewer);
    expect(warm.result.cardsBuilt).toBe(0);
    expect(warm.statements).toBe(2);
  });

  it('does nothing for an account that may not see a deck, or while another refill runs', async () => {
    const snoozed = await person({ cell: ISTANBUL });
    await db.admin.query(`UPDATE users SET status = 4 WHERE id = $1`, [snoozed]);
    expect(await refillDeck(context, { userId: snoozed })).toEqual({ outcome: 'not_eligible', reason: 'status' });
    expect(await redis.exists(keys.deckQueue(snoozed))).toBe(0);
    expect(await refillDeck(context, { userId: '1234567890123' })).toEqual({ outcome: 'not_eligible', reason: 'missing' });
    const busy = await person({ cell: ISTANBUL });
    expect(await takeDeckLock(redis, keys, busy)).toBeTruthy();
    expect(await refillDeck(context, { userId: busy })).toEqual({ outcome: 'locked' });
  });

  it('builds the same rules for a viewer anywhere in the dataset (random spot checks)', async () => {
    const random = rng(99);
    const viewers = await sampleViewers(400);
    for (let i = 0; i < 15; i += 1) {
      const viewer = viewers[Math.floor(random() * viewers.length)]!;
      await clearDeck(viewer);
      await refill(viewer);
      expect(await cardViolations(db.admin, viewer, (await queueOf(viewer)).ids)).toEqual([]);
    }
  });
});
