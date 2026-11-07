import type { Job, JobsOptions, RepeatOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { WorkerConfig } from '../config.js';
import type { WorkerServices } from '../services.js';

/** What a job processor may use. */
export interface JobContext {
  config: WorkerConfig;
  /** A shared, non-blocking connection for the processor's own commands. */
  redis: Redis;
  log: Logger;
  /** PostgreSQL, ids, storage, realtime and the other clients of this process. */
  services: WorkerServices;
  /** The job's lock token (needed to move the running job back to delayed). */
  token?: string | undefined;
}

export interface ScheduledJob {
  /** Stable id: upserting the same id replaces the schedule instead of adding one. */
  id: string;
  repeat: Omit<RepeatOptions, 'key'>;
  name: string;
  data?: Record<string, unknown>;
  /** Attempts and backoff of each run (retention comes from the queue). */
  opts?: Pick<JobsOptions, 'attempts' | 'backoff'> | undefined;
}

/**
 * One BullMQ queue this process works on. Producers (the API) add jobs by the
 * queue's name; only the worker defines how they run.
 */
export interface QueueDefinition<Data = unknown, Result = unknown> {
  name: string;
  /** Overrides WORKER_CONCURRENCY for this queue. */
  concurrency?: number;
  process(job: Job<Data, Result>, context: JobContext): Promise<Result>;
  /** Repeating jobs the worker keeps scheduled. */
  schedules?: readonly ScheduledJob[];
}
