import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { translate } from '../src/i18n/translate';
import {
  behind,
  deadLetterKindText,
  failedJobLabel,
  formatBytes,
  formatShortSpan,
  groupAction,
  lagTone,
  memoryTone,
  nextCronAt,
  partitionTone,
  queueLabel,
  runFigures,
  runState,
  scheduleOf,
  scheduleText,
  scheduleUtc,
  streamDelayMs,
  taskLabel,
} from '../src/lib/system';

/** The jobs page's helpers: schedules in words, run states, tones, sizes, names. */

const t = (locale: 'en' | 'fa' | 'tr') => (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => translate(locale, key, values);

describe('schedules', () => {
  it('read every so long, hourly, daily and weekly crons in UTC, any other cron as written, none as not scheduled', () => {
    expect(scheduleOf({ every: 30_000, pattern: null, tz: null })).toEqual({ kind: 'every', ms: 30_000 });
    expect(scheduleOf({ every: null, pattern: '17 * * * *', tz: 'UTC' })).toEqual({ kind: 'hourly', minute: 17 });
    expect(scheduleOf({ every: null, pattern: '17 3 * * *', tz: 'UTC' })).toEqual({ kind: 'daily', hour: 3, minute: 17 });
    expect(scheduleOf({ every: null, pattern: '41 4 * * 0', tz: null })).toEqual({ kind: 'weekly', day: 0, hour: 4, minute: 41 });
    expect(scheduleOf({ every: null, pattern: '41 4 * * 7', tz: 'UTC' })).toEqual({ kind: 'weekly', day: 0, hour: 4, minute: 41 });
    expect(scheduleOf({ every: null, pattern: '*/5 * * * *', tz: 'UTC' })).toEqual({ kind: 'cron', pattern: '*/5 * * * *', utc: true });
    expect(scheduleOf({ every: null, pattern: '0 3 1 * *', tz: 'UTC' })).toEqual({ kind: 'cron', pattern: '0 3 1 * *', utc: true });
    // Another zone: shown as written, never read as UTC.
    expect(scheduleOf({ every: null, pattern: '17 3 * * *', tz: 'Asia/Tehran' })).toEqual({ kind: 'cron', pattern: '17 3 * * *', utc: false });
    // A task "Run now" lists whose scheduler no worker registered.
    expect(scheduleOf({ every: null, pattern: null, tz: null })).toEqual({ kind: 'unscheduled' });
  });

  describe('in the browser’s time of day', () => {
    const zone = process.env['TZ'];
    beforeAll(() => {
      process.env['TZ'] = 'Asia/Tehran';
    });
    afterAll(() => {
      if (zone === undefined) delete process.env['TZ'];
      else process.env['TZ'] = zone;
    });
    // Wednesday 2 December 2026, 12:00 UTC.
    const now = new Date(Date.UTC(2026, 11, 2, 12, 0));

    it('are worded in each language, with the panel’s digits, as local times (UTC on hover)', () => {
      expect(scheduleText({ kind: 'every', ms: 900_000 }, t('en'), 'en', now)).toBe('Every 15 min');
      expect(scheduleText({ kind: 'daily', hour: 0, minute: 41 }, t('en'), 'en', now)).toBe('Daily, 04:11');
      expect(scheduleText({ kind: 'weekly', day: 0, hour: 4, minute: 41 }, t('en'), 'en', now)).toBe('Weekly, Sunday 08:11');
      // Late on Sunday in UTC is Monday in Tehran.
      expect(scheduleText({ kind: 'weekly', day: 0, hour: 22, minute: 30 }, t('en'), 'en', now)).toBe('Weekly, Monday 02:00');
      expect(scheduleText({ kind: 'hourly', minute: 7 }, t('fa'), 'fa', now)).toBe('هر ساعت، دقیقه‌ی ۷');
      expect(scheduleText({ kind: 'daily', hour: 3, minute: 17 }, t('fa'), 'fa', now)).toBe('هر روز، ساعت ۰۶:۴۷');
      expect(scheduleText({ kind: 'weekly', day: 0, hour: 4, minute: 41 }, t('fa'), 'fa', now)).toBe('هر هفته، یکشنبه ساعت ۰۸:۱۱');
      expect(scheduleText({ kind: 'daily', hour: 3, minute: 17 }, t('tr'), 'tr', now)).toBe('Her gün, 06:47');
      expect(scheduleText({ kind: 'unscheduled' }, t('en'), 'en', now)).toBe('Not scheduled');
      expect(scheduleText({ kind: 'unscheduled' }, t('fa'), 'fa', now)).toBe('زمان‌بندی نشده');
      expect(scheduleUtc({ kind: 'daily', hour: 3, minute: 17 }, 'en', now)).toBe('03:17 UTC');
      expect(scheduleUtc({ kind: 'weekly', day: 0, hour: 22, minute: 30 }, 'en', now)).toBe('Sunday 22:30 UTC');
      expect(scheduleUtc({ kind: 'every', ms: 1_000 }, 'en', now)).toBeNull();
    });

    it('find the next moment of a daily or weekly cron', () => {
      expect(nextCronAt({ hour: 13, minute: 0 }, now).toISOString()).toBe('2026-12-02T13:00:00.000Z');
      expect(nextCronAt({ hour: 3, minute: 17 }, now).toISOString()).toBe('2026-12-03T03:17:00.000Z');
      expect(nextCronAt({ hour: 4, minute: 41, day: 0 }, now).toISOString()).toBe('2026-12-06T04:41:00.000Z');
      expect(nextCronAt({ hour: 13, minute: 0, day: 3 }, now).toISOString()).toBe('2026-12-02T13:00:00.000Z');
      expect(nextCronAt({ hour: 11, minute: 0, day: 3 }, now).toISOString()).toBe('2026-12-09T11:00:00.000Z');
    });
  });
});

describe('runs and tones', () => {
  it('list a run’s own figures without the lease, which its state shows', () => {
    expect(runFigures({ summary: { leased: true, ensured: 2, dropped: 1, held: 0 } })).toEqual([
      ['ensured', 2],
      ['dropped', 1],
      ['held', 0],
    ]);
    expect(runFigures({ summary: { leased: false } })).toEqual([]);
  });

  it('bound a failed group’s action to the count shown only when the page counted every failed job', () => {
    expect(groupAction({ failed: { scanned: 12, more: false, groups: [] } }, 12)).toEqual({ max: 12, exact: true });
    expect(groupAction({ failed: { scanned: 200, more: true, groups: [] } }, 188)).toEqual({ max: undefined, exact: false });
  });

  it('tell a run that did its work, one another run held, one that will retry and one that failed', () => {
    expect(runState({ ok: true, willRetry: false, summary: { ensured: 3 } })).toBe('ok');
    expect(runState({ ok: true, willRetry: false, summary: { leased: false } })).toBe('skipped');
    expect(runState({ ok: false, willRetry: true, summary: {} })).toBe('retrying');
    expect(runState({ ok: false, willRetry: false, summary: {} })).toBe('failed');
  });

  it('colour memory from 70 % and 90 %, delay past a minute and ten, partitions short of plan or missing', () => {
    expect(memoryTone(69, 100)).toBe('green');
    expect(memoryTone(70, 100)).toBe('amber');
    expect(memoryTone(90, 100)).toBe('red');
    expect(memoryTone(5, null)).toBe('green');
    expect(lagTone(null)).toBe('green');
    expect(lagTone(60_000)).toBe('green');
    expect(lagTone(60_001)).toBe('amber');
    expect(lagTone(600_001)).toBe('red');
    expect(streamDelayMs({ lagMs: 1_000, watermarkLagMs: 30_000 })).toBe(30_000);
    expect(streamDelayMs({ lagMs: null, watermarkLagMs: null })).toBeNull();
    expect(partitionTone({ current: true, ahead: 3, premake: 3, maxXidAge: 10 })).toBe('green');
    expect(partitionTone({ current: true, ahead: 2, premake: 3, maxXidAge: 10 })).toBe('amber');
    expect(partitionTone({ current: true, ahead: 3, premake: 3, maxXidAge: 150_000_000 })).toBe('amber');
    expect(partitionTone({ current: false, ahead: 3, premake: 3, maxXidAge: 10 })).toBe('red');
    expect(behind(41, 42)).toBe(true);
    expect(behind(42, 42)).toBe(false);
    expect(behind(null, 42)).toBe(false);
  });
});

describe('numbers and names', () => {
  it('write sizes and short spans in the panel’s digits', () => {
    expect(formatBytes(512, 'en')).toBe('512 bytes');
    expect(formatBytes(1536, 'en')).toBe('1.5 kB');
    expect(formatBytes(3 * 1024 ** 3, 'en')).toBe('3 GB');
    expect(formatBytes(3 * 1024 ** 3, 'fa')).toBe('۳ گیگابایت');
    expect(formatShortSpan(240, 'en')).toBe('240 ms');
    expect(formatShortSpan(31_000, 'en')).toBe('31 sec');
  });

  it('name queues, tasks and failed jobs in words where the panel has them, else by their code', () => {
    expect(queueLabel('photo', t('en'))).toEqual({ name: 'Photos', mono: false });
    expect(queueLabel('reels', t('en'))).toEqual({ name: 'reels', mono: true });
    expect(taskLabel('stats', 'rollup', t('en'))).toEqual({ name: 'Daily figures', mono: false });
    expect(taskLabel('growth', 'tick', t('en'))).toEqual({ name: 'growth/tick', mono: true });
    expect(failedJobLabel('photo', 'process', t('en'))).toEqual({ name: 'Photo processing', mono: false });
    expect(failedJobLabel('photo', 'resize', t('en'))).toEqual({ name: 'resize', mono: true });
    expect(failedJobLabel('photo', 'other', t('en'))).toEqual({ name: 'Other', mono: false });
    expect(failedJobLabel('maint', 'partitions', t('en'))).toEqual({ name: 'Partitions', mono: false });
    expect(deadLetterKindText({ stream: 'msg', kind: 'voice' }, t('en'))).toBe('Voice');
    expect(deadLetterKindText({ stream: 'like', kind: 'superlike' }, t('fa'))).toBe('سوپرلایک');
    expect(deadLetterKindText({ stream: 'match', kind: null }, t('en'))).toBe('—');
  });
});
