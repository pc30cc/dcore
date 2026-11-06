import { findBrandsDir, loadBrand } from '@app/config';
import { toPublicBrand, type Locale, type PublicBrand } from '@app/shared';

/**
 * The brand this site is built for (BRAND=<id>; the neutral template when
 * unset). Read once per build; an invalid brand.json fails the build.
 */
export const brand: PublicBrand = toPublicBrand(loadBrand({ brandsDir: findBrandsDir(process.cwd()) }));

/** The site's origin, from the brand's legal domain. */
export const siteOrigin = `https://${brand.legalDomain}`;

/**
 * A per-locale brand text (`tagline`, `description`) in `locale`, else in the
 * brand's default locale, else empty.
 */
export function brandCopy(texts: PublicBrand['tagline'], locale: Locale): string {
  return texts[locale] ?? texts[brand.defaultLocale] ?? '';
}
