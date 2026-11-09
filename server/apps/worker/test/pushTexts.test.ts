import { describe, expect, it } from 'vitest';
import { missedCallText } from '../src/calls/texts.js';
import { likeText, matchText, messageText, pushLocale, requestText, type PushLocale } from '../src/push/texts.js';

/**
 * The texts of the pushes the worker writes, in each language, as the app
 * words the same things (its notification, chat and call strings): generic
 * without previews, a first name with them, never a name for a like or a
 * message request.
 */

const LOCALES: readonly PushLocale[] = ['fa', 'en', 'tr'];

function everyText(locale: PushLocale): string[] {
  return [
    matchText(locale, false, 'Negar Ahmadi'),
    matchText(locale, true, 'Negar Ahmadi'),
    likeText(locale, 1),
    likeText(locale, 12),
    messageText(locale, false, 'Negar', 'hello'),
    messageText(locale, true, 'Negar', undefined),
    requestText(locale),
    missedCallText(locale, 'audio', false, 'Negar'),
    missedCallText(locale, 'video', true, 'Negar'),
  ].flatMap((t) => [t.title, t.body]);
}

describe('push texts', () => {
  it('reads the language of the device, English for anything else', () => {
    expect(['fa', 'fa-IR', 'FA', 'en', 'en-GB', 'tr', 'tr-TR', 'de', '', null, undefined].map(pushLocale)).toEqual([
      'fa',
      'fa',
      'fa',
      'en',
      'en',
      'tr',
      'tr',
      'en',
      'en',
      'en',
      'en',
    ]);
  });

  it('words a match as the app does, naming the other person only with previews on', () => {
    expect(matchText('fa', false, 'Negar Ahmadi')).toEqual({ title: 'مچ تازه دارید', body: 'تا داغ است سلام کنید.' });
    expect(matchText('fa', true, 'Negar Ahmadi')).toEqual({ title: 'مچ تازه دارید', body: 'شما و Negar مچ شدید.' });
    expect(matchText('en', false, 'Negar')).toEqual({ title: 'You have a new match', body: "Say hello while it's fresh." });
    expect(matchText('en', true, 'Negar')).toEqual({ title: 'You have a new match', body: 'You and Negar matched.' });
    expect(matchText('tr', false, 'Negar')).toEqual({ title: 'Yeni bir eşleşmen var', body: 'Sıcakken bir merhaba de.' });
    expect(matchText('tr', true, 'Negar')).toEqual({ title: 'Yeni bir eşleşmen var', body: 'Sen ve Negar eşleştiniz.' });
    // A name that is not plainly a name falls back to the generic text.
    expect(matchText('fa', true, '0912 345 6789').body).toBe('تا داغ است سلام کنید.');
  });

  it('counts likes in the language’s own digits and never names a liker', () => {
    expect(likeText('fa', 1)).toEqual({ title: 'لایک تازه', body: 'کسی شما را لایک کرده.' });
    expect(likeText('fa', 12)).toEqual({ title: 'لایک تازه', body: '۱۲ نفر شما را لایک کرده‌اند.' });
    expect(likeText('en', 1)).toEqual({ title: 'New like', body: 'Someone likes you.' });
    expect(likeText('en', 1_200)).toEqual({ title: 'New like', body: '1,200 people like you.' });
    expect(likeText('tr', 3)).toEqual({ title: 'Yeni beğeni', body: '3 kişi seni beğendi.' });
  });

  it('keeps a message generic without previews, and a message request always', () => {
    expect(messageText('fa', false, 'Negar', 'سلام')).toEqual({ title: 'پیام تازه', body: 'یک پیام تازه دارید.' });
    expect(messageText('fa', true, 'Negar Ahmadi', 'سلام')).toEqual({ title: 'Negar', body: 'سلام' });
    expect(messageText('fa', true, 'Negar', undefined)).toEqual({ title: 'Negar', body: 'برایتان پیام فرستاد.' });
    expect(messageText('en', false, 'Negar', 'hi')).toEqual({ title: 'New message', body: 'You have a new message.' });
    expect(messageText('tr', true, 'Negar', 'https://example.com')).toEqual({ title: 'Negar', body: 'Sana bir mesaj gönderdi.' });
    expect(requestText('fa')).toEqual({ title: 'درخواست پیام تازه', body: 'کسی می‌خواهد با شما گفتگو کند.' });
    expect(requestText('en')).toEqual({ title: 'New message request', body: 'Someone wants to talk to you.' });
    expect(requestText('tr')).toEqual({ title: 'Yeni mesaj isteği', body: 'Biri seninle konuşmak istiyor.' });
  });

  it('titles a missed call as the app’s call notification does', () => {
    expect(missedCallText('fa', 'audio', false, 'Negar')).toEqual({ title: 'تماس صوتی بی‌پاسخ', body: 'یک تماس بی‌پاسخ دارید.' });
    expect(missedCallText('fa', 'video', true, 'Negar')).toEqual({ title: 'تماس تصویری بی‌پاسخ', body: 'Negar با شما تماس گرفت.' });
    expect(missedCallText('en', 'audio', false, 'Negar')).toEqual({ title: 'Missed voice call', body: 'You missed a call.' });
    expect(missedCallText('en', 'video', true, 'Negar')).toEqual({ title: 'Missed video call', body: 'Negar called you.' });
    expect(missedCallText('tr', 'audio', false, 'Negar')).toEqual({ title: 'Cevapsız sesli arama', body: 'Bir aramayı kaçırdın.' });
    expect(missedCallText('tr', 'video', true, 'Negar')).toEqual({ title: 'Cevapsız görüntülü arama', body: 'Negar seni aradı.' });
  });

  it('says «مچ» and «لایک» in Persian, never another word for them', () => {
    const persian = everyText('fa').join('\n');
    expect(persian).toContain('مچ');
    expect(persian).toContain('لایک');
    for (const other of ['پسند', 'جفت', 'همتا', 'جدید', 'از دست']) expect(persian, other).not.toContain(other);
  });

  it('leaves no text empty, untrimmed or with a placeholder in any language', () => {
    for (const locale of LOCALES) {
      for (const text of everyText(locale)) {
        expect(text.length, locale).toBeGreaterThan(0);
        expect(text, locale).toBe(text.trim());
        expect(text, locale).not.toMatch(/[{}%$]|undefined|null/);
      }
    }
  });
});
