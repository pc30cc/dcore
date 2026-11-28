import { describe, expect, it } from 'vitest';
import { csvText } from '../src/lib/csv';
import { factsOf } from '../src/lib/format';
import {
  addMicros,
  axisTicks,
  bucketDays,
  cohortLines,
  cohortTable,
  csvName,
  formatCount,
  formatDayCount,
  formatMoney,
  formatPercent,
  formatRatio,
  formatSpan,
  formatStatsDay,
  formatStatsSpan,
  formatShareTick,
  formatUnitsShort,
  formatUnitsTick,
  mergeLines,
  microsToUnits,
  monthlyChurn,
  niceTicks,
  rangeDaysOf,
  statsCellText,
  statsCsvRows,
  statsRange,
  subMicros,
} from '../src/lib/stats';

/** The statistics pages' helpers: ranges, money, cohorts, weeks, words and CSV. */

describe('ranges', () => {
  it('end yesterday (UTC) and span the asked days', () => {
    expect(statsRange(30, Date.parse('2026-11-27T00:30:00Z'))).toEqual({ from: '2026-10-28', to: '2026-11-26' });
    expect(statsRange(7, Date.parse('2026-01-01T23:59:00Z'))).toEqual({ from: '2025-12-25', to: '2025-12-31' });
  });

  it('come from the address only when offered', () => {
    expect(rangeDaysOf('90')).toBe(90);
    expect(rangeDaysOf('365')).toBe(365);
    for (const value of [null, '', '12', '30abc', '-7']) expect(rangeDaysOf(value)).toBe(30);
  });
});

describe('money', () => {
  it('turns decimal micros into exact units', () => {
    expect(microsToUnits('12345670')).toBe('12.34567');
    expect(microsToUnits('0')).toBe('0');
    expect(microsToUnits('990000')).toBe('0.99');
    expect(microsToUnits('-1500000')).toBe('-1.5');
    expect(microsToUnits('9223372036854775807')).toBe('9223372036854.775807');
  });

  it('adds and subtracts without float rounding', () => {
    expect(addMicros('9007199254740993', '1')).toBe('9007199254740994');
    expect(subMicros('100', '250')).toBe('-150');
  });

  it('writes an amount in its own currency, never converted, in the panel’s digits', () => {
    expect(formatMoney('312470000', 'USD', 'en')).toBe('$312.47');
    expect(formatMoney('41720000000000', 'IRR', 'en')).toContain('41,720,000');
    expect(formatMoney('312470000', 'USD', 'fa')).toContain('۳۱۲٫۴۷');
    // An amount past 2^53 micros keeps every unit digit.
    expect(formatMoney('123456789012345678', 'IRR', 'en')).toContain('123,456,789,012');
  });
});

describe('churn', () => {
  const day = (i: number) => `2026-11-${String(i + 1).padStart(2, '0')}`;

  it('is per 30 days: the ended ones over the snapshot days ÷ the average active, scaled', () => {
    const subscriptions = Array.from({ length: 10 }, (_, i) => ({ day: day(i), active: 500 + i * 10, renewing: 400 }));
    const churn = Array.from({ length: 12 }, (_, i) => ({ day: day(i), ended: 2, cancelled: 1 }));
    // 10 snapshot days, 20 ended, average 545: 20 / 545 × 3.
    const { ended, rate } = monthlyChurn({ subscriptions, churn });
    expect(ended).toBe(20);
    expect(rate).toBeCloseTo((20 / 545) * 3, 10);
  });

  it('is not given with less than a week of snapshots', () => {
    const subscriptions = Array.from({ length: 6 }, (_, i) => ({ day: day(i), active: 500, renewing: 400 }));
    expect(monthlyChurn({ subscriptions, churn: [{ day: day(0), ended: 3, cancelled: 0 }] })).toEqual({ ended: 3, rate: null });
    expect(monthlyChurn({ subscriptions: [], churn: [] })).toEqual({ ended: 0, rate: null });
  });
});

