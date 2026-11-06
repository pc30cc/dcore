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

/** The two stores the Android app ships in. */
export const storeIds = ['play', 'bazaar'] as const;
export type StoreId = (typeof storeIds)[number];

/** An Android application id, as Gradle accepts it. */
const applicationId = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/, 'must be an Android application id');

/**
 * SHA-256 certificate fingerprints, `AA:BB:…` (32 bytes), as the stores show
 * them; one or several per store (a rotated key, an extra signing key).
 * Normalised to upper case.
 */
const sha256Fingerprint = z
  .string()
  .regex(/^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/, 'must be a SHA-256 fingerprint (32 colon-separated hex bytes)')
  .transform((value) => value.toUpperCase());
const fingerprints = z.union([sha256Fingerprint.transform((value) => [value]), z.array(sha256Fingerprint)]);

/** A Google OAuth web client id; empty means not configured. */
const googleClientId = z.union([
  z.literal(''),
  z.string().regex(/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/, 'must be a Google OAuth client id'),
]);

/** Firebase's public client values for one Android app (what google-services.json carries); empty until set up. */
const firebaseClient = z
  .looseObject({
    projectId: z.string(),
    projectNumber: z.string().regex(/^[0-9]*$/, 'must be digits'),
    appId: z.string(),
    apiKey: z.string(),
  })
  .partial();

/** A store listing: where its page is, whether the app is published there, where users manage subscriptions. */
const storeListing = z
  .looseObject({
    listingUrl: httpsUrl.optional(),
    /** Shown on the website only once the app is published there. */
    live: z.boolean().default(false),
    /** The store's subscription centre, for "deleting does not cancel your subscription". */
    subscriptionsUrl: httpsUrl.optional(),
  })
  .refine((store) => !store.live || store.listingUrl !== undefined, {
    message: 'a live store needs listingUrl',
    path: ['listingUrl'],
  });

/** A file inside the brand's own folder: relative, no `..`, an image type the website can serve. */
const brandAssetPath = z
  .string()
  .regex(/^(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9_][A-Za-z0-9_./-]*\.(png|jpe?g|webp)$/, 'must be a relative .png, .jpg or .webp path in the brand folder');

export const brandSchema = z
  .looseObject({
    id: z.string().regex(/^[a-z0-9_][a-z0-9_-]{0,39}$/),
    appName: z.string().min(1).max(30),
    shortName: z.string().min(1).max(12),
    /** The one-line pitch on the website's home page. */
    tagline: localizedText.optional(),
    /** The website's meta description, and what the app is on its home page. */
    description: localizedText.optional(),
    ios: z.looseObject({ bundleId: z.string().min(1) }).optional(),
    android: z
      .looseObject({
        package: z.string().min(1),
        applicationId: z.looseObject({ bazaar: applicationId.optional(), play: applicationId.optional() }).optional(),
        /** The certificates each store signs the app with (Play app signing certificate, the Bazaar key). */
        signingCertSha256: z.looseObject({ bazaar: fingerprints.optional(), play: fingerprints.optional() }).optional(),
        /** Google sign-in's web client id (play build sign-in, the website's deletion page). */
        googleWebClientId: googleClientId.optional(),
        firebase: z.looseObject({ bazaar: firebaseClient.optional(), play: firebaseClient.optional() }).optional(),
      })
      .optional(),
    domains: z.looseObject({
      api: hostname,
      links: hostname,
      legal: hostname,
      realtime: hostname.optional(),
      rtc: hostname.optional(),
      cdn: hostname.optional(),
      admin: hostname.optional(),
    }),
    stores: z.looseObject({ play: storeListing.optional(), bazaar: storeListing.optional() }).optional(),
    legal: z.looseObject({
      privacyUrl: httpsUrl,
      termsUrl: httpsUrl,
      guidelinesUrl: httpsUrl,
      deleteAccountUrl: httpsUrl,
      childSafetyUrl: httpsUrl.optional(),
      supportUrl: httpsUrl.optional(),
      supportEmail: z.email(),
      /** Where security reports go (security.txt); the support address when unset. */
      securityEmail: z.email().optional(),
    }),
    /** The website's product copy. Everything here is shown as written (with `{appName}` filled in). */
    site: z
      .looseObject({
        /** What the app offers, a few short points on the home page. */
        highlights: z.array(z.looseObject({ title: localizedText, body: localizedText })).max(8).default([]),
        /** Screenshots on the home page: files in the brand folder, with their alternative text. */
        screenshots: z.array(z.looseObject({ file: brandAssetPath, alt: localizedText })).max(8).default([]),
      })
      .optional(),
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

const publicStoreSchema = z.object({
  listingUrl: z.string().optional(),
  live: z.boolean(),
  subscriptionsUrl: z.string().optional(),
});

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
    childSafetyUrl: z.string().optional(),
    supportUrl: z.string().optional(),
    supportEmail: z.string(),
  }),
  /** The stores the brand is configured for; `live` once published there. */
  stores: z.partialRecord(z.enum(storeIds), publicStoreSchema),
  legalDomain: z.string(),
  apiDomain: z.string(),
  defaultLocale: localeSchema,
  locales: z.array(localeSchema),
});

export type PublicBrand = z.infer<typeof publicBrandSchema>;
export type PublicStore = z.infer<typeof publicStoreSchema>;

export function toPublicBrand(brand: Brand): PublicBrand {
  const stores: PublicBrand['stores'] = {};
  for (const id of storeIds) {
    const store = brand.stores?.[id];
    if (!store) continue;
    stores[id] = {
      live: store.live,
      ...(store.listingUrl === undefined ? {} : { listingUrl: store.listingUrl }),
      ...(store.subscriptionsUrl === undefined ? {} : { subscriptionsUrl: store.subscriptionsUrl }),
    };
  }
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
      ...(brand.legal.childSafetyUrl === undefined ? {} : { childSafetyUrl: brand.legal.childSafetyUrl }),
      ...(brand.legal.supportUrl === undefined ? {} : { supportUrl: brand.legal.supportUrl }),
      supportEmail: brand.legal.supportEmail,
    },
    stores,
    legalDomain: brand.domains.legal,
    apiDomain: brand.domains.api,
    defaultLocale: brand.defaultLocale,
    locales: [...brand.locales],
  };
}

/** The application id a store's build is published under: `android.applicationId.<store>`, else `android.package`. */
export function androidApplicationId(brand: Brand, store: StoreId): string | undefined {
  return brand.android?.applicationId?.[store] ?? brand.android?.package;
}
