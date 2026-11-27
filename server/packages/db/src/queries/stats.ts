import { z } from 'zod';
import { many, one, sql } from '../query.js';
import { defineQuery } from './define.js';

/**
 * The dashboard's statistics (migration 0035). The worker writes them
 * (`stats_*` functions, EXECUTE for app_maint only); the API reads them, one
 * statement per chart, each a primary-key prefix of `stats_daily`,
 * `stats_revenue_daily` or `stats_moderation_daily`. Every reader also
 * answers `lastDay`, the newest day the rollup finished (the `rollup`
 * marker), in the same statement.
 */

const LAST_DAY = sql`(SELECT s.day::text FROM stats_daily s WHERE s.metric = 'rollup' ORDER BY s.day DESC LIMIT 1)`;

// ─── Worker ───────────────────────────────────────────────────────────────

/** Raw ids of test accounts (users_test_idx), at most `limit`. */
export const testAccountIds = defineQuery({ name: 'stats.testAccounts', statements: 1 }, async (db, limit = 10_001) => {
  const rows = await many<{ id: string }>(db, sql`SELECT u.id::text AS id FROM users u WHERE (u.flags & 1) <> 0 ORDER BY u.id LIMIT ${limit}`);
  return rows.map((r) => r.id);
});

const liveSchema = z.object({
  day: z.string(),
  signups: z.number().int(),
  matches: z.number().int(),
  calls: z.number().int(),
  callsAnswered: z.number().int(),
  reports: z.number().int(),
  photos: z.number().int(),
  texts: z.number().int(),
  reportsOpen: z.number().int(),
  reportsUrgent: z.number().int(),
  appeals: z.number().int(),
  tickets: z.number().int(),
  revenue: z.array(z.object({ currency: z.string(), micros: z.string(), estimated: z.boolean() })),
});
export type StatsLiveCounts = z.infer<typeof liveSchema>;

/** Today's counts and the review queues, each queue up to `cap + 1` (`stats_live`). */
export const statsLive = defineQuery({ name: 'stats.live', statements: 1 }, async (db, cap: number) => {
  const row = await one<{ v: unknown }>(db, sql`SELECT stats_live(${cap}::integer) AS v`);
  return liveSchema.parse(row.v);
});

export interface StatsRow {
  metric: string;
  /** `YYYY-MM-DD`. */
  day: string;
  dim?: string | undefined;
  value: number;
}

/** Upserts rows of stats_daily (`stats_put`); the rows that changed. */
export const statsPut = defineQuery({ name: 'stats.put', statements: 1 }, async (db, rows: readonly StatsRow[]) => {
  const row = await one<{ n: number }>(db, sql`SELECT stats_put(${JSON.stringify(rows)}::jsonb) AS n`);
  return row.n;
});

/** The days of [from, to] the rollup finished (the `rollup` marker). */
export const statsRolledUpDays = defineQuery({ name: 'stats.rolledUp', statements: 1 }, async (db, from: string, to: string) => {
  const rows = await many<{ day: string }>(
    db,
    sql`SELECT s.day::text AS day FROM stats_daily s WHERE s.metric = 'rollup' AND s.day BETWEEN ${from}::date AND ${to}::date ORDER BY s.day`,
  );
  return rows.map((r) => r.day);
});

const rolled = z.object({ rows: z.number().int() });

export const statsRollupPeople = defineQuery({ name: 'stats.rollupPeople', statements: 1 }, async (db, day: string) => {
  const row = await one<{ v: unknown }>(db, sql`SELECT stats_rollup_people(${day}::date) AS v`);
  return rolled.parse(row.v).rows;
});

export const statsRollupSocial = defineQuery({ name: 'stats.rollupSocial', statements: 1 }, async (db, day: string) => {
  const row = await one<{ v: unknown }>(db, sql`SELECT stats_rollup_social(${day}::date) AS v`);
  return rolled.parse(row.v).rows;
});

/** `snapshot`: also the subscriptions held and MRR (the newest day only). */
export const statsRollupMoney = defineQuery({ name: 'stats.rollupMoney', statements: 1 }, async (db, day: string, snapshot: boolean) => {
  const row = await one<{ v: unknown }>(db, sql`SELECT stats_rollup_money(${day}::date, ${snapshot}::boolean) AS v`);
  return rolled.parse(row.v).rows;
});

export const statsRollupPlaces = defineQuery({ name: 'stats.rollupPlaces', statements: 1 }, async (db, day: string) => {
  const row = await one<{ v: unknown }>(db, sql`SELECT stats_rollup_places(${day}::date) AS v`);
  return rolled.parse(row.v).rows;
});

