import { baseEnvShape, databaseEnvShape, envBoolean, envInt, envList, parseEnv, redisEnvShape, storageConfigOf, storageEnvShape, type Env, type StorageConfig } from '@app/config';
import { parseKeyRing } from '@app/shared/server';
import { z } from 'zod';

/**
 * The API's configuration, read from the environment once at start-up. No
 * secret has a default: a missing key stops the process with the variable's
 * name (see .env.example).
 */

const originSchema = z.url({ protocol: /^https?$/ }).refine((value) => new URL(value).origin === value, {
  message: 'must be a bare origin such as https://admin.example.com (no path, no trailing slash)',
});

const base64urlSecret = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, 'must be base64url')
  .refine((value) => value.length >= 43, 'must encode at least 32 bytes (43 base64url characters)');

/** 32 bytes, base64url (43 characters, no padding). */
const key32 = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'must be 32 bytes in base64url (43 characters)');

/** `{"1": "<base64url 32 bytes>"}`: keys by id, so new ones can be added. */
const keyRing = (name: string) =>
  z.string().superRefine((value, ctx) => {
    try {
      parseKeyRing(value, name);
    } catch (error) {
      // The message names the problem, never a key.
      ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'not a key ring' });
    }
  });

const pem = (label: 'PUBLIC KEY' | 'PRIVATE KEY') =>
  z
    .string()
    // Environment files often carry PEM with literal \n.
    .transform((value) => value.replaceAll('\\n', '\n').trim())
    .refine((value) => value.startsWith(`-----BEGIN ${label}-----`), `must be a PEM "${label}"`);

