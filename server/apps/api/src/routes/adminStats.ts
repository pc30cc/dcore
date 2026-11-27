import { statsCohortRows, statsModeration, statsPlaces, statsRevenue, statsSeries } from '@app/db';
import {
  STATS_FIRST_DAY,
  STATS_MAX_DAYS,
  STATS_MAX_METRICS,
  STATS_PLACES_TOP,
  STATS_REVENUE_CACHE_SECONDS,
  STATS_REVENUE_COUNTRIES_TOP,
  adminStatsConversionSchema,
  adminStatsDailyQuerySchema,
  adminStatsFunnelSchema,
  adminStatsLiveSchema,
  adminStatsModerationSchema,
  adminStatsPlacesQuerySchema,
  adminStatsPlacesSchema,
  adminStatsRangeQuerySchema,
  adminStatsRetentionSchema,
  adminStatsRevenueQuerySchema,
  adminStatsRevenueSchema,
  adminStatsSeriesSchema,
  providerHealth,
  providerHealthNames,
  signupStages,
  statsAddDays,
  statsCounterNames,
  statsDay,
  statsDaysBetween,
  statsSeriesMetrics,
  store as storeCodes,
  wireTime,
  type AdminStatsLive,
  type AdminStatsRevenue,
  type AppStore,
  type StatsCounterName,
  type StatsSeriesMetric,
} from '@app/shared';
import { callKeys, statsLiveSnapshotSchema, utcDay } from '@app/shared/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { z } from 'zod';
import { adminForbidden } from '../admin/problems.js';
import { callerMay } from '../admin/refs.js';
import { HttpProblem } from '../lib/problem.js';

/**
 * The dashboard and the statistics (`dashboard.read`; money with
 * `dashboard.revenue` too):
 *
 *   GET /v1/admin/stats/live         0 statements: the worker's snapshot plus the day counters in Valkey
 *   GET /v1/admin/stats/daily        ?metrics&from&to: one value per metric and day
 *   GET /v1/admin/stats/retention    ?from&to (sign-up days): day 1, 7 and 30 retention
 *   GET /v1/admin/stats/funnel       ?from&to (sign-up days): the furthest step reached
 *   GET /v1/admin/stats/places       ?by=city|country&day: active profiles by place and gender
 *   GET /v1/admin/stats/revenue      ?from&to&currency (dashboard.revenue): kept 5 minutes per newest day
 *   GET /v1/admin/stats/conversion   ?from&to (dashboard.revenue): paying within 7 and 30 days of signing up
 *   GET /v1/admin/stats/moderation   ?from&to: queue decisions per admin
 *
 * Every read but `live` is one statement (a primary-key prefix of the
 * stats tables). Days are UTC; a range is at most 400 days, starts no
 * earlier than STATS_FIRST_DAY and ends no later than today. Aggregates
 * only, read by nobody but these routes: no audit row. Valkey down on
 * `live` answers 503.
 */

type Query = z.infer<typeof adminStatsRangeQuerySchema>;

function badQuery(pointer: string, code: 'invalid' | 'ends_before_start', message: string): HttpProblem {
  return new HttpProblem('validation_failed', { detail: message, errors: [{ in: 'query', pointer, code, message }] });
}

/** The range checked against today (UTC). */
export function checkRange(query: Query, now: number): Query {
  const today = statsDay(now);
  if (query.from > query.to) throw badQuery('/to', 'ends_before_start', 'The end comes before the start.');
  if (query.from < STATS_FIRST_DAY) throw badQuery('/from', 'invalid', `No statistics before ${STATS_FIRST_DAY}.`);
  if (statsDaysBetween(query.from, query.to) > STATS_MAX_DAYS) throw badQuery('/from', 'invalid', `At most ${STATS_MAX_DAYS} days.`);
  if (query.to > today) throw badQuery('/to', 'invalid', 'The range ends after today.');
  return query;
}

function daysOf(from: string, to: string): string[] {
  return Array.from({ length: statsDaysBetween(from, to) }, (_, i) => statsAddDays(from, i));
}

function noStore(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
}

function requireRevenue(app: FastifyInstance, request: FastifyRequest): void {
  if (!callerMay(app, request, 'dashboard.revenue')) throw adminForbidden('role', 'Revenue figures need dashboard.revenue.', { permissions: ['dashboard.revenue'] });
}

const cap = (n: number, limit: number) => ({ count: Math.min(n, limit), more: n > limit });

