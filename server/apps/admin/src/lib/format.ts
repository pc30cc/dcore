import type { Locale } from '@app/shared';

/** A date and time in the panel's language ("9 Nov 2026, 19:40"). */
export function formatDateTime(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function formatDate(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}

/** A whole number in the panel's language (Persian digits in Persian). */
export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

/** A per-locale text in `locale`, else Persian, else English, else the fallback. */
export function localized(texts: Partial<Record<string, string>> | undefined, locale: Locale, fallback: string): string {
  for (const key of [locale, 'fa', 'en', 'tr']) {
    const value = texts?.[key];
    if (value) return value;
  }
  return fallback;
}