const envSchema = z
  .object({
    ...baseEnvShape,
    ...databaseEnvShape,
    ...redisEnvShape,
    ...storageEnvShape,
    HOST: z.string().default('0.0.0.0'),
    PORT: envInt(8080, { min: 1, max: 65_535 }),
    DATABASE_APPLICATION_NAME: z.string().min(1).max(63).default('api'),

    /** Hops or CIDRs whose X-Forwarded-For is believed; `false` believes no one. */
    TRUST_PROXY: z.string().default('false'),
    BODY_LIMIT_BYTES: envInt(1_048_576, { min: 1_024, max: 50 * 1_048_576 }),
    /** The admin panel's origins; nothing else gets CORS. Empty: CORS is off. */
    CORS_ADMIN_ORIGINS: envList().pipe(z.array(originSchema)),

    RATE_LIMIT_MAX: envInt(300, { min: 1 }),
    RATE_LIMIT_WINDOW_MS: envInt(60_000, { min: 1_000 }),

    OPENAPI_ENABLED: envBoolean(true),

    READINESS_TIMEOUT_MS: envInt(1_000, { min: 50, max: 10_000 }),
    /** Probes inside this window share one check, so a busy probe costs the database nothing extra. */
    READINESS_CACHE_MS: envInt(1_000, { min: 0, max: 60_000 }),
    /** After SIGTERM, /readyz answers 503 for this long before the server stops accepting requests. */
    SHUTDOWN_DRAIN_MS: envInt(0, { min: 0, max: 60_000 }),
    /** In-flight requests get this long to finish; then the process exits anyway. */
    SHUTDOWN_TIMEOUT_MS: envInt(15_000, { min: 1_000, max: 120_000 }),

    AUTH_JWT_ALG: z.enum(['EdDSA', 'HS256']).default('EdDSA'),
    AUTH_JWT_ISSUER: z.string().min(1),
    AUTH_ACCESS_TOKEN_TTL_SECONDS: envInt(900, { min: 60, max: 3_600 }),
    AUTH_CLOCK_SKEW_SECONDS: envInt(30, { min: 0, max: 300 }),
    /** Names the signing key in each token's header, so keys can rotate. */
    AUTH_JWT_KID: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).default('k1'),
    AUTH_JWT_PRIVATE_KEY: pem('PRIVATE KEY').optional(),
    AUTH_JWT_PUBLIC_KEY: pem('PUBLIC KEY').optional(),
    AUTH_JWT_SECRET: base64urlSecret.optional(),
    /** The previous key during a rotation: still accepted, never used to sign. */
    AUTH_JWT_PREVIOUS_KID: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional(),
    AUTH_JWT_PREVIOUS_PUBLIC_KEY: pem('PUBLIC KEY').optional(),
    AUTH_JWT_PREVIOUS_SECRET: base64urlSecret.optional(),

    /** Feistel keys of public user ids (k1) and billing references (k2). Never rotated: every public id would change. */
    ID_PUBLIC_KEY: key32,
    ID_BILLING_KEY: key32,
    /** Peppers of the keyed hashes (phones, Google subs, device keys), by id; HASH_PEPPER_KID hashes new values. */
    HASH_PEPPERS: keyRing('HASH_PEPPERS'),
    HASH_PEPPER_KID: envInt(1, { min: 1, max: 255 }),
    /** Master keys of sealed values (phone numbers, TOTP and provider secrets), by id; DATA_KEY_ID seals new ones. */
    DATA_KEYS: keyRing('DATA_KEYS'),
    DATA_KEY_ID: envInt(1, { min: 1, max: 255 }),
    /** Which edges are Cloudflare's: empty for the published ranges, `off`, a list, or `file:<path>`. */
    CF_EDGE_TRUST: z.string().default(''),
    /** Statement budgets: `enforce` in tests, `count` to see them, `off` in production. */
    PG_BUDGET: z.enum(['off', 'count', 'enforce']).optional(),

    /** The brand served (brands/<id>/brand.json); the template is refused in production. */
    BRAND: z.string().regex(/^[a-z0-9_][a-z0-9_-]{0,39}$/).default('_template'),
    /** Where the brands folder is; found by walking up from the working directory when unset. */
    BRANDS_DIR: z.string().min(1).optional(),
    /** Centrifugo connection tokens (HS256, the secret Centrifugo verifies them with); required in production. */
    CENTRIFUGO_TOKEN_HMAC_SECRET: z.string().min(32).optional(),
    /** The WebSocket URL apps connect to; default wss://<domains.realtime>/connection/websocket. */
    CENTRIFUGO_WS_URL: z.url({ protocol: /^wss?$/ }).optional(),
    REALTIME_TOKEN_TTL_SECONDS: envInt(3_600, { min: 300, max: 86_400 }),

    /** The OAuth web client id Google ID tokens must be issued for (play sign-in); unset: Google sign-in is off. */
    GOOGLE_WEB_CLIENT_ID: z.string().regex(/^[0-9A-Za-z._-]{10,200}$/).optional(),
    /** SMS providers (app_config `auth.sms_routing` picks them per number); a provider without its key is not used. */
    SMS_KAVENEGAR_API_KEY: z.string().min(8).optional(),
    SMS_KAVENEGAR_TEMPLATE: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
    SMS_SMSIR_API_KEY: z.string().min(8).optional(),
    SMS_SMSIR_TEMPLATE_ID: envInt(undefined, { min: 1 }).optional(),
    SMS_SMSIR_PARAMETER: z.string().regex(/^[A-Za-z0-9_]{1,40}$/).default('CODE'),
    SMS_TELNYX_API_KEY: z.string().min(8).optional(),
    SMS_TELNYX_VERIFY_PROFILE_ID: z.string().regex(/^[A-Za-z0-9-]{8,64}$/).optional(),
    SMS_TIMEOUT_MS: envInt(5_000, { min: 500, max: 30_000 }),
    /** The `fake` provider: `log` writes codes to the log (development), `memory` keeps them (tests), `off`. Never on in production. */
    SMS_FAKE: z.enum(['off', 'log', 'memory']).optional(),
    /** The website's origin: where the deletion forms are sent back to, and the only CORS origin of those routes; default https://<domains.legal>. */
    SITE_ORIGIN: originSchema.optional(),
  })
  .superRefine((env, ctx) => {
    const need = (key: keyof typeof env, why: string): void => {
      if (env[key] === undefined) ctx.addIssue({ code: 'custom', path: [key], message: `required ${why}` });
    };
    if (env.AUTH_JWT_ALG === 'EdDSA') {
      need('AUTH_JWT_PRIVATE_KEY', 'when AUTH_JWT_ALG is EdDSA');
      need('AUTH_JWT_PUBLIC_KEY', 'when AUTH_JWT_ALG is EdDSA');
      if (env.AUTH_JWT_PREVIOUS_KID) need('AUTH_JWT_PREVIOUS_PUBLIC_KEY', 'with AUTH_JWT_PREVIOUS_KID');
    } else {
      need('AUTH_JWT_SECRET', 'when AUTH_JWT_ALG is HS256');
      if (env.AUTH_JWT_PREVIOUS_KID) need('AUTH_JWT_PREVIOUS_SECRET', 'with AUTH_JWT_PREVIOUS_KID');
    }
    if (env.ID_PUBLIC_KEY === env.ID_BILLING_KEY) {
      ctx.addIssue({ code: 'custom', path: ['ID_BILLING_KEY'], message: 'must differ from ID_PUBLIC_KEY' });
    }
    if (env.PG_BUDGET === 'enforce' && env.NODE_ENV === 'production') {
      ctx.addIssue({ code: 'custom', path: ['PG_BUDGET'], message: 'enforce refuses statements: tests only' });
    }
    if (env.AUTH_JWT_PREVIOUS_KID !== undefined && env.AUTH_JWT_PREVIOUS_KID === env.AUTH_JWT_KID) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_JWT_PREVIOUS_KID'], message: 'must differ from AUTH_JWT_KID' });
    }
    if (env.NODE_ENV === 'production' && env.BRAND === '_template') {
      ctx.addIssue({ code: 'custom', path: ['BRAND'], message: 'the template brand is not served in production' });
    }
    if (env.NODE_ENV === 'production') need('CENTRIFUGO_TOKEN_HMAC_SECRET', 'in production');
    if (env.SMS_KAVENEGAR_API_KEY !== undefined) need('SMS_KAVENEGAR_TEMPLATE', 'with SMS_KAVENEGAR_API_KEY');
    if (env.SMS_SMSIR_API_KEY !== undefined) need('SMS_SMSIR_TEMPLATE_ID', 'with SMS_SMSIR_API_KEY');
    if (env.SMS_TELNYX_API_KEY !== undefined) need('SMS_TELNYX_VERIFY_PROFILE_ID', 'with SMS_TELNYX_API_KEY');
    if (env.NODE_ENV === 'production' && env.SMS_FAKE !== undefined && env.SMS_FAKE !== 'off') {
      ctx.addIssue({ code: 'custom', path: ['SMS_FAKE'], message: 'the fake SMS provider is never used in production' });
    }
    if (env.NODE_ENV === 'production' && env.LOG_PRETTY) {
      ctx.addIssue({ code: 'custom', path: ['LOG_PRETTY'], message: 'must be off in production (logs are JSON lines)' });
    }
  });

