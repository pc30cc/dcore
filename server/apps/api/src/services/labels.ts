import type { Locale } from '@app/shared';

/**
 * Default labels of the fixed catalogue lists `GET /v1/config` carries
 * (intentions, report reasons, deletion reasons) and of photo rejection
 * reasons. The panel overrides any of them per brand and locale with an
 * i18n string (`catalog.intention.<key>`, `catalog.report.<key>`,
 * `catalog.deletion.<key>`, `photo.reject.<code>`).
 */

type Texts = Readonly<Record<Locale, string>>;

export const intentionLabels: Readonly<Record<string, Texts>> = {
  serious: { en: 'A serious relationship', fa: 'رابطه‌ی جدی', tr: 'Ciddi bir ilişki' },
  marriage: { en: 'Marriage', fa: 'ازدواج', tr: 'Evlilik' },
  friendship: { en: 'Friendship', fa: 'دوستی', tr: 'Arkadaşlık' },
  not_sure: { en: 'Not sure yet', fa: 'هنوز مطمئن نیستم', tr: 'Henüz emin değilim' },
};

export const reportReasonLabels: Readonly<Record<string, Texts>> = {
  fake: { en: 'Fake profile', fa: 'پروفایل جعلی', tr: 'Sahte profil' },
  harassment: { en: 'Harassment', fa: 'آزار و مزاحمت', tr: 'Taciz' },
  inappropriate: { en: 'Inappropriate content', fa: 'محتوای نامناسب', tr: 'Uygunsuz içerik' },
  scam: { en: 'Scam or fraud', fa: 'کلاهبرداری', tr: 'Dolandırıcılık' },
  under_18: { en: 'May be under 18', fa: 'احتمالاً زیر ۱۸ سال', tr: '18 yaşından küçük olabilir' },
  threat: { en: 'Threat or danger', fa: 'تهدید یا خطر', tr: 'Tehdit veya tehlike' },
  spam: { en: 'Spam', fa: 'هرزنامه', tr: 'Spam' },
  child_safety: { en: 'A child may be at risk', fa: 'ممکن است کودکی در خطر باشد', tr: 'Bir çocuk risk altında olabilir' },
  other: { en: 'Something else', fa: 'موضوعی دیگر', tr: 'Başka bir şey' },
};

export const deletionReasonLabels: Readonly<Record<string, Texts>> = {
  break: { en: 'I need a break', fa: 'به استراحت نیاز دارم', tr: 'Ara vermem gerekiyor' },
  met_someone: { en: 'I met someone', fa: 'با کسی آشنا شدم', tr: 'Biriyle tanıştım' },
  not_useful: { en: 'It is not what I was looking for', fa: 'آن چیزی نبود که دنبالش بودم', tr: 'Aradığım şey değildi' },
  privacy: { en: 'Privacy concerns', fa: 'نگرانی درباره‌ی حریم خصوصی', tr: 'Gizlilik endişeleri' },
  bad_experience: { en: 'A bad experience', fa: 'تجربه‌ی بد', tr: 'Kötü bir deneyim' },
  other: { en: 'Something else', fa: 'دلیلی دیگر', tr: 'Başka bir neden' },
};

/** Photo rejection reasons (photos.reject_reason, 1-30); codes without their own text use `0`. */
export const photoRejectLabels: Readonly<Record<number, Texts>> = {
  0: { en: 'This photo was not approved.', fa: 'این عکس تأیید نشد.', tr: 'Bu fotoğraf onaylanmadı.' },
  1: { en: 'A face must be visible.', fa: 'چهره باید دیده شود.', tr: 'Yüz görünür olmalı.' },
  2: { en: 'Nudity or sexual content is not allowed.', fa: 'برهنگی یا محتوای جنسی مجاز نیست.', tr: 'Çıplaklık veya cinsel içerik yasaktır.' },
  3: { en: 'Violent content is not allowed.', fa: 'محتوای خشونت‌آمیز مجاز نیست.', tr: 'Şiddet içeren içerik yasaktır.' },
  4: { en: 'Text, contact details or links are not allowed in photos.', fa: 'متن، راه تماس یا پیوند در عکس مجاز نیست.', tr: 'Fotoğraflarda yazı, iletişim bilgisi veya bağlantı olamaz.' },
  5: { en: 'This photo seems to belong to someone else.', fa: 'به نظر می‌رسد این عکس متعلق به شخص دیگری است.', tr: 'Bu fotoğraf başka birine ait görünüyor.' },
  6: { en: 'The photo is too blurry or too small.', fa: 'عکس بیش از حد تار یا کوچک است.', tr: 'Fotoğraf çok bulanık veya çok küçük.' },
  7: { en: 'Only adults may appear in photos.', fa: 'در عکس‌ها فقط بزرگسالان می‌توانند باشند.', tr: 'Fotoğraflarda yalnızca yetişkinler yer alabilir.' },
  8: { en: 'This file could not be read as a photo. Try another one.', fa: 'این فایل به‌عنوان عکس خوانده نشد. عکس دیگری را امتحان کنید.', tr: 'Bu dosya fotoğraf olarak okunamadı. Başka bir tane deneyin.' },
};

export function label(texts: Texts | undefined, locale: Locale, fallback: string): string {
  return texts?.[locale] ?? texts?.en ?? fallback;
}
