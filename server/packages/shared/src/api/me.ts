import { z } from 'zod';
import { consentKind, legalConsentKinds } from '../codes.js';
import {
  accountStatusSchema,
  appStoreNameSchema,
  citySchema,
  countrySchema,
  dateSchema,
  filtersSchema,
  genderSchema,
  idSchema,
  intentionSchema,
  moderationActionSchema,
  notificationPrefsSchema,
  ownProfileSchema,
  preferencesSchema,
  publicUidSchema,
  settingsSchema,
  timeSchema,
} from './common.js';
import { authUserSchema } from './auth.js';

/** The account itself: `/v1/me` and the own-profile edits. */

export const legalConsentKindSchema = z.enum(legalConsentKinds);
export const consentKindSchema = consentKind.schema;

/** Where the account is, as far as anyone is told: a city and a country, never a position. */
export const accountLocationSchema = z.object({
  city: citySchema.pick({ id: true, name: true }).optional(),
  country: countrySchema.optional(),
  travel: z.object({ city: citySchema.pick({ id: true, name: true }), until: timeSchema }).optional(),
});

/**
 * `GET /v1/me` (restricted sessions included). A deleted account in its
 * grace period gets the minimal form: `id`, `status` and `deletion`.
 * `moderation` holds the active warnings, suspensions and bans; a shadowban
 * never appears.
 */
export const meSchema = z.object({
  id: publicUidSchema,
  status: accountStatusSchema,
  onboardingStep: z.number().int().min(0).max(50).optional(),
  /** The store of the session (`st`), which entitlements follow. */
  store: appStoreNameSchema.optional(),
  /** What purchases are bound to (Play `obfuscatedAccountId`, Bazaar developer payload). */
  billingRef: publicUidSchema.optional(),
  /** Absent until onboarding has created the profile. */
  profile: ownProfileSchema.optional(),
  preferences: preferencesSchema.optional(),
  location: accountLocationSchema.optional(),
  notifications: notificationPrefsSchema.optional(),
  flags: z.record(z.string(), z.boolean()).optional(),
  moderation: z.array(moderationActionSchema).optional(),
  deletion: z.object({ purgeAt: timeSchema }).optional(),
  /** Legal texts whose current version (`legal.versions`) the person has not accepted. */
  consentsDue: z.array(legalConsentKindSchema).optional(),
});
export type Me = z.infer<typeof meSchema>;

/** `PUT /v1/me/basics`, once, during onboarding. */
export const basicsRequestSchema = z.object({
  birthDate: dateSchema,
  gender: genderSchema,
  /**
   * The text versions the person was shown and accepted. The guidelines may
   * be accepted later, on their own step (`PUT /v1/me/consents/guidelines`).
   */
  consents: z.object({
    terms: z.number().int().positive(),
    privacy: z.number().int().positive(),
    guidelines: z.number().int().positive().optional(),
  }),
});
export type BasicsRequest = z.infer<typeof basicsRequestSchema>;

/** A consent as `GET /v1/me/consents` lists it. */
export const consentRecordSchema = z.object({
  kind: consentKindSchema,
  version: z.number().int().positive(),
  acceptedAt: timeSchema,
  withdrawnAt: timeSchema.optional(),
});
export const consentListSchema = z.object({ consents: z.array(consentRecordSchema) });
export const consentParamsSchema = z.object({ kind: consentKindSchema });
export const consentUpdateSchema = z.object({ version: z.number().int().positive(), accepted: z.boolean() });

/** A field edit; with no value set the answer is removed. */
export const fieldEditSchema = z.object({
  fieldId: z.number().int().positive(),
  option: z.number().int().min(1).max(255).optional(),
  options: z.array(z.number().int().min(1).max(255)).max(32).optional(),
  number: z.number().int().optional(),
  text: z.string().max(200).nullable().optional(),
});

/** A prompt in a position; `answer: null` removes the prompt from that position. */
export const promptEditSchema = z.object({
  position: z.number().int().min(0).max(2),
  promptId: z.number().int().positive(),
  answer: z.string().min(1).max(300).nullable(),
});

/** `PATCH /v1/me/profile`: only the fields present change. */
export const profilePatchSchema = z.object({
  displayName: z.string().trim().min(1).max(40).optional(),
  about: z.string().max(500).nullable().optional(),
  jobTitle: z.string().max(80).nullable().optional(),
  intention: intentionSchema.nullable().optional(),
  /** The deck switch (`profiles.mode_match`). */
  modeRomance: z.boolean().optional(),
  onboardingStep: z.number().int().min(0).max(50).optional(),
  fields: z.array(fieldEditSchema).max(64).optional(),
  prompts: z.array(promptEditSchema).max(3).optional(),
});
export type ProfilePatch = z.infer<typeof profilePatchSchema>;

/** `PATCH /v1/me/preferences`; `filters` needs advanced_filters. */
export const preferencesPatchSchema = preferencesSchema
  .partial()
  .extend({ filters: filtersSchema.optional() })
  .refine((p) => p.ageMin === undefined || p.ageMax === undefined || p.ageMin <= p.ageMax, {
    message: 'ageMin must not be above ageMax',
    path: ['ageMin'],
  });
export type PreferencesPatch = z.infer<typeof preferencesPatchSchema>;

/** `PATCH /v1/me/settings`; incognito needs its feature, snoozed pauses discovery. */
export const settingsPatchSchema = settingsSchema.partial();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const notificationPrefsPatchSchema = notificationPrefsSchema.partial();

/**
 * `PUT /v1/me/location`. The position becomes an H3 r7 cell in memory and
 * is never stored or logged. A city picked by hand (`source: "city"`) is
 * sent as its `cityId`, without a position.
 */
export const locationUpdateSchema = z
  .object({
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    accuracyM: z.number().int().nonnegative().max(1_000_000).optional(),
    source: z.enum(['gps', 'city', 'network']),
    cityId: z.number().int().positive().optional(),
  })
  .superRefine((body, ctx) => {
    const hasPosition = body.lat !== undefined && body.lng !== undefined;
    if ((body.lat === undefined) !== (body.lng === undefined)) {
      ctx.addIssue({ code: 'custom', path: [body.lat === undefined ? 'lat' : 'lng'], message: 'lat and lng go together' });
    }
    if (body.source === 'city' && body.cityId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['cityId'], message: 'a city location needs cityId' });
    }
    if (body.source !== 'city' && !hasPosition) {
      ctx.addIssue({ code: 'custom', path: ['lat'], message: 'a gps or network location needs lat and lng' });
    }
  });
export type LocationUpdate = z.infer<typeof locationUpdateSchema>;

export const locationResultSchema = z.object({
  city: citySchema.pick({ id: true, name: true }).optional(),
  country: countrySchema,
});

export const citiesQuerySchema = z.object({
  q: z.string().trim().min(1).max(80),
  country: countrySchema.optional(),
});
export const cityListSchema = z.object({ items: z.array(citySchema) });

/** `GET /v1/me/moderation`: shadowbans never appear. */
export const moderationHistorySchema = z.object({
  active: z.array(moderationActionSchema),
  history: z.array(moderationActionSchema),
});

/** `POST /v1/appeals`. */
export const appealRequestSchema = z.object({
  /** The moderation action appealed against. */
  actionId: idSchema,
  body: z.string().trim().min(1).max(2000),
});
export const appealBodySchema = z.object({ appeal: moderationActionSchema.shape.appeal.unwrap() });

/** `POST /v1/me/restore` (restore scope). */
export const restoredAccountSchema = z.object({ user: authUserSchema });
