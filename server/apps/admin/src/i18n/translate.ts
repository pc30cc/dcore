import { interpolate, type Locale } from '@app/shared';
import { messages, type MessageKey } from './messages';

export type TranslateValues = Readonly<Record<string, string | number>>;

/** `t` of the panel: the string for a key in the panel's language, placeholders filled. */
export type Translate = (key: MessageKey, values?: TranslateValues) => string;

const FSI = '\u2068';
const PDI = '\u2069';

/**
 * `values` with each string in a first-strong isolate (U+2068 ... U+2069).
 * The sentence keeps the direction of the element it is shown in; a value
 * in the other script (a Latin name in a Persian sentence, an API detail)
 * is laid out in its own direction, punctuation included, and counts as a
 * single neutral character for the sentence around it, so it moves none of
 * the sentence's punctuation.
 */
export function isolateValues(values: TranslateValues): TranslateValues {
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(values)) out[name] = typeof value === 'string' ? `${FSI}${value}${PDI}` : value;
  return out;
}

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
