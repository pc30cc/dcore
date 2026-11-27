/**
 * The dashboard's statistics: names and bounds shared by the worker that
 * writes them (stats/live, stats/rollup), the API that reads them and the
 * admin panel that shows them. Days are UTC (`YYYY-MM-DD` on the wire,
 * `YYYYMMDD` in Valkey key names).
 *
 * Stored metrics live in `stats_daily` (metric, day, dim); `dim` is `''`
 * unless noted: `matches` by match source code, `calls`, `calls_answered`,
 * `call_minutes` by call kind code, `reports`, `reports_auto` by reason code,
 * `signup_step` by the stored onboarding step (30 = finished), `conv_d7` and
 * `conv_d30` by store code, `churn`, `cancels`, `subs`, `subs_renewing` by
 * `<store>:<plan id>`, `mrr` by `<store>:<currency>`, `active_city` by
 * `<city id>:<gender>` (city 0 = other), `active_country` by
 * `<country>:<gender>` (ZZ = other).
 */

/** The longest range a statistics read covers. */
export const STATS_MAX_DAYS = 400;
/** No statistic is older than this day (a read that starts before it is refused). */
export const STATS_FIRST_DAY = '2020-01-01';
/** The most series one daily read returns. */
export const STATS_MAX_METRICS = 8;
/** A place with fewer people is folded into "other" as a whole. */
export const STATS_PLACE_MIN = 10;
/**
 * A (place, gender) cell with fewer people is not published, and neither is
 * one whose publication would let a smaller group be worked out (a country
 * minus its cities, Other minus ZZ): it is counted in "other".
 */
export const STATS_CELL_MIN = 5;
/** Places listed per read (the rest is "other"). */
export const STATS_PLACES_TOP = 50;
/** Countries listed in the revenue cube's country table. */
export const STATS_REVENUE_COUNTRIES_TOP = 30;
/** Review queues are counted up to this; more reads as "cap+". */
export const STATS_QUEUE_CAP = 10_000;
/** "Active" for places: the profile's last active day in the last 7 days. */
export const STATS_PLACES_WINDOW_DAYS = 7;
/** The revenue read is kept this long for the same parameters and newest day. */
export const STATS_REVENUE_CACHE_SECONDS = 300;

/**
 * Counters in Valkey (`ev:<name>:<yyyymmdd>`, 45 days), counted where the
 * event happens: swipes by the API, messages by the wb:msg writer, provider
 * calls by the API and the worker. The rollup copies them into stats_daily.
 */
export const statsCounterNames = [
  'like',
  'superlike',
  'pass',
  'msg',
  'sms_ok',
  'sms_fail',
  'push_ok',
  'push_fail',
  'store_ok',
  'store_err',
] as const;
export type StatsCounterName = (typeof statsCounterNames)[number];

/** The stats_daily metric each counter is rolled up into. */
export const statsCounterMetrics = {
  like: 'likes',
  superlike: 'superlikes',
  pass: 'passes',
  msg: 'messages',
  sms_ok: 'sms_ok',
  sms_fail: 'sms_fail',
  push_ok: 'push_ok',
  push_fail: 'push_fail',
  store_ok: 'store_ok',
  store_err: 'store_err',
} as const satisfies Record<StatsCounterName, string>;

/** Providers whose calls are counted for the health card (SMS codes, FCM pushes, store APIs). */
export const providerHealthNames = ['sms', 'push', 'store'] as const;
export type ProviderHealthName = (typeof providerHealthNames)[number];

/** Each provider's ok and failed counters. */
export const providerHealth = {
  sms: { ok: 'sms_ok', failed: 'sms_fail' },
  push: { ok: 'push_ok', failed: 'push_fail' },
  store: { ok: 'store_ok', failed: 'store_err' },
} as const satisfies Record<ProviderHealthName, { ok: StatsCounterName; failed: StatsCounterName }>;

/** The metrics `GET /v1/admin/stats/daily` returns, one value per day (the stored dims summed). */
export const statsSeriesMetrics = [
  'dau',
  'wau',
  'mau',
  'signups',
  'likes',
  'superlikes',
  'passes',
  'messages',
  'matches',
  'conversations',
  'replied',
  'calls',
  'calls_answered',
  'call_minutes',
  'reports',
  'reports_auto',
  'sms_ok',
  'sms_fail',
  'push_ok',
  'push_fail',
  'store_ok',
  'store_err',
] as const;
export type StatsSeriesMetric = (typeof statsSeriesMetrics)[number];

/**
 * The sign-up stages, cumulative: a stage is reached by an account whose
 * stored onboarding step is at least `from`. The app stores the next step's
 * code once a step is passed, so these mirror the Android app's
 * `OnboardingCodes` (START 0, NAME 2, BIRTH_DATE 4, GENDER 6, INTERESTED_IN 8,
 * INTENTION 10, PHOTOS 12, PROMPTS 14, FIELDS 16, LOCATION 18,
 * NOTIFICATIONS 20, GUIDELINES 22, DONE 30): keep both in step.
 */
export const signupStages = [
  { key: 'started', from: 0 },
  { key: 'privacy', from: 2 },
  { key: 'name', from: 4 },
  { key: 'birthDate', from: 6 },
  { key: 'gender', from: 8 },
  { key: 'interestedIn', from: 10 },
  { key: 'intention', from: 12 },
  { key: 'photos', from: 14 },
  { key: 'prompts', from: 16 },
  { key: 'fields', from: 18 },
  { key: 'location', from: 20 },
  { key: 'notifications', from: 22 },
  { key: 'done', from: 30 },
] as const;
export const signupStageKeys = signupStages.map((stage) => stage.key) as [(typeof signupStages)[number]['key'], ...(typeof signupStages)[number]['key'][]];
export type SignupStage = (typeof signupStages)[number]['key'];

/** Queue decisions counted per moderator (the audit actions of each kind). */
export const moderationDecisionKinds = ['photos', 'texts', 'reports', 'appeals'] as const;
export type ModerationDecisionKind = (typeof moderationDecisionKinds)[number];

/** `YYYY-MM-DD` of a time in UTC. */
export function statsDay(time: Date | number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` moved by `days`. */
export function statsAddDays(day: string, days: number): string {
  return statsDay(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000);
}

/** Days from `from` to `to` inclusive (0 when `to` is before `from`). */
export function statsDaysBetween(from: string, to: string): number {
  const span = Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000) + 1;
  return Math.max(0, span);
}
