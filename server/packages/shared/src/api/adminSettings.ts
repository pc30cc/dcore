import { z } from 'zod';
import type { AppConfigKey } from '../appConfig.js';
import { gender, photoStatus, profileReviewState } from '../codes.js';
import { localeSchema } from '../locale.js';
import { pageQuerySchema, pageSchema } from '../pagination.js';
import { permissions, type Permission } from '../permissions.js';
import { adminProfilePromptSchema, adminRefSchema, adminUserRefSchema, sideEffectsSchema } from './adminUsers.js';
import { httpUrl, idSchema, timeSchema } from './common.js';

/**
 * The admin panel's app settings (`/v1/admin/config`), brand
 * (`/v1/admin/brand`), providers (`/v1/admin/providers`) and new-profile
 * review queue (`/v1/admin/moderation/profiles`, `/v1/admin/users/{id}/
 * {approve,reject,needs-changes}`).
 *
 * Every settings read carries a `version` (a hash of what is stored); a
 * write names the version its form was built from (`baseVersion`) and is
 * refused with 409 `settings_changed` when the stored value moved meanwhile.
 * Provider secrets are write-only: a read shows each one only as a
 * fingerprint (the first 12 hex digits of its SHA-256; for a service
 * account, of its private key).
 */

/** 22 characters of base64url: the first 16 bytes of the SHA-256 of the stored value. */
export const settingsVersionSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

// ─── App settings ─────────────────────────────────────────────────────────

/**
 * The app_config keys the panel reads and writes, each with the permission
 * a write needs (`null`: shown, never written here). Reading any of them
 * needs `config.read`. A write of a key under `config.providers` or
 * `config.legal` also needs a second factor while one is required.
 */
export const adminConfigKeys = {
  'app.min_version': { write: 'config.write' },
  'app.maintenance': { write: 'config.write' },
  'onboarding.waitlist': { write: 'config.write' },
  'calls.enabled': { write: 'config.write' },
  'signup.countries': { write: 'config.write' },
  'limits.rates': { write: 'config.write' },
  /** Read-only: the website states the length its build carries. */
  'retention.deleted_account_days': { write: null },
  'retention.message_requests_days': { write: 'config.legal' },
  'retention.unsent_body_hours': { write: 'config.legal' },
  'retention.report_evidence_days': { write: 'config.legal' },
  'retention.unmatched_messages_days': { write: 'config.legal' },
  'legal.versions': { write: 'config.legal' },
  'safety.child_safety_contact': { write: 'config.legal' },
  'auth.sms_routing': { write: 'config.providers' },
} as const satisfies Partial<Record<AppConfigKey, { write: Permission | null }>>;

export type AdminConfigKey = keyof typeof adminConfigKeys;
export const adminConfigKeyList = Object.keys(adminConfigKeys) as AdminConfigKey[];
export const adminConfigKeySchema = z.enum(adminConfigKeyList as [AdminConfigKey, ...AdminConfigKey[]]);

export function isAdminConfigKey(key: string): key is AdminConfigKey {
  return Object.hasOwn(adminConfigKeys, key);
}

/** The permission a write of `key` needs (null: not written by the panel). */
export function adminConfigWritePermission(key: AdminConfigKey): Permission | null {
  return adminConfigKeys[key].write;
}

/** Whether a write of `key` needs a second factor (while the deployment requires one). */
export function adminConfigNeedsMfa(key: AdminConfigKey): boolean {
  const write = adminConfigKeys[key].write;
  return write === 'config.providers' || write === 'config.legal';
}

/** The panel's bounds beyond the stored schema (422 `out_of_range`, `version_lowered`). */
export const ADMIN_CONFIG_BOUNDS = {
  /** Google Play's largest versionCode. */
  versionCodeMax: 2_100_000_000,
  retention: {
    'retention.deleted_account_days': { min: 7, max: 365 },
    'retention.message_requests_days': { min: 1, max: 365 },
    'retention.unsent_body_hours': { min: 1, max: 168 },
    'retention.report_evidence_days': { min: 30, max: 3_650 },
    'retention.unmatched_messages_days': { min: 1, max: 90 },
  },
  legalVersionMax: 1_000,
  contactNameMax: 100,
  limits: {
    swipes_per_hour: { min: 60, max: 1_200 },
    messages_per_minute: { min: 10, max: 120 },
    messages_per_conversation: { min: 5, max: 40 },
    /** Never below the shipped 10: reporting is a safety path. */
    reports_per_day: { min: 10, max: 50 },
  },
} as const;

