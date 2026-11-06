import type { Locale } from '@app/shared';
import { Monitor, Moon, Sun } from 'lucide-react';
import { localeNames } from '@/i18n/messages';
import { useI18n } from '@/i18n/useI18n';
import { useTheme, type ThemeChoice } from '@/lib/theme';
import { cn } from '@/lib/utils';

const themeIcons = { light: Sun, dark: Moon, system: Monitor } as const;

/** Language and theme pickers, used in the header and on the sign-in page. */
export function Preferences({ className }: { className?: string }) {
  const { t, locale, locales, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <label className="sr-only" htmlFor="locale">
        {t('language.label')}
      </label>
      <select
        id="locale"
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {locales.map((code) => (
          <option key={code} value={code} lang={code}>
            {localeNames[code]}
          </option>
        ))}
      </select>
      <div role="radiogroup" aria-label={t('theme.label')} className="inline-flex rounded-md border border-input p-0.5 shadow-xs">
        {(['light', 'dark', 'system'] as const satisfies readonly ThemeChoice[]).map((choice) => {
          const Icon = themeIcons[choice];
          return (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={theme === choice}
              title={t(`theme.${choice}`)}
              onClick={() => setTheme(choice)}
              className={cn(
                'inline-flex size-8 items-center justify-center rounded-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                theme === choice && 'bg-accent text-accent-foreground',
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
              <span className="sr-only">{t(`theme.${choice}`)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
