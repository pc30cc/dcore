import { accountDeletionPagePath, interpolate, textDirection, type Locale } from '@app/shared';
import { brand } from './brand';
import { settings } from './settings';

/** Text pages with sections (content/pages.ts). */
export const documentSlugs = ['privacy', 'terms', 'community-guidelines', 'child-safety', 'support'] as const;
export type DocumentSlug = (typeof documentSlugs)[number];

/**
 * The pages the apps open. Their header and footer carry no store or
 * download link, and they link only to each other, so neither store build
 * leads its users to the other store through them.
 */
export const appPageIds = [...documentSlugs, 'delete-account', 'delete-account/verify', 'delete-account/done'] as const;
export type AppPageId = (typeof appPageIds)[number];

/** The landing and download pages: the only ones that show stores. The apps never link them. */
export const publicPageIds = ['', 'download'] as const;
export type PublicPageId = (typeof publicPageIds)[number];

export type PageId = AppPageId | PublicPageId;
export const pageIds: readonly PageId[] = [...publicPageIds, ...appPageIds];

/** The app-facing pages every footer lists. */
export const footerPageIds = [...documentSlugs, 'delete-account'] as const satisfies readonly AppPageId[];
export type FooterPageId = (typeof footerPageIds)[number];

/** Steps of the deletion flow that make no sense on their own: not indexed, not in the sitemap. */
export const unlistedPageIds: readonly PageId[] = ['delete-account/verify', 'delete-account/done'];

export function isAppFacing(id: PageId): id is AppPageId {
  return (appPageIds as readonly string[]).includes(id);
}

export function pagePath(locale: Locale, id: PageId = ''): string {
  return id === '' ? `/${locale}/` : `/${locale}/${id}/`;
}

/** The values every text may use: `{appName}`, `{supportEmail}` and so on. */
export function brandValues(locale: Locale): Record<string, string> {
  return {
    appName: brand.appName,
    supportEmail: brand.legal.supportEmail,
    siteHost: brand.legalDomain,
    deleteAccountPath: accountDeletionPagePath(locale, 'request'),
    supportPath: pagePath(locale, 'support'),
    // Numbers in the locale's own digits (Persian digits in Persian text).
    graceDays: new Intl.NumberFormat(locale).format(settings.deletionGraceDays),
  };
}

export function fill(locale: Locale, template: string): string {
  return interpolate(template, brandValues(locale));
}

export function dir(locale: Locale): 'rtl' | 'ltr' {
  return textDirection(locale);
}
