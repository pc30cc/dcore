import type { Locale } from '@app/shared';

/** ASCII digits for Persian and Arabic-Indic ones, so a number or an id typed on a Persian keyboard counts. */
export function asciiDigits(value: string): string {
  return value.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/** A decimal number in the panel's digits ("4.99" as «۴٫۹۹»): an example in a field. */
export function formatDecimal(value: number, locale: Locale, fractionDigits = 2): string {
  return new Intl.NumberFormat(locale, { useGrouping: false, minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(value);
}

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

/** Facts as one phrase in the panel's language ("A, B and C"; «A، B و C»): an accessible name, a short list. */
export function listOf(items: readonly string[], locale: Locale): string {
  return new Intl.ListFormat(locale, { type: 'conjunction' }).format(items);
}

/** Facts read one after another in an accessible name ("A, B, C"; «A، B، C»), where a "·" would be read as nothing or as a dot. */
export function factsOf(items: readonly string[], locale: Locale, isolate = false): string {
  // Isolated, a fact that starts in another script (a Latin code before Persian digits) keeps its own order.
  return (isolate ? items.map((item) => `\u2068${item}\u2069`) : items).join(locale === 'fa' ? '، ' : ', ');
}

/** Between facts read one after another on a line: Persian's own comma (a "·" beside Persian digits reads as a zero), else a middle dot. */
export function factSeparator(locale: Locale): string {
  return locale === 'fa' ? '، ' : ' · ';
}

/** Facts shown one after another on a line ("A · B"; «A، B»), with `factSeparator`. */
export function joinFacts(items: readonly string[], locale: Locale): string {
  return items.join(factSeparator(locale));
}

/** A short value kept on one line ("4:41 AM", "0 ms", "7 jobs"): its spaces made non-breaking, so a line never ends inside it. */
export function unbreakable(text: string): string {
  return text.replace(/ /g, '\u00a0');
}

/** Today as `YYYY-MM-DD` in the browser's time zone (the earliest end a date field offers). */
export function todayDay(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Whether the panel's calendar in `locale` is the Gregorian one (the browser's picker then fits). */
export function gregorianPanel(locale: Locale): boolean {
  return new Intl.DateTimeFormat(locale).resolvedOptions().calendar === 'gregory';
}

/** A day in full in the panel's language and calendar («جمعه، ۶ آذر ۱۴۰۵»). */
export function fullDay(iso: string, locale: Locale): string {
  // Noon, so no time zone moves it to another day.
  const day = new Date(`${iso}T12:00:00`);
  // ICU's full Persian pattern is «y MMMM d, EEEE» (year first, a Latin comma): the weekday leads here, as Persian writes it.
  if (locale === 'fa') return `${new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(day)}، ${new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(day)}`;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'full' }).format(day);
}
