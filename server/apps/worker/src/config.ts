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
import { parseServiceAccount, queuePrefix, type FcmServiceAccount } from '@app/shared/server';
import { z } from 'zod';
import { parsePublishTargets, type PublishTargetConfig } from './origins/targets.js';

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
    /**
     * Names this process in Redis (stream consumer names, BullMQ worker names). Unset (the default in a
     * deployment): the process takes the lowest free slot of a Valkey lease (`w0`, `w1`, ...), so names stay the
     * same across restarts and two running workers never share one. Set it only for a process run by hand.
     */
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
    /** Firebase Cloud Messaging: the service account (its JSON or the base64 of it); unset: pushes are not sent. Required in production. */
    FCM_SERVICE_ACCOUNT_JSON: z.string().min(2).optional(),
    /** Overrides the service account's project. */
    FCM_PROJECT_ID: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/).optional(),
    /** Runs the write-behind stream consumers (likes, matches) in this process. */
    STREAMS_ENABLED: envBoolean(true),
    /** LiveKit's server API (the room check, deleting a finished call's room); the four come together, as on the API. */
    LIVEKIT_API_URL: envUrl(['http', 'https', 'ws', 'wss']).optional(),
    LIVEKIT_API_KEY: z.string().regex(/^[A-Za-z0-9_-]{3,128}$/).optional(),
    LIVEKIT_API_SECRET: z.string().min(32).optional(),
    /** The API's key of the per-call identities: the room check recognises the two people by it. */
    LIVEKIT_IDENTITY_SECRET: z.string().min(32).optional(),
    /** Publishes the signed origins document to the media bucket (`bootstrap/origins.json`, behind the CDN) when storage is configured. */
    ORIGINS_PUBLISH_MEDIA: envBoolean(true),
    /**
     * More places the origins document is published to, on other hosts and providers (a JSON array): S3-compatible
     * buckets `{"kind":"s3","id","endpoint","region","bucket","key","accessKeyId","secretAccessKey","pathStyle"}` and
     * plain PUT endpoints `{"kind":"put","id","url","headers"}`. Holds credentials: a secret.
     */
    ORIGINS_PUBLISH_TARGETS: z
      .string()
      .optional()
      .superRefine((value, ctx) => {
        if (value === undefined) return;
        try {
          parsePublishTargets(value);
        } catch (error) {
          // The message names the problem, never a value.
          ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'not a list of targets' });
        }
      }),
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
      if (env.FCM_SERVICE_ACCOUNT_JSON === undefined) ctx.addIssue({ code: 'custom', path: ['FCM_SERVICE_ACCOUNT_JSON'], message: 'required in production' });
    }
    const livekit = [env.LIVEKIT_API_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, env.LIVEKIT_IDENTITY_SECRET];
    if (livekit.some((v) => v !== undefined) && livekit.some((v) => v === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['LIVEKIT_API_URL'], message: 'LIVEKIT_API_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET and LIVEKIT_IDENTITY_SECRET come together' });
    }
    if (env.FCM_SERVICE_ACCOUNT_JSON !== undefined) {
      try {
        parseServiceAccount(env.FCM_SERVICE_ACCOUNT_JSON, env.FCM_PROJECT_ID);
      } catch (error) {
        ctx.addIssue({ code: 'custom', path: ['FCM_SERVICE_ACCOUNT_JSON'], message: (error as Error).message });
      }
    }
  });

export type WorkerEnv = z.output<typeof envSchema>;

/** Every variable this process reads; .env.example lists each one (a test compares them). */
export const envVariables: readonly string[] = Object.keys(envSchema.shape);

export interface WorkerConfig {
  env: WorkerEnv['NODE_ENV'];
  log: { level: WorkerEnv['LOG_LEVEL']; pretty: boolean };
  workerId: string;
  /** `env`: WORKER_ID names the process; `lease`: the process should take a slot (`w<n>`) before it starts, `workerId` is a stand-in until then. */
  workerIdSource: 'env' | 'lease';
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
  /** Undefined without FCM_SERVICE_ACCOUNT_JSON: push jobs finish without sending. */
  push: { account: FcmServiceAccount } | undefined;
  streams: { enabled: boolean };
  /** Undefined without LIVEKIT_*: room checks decide nothing but the connecting cap, rooms are not deleted. */
  livekit: { apiUrl: string; apiKey: string; apiSecret: string; identitySecret: string } | undefined;
  /** Where the signed origins document is published. */
  origins: { media: boolean; targets: PublishTargetConfig[] };
}

export function loadConfig(source: Env = process.env): WorkerConfig {
  const env = parseEnv(envSchema, source);
  return {
    env: env.NODE_ENV,
    log: { level: env.LOG_LEVEL, pretty: env.LOG_PRETTY },
    workerId: env.WORKER_ID ?? `${hostname().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 48)}-${process.pid}`,
    workerIdSource: env.WORKER_ID === undefined ? 'lease' : 'env',
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
    push: (() => {
      const account = parseServiceAccount(env.FCM_SERVICE_ACCOUNT_JSON, env.FCM_PROJECT_ID);
      return account ? { account } : undefined;
    })(),
    streams: { enabled: env.STREAMS_ENABLED },
    livekit:
      env.LIVEKIT_API_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET && env.LIVEKIT_IDENTITY_SECRET
        ? { apiUrl: env.LIVEKIT_API_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET, identitySecret: env.LIVEKIT_IDENTITY_SECRET }
        : undefined,
    origins: { media: env.ORIGINS_PUBLISH_MEDIA, targets: env.ORIGINS_PUBLISH_TARGETS === undefined ? [] : parsePublishTargets(env.ORIGINS_PUBLISH_TARGETS) },
  };
}
