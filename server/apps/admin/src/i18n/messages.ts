import type { Locale } from '@app/shared';
import { en as appEn } from './locales/app/en';
import { fa as appFa } from './locales/app/fa';
import { tr as appTr } from './locales/app/tr';
import { en as contentEn } from './locales/content/en';
import { fa as contentFa } from './locales/content/fa';
import { tr as contentTr } from './locales/content/tr';
import { en as dashboardEn } from './locales/dashboard/en';
import { fa as dashboardFa } from './locales/dashboard/fa';
import { tr as dashboardTr } from './locales/dashboard/tr';
import { en as coreEn } from './locales/en';
import { fa as coreFa } from './locales/fa';
import { en as growthEn } from './locales/growth/en';
import { fa as growthFa } from './locales/growth/fa';
import { tr as growthTr } from './locales/growth/tr';
import { en as revenueEn } from './locales/revenue/en';
import { fa as revenueFa } from './locales/revenue/fa';
import { tr as revenueTr } from './locales/revenue/tr';
import { en as supportEn } from './locales/support/en';
import { fa as supportFa } from './locales/support/fa';
import { tr as supportTr } from './locales/support/tr';
import { en as systemEn } from './locales/system/en';
import { fa as systemFa } from './locales/system/fa';
import { tr as systemTr } from './locales/system/tr';
import { tr as coreTr } from './locales/tr';

/**
 * The panel's strings, per language: the core module (`locales/{en,fa,tr}.ts`)
 * and one module per area (`locales/<area>/`), composed into one table per
 * language. A key lives in exactly one module (a test holds it: a spread
 * would let a second definition win silently). English is the reference:
 * every other language has the same keys and placeholders (the i18n test
 * holds them).
 */

/** Every module, by name: `core`, then the areas in the order the composition spreads them. */
export const messageModules = {
  core: { en: coreEn, fa: coreFa, tr: coreTr },
  dashboard: { en: dashboardEn, fa: dashboardFa, tr: dashboardTr },
  content: { en: contentEn, fa: contentFa, tr: contentTr },
  revenue: { en: revenueEn, fa: revenueFa, tr: revenueTr },
  growth: { en: growthEn, fa: growthFa, tr: growthTr },
  app: { en: appEn, fa: appFa, tr: appTr },
  support: { en: supportEn, fa: supportFa, tr: supportTr },
  system: { en: systemEn, fa: systemFa, tr: systemTr },
} as const satisfies Readonly<Record<string, Readonly<Record<Locale, Readonly<Record<string, string>>>>>>;

const en = { ...coreEn, ...dashboardEn, ...contentEn, ...revenueEn, ...growthEn, ...appEn, ...supportEn, ...systemEn };

export type MessageKey = keyof typeof en;
export type Messages = Readonly<Record<MessageKey, string>>;

export const messages: Readonly<Record<Locale, Messages>> = {
  en,
  fa: { ...coreFa, ...dashboardFa, ...contentFa, ...revenueFa, ...growthFa, ...appFa, ...supportFa, ...systemFa },
  tr: { ...coreTr, ...dashboardTr, ...contentTr, ...revenueTr, ...growthTr, ...appTr, ...supportTr, ...systemTr },
};

export const localeNames: Readonly<Record<Locale, string>> = { en: 'English', fa: 'فارسی', tr: 'Türkçe' };
