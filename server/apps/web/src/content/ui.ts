import type { StoreId } from '@app/shared';
import type { FooterPageId } from '../lib/i18n';
import type { Localized } from './types';

/**
 * The site's own words: navigation, headings, buttons and the safety
 * commitments every brand shares. What the product is and offers is the
 * brand's (brand.json `tagline`, `description`, `site`), never written here.
 */
export interface UiStrings {
  skipToContent: string;
  languageLabel: string;
  mainNavLabel: string;
  footerPolicies: string;
  footerContact: string;
  draftTitle: string;
  draftBody: string;
  pageNames: Readonly<Record<FooterPageId | 'download', string>>;
  stores: Readonly<Record<StoreId, { name: string; button: string }>>;
  homeStoresTitle: string;
  homeStoresSoon: string;
  homeDownloadLink: string;
  homeHighlightsTitle: string;
  homeScreenshotsTitle: string;
  homeSafetyTitle: string;
  homeSafety: readonly string[];
  homePoliciesTitle: string;
  downloadTitle: string;
  downloadDescription: string;
  downloadSoon: string;
  downloadOnlyStores: string;
  notFoundTitle: string;
  notFoundBody: string;
  notFoundLink: string;
  chooseLanguage: string;
}

export const ui: Localized<UiStrings> = {
  en: {
    skipToContent: 'Skip to content',
    languageLabel: 'Language',
    mainNavLabel: 'Main',
    footerPolicies: 'Policies and help',
    footerContact: 'Contact',
    draftTitle: 'Draft',
    draftBody:
      'This text is a draft and is not in force yet. It is being reviewed with legal counsel before {appName} launches.',
    pageNames: {
      privacy: 'Privacy Policy',
      terms: 'Terms of Use',
      'community-guidelines': 'Community Guidelines',
      'child-safety': 'Child Safety Standards',
      support: 'Support',
      'delete-account': 'Delete your account',
      download: 'Download',
    },
    stores: {
      play: { name: 'Google Play', button: 'Get it on Google Play' },
      bazaar: { name: 'Cafe Bazaar', button: 'Get it on Cafe Bazaar' },
    },
    homeStoresTitle: 'Get the app',
    homeStoresSoon: '{appName} is not in the app stores yet. The store links will appear here once it is published.',
    homeDownloadLink: 'All download options',
    homeHighlightsTitle: 'What you get',
    homeScreenshotsTitle: 'A look inside',
    homeSafetyTitle: 'Safety comes first',
    homeSafety: [
      'Adults only: everyone on {appName} is 18 or older.',
      'Your exact location never leaves our servers. Others see a rounded distance and your city.',
      'Photos are checked before anyone else can see them.',
      'Every profile and conversation has Report and Block, and our team reviews every report.',
      'If we act on an account, we always say why, and every decision can be appealed in the app.',
    ],
    homePoliciesTitle: 'Policies and help',
    downloadTitle: 'Download {appName}',
    downloadDescription: 'Get {appName} from the official app stores.',
    downloadSoon: '{appName} is not in the app stores yet. The store links will appear here once it is published.',
    downloadOnlyStores:
      'Install {appName} only from these stores. We do not offer the app anywhere else, so a copy from another place is not ours.',
    notFoundTitle: 'Page not found',
    notFoundBody: 'The page you are looking for does not exist.',
    notFoundLink: 'Go to Support',
    chooseLanguage: 'Choose your language',
  },
  fa: {
    skipToContent: 'رفتن به محتوا',
    languageLabel: 'زبان',
    mainNavLabel: 'اصلی',
    footerPolicies: 'سیاست‌ها و راهنما',
    footerContact: 'تماس',
    draftTitle: 'پیش‌نویس',
    draftBody: 'این متن پیش‌نویس است و هنوز اجرایی نیست. پیش از راه‌اندازی {appName} با مشاور حقوقی بازبینی می‌شود.',
    pageNames: {
      privacy: 'سیاست حریم خصوصی',
      terms: 'شرایط استفاده',
      'community-guidelines': 'قوانین جامعه',
      'child-safety': 'استانداردهای ایمنی کودکان',
      support: 'پشتیبانی',
      'delete-account': 'حذف حساب کاربری',
      download: 'دانلود',
    },
    stores: {
      play: { name: 'گوگل پلی', button: 'دریافت از گوگل پلی' },
      bazaar: { name: 'کافه‌بازار', button: 'دریافت از کافه‌بازار' },
    },
    homeStoresTitle: 'دریافت اپ',
    homeStoresSoon: '{appName} هنوز در فروشگاه‌های اپ منتشر نشده است. پیوند فروشگاه‌ها پس از انتشار این‌جا قرار می‌گیرد.',
    homeDownloadLink: 'همه‌ی راه‌های دریافت',
    homeHighlightsTitle: 'آنچه به دست می‌آورید',
    homeScreenshotsTitle: 'نگاهی به داخل اپ',
    homeSafetyTitle: 'اول، ایمنی',
    homeSafety: [
      'فقط بزرگسالان: همه‌ی کاربران {appName} ۱۸ سال یا بیشتر دارند.',
      'موقعیت دقیق شما هرگز از سرورهای ما بیرون نمی‌رود. دیگران فقط فاصله‌ی گردشده و شهر شما را می‌بینند.',
      'عکس‌ها پیش از آن‌که کس دیگری ببیند بررسی می‌شوند.',
      'هر پروفایل و هر گفتگو گزینه‌ی گزارش و مسدودسازی دارد و تیم ما همه‌ی گزارش‌ها را بررسی می‌کند.',
      'اگر درباره‌ی حسابی اقدامی کنیم، همیشه دلیلش را می‌گوییم و به هر تصمیم می‌شود در اپ اعتراض کرد.',
    ],
    homePoliciesTitle: 'سیاست‌ها و راهنما',
    downloadTitle: 'دانلود {appName}',
    downloadDescription: '{appName} را از فروشگاه‌های رسمی اپ دریافت کنید.',
    downloadSoon: '{appName} هنوز در فروشگاه‌های اپ منتشر نشده است. پیوند فروشگاه‌ها پس از انتشار این‌جا قرار می‌گیرد.',
    downloadOnlyStores:
      '{appName} را فقط از همین فروشگاه‌ها نصب کنید. ما اپ را جای دیگری عرضه نمی‌کنیم، پس نسخه‌ای که از جای دیگر بیاید متعلق به ما نیست.',
    notFoundTitle: 'صفحه پیدا نشد',
    notFoundBody: 'صفحه‌ای که دنبالش هستید وجود ندارد.',
    notFoundLink: 'رفتن به پشتیبانی',
    chooseLanguage: 'زبان خود را انتخاب کنید',
  },
  tr: {
    skipToContent: 'İçeriğe geç',
    languageLabel: 'Dil',
    mainNavLabel: 'Ana menü',
    footerPolicies: 'Politikalar ve yardım',
    footerContact: 'İletişim',
    draftTitle: 'Taslak',
    draftBody:
      'Bu metin bir taslaktır ve henüz yürürlükte değildir. {appName} yayına girmeden önce hukuk danışmanıyla gözden geçiriliyor.',
    pageNames: {
      privacy: 'Gizlilik Politikası',
      terms: 'Kullanım Koşulları',
      'community-guidelines': 'Topluluk Kuralları',
      'child-safety': 'Çocuk Güvenliği Standartları',
      support: 'Destek',
      'delete-account': 'Hesabını sil',
      download: 'İndir',
    },
    stores: {
      play: { name: 'Google Play', button: 'Google Play’den indir' },
      bazaar: { name: 'Cafe Bazaar', button: 'Cafe Bazaar’dan indir' },
    },
    homeStoresTitle: 'Uygulamayı edin',
    homeStoresSoon: '{appName} henüz uygulama mağazalarında değil. Yayınlandığında mağaza bağlantıları burada olacak.',
    homeDownloadLink: 'Tüm indirme seçenekleri',
    homeHighlightsTitle: 'Neler sunuyor',
    homeScreenshotsTitle: 'Uygulamadan görüntüler',
    homeSafetyTitle: 'Önce güvenlik',
    homeSafety: [
      'Yalnızca yetişkinler: {appName} üzerindeki herkes 18 yaşında veya daha büyük.',
      'Tam konumun sunucularımızdan asla çıkmaz. Diğerleri yuvarlanmış bir mesafe ve şehrini görür.',
      'Fotoğraflar başkası görmeden önce kontrol edilir.',
      'Her profilde ve sohbette Bildir ve Engelle vardır; ekibimiz her bildirimi inceler.',
      'Bir hesap hakkında işlem yaparsak nedenini her zaman söyleriz ve her karara uygulamada itiraz edilebilir.',
    ],
    homePoliciesTitle: 'Politikalar ve yardım',
    downloadTitle: '{appName} uygulamasını indir',
    downloadDescription: '{appName} uygulamasını resmî uygulama mağazalarından edin.',
    downloadSoon: '{appName} henüz uygulama mağazalarında değil. Yayınlandığında mağaza bağlantıları burada olacak.',
    downloadOnlyStores:
      '{appName} uygulamasını yalnızca bu mağazalardan yükle. Uygulamayı başka hiçbir yerde sunmuyoruz; başka bir yerden gelen kopya bize ait değildir.',
    notFoundTitle: 'Sayfa bulunamadı',
    notFoundBody: 'Aradığın sayfa mevcut değil.',
    notFoundLink: 'Desteğe git',
    chooseLanguage: 'Dilini seç',
  },
};