export const adminConfigQuerySchema = z.object({
  /** A comma list of keys (each one of `adminConfigKeys`, at most 30); absent: every key. */
  keys: z.string().max(1_000).optional(),
});

export const adminConfigItemSchema = z.object({
  key: adminConfigKeySchema,
  value: z.unknown(),
  version: settingsVersionSchema,
  /** The permission a write needs; null: read-only here. */
  write: z.enum(permissions as [Permission, ...Permission[]]).nullable(),
  updatedAt: timeSchema.nullable(),
  updatedBy: adminRefSchema.nullable(),
});
export type AdminConfigItem = z.infer<typeof adminConfigItemSchema>;
export const adminConfigListSchema = z.object({ items: z.array(adminConfigItemSchema) });
export type AdminConfigList = z.infer<typeof adminConfigListSchema>;

export const adminConfigParamsSchema = z.object({ key: z.string().min(1).max(100) });
export const adminConfigUpdateSchema = z.strictObject({ value: z.unknown(), baseVersion: settingsVersionSchema });
export type AdminConfigUpdate = z.infer<typeof adminConfigUpdateSchema>;
export const adminConfigResultSchema = z.object({ item: adminConfigItemSchema });

// ─── Brand ────────────────────────────────────────────────────────────────

/** The run-time brand values: brand.json's, unless the panel saved its own. */
export const brandValueKeys = ['appName', 'supportEmail', 'privacyUrl', 'termsUrl', 'guidelinesUrl', 'childSafetyUrl', 'deleteAccountUrl'] as const;
export type BrandValueKey = (typeof brandValueKeys)[number];
export const BRAND_APP_NAME_MAX = 30;
export const BRAND_URL_MAX = 500;
export const BRAND_WELCOME_IMAGES_MAX = 16;

const httpsUrl = z.url({ protocol: /^https$/ }).max(BRAND_URL_MAX);
const themed = z.object({ light: z.string(), dark: z.string() });

/**
 * Refused in an app name: placeholder braces, control characters, and the
 * invisible format characters (bidi controls, word joiners, the BOM), but
 * never ZWNJ or ZWJ, which Persian words need (U+200C, U+200D).
 */
export const BRAND_APP_NAME_REFUSED = /[{}\p{Cc}]|(?![\u200c\u200d])\p{Cf}/u;

/** Whether `name` (trimmed) may be the run-time app name. */
export function brandAppNameValid(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && [...trimmed].length <= BRAND_APP_NAME_MAX && !BRAND_APP_NAME_REFUSED.test(trimmed);
}

/** The legal values, which the privacy policy and the stores name: a change needs `config.legal` (and the second factor). */
export const brandLegalKeys = ['supportEmail', 'privacyUrl', 'termsUrl', 'guidelinesUrl', 'childSafetyUrl', 'deleteAccountUrl'] as const;
export type BrandLegalKey = (typeof brandLegalKeys)[number];

