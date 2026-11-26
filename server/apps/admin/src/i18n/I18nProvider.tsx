import { isLocale, textDirection, type Locale } from '@app/shared';
import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { brand } from '@/lib/brand';
import { readPreference, writePreference } from '@/lib/storage';
import type { MessageKey } from './messages';
import { translate, type TranslateValues } from './translate';

const STORAGE_KEY = 'admin.locale';

export interface I18nValue {
  locale: Locale;
  locales: readonly Locale[];
  dir: 'rtl' | 'ltr';
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, values?: TranslateValues) => string;
}

// eslint-disable-next-line react-refresh/only-export-components
export const I18nContext = createContext<I18nValue | null>(null);

function initialLocale(): Locale {
  const saved = readPreference(STORAGE_KEY);
  if (saved && isLocale(saved) && brand.locales.includes(saved)) return saved;
  return brand.defaultLocale;
}

/**
 * `lang` (which picks the font stack in index.css) and `dir` on <html>.
 * Written before the render that shows a language, never only in an effect:
 * layout effects (a tab strip measuring its tabs) run before passive ones
 * and would measure the old language's fonts and direction.
 */
function applyDocumentLocale(locale: Locale): void {
  const root = document.documentElement;
  if (root.lang !== locale) root.lang = locale;
  const dir = textDirection(locale);
  if (root.dir !== dir) root.dir = dir;
}

/** Holds the panel's language; sets `lang` and `dir` on <html>, so the whole layout mirrors for Persian. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const first = initialLocale();
    applyDocumentLocale(first);
    return first;
  });
  const dir = textDirection(locale);

  useEffect(() => {
    applyDocumentLocale(locale);
    document.title = translate(locale, 'app.title', {}, brand.appName);
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    applyDocumentLocale(next);
    setLocaleState(next);
    writePreference(STORAGE_KEY, next);
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      locales: brand.locales,
      dir,
      setLocale,
      t: (key, values) => translate(locale, key, values, brand.appName),
    }),
    [locale, dir, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
