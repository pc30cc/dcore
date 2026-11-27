import {
  statsAddDays,
  statsDay,
  statsDaysBetween,
  type AdminStatsConversion,
  type AdminStatsFunnel,
  type AdminStatsLive,
  type AdminStatsModeration,
  type AdminStatsPlaces,
  type AdminStatsRetention,
  type AdminStatsRevenue,
  type AdminStatsSeries,
  type Locale,
  type StatsSeriesMetric,
} from '@app/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import { apiRequest } from './api';
import type { CsvCell } from './csv';
import { formatNumber } from './format';

/**
 * The dashboard's and the statistics page's reads (`GET /v1/admin/stats/*`)
 * and the helpers that turn their answers into what the pages show. Days are
 * UTC `YYYY-MM-DD`; the statistics cover closed days, so a range ends
 * yesterday (UTC). The live read costs the database nothing and is polled
 * while the tab is visible; every other read is one statement and kept for
 * a few minutes (the figures change once a night).
 */

export const LIVE_POLL_MS = 30_000;
const DAILY_STALE_MS = 300_000;

/** The ranges the statistics page offers, in days. */
export const statsRanges = [7, 30, 90, 365] as const;
export type StatsRangeDays = (typeof statsRanges)[number];
export const DEFAULT_RANGE: StatsRangeDays = 30;

/** `?days=` of the address as a range the page offers; anything else is the default. */
export function rangeDaysOf(value: string | null): StatsRangeDays {
  const days = Number(value);
  return (statsRanges as readonly number[]).includes(days) ? (days as StatsRangeDays) : DEFAULT_RANGE;
}

export interface StatsRange {
  from: string;
  to: string;
}

/** The last `days` closed UTC days: `to` is yesterday. */
export function statsRange(days: number, now: number = Date.now()): StatsRange {
  const to = statsAddDays(statsDay(now), -1);
  return { from: statsAddDays(to, -(days - 1)), to };
}

/** Every day of a range, oldest first. */
export function daysOf(range: StatsRange): string[] {
  const count = statsDaysBetween(range.from, range.to);
  return Array.from({ length: count }, (_, i) => statsAddDays(range.from, i));
}

export const statsKeys = {
  live: ['stats', 'live'] as const,
  daily: (metrics: readonly string[], range: StatsRange) => ['stats', 'daily', metrics.join(','), range.from, range.to] as const,
  retention: (range: StatsRange) => ['stats', 'retention', range.from, range.to] as const,
  funnel: (range: StatsRange) => ['stats', 'funnel', range.from, range.to] as const,
  places: (kind: PlaceKind) => ['stats', 'places', kind] as const,
  revenue: (range: StatsRange, currency: string | null) => ['stats', 'revenue', range.from, range.to, currency ?? ''] as const,
  conversion: (range: StatsRange) => ['stats', 'conversion', range.from, range.to] as const,
  moderation: (range: StatsRange) => ['stats', 'moderation', range.from, range.to] as const,
};

const rangeQuery = (range: StatsRange) => `from=${range.from}&to=${range.to}`;

