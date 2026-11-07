import { jobId, queuePrefix, queueRetention, type ActiveQueueName, type JobName } from '@app/shared/server';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * Adding jobs to the worker's queues (BullMQ) from a request. Job ids are
 * deterministic (`jobId(name, ...parts)`), so a retried request adds
 * nothing twice; every job carries its queue's retention.
 *
 * A BullMQ queue checks its connection once, when it is created, and stays
 * broken if Valkey was down then; queues are therefore made on first use,
 * only on a ready connection, and dropped after a failed add so the next
 * add makes a fresh one.
 */

export interface JobOptions {
  /** Run no earlier than this many milliseconds from now. */
  delayMs?: number | undefined;
  /** Attempts in all (default 1). */
  attempts?: number | undefined;
  /** Exponential backoff between attempts, starting at this many milliseconds. */
  backoffMs?: number | undefined;
}

export interface JobProducer {
  /** Adds a job the worker runs (`queueJobs`); throws when Valkey cannot take it. */
  add<Q extends ActiveQueueName>(queue: Q, name: JobName<Q>, id: string, data: Record<string, unknown>, options?: JobOptions): Promise<void>;
  close(): Promise<void>;
}

export class JobsUnavailableError extends Error {
  constructor(cause: unknown) {
    super('the job queue cannot be reached', { cause });
    this.name = 'JobsUnavailableError';
  }
}

export class BullJobProducer implements JobProducer {
  private readonly redis: Redis;
  private readonly prefix: string;
  private readonly queues = new Map<ActiveQueueName, Queue>();

  constructor(options: { redis: Redis; keyPrefix: string }) {
    this.redis = options.redis;
    this.prefix = queuePrefix(options.keyPrefix);
  }

  private queue(name: ActiveQueueName): Queue {
    const existing = this.queues.get(name);
    if (existing) return existing;
    if (this.redis.status !== 'ready') throw new JobsUnavailableError(new Error(`redis is ${this.redis.status}`));
    const queue = new Queue(name, { connection: this.redis, prefix: this.prefix });
    // Errors also reach the caller of add(); without a listener they would be thrown as events.
    queue.on('error', () => undefined);
    this.queues.set(name, queue);
    return queue;
  }

  async add<Q extends ActiveQueueName>(queue: Q, name: JobName<Q>, id: string, data: Record<string, unknown>, options: JobOptions = {}): Promise<void> {
    const retention = queueRetention(queue);
    const target = this.queue(queue);
    try {
      await target.add(name, data, {
        jobId: id,
        removeOnComplete: retention.removeOnComplete,
        removeOnFail: retention.removeOnFail,
        ...(options.delayMs ? { delay: options.delayMs } : {}),
        ...(options.attempts ? { attempts: options.attempts } : {}),
        ...(options.backoffMs ? { backoff: { type: 'exponential', delay: options.backoffMs } } : {}),
      });
    } catch (error) {
      this.queues.delete(queue);
      // The connection is the app's: closing the queue leaves it open.
      await target.close().catch(() => undefined);
      throw new JobsUnavailableError(error);
    }
  }

  async close(): Promise<void> {
    const queues = [...this.queues.values()];
    this.queues.clear();
    await Promise.allSettled(queues.map((q) => q.close()));
  }
}

export interface RecordedJob {
  queue: ActiveQueueName;
  name: string;
  id: string;
  data: Record<string, unknown>;
  options: JobOptions;
}

/** Keeps jobs in memory (tests): one per id, as BullMQ does while a job is kept. */
export class MemoryJobProducer implements JobProducer {
  readonly jobs: RecordedJob[] = [];
  failWith: Error | null = null;

  async add<Q extends ActiveQueueName>(queue: Q, name: JobName<Q>, id: string, data: Record<string, unknown>, options: JobOptions = {}): Promise<void> {
    if (this.failWith) throw new JobsUnavailableError(this.failWith);
    if (this.jobs.some((job) => job.queue === queue && job.id === id)) return;
    this.jobs.push({ queue, name, id, data, options });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export { jobId };
