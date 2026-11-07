import type { Redis } from 'ioredis';

/**
 * A periodic job's lease (`lease:<job>`): the first run of a period takes
 * it, and it is never released early, so a second trigger inside the TTL
 * (another process's schedule, a stalled job picked up again) does nothing.
 * It expires on its own; a later retry of the same job finds it gone.
 */
export async function takeLease(redis: Redis, key: string, ttlMs: number, holder: string): Promise<boolean> {
  return (await redis.set(key, holder, 'PX', ttlMs, 'NX')) === 'OK';
}
