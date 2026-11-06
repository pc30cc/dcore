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

/** Holds the panel's language; sets `lang` and `dir` on <html>, so the whole layout mirrors for Persian. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const dir = textDirection(locale);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
    document.title = translate(locale, 'app.title', {}, brand.appName);
  }, [locale, dir]);

  const setLocale = useCallback((next: Locale) => {
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
