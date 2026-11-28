import {
  PARTITION_XID_AGE_WARN,
  PROCESS_STALE_MS,
  SYSTEM_JOB_ACTION_MAX,
  VALKEY_MEMORY_DANGER,
  VALKEY_MEMORY_WARN,
  type AdminDeadLetter,
  type AdminDeadLetterDelete,
  type AdminQueue,
  type AdminRun,
  type AdminSystemHealth,
  type AdminSystemPartitions,
  type AdminSystemQueues,
  type AdminSystemStreams,
  type AdminTask,
  type Locale,
  type SideEffects,
  type StreamName,
} from '@app/shared';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { MessageKey } from '@/i18n/messages';
import { hasMessage, type Translate } from '@/i18n/translate';
import { apiRequest } from './api';
import { queryClient } from './queries';
import { formatSpan } from './stats';

/**
 * The jobs and health page's reads (`GET /v1/admin/system/*`) and writes,
 * and the helpers that turn their answers into what the page shows. The
 * health, queue and stream reads cost the database nothing (one cached
 * readiness probe at most) and are polled every 30 s while the tab is
 * visible; the partitions (one catalog statement) every 5 minutes. A failed
 * poll keeps the last answer.
 */

export const SYSTEM_POLL_MS = 30_000;
export const PARTITIONS_POLL_MS = 300_000;
export const DEAD_LETTER_PAGE = 50;

/** A saving queue this far behind is amber, and red from the second. */
export const LAG_WARN_MS = 60_000;
export const LAG_DANGER_MS = 600_000;

export const systemKeys = {
  all: ['system'] as const,
  health: ['system', 'health'] as const,
  queues: ['system', 'queues'] as const,
  streams: ['system', 'streams'] as const,
  partitions: ['system', 'partitions'] as const,
  deadLetters: (stream: StreamName) => ['system', 'dead-letters', stream] as const,
};

const polled = (ms: number) => ({ staleTime: 0, refetchInterval: ms, refetchIntervalInBackground: false, placeholderData: keepPreviousData });

export function useSystemHealth() {
  return useQuery({ queryKey: systemKeys.health, queryFn: ({ signal }) => apiRequest<AdminSystemHealth>('/v1/admin/system/health', { signal }), ...polled(SYSTEM_POLL_MS) });
}

export function useSystemQueues() {
  return useQuery({ queryKey: systemKeys.queues, queryFn: ({ signal }) => apiRequest<AdminSystemQueues>('/v1/admin/system/queues', { signal }), ...polled(SYSTEM_POLL_MS) });
}

export function useSystemStreams() {
  return useQuery({ queryKey: systemKeys.streams, queryFn: ({ signal }) => apiRequest<AdminSystemStreams>('/v1/admin/system/streams', { signal }), ...polled(SYSTEM_POLL_MS) });
}

export function useSystemPartitions() {
  return useQuery({
    queryKey: systemKeys.partitions,
    queryFn: ({ signal }) => apiRequest<AdminSystemPartitions>('/v1/admin/system/partitions', { signal }),
    ...polled(PARTITIONS_POLL_MS),
  });
}

