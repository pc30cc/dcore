import { z } from 'zod';
import { originsSettingsSchema } from './api/origins.js';
import { welcomeOverrideSchema } from './brand.js';
import { localeSchema } from './locale.js';

/**
 * The typed keys of `app_config` (panel-editable settings). The database
 * keeps only JSON; every process parses the rows with these schemas when it
 * loads them into memory, so a bad value is refused once, at load time,
 * instead of on a request path. Keys use the SQL store words
 * (`cafe_bazaar`, `google_play`).
 */

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();
const hex32 = z.string().regex(/^[0-9a-f]{64}$/, 'must be 32 bytes in lowercase hex');

const versionPair = z.strictObject({ required: nonNegativeInt, recommended: nonNegativeInt }).refine(
  (v) => v.recommended >= v.required,
  'recommended must not be below required',
);

/** SMS providers the API can route a number to. */
export const smsProviders = ['kavenegar', 'smsir', 'telnyx', 'fake'] as const;
export type SmsProviderName = (typeof smsProviders)[number];

const e164Prefix = z.string().regex(/^\+[1-9][0-9]{0,5}$/, 'must be + and a country or area prefix');

export const appConfigSchemas = {
  'app.maintenance': z.strictObject({
    enabled: z.boolean(),
    /** The text shown, per locale. */
    message: z.partialRecord(localeSchema, z.string().max(500)),
  }),
  'app.min_version': z.strictObject({ cafe_bazaar: versionPair, google_play: versionPair }),
  'auth.otp': z.strictObject({
    length: z.number().int().min(4).max(8),
    ttl_seconds: z.number().int().min(60).max(900),
    max_attempts: z.number().int().min(1).max(10),
  }),
  'auth.access_token_ttl_seconds': z.number().int().min(60).max(3_600),
  'auth.session_idle_days': z.number().int().min(1).max(365),
  /** Test accounts (store review, QA) that sign in with a fixed code: keyed hashes only, never a number or a code. */
  'auth.review_accounts': z.array(z.strictObject({ phone_hash: hex32, otp_hash: hex32 })).max(50),
  /**
   * Which SMS providers serve a number, by its longest matching prefix, in
   * order of preference (the next one is tried when one is down). A number
   * no route matches uses `default`; an empty `default` refuses it
   * (`phone_not_allowed`).
   */
  'auth.sms_routing': z
    .strictObject({
      routes: z.array(z.strictObject({ prefix: e164Prefix, providers: z.array(z.enum(smsProviders)).min(1) })).max(300),
      default: z.array(z.enum(smsProviders)),
    })
    .refine((r) => new Set(r.routes.map((route) => route.prefix)).size === r.routes.length, 'a prefix is listed twice'),
  /**
   * OTP pumping caps (fail closed): the resend wait and daily count per
   * number, per IP (an IPv6 /56) per hour, per install per day, and per
   * country prefix per hour (`default` for prefixes not listed).
   */
  'auth.otp_caps': z.strictObject({
    resend_seconds: z.number().int().min(10).max(3_600),
    phone_daily: z.number().int().min(1).max(100),
    ip_hourly: z.number().int().min(1).max(10_000),
    install_daily: z.number().int().min(1).max(100),
    verify_ip_hourly: z.number().int().min(1).max(10_000),
    prefix_hourly: z.record(z.union([z.literal('default'), e164Prefix]), positiveInt).refine(
      (caps) => caps['default'] !== undefined,
      'prefix_hourly needs a default',
    ),
  }),
  'onboarding.waitlist': z.strictObject({ enabled: z.boolean() }),
  /** The text versions a person must have accepted; a higher one asks everyone again. */
  'legal.versions': z.strictObject({ terms: positiveInt, privacy: positiveInt, guidelines: positiveInt }),
  'deck.weights': z.record(z.string().regex(/^[a-z]+$/), z.number().min(0).max(10)),
  'deck.refill': z.strictObject({
    queue_size: positiveInt,
    refill_below: nonNegativeInt,
    fetch_limit: positiveInt,
    max_idle_days: positiveInt,
    idle_steps: z.array(positiveInt).min(1),
  }),
  'deck.pass_return_days': positiveInt,
  'likes.window_days': positiveInt,
  'likes.bucket_cap': positiveInt,
  'chat.max_body_chars': z.number().int().min(1).max(10_000),
  'requests.resend_after_days': positiveInt,
  'retention.deleted_account_days': z.number().int().min(1).max(365),
  'retention.verification_media_days': positiveInt,
  'retention.message_requests_days': positiveInt,
  'retention.unsent_body_hours': positiveInt,
  'retention.report_evidence_days': positiveInt,
  /** Days after an unmatch before its messages, media and calls are purged (the match row stays). */
  'retention.unmatched_messages_days': z.number().int().min(1).max(90),
  'safety.child_safety_contact': z.strictObject({ name: z.string().nullable(), email: z.email().nullable() }),
  'calls.enabled': z.strictObject({ audio: z.boolean(), video: z.boolean() }),
  'billing.cross_store_entitlements': z.boolean(),
  /** The hosts of the signed origins document (`GET /v1/origins`); null until the panel saves them. */
  'origins.hosts': originsSettingsSchema.nullable(),
  /** The panel's overrides of brand.json's `welcome` (texts per locale, colours, picture URLs). */
  'brand.welcome': welcomeOverrideSchema,
} as const;

