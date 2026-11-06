import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Redis } from 'ioredis';

/**
 * These tests need a real Redis (or Valkey) named by TEST_REDIS_URL
 * (infra/dev/native.sh env). Without it they are skipped, unless
 * REQUIRE_INTEGRATION=1 makes that a failure.
 */
export const TEST_REDIS_URL = process.env['TEST_REDIS_URL'];
if (!TEST_REDIS_URL && process.env['REQUIRE_INTEGRATION'] === '1') {
  throw new Error('REQUIRE_INTEGRATION=1 but TEST_REDIS_URL is not set');
}
export const hasRedis = Boolean(TEST_REDIS_URL);

export function connect(): Redis {
  return new Redis(TEST_REDIS_URL ?? '', { maxRetriesPerRequest: null });
}

export function uniqueName(prefix: string): string {
  return `test:${prefix}:${randomBytes(5).toString('hex')}`;
}

/** Polls until `check` is true or the time is up. */
export async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await sleep(20);
  }
}
