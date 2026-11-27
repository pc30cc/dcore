import type { Locale } from '@app/shared';
import { brand } from '@/lib/brand';
import { localeOf, runtimeConfig } from '@/lib/runtimeConfig';
import { readPreference } from '@/lib/storage';

/** Where the language picked in the panel's menu is kept (only the menu writes it). */
export const LOCALE_STORAGE_KEY = 'admin.locale';

/** The build's default (vite.config.ts: ADMIN_DEFAULT_LOCALE, else Persian), for a page without /config.js. */
export const BUILD_DEFAULT_LOCALE: Locale = localeOf(__ADMIN_DEFAULT_LOCALE__) ?? brand.defaultLocale;

/** The language picked in the panel's menu on this browser; null when none (or one this build lacks). */
export function savedLocale(): Locale | null {
  return localeOf(readPreference(LOCALE_STORAGE_KEY));
}

/** The deployment's default: ADMIN_DEFAULT_LOCALE as /config.js names it, else the build's. */
export function panelDefaultLocale(): Locale {
  const config = runtimeConfig();
  return (config.ok ? config.config.defaultLocale : null) ?? BUILD_DEFAULT_LOCALE;
}

/** The language a page opens in: the one picked in the menu, else the deployment's default. */
export function initialLocale(): Locale {
  return savedLocale() ?? panelDefaultLocale();
}
