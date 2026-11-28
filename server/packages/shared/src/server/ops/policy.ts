import { jobId, queueJobs, type ActiveQueueName } from '../queues.js';

/**
 * What the jobs page may do with the worker's jobs, by queue and job name.
 *
 * Failed jobs are retried only where a late run is harmless: every job is
 * idempotent, but a late notification or call ring is something people see,
 * and a periodic beat is pointless to run again. Anything else may be
 * removed. "Run now" starts a few maintenance tasks by hand under a job id
 * of its own per minute (`<name>.run.<minute>`), so a second click within the
 * minute adds nothing; the job's lease decides whether it works.
 */

/** Names of queues and jobs as BullMQ and the panel carry them. */
export const OPS_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** Failed jobs that may run again: a list of names, or `'*'` for every job of the queue. */
export const retryableJobs: { readonly [Q in ActiveQueueName]?: readonly (typeof queueJobs)[Q][number][] | '*' } = {
  system: ['origins-publish'],
  deck: '*',
  photo: '*',
  account: '*',
  safety: '*',
  chat: ['like-notes', 'unsend-clear'],
  maint: '*',
  iap: '*',
  calls: ['finalize'],
  stats: ['rollup'],
};

/** Tasks the jobs page starts by hand. */
export const runnableTasks = [
  { queue: 'maint', name: 'partitions' },
  { queue: 'maint', name: 'lk-rebuild' },
  { queue: 'system', name: 'origins-publish' },
  { queue: 'stats', name: 'rollup' },
] as const satisfies readonly { queue: ActiveQueueName; name: string }[];

export type RunnableTask = (typeof runnableTasks)[number];

/** The queues that have jobs (keys of `queueJobs`), in the table's order. */
export const activeQueueNames = Object.keys(queueJobs) as ActiveQueueName[];

export function isActiveQueue(name: string): name is ActiveQueueName {
  return (activeQueueNames as readonly string[]).includes(name);
}

/** Whether `name` is a job of `queue` in this build. */
export function isJobOf(queue: ActiveQueueName, name: string): boolean {
  return (queueJobs[queue] as readonly string[]).includes(name);
}

/** Whether failed `queue/name` jobs may run again. */
export function isRetryable(queue: string, name: string): boolean {
  if (!isActiveQueue(queue) || !isJobOf(queue, name)) return false;
  const rule = retryableJobs[queue];
  if (rule === undefined) return false;
  return rule === '*' || (rule as readonly string[]).includes(name);
}

/** Whether `queue/name` may be started by hand. */
export function isRunnable(queue: string, name: string): boolean {
  return runnableTasks.some((task) => task.queue === queue && task.name === name);
}

const REPEAT = /^repeat:([^:]+):[0-9]+$/;

/**
 * The job name a job id carries: a scheduler's occurrence (`repeat:<scheduler>:<ms>`,
 * the scheduler id being the job name) or the first part of a
 * deterministic id (`process.<photoId>`). Anything else reads `other`.
 */
export function jobNameOfId(id: string): string {
  const repeat = REPEAT.exec(id);
  const name = repeat ? repeat[1]! : id.split('.', 1)[0]!;
  return OPS_NAME.test(name) ? name : 'other';
}

const MANUAL = /^[a-z][a-z0-9-]{0,39}\.run\.[0-9]{1,12}$/;

/** Whether a job id is one of "Run now" (`<name>.run.<minute>`). */
export function isManualRunId(id: string | undefined): boolean {
  return id !== undefined && MANUAL.test(id);
}

/** The job id of a run started by hand at `nowMs`: one per task per minute. */
export function manualRunId(name: string, nowMs: number): string {
  return jobId(name, 'run', Math.floor(nowMs / 60_000));
}
