import { Redis } from 'ioredis';

export interface RedisClientOptions {
  url: string;
  connectionName: string;
}

/**
 * A Redis client for request-path work (rate limits, short-lived caches).
 * Commands fail fast while disconnected instead of queueing, so a Redis outage
 * degrades the API (limits are skipped, /readyz reports it) rather than
 * stalling every request. It connects on start, not on construction.
 */
export function createRedis({ url, connectionName }: RedisClientOptions): Redis {
  return new Redis(url, {
    connectionName,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 1_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
}

/** Closes a client whatever state it is in. */
export async function closeRedis(redis: Redis): Promise<void> {
  if (redis.status === 'ready') {
    await redis.quit().catch(() => redis.disconnect());
  } else {
    redis.disconnect();
  }
}