describe('cohorts', () => {
  const lines = cohortLines(
    [
      { day: '2026-11-01', signups: 100, d1: 40, d7: 20 },
      { day: '2026-11-02', signups: 300, d1: 90, d7: null },
    ],
    (c) => [c.d1, c.d7],
  );

  it('average each measure over the cohorts it reached, weighted by sign-ups', () => {
    const average = mergeLines('', lines);
    expect(average.signups).toBe(400);
    expect(average.cells[0]).toEqual({ reached: 130, base: 400 });
    // Day 7 measured for the first cohort only.
    expect(average.cells[1]).toEqual({ reached: 20, base: 100 });
    expect(mergeLines('', cohortLines([{ day: 'x', signups: 5, d: null }], (c) => [c.d])).cells).toEqual([null]);
  });

  it('list days newest first, and past a month weeks counted back from the newest day (only the oldest short)', () => {
    expect(cohortTable(lines).map((line) => line.day)).toEqual(['2026-11-02', '2026-11-01']);
    const many = cohortLines(
      Array.from({ length: 40 }, (_, i) => ({ day: `d${String(i).padStart(2, '0')}`, signups: 10, d1: 1 })),
      (c) => [c.d1],
    );
    const weeks = cohortTable(many);
    expect(weeks).toHaveLength(6);
    // The newest week is whole (d33-d39); the 5 days left over are the oldest line.
    expect(weeks[0]).toEqual({ day: 'd33', signups: 70, cells: [{ reached: 7, base: 70 }] });
    expect(weeks.slice(0, -1).every((week) => week.signups === 70)).toBe(true);
    expect(weeks.at(-1)).toEqual({ day: 'd00', signups: 50, cells: [{ reached: 5, base: 50 }] });
  });
});

describe('weeks of a long chart', () => {
  it('sum each week’s known values, counted back from the last day', () => {
    const days = Array.from({ length: 10 }, (_, i) => `d${i}`);
    expect(bucketDays(days, [[1, 2, 3, null, 5, 6, 7, 8, null, 10]], 7)).toEqual({
      days: ['d0', 'd3'],
      spans: [
        { from: 'd0', to: 'd2', days: 3 },
        { from: 'd3', to: 'd9', days: 7 },
      ],
      series: [[6, 36]],
    });
    expect(bucketDays(['a'], [[null]], 7)).toEqual({ days: ['a'], spans: [{ from: 'a', to: 'a', days: 1 }], series: [[null]] });
    expect(bucketDays(['a', 'b'], [[1, 2]], 1)).toEqual({
      days: ['a', 'b'],
      spans: [
        { from: 'a', to: 'a', days: 1 },
        { from: 'b', to: 'b', days: 1 },
      ],
      series: [[1, 2]],
    });
  });

  it('never end on a short week: 30 days are 2 + 4 × 7, the 2 days oldest', () => {
    const days = Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2026, 9, 28 + i)).toISOString().slice(0, 10));
    const { spans, series } = bucketDays(days, [days.map(() => 10)], 7);
    expect(spans.map((span) => span.days)).toEqual([2, 7, 7, 7, 7]);
    expect(spans.at(-1)).toEqual({ from: '2026-11-20', to: '2026-11-26', days: 7 });
    expect(spans[0]).toEqual({ from: '2026-10-28', to: '2026-10-29', days: 2 });
    expect(series[0]).toEqual([20, 70, 70, 70, 70]);
    // 90 and 365 days: only the oldest group is short, and the groups cover every day once.
    for (const [count, size] of [
      [90, 7],
      [365, 7],
      [365, 21],
    ] as const) {
      const long = Array.from({ length: count }, (_, i) => `d${i}`);
      const grouped = bucketDays(long, [long.map(() => 1)], size).spans;
      expect(grouped.slice(1).every((span) => span.days === size), `${count}/${size}`).toBe(true);
      expect(grouped.reduce((sum, span) => sum + span.days, 0)).toBe(count);
      expect(grouped.at(-1)!.to).toBe(`d${count - 1}`);
    }
  });

  it('name a group by its span, in the panel’s calendar', () => {
    // Intl spaces the dash with thin spaces: compared as plain spaces.
    const plain = (text: string) => text.replace(/\s/g, ' ');
    expect(plain(formatStatsSpan('2026-11-20', '2026-11-26', 'en'))).toBe('Nov 20 – 26, 2026');
    expect(plain(formatStatsSpan('2026-11-20', '2026-11-26', 'fa'))).toBe('۲۹ آبان تا ۵ آذر ۱۴۰۵');
    expect(plain(formatStatsSpan('2026-10-28', '2026-10-28', 'en'))).toBe('Oct 28, 2026');
    expect(formatDayCount(2, 'en')).toBe('2 days');
    expect(formatDayCount(1, 'en')).toBe('1 day');
    expect(formatDayCount(2, 'fa')).toBe('۲ روز');
    expect(formatDayCount(2, 'tr')).toBe('2 gün');
  });
});

