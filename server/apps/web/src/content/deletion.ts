import type { AccountDeletionFormError, StoreId } from '@app/shared';
import type { ContentSection, Localized } from './types';

/** The texts of the deletion pages (request, code, done). Brand values are placeholders. */
export interface DeletionStrings {
  title: string;
  description: string;
  phoneTitle: string;
  phoneBody: string;
  phoneLabel: string;
  phoneHint: string;
  sendCode: string;
  googleTitle: string;
  googleBody: string;
  googleNoScript: string;
  googleUnavailable: string;
  noPhoneTitle: string;
  noPhoneBody: string;
  mailButton: string;
  mailSubject: string;
  verifyTitle: string;
  verifyDescription: string;
  codeLabel: string;
  codeHint: string;
  confirmButton: string;
  noCodeBody: string;
  startAgain: string;
  doneTitle: string;
  doneDescription: string;
  doneBody: readonly string[];
  doneSupport: string;
  errorTitle: string;
  errors: Readonly<Record<AccountDeletionFormError, string>>;
  subscriptionsTitle: string;
  subscriptionsBody: string;
  subscriptionsLink: Readonly<Record<StoreId, string>>;
  subscriptionsInApp: Readonly<Record<StoreId, string>>;
  /** After the forms: the in-app way, what is deleted, what is kept, changing your mind. */
  sections: readonly ContentSection[];
}

