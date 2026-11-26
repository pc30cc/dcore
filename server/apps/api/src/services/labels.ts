import type { Locale } from '@app/shared';

/**
 * Default labels of the fixed catalogue lists `GET /v1/config` carries
 * (intentions, report reasons, deletion reasons) and of photo rejection
 * reasons, text rejection reasons and moderation reasons. The panel
 * overrides any of them per brand and locale with an i18n string
 * (`catalog.intention.<key>`, `catalog.report.<key>`,
 * `catalog.deletion.<key>`, `photo.reject.<code>`, `text.reject.<code>`,
 * `moderation.reason.<code>`).
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
  9: { en: 'This photo was not approved.', fa: 'این عکس تأیید نشد.', tr: 'Bu fotoğraf onaylanmadı.' },
};

/**
 * Text rejection reasons (profiles.text_reject_reason, profile_prompts.reject_reason);
 * codes without their own text use 6 (`other`).
 */
export const textRejectLabels: Readonly<Record<number, Texts>> = {
  1: {
    en: 'Contact details, links and social handles are not allowed in your profile.',
    fa: 'راه تماس، پیوند و نام کاربری شبکه‌های اجتماعی در پروفایل مجاز نیست.',
    tr: 'Profilinizde iletişim bilgisi, bağlantı ve sosyal medya kullanıcı adı olamaz.',
  },
  2: { en: 'Offensive or hateful language is not allowed.', fa: 'زبان توهین‌آمیز یا نفرت‌آمیز مجاز نیست.', tr: 'Saldırgan veya nefret içeren dil yasaktır.' },
  3: { en: 'Sexual content is not allowed in your profile.', fa: 'محتوای جنسی در پروفایل مجاز نیست.', tr: 'Profilinizde cinsel içerik olamaz.' },
  4: { en: 'Advertising and selling are not allowed.', fa: 'تبلیغ و فروش مجاز نیست.', tr: 'Reklam ve satış yasaktır.' },
  5: { en: 'Do not present yourself as someone else.', fa: 'خود را به‌جای شخص دیگری معرفی نکنید.', tr: 'Kendinizi başka biri olarak tanıtmayın.' },
  6: { en: 'This text was not approved.', fa: 'این متن تأیید نشد.', tr: 'Bu metin onaylanmadı.' },
};

/**
 * The default message a person reads for a moderation reason
 * (moderation_actions.reason_code): the panel pre-fills it, in the person's
 * language, and the admin may edit it before sending.
 */
export const moderationReasonLabels: Readonly<Record<number, Texts>> = {
  1: {
    en: 'Your profile does not appear to represent a real person.',
    fa: 'به نظر نمی‌رسد پروفایل شما متعلق به یک شخص واقعی باشد.',
    tr: 'Profiliniz gerçek bir kişiyi temsil ediyor görünmüyor.',
  },
  2: { en: 'You harassed or bullied other members.', fa: 'شما دیگر کاربران را آزار داده‌اید یا مزاحمشان شده‌اید.', tr: 'Diğer üyeleri taciz ettiniz veya rahatsız ettiniz.' },
  3: {
    en: 'You shared content that breaks our community guidelines.',
    fa: 'شما محتوایی منتشر کرده‌اید که با قوانین جامعه مغایر است.',
    tr: 'Topluluk kurallarımıza aykırı içerik paylaştınız.',
  },
  4: { en: 'Your account was used for scams or fraud.', fa: 'از حساب شما برای کلاهبرداری استفاده شده است.', tr: 'Hesabınız dolandırıcılık için kullanıldı.' },
  5: {
    en: 'You must be 18 or older to use this app.',
    fa: 'برای استفاده از این برنامه باید دست‌کم ۱۸ سال داشته باشید.',
    tr: 'Bu uygulamayı kullanmak için en az 18 yaşında olmalısınız.',
  },
  6: { en: 'You threatened or endangered other members.', fa: 'شما دیگر کاربران را تهدید کرده‌اید یا به خطر انداخته‌اید.', tr: 'Diğer üyeleri tehdit ettiniz veya tehlikeye attınız.' },
  7: {
    en: 'Your account sent spam or unwanted promotion.',
    fa: 'از حساب شما پیام‌های ناخواسته یا تبلیغاتی فرستاده شده است.',
    tr: 'Hesabınızdan istenmeyen mesaj veya reklam gönderildi.',
  },
  8: { en: 'Your account broke our child safety rules.', fa: 'حساب شما قوانین ایمنی کودکان را نقض کرده است.', tr: 'Hesabınız çocuk güvenliği kurallarımızı ihlal etti.' },
  9: { en: 'You used hateful or abusive language.', fa: 'شما از زبان نفرت‌آمیز یا توهین‌آمیز استفاده کرده‌اید.', tr: 'Nefret içeren veya hakaret eden bir dil kullandınız.' },
  10: {
    en: 'This account was created to get around an earlier restriction.',
    fa: 'این حساب برای دور زدن یک محدودیت قبلی ساخته شده است.',
    tr: 'Bu hesap önceki bir kısıtlamayı aşmak için açıldı.',
  },
  99: { en: 'Your account broke our community guidelines.', fa: 'حساب شما قوانین جامعه را نقض کرده است.', tr: 'Hesabınız topluluk kurallarımızı ihlal etti.' },
};

export function label(texts: Texts | undefined, locale: Locale, fallback: string): string {
  return texts?.[locale] ?? texts?.en ?? fallback;
}
