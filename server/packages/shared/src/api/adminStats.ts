import { z } from 'zod';
import { appStoreSchema } from '../codes.js';
import { providerHealthNames, signupStageKeys, statsSeriesMetrics } from '../stats.js';
import { adminIdSchema } from './admin.js';
import { countrySchema, dateSchema, timeSchema } from './common.js';

/**
 * The dashboard (`/`) and statistics (`/stats`) of the admin panel, all
 * `GET /v1/admin/stats/*` with `dashboard.read` (money with
 * `dashboard.revenue` too). Days are UTC `YYYY-MM-DD`; a range is
 * inclusive, at most 400 days, from 2020-01-01 (STATS_FIRST_DAY) to today. Money is a decimal
 * string of micros of its currency, never summed across currencies.
 * Aggregates only: no person, phone, message or token is ever in an answer.
 */

const int = z.number().int().nonnegative();
/** Micros of a currency as a decimal string (no float rounding). */
export const microsSchema = z.string().regex(/^-?[0-9]{1,19}$/, 'must be decimal micros');
export const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'must be an ISO 4217 code');
export const statsDaySchema = dateSchema;
export const statsSeriesMetricSchema = z.enum(statsSeriesMetrics);
export const providerHealthNameSchema = z.enum(providerHealthNames);

// ─── Requests ─────────────────────────────────────────────────────────────

export const adminStatsRangeQuerySchema = z.object({ from: statsDaySchema, to: statsDaySchema });
export type AdminStatsRangeQuery = z.infer<typeof adminStatsRangeQuerySchema>;

/** `metrics`: names of {@link statsSeriesMetrics}, comma separated, at most STATS_MAX_METRICS (8). */
export const adminStatsDailyQuerySchema = adminStatsRangeQuerySchema.extend({ metrics: z.string().min(1).max(400) });
export type AdminStatsDailyQuery = z.infer<typeof adminStatsDailyQuerySchema>;

/** `day`: the places of that day (default: the newest day that has them). */
export const adminStatsPlacesQuerySchema = z.object({ by: z.enum(['city', 'country']).default('city'), day: statsDaySchema.optional() });
export type AdminStatsPlacesQuery = z.infer<typeof adminStatsPlacesQuerySchema>;

/** `currency`: the currency the series are in (default: the one with the most payments in the range). */
export const adminStatsRevenueQuerySchema = adminStatsRangeQuerySchema.extend({ currency: z.string().min(1).max(8).optional() });
export type AdminStatsRevenueQuery = z.infer<typeof adminStatsRevenueQuerySchema>;


// ─── GET /stats/live ──────────────────────────────────────────────────────

/** A review queue: counted up to 10,000 (`more`: there are more). */
export const statsCappedSchema = z.object({ count: int, more: z.boolean() });

export const statsStreamSchema = z.object({
  name: z.enum(['like', 'match', 'msg']),
  length: int,
  /** Entries still to be written (not delivered yet, or being saved); null: unknown (no reader group, or an older snapshot). */
  waiting: int.nullable(),
  /** Delivered to the writers and not acknowledged. */
  pending: int,
  dead: int,
  /** How far the writer is behind; null: the stream or its group is missing. */
  lagMs: int.nullable(),
});

export const statsJobsSchema = z.object({ queue: z.string(), waiting: int, active: int, delayed: int, failed: int });

/** One provider's calls today: `ok` and `failed` (a provider that never answered, or answered 5xx, 429, 401 or 403). */
export const providerTodaySchema = z.object({ name: providerHealthNameSchema, ok: int, failed: int });

