import { SYSTEM_FAILED_ACTION_SCAN, SYSTEM_FAILED_SCAN, SYSTEM_JOB_ACTION_MAX } from '@app/shared';
import {
  OPS_NAME,
  activeQueueNames,
  isRetryable,
  jobNameOfId,
  queuePrefix,
  queueRetention,
  type ActiveQueueName,
} from '@app/shared/server';
import { Job, Queue } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * The jobs page's view of the worker's BullMQ queues, through Queue objects
 * of its own on the app's kv-core connection (made on first use on a ready
 * connection, as the job producer's; closed with the app). It reads counts,
 * the newest failed ids with their finish times (no job hash), and the
 * schedulers; it retries and removes failed jobs by id. Nothing here reads
 * a job's data or failure message.
 *
 * A BullMQ queue checks its connection once, when it is made, and stays
 * broken if Valkey dropped then: every Queue is therefore dropped (and
 * closed) after a failed call, so the next call makes fresh ones, as the job
 * producer does. A retry or a remove skips a job only for BullMQ's own state
 * outcomes (gone, no longer failed, locked by a worker); any other error
 * ends the action and is thrown.
 */

export interface FailedGroup {
  name: string;
  count: number;
  newestAtMs: number;
  oldestAtMs: number;
  retryable: boolean;
}

export interface QueueOverview {
  name: ActiveQueueName;
  paused: boolean;
  counts: { waiting: number; active: number; delayed: number; failed: number; completed: number };
  failed: { scanned: number; more: boolean; groups: FailedGroup[] };
}

export interface SchedulerView {
  queue: ActiveQueueName;
  name: string;
  every: number | null;
  pattern: string | null;
  tz: string | null;
  nextAtMs: number | null;
}

export class OpsUnavailableError extends Error {
  constructor(cause: unknown) {
    super('the job queues cannot be read', { cause });
    this.name = 'OpsUnavailableError';
  }
}

const n = (counts: Record<string, number>, key: string) => (typeof counts[key] === 'number' ? counts[key] : 0);

/** BullMQ's answer that a job is not in the state an action needs (gone, moved, locked): a negative numeric `code`. */
function isStateOutcome(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' && code < 0;
}

/** Failed ids and their finish times from a ZREVRANGE … WITHSCORES answer. */
function pairs(reply: string[]): { id: string; atMs: number }[] {
  const out: { id: string; atMs: number }[] = [];
  for (let i = 0; i + 1 < reply.length; i += 2) out.push({ id: reply[i]!, atMs: Math.max(0, Math.floor(Number(reply[i + 1]) || 0)) });
  return out;
}