export const statsRollupModeration = defineQuery({ name: 'stats.rollupModeration', statements: 1 }, async (db, day: string) => {
  const row = await one<{ v: unknown }>(db, sql`SELECT stats_rollup_moderation(${day}::date) AS v`);
  return rolled.parse(row.v).rows;
});

// ─── API readers ──────────────────────────────────────────────────────────

const dayValue = z.object({ metric: z.string(), day: z.string(), dim: z.string().optional(), value: z.coerce.number() });
const rowsSchema = z.array(dayValue);

export interface StatsRows {
  lastDay: string | null;
  rows: z.infer<typeof dayValue>[];
}

export interface StatsSeriesRows extends StatsRows {
  /** The days of [from, to] the rollup finished (the `rollup` marker). */
  rolledUp: string[];
}

/** One value per (metric, day) of [from, to], the dims summed, and the days of the range rolled up. */
export const statsSeries = defineQuery(
  { name: 'stats.series', statements: 1 },
  async (db, metrics: readonly string[], from: string, to: string): Promise<StatsSeriesRows> => {
    const row = await one<{ last_day: string | null; rows: unknown; rolled: unknown }>(
      db,
      sql`
SELECT ${LAST_DAY} AS last_day,
       coalesce((SELECT jsonb_agg(jsonb_build_object('metric', g.metric, 'day', g.day, 'value', g.value) ORDER BY g.metric, g.day)
                   FROM (SELECT s.metric, s.day::text AS day, sum(s.value) AS value
                           FROM stats_daily s
                          WHERE s.metric = ANY (${[...metrics]}::text[]) AND s.day BETWEEN ${from}::date AND ${to}::date
                          GROUP BY s.metric, s.day) g), '[]'::jsonb) AS rows,
       coalesce((SELECT jsonb_agg(s.day::text ORDER BY s.day)
                   FROM stats_daily s
                  WHERE s.metric = 'rollup' AND s.day BETWEEN ${from}::date AND ${to}::date), '[]'::jsonb) AS rolled`,
    );
    return { lastDay: row.last_day, rows: rowsSchema.parse(row.rows), rolledUp: z.array(z.string()).parse(row.rolled) };
  },
);

/** The rows of `metrics` of [from, to] with their dims (cohort tables: retention, funnel, conversion). */
export const statsCohortRows = defineQuery(
  { name: 'stats.cohorts', statements: 1 },
  async (db, metrics: readonly string[], from: string, to: string): Promise<StatsRows> => {
    const row = await one<{ last_day: string | null; rows: unknown }>(
      db,
      sql`
SELECT ${LAST_DAY} AS last_day,
       coalesce((SELECT jsonb_agg(jsonb_build_object('metric', s.metric, 'day', s.day::text, 'dim', s.dim, 'value', s.value) ORDER BY s.metric, s.day, s.dim)
                   FROM stats_daily s
                  WHERE s.metric = ANY (${[...metrics]}::text[]) AND s.day BETWEEN ${from}::date AND ${to}::date), '[]'::jsonb) AS rows`,
    );
    return { lastDay: row.last_day, rows: rowsSchema.parse(row.rows) };
  },
);

export interface StatsPlaceRows {
  day: string | null;
  cells: { dim: string; value: number }[];
}

/** The places of one day (`active_city` or `active_country`); `day` null: the newest day that has them. */
export const statsPlaces = defineQuery(
  { name: 'stats.places', statements: 1 },
  async (db, metric: 'active_city' | 'active_country', day: string | null): Promise<StatsPlaceRows> => {
    const row = await one<{ day: string | null; cells: unknown }>(
      db,
      sql`
WITH d AS (
  SELECT coalesce(${day}::date, (SELECT s.day FROM stats_daily s WHERE s.metric = ${metric} ORDER BY s.day DESC LIMIT 1)) AS day
)
SELECT d.day::text AS day,
       coalesce((SELECT jsonb_agg(jsonb_build_object('dim', s.dim, 'value', s.value) ORDER BY s.dim)
                   FROM stats_daily s WHERE s.metric = ${metric} AND s.day = d.day), '[]'::jsonb) AS cells
  FROM d`,
    );
    return { day: row.day, cells: z.array(z.object({ dim: z.string(), value: z.coerce.number() })).parse(row.cells) };
  },
);

const micros = z.union([z.string(), z.number()]).transform((v) => String(v));

