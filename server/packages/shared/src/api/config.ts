import { z } from 'zod';
import { localeSchema } from '../locale.js';
import { templateIdSchema } from '../templates.js';
import { appStoreNameSchema, httpUrl } from './common.js';

/**
 * `GET /v1/config?store=&locale=`: what every client reads before anyone
 * signs in. Cacheable at the edge (ETag = `cfg:v`), so it carries nothing per
 * user; per-user switches are `GET /v1/me` `flags`.
 */
export const configQuerySchema = z.object({
  store: appStoreNameSchema,
  locale: localeSchema,
});
export type ConfigQuery = z.infer<typeof configQuerySchema>;

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const themedColor = z.object({ light: hexColor, dark: hexColor });

/** The legal text versions a person must have accepted (app_config `legal.versions`). */
export const legalVersionsSchema = z.object({
  terms: z.number().int().positive(),
  privacy: z.number().int().positive(),
  guidelines: z.number().int().positive(),
});
export type LegalVersions = z.infer<typeof legalVersionsSchema>;

export const fieldDefSchema = z.object({
  id: z.number().int().positive(),
  key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  label: z.string(),
  kind: z.enum(['single', 'multi', 'text', 'number', 'country']),
  options: z.array(z.object({ id: z.number().int().min(1).max(255), label: z.string() })).optional(),
  min: z.number().int().optional(),
  max: z.number().int().optional(),
  unit: z.string().optional(),
  /** Shown to its holder only. */
  private: z.boolean(),
  /** Usable as an advanced filter. */
  filterable: z.boolean(),
  /** A special category: stored only with the `sensitive_fields` consent. */
  sensitive: z.boolean(),
  /** Must be answered before the profile counts as complete. */
  required: z.boolean(),
});
export type FieldDef = z.infer<typeof fieldDefSchema>;

export const promptDefSchema = z.object({
  id: z.number().int().positive(),
  text: z.string(),
  /** `voice` for a prompt answered with a recording. */
  category: z.string().optional(),
});

/** A labelled choice from a catalogue list (intentions, report reasons, deletion reasons). */
export const catalogEntrySchema = z.object({ key: z.string().min(1), label: z.string() });

/**
 * The signed-out welcome, in the requested locale only: the panel's text
 * when it set one, else brand.json's (`{appName}` and the headline's
 * `*emphasis*` left for the app). A missing text falls back, in the app, to
 * the brand's default locale and then to its own strings. `images` are the
 * panel's picture URLs; empty: the pictures the app ships.
 */
export const welcomeConfigSchema = z.object({
  eyebrow: z.string().min(1).max(60).optional(),
  headline: z.string().min(1).max(160).optional(),
  subtitle: z.string().min(1).max(400).optional(),
  gradient: z.object({ top: hexColor, middle: hexColor, bottom: hexColor }).optional(),
  images: z.array(z.url({ protocol: /^https$/ })).max(16),
});
export type WelcomeConfig = z.infer<typeof welcomeConfigSchema>;

/**
 * The visual templates the panel offers, in display order, and its default
 * (always among them). Ids are strings: an app shows a template it does not
 * ship as the default, and the default it does not ship as `neon`.
 */
export const uiConfigSchema = z
  .object({
    defaultTemplate: templateIdSchema,
    templates: z.array(templateIdSchema).min(1),
  })
  .refine((ui) => ui.templates.includes(ui.defaultTemplate), { message: 'templates must hold defaultTemplate', path: ['templates'] });
export type UiConfig = z.infer<typeof uiConfigSchema>;

export const configSchema = z.object({
  /** The document's version counter (`cfg:v`). */
  v: z.number().int().nonnegative(),
  /** What `{appName}` stands for. */
  appName: z.string().min(1),
  colors: z.object({ brand: themedColor, onBrand: themedColor }).optional(),
  legal: z.object({
    privacyUrl: httpUrl,
    termsUrl: httpUrl,
    guidelinesUrl: httpUrl,
    childSafetyUrl: httpUrl,
    deleteAccountUrl: httpUrl,
    supportEmail: z.email(),
    versions: legalVersionsSchema,
  }),
  /** Plan key (`plus`, `premium`) to its name in the requested language. */
  planNames: z.record(z.string(), z.string()),
  /** Version codes of the store in the query: below `required` the app cannot be used. */
  minVersion: z.object({ required: z.number().int().nonnegative(), recommended: z.number().int().nonnegative() }),
  maintenance: z.object({ enabled: z.boolean(), message: z.string().optional() }),
  auth: z.object({
    otpLength: z.number().int().min(4).max(8),
    methods: z.array(z.enum(['phone', 'google'])).min(1),
  }),
  catalog: z.object({
    fields: z.array(fieldDefSchema),
    prompts: z.array(promptDefSchema),
    intentions: z.array(catalogEntrySchema),
    reportReasons: z.array(catalogEntrySchema),
    deletionReasons: z.array(catalogEntrySchema),
  }),
  limits: z.object({
    photosMax: z.number().int().positive(),
    photosMin: z.number().int().nonnegative(),
    promptsMax: z.number().int().nonnegative(),
    aboutMax: z.number().int().positive(),
    messageMax: z.number().int().positive(),
    commentMax: z.number().int().positive(),
  }),
  calls: z.object({ audio: z.boolean(), video: z.boolean() }),
  /** Text overrides from the admin panel, this locale only; the app ships its own strings. */
  strings: z.record(z.string(), z.string()),
  /** Absent when neither brand.json nor the panel sets a welcome. */
  welcome: welcomeConfigSchema.optional(),
  ui: uiConfigSchema,
});
export type Config = z.infer<typeof configSchema>;
