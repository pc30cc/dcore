import { z } from 'zod';

/** Every locale the product ships. A brand may enable a subset (`brand.locales`). */
export const locales = ['en', 'fa', 'tr'] as const;
export type Locale = (typeof locales)[number];
export const localeSchema = z.enum(locales);

const rtlLocales: ReadonlySet<string> = new Set<Locale>(['fa']);

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

export function isRtl(locale: string): boolean {
  return rtlLocales.has(locale);
}

export function textDirection(locale: string): 'rtl' | 'ltr' {
  return isRtl(locale) ? 'rtl' : 'ltr';
}

/**
 * Replaces `{name}` placeholders, e.g. `{appName}`. A placeholder without a
 * value is left as it is, so a missing value shows up instead of vanishing.
 */
export function interpolate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? (values[name] ?? match) : match,
  );
}

/** Lists the `{name}` placeholders a template uses. */
export function placeholders(template: string): string[] {
  return [...template.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((m) => m[1] ?? '');
}
