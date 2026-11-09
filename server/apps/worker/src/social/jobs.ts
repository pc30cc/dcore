import { queueRetention, type ActiveQueueName, type JobName } from '@app/shared/server';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * Jobs the stream consumers queue for later (pushes, the like notes of a
 * match). One BullMQ queue object per connection and queue, made on first
 * use. Ids are deterministic (`jobId(...)`), so a replayed stream entry
 * adds nothing twice while the first job waits, runs or is still kept.
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

export interface LaterJob<Q extends ActiveQueueName> {
  queue: Q;
  name: JobName<Q>;
  id: string;
  data: Record<string, unknown>;
  delayMs?: number | undefined;
  attempts?: number | undefined;
  backoffMs?: number | undefined;
}

export async function queueJob<Q extends ActiveQueueName>(redis: Redis, prefix: string, job: LaterJob<Q>): Promise<void> {
  const retention = queueRetention(job.queue);
  await queueOf(redis, prefix, job.queue).add(job.name, job.data, {
    jobId: job.id,
    removeOnComplete: retention.removeOnComplete,
    removeOnFail: retention.removeOnFail,
    ...(job.delayMs ? { delay: job.delayMs } : {}),
    ...(job.attempts ? { attempts: job.attempts } : {}),
    ...(job.backoffMs ? { backoff: { type: 'exponential', delay: job.backoffMs } } : {}),
  });
}

/**
 * A sweep's re-queue: nothing while a job of that id waits, is delayed or
 * runs; one that finished (kept by retention, so a plain add would be a
 * no-op) is removed first and added again, so a job that gave up or failed
 * for good runs once more.
 */
export async function requeueJob<Q extends ActiveQueueName>(redis: Redis, prefix: string, job: LaterJob<Q>): Promise<'queued' | 'pending'> {
  const existing = await queueOf(redis, prefix, job.queue).getJob(job.id);
  if (existing) {
    const state = await existing.getState();
    if (state !== 'completed' && state !== 'failed' && state !== 'unknown') return 'pending';
    if (state !== 'unknown') await existing.remove();
  }
  await queueJob(redis, prefix, job);
  return 'queued';
}

/** Closes the queue objects made on this connection (shutdown, tests). */
export async function closeSocialQueues(redis: Redis): Promise<void> {
  const byName = queues.get(redis);
  if (!byName) return;
  queues.delete(redis);
  await Promise.allSettled([...byName.values()].map((q) => q.close()));
}
