import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { translate } from '../src/i18n/translate';
import { factSeparator, formatDateTime, joinFacts, unbreakable } from '../src/lib/format';
import {
  behind,
  clockOf,
  deadLetterKindText,
  failedJobLabel,
  formatBytes,
  formatLatency,
  formatShare,
  formatShortSpan,
  groupAction,
  lagTone,
  localMinuteOf,
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
  systemAuditSubject,
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
      // The time of day never breaks across lines ("4:11" / "AM"): its space is a no-break one.
      expect(scheduleText({ kind: 'daily', hour: 0, minute: 41 }, t('en'), 'en', now)).toBe('Daily, 4:11\u00a0AM');
      expect(scheduleText({ kind: 'weekly', day: 0, hour: 4, minute: 41 }, t('en'), 'en', now)).toBe('Weekly, Sunday 8:11\u00a0AM');
      // Late on Sunday in UTC is Monday in Tehran.
      expect(scheduleText({ kind: 'weekly', day: 0, hour: 22, minute: 30 }, t('en'), 'en', now)).toBe('Weekly, Monday 2:00\u00a0AM');
      // Tehran is UTC+3:30: minute 7 of every UTC hour is minute 37 there.
      expect(scheduleText({ kind: 'hourly', minute: 7 }, t('fa'), 'fa', now)).toBe('هر ساعت، دقیقه‌ی ۳۷');
      expect(scheduleText({ kind: 'hourly', minute: 47 }, t('en'), 'en', now)).toBe('Hourly, minute 17');
      expect(scheduleText({ kind: 'daily', hour: 3, minute: 17 }, t('fa'), 'fa', now)).toBe('هر روز، ساعت ۶:۴۷');
      expect(scheduleText({ kind: 'weekly', day: 0, hour: 4, minute: 41 }, t('fa'), 'fa', now)).toBe('هر هفته، یکشنبه ساعت ۸:۱۱');
      expect(scheduleText({ kind: 'daily', hour: 3, minute: 17 }, t('tr'), 'tr', now)).toBe('Her gün, 06:47');
      expect(scheduleText({ kind: 'unscheduled' }, t('en'), 'en', now)).toBe('Not scheduled');
      expect(scheduleText({ kind: 'unscheduled' }, t('fa'), 'fa', now)).toBe('زمان‌بندی نشده');
      expect(scheduleUtc({ kind: 'hourly', minute: 7 }, t('en'), 'en', now)).toBe('Hourly, minute 7 UTC');
      expect(scheduleUtc({ kind: 'hourly', minute: 7 }, t('fa'), 'fa', now)).toBe('هر ساعت، دقیقه‌ی ۷ UTC');
      expect(scheduleUtc({ kind: 'daily', hour: 3, minute: 17 }, t('en'), 'en', now)).toBe('3:17 AM UTC');
      expect(scheduleUtc({ kind: 'daily', hour: 3, minute: 17 }, t('fa'), 'fa', now)).toBe('۳:۱۷ UTC');
      expect(scheduleUtc({ kind: 'weekly', day: 0, hour: 22, minute: 30 }, t('en'), 'en', now)).toBe('Sunday 10:30 PM UTC');
      expect(scheduleUtc({ kind: 'every', ms: 1_000 }, t('en'), 'en', now)).toBeNull();
    });

    it('read an hourly cron’s minute as the next run beside it does, in every language', () => {
      // The next run of "17 * * * *" from 12:00 UTC is 12:17 UTC, 15:47 in Tehran.
      const nextAt = new Date(Date.UTC(2026, 11, 2, 12, 17)).toISOString();
      expect(localMinuteOf(17, now)).toBe(47);
      expect(localMinuteOf(17, now, 'UTC')).toBe(17);
      expect(localMinuteOf(17, now, 'Asia/Kathmandu')).toBe(2);
      const minuteOf = (text: string, locale: 'fa' | 'en' | 'tr') => text.match(locale === 'fa' ? /[۰-۹]+(?=$)/ : /[0-9]+(?=( [AP]M)?$)/)?.[0];
      const digits = (text: string | undefined) => text?.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
      for (const locale of ['fa', 'en', 'tr'] as const) {
        const next = formatDateTime(nextAt, locale);
        const hourly = scheduleText({ kind: 'hourly', minute: 17 }, t(locale), locale, now);
        expect(digits(minuteOf(next, locale)), `${locale}: ${next}`).toBe('47');
        expect(hourly, locale).toContain(new Intl.NumberFormat(locale).format(47));
        expect(hourly, locale).not.toContain(new Intl.NumberFormat(locale).format(17));
      }
    });

    it('write a time of day as the next run beside them does: one format, the hour unpadded where the language writes it so', () => {
      // 06:47 in Tehran: the hour below ten is where the two used to differ («۰۶:۴۷» against «۶:۴۷»).
      const at = nextCronAt({ hour: 3, minute: 17 }, now);
      for (const locale of ['fa', 'en', 'tr'] as const) {
        const next = formatDateTime(at.toISOString(), locale);
        expect(next.endsWith(clockOf(at, locale)), `${locale}: ${next}`).toBe(true);
        expect(scheduleText({ kind: 'daily', hour: 3, minute: 17 }, t(locale), locale, now).endsWith(unbreakable(clockOf(at, locale))), locale).toBe(true);
      }
      expect(clockOf(at, 'fa')).toBe('۶:۴۷');
      expect(formatDateTime(at.toISOString(), 'fa')).toBe('۱۲ آذر ۱۴۰۵، ۶:۴۷');
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

  it('write every run under a second in milliseconds, 0 included', () => {
    expect(formatShortSpan(0, 'en')).toBe('0 ms');
    expect(formatShortSpan(0, 'fa')).toBe('۰ میلی‌ثانیه');
    expect(formatShortSpan(1, 'en')).toBe('1 ms');
    expect(formatShortSpan(999, 'en')).toBe('999 ms');
    expect(formatShortSpan(999.7, 'en')).toBe('999 ms');
    expect(formatShortSpan(0, 'tr')).toBe('0 msn');
    expect(formatShortSpan(1_000, 'en')).toBe('1 sec');
    expect(formatShortSpan(1_000, 'fa')).toBe('۱ ثانیه');
  });

  it('say “under 1” for a round trip under a millisecond and a share under a percent, never a rounded 0 or 1', () => {
    expect(formatLatency(0, 'en', t('en'))).toBe('<1 ms');
    expect(formatLatency(0, 'fa', t('fa'))).toBe('کمتر از ۱ میلی‌ثانیه');
    expect(formatLatency(0, 'tr', t('tr'))).toBe('1 msn’den az');
    expect(formatLatency(1, 'en', t('en'))).toBe('1 ms');
    expect(formatLatency(4, 'fa', t('fa'))).toBe('۴ میلی‌ثانیه');
    expect(formatShare(0, 'en', t('en'))).toBe('<1%');
    expect(formatShare(0.004, 'en', t('en'))).toBe('<1%');
    expect(formatShare(0.0099, 'en', t('en'))).toBe('<1%');
    expect(formatShare(0.004, 'fa', t('fa'))).toBe('کمتر از ۱٪');
    expect(formatShare(0.004, 'tr', t('tr'))).toBe('%1’den az');
    expect(formatShare(0.01, 'en', t('en'))).toBe('1%');
    expect(formatShare(0.75, 'fa', t('fa'))).toBe('۷۵٪');
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

describe('audit rows of the jobs page', () => {
  const words = (name: string) => ({ name, mono: false });
  it('name the task started, the queue, job and count of a retry or remove, the stream and count of a delete', () => {
    expect(systemAuditSubject({ action: 'system.task_run', detail: { queue: 'stats', name: 'rollup', jobId: 'rollup.run.1' } }, t('en'))).toEqual({ kind: 'Task', parts: [words('Daily figures')] });
    expect(systemAuditSubject({ action: 'system.task_run', detail: { queue: 'maint', name: 'partitions' } }, t('fa'))).toEqual({ kind: 'کار', parts: [words('ساخت و حذف پارتیشن‌ها')] });
    expect(systemAuditSubject({ action: 'system.task_run', detail: { queue: 'growth', name: 'tick' } }, t('en'))).toEqual({ kind: 'Task', parts: [{ name: 'growth/tick', mono: true }] });
    expect(systemAuditSubject({ action: 'system.jobs_retry', detail: { queue: 'photo', name: 'process', count: 7, more: false } }, t('en'))).toEqual({
      kind: 'Queue',
      parts: [words('Photos'), words('Photo processing'), words('7\u00a0jobs')],
    });
    expect(systemAuditSubject({ action: 'system.jobs_remove', detail: { queue: 'push', name: 'other', count: 3, more: true } }, t('fa'))).toEqual({
      kind: 'صف',
      parts: [words('اعلان‌ها'), words('دیگر'), words('۳\u00a0کار')],
    });
    expect(systemAuditSubject({ action: 'system.dead_letters_delete', detail: { stream: 'like', ids: ['1-0', '2-0', '3-0'] } }, t('en'))).toEqual({ kind: 'Queue', parts: [words('Likes'), words('3\u00a0entries')] });
    expect(systemAuditSubject({ action: 'system.dead_letters_delete', detail: { stream: 'msg', upTo: '9-0', lengthBefore: 12, count: 4 } }, t('fa'))).toEqual({ kind: 'صف', parts: [words('پیام‌ها'), words('۴\u00a0ورودی')] });
    // An "up to" delete past the scan (null), or written before the count was recorded: the stream alone.
    expect(systemAuditSubject({ action: 'system.dead_letters_delete', detail: { stream: 'msg', upTo: '9-0', lengthBefore: 12, count: null } }, t('en'))).toEqual({ kind: 'Queue', parts: [words('Messages')] });
    expect(systemAuditSubject({ action: 'system.dead_letters_delete', detail: { stream: 'match', upTo: '9-0', lengthBefore: 3 } }, t('en'))).toEqual({ kind: 'Queue', parts: [words('Matches')] });
  });

  it('count one job or one entry in the singular, and never break a count from its noun', () => {
    const last = (subject: ReturnType<typeof systemAuditSubject>) => subject?.parts.at(-1)?.name;
    expect(last(systemAuditSubject({ action: 'system.dead_letters_delete', detail: { stream: 'like', ids: ['1-0'] } }, t('en')))).toBe('1\u00a0entry');
    expect(last(systemAuditSubject({ action: 'system.dead_letters_delete', detail: { stream: 'like', upTo: '9-0', lengthBefore: 1, count: 1 } }, t('en')))).toBe('1\u00a0entry');
    expect(last(systemAuditSubject({ action: 'system.jobs_retry', detail: { queue: 'photo', name: 'delete', count: 1, more: false } }, t('en')))).toBe('1\u00a0job');
    expect(last(systemAuditSubject({ action: 'system.jobs_retry', detail: { queue: 'photo', name: 'delete', count: 1, more: false } }, t('fa')))).toBe('۱\u00a0کار');
    expect(last(systemAuditSubject({ action: 'system.dead_letters_delete', detail: { stream: 'like', ids: ['1-0'] } }, t('tr')))).toBe('1\u00a0kayıt');
    expect(last(systemAuditSubject({ action: 'system.jobs_remove', detail: { queue: 'push', name: 'send', count: 2, more: false } }, t('en')))).toBe('2\u00a0jobs');
  });
});

describe('facts on a line', () => {
  it('are joined by Persian’s own comma in Persian (a "·" beside Persian digits reads as a zero), by a middle dot elsewhere', () => {
    expect(factSeparator('fa')).toBe('، ');
    expect(factSeparator('en')).toBe(' · ');
    expect(factSeparator('tr')).toBe(' · ');
    expect(joinFacts(['۷ آذر ۱۴۰۵، ۱۵:۴۴', 'در ۰ میلی‌ثانیه'], 'fa')).toBe('۷ آذر ۱۴۰۵، ۱۵:۴۴، در ۰ میلی‌ثانیه');
    expect(joinFacts(['Nov 28, 2026, 3:44 PM', 'took 0 ms'], 'en')).toBe('Nov 28, 2026, 3:44 PM · took 0 ms');
  });

  it('keep a short value on one line', () => {
    expect(unbreakable('4:41 AM')).toBe('4:41\u00a0AM');
    expect(unbreakable('0 ms')).toBe('0\u00a0ms');
    expect(unbreakable('۶:۴۷')).toBe('۶:۴۷');
  });

  it('leave any other row, or a detail this build cannot read, to the target column', () => {
    expect(systemAuditSubject({ action: 'role.update', detail: { role: 'support' } }, t('en'))).toBeNull();
    expect(systemAuditSubject({ action: 'user.ban', detail: { reason: 'scam' } }, t('en'))).toBeNull();
    expect(systemAuditSubject({ action: 'system.task_run', detail: null }, t('en'))).toBeNull();
    expect(systemAuditSubject({ action: 'system.jobs_retry', detail: { queue: 3, name: 'process' } }, t('en'))).toBeNull();
    expect(systemAuditSubject({ action: 'system.dead_letters_delete', detail: { ids: [] } }, t('en'))).toBeNull();
  });
});