export class OpsQueues {
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
    if (this.redis.status !== 'ready') throw new OpsUnavailableError(new Error(`redis is ${this.redis.status}`));
    // It never adds a job; its defaults still carry the shared retention, so nothing added through it could be kept unbounded.
    const retention = queueRetention(name);
    const queue = new Queue(name, { connection: this.redis, prefix: this.prefix, defaultJobOptions: { removeOnComplete: retention.removeOnComplete, removeOnFail: retention.removeOnFail } });
    queue.on('error', () => undefined);
    this.queues.set(name, queue);
    return queue;
  }

  /** Drops every Queue made so far (closed; the connection is the app's and stays open): the next call makes fresh ones. */
  private reset(): void {
    const queues = [...this.queues.values()];
    this.queues.clear();
    void Promise.allSettled(queues.map((q) => q.close()));
  }

  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      this.reset();
      if (error instanceof OpsUnavailableError) throw error;
      throw new OpsUnavailableError(error);
    }
  }

  /** Every queue of the shared table: counts, paused, and the newest failed ids grouped by job name. */
  overview(): Promise<QueueOverview[]> {
    return this.guarded(() =>
      Promise.all(
        activeQueueNames.map(async (name) => {
          const queue = this.queue(name);
          const [counts, paused, failed] = await Promise.all([
            queue.getJobCounts('wait', 'prioritized', 'waiting-children', 'active', 'delayed', 'failed', 'completed'),
            queue.isPaused(),
            this.redis.zrevrange(queue.keys.failed!, 0, SYSTEM_FAILED_SCAN - 1, 'WITHSCORES'),
          ]);
          const groups = new Map<string, FailedGroup>();
          const scanned = pairs(failed);
          for (const { id, atMs } of scanned) {
            const job = jobNameOfId(id);
            const group = groups.get(job) ?? { name: job, count: 0, newestAtMs: atMs, oldestAtMs: atMs, retryable: isRetryable(name, job) };
            group.count += 1;
            group.newestAtMs = Math.max(group.newestAtMs, atMs);
            group.oldestAtMs = Math.min(group.oldestAtMs, atMs);
            groups.set(job, group);
          }
          const failedCount = n(counts, 'failed');
          return {
            name,
            paused,
            counts: {
              waiting: n(counts, 'wait') + n(counts, 'prioritized') + n(counts, 'waiting-children'),
              active: n(counts, 'active'),
              delayed: n(counts, 'delayed'),
              failed: failedCount,
              completed: n(counts, 'completed'),
            },
            failed: { scanned: scanned.length, more: failedCount > scanned.length, groups: [...groups.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) },
          };
        }),
      ),
    );
  }

  /** Every job scheduler of every queue (the scheduled tasks), by queue then name. */
  schedulers(): Promise<SchedulerView[]> {
    return this.guarded(async () => {
      const lists = await Promise.all(
        activeQueueNames.map(async (queue) => {
          const schedulers = await this.queue(queue).getJobSchedulers(0, 49, true);
          return schedulers
            .map((s): SchedulerView | null => {
              const name = s.name || s.key;
              if (!OPS_NAME.test(name)) return null;
              return {
                queue,
                name,
                every: typeof s.every === 'number' && s.every > 0 ? s.every : null,
                pattern: typeof s.pattern === 'string' ? s.pattern : null,
                tz: typeof s.tz === 'string' ? s.tz : null,
                nextAtMs: typeof s.next === 'number' && s.next > 0 ? s.next : null,
              };
            })
            .filter((s): s is SchedulerView => s !== null);
        }),
      );
      return lists.flat().sort((a, b) => a.queue.localeCompare(b.queue) || a.name.localeCompare(b.name));
    });
  }

  /**
   * The newest failed jobs of `name` (`other` matches ids that name no job),
   * at most `max` of them (and never more than SYSTEM_JOB_ACTION_MAX):
   * `more` when the name may have others the action leaves.
   */
  matchingFailed(queue: ActiveQueueName, name: string, max: number = SYSTEM_JOB_ACTION_MAX): Promise<{ ids: string[]; more: boolean }> {
    const limit = Math.max(1, Math.min(max, SYSTEM_JOB_ACTION_MAX));
    return this.guarded(async () => {
      const q = this.queue(queue);
      const ids = (await this.redis.zrevrange(q.keys.failed!, 0, SYSTEM_FAILED_ACTION_SCAN - 1)).filter((id) => jobNameOfId(id) === name);
      // The scan read the newest ids only; there may be more of the name further back.
      const scannedAll = (await this.redis.zcard(q.keys.failed!)) <= SYSTEM_FAILED_ACTION_SCAN;
      return { ids: ids.slice(0, limit), more: ids.length > limit || !scannedAll };
    });
  }

  /** Whether a job with this id is kept in the queue (any state). */
  jobExists(queue: ActiveQueueName, id: string): Promise<boolean> {
    return this.guarded(async () => (await this.redis.exists(this.queue(queue).toKey(id))) === 1);
  }

  /**
   * Puts failed jobs back to wait with their attempts reset; a job gone or
   * no longer failed is skipped. Throws (after the Queues are dropped) on
   * any other error: the jobs before it stay retried.
   */
  async retry(queue: ActiveQueueName, ids: readonly string[]): Promise<number> {
    return this.acting(async () => {
      const q = this.queue(queue);
      let done = 0;
      for (const id of ids) {
        try {
          const job = await Job.fromId(q, id);
          if (!job) continue;
          await job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
          done += 1;
        } catch (error) {
          // Moved meanwhile (retried, removed or running: BullMQ answers 'not in the failed state'): left alone.
          if (!isStateOutcome(error)) throw error;
        }
      }
      return done;
    });
  }

  /** Removes failed jobs; a locked or vanished one is skipped. Throws, as {@link retry}, on any other error. */
  async remove(queue: ActiveQueueName, ids: readonly string[]): Promise<number> {
    return this.acting(async () => {
      const q = this.queue(queue);
      let done = 0;
      for (const id of ids) {
        try {
          if ((await q.remove(id)) === 1) done += 1;
        } catch (error) {
          if (!isStateOutcome(error)) throw error;
        }
      }
      return done;
    });
  }

  private async acting<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      this.reset();
      throw error;
    }
  }

  async close(): Promise<void> {
    const queues = [...this.queues.values()];
    this.queues.clear();
    // The connection is the app's: closing the queues leaves it open.
    await Promise.allSettled(queues.map((q) => q.close()));
  }
}
