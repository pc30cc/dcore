import type { Locale } from '@app/shared';
import { brand } from './brand';
import { pagePath, pageSlugs, type PageSlug } from './i18n';

/** Every page the site builds, for the sitemap and the tests. */
export function allPaths(): string[] {
  return brand.locales.flatMap((locale: Locale) => [pagePath(locale), ...pageSlugs.map((slug) => pagePath(locale, slug))]);
}

/**
 * Paths without a language that must still work: `/privacy/` and the like,
 * and the exact URLs the stores were given (brand.legal), which may use other
 * names (`/guidelines`). Each one forwards to the page in the visitor's language.
 */
export function unlocalizedRedirects(): { path: string; slug: PageSlug }[] {
  const out = new Map<string, PageSlug>(pageSlugs.map((slug) => [slug, slug]));
  const fromBrand: [string, PageSlug][] = [
    [brand.legal.privacyUrl, 'privacy'],
    [brand.legal.termsUrl, 'terms'],
    [brand.legal.guidelinesUrl, 'community-guidelines'],
    [brand.legal.deleteAccountUrl, 'delete-account'],
  ];
  for (const [url, slug] of fromBrand) {
    const parsed = new URL(url);
    if (parsed.hostname !== brand.legalDomain) continue;
    const path = parsed.pathname.replace(/^\/+|\/+$/g, '');
    if (path === '' || brand.locales.some((locale) => path === locale || path.startsWith(`${locale}/`))) continue;
    out.set(path, slug);
  }
  return [...out].map(([path, slug]) => ({ path, slug }));
}
