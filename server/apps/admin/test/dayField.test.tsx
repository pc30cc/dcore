import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { DayField } from '../src/components/form/DayField';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { messages } from '../src/i18n/messages';
import { translate } from '../src/i18n/translate';
import { fullDay } from '../src/lib/format';
import { formatJalaliDay, isJalaliLeapYear, isoDayToJalali, jalaliMonthLength, jalaliToIsoDay, parseJalaliDay } from '../src/lib/jalali';
import { resetPanel } from './panel';

/**
 * Days in the panel's calendar: the Persian panel reads and writes the Solar
 * Hijri day (the browser's picker is Gregorian only); what reaches the
 * panel's filters and the API is the Gregorian ISO day.
 */

describe('the Solar Hijri calendar', () => {
  it('converts known days both ways', () => {
    const pairs: [string, { y: number; m: number; d: number }][] = [
      ['2026-03-21', { y: 1405, m: 1, d: 1 }],
      ['2025-03-21', { y: 1404, m: 1, d: 1 }],
      ['2024-03-20', { y: 1403, m: 1, d: 1 }],
      ['2025-03-20', { y: 1403, m: 12, d: 30 }],
      ['2026-11-27', { y: 1405, m: 9, d: 6 }],
      ['2000-01-01', { y: 1378, m: 10, d: 11 }],
      ['1979-02-11', { y: 1357, m: 11, d: 22 }],
    ];
    for (const [iso, day] of pairs) {
      expect(isoDayToJalali(iso), iso).toEqual(day);
      expect(jalaliToIsoDay(day), iso).toBe(iso);
    }
  });

  it('knows the leap years and the months’ lengths', () => {
    expect(isJalaliLeapYear(1403)).toBe(true);
    expect(isJalaliLeapYear(1404)).toBe(false);
    expect(isJalaliLeapYear(1408)).toBe(true);
    expect([1, 6, 7, 11].map((m) => jalaliMonthLength(1404, m))).toEqual([31, 31, 30, 30]);
    expect(jalaliMonthLength(1403, 12)).toBe(30);
    expect(jalaliMonthLength(1404, 12)).toBe(29);
    expect(jalaliToIsoDay({ y: 1404, m: 12, d: 30 })).toBeNull();
    expect(jalaliToIsoDay({ y: 1404, m: 7, d: 31 })).toBeNull();
    expect(jalaliToIsoDay({ y: 1404, m: 13, d: 1 })).toBeNull();
  });

  it('agrees with the browser’s Persian calendar on every day from 1300 to 1500', () => {
    const persian = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
    const wrong: string[] = [];
    for (let at = Date.UTC(1921, 2, 21); at < Date.UTC(2121, 2, 21); at += 86_400_000) {
      const iso = new Date(at).toISOString().slice(0, 10);
      const parts = Object.fromEntries(persian.formatToParts(new Date(at)).map((part) => [part.type, part.value]));
      const day = isoDayToJalali(iso);
      if (day?.y !== Number(parts['year']) || day.m !== Number(parts['month']) || day.d !== Number(parts['day']) || jalaliToIsoDay(day) !== iso) wrong.push(iso);
    }
    expect(wrong).toEqual([]);
  });

  it('reads a typed day in Persian, Arabic-Indic or Latin digits, with / - or . between, and nothing else', () => {
    for (const text of ['۱۴۰۵/۰۹/۰۶', '1405/9/6', ' 1405-09-06 ', '١٤٠٥.٠٩.٠٦', '۱۴۰۵ / ۹ / ۶']) expect(parseJalaliDay(text), text).toBe('2026-11-27');
    for (const text of ['', '2026/11/27', '1299/12/29', '05/09/06', '1405/09', '1405/09/06/1', '1404/12/30', '1405/00/10', 'abcd/ef/gh', '2026-11-27x']) expect(parseJalaliDay(text), text).toBeNull();
    expect(formatJalaliDay('2026-11-27')).toBe('۱۴۰۵/۰۹/۰۶');
    expect(formatJalaliDay('nope')).toBe('');
  });
});

function Harness({ initial = '', min, max }: { initial?: string; min?: string; max?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="day">Day</label>
      <DayField id="day" value={value} onChange={setValue} min={min} max={max} />
      <output data-testid="value">{value}</output>
      <button type="button" onClick={() => setValue('2026-03-21')}>
        preset
      </button>
      <button type="button" onClick={() => setValue('')}>
        clear
      </button>
    </>
  );
}

const value = () => screen.getByTestId('value').textContent;

describe('a date field', () => {
  beforeEach(() => {
    resetPanel();
  });

  it('is the browser’s picker in a Gregorian language', () => {
    render(
      <I18nProvider>
        <Harness initial="2026-11-27" />
      </I18nProvider>,
    );
    const input = screen.getByLabelText<HTMLInputElement>('Day');
    expect(input.type).toBe('date');
    expect(input.value).toBe('2026-11-27');
  });

  it('in Persian takes the Solar Hijri day and keeps the Gregorian one, with the day in full below', () => {
    window.localStorage.setItem('admin.locale', 'fa');
    render(
      <I18nProvider>
        <Harness min="2026-01-01" max="2026-12-31" />
      </I18nProvider>,
    );
    const input = screen.getByLabelText<HTMLInputElement>('Day');
    expect(input.type).toBe('text');
    expect(input.getAttribute('dir')).toBe('ltr');
    // An example in Persian digits: today's day.
    expect(input.placeholder).toMatch(/^[۰-۹]{4}\/[۰-۹]{2}\/[۰-۹]{2}$/);

    fireEvent.change(input, { target: { value: '۱۴۰۵/۰۹/۰۶' } });
    expect(value()).toBe('2026-11-27');
    expect(screen.getByText(fullDay('2026-11-27', 'fa'))).toBeTruthy();
    // The weekday first, a Persian comma, then day, month and year (ICU's own pattern puts the year first with a Latin comma).
    expect(fullDay('2026-11-27', 'fa')).toBe('جمعه، ۶ آذر ۱۴۰۵');
    expect(fullDay('2026-11-27', 'fa')).not.toContain(',');
    expect(fullDay('2026-11-27', 'en')).toBe('Friday, November 27, 2026');

    // Half typed: no day, and once the field is left, how to write one.
    fireEvent.change(input, { target: { value: '1405/9' } });
    expect(value()).toBe('');
    fireEvent.blur(input);
    expect(screen.getByText(translate('fa', 'form.day.invalid', { example: input.placeholder }))).toBeTruthy();

    // Outside the bounds: said in Solar Hijri days.
    fireEvent.change(input, { target: { value: '1404/01/01' } });
    expect(screen.getByText(translate('fa', 'form.day.beforeMin', { day: '۱۴۰۴/۱۰/۱۱' }))).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('follows a value set from outside (a preset, a clear)', () => {
    window.localStorage.setItem('admin.locale', 'fa');
    render(
      <I18nProvider>
        <Harness />
      </I18nProvider>,
    );
    const input = screen.getByLabelText<HTMLInputElement>('Day');
    fireEvent.click(screen.getByRole('button', { name: 'preset' }));
    expect(input.value).toBe('۱۴۰۵/۰۱/۰۱');
    fireEvent.click(screen.getByRole('button', { name: 'clear' }));
    expect(input.value).toBe('');
    expect(messages.fa['form.day.invalid']).toContain('{example}');
  });
});
