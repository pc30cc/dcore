import {
  adminStatsConversionSchema,
  adminStatsFunnelSchema,
  adminStatsLiveSchema,
  adminStatsModerationSchema,
  adminStatsPlacesSchema,
  adminStatsRetentionSchema,
  adminStatsRevenueSchema,
  adminStatsSeriesSchema,
  statsAddDays,
  statsDay,
} from '@app/shared';
import { callKeys, utcDay } from '@app/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { weightedMedian } from '../src/routes/adminStats.js';
import { migratedDatabase, row, statements, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, startAdminHarness, type AdminHarness, type AdminSession } from './adminSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * The dashboard and statistics routes: the live read costs no statement
 * (the worker's snapshot, the day counters, live calls and the heartbeat
 * from Valkey; a stale snapshot or a stopped worker shows none; test accounts
 * left out of today's active people at once) and every chart read one (W7
 * AC4); money only with dashboard.revenue; ranges checked (no day before
 * 2020); daily series with 0 for a rolled-up day without a row; retention,
 * funnel, places (withheld cells null, Other's too), revenue (one currency,
 * the one with the most payments by default, the catalogue's product names,
 * kept 5 minutes per newest day), conversion and moderator figures (names
 * only) shaped from the stats tables.
 */

describe('weightedMedian', () => {
  it('takes the value where half the weight is reached', () => {
    expect(weightedMedian([])).toBeNull();
    expect(weightedMedian([[5, 0]])).toBeNull();
    expect(weightedMedian([[100, 1], [7200, 3]])).toBe(7200);
    expect(weightedMedian([[100, 2], [7200, 2]])).toBe(100);
    expect(weightedMedian([[30, 1], [10, 1], [20, 1]])).toBe(20);
  });
});

