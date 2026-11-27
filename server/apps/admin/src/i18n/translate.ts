import { interpolate, type Locale } from '@app/shared';
import { messages, type MessageKey } from './messages';

export type TranslateValues = Readonly<Record<string, string | number>>;

/** `t` of the panel: the string for a key in the panel's language, placeholders filled. */
export type Translate = (key: MessageKey, values?: TranslateValues) => string;

/**
 * How to word a text that stays on screen (a notice, a refusal): called
 * when it is drawn, with the panel's language of that moment, by
 * <Worded>, whose `t` isolates each string value. State holds this, never
 * finished text, which would keep the language it was worded in.
 */
export type Wording = (t: Translate, locale: Locale) => string;

const FSI = '\u2068';
const PDI = '\u2069';

/** `text` in a first-strong isolate (U+2068 ... U+2069): a value with no sentence of its own around it (an API detail). */
export function isolate(text: string): string {
  return `${FSI}${text}${PDI}`;
}

/**
 * `values` with each string in a first-strong isolate (U+2068 ... U+2069).
 * The sentence keeps the direction of the element it is shown in; a value
 * in the other script (a Latin name in a Persian sentence, an API detail)
 * is laid out in its own direction, punctuation included, and counts as a
 * single neutral character for the sentence around it, so it moves none of
 * the sentence's punctuation. <Worded> draws each isolate as a <bdi>.
 */
export function isolateValues(values: TranslateValues): TranslateValues {
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(values)) out[name] = typeof value === 'string' ? isolate(value) : value;
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