/** Today's figures, read again every 30 s while the tab is visible; a failed poll keeps the last answer. */
export function useStatsLive() {
  return useQuery({
    queryKey: statsKeys.live,
    queryFn: ({ signal }) => apiRequest<AdminStatsLive>('/v1/admin/stats/live', { signal }),
    staleTime: 0,
    refetchInterval: LIVE_POLL_MS,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

/** Daily values of up to 8 metrics. */
export function useStatsSeries(metrics: readonly StatsSeriesMetric[], range: StatsRange) {
  return useQuery({
    queryKey: statsKeys.daily(metrics, range),
    queryFn: ({ signal }) => apiRequest<AdminStatsSeries>(`/v1/admin/stats/daily?metrics=${metrics.join(',')}&${rangeQuery(range)}`, { signal }),
    staleTime: DAILY_STALE_MS,
    placeholderData: keepPreviousData,
  });
}

export function useStatsRetention(range: StatsRange) {
  return useQuery({
    queryKey: statsKeys.retention(range),
    queryFn: ({ signal }) => apiRequest<AdminStatsRetention>(`/v1/admin/stats/retention?${rangeQuery(range)}`, { signal }),
    staleTime: DAILY_STALE_MS,
    placeholderData: keepPreviousData,
  });
}

export function useStatsFunnel(range: StatsRange) {
  return useQuery({
    queryKey: statsKeys.funnel(range),
    queryFn: ({ signal }) => apiRequest<AdminStatsFunnel>(`/v1/admin/stats/funnel?${rangeQuery(range)}`, { signal }),
    staleTime: DAILY_STALE_MS,
    placeholderData: keepPreviousData,
  });
}

export type PlaceKind = AdminStatsPlaces['kind'];
export const placeKinds: readonly PlaceKind[] = ['city', 'country'];

/** The newest day's places (the range does not apply: they are the last 7 days' active profiles). */
export function useStatsPlaces(kind: PlaceKind) {
  return useQuery({
    queryKey: statsKeys.places(kind),
    queryFn: ({ signal }) => apiRequest<AdminStatsPlaces>(`/v1/admin/stats/places?by=${kind}`, { signal }),
    staleTime: DAILY_STALE_MS,
    placeholderData: keepPreviousData,
  });
}

/** Money figures (`dashboard.revenue`): never requested without it. */
export function useStatsRevenue(range: StatsRange, currency: string | null, enabled: boolean) {
  return useQuery({
    queryKey: statsKeys.revenue(range, currency),
    queryFn: ({ signal }) =>
      apiRequest<AdminStatsRevenue>(`/v1/admin/stats/revenue?${rangeQuery(range)}${currency ? `&currency=${currency}` : ''}`, { signal }),
    enabled,
    staleTime: DAILY_STALE_MS,
    placeholderData: keepPreviousData,
  });
}

/** Paying sign-ups (`dashboard.revenue`): never requested without it. */
export function useStatsConversion(range: StatsRange, enabled: boolean) {
  return useQuery({
    queryKey: statsKeys.conversion(range),
    queryFn: ({ signal }) => apiRequest<AdminStatsConversion>(`/v1/admin/stats/conversion?${rangeQuery(range)}`, { signal }),
    enabled,
    staleTime: DAILY_STALE_MS,
    placeholderData: keepPreviousData,
  });
}

export function useStatsModeration(range: StatsRange) {
  return useQuery({
    queryKey: statsKeys.moderation(range),
    queryFn: ({ signal }) => apiRequest<AdminStatsModeration>(`/v1/admin/stats/moderation?${rangeQuery(range)}`, { signal }),
    staleTime: DAILY_STALE_MS,
    placeholderData: keepPreviousData,
  });
}

/**
 * When every statistics read on screen has failed with nothing to show (the
 * API down, a deploy): the first one's error and a retry of them all, so the
 * page shows one notice instead of one per card. Null otherwise.
 */
export function useStatsPageFailure(): { error: unknown; retry: () => void } | null {
  const client = useQueryClient();
  const cache = client.getQueryCache();
  const subscribe = useCallback((onChange: () => void) => cache.subscribe(onChange), [cache]);
  const failedHash = useSyncExternalStore(subscribe, () => {
    const queries = cache.findAll({ queryKey: ['stats'], type: 'active' }).filter((q) => q.queryKey[1] !== 'live');
    const failed = queries.length > 1 && queries.every((q) => q.state.status === 'error' && q.state.data === undefined);
    return failed ? queries[0]!.queryHash : null;
  });
  const retry = useCallback(() => {
    void client.refetchQueries({ queryKey: ['stats'], type: 'active', predicate: (q) => q.queryKey[1] !== 'live' });
  }, [client]);
  if (failedHash === null) return null;
  return { error: cache.get(failedHash)?.state.error ?? null, retry };
}

// ─── Series ──────────────────────────────────────────────────────────────

/** The active-people card's metrics (its read also gives the page its newest day). */
export const ACTIVE_METRICS = ['dau', 'wau', 'mau'] as const satisfies readonly StatsSeriesMetric[];

/** One value per day of `days` for `metric` (a day without a row is null: not rolled up). */
export function seriesValues(answer: AdminStatsSeries | undefined, metric: StatsSeriesMetric, days: readonly string[]): (number | null)[] {
  const points = new Map(answer?.series.find((s) => s.metric === metric)?.points.map((p) => [p.day, p.value]));
  return days.map((day) => points.get(day) ?? null);
}

/** The sum of the known values (null when none is known). */
export function sumOf(values: readonly (number | null)[]): number | null {
  let total: number | null = null;
  for (const value of values) if (value !== null) total = (total ?? 0) + value;
  return total;
}

/** The newest known value. */
export function lastOf(values: readonly (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i -= 1) if (values[i] !== null && values[i] !== undefined) return values[i]!;
  return null;
}

/** `part ÷ whole`, null when the whole is not known or zero. */
export function ratio(part: number | null, whole: number | null): number | null {
  return part === null || whole === null || whole === 0 ? null : part / whole;
}

/** A group of days: its first and last day and how many days it holds. */
export interface DaySpan {
  from: string;
  to: string;
  days: number;
}

/**
 * Days summed in groups of `size` counted back from the last day, so the
 * newest group is always whole and only the oldest may be short: each
 * group's first day, its span and the sum of its known values.
 */
export function bucketDays(
  days: readonly string[],
  series: readonly (readonly (number | null)[])[],
  size: number,
): { days: string[]; spans: DaySpan[]; series: (number | null)[][] } {
  const step = Math.max(1, Math.floor(size));
  const bounds: [number, number][] = [];
  for (let end = days.length; end > 0; end -= step) bounds.unshift([Math.max(0, end - step), end]);
  const spans = bounds.map(([start, end]) => ({ from: days[start]!, to: days[end - 1]!, days: end - start }));
  return { days: spans.map((span) => span.from), spans, series: series.map((values) => bounds.map(([start, end]) => sumOf(values.slice(start, end)))) };
}

// ─── Cohorts (retention and conversion) ──────────────────────────────────

/** A rate measured over a group of cohorts: how many of `base` sign-ups did it. */
export interface CohortCell {
  reached: number;
  base: number;
}

export interface CohortLine {
  /** The first day of the cohort (or of the week). */
  day: string;
  signups: number;
  /** One cell per measure (day 1, 7, 30...); null: not measurable yet. */
  cells: (CohortCell | null)[];
}

/** One line per sign-up day from each day's sign-ups and measured counts. */
export function cohortLines<T extends { day: string; signups: number }>(cohorts: readonly T[], measures: (cohort: T) => readonly (number | null)[]): CohortLine[] {
  return cohorts.map((cohort) => ({
    day: cohort.day,
    signups: cohort.signups,
    cells: measures(cohort).map((reached) => (reached === null ? null : { reached, base: cohort.signups })),
  }));
}

/** Lines merged into one: each measure over the cohorts where it was measured (sign-ups weighted). */
export function mergeLines(day: string, lines: readonly CohortLine[]): CohortLine {
  const width = lines[0]?.cells.length ?? 0;
  const cells = Array.from({ length: width }, (_, i) => {
    let reached = 0;
    let base = 0;
    let measured = false;
    for (const line of lines) {
      const cell = line.cells[i];
      if (!cell) continue;
      measured = true;
      reached += cell.reached;
      base += cell.base;
    }
    return measured ? { reached, base } : null;
  });
  return { day, signups: lines.reduce((sum, line) => sum + line.signups, 0), cells };
}

/** Daily lines, newest first; past a month, weeks counted back from the newest day (only the oldest may be short). */
export function cohortTable(lines: readonly CohortLine[]): CohortLine[] {
  const size = lines.length > 31 ? 7 : 1;
  const groups: CohortLine[] = [];
  for (let end = lines.length; end > 0; end -= size) {
    const part = lines.slice(Math.max(0, end - size), end);
    groups.push(size === 1 ? part[0]! : mergeLines(part[0]!.day, part));
  }
  return groups;
}

export const cellRate = (cell: CohortCell | null | undefined): number | null => (cell ? ratio(cell.reached, cell.base) : null);

// ─── Subscriptions ───────────────────────────────────────────────────────

/** Fewer days of snapshots than this give no churn rate (too noisy). */
export const CHURN_MIN_DAYS = 7;

/**
 * Churn per 30 days over the days of the range that have a subscription
 * snapshot: the subscriptions that ended on those days ÷ the average active
 * ones, scaled to 30 days. Null with fewer than a week of snapshots.
 */
export function monthlyChurn(data: Pick<AdminStatsRevenue, 'subscriptions' | 'churn'>): { ended: number; rate: number | null } {
  const days = new Set(data.subscriptions.map((s) => s.day));
  const ended = data.churn.filter((c) => days.has(c.day)).reduce((sum, c) => sum + c.ended, 0);
  if (days.size < CHURN_MIN_DAYS) return { ended, rate: null };
  const average = data.subscriptions.reduce((sum, s) => sum + s.active, 0) / days.size;
  const rate = ratio(ended, average);
  return { ended, rate: rate === null ? null : (rate * 30) / days.size };
}

// ─── Money ───────────────────────────────────────────────────────────────

/** Decimal micros of a currency as an exact decimal string of units ("12345670" → "12.34567"). */
export function microsToUnits(micros: string): string {
  const negative = micros.startsWith('-');
  const digits = (negative ? micros.slice(1) : micros).replace(/^0+(?=\d)/, '').padStart(7, '0');
  const whole = digits.slice(0, -6).replace(/^0+(?=\d)/, '');
  const fraction = digits.slice(-6).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** The sum of decimal micros (exact). */
export function addMicros(...values: readonly string[]): string {
  return values.reduce((sum, value) => sum + BigInt(value), 0n).toString();
}

/** `a − b` of decimal micros (exact). */
export function subMicros(a: string, b: string): string {
  return (BigInt(a) - BigInt(b)).toString();
}

/** An amount in its currency in the panel's language (Persian digits in Persian); never converted. */
export function formatMoney(micros: string, currency: string, locale: Locale): string {
  try {
    const format = new Intl.NumberFormat(locale, { style: 'currency', currency });
    // A decimal string keeps every digit (Intl reads it exactly); rounding to the currency's own digits is Intl's.
    return format.format(microsToUnits(micros) as `${number}`);
  } catch {
    return `${microsToUnits(micros)} ${currency}`;
  }
}

/** A short amount of units for an axis or a readout ("$1.2K"), in its currency. */
export function formatUnitsShort(units: number, currency: string, locale: Locale): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(units);
  } catch {
    return `${formatCount(units, locale)} ${currency}`;
  }
}

/** Decimal micros as a number of units, for drawing (exact enough for a chart, never for a sum). */
export const unitsOf = (micros: string) => Number(microsToUnits(micros));

/** A currency's name in the panel's language ("US dollar"); the code when the runtime does not know it. */
export function currencyName(code: string, locale: Locale): string {
  try {
    return new Intl.DisplayNames(locale, { type: 'currency', fallback: 'code' }).of(code) ?? code;
  } catch {
    return code;
  }
}

// ─── Words ───────────────────────────────────────────────────────────────

const DAY_STYLES = {
  short: { timeZone: 'UTC', day: 'numeric', month: 'short' },
  numeric: { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' },
  month: { timeZone: 'UTC', month: 'short', year: 'numeric' },
  medium: { timeZone: 'UTC', dateStyle: 'medium' },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

/** A UTC day in the panel's language and calendar: `short` "20 Nov" and `month` "Nov 2026" for axes, `numeric` "11/20/2026" for a narrow column, `medium` with the year. */
export function formatStatsDay(day: string, locale: Locale, style: keyof typeof DAY_STYLES = 'medium'): string {
  const date = new Date(`${day}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat(locale, DAY_STYLES[style]).format(date);
}

/** A span of UTC days in the panel's language and calendar ("Nov 20 – 26, 2026", «۲۹ آبان تا ۵ آذر ۱۴۰۵»); a single day reads as that day. */
export function formatStatsSpan(from: string, to: string, locale: Locale): string {
  const start = new Date(`${from}T12:00:00.000Z`);
  const end = new Date(`${to}T12:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return from === to ? from : `${from} – ${to}`;
  return new Intl.DateTimeFormat(locale, DAY_STYLES.medium).formatRange(start, end);
}

/** A number of days in words ("2 days", «۲ روز», "2 gün"). */
export function formatDayCount(count: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { style: 'unit', unit: 'day', unitDisplay: 'long' }).format(count);
}

/** A ratio of two counts ("1.25", «۱٫۲۵»). */
export function formatRatio(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(value);
}

/** A share as a percentage in the panel's digits ("12.5%", «٪۱۲٫۵»). */
export function formatPercent(value: number, locale: Locale, fractionDigits = 1): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: fractionDigits }).format(value);
}

/** A count for an axis or a tile: in full under 10,000, then compact ("12K", «۱۲ هزار»). */
export function formatCount(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, Math.abs(value) < 10_000 ? { maximumFractionDigits: 0 } : { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** A length of time in the largest unit that fits ("45 sec", "12 min", "3.5 hr", "2 days"). */
export function formatSpan(seconds: number, locale: Locale): string {
  const unit = (value: number, name: 'second' | 'minute' | 'hour' | 'day', digits = 0) =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'short', maximumFractionDigits: digits }).format(value);
  if (seconds < 60) return unit(Math.round(seconds), 'second');
  if (seconds < 3_600) return unit(Math.round(seconds / 60), 'minute');
  if (seconds < 172_800) return unit(seconds / 3_600, 'hour', 1);
  return unit(seconds / 86_400, 'day', 1);
}

/** A clean upper bound and four ticks for an axis from 0. */
export function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0, 1, 2, 3, 4].map((n) => n / 4);
  const raw = max / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  return [0, 1, 2, 3, 4].map((n) => n * step);
}

