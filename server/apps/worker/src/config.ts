import { hostname } from 'node:os';
import { baseEnvShape, envInt, parseEnv, redisEnvShape, type Env } from '@app/config';
import { z } from 'zod';

const envSchema = z.object({
  ...baseEnvShape,
  ...redisEnvShape,
  /** Names this process in Redis (stream consumer names, BullMQ worker names). Stable across restarts. */
  WORKER_ID: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .optional(),
  /** Jobs each queue runs at once in this process, unless the queue sets its own. */
  WORKER_CONCURRENCY: envInt(4, { min: 1, max: 256 }),
  /** In-flight jobs get this long to finish on SIGTERM; then the process exits anyway. */
  SHUTDOWN_TIMEOUT_MS: envInt(30_000, { min: 1_000, max: 600_000 }),
});

export type WorkerEnv = z.output<typeof envSchema>;

export interface WorkerConfig {
  env: WorkerEnv['NODE_ENV'];
  log: { level: WorkerEnv['LOG_LEVEL']; pretty: boolean };
  workerId: string;
  redis: { url: string; keyPrefix: string };
  /** BullMQ's key prefix, derived from REDIS_KEY_PREFIX (`app:` gives `app:bull`). */
  queuePrefix: string;
  concurrency: number;
  shutdownTimeoutMs: number;
}

export function loadConfig(source: Env = process.env): WorkerConfig {
  const env = parseEnv(envSchema, source);
  return {
    env: env.NODE_ENV,
    log: { level: env.LOG_LEVEL, pretty: env.LOG_PRETTY },
    workerId: env.WORKER_ID ?? `${hostname().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 48)}-${process.pid}`,
    redis: { url: env.REDIS_URL, keyPrefix: env.REDIS_KEY_PREFIX },
    queuePrefix: `${env.REDIS_KEY_PREFIX}bull`,
    concurrency: env.WORKER_CONCURRENCY,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  };
}
