import type { PushText } from '@app/shared';

/**
 * The text of the pushes the worker sends, in the person's language (fa,
 * en, tr; anything else gets English). Generic unless the person turned
 * previews on; with previews, a match names the other person by first name
 * only. A like never names anyone (who liked is what a plan pays for).
 */

export type PushLocale = 'fa' | 'en' | 'tr';

export function pushLocale(locale: string | null | undefined): PushLocale {
  const base = (locale ?? '').slice(0, 2).toLowerCase();
  return base === 'fa' || base === 'tr' ? base : 'en';
}

/** The first name of a display name, kept short: what a push may show of a person. */
export function firstName(name: string): string {
  const first = name.trim().split(/\s+/u)[0] ?? '';
  return [...first].slice(0, 40).join('');
}

const TEXTS = {
  match: {
    en: { title: 'New match', body: 'You have a new match. Say hello!', named: (name: string) => `You and ${name} like each other.` },
    fa: { title: 'مچ جدید', body: 'یک مچ جدید دارید. سلام کنید!', named: (name: string) => `شما و ${name} همدیگر را پسندیدید.` },
    tr: { title: 'Yeni eşleşme', body: 'Yeni bir eşleşmen var. Merhaba de!', named: (name: string) => `${name} ile birbirinizi beğendiniz.` },
  },
  like: {
    en: { title: 'New like', one: 'Someone liked you.', many: (n: string) => `${n} people liked you.` },
    fa: { title: 'لایک جدید', one: 'کسی شما را لایک کرده است.', many: (n: string) => `${n} نفر شما را لایک کرده‌اند.` },
    tr: { title: 'Yeni beğeni', one: 'Biri seni beğendi.', many: (n: string) => `${n} kişi seni beğendi.` },
  },
} as const;

const NUMBER_LOCALE: Record<PushLocale, string> = { en: 'en-US', fa: 'fa-IR', tr: 'tr-TR' };

export function matchText(locale: PushLocale, previews: boolean, peerName: string | undefined): PushText {
  const t = TEXTS.match[locale];
  const name = peerName ? firstName(peerName) : '';
  return { title: t.title, body: previews && name ? t.named(name) : t.body };
}

export function likeText(locale: PushLocale, total: number): PushText {
  const t = TEXTS.like[locale];
  if (total <= 1) return { title: t.title, body: t.one };
  return { title: t.title, body: t.many(new Intl.NumberFormat(NUMBER_LOCALE[locale]).format(total)) };
}
