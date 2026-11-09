import type { Locale } from '@app/shared';
import { en } from './locales/en';
import { fa } from './locales/fa';
import { tr } from './locales/tr';

/**
 * The panel's strings, per language. English is the reference: every other
 * language has the same keys and placeholders (the i18n test holds them).
 */

export type MessageKey = keyof typeof en;
export type Messages = Readonly<Record<MessageKey, string>>;

export const messages: Readonly<Record<Locale, Messages>> = { en, fa, tr };

export const localeNames: Readonly<Record<Locale, string>> = { en: 'English', fa: 'فارسی', tr: 'Türkçe' };