export type ApiEnv = z.output<typeof envSchema>;

/** Every variable this process reads; .env.example lists each one (a test compares them). */
export const envVariables: readonly string[] = Object.keys(envSchema.shape);

/** Fastify's trustProxy: none, all, the nearest N hops, or these addresses/CIDRs. */
export type TrustProxy = boolean | string[] | ((address: string, hop: number) => boolean);

export interface SigningKeyConfig {
  kid: string;
  /** PEM (EdDSA) or base64url secret (HS256). */
  privateKey?: string | undefined;
  publicKey?: string | undefined;
  secret?: string | undefined;
}

export interface ApiConfig {
  env: ApiEnv['NODE_ENV'];
  host: string;
  port: number;
  log: { level: ApiEnv['LOG_LEVEL']; pretty: boolean };
  trustProxy: TrustProxy;
  bodyLimitBytes: number;
  corsAdminOrigins: string[];
  database: {
    url: string;
    target: ApiEnv['DATABASE_TARGET'];
    applicationName: string;
    poolMax: number;
    statementTimeoutMs: number;
    idleInTransactionTimeoutMs: number;
    connectTimeoutMs: number;
  };
  /** kv-core, and kv-cache (`cacheUrl`, undefined: the same instance). */
  redis: { url: string; cacheUrl: string | undefined; keyPrefix: string };
  rateLimit: { max: number; windowMs: number };
  openapi: { enabled: boolean };
  readiness: { timeoutMs: number; cacheMs: number };
  shutdown: { drainMs: number; timeoutMs: number };
  auth: {
    alg: ApiEnv['AUTH_JWT_ALG'];
    issuer: string;
    accessTokenTtlSeconds: number;
    clockSkewSeconds: number;
    current: SigningKeyConfig;
    previous?: SigningKeyConfig | undefined;
  };
  ids: { publicKey: string; billingKey: string };
  secrets: { hashPeppers: string; hashPepperKid: number; dataKeys: string; dataKeyId: number };
  edgeTrust: string;
  pgBudget: 'off' | 'count' | 'enforce';
  brand: { id: string; dir: string | undefined };
  realtime: { tokenSecret: string | undefined; wsUrl: string | undefined; tokenTtlSeconds: number };
  google: { webClientId: string | undefined };
  sms: {
    kavenegar: { apiKey: string; template: string } | undefined;
    smsir: { apiKey: string; templateId: number; parameter: string } | undefined;
    telnyx: { apiKey: string; verifyProfileId: string } | undefined;
    timeoutMs: number;
    fake: 'off' | 'log' | 'memory';
  };
  /** Object storage and the CDN of photos; undefined without S3_* (the photo routes answer 503). */
  storage: StorageConfig | undefined;
  /** The website's origin (account deletion without signing in); undefined: https://<the brand's domains.legal>. */
  siteOrigin: string | undefined;
}