describe.skipIf(!hasInfrastructure)('admin: dashboard and statistics', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  let superAdmin: AdminSession;
  let analyst: AdminSession;
  let moderator: AdminSession;
  let auditor: AdminSession;
  const now = Date.now();
  const today = statsDay(now);
  const back = (n: number) => statsAddDays(today, -n);

  beforeAll(async () => {
    db = await migratedDatabase();
    // A role without dashboard.read (every seeded role holds it).
    await db.sql.query(`INSERT INTO admin_roles (id, key, names) VALUES (40, 'auditor', '{}')`);
    await db.sql.query(`INSERT INTO admin_role_permissions (role_id, permission) VALUES (40, 'audit.read')`);
    h = await startAdminHarness(db);
    [superAdmin, analyst, moderator, auditor] = [await adminAs(h, 'superadmin'), await adminAs(h, 'analyst'), await adminAs(h, 'moderator'), await adminAs(h, 'auditor')];
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await db?.drop();
  });

  const get = (session: AdminSession | null, url: string) => admin(h, url, undefined, session ? { token: session.accessToken } : {});
  const put = async (rows: [metric: string, day: string, dim: string, value: number][]) => {
    for (const [metric, day, dim, value] of rows) {
      await db.sql.query(
        `INSERT INTO stats_daily (metric, day, dim, value) VALUES ($1, $2, $3, $4) ON CONFLICT (metric, day, dim) DO UPDATE SET value = EXCLUDED.value`,
        [metric, day, dim, value],
      );
    }
  };

  function snapshot(day: string, overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      at: new Date(now - 20_000).toISOString(),
      day,
      online: 7,
      testActive: 1,
      db: {
        signups: 3,
        matches: 2,
        calls: 1,
        callsAnswered: 1,
        reports: 1,
        photos: 10_001,
        texts: 2,
        reportsOpen: 4,
        reportsUrgent: 1,
        appeals: 0,
        tickets: 3,
        revenue: [
          { currency: 'USD', micros: '5000000', estimated: false },
          { currency: 'IRR', micros: '900000000000', estimated: true },
        ],
      },
      streams: [
        { name: 'like', length: 0, pending: 0, dead: 0, lagMs: 0 },
        { name: 'match', length: 0, pending: 0, dead: 0, lagMs: null },
        { name: 'msg', length: 3, pending: 1, dead: 0, lagMs: 1200 },
      ],
      jobs: [{ queue: 'stats', waiting: 1, active: 0, delayed: 0, failed: 0 }],
      ...overrides,
    });
  }

  it('serves the live dashboard from Valkey alone, revenue only with dashboard.revenue', async () => {
    const k = h.app.keys;
    const day = utcDay(now);
    await h.redis.set(k.statsLive(), snapshot(today), 'EX', 600);
    await h.redis.sadd(k.activeDay(day), '11', '12', '13');
    for (const [name, n] of [['like', 4], ['superlike', 1], ['pass', 2], ['msg', 5], ['sms_ok', 3], ['sms_fail', 1], ['push_ok', 2]] as const) {
      await h.redis.set(k.statsCounter(name, day), String(n));
    }
    await h.redis.zadd(callKeys(k).live(), Date.now() + 60_000, 'c1', Date.now() - 1_000, 'c2');
    const beat = new Date(now - 5_000).toISOString();
    await h.redis.set(k.workerHeartbeat(), JSON.stringify({ at: beat, workerId: 'w1' }), 'PX', 90_000);

    const res = await get(superAdmin, '/v1/admin/stats/live');
    expect(res.statusCode).toBe(200);
    expect(statements(res)).toBe(0);
    expect(res.headers['cache-control']).toBe('no-store');
    const live = adminStatsLiveSchema.parse(res.json());
    expect(live).toMatchObject({
      day: today,
      worker: { alive: true, lastBeatAt: beat },
      online: 7,
      activeToday: 2,
      likesToday: 4,
      superlikesToday: 1,
      passesToday: 2,
      messagesToday: 5,
      callsLive: 1,
      signupsToday: 3,
      matchesToday: 2,
      callsToday: 1,
      callsAnsweredToday: 1,
      reportsToday: 1,
      queues: { photos: { count: 10_000, more: true }, texts: { count: 2, more: false }, reports: { count: 4, more: false }, urgentReports: { count: 1, more: false }, tickets: { count: 3, more: false } },
      providers: [
        { name: 'sms', ok: 3, failed: 1 },
        { name: 'push', ok: 2, failed: 0 },
        { name: 'store', ok: 0, failed: 0 },
      ],
      revenueToday: [
        { currency: 'IRR', amountMicros: '900000000000', estimated: true },
        { currency: 'USD', amountMicros: '5000000', estimated: false },
      ],
    });
    expect(live.streams).toHaveLength(3);

    const plain = adminStatsLiveSchema.parse((await get(moderator, '/v1/admin/stats/live')).json());
    expect(plain.revenueToday).toBeUndefined();
    expect(plain.likesToday).toBe(4);
  });

  it('reads a snapshot of another shape as none, one of yesterday for its queues only, and a missing beat as a stopped worker', async () => {
    const k = h.app.keys;
    await h.redis.set(k.statsLive(), '{"at": 1}', 'EX', 600);
    let live = adminStatsLiveSchema.parse((await get(superAdmin, '/v1/admin/stats/live')).json());
    expect(live).toMatchObject({ snapshotAt: null, queues: null, streams: null, jobs: null, signupsToday: null, online: null, activeToday: 3, revenueToday: [] });

    await h.redis.set(k.statsLive(), snapshot(back(1)), 'EX', 600);
    live = adminStatsLiveSchema.parse((await get(superAdmin, '/v1/admin/stats/live')).json());
    expect(live.signupsToday).toBeNull();
    expect(live.queues?.reports.count).toBe(4);
    expect(live.activeToday).toBe(3);

    await h.redis.del(k.workerHeartbeat());
    live = adminStatsLiveSchema.parse((await get(superAdmin, '/v1/admin/stats/live')).json());
    expect(live.worker).toEqual({ alive: false, lastBeatAt: null });
    // A stopped worker's figures are not shown as current.
    expect(live).toMatchObject({ snapshotAt: null, queues: null, streams: null, jobs: null, online: null });
  });

  it('shows no snapshot figures once the snapshot is older than 150 s or the worker is gone', async () => {
    const k = h.app.keys;
    const beat = () => h.redis.set(k.workerHeartbeat(), JSON.stringify({ at: new Date().toISOString(), workerId: 'w1' }), 'PX', 90_000);
    await beat();
    await h.redis.set(k.statsLive(), snapshot(today, { at: new Date(now - 180_000).toISOString() }), 'EX', 600);
    let live = adminStatsLiveSchema.parse((await get(superAdmin, '/v1/admin/stats/live')).json());
    expect(live.worker.alive).toBe(true);
    expect(live).toMatchObject({ snapshotAt: null, queues: null, streams: null, jobs: null, online: null, signupsToday: null, matchesToday: null, revenueToday: [] });

    await h.redis.set(k.statsLive(), snapshot(today), 'EX', 600);
    live = adminStatsLiveSchema.parse((await get(superAdmin, '/v1/admin/stats/live')).json());
    expect(live.signupsToday).toBe(3);
    expect(live.snapshotAt).not.toBeNull();

    await h.redis.del(k.workerHeartbeat());
    live = adminStatsLiveSchema.parse((await get(superAdmin, '/v1/admin/stats/live')).json());
    expect(live).toMatchObject({ snapshotAt: null, queues: null, signupsToday: null, online: null });
    await beat();
  });

  it('leaves test accounts out of today’s active people the moment they are marked', async () => {
    const k = h.app.keys;
    const day = utcDay(now);
    // The snapshot (a minute old) still counts one test account; the worker's id set knows two.
    await h.redis.set(k.statsLive(), snapshot(today, { testActive: 1 }), 'EX', 600);
    await h.redis.sadd(k.statsTestIds(), '13', '14');
    try {
      const before = adminStatsLiveSchema.parse((await get(superAdmin, '/v1/admin/stats/live')).json());
      expect(before.activeToday).toBe(2);
      // The second test account opens the app: nothing moves.
      await h.redis.sadd(k.activeDay(day), '14');
      const after = adminStatsLiveSchema.parse((await get(superAdmin, '/v1/admin/stats/live')).json());
      expect(after.activeToday).toBe(2);
      // An ordinary account does count.
      await h.redis.sadd(k.activeDay(day), '15');
      expect(adminStatsLiveSchema.parse((await get(superAdmin, '/v1/admin/stats/live')).json()).activeToday).toBe(3);
    } finally {
      await h.redis.srem(k.activeDay(day), '14', '15');
      await h.redis.del(k.statsTestIds());
    }
  });

  it('answers 503 when Valkey cannot be read', async () => {
    const pipeline = h.app.redis.pipeline.bind(h.app.redis);
    const broken = {
      get: () => broken,
      scard: () => broken,
      mget: () => broken,
      zcount: () => broken,
      exists: () => broken,
      sintercard: () => broken,
      exec: () => Promise.reject(new Error('valkey down')),
    };
    h.app.redis.pipeline = (() => broken) as unknown as typeof h.app.redis.pipeline;
    try {
      const res = await get(superAdmin, '/v1/admin/stats/live');
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
    } finally {
      h.app.redis.pipeline = pipeline;
    }
  });

  it('asks for a token, dashboard.read, and dashboard.revenue for money', async () => {
    expect((await get(null, '/v1/admin/stats/live')).statusCode).toBe(401);
    expect((await get(auditor, '/v1/admin/stats/live')).statusCode).toBe(403);
    expect((await get(auditor, `/v1/admin/stats/daily?metrics=dau&from=${back(7)}&to=${back(1)}`)).statusCode).toBe(403);
    for (const path of ['revenue', 'conversion']) {
      const url = `/v1/admin/stats/${path}?from=${back(7)}&to=${back(1)}`;
      const refused = await get(moderator, url);
      expect(refused.statusCode, path).toBe(403);
      expect(refused.json(), path).toMatchObject({ code: 'forbidden', reason: 'role', permissions: ['dashboard.revenue'] });
      expect((await get(analyst, url)).statusCode, path).toBe(200);
    }
    expect((await get(moderator, `/v1/admin/stats/moderation?from=${back(7)}&to=${back(1)}`)).statusCode).toBe(200);
  });

  it('checks ranges, metrics and currencies', async () => {
    const problem = async (url: string) => {
      const res = await get(superAdmin, url);
      expect(res.statusCode, url).toBe(400);
      const body = res.json<{ code: string; errors: { in: string; pointer: string; code: string }[] }>();
      expect(body.code).toBe('validation_failed');
      return body.errors[0]!;
    };
    expect(await problem(`/v1/admin/stats/retention?from=${back(1)}&to=${back(3)}`)).toMatchObject({ in: 'query', pointer: '/to', code: 'ends_before_start' });
    expect(await problem(`/v1/admin/stats/funnel?from=${back(400)}&to=${today}`)).toMatchObject({ pointer: '/from', code: 'invalid' });
    expect(await problem(`/v1/admin/stats/funnel?from=${back(1)}&to=${statsAddDays(today, 1)}`)).toMatchObject({ pointer: '/to' });
    expect(await problem(`/v1/admin/stats/daily?metrics=dau,nope&from=${back(7)}&to=${back(1)}`)).toMatchObject({ pointer: '/metrics' });
    const nine = 'dau,wau,mau,signups,likes,superlikes,passes,messages,matches';
    expect(await problem(`/v1/admin/stats/daily?metrics=${nine}&from=${back(7)}&to=${back(1)}`)).toMatchObject({ pointer: '/metrics' });
    expect(await problem(`/v1/admin/stats/revenue?from=${back(7)}&to=${back(1)}&currency=usd`)).toMatchObject({ pointer: '/currency' });
    // Days PostgreSQL cannot hold, and any day before the first one, are refused before a statement.
    for (const path of ['funnel', 'retention', 'daily?metrics=likes&', 'conversion', 'moderation']) {
      const url = `/v1/admin/stats/${path}${path.includes('?') ? '' : '?'}from=0000-01-01&to=0000-01-02`;
      expect(await problem(url)).toMatchObject({ pointer: '/from', code: 'invalid' });
    }
    expect(await problem(`/v1/admin/stats/revenue?from=0000-01-01&to=0000-01-02`)).toMatchObject({ pointer: '/from' });
    expect(await problem(`/v1/admin/stats/funnel?from=2019-12-31&to=2020-01-02`)).toMatchObject({ pointer: '/from' });
    expect(await problem(`/v1/admin/stats/places?day=0000-01-01`)).toMatchObject({ pointer: '/day', code: 'invalid' });
    expect(await problem(`/v1/admin/stats/places?by=country&day=2019-12-31`)).toMatchObject({ pointer: '/day' });
    expect((await get(superAdmin, `/v1/admin/stats/funnel?from=2020-01-01&to=2020-01-02`)).statusCode).toBe(200);
    expect((await get(superAdmin, `/v1/admin/stats/funnel?from=${back(399)}&to=${today}`)).statusCode).toBe(200);
  });

  it('reads daily series in one statement, the dims summed, a rolled-up day without a row as 0', async () => {
    await put([
      ['dau', back(2), '', 10],
      ['dau', back(1), '', 12],
      ['likes', back(1), '', 40],
      ['matches', back(1), '1', 3],
      ['matches', back(1), '2', 1],
      ['rollup', back(1), '', 1],
      // Rolled up with nothing counted (no calls, no likes): 0, not a gap. back(4) was never rolled up.
      ['rollup', back(3), '', 1],
    ]);
    const res = await get(superAdmin, `/v1/admin/stats/daily?metrics=dau,likes,matches,calls,dau&from=${back(7)}&to=${back(1)}`);
    expect(res.statusCode).toBe(200);
    expect(statements(res)).toBe(1);
    expect(adminStatsSeriesSchema.parse(res.json())).toEqual({
      from: back(7),
      to: back(1),
      lastDay: back(1),
      series: [
        // DAU is measured from the day's activity set: a day without it has no point.
        { metric: 'dau', points: [{ day: back(2), value: 10 }, { day: back(1), value: 12 }] },
        { metric: 'likes', points: [{ day: back(3), value: 0 }, { day: back(1), value: 40 }] },
        { metric: 'matches', points: [{ day: back(3), value: 0 }, { day: back(1), value: 4 }] },
        { metric: 'calls', points: [{ day: back(3), value: 0 }, { day: back(1), value: 0 }] },
      ],
    });
  });

  it('reads retention by cohort (null where not measured) and the cumulative sign-up steps', async () => {
    await put([
      ['signups', back(10), '', 5],
      ['ret_d1', back(10), '', 2],
      ['ret_d7', back(10), '', 0],
      ['signups', back(9), '', 3],
      ['signup_step', back(3), '0', 2],
      ['signup_step', back(3), '12', 1],
      ['signup_step', back(3), '30', 4],
      ['signups', back(3), '', 7],
      ['signup_refused', back(3), '', 1],
    ]);
    const retention = await get(superAdmin, `/v1/admin/stats/retention?from=${back(10)}&to=${back(9)}`);
    expect(statements(retention)).toBe(1);
    expect(adminStatsRetentionSchema.parse(retention.json()).cohorts).toEqual([
      { day: back(10), signups: 5, d1: 2, d7: 0, d30: null },
      { day: back(9), signups: 3, d1: null, d7: null, d30: null },
    ]);
    const funnel = await get(superAdmin, `/v1/admin/stats/funnel?from=${back(3)}&to=${back(3)}`);
    expect(statements(funnel)).toBe(1);
    const body = adminStatsFunnelSchema.parse(funnel.json());
    expect(body.signups).toBe(7);
    expect(body.refusedUnderAge).toBe(1);
    const reached = Object.fromEntries(body.stages.map((s) => [s.stage, s.reached]));
    expect(reached).toMatchObject({ started: 7, privacy: 5, intention: 5, photos: 4, done: 4 });
  });

  it('lists places with their names, withheld cells as null (Other’s too), the rest under Other', async () => {
    const city = h.app.cities.search('Tehran', 'en', 'IR')[0]!;
    await put([
      ['active_city', back(1), `${city.id}:1`, 7],
      ['active_city', back(1), `${city.id}:2`, 6],
      ['active_city', back(1), '0:1', 13],
      ['active_country', back(1), 'TR:1', 20],
      ['active_country', back(1), 'TR:2', 10],
    ]);
    const cities = await get(superAdmin, '/v1/admin/stats/places?by=city');
    expect(statements(cities)).toBe(1);
    const body = adminStatsPlacesSchema.parse(cities.json());
    expect(body.day).toBe(back(1));
    expect(body.kind).toBe('city');
    expect(body.places).toHaveLength(1);
    expect(body.places[0]).toMatchObject({ code: String(city.id), country: 'IR', women: 7, men: 6, nonBinary: null, total: 13 });
    expect(body.places[0]!.names?.en.length).toBeGreaterThan(0);
    expect(body.places[0]!.names?.fa.length).toBeGreaterThan(0);
    // Other's men and non-binary cells were withheld (no row): null, never 0 or a number to subtract from.
    expect(body.other).toEqual({ women: 13, men: null, nonBinary: null, total: 13 });
    const countries = adminStatsPlacesSchema.parse((await get(superAdmin, `/v1/admin/stats/places?by=country&day=${back(1)}`)).json());
    expect(countries.places).toEqual([{ code: 'TR', country: 'TR', women: 20, men: 10, nonBinary: null, total: 30 }]);
    expect(countries.other).toEqual({ women: null, men: null, nonBinary: null, total: 0 });

    // Past the top 50, a place's cells join Other only where Other's own cell is published.
    await put([
      ...Array.from({ length: 50 }, (_, i) => ['active_city', back(2), `${900_001 + i}:1`, 20] as [string, string, string, number]),
      ['active_city', back(2), `${city.id}:1`, 7],
      ['active_city', back(2), `${city.id}:2`, 6],
      ['active_city', back(2), '0:1', 13],
    ]);
    const folded = adminStatsPlacesSchema.parse((await get(superAdmin, `/v1/admin/stats/places?by=city&day=${back(2)}`)).json());
    expect(folded.places).toHaveLength(50);
    expect(folded.places.map((p) => p.code)).not.toContain(String(city.id));
    expect(folded.other).toEqual({ women: 20, men: null, nonBinary: null, total: 20 });
  });

  it('reads revenue in one currency with catalogue names, kept per newest day', async () => {
    const product = async (store: number, productId: string, basePlan: string | null) =>
      (
        await row<{ id: number }>(db, `SELECT id FROM store_products WHERE store = $1 AND product_id = $2 AND base_plan_id IS NOT DISTINCT FROM $3`, [
          store,
          productId,
          basePlan,
        ])
      ).id;
    const plus = await product(1, 'sub.plus', 'm1');
    const premium = await product(2, 'sub.premium.3m', null);
    const cube = [
      [back(2), 1, plus, 'TR', 'USD', '10000000', '5000000', 2, 1, 2, false],
      [back(1), 2, premium, 'IR', 'IRR', '300000000000', '0', 1, 0, 1, true],
      [back(1), 1, 999, 'TR', 'USD', '1000000', '0', 1, 0, 0, false],
    ] as const;
    for (const [day, store, ref, region, currency, gross, refund, payments, refunds, newSubs, estimated] of cube) {
      await db.sql.query(
        `INSERT INTO stats_revenue_daily (day, store, product_ref, region, currency, gross_micros, refund_micros, payments, refunds, new_subs, estimated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [day, store, ref, region, currency, gross, refund, payments, refunds, newSubs, estimated],
      );
    }
    await put([
      ['mrr', back(1), '1:USD', 5_000_000],
      ['mrr', back(1), '2:IRR', 100_000_000_000],
      ['subs', back(1), '1:2', 2],
      ['subs_renewing', back(1), '1:2', 1],
      ['churn', back(1), '1:2', 1],
      ['cancels', back(2), '1:2', 1],
    ]);
    const url = `/v1/admin/stats/revenue?from=${back(7)}&to=${back(1)}`;
    // The permission test read this range before the rows existed: that answer is kept under the newest day it saw.
    await h.redis.set(h.app.keys.statsLastDay(), back(2));
    const first = await get(analyst, url);
    expect(first.statusCode).toBe(200);
    expect(statements(first)).toBe(1);
    // Amounts of different currencies are never compared: the default is the currency with the most payments.
    const auto = adminStatsRevenueSchema.parse(first.json());
    expect(auto.currency).toBe('USD');
    expect(auto.currencies.map((c) => c.currency)).toEqual(['USD', 'IRR']);
    const irr = adminStatsRevenueSchema.parse((await get(analyst, `${url}&currency=IRR`)).json());
    expect(irr.currency).toBe('IRR');
    expect(irr.estimated).toBe(true);
    expect(irr.byStore).toEqual([{ store: 'bazaar', grossMicros: '300000000000', refundMicros: '0', payments: 1 }]);
    expect(irr.byProduct).toEqual([
      { productRef: premium, productId: 'sub.premium.3m', store: 'bazaar', kind: 'subscription', plan: 'premium', period: 'P3M', grossMicros: '300000000000', payments: 1 },
    ]);
    expect(irr.mrr).toEqual([{ day: back(1), micros: '100000000000' }]);
    expect(irr.subscriptions).toEqual([{ day: back(1), active: 2, renewing: 1 }]);
    expect(irr.churn).toEqual([
      { day: back(2), ended: 0, cancelled: 1 },
      { day: back(1), ended: 1, cancelled: 0 },
    ]);

    // The same read again: from kv-cache, no statement.
    const again = await get(analyst, url);
    expect(statements(again)).toBe(0);
    expect(again.json()).toEqual(first.json());
    // A new newest day reads again.
    await h.redis.set(h.app.keys.statsLastDay(), back(1));
    expect(statements(await get(analyst, url))).toBe(1);

    const usd = adminStatsRevenueSchema.parse((await get(superAdmin, `${url}&currency=USD`)).json());
    expect(usd.currency).toBe('USD');
    expect(usd.estimated).toBe(false);
    expect(usd.days.map((d) => [d.day, d.grossMicros, d.refundMicros])).toEqual([
      [back(2), '10000000', '5000000'],
      [back(1), '1000000', '0'],
    ]);
    expect(usd.byProduct.map((p) => p.productId)).toEqual(['sub.plus', '?']);
    expect(usd.byCountry).toEqual([{ region: 'TR', grossMicros: '11000000', payments: 3 }]);
    expect(usd.mrr).toEqual([{ day: back(1), micros: '5000000' }]);
  });

  it('reads conversion by cohort, measurable once the window has passed', async () => {
    await put([
      ['signups', back(40), '', 10],
      ['conv_d7', back(40), '1', 1],
      ['conv_d30', back(40), '1', 2],
      ['conv_d30', back(40), '2', 1],
      ['signups', back(3), '', 4],
      ['conv_d7', back(3), '1', 1],
    ]);
    const old = adminStatsConversionSchema.parse((await get(analyst, `/v1/admin/stats/conversion?from=${back(40)}&to=${back(40)}`)).json());
    expect(old.cohorts).toEqual([{ day: back(40), signups: 10, d7: { play: 1, bazaar: 0, total: 1 }, d30: { play: 2, bazaar: 1, total: 3 } }]);
    const young = await get(analyst, `/v1/admin/stats/conversion?from=${back(3)}&to=${back(3)}`);
    expect(statements(young)).toBe(1);
    expect(adminStatsConversionSchema.parse(young.json()).cohorts).toEqual([{ day: back(3), signups: 4, d7: null, d30: null }]);
  });

  it('reads moderator decisions with their names, overturn rate and median wait', async () => {
    const m1 = (await row<{ id: number }>(db, `INSERT INTO admin_users (email, display_name) VALUES ('m1@example.com', 'Mod One') RETURNING id`)).id;
    const m2 = (await row<{ id: number }>(db, `INSERT INTO admin_users (email, display_name, disabled_at) VALUES ('m2@example.com', 'Mod Two', now()) RETURNING id`)).id;
    const rowsIn: [string, number, number, number, number, number, number, number, number | null, number][] = [
      [back(2), m1, 3, 1, 0, 1, 1, 3, 7200, 0],
      [back(1), m1, 1, 1, 0, 0, 0, 1, 100, 0],
      [back(1), m2, 2, 0, 2, 0, 0, 0, null, 1],
    ];
    for (const r of rowsIn) {
      await db.sql.query(
        `INSERT INTO stats_moderation_daily (day, admin_id, decisions, photos, texts, reports, appeals, timed, response_p50_s, overturned)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        r,
      );
    }
    const res = await get(moderator, `/v1/admin/stats/moderation?from=${back(7)}&to=${back(1)}`);
    expect(statements(res)).toBe(1);
    const body = adminStatsModerationSchema.parse(res.json());
    expect(body.moderators).toEqual([
      { admin: { id: String(m1), displayName: 'Mod One' }, decisions: 4, photos: 2, texts: 0, reports: 1, appeals: 1, overturned: 0, overturnRate: 0, responseMedianS: 7200 },
      { admin: { id: String(m2), displayName: 'Mod Two' }, decisions: 2, photos: 0, texts: 2, reports: 0, appeals: 0, overturned: 1, overturnRate: 0.5, responseMedianS: null },
    ]);
    // Whether an admin account is disabled is the admins page's (admins.read), never this card's.
    for (const m of res.json<{ moderators: { admin: Record<string, unknown> }[] }>().moderators) expect(Object.keys(m.admin).sort()).toEqual(['displayName', 'id']);
    expect(res.body).not.toMatch(/disabled/i);
    expect(body.days).toEqual([
      { day: back(2), decisions: 3 },
      { day: back(1), decisions: 3 },
    ]);
  });
});