/** Whether `url` is an https address on one of `hosts` (exactly). */
export function brandUrlOnHosts(url: string, hosts: readonly string[]): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && hosts.includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Whether `url` is served from `origin` (a welcome picture: the deployment's media origin only). */
export function brandUrlFromOrigin(url: string, origin: string | null): boolean {
  if (!origin) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

export const adminBrandValuesSchema = z.object({
  appName: z.string(),
  supportEmail: z.string(),
  privacyUrl: z.string(),
  termsUrl: z.string(),
  guidelinesUrl: z.string(),
  childSafetyUrl: z.string(),
  deleteAccountUrl: z.string(),
});
export type AdminBrandValues = z.infer<typeof adminBrandValuesSchema>;

export const adminBrandSchema = z.object({
  version: settingsVersionSchema,
  /** brand.json's id (BRAND). */
  brandId: z.string(),
  /** brand.json's values. */
  build: adminBrandValuesSchema,
  /** The panel's values; a key absent is brand.json's. */
  saved: adminBrandValuesSchema.partial(),
  /** The welcome pictures (empty: the app's own). */
  welcomeImages: z.array(z.string()),
  /** The hosts a legal link may be on: brand.json's domains and the hosts of its own links. */
  linkHosts: z.array(z.string()),
  /** The only origin a welcome picture may come from (the deployment's media CDN). */
  mediaOrigin: z.string().nullable(),
  /** Built into the app (read-only). */
  colors: z.object({ brand: themed, onBrand: themed }),
  fonts: z.object({ latin: z.string(), persian: z.string() }),
  updatedAt: timeSchema.nullable(),
  updatedBy: adminRefSchema.nullable(),
});
export type AdminBrand = z.infer<typeof adminBrandSchema>;

/** `null`: brand.json's value. */
export const adminBrandUpdateSchema = z.strictObject({
  baseVersion: settingsVersionSchema,
  appName: z.string().max(BRAND_APP_NAME_MAX).nullable(),
  supportEmail: z.email().max(254).nullable(),
  privacyUrl: httpsUrl.nullable(),
  termsUrl: httpsUrl.nullable(),
  guidelinesUrl: httpsUrl.nullable(),
  childSafetyUrl: httpsUrl.nullable(),
  deleteAccountUrl: httpsUrl.nullable(),
  welcomeImages: z.array(httpsUrl).max(BRAND_WELCOME_IMAGES_MAX),
});
export type AdminBrandUpdate = z.infer<typeof adminBrandUpdateSchema>;

// ─── Providers ────────────────────────────────────────────────────────────

/** The providers the panel may set (RTC/TURN has its own route). */
export const providerKinds = ['kavenegar', 'smsir', 'telnyx', 'play', 'bazaar', 'fcm'] as const;
export type ProviderKind = (typeof providerKinds)[number];
export const providerKindSchema = z.enum(providerKinds);

/** Where a provider's settings come from in a process. */
export const providerSources = ['panel', 'off', 'unreadable', 'env', 'none'] as const;
export type ProviderSource = (typeof providerSources)[number];
export const providerSourceSchema = z.enum(providerSources);

const packageName = z
  .string()
  .max(255)
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/);
const noSpace = (min: number, max: number) => z.string().min(min).max(max).regex(/^\S+$/);

/** The non-secret settings of each kind (what a read shows in clear). */
export const providerSettingsSchemas = {
  kavenegar: z.strictObject({ template: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }),
  smsir: z.strictObject({ templateId: z.number().int().min(1).max(2_147_483_647), parameter: z.string().regex(/^[A-Za-z0-9_]{1,40}$/) }),
  telnyx: z.strictObject({ verifyProfileId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/) }),
  play: z.strictObject({
    packageName,
    /** The OIDC audience of the RTDN push subscription; with the e-mail, or neither. */
    rtdnAudience: z.string().min(8).max(500).nullable(),
    rtdnPushServiceAccountEmail: z.email().max(254).nullable(),
  }),
  bazaar: z.strictObject({
    packageName,
    /** The app's RSA public key (base64 X.509 DER, as Pishkhan shows it). Public, so shown. */
    rsaPublicKey: z.string().regex(/^[A-Za-z0-9+/]{100,2000}={0,2}$/),
    auth: z.enum(['pishkhan', 'oauth']),
    clientId: z.string().min(4).max(200).nullable(),
  }),
  fcm: z.strictObject({ projectId: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/).nullable() }),
} as const satisfies Record<ProviderKind, z.ZodType>;