/**
 * A snapshot older than this, or one without a living worker, is not shown:
 * the live job writes one a minute, and the heartbeat lives 90 s, so a
 * stopped worker's figures go within 90 s.
 */
export const STATS_SNAPSHOT_FRESH_MS = 150_000;

/** Metrics measured from the `la:` sets: a rolled-up day without a row was not measured (the others read 0). */
const MEASURED_ONLY: ReadonlySet<StatsSeriesMetric> = new Set(['dau', 'wau', 'mau']);

function storeName(code: number): AppStore {
  const name = storeCodes.nameOrUndefined(code);
  return name === 'bazaar' ? 'bazaar' : 'play';
}

async function live(app: FastifyInstance, request: FastifyRequest, now: number): Promise<AdminStatsLive> {
  const day = utcDay(now);
  const pipeline = app.redis
    .pipeline()
    .get(app.keys.statsLive())
    .scard(app.keys.activeDay(day))
    .mget(...statsCounterNames.map((name) => app.keys.statsCounter(name, day)))
    .zcount(callKeys(app.keys).live(), now, '+inf')
    .get(app.keys.workerHeartbeat())
    .exists(app.keys.statsTestIds())
    .sintercard(2, app.keys.activeDay(day), app.keys.statsTestIds());
  let replies: [Error | null, unknown][];
  try {
    replies = (await pipeline.exec()) ?? [];
    const failed = replies.find(([error]) => error !== null);
    if (failed || replies.length < 7) throw failed?.[0] ?? new Error('no answer');
  } catch (error) {
    throw new HttpProblem('service_unavailable', { detail: 'Valkey cannot be read.', headers: { 'retry-after': '5' }, cause: error });
  }
  const [snapshotRaw, active, counterValues, callsLive, beatRaw, testIdsKept, testActiveNow] = replies.map(([, value]) => value);
  const counters = new Map<StatsCounterName, number>(
    statsCounterNames.map((name, i) => [name, Math.max(0, Number((counterValues as (string | null)[])[i] ?? 0) || 0)]),
  );
  let snapshot: z.infer<typeof statsLiveSnapshotSchema> | null = null;
  if (typeof snapshotRaw === 'string') {
    try {
      const parsed = statsLiveSnapshotSchema.safeParse(JSON.parse(snapshotRaw));
      if (parsed.success) snapshot = parsed.data;
    } catch {
      snapshot = null;
    }
  }
  let lastBeatAt: string | null = null;
  if (typeof beatRaw === 'string') {
    try {
      const at = (JSON.parse(beatRaw) as { at?: unknown }).at;
      if (typeof at === 'string' && Number.isFinite(Date.parse(at))) lastBeatAt = wireTime(Date.parse(at));
    } catch {
      lastBeatAt = null;
    }
  }
  const today = statsDay(now);
  // Figures of a worker that is gone, or of a live job that stopped writing, are not shown as current.
  const snapshotMs = snapshot ? Date.parse(snapshot.at) : Number.NaN;
  if (snapshot && (lastBeatAt === null || !Number.isFinite(snapshotMs) || now - snapshotMs > STATS_SNAPSHOT_FRESH_MS)) snapshot = null;
  // A snapshot written before midnight still tells the queues, not today's counts.
  const sameDay = snapshot?.day === today ? snapshot : null;
  // The test accounts of today's set, exact at this moment (the worker keeps their ids); else the snapshot's count.
  const testActive = Number(testIdsKept ?? 0) > 0 ? Math.max(0, Number(testActiveNow ?? 0)) : (sameDay?.testActive ?? 0);
  const answer: AdminStatsLive = {
    at: wireTime(now),
    day: today,
    snapshotAt: snapshot ? wireTime(snapshotMs) : null,
    worker: { alive: lastBeatAt !== null, lastBeatAt },
    online: snapshot?.online ?? null,
    activeToday: Math.max(0, Number(active ?? 0) - testActive),
    likesToday: counters.get('like') ?? 0,
    superlikesToday: counters.get('superlike') ?? 0,
    passesToday: counters.get('pass') ?? 0,
    messagesToday: counters.get('msg') ?? 0,
    callsLive: Math.max(0, Number(callsLive ?? 0)),
    signupsToday: sameDay?.db.signups ?? null,
    matchesToday: sameDay?.db.matches ?? null,
    callsToday: sameDay?.db.calls ?? null,
    callsAnsweredToday: sameDay?.db.callsAnswered ?? null,
    reportsToday: sameDay?.db.reports ?? null,
    queues: snapshot
      ? {
          photos: cap(snapshot.db.photos, 10_000),
          texts: cap(snapshot.db.texts, 10_000),
          reports: cap(snapshot.db.reportsOpen, 10_000),
          urgentReports: cap(snapshot.db.reportsUrgent, 10_000),
          appeals: cap(snapshot.db.appeals, 10_000),
          tickets: cap(snapshot.db.tickets, 10_000),
        }
      : null,
    streams: snapshot?.streams ?? null,
    jobs: snapshot?.jobs ?? null,
    providers: providerHealthNames.map((name) => ({
      name,
      ok: counters.get(providerHealth[name].ok) ?? 0,
      failed: counters.get(providerHealth[name].failed) ?? 0,
    })),
  };
  if (callerMay(app, request, 'dashboard.revenue')) {
    // By currency code: amounts of different currencies are never compared.
    answer.revenueToday = (sameDay?.db.revenue ?? [])
      .map((r) => ({ currency: r.currency, amountMicros: r.micros, estimated: r.estimated }))
      .sort((a, b) => a.currency.localeCompare(b.currency));
  }
  return answer;
}