export const deletion: Localized<DeletionStrings> = {
  en: {
    title: 'Delete your account',
    description: 'Delete your {appName} account without the app, and see what happens to your data.',
    phoneTitle: 'Delete with your phone number',
    phoneBody:
      'Enter the number you signed up with. If an account uses it, we send a code to it by text message, so nobody but you can delete your account.',
    phoneLabel: 'Phone number',
    phoneHint: 'With the country code, for example +44 7700 900123.',
    sendCode: 'Send the code',
    googleTitle: 'Signed in with Google?',
    googleBody: 'If your account uses Google sign-in and no phone number, confirm with your Google account instead.',
    googleNoScript: 'This option needs JavaScript in your browser. Turn it on, or write to {supportEmail}.',
    googleUnavailable: 'Google sign-in could not be loaded. Please try again later, or write to {supportEmail}.',
    noPhoneTitle: 'No longer have that number?',
    noPhoneBody:
      'Write to {supportEmail} with the number you signed up with. We confirm with you before deleting anything.',
    mailButton: 'E-mail a deletion request',
    mailSubject: 'Delete my account',
    verifyTitle: 'Enter the code',
    verifyDescription:
      'If an account uses that number, we sent it a code by text message. Enter the number again with the code to delete the account.',
    codeLabel: 'Code',
    codeHint: 'The code from the text message.',
    confirmButton: 'Delete my account',
    noCodeBody: 'No message after a minute? Check the number and start again. No message is sent to a number that has no account.',
    startAgain: 'Start again',
    doneTitle: 'Your account is being deleted',
    doneDescription: 'Your request is confirmed.',
    doneBody: [
      'Your account is hidden from everyone now, and you are signed out on every device.',
      'It is deleted for good {graceDays} days after your request. Until then you can change your mind: sign in to {appName} with the same phone number or Google account and choose Restore.',
    ],
    doneSupport: 'Questions? Write to {supportEmail}.',
    errorTitle: 'There is a problem',
    errors: {
      phone_invalid: 'That does not look like a phone number. Enter it with the country code, for example +44 7700 900123.',
      rate_limited: 'Too many requests. Please wait a while and try again.',
      sms_unavailable: 'We cannot send text messages right now. Please try again later.',
      otp_invalid: 'That code is not right. Check the number and the code and try again.',
      otp_expired: 'That code has expired. Start again to get a new one.',
      otp_locked: 'Too many wrong codes. Start again to get a new code.',
      google_token_invalid: 'We could not confirm your Google account. Please try again.',
      maintenance: 'The service is under maintenance. Please try again later.',
      error: 'Something went wrong. Please try again, or write to {supportEmail}.',
    },
    subscriptionsTitle: 'Subscriptions',
    subscriptionsBody: 'Deleting your account does not cancel a store subscription. Cancel it in the store you bought it from:',
    subscriptionsLink: {
      play: 'Manage your Google Play subscriptions',
      bazaar: 'Manage your Cafe Bazaar subscriptions',
    },
    subscriptionsInApp: {
      play: 'Google Play: open the Play Store app and cancel it under Payments and subscriptions.',
      bazaar: 'Cafe Bazaar: open the Cafe Bazaar app and cancel it in your account’s subscriptions.',
    },
    sections: [
      {
        heading: 'In the app',
        body: ['If you can still sign in, this is the fastest way:'],
        list: ['Open {appName}.', 'Go to Settings, then Account, then Delete account.', 'Confirm.'],
        ordered: true,
      },
      {
        heading: 'What is deleted',
        body: [
          'Your account is hidden from everyone as soon as you confirm, and you are signed out on every device. {graceDays} days later we permanently delete your profile, photos, prompts, preferences, location, matches and the messages in them. Likes you gave disappear within two more weeks.',
        ],
      },
      {
        heading: 'What is kept, and why',
        body: ['A few records stay, without your profile:'],
        list: [
          'Purchase records, because tax and refund rules require them.',
          'Reports, moderation decisions and bans, so that safety work goes on and a banned person cannot simply come back. A ban keeps only a protected form of the phone number and the device, not the number itself.',
          'Support conversations, for the period consumer law requires.',
        ],
      },
      {
        heading: 'Changed your mind?',
        body: ['Sign in to {appName} with the same phone number or Google account within {graceDays} days and choose Restore.'],
      },
    ],
  },
  fa: {
    title: 'حذف حساب کاربری',
    description: 'حساب {appName} خود را بدون اپ حذف کنید و ببینید چه بر سر داده‌هایتان می‌آید.',
    phoneTitle: 'حذف با شماره‌ی موبایل',
    phoneBody:
      'شماره‌ای را که با آن ثبت‌نام کرده‌اید وارد کنید. اگر حسابی با این شماره باشد، کدی با پیامک به آن می‌فرستیم تا هیچ‌کس جز خودتان نتواند حسابتان را حذف کند.',
    phoneLabel: 'شماره‌ی موبایل',
    // U+2066/U+2069 keep the number left to right inside the Persian sentence.
    phoneHint: 'همراه با کد کشور، مثلاً \u2066+98 912 345 6789\u2069.',
    sendCode: 'ارسال کد',
    googleTitle: 'با Google وارد شده‌اید؟',
    googleBody: 'اگر حساب شما با Google وارد می‌شود و شماره‌ی موبایل ندارد، به‌جای آن با حساب Google خود تأیید کنید.',
    googleNoScript: 'این گزینه به JavaScript در مرورگر نیاز دارد. آن را روشن کنید یا به {supportEmail} بنویسید.',
    googleUnavailable: 'ورود با Google بارگیری نشد. لطفاً بعداً دوباره تلاش کنید یا به {supportEmail} بنویسید.',
    noPhoneTitle: 'دیگر به آن شماره دسترسی ندارید؟',
    noPhoneBody: 'با ذکر شماره‌ای که با آن ثبت‌نام کرده‌اید به {supportEmail} بنویسید. پیش از حذف هر چیزی با شما تأیید می‌کنیم.',
    mailButton: 'ارسال درخواست حذف با ایمیل',
    mailSubject: 'حذف حساب کاربری من',
    verifyTitle: 'کد را وارد کنید',
    verifyDescription:
      'اگر حسابی با آن شماره باشد، کدی با پیامک برایش فرستاده‌ایم. برای حذف حساب، شماره را دوباره همراه با کد وارد کنید.',
    codeLabel: 'کد',
    codeHint: 'کدی که در پیامک آمده است.',
    confirmButton: 'حذف حساب من',
    noCodeBody: 'پس از یک دقیقه پیامکی نرسید؟ شماره را بررسی کنید و دوباره شروع کنید. به شماره‌ای که حسابی ندارد پیامکی فرستاده نمی‌شود.',
    startAgain: 'شروع دوباره',
    doneTitle: 'حساب شما در حال حذف است',
    doneDescription: 'درخواست شما تأیید شد.',
    doneBody: [
      'حساب شما اکنون از دید همه پنهان است و از همه‌ی دستگاه‌ها خارج شده‌اید.',
      'حساب {graceDays} روز پس از درخواست شما برای همیشه حذف می‌شود. تا آن زمان می‌توانید نظرتان را تغییر دهید: با همان شماره‌ی موبایل یا حساب Google وارد {appName} شوید و «بازگرداندن حساب» را بزنید.',
    ],
    doneSupport: 'پرسشی دارید؟ به {supportEmail} بنویسید.',
    errorTitle: 'مشکلی پیش آمد',
    errors: {
      phone_invalid: 'این شماره درست به نظر نمی‌رسد. آن را همراه با کد کشور وارد کنید، مثلاً \u2066+98 912 345 6789\u2069.',
      rate_limited: 'درخواست‌ها بیش از حد زیاد است. کمی صبر کنید و دوباره تلاش کنید.',
      sms_unavailable: 'الان نمی‌توانیم پیامک بفرستیم. لطفاً بعداً دوباره تلاش کنید.',
      otp_invalid: 'کد درست نیست. شماره و کد را بررسی کنید و دوباره تلاش کنید.',
      otp_expired: 'مهلت این کد تمام شده است. برای گرفتن کد تازه دوباره شروع کنید.',
      otp_locked: 'کد اشتباه بیش از حد وارد شد. برای گرفتن کد تازه دوباره شروع کنید.',
      google_token_invalid: 'نتوانستیم حساب Google شما را تأیید کنیم. لطفاً دوباره تلاش کنید.',
      maintenance: 'سرویس در حال نگه‌داری است. لطفاً بعداً دوباره تلاش کنید.',
      error: 'مشکلی پیش آمد. لطفاً دوباره تلاش کنید یا به {supportEmail} بنویسید.',
    },
    subscriptionsTitle: 'اشتراک‌ها',
    subscriptionsBody: 'حذف حساب، اشتراک فروشگاه را لغو نمی‌کند. آن را در فروشگاهی که از آن خریده‌اید لغو کنید:',
    subscriptionsLink: {
      play: 'مدیریت اشتراک‌های گوگل پلی',
      bazaar: 'مدیریت اشتراک‌های کافه‌بازار',
    },
    subscriptionsInApp: {
      play: 'گوگل پلی: اپ Play Store را باز کنید و در بخش پرداخت‌ها و اشتراک‌ها آن را لغو کنید.',
      bazaar: 'کافه‌بازار: اپ کافه‌بازار را باز کنید و در بخش اشتراک‌های حساب کاربری‌تان آن را لغو کنید.',
    },
    sections: [
      {
        heading: 'در اپ',
        body: ['اگر هنوز می‌توانید وارد شوید، سریع‌ترین راه این است:'],
        list: ['{appName} را باز کنید.', 'به تنظیمات، سپس حساب، سپس حذف حساب بروید.', 'تأیید کنید.'],
        ordered: true,
      },
      {
        heading: 'چه چیزی حذف می‌شود',
        body: [
          'حساب شما بلافاصله پس از تأیید از دید همه پنهان می‌شود و از همه‌ی دستگاه‌ها خارج می‌شوید. {graceDays} روز بعد پروفایل، عکس‌ها، پاسخ پرسش‌ها، ترجیحات، موقعیت، مچ‌ها و پیام‌های آن‌ها برای همیشه حذف می‌شوند. لایک‌هایی که داده‌اید تا دو هفته‌ی بعد از آن پاک می‌شوند.',
        ],
      },
      {
        heading: 'چه چیزی نگه داشته می‌شود و چرا',
        body: ['چند سابقه، بدون پروفایل شما، می‌ماند:'],
        list: [
          'سوابق خرید، چون قوانین مالیات و بازپرداخت آن‌ها را الزامی می‌کنند.',
          'گزارش‌ها، تصمیم‌های نظارتی و محرومیت‌ها، تا کار ایمنی ادامه پیدا کند و فرد محروم‌شده به‌سادگی برنگردد. برای محرومیت فقط شکل محافظت‌شده‌ای از شماره و دستگاه نگه داشته می‌شود، نه خود شماره.',
          'گفتگوهای پشتیبانی، به مدتی که قانون حمایت از مصرف‌کننده الزام می‌کند.',
        ],
      },
      {
        heading: 'نظرتان عوض شد؟',
        body: ['ظرف {graceDays} روز با همان شماره‌ی موبایل یا حساب Google وارد {appName} شوید و «بازگرداندن حساب» را بزنید.'],
      },
    ],
  },
  tr: {
    title: 'Hesabını sil',
    description: '{appName} hesabını uygulama olmadan sil ve verilerine ne olacağını gör.',
    phoneTitle: 'Telefon numaranla sil',
    phoneBody:
      'Kayıt olduğun numarayı gir. Bu numarayı kullanan bir hesap varsa ona SMS ile bir kod göndeririz; böylece hesabını senden başka kimse silemez.',
    phoneLabel: 'Telefon numarası',
    phoneHint: 'Ülke koduyla, örneğin +90 532 123 45 67.',
    sendCode: 'Kodu gönder',
    googleTitle: 'Google ile mi giriş yaptın?',
    googleBody: 'Hesabın telefon numarası olmadan Google ile giriş yapıyorsa, onun yerine Google hesabınla onayla.',
    googleNoScript: 'Bu seçenek tarayıcında JavaScript gerektirir. Aç ya da {supportEmail} adresine yaz.',
    googleUnavailable: 'Google ile giriş yüklenemedi. Lütfen daha sonra yeniden dene ya da {supportEmail} adresine yaz.',
    noPhoneTitle: 'O numara artık sende değil mi?',
    noPhoneBody: 'Kayıt olduğun numarayı belirterek {supportEmail} adresine yaz. Hiçbir şeyi silmeden önce seninle teyit ederiz.',
    mailButton: 'Silme talebini e-postayla gönder',
    mailSubject: 'Hesabımı sil',
    verifyTitle: 'Kodu gir',
    verifyDescription:
      'Bu numarayı kullanan bir hesap varsa ona SMS ile bir kod gönderdik. Hesabı silmek için numarayı kodla birlikte yeniden gir.',
    codeLabel: 'Kod',
    codeHint: 'SMS’teki kod.',
    confirmButton: 'Hesabımı sil',
    noCodeBody: 'Bir dakika sonra mesaj gelmedi mi? Numarayı kontrol et ve yeniden başla. Hesabı olmayan bir numaraya mesaj gönderilmez.',
    startAgain: 'Yeniden başla',
    doneTitle: 'Hesabın siliniyor',
    doneDescription: 'Talebin onaylandı.',
    doneBody: [
      'Hesabın artık herkesten gizli ve tüm cihazlardan çıkış yaptın.',
      'Hesabın, talebinden {graceDays} gün sonra kalıcı olarak silinir. O zamana kadar fikrini değiştirebilirsin: aynı telefon numarası veya Google hesabıyla {appName} uygulamasına giriş yap ve Geri yükle’yi seç.',
    ],
    doneSupport: 'Sorun mu var? {supportEmail} adresine yaz.',
    errorTitle: 'Bir sorun var',
    errors: {
      phone_invalid: 'Bu bir telefon numarasına benzemiyor. Ülke koduyla gir, örneğin +90 532 123 45 67.',
      rate_limited: 'Çok fazla istek. Lütfen biraz bekleyip yeniden dene.',
      sms_unavailable: 'Şu anda SMS gönderemiyoruz. Lütfen daha sonra yeniden dene.',
      otp_invalid: 'Kod doğru değil. Numarayı ve kodu kontrol edip yeniden dene.',
      otp_expired: 'Bu kodun süresi doldu. Yeni bir kod almak için yeniden başla.',
      otp_locked: 'Çok fazla yanlış kod girildi. Yeni bir kod almak için yeniden başla.',
      google_token_invalid: 'Google hesabını doğrulayamadık. Lütfen yeniden dene.',
      maintenance: 'Hizmet bakımda. Lütfen daha sonra yeniden dene.',
      error: 'Bir şeyler ters gitti. Lütfen yeniden dene ya da {supportEmail} adresine yaz.',
    },
    subscriptionsTitle: 'Abonelikler',
    subscriptionsBody: 'Hesabını silmek mağaza aboneliğini iptal etmez. Aboneliği satın aldığın mağazadan iptal et:',
    subscriptionsLink: {
      play: 'Google Play aboneliklerini yönet',
      bazaar: 'Cafe Bazaar aboneliklerini yönet',
    },
    subscriptionsInApp: {
      play: 'Google Play: Play Store uygulamasını aç ve Ödemeler ve abonelikler bölümünden iptal et.',
      bazaar: 'Cafe Bazaar: Cafe Bazaar uygulamasını aç ve hesabının abonelikler bölümünden iptal et.',
    },
    sections: [
      {
        heading: 'Uygulamada',
        body: ['Hâlâ giriş yapabiliyorsan en hızlı yol bu:'],
        list: ['{appName} uygulamasını aç.', 'Ayarlar, ardından Hesap, ardından Hesabı sil bölümüne git.', 'Onayla.'],
        ordered: true,
      },
      {
        heading: 'Neler silinir',
        body: [
          'Onayladığın anda hesabın herkesten gizlenir ve tüm cihazlardan çıkış yaparsın. {graceDays} gün sonra profilini, fotoğraflarını, yanıtlarını, tercihlerini, konumunu, eşleşmelerini ve içlerindeki mesajları kalıcı olarak sileriz. Verdiğin beğeniler bundan sonraki iki hafta içinde kaybolur.',
        ],
      },
      {
        heading: 'Neler saklanır ve neden',
        body: ['Birkaç kayıt, profilin olmadan kalır:'],
        list: [
          'Satın alma kayıtları, çünkü vergi ve iade kuralları bunları gerektirir.',
          'Şikâyetler, denetim kararları ve yasaklar; güvenlik çalışması sürsün ve yasaklanan biri kolayca geri dönemesin diye. Bir yasak için numaranın kendisi değil, yalnızca numaranın ve cihazın korunmuş bir biçimi saklanır.',
          'Destek yazışmaları, tüketici mevzuatının gerektirdiği süre boyunca.',
        ],
      },
      {
        heading: 'Fikrini mi değiştirdin?',
        body: ['{graceDays} gün içinde aynı telefon numarası veya Google hesabıyla {appName} uygulamasına giriş yap ve Geri yükle’yi seç.'],
      },
    ],
  },
};
