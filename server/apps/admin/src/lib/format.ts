import type { Locale } from '@app/shared';

/** A date and time in the panel's language ("9 Nov 2026, 19:40"). */
export function formatDateTime(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function formatDate(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}

/** The time of day alone ("19:40"), where the day is shown elsewhere. */
export function formatTime(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(date);
}

/** A length of time as a clock in the panel's digits: `m:ss`, or `h:mm:ss` from an hour. */
export function formatDuration(seconds: number, locale: Locale): string {
  const total = Math.max(0, Math.round(seconds));
  const two = new Intl.NumberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false, maximumFractionDigits: 0 });
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const rest = total % 60;
  return hours > 0 ? `${formatPlain(hours, locale)}:${two.format(minutes)}:${two.format(rest)}` : `${formatPlain(minutes, locale)}:${two.format(rest)}`;
}

/**
 * A day typed in a date field (`YYYY-MM-DD`, the browser's Gregorian
 * picker) in the panel's calendar, when that calendar is another one
 * (Solar Hijri in Persian); undefined when the picker already shows it.
 */
export function dayInPanelCalendar(day: string, locale: Locale): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  if (new Intl.DateTimeFormat(locale).resolvedOptions().calendar === 'gregory') return undefined;
  // Noon, so no time zone moves it to the day before.
  return formatDate(`${day}T12:00:00`, locale);
}

/** A whole number in the panel's language (Persian digits in Persian). */
export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

/** A number without grouping in the panel's digits: a version code, a counter. */
export function formatPlain(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, {
    useGrouping: false,
    maximumFractionDigits: 0,
  }).format(value);
}

function displayName(type: 'region' | 'language', code: string, locale: Locale): string {
  try {
    return new Intl.DisplayNames(locale, { type, fallback: 'code' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** A country's name in the panel's language (`DE` → "Germany"); the code when the runtime does not know it. */
export function regionName(code: string, locale: Locale): string {
  return displayName('region', code.toUpperCase(), locale);
}

/** A language tag's name in the panel's language (`tr-DE` → "Turkish (Germany)"); the tag when it is not one. */
export function languageName(tag: string, locale: Locale): string {
  return displayName('language', tag, locale);
}

/** A per-locale text in `locale`, else Persian, else English, else the fallback. */
export function localized(texts: Partial<Record<string, string>> | undefined, locale: Locale, fallback: string): string {
  for (const key of [locale, 'fa', 'en', 'tr']) {
    const value = texts?.[key];
    if (value) return value;
  }
  return fallback;
}
