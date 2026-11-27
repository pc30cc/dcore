import { queueJobs, queueRetention, queueNames, type ActiveQueueName, type QueueName } from '@app/shared/server';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * Job counts of every queue for the dashboard (BullMQ `getJobCounts`, a few
 * Valkey commands per queue). The Queue objects are made once per
 * connection and closed with the worker (`closeStatsQueues`). They only
 * read; their default job options still carry the shared retention, so
 * nothing added through them could be kept unbounded.
 */

export interface QueueCounts {
  queue: string;
  /** Waiting to run: wait, prioritized and waiting-children. */
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

const queues = new WeakMap<Redis, Map<string, Queue>>();

function queueOf(redis: Redis, prefix: string, name: string): Queue {
  let byName = queues.get(redis);
  if (!byName) {
    byName = new Map();
    queues.set(redis, byName);
  }
  const key = `${prefix}|${name}`;
  let queue = byName.get(key);
  if (!queue) {
    const retention = queueRetention((queueNames as readonly string[]).includes(name) ? (name as QueueName) : 'system');
    queue = new Queue(name, {
      connection: redis,
      prefix,
      defaultJobOptions: { removeOnComplete: retention.removeOnComplete, removeOnFail: retention.removeOnFail },
    });
    queue.on('error', () => undefined);
    byName.set(key, queue);
  }
  return queue;
}

/** The queues that have jobs, in the shared table's order. */
export const countedQueues = Object.keys(queueJobs) as ActiveQueueName[];

export async function queueCounts(redis: Redis, prefix: string, names: readonly string[] = countedQueues): Promise<QueueCounts[]> {
  return Promise.all(
    names.map(async (name) => {
      const c = await queueOf(redis, prefix, name).getJobCounts('wait', 'active', 'delayed', 'failed', 'prioritized', 'waiting-children');
      const n = (key: string) => (typeof c[key] === 'number' ? c[key] : 0);
      return { queue: name, waiting: n('wait') + n('prioritized') + n('waiting-children'), active: n('active'), delayed: n('delayed'), failed: n('failed') };
    }),
  );
}

/** Closes the queue objects made on this connection (shutdown, tests). */
export async function closeStatsQueues(redis: Redis): Promise<void> {
  const byName = queues.get(redis);
  if (!byName) return;
  queues.delete(redis);
  await Promise.allSettled([...byName.values()].map((q) => q.close()));
}