function metricsOf(text: string): StatsSeriesMetric[] {
  const names = [...new Set(text.split(',').map((m) => m.trim()).filter((m) => m.length > 0))];
  if (names.length === 0 || names.length > STATS_MAX_METRICS) throw badQuery('/metrics', 'invalid', `Between 1 and ${STATS_MAX_METRICS} metrics.`);
  for (const name of names) {
    if (!(statsSeriesMetrics as readonly string[]).includes(name)) throw badQuery('/metrics', 'invalid', 'Not a statistic.');
  }
  return names as StatsSeriesMetric[];
}

/** The weighted median of daily medians: [value, weight] pairs. */
export function weightedMedian(pairs: readonly (readonly [number, number])[]): number | null {
  const kept = pairs.filter(([, w]) => w > 0).sort((a, b) => a[0] - b[0]);
  const total = kept.reduce((sum, [, w]) => sum + w, 0);
  if (total === 0) return null;
  let seen = 0;
  for (const [value, weight] of kept) {
    seen += weight;
    if (seen * 2 >= total) return value;
  }
  return kept.at(-1)![0];
}

export const adminStatsRoutes: FastifyPluginAsyncZod<{ now?: (() => number) | undefined }> = async (app, options) => {
  const now = options.now ?? Date.now;
  const tags = ['admin'];
  const read = app.requirePermission('dashboard.read');

  app.get(
    '/v1/admin/stats/live',
    {
      preHandler: read,
      config: { pgBudget: 0 },
      schema: { tags, summary: 'The live dashboard: today’s figures, the review queues and the background service', response: { 200: adminStatsLiveSchema } },
    },
    async (request, reply) => {
      noStore(reply);
      return live(app, request, now());
    },
  );

  app.get(
    '/v1/admin/stats/daily',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Daily statistics by metric', querystring: adminStatsDailyQuerySchema, response: { 200: adminStatsSeriesSchema } },
    },
    async (request, reply) => {
      const { from, to } = checkRange(request.query, now());
      const metrics = metricsOf(request.query.metrics);
      noStore(reply);
      const { lastDay, rows, rolledUp } = await statsSeries(app.pg, metrics, from, to);
      return {
        from,
        to,
        lastDay,
        series: metrics.map((metric) => {
          const values = new Map(rows.filter((r) => r.metric === metric).map((r) => [r.day, Math.max(0, Math.round(r.value))]));
          // A day the rollup finished counted every event it had: no row is 0. The la: measures are not filled.
          if (!MEASURED_ONLY.has(metric)) for (const day of rolledUp) if (!values.has(day)) values.set(day, 0);
          return { metric, points: [...values.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, value]) => ({ day, value })) };
        }),
      };
    },
  );

  app.get(
    '/v1/admin/stats/retention',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Day 1, 7 and 30 retention by sign-up day', querystring: adminStatsRangeQuerySchema, response: { 200: adminStatsRetentionSchema } },
    },
    async (request, reply) => {
      const { from, to } = checkRange(request.query, now());
      noStore(reply);
      const { lastDay, rows } = await statsCohortRows(app.pg, ['signups', 'ret_d1', 'ret_d7', 'ret_d30'], from, to);
      const value = (metric: string, day: string) => rows.find((r) => r.metric === metric && r.day === day)?.value;
      return {
        from,
        to,
        lastDay,
        cohorts: daysOf(from, to).map((day) => ({
          day,
          signups: value('signups', day) ?? 0,
          d1: value('ret_d1', day) ?? null,
          d7: value('ret_d7', day) ?? null,
          d30: value('ret_d30', day) ?? null,
        })),
      };
    },
  );

  app.get(
    '/v1/admin/stats/funnel',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Sign-up steps reached by the sign-ups of the range', querystring: adminStatsRangeQuerySchema, response: { 200: adminStatsFunnelSchema } },
    },
    async (request, reply) => {
      const { from, to } = checkRange(request.query, now());
      noStore(reply);
      const { lastDay, rows } = await statsCohortRows(app.pg, ['signup_step', 'signups', 'signup_refused'], from, to);
      const sum = (metric: string, keep: (dim: string) => boolean = () => true) =>
        rows.filter((r) => r.metric === metric && keep(r.dim ?? '')).reduce((total, r) => total + r.value, 0);
      return {
        from,
        to,
        lastDay,
        signups: sum('signups'),
        refusedUnderAge: sum('signup_refused'),
        stages: signupStages.map((stage) => ({ stage: stage.key, reached: sum('signup_step', (dim) => Number(dim) >= stage.from) })),
      };
    },
  );

  app.get(
    '/v1/admin/stats/places',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Active profiles by city or country and gender', querystring: adminStatsPlacesQuerySchema, response: { 200: adminStatsPlacesSchema } },
    },
    async (request, reply) => {
      const { by, day: asked } = request.query;
      if (asked !== undefined && asked > statsDay(now())) throw badQuery('/day', 'invalid', 'The day is after today.');
      if (asked !== undefined && asked < STATS_FIRST_DAY) throw badQuery('/day', 'invalid', `No statistics before ${STATS_FIRST_DAY}.`);
      noStore(reply);
      const { day, cells } = await statsPlaces(app.pg, by === 'city' ? 'active_city' : 'active_country', asked ?? null);
      // An Other cell without a row was withheld (or is 0): it stays null, and places past the top are not added to it.
      const other: { women: number | null; men: number | null; nonBinary: number | null; total: number } = { women: null, men: null, nonBinary: null, total: 0 };
      const places = new Map<string, { women: number | null; men: number | null; nonBinary: number | null; total: number }>();
      const field = { 1: 'women', 2: 'men', 3: 'nonBinary' } as const;
      for (const { dim, value } of cells) {
        const [code, genderText] = dim.split(':');
        const gender = Number(genderText) as 1 | 2 | 3;
        const name = field[gender];
        if (!code || !name) continue;
        if (code === '0' || code === 'ZZ') {
          other[name] = (other[name] ?? 0) + value;
          other.total += value;
          continue;
        }
        const place = places.get(code) ?? { women: null, men: null, nonBinary: null, total: 0 };
        place[name] = value;
        place.total += value;
        places.set(code, place);
      }
      const listed = [...places.entries()]
        .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
        .slice(0, STATS_PLACES_TOP)
        .map(([code, counts]) => {
          if (by === 'country') return { code, country: code, ...counts };
          const city = app.cities.get(Number(code));
          return { code, country: city?.country ?? 'ZZ', ...(city ? { names: { en: city.en || city.name, fa: city.fa || city.en || city.name, tr: city.tr || city.en || city.name } } : {}), ...counts };
        });
      // Places past the top 50 are counted in "other" too.
      const shown = new Set(listed.map((p) => p.code));
      for (const [, counts] of [...places.entries()].filter(([code]) => !shown.has(code))) {
        for (const name of ['women', 'men', 'nonBinary'] as const) {
          const value = counts[name];
          if (value === null || other[name] === null) continue;
          other[name] += value;
          other.total += value;
        }
      }
      return { day, kind: by, windowDays: 7 as const, places: listed, other };
    },
  );

  app.get(
    '/v1/admin/stats/revenue',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Revenue, subscriptions and churn in one currency', querystring: adminStatsRevenueQuerySchema, response: { 200: adminStatsRevenueSchema } },
    },
    async (request, reply) => {
      requireRevenue(app, request);
      const { from, to } = checkRange(request.query, now());
      const currency = request.query.currency ?? null;
      if (currency !== null && !/^[A-Z]{3}$/.test(currency)) throw badQuery('/currency', 'invalid', 'Not an ISO 4217 code.');
      noStore(reply);
      // Kept per newest rolled-up day: a new day's rollup makes a new key.
      const last = await app.redis.get(app.keys.statsLastDay()).catch(() => null);
      const key = app.keys.statsRevenue(last ?? 'none', from, to, currency ?? 'auto');
      const cached = await app.cache.get(key).catch(() => null);
      if (cached !== null) {
        try {
          const parsed = adminStatsRevenueSchema.safeParse(JSON.parse(cached));
          if (parsed.success) return parsed.data;
        } catch {
          // A value of another shape is read again.
        }
      }
      const r = await statsRevenue(app.pg, from, to, currency, STATS_REVENUE_COUNTRIES_TOP);
      const catalog = app.store.catalog();
      const plans = app.cfg.get().plans;
      const answer: AdminStatsRevenue = {
        from,
        to,
        lastDay: r.lastDay,
        currencies: r.currencies.map((c) => ({ currency: c.currency, grossMicros: c.gross })),
        currency: r.currency,
        estimated: r.estimated,
        days: r.days.map((d) => ({ day: d.day, grossMicros: d.gross, refundMicros: d.refund, payments: d.payments, refunds: d.refunds, newSubs: d.newSubs })),
        byStore: r.byStore.map((s) => ({ store: storeName(s.store), grossMicros: s.gross, refundMicros: s.refund, payments: s.payments })),
        byProduct: r.byProduct.map((p) => {
          const row = catalog.product(p.productRef);
          const plan = row?.planId === null || row?.planId === undefined ? undefined : plans.find((candidate) => candidate.id === row.planId)?.key;
          return {
            productRef: p.productRef,
            productId: row?.productId ?? '?',
            store: storeName(p.store),
            ...(row ? { kind: row.kind === 1 ? ('subscription' as const) : ('consumable' as const) } : {}),
            ...(plan ? { plan } : {}),
            ...(row?.period ? { period: row.period } : {}),
            grossMicros: p.gross,
            payments: p.payments,
          };
        }),
        byCountry: r.byCountry.map((c) => ({ region: c.region, grossMicros: c.gross, payments: c.payments })),
        mrr: r.mrr.map((m) => ({ day: m.day, micros: m.micros })),
        subscriptions: r.subscriptions,
        churn: r.churn,
      };
      await app.cache.set(key, JSON.stringify(answer), 'EX', STATS_REVENUE_CACHE_SECONDS).catch((error: unknown) => request.log.debug({ err: error }, 'revenue not cached'));
      return answer;
    },
  );

  app.get(
    '/v1/admin/stats/conversion',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Sign-ups paying within 7 and 30 days, by sign-up day', querystring: adminStatsRangeQuerySchema, response: { 200: adminStatsConversionSchema } },
    },
    async (request, reply) => {
      requireRevenue(app, request);
      const { from, to } = checkRange(request.query, now());
      noStore(reply);
      const { lastDay, rows } = await statsCohortRows(app.pg, ['signups', 'conv_d7', 'conv_d30'], from, to);
      const of = (metric: string, day: string) => {
        const play = rows.find((r) => r.metric === metric && r.day === day && r.dim === String(storeCodes.code('play')))?.value ?? 0;
        const bazaar = rows.find((r) => r.metric === metric && r.day === day && r.dim === String(storeCodes.code('bazaar')))?.value ?? 0;
        return { play, bazaar, total: play + bazaar };
      };
      return {
        from,
        to,
        lastDay,
        cohorts: daysOf(from, to).map((day) => ({
          day,
          signups: rows.find((r) => r.metric === 'signups' && r.day === day)?.value ?? 0,
          d7: lastDay !== null && lastDay >= statsAddDays(day, 6) ? of('conv_d7', day) : null,
          d30: lastDay !== null && lastDay >= statsAddDays(day, 29) ? of('conv_d30', day) : null,
        })),
      };
    },
  );

  app.get(
    '/v1/admin/stats/moderation',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Queue decisions per admin: count, median wait, overturns', querystring: adminStatsRangeQuerySchema, response: { 200: adminStatsModerationSchema } },
    },
    async (request, reply) => {
      const { from, to } = checkRange(request.query, now());
      noStore(reply);
      const m = await statsModeration(app.pg, from, to);
      return {
        from,
        to,
        lastDay: m.lastDay,
        moderators: m.moderators.map((row) => ({
          admin: { id: String(row.adminId), displayName: row.displayName ?? '' },
          decisions: row.decisions,
          photos: row.photos,
          texts: row.texts,
          reports: row.reports,
          appeals: row.appeals,
          overturned: row.overturned,
          overturnRate: row.decisions > 0 ? row.overturned / row.decisions : null,
          responseMedianS: weightedMedian(row.medians),
        })),
        days: m.days,
      };
    },
  );
};
