import { baseEnvShape, databaseEnvShape, envBoolean, envInt, envList, parseEnv, redisEnvShape, type Env } from '@app/config';
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
    if (env.AUTH_JWT_PREVIOUS_KID !== undefined && env.AUTH_JWT_PREVIOUS_KID === env.AUTH_JWT_KID) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_JWT_PREVIOUS_KID'], message: 'must differ from AUTH_JWT_KID' });
    }
    if (env.NODE_ENV === 'production' && env.LOG_PRETTY) {
      ctx.addIssue({ code: 'custom', path: ['LOG_PRETTY'], message: 'must be off in production (logs are JSON lines)' });
    }
  });

export type ApiEnv = z.output<typeof envSchema>;

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
  redis: { url: string; keyPrefix: string };
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
    redis: { url: env.REDIS_URL, keyPrefix: env.REDIS_KEY_PREFIX },
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
  };
}
