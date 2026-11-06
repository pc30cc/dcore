import { Redis } from 'ioredis';

/**
 * A connection for background work. Unlike the API's, commands wait for a
 * reconnect instead of failing (maxRetriesPerRequest: null), which is what
 * BullMQ requires and what a long-running consumer wants.
 */
export function createWorkerRedis(url: string, connectionName: string): Redis {
  return new Redis(url, {
    connectionName,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (attempt) => Math.min(attempt * 250, 5_000),
  });
}