describe('words', () => {
  it('write a UTC day in the panel’s calendar, whatever the browser’s zone', () => {
    expect(formatStatsDay('2026-11-26', 'en')).toBe('Nov 26, 2026');
    expect(formatStatsDay('2026-11-26', 'fa', 'short')).toBe('۵ آذر');
    expect(formatStatsDay('2026-11-26', 'en', 'month')).toBe('Nov 2026');
  });

  it('write shares and lengths of time in the largest unit that fits', () => {
    expect(formatPercent(0.4125, 'en')).toBe('41.3%');
    expect(formatSpan(45, 'en')).toBe('45 sec');
    expect(formatSpan(2100, 'en')).toBe('35 min');
    expect(formatSpan(5400, 'en')).toBe('1.5 hr');
    expect(formatSpan(259_200, 'en')).toBe('3 days');
  });

  it('give an axis clean ticks from 0', () => {
    expect(niceTicks(9)).toEqual([0, 2.5, 5, 7.5, 10]);
    expect(niceTicks(1873)).toEqual([0, 500, 1000, 1500, 2000]);
    expect(niceTicks(0)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('give a count axis whole steps only, each label once', () => {
    const count = (value: number) => formatCount(value, 'en');
    // The fractional steps a top of 1 had: their labels read 0, 0, 1, 1, 1.
    expect(niceTicks(1).map(count)).toEqual(['0', '0', '1', '1', '1']);
    expect(niceTicks(1, true)).toEqual([0, 1]);
    expect(niceTicks(0, true)).toEqual([0, 1]);
    expect(niceTicks(0.4, true)).toEqual([0, 1]);
    expect(niceTicks(2, true)).toEqual([0, 1, 2]);
    expect(niceTicks(3, true)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(4, true)).toEqual([0, 1, 2, 3, 4]);
    expect(niceTicks(7, true)).toEqual([0, 2, 4, 6, 8]);
    // No step of 2.5: 9 reads 0, 5, 10 (not 0, 2.5, 5, 7.5, 10).
    expect(niceTicks(9, true)).toEqual([0, 5, 10]);
    expect(niceTicks(100, true)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(1873, true)).toEqual([0, 500, 1000, 1500, 2000]);
    expect(niceTicks(48_000, true)).toEqual([0, 20_000, 40_000, 60_000]);
    for (let max = 0; max <= 5000; max += 1) {
      const ticks = niceTicks(max, true);
      expect(ticks.every((tick) => Number.isInteger(tick)), `${max}`).toBe(true);
      expect(ticks.length, `${max}`).toBeGreaterThanOrEqual(2);
      expect(ticks.length, `${max}`).toBeLessThanOrEqual(5);
      expect(ticks.at(-1)!, `${max}`).toBeGreaterThanOrEqual(max);
      for (const locale of ['en', 'fa', 'tr'] as const) {
        const texts = ticks.map((tick) => formatCount(tick, locale));
        expect(new Set(texts).size, `${locale} ${max}: ${texts.join(' ')}`).toBe(texts.length);
      }
    }
    expect(axisTicks(1, count, true)).toEqual({ ticks: [0, 1], texts: ['0', '1'] });
    expect(axisTicks(3, (value) => formatCount(value, 'fa'), true).texts).toEqual(['۰', '۱', '۲', '۳']);
  });

  it('keep fractional steps for money and shares, each label as exact as its tick', () => {
    const usd = (value: number) => formatUnitsTick(value, 'USD', 'en');
    expect(axisTicks(9, usd)).toEqual({ ticks: [0, 2.5, 5, 7.5, 10], texts: ['$0', '$2.5', '$5', '$7.5', '$10'] });
    expect(axisTicks(1.75, usd)).toEqual({ ticks: [0, 0.5, 1, 1.5, 2], texts: ['$0', '$0.5', '$1', '$1.5', '$2'] });
    // The readout's short amount rounds 0.25 to "$0.3"; the axis keeps the tick's digits.
    expect(formatUnitsShort(0.25, 'USD', 'en')).toBe('$0.3');
    expect(axisTicks(1, usd).texts).toEqual(['$0', '$0.25', '$0.5', '$0.75', '$1']);
    expect(axisTicks(41_000, usd).texts).toEqual(['$0', '$20K', '$40K', '$60K', '$80K']);
    expect(axisTicks(0.0004, (value) => formatShareTick(value, 'en')).texts).toEqual(['0%', '0.01%', '0.02%', '0.03%', '0.04%']);
    expect(axisTicks(0.009, (value) => formatShareTick(value, 'fa')).texts).toEqual(['۰٪', '۰٫۲۵٪', '۰٫۵٪', '۰٫۷۵٪', '۱٪']);
  });

  it('thin an axis whose formatter would show a label twice: every other tick, then the ends', () => {
    // A failure rate of 0.2 % at one place: steps of 0.05 % read 0.1 % and 0.2 % twice.
    const share = (value: number) => formatPercent(value, 'en');
    expect(niceTicks(0.002).map(share)).toEqual(['0%', '0.1%', '0.1%', '0.2%', '0.2%']);
    expect(axisTicks(0.002, share).texts).toEqual(['0%', '0.1%', '0.2%']);
    expect(axisTicks(0.002, share).ticks.at(-1)).toBeCloseTo(0.002, 12);
    const tenths = (value: number) => new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value);
    // 0, 0.0025, 0.005, 0.0075, 0.01 at one place: 0, 0, 0, 0, 0 → the ends 0 and 0 (the top kept for the scale).
    expect(axisTicks(0.01, tenths).ticks).toEqual([0, 0.01]);
  });
});

describe('a card’s table and CSV', () => {
  const table = {
    columns: [
      { label: 'Day', kind: 'day' as const },
      { label: 'Place', kind: 'text' as const },
      { label: 'Women', kind: 'count' as const },
      { label: 'Share', kind: 'percent' as const },
      { label: 'Gross', kind: 'money' as const, currency: 'USD' },
    ],
    rows: [['2026-11-26', '=HYPERLINK("x")', '<5', 0.123456, '7990000']],
  };

  it('shows each cell as the page writes it', () => {
    expect(table.rows[0]!.map((value, i) => statsCellText(value, table.columns[i]!, 'en'))).toEqual(['Nov 26, 2026', '=HYPERLINK("x")', '<5', '12.3%', '$7.99']);
    expect(statsCellText(null, table.columns[2]!, 'en')).toBe('—');
  });

  it('writes plain values: ISO days, ratios to 4 places, amounts in units, text a spreadsheet cannot run', () => {
    expect(csvText(table.columns.map((c) => c.label), statsCsvRows(table))).toBe(`Day,Place,Women,Share,Gross\r\n2026-11-26,"'=HYPERLINK(""x"")",<5,0.1235,7.99\r\n`);
    expect(csvText(['a'], [['+1'], ['-x'], ['@y'], ['\tz'], ['ok, fine'], [null], [3]])).toBe(`a\r\n'+1\r\n'-x\r\n'@y\r\n'\tz\r\n"ok, fine"\r\n\r\n3\r\n`);
    expect(csvName('revenue', { from: '2026-11-01', to: '2026-11-26' }, 'USD')).toBe('stats-revenue-USD-2026-11-01-2026-11-26.csv');
  });
});

describe('mixed-direction facts and ratios', () => {
  it('isolates each fact when asked, so a Latin key keeps its place before Persian digits; the CSV drops the isolates', () => {
    expect(factsOf(['premium', '۳ ماه'], 'fa', true)).toBe('⁨premium⁩، ⁨۳ ماه⁩');
    expect(factsOf(['premium', '3 months'], 'en')).toBe('premium, 3 months');
    const table = { columns: [{ label: 'Plan', kind: 'text' as const }, { label: 'Women to men', kind: 'ratio' as const }], rows: [[factsOf(['plus', '۱ ماه'], 'fa', true), 0.781234]] };
    expect(statsCsvRows(table)).toEqual([['plus، ۱ ماه', 0.7812]]);
    expect(statsCellText(0.781234, table.columns[1]!, 'fa')).toBe('۰٫۷۸');
    expect(formatRatio(1.5, 'en')).toBe('1.50');
  });
});