/** The secret fields of each kind (write-only). */
export const providerSecretSchemas = {
  kavenegar: z.strictObject({ apiKey: noSpace(8, 200) }),
  smsir: z.strictObject({ apiKey: noSpace(8, 200) }),
  telnyx: z.strictObject({ apiKey: noSpace(8, 300) }),
  play: z.strictObject({ serviceAccountJson: z.string().min(2).max(20_000) }),
  bazaar: z.strictObject({ pishkhanToken: noSpace(8, 500), clientSecret: noSpace(8, 500), refreshToken: noSpace(8, 2_000) }).partial(),
  fcm: z.strictObject({ serviceAccountJson: z.string().min(2).max(20_000) }),
} as const satisfies Record<ProviderKind, z.ZodType>;

export const providerSecretFields = {
  kavenegar: ['apiKey'],
  smsir: ['apiKey'],
  telnyx: ['apiKey'],
  play: ['serviceAccountJson'],
  bazaar: ['pishkhanToken', 'clientSecret', 'refreshToken'],
  fcm: ['serviceAccountJson'],
} as const satisfies Record<ProviderKind, readonly string[]>;

const providerUpdate = <K extends ProviderKind>(kind: K) =>
  z.strictObject({
    kind: z.literal(kind),
    baseVersion: settingsVersionSchema,
    enabled: z.boolean(),
    settings: providerSettingsSchemas[kind],
    /** Only the secrets typed now; a stored one not sent is kept. */
    secrets: providerSecretSchemas[kind].partial().optional(),
  });

export const adminProviderUpdateSchema = z.discriminatedUnion('kind', [
  providerUpdate('kavenegar'),
  providerUpdate('smsir'),
  providerUpdate('telnyx'),
  providerUpdate('play'),
  providerUpdate('bazaar'),
  providerUpdate('fcm'),
]);
export type AdminProviderUpdate = z.infer<typeof adminProviderUpdateSchema>;
export const adminProviderParamsSchema = z.object({ kind: providerKindSchema });
export const adminProviderDeleteSchema = z.strictObject({ baseVersion: settingsVersionSchema });

/** A secret as a read shows it: whether it is there, and its fingerprint. */
export const secretViewSchema = z.object({
  set: z.boolean(),
  fingerprint: z.string().regex(/^[0-9a-f]{12}$/).nullable(),
  /** Stored, but it cannot be opened with this deployment's keys (PROVIDER_KEYS changed): save it again. */
  unreadable: z.boolean(),
});
export type SecretView = z.infer<typeof secretViewSchema>;

const settingsView = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));
const accountView = z.object({ clientEmail: z.string(), projectId: z.string().optional() });

export const providerAppliedSchema = z.object({
  process: z.enum(['api', 'worker']),
  /** The host or worker name. */
  name: z.string(),
  source: providerSourceSchema,
  /** Of the provider's main secret, as that process uses it. */
  fingerprint: z.string().regex(/^[0-9a-f]{12}$/).nullable(),
  at: timeSchema,
});
export type ProviderApplied = z.infer<typeof providerAppliedSchema>;

export const adminProviderSchema = z.object({
  kind: providerKindSchema,
  /** What this API process uses now. */
  source: providerSourceSchema,
  version: settingsVersionSchema,
  updatedAt: timeSchema.nullable(),
  updatedBy: adminRefSchema.nullable(),
  /** The panel's entry; null: none (the deployment's values apply). */
  panel: z
    .object({
      enabled: z.boolean(),
      settings: settingsView,
      secrets: z.record(z.string(), secretViewSchema),
      account: accountView.optional(),
    })
    .nullable(),
  /** The deployment's values (`known` false: this process does not carry them, as FCM in the API). */
  env: z.object({
    known: z.boolean(),
    set: z.boolean(),
    settings: settingsView.optional(),
    secrets: z.record(z.string(), secretViewSchema).optional(),
    account: accountView.optional(),
  }),
  /** What each running process reported it applied. */
  applied: z.array(providerAppliedSchema),
});
export type AdminProvider = z.infer<typeof adminProviderSchema>;

