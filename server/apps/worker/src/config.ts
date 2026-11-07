import { hostname } from 'node:os';
import {
  baseEnvShape,
  databaseEnvShape,
  envBoolean,
  envInt,
  envUrl,
  parseEnv,
  redisEnvShape,
  storageConfigOf,
  storageEnvShape,
  type Env,
  type StorageConfig,
} from '@app/config';
import { queuePrefix } from '@app/shared/server';
import { z } from 'zod';

/** 32 bytes, base64url (43 characters, no padding). */
const key32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'must be 32 bytes in base64url (43 characters)');

const envSchema = z
  .object({
    ...baseEnvShape,
    ...databaseEnvShape,
    ...redisEnvShape,
    ...storageEnvShape,
    /** Jobs run longer statements than requests; the role's own timeout (30 s in production) still applies. */
    DATABASE_STATEMENT_TIMEOUT_MS: envInt(30_000, { min: 0, max: 600_000 }),
    DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: envInt(30_000, { min: 0, max: 600_000 }),
    DATABASE_APPLICATION_NAME: z.string().min(1).max(63).default('worker'),
    /** Names this process in Redis (stream consumer names, BullMQ worker names). Stable across restarts. */
    WORKER_ID: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/)
      .optional(),
    /** Jobs each queue runs at once in this process, unless the queue sets its own. */
    WORKER_CONCURRENCY: envInt(4, { min: 1, max: 256 }),
    /** In-flight jobs get this long to finish on SIGTERM; then the process exits anyway. */
    SHUTDOWN_TIMEOUT_MS: envInt(30_000, { min: 1_000, max: 600_000 }),
    /** The same Feistel keys as the API's: realtime channels are named by the public user id. */
    ID_PUBLIC_KEY: key32,
    ID_BILLING_KEY: key32,
    /** Centrifugo's server API (publishing to users' channels); required in production. */
    CENTRIFUGO_API_URL: envUrl(['http', 'https']).optional(),
    CENTRIFUGO_API_KEY: z.string().min(16).optional(),
    /** Automatic photo moderation: `fake` until a provider is chosen. */
    MODERATION_PROVIDER: z.enum(['fake']).default('fake'),
    /** The fake provider approves every photo (development); off, photos wait for a human. Never on in production. */
    PHOTO_AUTO_APPROVE: z.enum(['true', 'false']).optional(),
    /** Photos processed at once by this process (each decodes a full-size image). */
    PHOTO_CONCURRENCY: envInt(2, { min: 1, max: 32 }),
    /** Pixels a photo may have before it is refused undecoded. */
    PHOTO_MAX_PIXELS: envInt(50_000_000, { min: 1_000_000, max: 268_402_689 }),
    /** Runs the periodic maintenance jobs (partitions, active drain, sessions clean-up). */
    MAINT_ENABLED: envBoolean(true),
  })
  .superRefine((env, ctx) => {
    if (env.ID_PUBLIC_KEY === env.ID_BILLING_KEY) {
      ctx.addIssue({ code: 'custom', path: ['ID_BILLING_KEY'], message: 'must differ from ID_PUBLIC_KEY' });
    }
    if ((env.CENTRIFUGO_API_URL === undefined) !== (env.CENTRIFUGO_API_KEY === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['CENTRIFUGO_API_KEY'], message: 'CENTRIFUGO_API_URL and CENTRIFUGO_API_KEY come together' });
    }
    if (env.NODE_ENV === 'production') {
      if (env.CENTRIFUGO_API_URL === undefined) ctx.addIssue({ code: 'custom', path: ['CENTRIFUGO_API_URL'], message: 'required in production' });
      if (env.PHOTO_AUTO_APPROVE === 'true') {
        ctx.addIssue({ code: 'custom', path: ['PHOTO_AUTO_APPROVE'], message: 'photos are never approved unseen in production' });
      }
      if (env.LOG_PRETTY) ctx.addIssue({ code: 'custom', path: ['LOG_PRETTY'], message: 'must be off in production (logs are JSON lines)' });
    }
  });

export type WorkerEnv = z.output<typeof envSchema>;

/** Every variable this process reads; .env.example lists each one (a test compares them). */
export const envVariables: readonly string[] = Object.keys(envSchema.shape);

export interface WorkerConfig {
  env: WorkerEnv['NODE_ENV'];
  log: { level: WorkerEnv['LOG_LEVEL']; pretty: boolean };
  workerId: string;
  /** kv-core, and kv-cache (`cacheUrl`, undefined: the same instance). */
  redis: { url: string; cacheUrl: string | undefined; keyPrefix: string };
  /** BullMQ's key prefix, derived from REDIS_KEY_PREFIX (`app:` gives `app:bull`). */
  queuePrefix: string;
  concurrency: number;
  shutdownTimeoutMs: number;
  database: {
    url: string;
    target: WorkerEnv['DATABASE_TARGET'];
    applicationName: string;
    poolMax: number;
    statementTimeoutMs: number;
    idleInTransactionTimeoutMs: number;
    connectTimeoutMs: number;
  };
  ids: { publicKey: string; billingKey: string };
  /** Undefined without S3_*: photo jobs then wait and retry. */
  storage: StorageConfig | undefined;
  realtime: { apiUrl: string; apiKey: string } | undefined;
  photos: { provider: WorkerEnv['MODERATION_PROVIDER']; autoApprove: boolean; concurrency: number; maxPixels: number };
  maint: { enabled: boolean };
}

export function loadConfig(source: Env = process.env): WorkerConfig {
  const env = parseEnv(envSchema, source);
  return {
    env: env.NODE_ENV,
    log: { level: env.LOG_LEVEL, pretty: env.LOG_PRETTY },
    workerId: env.WORKER_ID ?? `${hostname().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 48)}-${process.pid}`,
    redis: { url: env.REDIS_URL, cacheUrl: env.REDIS_CACHE_URL, keyPrefix: env.REDIS_KEY_PREFIX },
    queuePrefix: queuePrefix(env.REDIS_KEY_PREFIX),
    concurrency: env.WORKER_CONCURRENCY,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    database: {
      url: env.DATABASE_URL,
      target: env.DATABASE_TARGET,
      applicationName: env.DATABASE_APPLICATION_NAME,
      poolMax: env.DATABASE_POOL_MAX,
      statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
      idleInTransactionTimeoutMs: env.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      connectTimeoutMs: env.DATABASE_CONNECT_TIMEOUT_MS,
    },
    ids: { publicKey: env.ID_PUBLIC_KEY, billingKey: env.ID_BILLING_KEY },
    storage: storageConfigOf(env),
    realtime: env.CENTRIFUGO_API_URL && env.CENTRIFUGO_API_KEY ? { apiUrl: env.CENTRIFUGO_API_URL, apiKey: env.CENTRIFUGO_API_KEY } : undefined,
    photos: {
      provider: env.MODERATION_PROVIDER,
      autoApprove: env.PHOTO_AUTO_APPROVE !== undefined ? env.PHOTO_AUTO_APPROVE === 'true' : env.NODE_ENV === 'development',
      concurrency: env.PHOTO_CONCURRENCY,
      maxPixels: env.PHOTO_MAX_PIXELS,
    },
    maint: { enabled: env.MAINT_ENABLED },
  };
}
