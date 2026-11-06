import { interpolate, type Locale } from '@app/shared';
import { messages, type MessageKey } from './messages';

export type TranslateValues = Readonly<Record<string, string | number>>;

/** The string for `key` in `locale`, placeholders filled; English when a locale lacks it. */
export function translate(locale: Locale, key: MessageKey, values: TranslateValues = {}, appName = ''): string {
  const template = messages[locale][key] || messages.en[key];
  const strings: Record<string, string> = { appName };
  for (const [name, value] of Object.entries(values)) strings[name] = String(value);
  return interpolate(template, strings);
}