// ─── Tables (a card's "Show table" and its CSV) ──────────────────────────

export type StatsColumnKind = 'day' | 'count' | 'percent' | 'ratio' | 'money' | 'span' | 'text';

export interface StatsColumn {
  label: string;
  kind: StatsColumnKind;
  /** The currency of a money column. */
  currency?: string;
  /** Below this width the column leaves the table for a line under the first cell (a secondary figure). */
  narrow?: 'sm' | 'md';
}

/** A cell: a day, a count, a ratio (percent), decimal micros (money), seconds (span) or text; a string in a count column is shown as it is ("<5"). */
export type StatsCellValue = string | number | null;

export interface StatsTable {
  columns: StatsColumn[];
  rows: StatsCellValue[][];
}

/** A cell as the page shows it (the panel's digits and calendar); null is a dash. */
export function statsCellText(value: StatsCellValue, column: StatsColumn, locale: Locale): string {
  if (value === null) return '—';
  if (typeof value === 'string' && column.kind !== 'day' && column.kind !== 'money' && column.kind !== 'text') return value;
  switch (column.kind) {
    case 'day':
      return formatStatsDay(String(value), locale);
    case 'count':
      return formatNumber(Number(value), locale);
    case 'percent':
      return formatPercent(Number(value), locale);
    case 'ratio':
      return formatRatio(Number(value), locale);
    case 'money':
      return formatMoney(String(value), column.currency ?? 'XXX', locale);
    case 'span':
      return formatSpan(Number(value), locale);
    case 'text':
      return String(value);
  }
}

