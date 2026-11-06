import { interpolate, textDirection, type Locale } from '@app/shared';
import { brand } from './brand';

export const pageSlugs = [
  'privacy',
  'terms',
  'community-guidelines',
  'child-safety',
  'delete-account',
  'support',
] as const;
export type PageSlug = (typeof pageSlugs)[number];

/** The values every text may use: `{appName}`, `{supportEmail}` and so on. */
export function brandValues(locale: Locale): Record<string, string> {
  return {
    appName: brand.appName,
    supportEmail: brand.legal.supportEmail,
    siteHost: brand.legalDomain,
    deleteAccountPath: `/${locale}/delete-account/`,
  };
}

export function fill(locale: Locale, template: string): string {
  return interpolate(template, brandValues(locale));
}

export function dir(locale: Locale): 'rtl' | 'ltr' {
  return textDirection(locale);
}

export function pagePath(locale: Locale, slug?: PageSlug): string {
  return slug ? `/${locale}/${slug}/` : `/${locale}/`;
}
