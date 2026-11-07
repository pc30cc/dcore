import { Redis } from 'ioredis';

/**
 * Tests that need Redis read TEST_REDIS_URL (infra/dev/native.sh env).
 * Without it they are skipped, unless REQUIRE_INTEGRATION=1 makes that a
 * failure. Every key they write carries a random prefix, like a deployment's.
 */
export const TEST_REDIS_URL = process.env['TEST_REDIS_URL'];
if (!TEST_REDIS_URL && process.env['REQUIRE_INTEGRATION'] === '1') {
  throw new Error('REQUIRE_INTEGRATION=1 but TEST_REDIS_URL is not set');
}
export const hasRedis = Boolean(TEST_REDIS_URL);

export function testRedis(): Redis {
  if (!TEST_REDIS_URL) throw new Error('TEST_REDIS_URL is not set');
  return new Redis(TEST_REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1 });
}

export function testPrefix(): string {
  return `t${Math.random().toString(36).slice(2, 10)}:`;
}

/** Deletes every key under a prefix. */
export async function dropPrefix(redis: Redis, prefix: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 1000);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}