const revenueSchema = z.object({
  lastDay: z.string().nullable(),
  currency: z.string().nullable(),
  currencies: z.array(z.object({ currency: z.string(), gross: micros })),
  estimated: z.boolean(),
  days: z.array(z.object({ day: z.string(), gross: micros, refund: micros, payments: z.number(), refunds: z.number(), newSubs: z.number() })),
  byStore: z.array(z.object({ store: z.number(), gross: micros, refund: micros, payments: z.number() })),
  byProduct: z.array(z.object({ productRef: z.number(), store: z.number(), gross: micros, payments: z.number() })),
  byCountry: z.array(z.object({ region: z.string(), gross: micros, payments: z.number() })),
  mrr: z.array(z.object({ day: z.string(), micros })),
  subscriptions: z.array(z.object({ day: z.string(), active: z.number(), renewing: z.number() })),
  churn: z.array(z.object({ day: z.string(), ended: z.number(), cancelled: z.number() })),
});
export type StatsRevenue = z.infer<typeof revenueSchema>;

/**
 * The revenue of [from, to] in one currency (`currency`, else the one with
 * the most payments; amounts of different currencies are never compared): one statement over stats_revenue_daily's primary key
 * and the money metrics of stats_daily. Amounts are decimal strings.
 */
export const statsRevenue = defineQuery(
  { name: 'stats.revenue', statements: 1 },
  async (db, from: string, to: string, currency: string | null, countries: number): Promise<StatsRevenue> => {
    const row = await one<{ v: unknown }>(
      db,
      sql`
WITH r AS MATERIALIZED (
  SELECT * FROM stats_revenue_daily WHERE day BETWEEN ${from}::date AND ${to}::date
), cur AS (
  SELECT r.currency::text AS currency, sum(r.gross_micros) AS gross, sum(r.payments) AS payments FROM r GROUP BY r.currency
), pick AS (
  SELECT coalesce(${currency}::text, (SELECT c.currency FROM cur c ORDER BY c.payments DESC, c.currency LIMIT 1)) AS c
), x AS (
  SELECT r.* FROM r, pick WHERE r.currency = pick.c
), m AS (
  SELECT s.metric, s.day, s.dim, s.value FROM stats_daily s
   WHERE s.metric IN ('mrr', 'subs', 'subs_renewing', 'churn', 'cancels') AND s.day BETWEEN ${from}::date AND ${to}::date
)
SELECT jsonb_build_object(
  'lastDay', ${LAST_DAY},
  'currency', (SELECT pick.c FROM pick),
  'currencies', coalesce((SELECT jsonb_agg(jsonb_build_object('currency', c.currency, 'gross', c.gross::text) ORDER BY c.payments DESC, c.currency) FROM cur c), '[]'::jsonb),
  'estimated', coalesce((SELECT bool_or(x.estimated) FROM x), false),
  'days', coalesce((SELECT jsonb_agg(jsonb_build_object('day', d.day::text, 'gross', d.gross::text, 'refund', d.refund::text, 'payments', d.payments,
                                                         'refunds', d.refunds, 'newSubs', d.new_subs) ORDER BY d.day)
                      FROM (SELECT x.day, sum(x.gross_micros) AS gross, sum(x.refund_micros) AS refund, sum(x.payments) AS payments,
                                   sum(x.refunds) AS refunds, sum(x.new_subs) AS new_subs
                              FROM x GROUP BY x.day) d), '[]'::jsonb),
  'byStore', coalesce((SELECT jsonb_agg(jsonb_build_object('store', b.store, 'gross', b.gross::text, 'refund', b.refund::text, 'payments', b.payments) ORDER BY b.store)
                         FROM (SELECT x.store, sum(x.gross_micros) AS gross, sum(x.refund_micros) AS refund, sum(x.payments) AS payments
                                 FROM x GROUP BY x.store) b), '[]'::jsonb),
  'byProduct', coalesce((SELECT jsonb_agg(jsonb_build_object('productRef', b.product_ref, 'store', b.store, 'gross', b.gross::text, 'payments', b.payments)
                                          ORDER BY b.gross DESC, b.product_ref)
                           FROM (SELECT x.product_ref, x.store, sum(x.gross_micros) AS gross, sum(x.payments) AS payments
                                   FROM x GROUP BY x.product_ref, x.store) b), '[]'::jsonb),
  'byCountry', coalesce((SELECT jsonb_agg(jsonb_build_object('region', b.region, 'gross', b.gross::text, 'payments', b.payments) ORDER BY b.gross DESC, b.region)
                           FROM (SELECT x.region::text AS region, sum(x.gross_micros) AS gross, sum(x.payments) AS payments
                                   FROM x GROUP BY x.region ORDER BY 2 DESC, 1 LIMIT ${countries}) b), '[]'::jsonb),
  'mrr', coalesce((SELECT jsonb_agg(jsonb_build_object('day', g.day::text, 'micros', g.v::text) ORDER BY g.day)
                     FROM (SELECT m.day, sum(m.value) AS v FROM m, pick
                            WHERE m.metric = 'mrr' AND split_part(m.dim, ':', 2) = pick.c GROUP BY m.day) g), '[]'::jsonb),
  'subscriptions', coalesce((SELECT jsonb_agg(jsonb_build_object('day', g.day::text, 'active', g.active, 'renewing', g.renewing) ORDER BY g.day)
                               FROM (SELECT m.day, sum(m.value) FILTER (WHERE m.metric = 'subs') AS active,
                                            coalesce(sum(m.value) FILTER (WHERE m.metric = 'subs_renewing'), 0) AS renewing
                                       FROM m WHERE m.metric IN ('subs', 'subs_renewing') GROUP BY m.day
                                     HAVING sum(m.value) FILTER (WHERE m.metric = 'subs') IS NOT NULL) g), '[]'::jsonb),
  'churn', coalesce((SELECT jsonb_agg(jsonb_build_object('day', g.day::text, 'ended', g.ended, 'cancelled', g.cancelled) ORDER BY g.day)
                       FROM (SELECT m.day, coalesce(sum(m.value) FILTER (WHERE m.metric = 'churn'), 0) AS ended,
                                    coalesce(sum(m.value) FILTER (WHERE m.metric = 'cancels'), 0) AS cancelled
                               FROM m WHERE m.metric IN ('churn', 'cancels') GROUP BY m.day) g), '[]'::jsonb)) AS v`,
    );
    return revenueSchema.parse(row.v);
  },
);

