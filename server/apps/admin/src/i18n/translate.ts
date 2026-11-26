import { interpolate, type Locale } from '@app/shared';
import { messages, type MessageKey } from './messages';

export type TranslateValues = Readonly<Record<string, string | number>>;

/**
 * The string for `key` in `locale`, placeholders filled; English when a
 * locale lacks it. A number placeholder is written in the locale's digits,
 * without grouping (a counter, a version, a count).
 */
export function translate(locale: Locale, key: MessageKey, values: TranslateValues = {}, appName = ''): string {
  const template = messages[locale][key] || messages.en[key];
  const strings: Record<string, string> = { appName };
  let digits: Intl.NumberFormat | undefined;
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === 'number') {
      digits ??= new Intl.NumberFormat(locale, {
        useGrouping: false,
        maximumFractionDigits: 3,
      });
      strings[name] = digits.format(value);
    } else strings[name] = value;
  }
  return interpolate(template, strings);
}
