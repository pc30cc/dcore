import type { Locale } from '@app/shared';

/**
 * The panel's strings. `{appName}` and other placeholders are filled at run
 * time; no brand name is written here.
 */
const en = {
  'app.title': '{appName} Admin',
  'nav.label': 'Sections',
  'nav.open': 'Open navigation',
  'nav.close': 'Close navigation',
  'nav.dashboard': 'Dashboard',
  'nav.users': 'Users',
  'nav.moderation': 'Moderation',
  'nav.content': 'Content',
  'nav.revenue': 'Revenue',
  'nav.growth': 'Growth',
  'nav.brand': 'Brand and app',
  'nav.support': 'Support',
  'nav.system': 'System',
  'section.pending.title': 'Not built yet',
  'section.pending.body':
    'Section {section}: this section needs its admin API, which does not exist yet.',
  'shell.devNotice':
    'Development build: the panel opens without signing in. A production build sends everyone to the sign-in page until admin authentication exists.',
  'login.title': 'Sign in to {appName} Admin',
  'login.subtitle': 'For the team only. Every action is recorded in the audit log.',
  'login.email': 'Work e-mail',
  'login.password': 'Password',
  'login.otp': 'Code from your authenticator app',
  'login.submit': 'Sign in',
  'login.unavailable.title': 'Sign-in is not connected yet',
  'login.unavailable.body':
    'The API has no admin authentication yet (e-mail, password and a required second factor). Until it does, nobody can sign in here.',
  'theme.label': 'Theme',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'theme.system': 'System',
  'language.label': 'Language',
  'notFound.title': 'Page not found',
  'notFound.back': 'Back to the dashboard',
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Readonly<Record<MessageKey, string>>;

const fa: Messages = {
  'app.title': 'پنل مدیریت {appName}',
  'nav.label': 'بخش‌ها',
  'nav.open': 'باز کردن منو',
  'nav.close': 'بستن منو',
  'nav.dashboard': 'داشبورد',
  'nav.users': 'کاربران',
  'nav.moderation': 'نظارت',
  'nav.content': 'محتوا',
  'nav.revenue': 'درآمد',
  'nav.growth': 'رشد',
  'nav.brand': 'برند و اپ',
  'nav.support': 'پشتیبانی',
  'nav.system': 'سیستم',
  'section.pending.title': 'هنوز ساخته نشده',
  'section.pending.body':
    'بخش {section}: این بخش به API مدیریت خودش نیاز دارد که هنوز وجود ندارد.',
  'shell.devNotice':
    'نسخه‌ی توسعه: پنل بدون ورود باز می‌شود. نسخه‌ی production تا وقتی ورود مدیران ساخته نشده، همه را به صفحه‌ی ورود می‌فرستد.',
  'login.title': 'ورود به پنل مدیریت {appName}',
  'login.subtitle': 'فقط برای تیم. هر اقدام در لاگ ممیزی ثبت می‌شود.',
  'login.email': 'ایمیل کاری',
  'login.password': 'رمز عبور',
  'login.otp': 'کد برنامه‌ی احراز هویت',
  'login.submit': 'ورود',
  'login.unavailable.title': 'ورود هنوز وصل نشده',
  'login.unavailable.body':
    'API هنوز ورود مدیران را ندارد (ایمیل، رمز عبور و عامل دوم اجباری). تا آن موقع هیچ‌کس نمی‌تواند این‌جا وارد شود.',
  'theme.label': 'پوسته',
  'theme.light': 'روشن',
  'theme.dark': 'تیره',
  'theme.system': 'سیستم',
  'language.label': 'زبان',
  'notFound.title': 'صفحه پیدا نشد',
  'notFound.back': 'بازگشت به داشبورد',
};

const tr: Messages = {
  'app.title': '{appName} Yönetim',
  'nav.label': 'Bölümler',
  'nav.open': 'Menüyü aç',
  'nav.close': 'Menüyü kapat',
  'nav.dashboard': 'Pano',
  'nav.users': 'Kullanıcılar',
  'nav.moderation': 'Moderasyon',
  'nav.content': 'İçerik',
  'nav.revenue': 'Gelir',
  'nav.growth': 'Büyüme',
  'nav.brand': 'Marka ve uygulama',
  'nav.support': 'Destek',
  'nav.system': 'Sistem',
  'section.pending.title': 'Henüz hazır değil',
  'section.pending.body':
    'Bölüm {section}: bu bölümün yönetim API’si henüz yok.',
  'shell.devNotice':
    'Geliştirme sürümü: panel oturum açmadan açılır. Üretim sürümü, yönetici kimlik doğrulaması hazır olana kadar herkesi giriş sayfasına yönlendirir.',
  'login.title': '{appName} Yönetim’e giriş',
  'login.subtitle': 'Yalnızca ekip için. Her işlem denetim kaydına yazılır.',
  'login.email': 'İş e-postası',
  'login.password': 'Parola',
  'login.otp': 'Doğrulama uygulamasındaki kod',
  'login.submit': 'Giriş yap',
  'login.unavailable.title': 'Giriş henüz bağlı değil',
  'login.unavailable.body':
    'API’de henüz yönetici kimlik doğrulaması yok (e-posta, parola ve zorunlu ikinci adım). O zamana kadar kimse buradan giriş yapamaz.',
  'theme.label': 'Tema',
  'theme.light': 'Açık',
  'theme.dark': 'Koyu',
  'theme.system': 'Sistem',
  'language.label': 'Dil',
  'notFound.title': 'Sayfa bulunamadı',
  'notFound.back': 'Panoya dön',
};

export const messages: Readonly<Record<Locale, Messages>> = { en, fa, tr };

export const localeNames: Readonly<Record<Locale, string>> = { en: 'English', fa: 'فارسی', tr: 'Türkçe' };