export const adminStatsLiveSchema = z.object({
  at: timeSchema,
  day: statsDaySchema,
  /** When the background service last wrote its snapshot; null: none in the last 10 minutes. */
  snapshotAt: timeSchema.nullable(),
  worker: z.object({ alive: z.boolean(), lastBeatAt: timeSchema.nullable() }),
  /** People connected to realtime (test accounts included); null: unknown. */
  online: int.nullable(),
  /** Accounts that used the app today (UTC), test accounts left out. */
  activeToday: int,
  likesToday: int,
  superlikesToday: int,
  passesToday: int,
  messagesToday: int,
  /** Calls ringing or in progress now. */
  callsLive: int,
  // From the snapshot (null without one):
  signupsToday: int.nullable(),
  matchesToday: int.nullable(),
  callsToday: int.nullable(),
  callsAnsweredToday: int.nullable(),
  reportsToday: int.nullable(),
  queues: z
    .object({
      photos: statsCappedSchema,
      texts: statsCappedSchema,
      reports: statsCappedSchema,
      urgentReports: statsCappedSchema,
      appeals: statsCappedSchema,
      /** Support requests waiting for an answer (status open). */
      tickets: statsCappedSchema,
    })
    .nullable(),
  streams: z.array(statsStreamSchema).nullable(),
  jobs: z.array(statsJobsSchema).nullable(),
  providers: z.array(providerTodaySchema),
  /** Only with `dashboard.revenue`: today's payments per currency, by currency code (amounts of different currencies are never compared). */
  revenueToday: z.array(z.object({ currency: currencySchema, amountMicros: microsSchema, estimated: z.boolean() })).optional(),
});
export type AdminStatsLive = z.infer<typeof adminStatsLiveSchema>;

// ─── GET /stats/daily ─────────────────────────────────────────────────────

export const adminStatsSeriesSchema = z.object({
  from: statsDaySchema,
  to: statsDaySchema,
  /** The newest day rolled up; null: none yet. */
  lastDay: statsDaySchema.nullable(),
  /**
   * A point per day rolled up (a day with nothing counted reads 0); a day not
   * rolled up has none. `dau`, `wau` and `mau` have points only where they
   * were measured.
   */
  series: z.array(z.object({ metric: statsSeriesMetricSchema, points: z.array(z.object({ day: statsDaySchema, value: int })) })),
});
export type AdminStatsSeries = z.infer<typeof adminStatsSeriesSchema>;

// ─── GET /stats/retention ─────────────────────────────────────────────────

/** Of the sign-ups of a day, how many used the app 1, 7 and 30 days later; null: not measurable (that day is after `lastDay`, or its activity was not kept). */
export const adminStatsRetentionSchema = z.object({
  from: statsDaySchema,
  to: statsDaySchema,
  lastDay: statsDaySchema.nullable(),
  cohorts: z.array(z.object({ day: statsDaySchema, signups: int, d1: int.nullable(), d7: int.nullable(), d30: int.nullable() })),
});
export type AdminStatsRetention = z.infer<typeof adminStatsRetentionSchema>;

// ─── GET /stats/funnel ────────────────────────────────────────────────────

export const signupStageSchema = z.enum(signupStageKeys);

/** The sign-ups of the range by the furthest step reached (cumulative, in sign-up order). */
export const adminStatsFunnelSchema = z.object({
  from: statsDaySchema,
  to: statsDaySchema,
  lastDay: statsDaySchema.nullable(),
  signups: int,
  refusedUnderAge: int,
  stages: z.array(z.object({ stage: signupStageSchema, reached: int })),
});
export type AdminStatsFunnel = z.infer<typeof adminStatsFunnelSchema>;

// ─── GET /stats/places ────────────────────────────────────────────────────

/** A gender count; null: withheld (fewer than 5, or it would tell a smaller group; counted in `other`). */
const cellSchema = int.nullable();

export const adminStatsPlacesSchema = z.object({
  day: statsDaySchema.nullable(),
  /** What a place is (the request's `by`). */
  kind: z.enum(['city', 'country']),
  windowDays: z.literal(7),
  places: z.array(
    z.object({
      /** The city id, or the country code. */
      code: z.string(),
      country: countrySchema,
      /** City names (cities only, when the city table knows the id). */
      names: z.object({ en: z.string(), fa: z.string(), tr: z.string() }).optional(),
      women: cellSchema,
      men: cellSchema,
      nonBinary: cellSchema,
      /** The published cells summed. */
      total: int,
    }),
  ),
  /** Everyone not in a listed cell; a cell is null when withheld like a place's. `total`: the published cells summed. */
  other: z.object({ women: cellSchema, men: cellSchema, nonBinary: cellSchema, total: int }),
});
export type AdminStatsPlaces = z.infer<typeof adminStatsPlacesSchema>;

