import { queueRetention, type ActiveQueueName, type JobName } from '@app/shared/server';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * Jobs one worker job adds for another (a refill asking for the like
 * buckets to be rebuilt). One BullMQ queue object per connection and queue,
 * made on first use; ids are deterministic, so a second add while the
 * first waits or runs is a no-op.
 */

const queues = new WeakMap<Redis, Map<string, Queue>>();

function queueOf(redis: Redis, prefix: string, name: ActiveQueueName): Queue {
  let byName = queues.get(redis);
  if (!byName) {
    byName = new Map();
    queues.set(redis, byName);
  }
  const key = `${prefix}|${name}`;
  let queue = byName.get(key);
  if (!queue) {
    queue = new Queue(name, { connection: redis, prefix });
    queue.on('error', () => undefined);
    byName.set(key, queue);
  }
  return queue;
}

export async function addJob<Q extends ActiveQueueName>(
  redis: Redis,
  prefix: string,
  queue: Q,
  name: JobName<Q>,
  id: string,
  data: Record<string, unknown>,
  options: { attempts?: number; backoffMs?: number } = {},
): Promise<void> {
  const retention = queueRetention(queue);
  await queueOf(redis, prefix, queue).add(name, data, {
    jobId: id,
    removeOnComplete: retention.removeOnComplete,
    removeOnFail: retention.removeOnFail,
    ...(options.attempts ? { attempts: options.attempts } : {}),
    ...(options.backoffMs ? { backoff: { type: 'exponential', delay: options.backoffMs } } : {}),
  });
}

/** Closes the queue objects made on this connection (tests, shutdown). */
export async function closeQueues(redis: Redis): Promise<void> {
  const byName = queues.get(redis);
  if (!byName) return;
  queues.delete(redis);
  await Promise.allSettled([...byName.values()].map((q) => q.close()));
}
