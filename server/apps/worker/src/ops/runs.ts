import { errorKindOf, isManualRunId, runField, summarizeResult, type KeyBuilder, type RunRecord } from '@app/shared/server';
import type { Job, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

/**
 * The run recorder: when a scheduled job (a scheduler's occurrence) or a run
 * started from the jobs page ends, its outcome goes to `ops:runs` (field
 * `<queue>/<job>`) and, when it worked, its time to `ops:runs:ok`; BullMQ
 * keeps finished jobs for an hour only, so this is how the page tells when
 * a nightly task last ran. Other jobs (the per-person ones) are not
 * recorded. The record holds no job id, data or message (shared
 * `ops/runs.ts`); a failure to write it is logged, never thrown, so a
 * listener can never stop the worker.
 */

type Finished = Pick<Job, 'id' | 'name' | 'queueName' | 'repeatJobKey' | 'attemptsMade' | 'opts' | 'processedOn' | 'finishedOn'>;

/** Whether a finished job is one the recorder keeps. */
export function isRecorded(job: Pick<Job, 'id' | 'repeatJobKey'>): boolean {
  return Boolean(job.repeatJobKey) || isManualRunId(job.id);
}

/** The record of a finished job. */
export function runRecordOf(job: Finished, outcome: { ok: true; result: unknown } | { ok: false; error: unknown }, now: number = Date.now()): RunRecord {
  const attempts = Math.max(1, job.opts?.attempts ?? 1);
  const attempt = Math.max(1, job.attemptsMade ?? 1);
  const ms = typeof job.finishedOn === 'number' && typeof job.processedOn === 'number' ? Math.max(0, job.finishedOn - job.processedOn) : null;
  return {
    atMs: typeof job.finishedOn === 'number' ? job.finishedOn : now,
    ok: outcome.ok,
    ms,
    attempt,
    attempts,
    willRetry: !outcome.ok && attempt < attempts,
    error: outcome.ok ? null : errorKindOf(outcome.error),
    manual: isManualRunId(job.id),
    summary: outcome.ok ? summarizeResult(outcome.result) : {},
  };
}

/** Writes one record (and the success time when it worked), in one MULTI. */
export async function recordRun(redis: Redis, keys: KeyBuilder, job: Finished, record: RunRecord): Promise<void> {
  const field = runField(job.queueName, job.name);
  const multi = redis.multi().hset(keys.opsRuns(), field, JSON.stringify(record));
  if (record.ok) multi.hset(keys.opsRunsOk(), field, String(record.atMs));
  await multi.exec();
}

/** Records the scheduled and hand-started jobs this worker finishes. */
export function attachRunRecorder(worker: Worker, options: { redis: Redis; keys: KeyBuilder; log: Logger }): void {
  const { redis, keys, log } = options;
  const write = (job: Finished, outcome: { ok: true; result: unknown } | { ok: false; error: unknown }): void => {
    if (!isRecorded(job)) return;
    recordRun(redis, keys, job, runRecordOf(job, outcome)).catch((error: unknown) =>
      log.warn({ err: error, queue: job.queueName, job: job.name }, 'run recorder: the outcome was not written'),
    );
  };
  worker.on('completed', (job, result) => write(job, { ok: true, result }));
  worker.on('failed', (job, error) => {
    if (job) write(job, { ok: false, error });
  });
}