// ─── GET /stats/revenue (dashboard.revenue) ───────────────────────────────

export const adminStatsRevenueSchema = z.object({
  from: statsDaySchema,
  to: statsDaySchema,
  lastDay: statsDaySchema.nullable(),
  /** Gross per currency over the range, the currency with the most payments first. */
  currencies: z.array(z.object({ currency: currencySchema, grossMicros: microsSchema })),
  /** The currency of everything below (asked for, else the one with the most payments); null: no payment in the range. */
  currency: currencySchema.nullable(),
  /** Some amounts are list prices (Cafe Bazaar reports none). */
  estimated: z.boolean(),
  days: z.array(z.object({ day: statsDaySchema, grossMicros: microsSchema, refundMicros: microsSchema, payments: int, refunds: int, newSubs: int })),
  byStore: z.array(z.object({ store: appStoreSchema, grossMicros: microsSchema, refundMicros: microsSchema, payments: int })),
  byProduct: z.array(
    z.object({
      productRef: z.number().int(),
      /** The store's product id; `?` when the catalogue no longer has it. */
      productId: z.string(),
      store: appStoreSchema,
      kind: z.enum(['subscription', 'consumable']).optional(),
      plan: z.string().optional(),
      period: z.string().optional(),
      grossMicros: microsSchema,
      payments: int,
    }),
  ),
  /** Top 30 by gross; `ZZ`: unknown. */
  byCountry: z.array(z.object({ region: z.string().regex(/^[A-Z]{2}$/), grossMicros: microsSchema, payments: int })),
  /** Monthly recurring revenue in the currency, all stores (from the day the snapshots began). */
  mrr: z.array(z.object({ day: statsDaySchema, micros: microsSchema })),
  subscriptions: z.array(z.object({ day: statsDaySchema, active: int, renewing: int })),
  churn: z.array(z.object({ day: statsDaySchema, ended: int, cancelled: int })),
});
export type AdminStatsRevenue = z.infer<typeof adminStatsRevenueSchema>;

// ─── GET /stats/conversion (dashboard.revenue) ────────────────────────────

/** Paying within 7 and 30 days of signing up, by the store of the first payment; null: not measurable yet. */
const conversionSchema = z.object({ play: int, bazaar: int, total: int });

export const adminStatsConversionSchema = z.object({
  from: statsDaySchema,
  to: statsDaySchema,
  lastDay: statsDaySchema.nullable(),
  cohorts: z.array(z.object({ day: statsDaySchema, signups: int, d7: conversionSchema.nullable(), d30: conversionSchema.nullable() })),
});
export type AdminStatsConversion = z.infer<typeof adminStatsConversionSchema>;

// ─── GET /stats/moderation ────────────────────────────────────────────────

export const adminStatsModerationSchema = z.object({
  from: statsDaySchema,
  to: statsDaySchema,
  lastDay: statsDaySchema.nullable(),
  /** One row per admin who decided in the range, most decisions first. Names are the admins' display names. */
  moderators: z.array(
    z.object({
      admin: z.object({ id: adminIdSchema, displayName: z.string() }),
      decisions: int,
      photos: int,
      texts: int,
      reports: int,
      appeals: int,
      /** Appeals overturned in the range against this admin's actions. */
      overturned: int,
      /** overturned ÷ decisions; null without decisions. */
      overturnRate: z.number().nonnegative().nullable(),
      /** Median waiting time of the timed decisions (the daily medians weighted by their decisions); null: none timed. */
      responseMedianS: int.nullable(),
    }),
  ),
  /** Decisions of every admin per day. */
  days: z.array(z.object({ day: statsDaySchema, decisions: int })),
});
export type AdminStatsModeration = z.infer<typeof adminStatsModerationSchema>;
