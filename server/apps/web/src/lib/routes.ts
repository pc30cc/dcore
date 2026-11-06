import type { Locale } from '@app/shared';
import { brand } from './brand';
import { appPageIds, pageIds, pagePath, unlistedPageIds, type PageId } from './i18n';

/** Every page the site builds in every brand locale. */
export function allPaths(): string[] {
  return brand.locales.flatMap((locale: Locale) => pageIds.map((id) => pagePath(locale, id)));
}

/** The pages search engines are given (the sitemap). */
export function listedPaths(): string[] {
  return brand.locales.flatMap((locale: Locale) => pageIds.filter((id) => !unlistedPageIds.includes(id)).map((id) => pagePath(locale, id)));
}

/**
 * Paths without a language that must still work: `/privacy/` and the like,
 * and the exact URLs the stores and the apps were given (brand.legal), which
 * may use other names (`/guidelines`). Each one forwards to the page in the
 * visitor's language.
 */
export function unlocalizedRedirects(): { path: string; id: PageId }[] {
  const out = new Map<string, PageId>();
  for (const id of [...appPageIds, 'download'] as const) {
    if (!(id as string).includes('/')) out.set(id, id);
  }
  const fromBrand: [string | undefined, PageId][] = [
    [brand.legal.privacyUrl, 'privacy'],
    [brand.legal.termsUrl, 'terms'],
    [brand.legal.guidelinesUrl, 'community-guidelines'],
    [brand.legal.childSafetyUrl, 'child-safety'],
    [brand.legal.supportUrl, 'support'],
    [brand.legal.deleteAccountUrl, 'delete-account'],
  ];
  for (const [url, id] of fromBrand) {
    if (url === undefined) continue;
    const parsed = new URL(url);
    if (parsed.hostname !== brand.legalDomain) continue;
    const path = parsed.pathname.replace(/^\/+|\/+$/g, '');
    if (path === '' || path === '.well-known' || path.startsWith('.well-known/')) continue;
    if (brand.locales.some((locale) => path === locale || path.startsWith(`${locale}/`))) continue;
    out.set(path, id);
  }
  return [...out].map(([path, id]) => ({ path, id }));
}