function parseTrustProxy(value: string): TrustProxy {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'false' || trimmed === '') return false;
  if (trimmed === 'true') return true;
  if (/^\d+$/.test(trimmed)) {
    const hops = Number(trimmed);
    // proxy-addr counts hops from the socket outwards, starting at 0.
    return (_address, hop) => hop < hops;
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig(source: Env = process.env): ApiConfig {
  const env = parseEnv(envSchema, source);
  return {
    env: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    log: { level: env.LOG_LEVEL, pretty: env.LOG_PRETTY },
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    bodyLimitBytes: env.BODY_LIMIT_BYTES,
    corsAdminOrigins: env.CORS_ADMIN_ORIGINS,
    database: {
      url: env.DATABASE_URL,
      target: env.DATABASE_TARGET,
      applicationName: env.DATABASE_APPLICATION_NAME,
      poolMax: env.DATABASE_POOL_MAX,
      statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
      idleInTransactionTimeoutMs: env.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      connectTimeoutMs: env.DATABASE_CONNECT_TIMEOUT_MS,
    },
    redis: { url: env.REDIS_URL, cacheUrl: env.REDIS_CACHE_URL, keyPrefix: env.REDIS_KEY_PREFIX },
    rateLimit: { max: env.RATE_LIMIT_MAX, windowMs: env.RATE_LIMIT_WINDOW_MS },
    openapi: { enabled: env.OPENAPI_ENABLED },
    readiness: { timeoutMs: env.READINESS_TIMEOUT_MS, cacheMs: env.READINESS_CACHE_MS },
    shutdown: { drainMs: env.SHUTDOWN_DRAIN_MS, timeoutMs: env.SHUTDOWN_TIMEOUT_MS },
    auth: {
      alg: env.AUTH_JWT_ALG,
      issuer: env.AUTH_JWT_ISSUER,
      accessTokenTtlSeconds: env.AUTH_ACCESS_TOKEN_TTL_SECONDS,
      clockSkewSeconds: env.AUTH_CLOCK_SKEW_SECONDS,
      current: {
        kid: env.AUTH_JWT_KID,
        privateKey: env.AUTH_JWT_PRIVATE_KEY,
        publicKey: env.AUTH_JWT_PUBLIC_KEY,
        secret: env.AUTH_JWT_SECRET,
      },
      previous: env.AUTH_JWT_PREVIOUS_KID
        ? {
            kid: env.AUTH_JWT_PREVIOUS_KID,
            publicKey: env.AUTH_JWT_PREVIOUS_PUBLIC_KEY,
            secret: env.AUTH_JWT_PREVIOUS_SECRET,
          }
        : undefined,
    },
    ids: { publicKey: env.ID_PUBLIC_KEY, billingKey: env.ID_BILLING_KEY },
    secrets: {
      hashPeppers: env.HASH_PEPPERS,
      hashPepperKid: env.HASH_PEPPER_KID,
      dataKeys: env.DATA_KEYS,
      dataKeyId: env.DATA_KEY_ID,
    },
    edgeTrust: env.CF_EDGE_TRUST,
    pgBudget: env.PG_BUDGET ?? (env.NODE_ENV === 'test' ? 'enforce' : 'off'),
    brand: { id: env.BRAND, dir: env.BRANDS_DIR },
    realtime: {
      tokenSecret: env.CENTRIFUGO_TOKEN_HMAC_SECRET,
      wsUrl: env.CENTRIFUGO_WS_URL,
      tokenTtlSeconds: env.REALTIME_TOKEN_TTL_SECONDS,
    },
    google: { webClientId: env.GOOGLE_WEB_CLIENT_ID },
    sms: {
      kavenegar:
        env.SMS_KAVENEGAR_API_KEY && env.SMS_KAVENEGAR_TEMPLATE
          ? { apiKey: env.SMS_KAVENEGAR_API_KEY, template: env.SMS_KAVENEGAR_TEMPLATE }
          : undefined,
      smsir:
        env.SMS_SMSIR_API_KEY && env.SMS_SMSIR_TEMPLATE_ID !== undefined
          ? { apiKey: env.SMS_SMSIR_API_KEY, templateId: env.SMS_SMSIR_TEMPLATE_ID, parameter: env.SMS_SMSIR_PARAMETER }
          : undefined,
      telnyx:
        env.SMS_TELNYX_API_KEY && env.SMS_TELNYX_VERIFY_PROFILE_ID
          ? { apiKey: env.SMS_TELNYX_API_KEY, verifyProfileId: env.SMS_TELNYX_VERIFY_PROFILE_ID }
          : undefined,
      timeoutMs: env.SMS_TIMEOUT_MS,
      fake: env.SMS_FAKE ?? (env.NODE_ENV === 'production' ? 'off' : env.NODE_ENV === 'test' ? 'memory' : 'log'),
    },
    storage: storageConfigOf(env),
    siteOrigin: env.SITE_ORIGIN,
  };
}