/** A stream's failed entries, newest first, a page at a time (read while its dialog is open). */
export function useDeadLetters(stream: StreamName, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: systemKeys.deadLetters(stream),
    enabled,
    staleTime: 0,
    initialPageParam: null as string | null,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor,
    queryFn: ({ pageParam, signal }) =>
      apiRequest<{ items: AdminDeadLetter[]; nextCursor: string | null }>(
        `/v1/admin/system/streams/${stream}/dead-letters?limit=${DEAD_LETTER_PAGE}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal },
      ),
  });
}

/** Reads every card of the page again (the page's Refresh). */
export function refreshSystem(): Promise<void> {
  return queryClient.refetchQueries({ queryKey: systemKeys.all, type: 'active' });
}

// ─── Writes ─────────────────────────────────────────────────────────────────

export interface DeadLettersDeleted {
  deleted: number;
  sideEffects: SideEffects;
}

export interface JobGroupResult {
  matched: number;
  done: number;
  more: boolean;
  sideEffects: SideEffects;
}

export interface TaskRunResult {
  queued: boolean;
  /** This minute's run was started already: nothing was added. */
  already: boolean;
  jobId: string;
  sideEffects: SideEffects;
}

export function deleteDeadLetters(body: AdminDeadLetterDelete): Promise<DeadLettersDeleted> {
  return apiRequest<DeadLettersDeleted>('/v1/admin/system/dead-letters/delete', { method: 'POST', body });
}

/** Retries or removes a failed group; `max` bounds it to the count the page showed (else the server's own bound). */
export function actOnFailedJobs(action: 'retry' | 'remove', queue: string, name: string, max?: number): Promise<JobGroupResult> {
  return apiRequest<JobGroupResult>(`/v1/admin/system/jobs/${action}`, { method: 'POST', body: max === undefined ? { queue, name } : { queue, name, max } });
}

/**
 * How many jobs a retry or remove of a shown group acts on: the count shown
 * when the page counted every failed job of the queue (`max` sent), else
 * the server's bound (no `max`: the count shown is partial).
 */
export function groupAction(queue: Pick<AdminQueue, 'failed'>, count: number): { max: number | undefined; exact: boolean } {
  if (queue.failed.more) return { max: undefined, exact: false };
  return { max: Math.min(Math.max(1, count), SYSTEM_JOB_ACTION_MAX), exact: true };
}

export function runTask(queue: string, name: string): Promise<TaskRunResult> {
  return apiRequest<TaskRunResult>('/v1/admin/system/tasks/run', { method: 'POST', body: { queue, name } });
}

// ─── Words ──────────────────────────────────────────────────────────────────

/** A shown name, and whether it is a code (drawn in mono, left to right). */
export interface ShownName {
  name: string;
  mono: boolean;
}

/** A job queue's words (the dashboard's); one this build has no words for keeps its code. */
export function queueLabel(queue: string, t: Translate): ShownName {
  const key = `dashboard.queue.${queue}`;
  return hasMessage(key) ? { name: t(key), mono: false } : { name: queue, mono: true };
}

/** A scheduled task's words (`jobs.task.<queue>.<name>`); one without keeps `queue/name`. */
export function taskLabel(queue: string, name: string, t: Translate): ShownName {
  const key = `jobs.task.${queue}.${name}`;
  return hasMessage(key) ? { name: t(key), mono: false } : { name: `${queue}/${name}`, mono: true };
}

/** A failed group's job: a task's words where it has them, `other` worded, any other name as its code. */
export function failedJobLabel(queue: string, name: string, t: Translate): ShownName {
  if (name === 'other') return { name: t('jobs.failed.other'), mono: false };
  const key = `jobs.task.${queue}.${name}`;
  return hasMessage(key) ? { name: t(key), mono: false } : { name, mono: true };
}

/** A failed entry's kind: a message's in the panel's words for message kinds, a like's in the page's. */
export function deadLetterKindText(entry: Pick<AdminDeadLetter, 'stream' | 'kind'>, t: Translate): string {
  if (entry.kind === null) return t('common.none');
  if (entry.stream === 'msg') {
    const key = `messageKind.${entry.kind}`;
    return hasMessage(key) ? t(key) : entry.kind;
  }
  const key = `jobs.dead.kind.${entry.kind}`;
  return hasMessage(key) ? t(key) : entry.kind;
}

// ─── Schedules ──────────────────────────────────────────────────────────────

export type Schedule =
  | { kind: 'every'; ms: number }
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; day: number; hour: number; minute: number }
  | { kind: 'cron'; pattern: string; utc: boolean }
  | { kind: 'unscheduled' };

const FIELD = /^(\d{1,2})$/;

/**
 * What a task's schedule is: every so long, an hourly, daily or weekly cron,
 * any other cron as written, or none (a task "Run now" lists whose
 * scheduler no worker has registered yet).
 */
export function scheduleOf(task: Pick<AdminTask, 'every' | 'pattern' | 'tz'>): Schedule {
  if (task.every !== null) return { kind: 'every', ms: task.every };
  if (task.pattern === null) return { kind: 'unscheduled' };
  const utc = task.tz === null || task.tz === 'UTC' || task.tz === 'Etc/UTC';
  const parts = task.pattern.trim().split(/\s+/);
  if (utc && parts.length === 5) {
    const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
    const minute = FIELD.test(m) ? Number(m) : NaN;
    const hour = FIELD.test(h) ? Number(h) : NaN;
    if (minute >= 0 && minute < 60 && dom === '*' && mon === '*') {
      if (h === '*' && dow === '*') return { kind: 'hourly', minute };
      if (hour >= 0 && hour < 24) {
        if (dow === '*') return { kind: 'daily', hour, minute };
        if (/^[0-7]$/.test(dow)) return { kind: 'weekly', day: Number(dow) % 7, hour, minute };
      }
    }
  }
  return { kind: 'cron', pattern: task.pattern, utc };
}

/** A time of day in the panel's digits ("03:17"), in the browser's zone (or `timeZone`). */
export function clockOf(date: Date, locale: Locale, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) }).format(date);
}

/** A weekday's name in the panel's language, in the browser's zone (or `timeZone`). */
export function weekdayOf(date: Date, locale: Locale, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'long', ...(timeZone ? { timeZone } : {}) }).format(date);
}

/** A daily or weekly cron's next moment from `now` (UTC hour and minute, and weekday 0 Sunday). */
export function nextCronAt(schedule: { hour: number; minute: number; day?: number }, now: Date = new Date()): Date {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), schedule.hour, schedule.minute);
  let at = today < now.getTime() ? today + 86_400_000 : today;
  if (schedule.day !== undefined) at += ((schedule.day - new Date(at).getUTCDay() + 7) % 7) * 86_400_000;
  return new Date(at);
}

/**
 * A schedule in words ("Every 30 sec", "Daily, 06:47"): a daily or weekly
 * cron in the browser's time of day (and weekday), as every other time on
 * the page; a cron no rule reads is shown as written.
 */
export function scheduleText(schedule: Schedule, t: Translate, locale: Locale, now: Date = new Date()): string {
  switch (schedule.kind) {
    case 'every':
      return t('jobs.task.every', { duration: formatSpan(schedule.ms / 1000, locale) });
    case 'hourly':
      return t('jobs.task.hourly', { minute: schedule.minute });
    case 'daily':
      return t('jobs.task.daily', { time: clockOf(nextCronAt(schedule, now), locale) });
    case 'weekly': {
      const at = nextCronAt(schedule, now);
      return t('jobs.task.weekly', { day: weekdayOf(at, locale), time: clockOf(at, locale) });
    }
    case 'cron':
      return schedule.pattern;
    case 'unscheduled':
      return t('jobs.task.notScheduled');
  }
}

/** A daily or weekly cron as written, in UTC ("03:17 UTC", "Sunday 04:41 UTC"), for a hover title; null for the others. */
export function scheduleUtc(schedule: Schedule, locale: Locale, now: Date = new Date()): string | null {
  if (schedule.kind !== 'daily' && schedule.kind !== 'weekly') return null;
  const at = nextCronAt(schedule, now);
  const clock = `${clockOf(at, locale, 'UTC')} UTC`;
  return schedule.kind === 'weekly' ? `${weekdayOf(at, locale, 'UTC')} ${clock}` : clock;
}

// ─── Runs and tones ─────────────────────────────────────────────────────────

export type RunState = 'ok' | 'skipped' | 'retrying' | 'failed';

/** How a task's last run ended: done, done without work (another run held the lease), failed with retries left, or failed. */
export function runState(run: Pick<AdminRun, 'ok' | 'willRetry' | 'summary'>): RunState {
  if (run.ok) return run.summary['leased'] === false ? 'skipped' : 'ok';
  return run.willRetry ? 'retrying' : 'failed';
}

/** A run's own figures (what it made, dropped, held...), without `leased`, which its state already shows. */
export function runFigures(run: Pick<AdminRun, 'summary'>): [string, number | boolean][] {
  return Object.entries(run.summary).filter(([key]) => key !== 'leased');
}

export const runTone: Readonly<Record<RunState, 'green' | 'gray' | 'amber' | 'red'>> = { ok: 'green', skipped: 'gray', retrying: 'amber', failed: 'red' };
export const runWords: Readonly<Record<RunState, MessageKey>> = { ok: 'jobs.task.ok', skipped: 'jobs.task.skipped', retrying: 'jobs.task.retrying', failed: 'jobs.task.failed' };

export type Tone = 'green' | 'amber' | 'red';

/** Valkey memory in use: amber from 70 %, red from 90 % (no limit: green). */
export function memoryTone(used: number | null, max: number | null): Tone {
  if (used === null || max === null || max <= 0) return 'green';
  const share = used / max;
  return share >= VALKEY_MEMORY_DANGER ? 'red' : share >= VALKEY_MEMORY_WARN ? 'amber' : 'green';
}

/** A saving queue's delay: the larger of its oldest unsaved entry and its watermark; null when neither is known. */
export function streamDelayMs(stream: Pick<AdminSystemStreams['streams'][number], 'lagMs' | 'watermarkLagMs'>): number | null {
  if (stream.lagMs === null && stream.watermarkLagMs === null) return null;
  return Math.max(stream.lagMs ?? 0, stream.watermarkLagMs ?? 0);
}

export function lagTone(ms: number | null): Tone {
  if (ms === null) return 'green';
  return ms > LAG_DANGER_MS ? 'red' : ms > LAG_WARN_MS ? 'amber' : 'green';
}

/** A partitioned table's state: red with no partition for now, amber with fewer made ahead than planned or an old transaction age. */
export function partitionTone(parent: Pick<AdminSystemPartitions['parents'][number], 'current' | 'ahead' | 'premake' | 'maxXidAge'>): Tone {
  if (!parent.current) return 'red';
  if (parent.ahead < parent.premake || parent.maxXidAge >= PARTITION_XID_AGE_WARN) return 'amber';
  return 'green';
}

/** Whether a process's settings are older than the current ones. */
export function behind(cfgVersion: number | null, current: number | null): boolean {
  return cfgVersion !== null && current !== null && cfgVersion < current;
}

/** Processes are listed while heard from within this long (the server leaves older ones out). */
export const PROCESS_STALE_SECONDS = PROCESS_STALE_MS / 1000;

// ─── Numbers ────────────────────────────────────────────────────────────────

const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

/** A size in the largest unit that fits (1,024 steps), in the panel's digits and words ("1.5 GB", «۱٫۵ گیگابایت»). */
export function formatBytes(bytes: number, locale: Locale): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Persian reads the units in words (ICU's short ones are Latin); bytes alone too ("512 bytes").
  const display = locale === 'fa' || unit === 0 ? 'long' : 'short';
  return new Intl.NumberFormat(locale, { style: 'unit', unit: BYTE_UNITS[unit], unitDisplay: display, maximumFractionDigits: unit === 0 || value >= 100 ? 0 : 1 }).format(value);
}

/** A short length of time: milliseconds under a second ("240 ms"), else as the statistics write it ("0 sec", "12 sec", "3 min"). */
export function formatShortSpan(ms: number, locale: Locale): string {
  if (ms > 0 && ms < 1000) return new Intl.NumberFormat(locale, { style: 'unit', unit: 'millisecond', unitDisplay: 'short', maximumFractionDigits: 0 }).format(Math.max(0, Math.round(ms)));
  return formatSpan(ms / 1000, locale);
}

/** Milliseconds as such ("4 ms", «۴ میلی‌ثانیه»): a round trip. */
export function formatMs(ms: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { style: 'unit', unit: 'millisecond', unitDisplay: 'short', maximumFractionDigits: 0 }).format(Math.max(0, Math.round(ms)));
}

/** A length of months or days in words ("12 months", «۱۲ ماه»). */
export function formatPeriodLength(value: number, unit: 'month' | 'day', locale: Locale): string {
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long', maximumFractionDigits: 0 }).format(value);
}