export const adminProvidersReadOnlySchema = z.object({
  storage: z.object({
    configured: z.boolean(),
    endpoint: z.string().nullable(),
    region: z.string().nullable(),
    privateBucket: z.string().nullable(),
    mediaBucket: z.string().nullable(),
    pathStyle: z.boolean().nullable(),
    accessKeyId: secretViewSchema,
    secretAccessKey: secretViewSchema,
    cdn: z.object({ baseUrl: z.string(), scheme: z.string(), signingKey: secretViewSchema }).nullable(),
  }),
  livekit: z.object({
    configured: z.boolean(),
    apiUrl: z.string().nullable(),
    apiKey: z.string().nullable(),
    apiSecret: secretViewSchema,
    identitySecret: secretViewSchema,
  }),
  /** From the workers' reports; `autoApprove` null: no worker reported. */
  moderation: z.object({ provider: z.string(), autoApprove: z.boolean().nullable() }),
});

export const adminProvidersSchema = z.object({
  items: z.array(adminProviderSchema),
  readOnly: adminProvidersReadOnlySchema,
  /** False when the processes' reports could not be read (Valkey). */
  appliedKnown: z.boolean(),
});
export type AdminProviders = z.infer<typeof adminProvidersSchema>;

/** Provider writes an admin may make in an hour. */
export const PROVIDER_WRITES_PER_HOUR = 60;

// ─── New-profile review ───────────────────────────────────────────────────

export const PROFILE_REVIEW_TEXT_MAX = 1_000;
export const PROFILE_REVIEW_NOTE_MAX = 500;

export const adminProfileReviewQuerySchema = pageQuerySchema.extend({
  /** `waiting` (the queue, oldest first), `needs_changes` (sent back), `rejected`. */
  state: profileReviewState.schema.default('waiting'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const adminProfileReviewItemSchema = z.object({
  user: adminUserRefSchema.extend({
    age: z.number().int().nullable(),
    gender: gender.schema.nullable(),
    country: z.string().nullable(),
    verified: z.boolean(),
  }),
  /** The person's language: a message to them is written in it. */
  locale: localeSchema,
  signedUpAt: timeSchema,
  state: profileReviewState.schema,
  /** When the profile was sent for review (again, after changes). */
  submittedAt: timeSchema,
  /** Decisions so far (needs-changes rounds and a rejection). */
  rounds: z.number().int().nonnegative(),
  about: z.string().nullable(),
  job: z.string().nullable(),
  prompts: z.array(adminProfilePromptSchema),
  photos: z.array(z.object({ id: idSchema, position: z.number().int(), status: photoStatus.schema, thumbUrl: httpUrl.optional() })),
  /** The last decision (needs changes or rejected); null while it waits the first time. Kept after the person sends it again. */
  decision: z
    .object({
      kind: z.enum(['needs_changes', 'rejected']),
      reasonText: z.string(),
      decidedAt: timeSchema,
      decidedBy: adminRefSchema.nullable(),
    })
    .nullable(),
});
export type AdminProfileReviewItem = z.infer<typeof adminProfileReviewItemSchema>;
export const adminProfileReviewPageSchema = pageSchema(adminProfileReviewItemSchema);

const reasonText = z.string().trim().min(1).max(PROFILE_REVIEW_TEXT_MAX);
const note = z.string().trim().max(PROFILE_REVIEW_NOTE_MAX).optional();

/** `from`: the review state the admin saw; another one now is a 409 `stale`. */
export const adminProfileApproveSchema = z.strictObject({ from: profileReviewState.schema, note });
/** `reasonText`: what the person reads, in their language. */
export const adminProfileRejectSchema = z.strictObject({ from: profileReviewState.schema, reasonText, note });
export const adminProfileNeedsChangesSchema = adminProfileRejectSchema;

export const adminProfileDecisionSchema = z.object({
  user: adminUserRefSchema,
  /** `approved`: the account is active and listable now. */
  review: z.union([z.literal('approved'), profileReviewState.schema]),
  sideEffects: sideEffectsSchema,
});
export type AdminProfileDecision = z.infer<typeof adminProfileDecisionSchema>;
