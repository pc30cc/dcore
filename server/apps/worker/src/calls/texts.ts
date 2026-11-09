import type { PushText } from '@app/shared';
import { firstName, type PushLocale } from '../push/texts.js';

/**
 * The missed-call notification, in the person's language. Generic unless
 * the person turned previews on; with previews it names the caller by first
 * name only.
 */

const TEXTS = {
  en: {
    audio: 'Missed voice call',
    video: 'Missed video call',
    body: 'You missed a call.',
    named: (name: string) => `${name} called you.`,
  },
  fa: {
    audio: 'تماس صوتی از دست رفته',
    video: 'تماس تصویری از دست رفته',
    body: 'یک تماس را از دست دادید.',
    named: (name: string) => `${name} با شما تماس گرفت.`,
  },
  tr: {
    audio: 'Cevapsız sesli arama',
    video: 'Cevapsız görüntülü arama',
    body: 'Bir aramayı kaçırdın.',
    named: (name: string) => `${name} seni aradı.`,
  },
} as const;

export function missedCallText(locale: PushLocale, kind: 'audio' | 'video', previews: boolean, callerName: string | undefined): PushText {
  const t = TEXTS[locale];
  const name = callerName ? firstName(callerName) : '';
  return { title: t[kind], body: previews && name ? t.named(name) : t.body };
}
