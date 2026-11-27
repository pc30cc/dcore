import type {
  AdminStatsConversion,
  AdminStatsFunnel,
  AdminStatsLive,
  AdminStatsModeration,
  AdminStatsPlaces,
  AdminStatsRetention,
  AdminStatsRevenue,
  AdminStatsSeries,
  StatsSeriesMetric,
} from '@app/shared';
import { signupStageKeys } from '@app/shared';
import type { Call } from './panel';

/** Answers of `GET /v1/admin/stats/*` for the dashboard and statistics tests. */

export const NOW = '2026-11-27T10:00:00.000Z';
/** Yesterday (UTC) of {@link NOW}: the newest closed day. */
export const LAST_DAY = '2026-11-26';

export function live(overrides: Partial<AdminStatsLive> = {}): AdminStatsLive {
  return {
    at: '2026-11-27T09:59:30.000Z',
    day: '2026-11-27',
    snapshotAt: '2026-11-27T09:59:00.000Z',
    worker: { alive: true, lastBeatAt: '2026-11-27T09:59:10.000Z' },
    online: 1384,
    activeToday: 2954,
    likesToday: 21837,
    superlikesToday: 702,
    passesToday: 33015,
    messagesToday: 26940,
    callsLive: 5,
    signupsToday: 187,
    matchesToday: 2391,
    callsToday: 412,
    callsAnsweredToday: 268,
    reportsToday: 41,
    queues: {
      photos: { count: 37, more: false },
      texts: { count: 12, more: false },
      reports: { count: 23, more: false },
      urgentReports: { count: 2, more: false },
      appeals: { count: 4, more: false },
      tickets: { count: 10000, more: true },
    },
    streams: [
      { name: 'like', length: 18204, pending: 12, dead: 0, lagMs: 840 },
      { name: 'match', length: 2410, pending: 0, dead: 0, lagMs: 0 },
      { name: 'msg', length: 40118, pending: 64, dead: 1, lagMs: 92_000 },
    ],
    jobs: [
      { queue: 'photo', waiting: 3, active: 1, delayed: 0, failed: 0 },
      { queue: 'push', waiting: 41, active: 4, delayed: 12, failed: 2 },
      { queue: 'maint', waiting: 0, active: 0, delayed: 0, failed: 0 },
    ],
    providers: [
      { name: 'sms', ok: 271, failed: 6 },
      { name: 'push', ok: 18402, failed: 77 },
      { name: 'store', ok: 0, failed: 0 },
    ],
    revenueToday: [
      { currency: 'USD', amountMicros: '312470000', estimated: false },
      { currency: 'IRR', amountMicros: '41720000000000', estimated: true },
    ],
    ...overrides,
  };
}

/** Live figures with no snapshot of the background service (and it is not running). */
export function liveWaiting(): AdminStatsLive {
  return live({
    snapshotAt: null,
    worker: { alive: false, lastBeatAt: null },
    online: null,
    signupsToday: null,
    matchesToday: null,
    callsToday: null,
    callsAnsweredToday: null,
    reportsToday: null,
    queues: null,
    streams: null,
    jobs: null,
    revenueToday: [],
  });
}

/** Every day from `from` to `to`, oldest first. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += 86_400_000) out.push(new Date(at).toISOString().slice(0, 10));
  return out;
}

/** A daily answer: each asked metric `base + i` on every day of the range (none before `start`). */
export function series(call: Call, values: Partial<Record<StatsSeriesMetric, (i: number) => number>> = {}, start?: string): AdminStatsSeries {
  const metrics = (call.query['metrics'] ?? '').split(',') as StatsSeriesMetric[];
  const days = daysBetween(call.query['from']!, call.query['to']!).filter((day) => !start || day >= start);
  return {
    from: call.query['from']!,
    to: call.query['to']!,
    lastDay: LAST_DAY,
    series: metrics.map((metric, m) => ({ metric, points: days.map((day, i) => ({ day, value: values[metric]?.(i) ?? 100 * (m + 1) + i })) })),
  };
}

export function retention(call: Call): AdminStatsRetention {
  const days = daysBetween(call.query['from']!, call.query['to']!);
  return {
    from: call.query['from']!,
    to: call.query['to']!,
    lastDay: LAST_DAY,
    cohorts: days.map((day, i) => {
      const age = days.length - i; // days from the cohort to LAST_DAY + 1
      return { day, signups: 200, d1: age > 1 ? 80 : null, d7: age > 7 ? 40 : null, d30: age > 30 ? 20 : null };
    }),
  };
}

export function funnel(call: Call): AdminStatsFunnel {
  const reached = [1000, 950, 930, 910, 900, 880, 860, 800, 760, 740, 700, 680, 600];
  return {
    from: call.query['from']!,
    to: call.query['to']!,
    lastDay: LAST_DAY,
    signups: 1000,
    refusedUnderAge: 14,
    stages: signupStageKeys.map((stage, i) => ({ stage, reached: reached[i] ?? 0 })),
  };
}