/** Bidirectional isolates (a text shown in a table is isolated; its CSV cell is not). */
const ISOLATES = /[\u2066-\u2069]/g;

/** The same rows for a CSV file: ISO days, plain numbers, ratios to 4 places, amounts in units, texts without isolates. */
export function statsCsvRows(table: StatsTable): CsvCell[][] {
  return table.rows.map((row) =>
    row.map((value, i) => {
      const column = table.columns[i];
      if (value === null || !column) return value;
      if (column.kind === 'money') return microsToUnits(String(value));
      if ((column.kind === 'percent' || column.kind === 'ratio') && typeof value === 'number') return Math.round(value * 10_000) / 10_000;
      if (typeof value === 'string') return value.replace(ISOLATES, '');
      return value;
    }),
  );
}

/** A CSV file's name: `stats-<card>[-<part>]-<from>-<to>.csv` (the part: a currency). */
export const csvName = (card: string, range: StatsRange, part?: string | null) => `stats-${card}${part ? `-${part}` : ''}-${range.from}-${range.to}.csv`;

/** The places' CSV file's name: `stats-places-<kind>-<day>.csv`. */
export const placesCsvName = (kind: PlaceKind, day: string) => `stats-places-${kind}-${day}.csv`;

interface QueryLike {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  data?: unknown;
  isPlaceholderData?: boolean;
  isFetching?: boolean;
  refetch: () => unknown;
}

/** What a card shows of its reads: loading (none answered yet), failed (one failed with nothing to show), refreshing (an older answer shown meanwhile). */
export interface CardState {
  pending: boolean;
  error: unknown;
  refreshing: boolean;
  retry: () => void;
}

export function cardState(...queries: readonly QueryLike[]): CardState {
  const failed = queries.find((q) => q.isError && q.data === undefined);
  return {
    pending: !failed && queries.some((q) => q.isPending),
    error: failed ? failed.error : null,
    refreshing: queries.some((q) => q.isPlaceholderData === true),
    retry: () => {
      for (const q of queries) if (q.isError) void q.refetch();
    },
  };
}
