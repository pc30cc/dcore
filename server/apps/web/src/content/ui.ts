import type { PageSlug } from '../lib/i18n';
import type { Localized } from './types';

export interface UiStrings {
  skipToContent: string;
  languageLabel: string;
  homeLink: string;
  footerPolicies: string;
  footerContact: string;
  draftTitle: string;
  draftBody: string;
  pageNames: Readonly<Record<PageSlug, string>>;
  homeTitle: string;
  homeBody: readonly string[];
  homeStoresTitle: string;
  homeStoresBody: string;
  homePoliciesTitle: string;
  deleteMailButton: string;
  deleteMailSubject: string;
  notFoundTitle: string;
  notFoundBody: string;
  chooseLanguage: string;
}

export const ui: Localized<UiStrings> = {
  en: {
    skipToContent: 'Skip to content',
    languageLabel: 'Language',
    homeLink: 'Home',
    footerPolicies: 'Policies',
    footerContact: 'Contact',
    draftTitle: 'Draft',
    draftBody:
      'This text is a draft and is not in force yet. It is being reviewed with legal counsel before {appName} launches.',
    pageNames: {
      privacy: 'Privacy Policy',
      terms: 'Terms of Use',
      'community-guidelines': 'Community Guidelines',
      'child-safety': 'Child Safety Standards',
      'delete-account': 'Delete your account',
      support: 'Support',
    },
    homeTitle: '{appName}',
    homeBody: [
      '{appName} is not available in app stores yet. This site holds its policies, explains how to delete an account, and is where to reach support.',
    ],
    homeStoresTitle: 'Get the app',
    homeStoresBody: 'Store links will appear here once the app is published.',
    homePoliciesTitle: 'Policies and help',
    deleteMailButton: 'E-mail a deletion request',
    deleteMailSubject: 'Delete my account',
    notFoundTitle: 'Page not found',
    notFoundBody: 'The page you are looking for does not exist.',
    chooseLanguage: 'Choose your language',
  },
  fa: {
    skipToContent: 'رفتن به محتوا',
    languageLabel: 'زبان',
    homeLink: 'خانه',
    footerPolicies: 'سیاست‌ها',
    footerContact: 'تماس',
    draftTitle: 'پیش‌نویس',
    draftBody: 'این متن پیش‌نویس است و هنوز اجرایی نیست. پیش از راه‌اندازی {appName} با مشاور حقوقی بازبینی می‌شود.',
    pageNames: {
      privacy: 'سیاست حریم خصوصی',
      terms: 'شرایط استفاده',
      'community-guidelines': 'قوانین جامعه',
      'child-safety': 'استانداردهای ایمنی کودکان',
      'delete-account': 'حذف حساب کاربری',
      support: 'پشتیبانی',
    },
    homeTitle: '{appName}',
    homeBody: [
      '{appName} هنوز در فروشگاه‌های اپ منتشر نشده است. این سایت سیاست‌های آن را در خود دارد، روش حذف حساب را توضیح می‌دهد و راه تماس با پشتیبانی است.',
    ],
    homeStoresTitle: 'دریافت اپ',
    homeStoresBody: 'پیوند فروشگاه‌ها پس از انتشار اپ این‌جا قرار می‌گیرد.',
    homePoliciesTitle: 'سیاست‌ها و راهنما',
    deleteMailButton: 'ارسال درخواست حذف با ایمیل',
    deleteMailSubject: 'حذف حساب کاربری من',
    notFoundTitle: 'صفحه پیدا نشد',
    notFoundBody: 'صفحه‌ای که دنبالش هستید وجود ندارد.',
    chooseLanguage: 'زبان خود را انتخاب کنید',
  },
  tr: {
    skipToContent: 'İçeriğe geç',
    languageLabel: 'Dil',
    homeLink: 'Ana sayfa',
    footerPolicies: 'Politikalar',
    footerContact: 'İletişim',
    draftTitle: 'Taslak',
    draftBody:
      'Bu metin bir taslaktır ve henüz yürürlükte değildir. {appName} yayına girmeden önce hukuk danışmanıyla gözden geçiriliyor.',
    pageNames: {
      privacy: 'Gizlilik Politikası',
      terms: 'Kullanım Koşulları',
      'community-guidelines': 'Topluluk Kuralları',
      'child-safety': 'Çocuk Güvenliği Standartları',
      'delete-account': 'Hesabını sil',
      support: 'Destek',
    },
    homeTitle: '{appName}',
    homeBody: [
      '{appName} henüz uygulama mağazalarında yok. Bu site politikalarını barındırır, hesabın nasıl silineceğini anlatır ve desteğe ulaşabileceğin yerdir.',
    ],
    homeStoresTitle: 'Uygulamayı edin',
    homeStoresBody: 'Uygulama yayınlandığında mağaza bağlantıları burada olacak.',
    homePoliciesTitle: 'Politikalar ve yardım',
    deleteMailButton: 'Silme talebini e-postayla gönder',
    deleteMailSubject: 'Hesabımı sil',
    notFoundTitle: 'Sayfa bulunamadı',
    notFoundBody: 'Aradığın sayfa mevcut değil.',
    chooseLanguage: 'Dilini seç',
  },
};