export function places(call: Call): AdminStatsPlaces {
  if (call.query['by'] === 'country') {
    return {
      day: LAST_DAY,
      kind: 'country',
      windowDays: 7,
      places: [{ code: 'IR', country: 'IR', women: 1754, men: 2399, nonBinary: 40, total: 4193 }],
      other: { women: 25, men: 30, nonBinary: null, total: 55 },
    };
  }
  return {
    day: LAST_DAY,
    kind: 'city',
    windowDays: 7,
    places: [
      { code: '112931', country: 'IR', names: { en: 'Tehran', fa: 'تهران', tr: 'Tahran' }, women: 812, men: 1043, nonBinary: 18, total: 1873 },
      { code: '124665', country: 'IR', names: { en: 'Mashhad', fa: 'مشهد', tr: 'Meşhed' }, women: 233, men: 311, nonBinary: null, total: 544 },
    ],
    other: { women: 236, men: 318, nonBinary: null, total: 554 },
  };
}

export function revenue(call: Call): AdminStatsRevenue {
  const days = daysBetween(call.query['from']!, call.query['to']!);
  const currency = call.query['currency'] ?? 'IRR';
  const unit = currency === 'USD' ? 7_990_000n : 1_490_000_000_000n;
  return {
    from: call.query['from']!,
    to: call.query['to']!,
    lastDay: LAST_DAY,
    currencies: [
      { currency: 'IRR', grossMicros: (unit * 300n).toString() },
      { currency: 'USD', grossMicros: '2397000000' },
    ],
    currency,
    estimated: currency === 'IRR',
    days: days.map((day, i) => ({ day, grossMicros: (unit * BigInt(10 + (i % 3))).toString(), refundMicros: i === 2 ? unit.toString() : '0', payments: 10 + (i % 3), refunds: i === 2 ? 1 : 0, newSubs: 4 })),
    byStore: [{ store: currency === 'USD' ? 'play' : 'bazaar', grossMicros: (unit * 300n).toString(), refundMicros: unit.toString(), payments: 300 }],
    byProduct: [
      { productRef: 4, productId: 'sub.plus.1m', store: 'bazaar', kind: 'subscription', plan: 'plus', period: 'P1M', grossMicros: (unit * 200n).toString(), payments: 200 },
      { productRef: 99, productId: '?', store: 'bazaar', grossMicros: (unit * 100n).toString(), payments: 100 },
    ],
    byCountry: [
      { region: 'IR', grossMicros: (unit * 290n).toString(), payments: 290 },
      { region: 'ZZ', grossMicros: (unit * 10n).toString(), payments: 10 },
    ],
    mrr: days.map((day, i) => ({ day, micros: (unit * BigInt(400 + i)).toString() })),
    subscriptions: days.map((day, i) => ({ day, active: 500 + i, renewing: 400 + i })),
    churn: days.map((day) => ({ day, ended: 1, cancelled: 2 })),
  };
}

export function conversion(call: Call): AdminStatsConversion {
  const days = daysBetween(call.query['from']!, call.query['to']!);
  return {
    from: call.query['from']!,
    to: call.query['to']!,
    lastDay: LAST_DAY,
    cohorts: days.map((day, i) => {
      const age = days.length - i;
      return { day, signups: 100, d7: age > 6 ? { play: 3, bazaar: 2, total: 5 } : null, d30: age > 29 ? { play: 5, bazaar: 3, total: 8 } : null };
    }),
  };
}

export function moderation(call: Call): AdminStatsModeration {
  const days = daysBetween(call.query['from']!, call.query['to']!);
  return {
    from: call.query['from']!,
    to: call.query['to']!,
    lastDay: LAST_DAY,
    moderators: [
      { admin: { id: '2', displayName: 'Mina Karimi' }, decisions: 1013, photos: 553, texts: 209, reports: 207, appeals: 44, overturned: 6, overturnRate: 6 / 1013, responseMedianS: 2100 },
      { admin: { id: '3', displayName: 'Omid Rahmani' }, decisions: 181, photos: 99, texts: 36, reports: 38, appeals: 8, overturned: 4, overturnRate: 4 / 181, responseMedianS: null },
    ],
    days: days.map((day, i) => ({ day, decisions: 30 + (i % 5) })),
  };
}

/** Every stats route with full answers. */
export const statsHandlers = {
  'GET /v1/admin/stats/live': () => live(),
  'GET /v1/admin/stats/daily': (call: Call) => series(call),
  'GET /v1/admin/stats/retention': retention,
  'GET /v1/admin/stats/funnel': funnel,
  'GET /v1/admin/stats/places': places,
  'GET /v1/admin/stats/revenue': revenue,
  'GET /v1/admin/stats/conversion': conversion,
  'GET /v1/admin/stats/moderation': moderation,
};