export type AppConfigKey = keyof typeof appConfigSchemas;
export type AppConfigValue<K extends AppConfigKey> = z.output<(typeof appConfigSchemas)[K]>;
export type AppConfig = { [K in AppConfigKey]: AppConfigValue<K> };
export const appConfigKeys = Object.keys(appConfigSchemas) as AppConfigKey[];

export function isAppConfigKey(key: string): key is AppConfigKey {
  return Object.hasOwn(appConfigSchemas, key);
}

/** Parses one row's value; throws a zod error naming the key. */
export function parseAppConfigValue<K extends AppConfigKey>(key: K, value: unknown): AppConfigValue<K> {
  const result = appConfigSchemas[key].safeParse(value);
  if (!result.success) {
    throw new Error(`app_config ${key}: ${result.error.issues.map((i) => `${i.path.join('.') || '(value)'} ${i.message}`).join('; ')}`);
  }
  return result.data as AppConfigValue<K>;
}

/**
 * Parses a whole set of rows. Unknown keys are returned apart (a newer panel
 * may write keys this build does not know); a known key that does not parse,
 * or one that is missing, throws.
 */
export function parseAppConfig(rows: Iterable<{ key: string; value: unknown }>): { config: AppConfig; unknown: string[] } {
  const config: Partial<Record<AppConfigKey, unknown>> = {};
  const unknown: string[] = [];
  for (const { key, value } of rows) {
    if (isAppConfigKey(key)) config[key] = parseAppConfigValue(key, value);
    else unknown.push(key);
  }
  const missing = appConfigKeys.filter((key) => !(key in config));
  if (missing.length > 0) throw new Error(`app_config is missing ${missing.join(', ')}`);
  return { config: config as AppConfig, unknown };
}

/** The SMS providers for a number: the longest matching route, else the default. */
export function smsProvidersFor(routing: AppConfig['auth.sms_routing'], e164: string): readonly SmsProviderName[] {
  let best: { prefix: string; providers: readonly SmsProviderName[] } | undefined;
  for (const route of routing.routes) {
    if (e164.startsWith(route.prefix) && (best === undefined || route.prefix.length > best.prefix.length)) best = route;
  }
  return best?.providers ?? routing.default;
}

/** The hourly OTP cap of a number's prefix: the longest listed prefix, else `default`. */
export function otpPrefixCap(caps: AppConfig['auth.otp_caps'], e164: string): { prefix: string; cap: number } {
  let best: { prefix: string; cap: number } | undefined;
  for (const [prefix, cap] of Object.entries(caps.prefix_hourly)) {
    if (prefix === 'default') continue;
    if (e164.startsWith(prefix) && (best === undefined || prefix.length > best.prefix.length)) best = { prefix, cap };
  }
  return best ?? { prefix: 'default', cap: caps.prefix_hourly['default'] ?? 0 };
}
