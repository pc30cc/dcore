import path from 'node:path';
import { findBrandsDir, loadBrand } from '@app/config';
import { toPublicBrand, type Brand, type Locale, type PublicBrand } from '@app/shared';

/**
 * The brand this site is built for (BRAND=<id>; the neutral template when
 * unset), from the repository's `brands/` folder or from BRANDS_DIR. Read once
 * per build; an invalid brand.json fails the build.
 */
const brandsDir = process.env['BRANDS_DIR'] ? path.resolve(process.env['BRANDS_DIR']) : findBrandsDir(process.cwd());

/** The whole brand.json, for what only the build needs (store packages, signing certificates, site copy). */
export const brandConfig: Brand = loadBrand({ brandsDir });

/** What the pages show of the brand. */
export const brand: PublicBrand = toPublicBrand(brandConfig);

/** The brand's own folder, where its images are. */
export const brandDir = path.join(brandsDir, brandConfig.id);

/** The site's origin, from the brand's legal domain. */
export const siteOrigin = `https://${brand.legalDomain}`;

/**
 * A per-locale brand text (`tagline`, `description`, site copy) in `locale`,
 * else in the brand's default locale, else empty.
 */
export function brandCopy(texts: Partial<Record<Locale, string>> | undefined, locale: Locale): string {
  return texts?.[locale] ?? texts?.[brand.defaultLocale] ?? '';
}
