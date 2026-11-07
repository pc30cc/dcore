/**
 * The BullMQ queues: names, retention and job ids, shared by the producers
 * (API, worker) and the worker that runs them.
 *
 * Job ids are deterministic, so adding a job while one with the same id
 * waits, runs or is still kept as finished is a no-op; every job's effect is
 * idempotent on its own. BullMQ refuses a custom id that is an integer or
 * that contains `:` (unless it has exactly three parts), so the parts of an
 * id are joined with `.`: `process.1287390234923410099`.
 *
 * Every queue sets retention: BullMQ keeps finished jobs by default, which
 * would fill the noeviction Valkey until every write is refused.
 */

export const queueNames = [
  'system',
  'deck',
  'photo',
  'moderation',
  'push',
  'calls',
  'iap',
  'account',
  'safety',
  'chat',
  'maint',
  'campaigns',
  'stats',
] as const;
export type QueueName = (typeof queueNames)[number];

/**
 * The jobs each queue runs, by name: what producers may add and what the
 * worker's processor of that queue must handle (a worker test runs every
 * name through its queue). A queue that is not listed has no jobs yet, so
 * nothing can be added to it.
 */
export const queueJobs = {
  system: ['heartbeat'],
  deck: ['refill'],
  photo: ['process', 'delete'],
  account: ['deletion-fanout', 'purge', 'deletion-sweep', 'unmatch-purge'],
  safety: ['moderation-end', 'moderation-sweep', 'block-deck'],
  push: ['send'],
  chat: ['like-notes'],
  maint: ['partitions', 'active-drain', 'sessions-cleanup', 'lk-rebuild'],
} as const satisfies Partial<Record<QueueName, readonly string[]>>;

/** Queues that have jobs. */
export type ActiveQueueName = keyof typeof queueJobs;
/** The job names of a queue. */
export type JobName<Q extends ActiveQueueName> = (typeof queueJobs)[Q][number];

export interface KeepJobs {
  /** Seconds a finished job is kept. */
  age: number;
  /** At most this many are kept. */
  count?: number;
}

export interface QueueRetention {
  removeOnComplete: KeepJobs;
  removeOnFail: KeepJobs;
}

const FAILED: KeepJobs = { age: 7 * 24 * 3_600, count: 50_000 };

/** Retention of finished jobs per queue: `push` (a job per message) keeps completed ones 10 minutes. */
export function queueRetention(name: QueueName): QueueRetention {
  if (name === 'push') return { removeOnComplete: { age: 600 }, removeOnFail: FAILED };
  return { removeOnComplete: { age: 3_600, count: 10_000 }, removeOnFail: FAILED };
}

/** BullMQ's key prefix under the deployment prefix (`app:` gives `app:bull`). */
export function queuePrefix(keyPrefix: string): string {
  return `${keyPrefix}bull`;
}

const PART = /^[A-Za-z0-9_-]{1,100}$/;

/** A deterministic job id from its parts (`jobId('process', photoId)` = `process.<photoId>`). */
export function jobId(name: string, ...parts: (string | number | bigint)[]): string {
  const all = [name, ...parts.map(String)];
  for (const part of all) if (!PART.test(part)) throw new TypeError(`"${part.slice(0, 40)}" cannot be part of a job id`);
  if (!/[A-Za-z_-]/.test(name)) throw new TypeError('a job id starts with a name');
  return all.join('.');
}