const moderationSchema = z.object({
  lastDay: z.string().nullable(),
  moderators: z.array(
    z.object({
      adminId: z.number(),
      displayName: z.string().nullable(),
      decisions: z.number(),
      photos: z.number(),
      texts: z.number(),
      reports: z.number(),
      appeals: z.number(),
      overturned: z.number(),
      /** [daily median seconds, decisions timed that day] of the days that had any. */
      medians: z.array(z.tuple([z.number(), z.number()])),
    }),
  ),
  days: z.array(z.object({ day: z.string(), decisions: z.number() })),
});
export type StatsModeration = z.infer<typeof moderationSchema>;

/** Decisions per admin over [from, to], with the admins' display names (admin_users primary key). */
export const statsModeration = defineQuery({ name: 'stats.moderation', statements: 1 }, async (db, from: string, to: string): Promise<StatsModeration> => {
  const row = await one<{ v: unknown }>(
    db,
    sql`
WITH r AS MATERIALIZED (
  SELECT * FROM stats_moderation_daily WHERE day BETWEEN ${from}::date AND ${to}::date
)
SELECT jsonb_build_object(
  'lastDay', ${LAST_DAY},
  'moderators', coalesce((SELECT jsonb_agg(jsonb_build_object(
                    'adminId', g.admin_id, 'displayName', a.display_name,
                    'decisions', g.decisions, 'photos', g.photos, 'texts', g.texts, 'reports', g.reports, 'appeals', g.appeals,
                    'overturned', g.overturned, 'medians', g.medians) ORDER BY g.decisions DESC, g.admin_id)
                  FROM (SELECT r.admin_id, sum(r.decisions) AS decisions, sum(r.photos) AS photos, sum(r.texts) AS texts,
                               sum(r.reports) AS reports, sum(r.appeals) AS appeals, sum(r.overturned) AS overturned,
                               coalesce(jsonb_agg(jsonb_build_array(r.response_p50_s, r.timed)) FILTER (WHERE r.response_p50_s IS NOT NULL AND r.timed > 0), '[]'::jsonb) AS medians
                          FROM r GROUP BY r.admin_id) g
                  LEFT JOIN admin_users a ON a.id = g.admin_id), '[]'::jsonb),
  'days', coalesce((SELECT jsonb_agg(jsonb_build_object('day', d.day::text, 'decisions', d.n) ORDER BY d.day)
                      FROM (SELECT r.day, sum(r.decisions) AS n FROM r GROUP BY r.day) d), '[]'::jsonb)) AS v`,
  );
  return moderationSchema.parse(row.v);
});
