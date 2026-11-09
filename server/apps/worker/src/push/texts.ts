import type { PushText } from '@app/shared';

/**
 * The text of the pushes the worker sends, in the person's language (fa,
 * en, tr; anything else gets English). Generic unless the person turned
 * previews on; with previews, a match and a message name the other person
 * by first name only, and a message shows the start of a text (never one
 * that holds a link, an e-mail address or a phone number). A like never
 * names anyone (who liked is what a plan pays for); a message request is
 * always generic (the sender is not someone the person chose).
 */

export type PushLocale = 'fa' | 'en' | 'tr';

export function pushLocale(locale: string | null | undefined): PushLocale {
  const base = (locale ?? '').slice(0, 2).toLowerCase();
  return base === 'fa' || base === 'tr' ? base : 'en';
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
  message: {
    en: { title: 'New message', body: 'You have a new message.', sent: 'Sent you a message.' },
    fa: { title: 'پیام جدید', body: 'یک پیام جدید دارید.', sent: 'برای شما پیام فرستاد.' },
    tr: { title: 'Yeni mesaj', body: 'Yeni bir mesajın var.', sent: 'Sana bir mesaj gönderdi.' },
  },
  request: {
    en: { title: 'New message request', body: 'Someone sent you a message request.' },
    fa: { title: 'درخواست پیام جدید', body: 'کسی برای شما درخواست پیام فرستاده است.' },
    tr: { title: 'Yeni mesaj isteği', body: 'Biri sana mesaj isteği gönderdi.' },
  },
} as const;

/** What a push may show of a text: this many characters, on one line. */
export const PREVIEW_MAX_CHARS = 100;

/** Links, e-mail addresses and phone numbers (Latin, Persian and Arabic digits). */
const CONTACT = [
  /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]{2,}\.(com|net|org|ir|me|io|app|link|ly|to|gg|info|xyz|site)\b/i,
  /[^\s@]+@[^\s@]+\.[^\s@]{2,}/,
  /(?:[+0-9۰-۹٠-٩][\s().-]{0,2}){7,}/,
];

/**
 * The start of a text as a push may show it: control characters and line
 * breaks folded into single spaces, cut at PREVIEW_MAX_CHARS. Undefined when
 * nothing is left, or when the text holds something a lock screen or
 * Google's servers must not carry (a link, an e-mail address, a phone
 * number): the push then says only that a message came.
 */
export function pushPreview(text: string | undefined): string | undefined {
  if (!text) return undefined;
  // eslint-disable-next-line no-control-regex
  const folded = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!folded || CONTACT.some((pattern) => pattern.test(folded))) return undefined;
  const chars = [...folded];
  return chars.length > PREVIEW_MAX_CHARS ? `${chars.slice(0, PREVIEW_MAX_CHARS - 1).join('')}…` : folded;
}

/** A first name as a push may show it: letters (and marks, joiners, apostrophes, dots, hyphens) only. */
const NAME = /^(?:[\p{L}\p{M}'’.-]|\u200c|\u200d)+$/u;

/**
 * The first name of a display name, kept short: what a push may show of a
 * person. Empty for anything that is not plainly a name (digits, an e-mail
 * address, a phone number, symbols): the push then uses its generic text.
 */
export function firstName(name: string): string {
  const first = name.trim().split(/\s+/u)[0] ?? '';
  if (!NAME.test(first) || CONTACT.some((pattern) => pattern.test(first))) return '';
  return [...first].slice(0, 40).join('');
}

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

/**
 * A new message: generic without previews; with them, the sender's first
 * name as the title and the start of a text as the body (or "sent you a
 * message" for anything else, or a text a push must not show).
 */
export function messageText(locale: PushLocale, previews: boolean, senderName: string | undefined, preview: string | undefined): PushText {
  const t = TEXTS.message[locale];
  const name = senderName ? firstName(senderName) : '';
  if (!previews || !name) return { title: t.title, body: t.body };
  return { title: name, body: pushPreview(preview) ?? t.sent };
}

/** A message request: always generic. */
export function requestText(locale: PushLocale): PushText {
  const t = TEXTS.request[locale];
  return { title: t.title, body: t.body };
}
