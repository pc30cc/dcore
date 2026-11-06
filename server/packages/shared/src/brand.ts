import { z } from 'zod';
import { localeSchema } from './locale.js';

/**
 * The shape of `brands/<id>/brand.json`. No brand name, colour or domain is
 * written in code: build tools and the API read it from here. Objects are
 * loose so a platform can add its own keys (store-specific settings, say)
 * without a schema change here; the keys listed are the ones code relies on.
 */
const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'must be #RRGGBB');
const themedColor = z.object({ light: hexColor, dark: hexColor });
const hostname = z
  .string()
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'must be a lowercase host name');
const httpsUrl = z.url({ protocol: /^https$/ });
/** A short text per locale; a locale may be missing (the default locale's is used). */
const localizedText = z.partialRecord(localeSchema, z.string().min(1));

export const brandSchema = z
  .looseObject({
    id: z.string().regex(/^[a-z0-9_][a-z0-9_-]{0,39}$/),
    appName: z.string().min(1).max(30),
    shortName: z.string().min(1).max(12),
    /** The one-line pitch on the website's home page. */
    tagline: localizedText.optional(),
    /** The website's meta description. */
    description: localizedText.optional(),
    ios: z.looseObject({ bundleId: z.string().min(1) }).optional(),
    android: z.looseObject({ package: z.string().min(1) }).optional(),
    domains: z.looseObject({ api: hostname, links: hostname, legal: hostname }),
    legal: z.looseObject({
      privacyUrl: httpsUrl,
      termsUrl: httpsUrl,
      guidelinesUrl: httpsUrl,
      deleteAccountUrl: httpsUrl,
      supportEmail: z.email(),
    }),
    colors: z.looseObject({ brand: themedColor, onBrand: themedColor }),
    fonts: z.looseObject({ latin: z.string().min(1), persian: z.string().min(1) }),
    planNames: z.record(z.string(), z.partialRecord(localeSchema, z.string().min(1))).optional(),
    defaultLocale: localeSchema,
    locales: z.array(localeSchema).min(1),
  })
  .refine((brand) => brand.locales.includes(brand.defaultLocale), {
    message: 'defaultLocale must be one of locales',
    path: ['defaultLocale'],
  });

export type Brand = z.infer<typeof brandSchema>;

/** What a browser, the website or the app may see of a brand. */
export const publicBrandSchema = z.object({
  id: z.string(),
  appName: z.string(),
  shortName: z.string(),
  tagline: z.partialRecord(localeSchema, z.string()),
  description: z.partialRecord(localeSchema, z.string()),
  colors: z.object({ brand: themedColor, onBrand: themedColor }),
  fonts: z.object({ latin: z.string(), persian: z.string() }),
  legal: z.object({
    privacyUrl: z.string(),
    termsUrl: z.string(),
    guidelinesUrl: z.string(),
    deleteAccountUrl: z.string(),
    supportEmail: z.string(),
  }),
  legalDomain: z.string(),
  defaultLocale: localeSchema,
  locales: z.array(localeSchema),
});

export type PublicBrand = z.infer<typeof publicBrandSchema>;

export function toPublicBrand(brand: Brand): PublicBrand {
  return {
    id: brand.id,
    appName: brand.appName,
    shortName: brand.shortName,
    tagline: { ...brand.tagline },
    description: { ...brand.description },
    colors: { brand: brand.colors.brand, onBrand: brand.colors.onBrand },
    fonts: { latin: brand.fonts.latin, persian: brand.fonts.persian },
    legal: {
      privacyUrl: brand.legal.privacyUrl,
      termsUrl: brand.legal.termsUrl,
      guidelinesUrl: brand.legal.guidelinesUrl,
      deleteAccountUrl: brand.legal.deleteAccountUrl,
      supportEmail: brand.legal.supportEmail,
    },
    legalDomain: brand.domains.legal,
    defaultLocale: brand.defaultLocale,
    locales: [...brand.locales],
  };
}
