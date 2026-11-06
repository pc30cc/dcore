import type { Pool } from '@app/db';
import type { DependencyCheck, Readiness } from '@app/shared';
import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import { TimeoutError, withTimeout } from './timeout.js';

export interface ReadinessOptions {
  pool: Pool;
  redis: Redis;
  timeoutMs: number;
  /** A result younger than this is reused; concurrent probes always share one check. */
  cacheMs: number;
  log: FastifyBaseLogger;
}

export interface ReadinessProbe {
  check(): Promise<Readiness>;
  /** From now on every check reports `shutting_down`, so load balancers drain this instance. */
  beginShutdown(): void;
  readonly shuttingDown: boolean;
}

async function timed(name: string, run: () => Promise<unknown>, timeoutMs: number, log: FastifyBaseLogger): Promise<DependencyCheck> {
  const started = performance.now();
  try {
    await withTimeout(run(), timeoutMs);
    return { status: 'up', latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    const reason = error instanceof TimeoutError ? 'timeout' : 'error';
    log.warn({ err: error, dependency: name }, 'readiness check failed');
    return { status: 'down', latencyMs: Math.round(performance.now() - started), reason };
  }
}

export function createReadinessProbe(options: ReadinessOptions): ReadinessProbe {
  const { pool, redis, timeoutMs, cacheMs, log } = options;
  let shuttingDown = false;
  let inFlight: Promise<Readiness> | undefined;
  let last: { at: number; result: Readiness } | undefined;

  async function run(): Promise<Readiness> {
    const [postgres, cache] = await Promise.all([
      // The cheapest statement there is; no table, no lock.
      timed('postgres', () => pool.query('SELECT 1'), timeoutMs, log),
      timed(
        'redis',
        async () => {
          if (redis.status !== 'ready') throw new Error(`redis connection is ${redis.status}`);
          await redis.ping();
        },
        timeoutMs,
        log,
      ),
    ]);
    const up = postgres.status === 'up' && cache.status === 'up';
    return { status: up ? 'ready' : 'not_ready', checks: { postgres, redis: cache } };
  }

  return {
    get shuttingDown() {
      return shuttingDown;
    },
    beginShutdown() {
      shuttingDown = true;
    },
    async check() {
      if (shuttingDown) return { status: 'shutting_down', checks: {} };
      if (last && performance.now() - last.at < cacheMs) return last.result;
      inFlight ??= run()
        .then((result) => {
          last = { at: performance.now(), result };
          return result;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
  };
}
