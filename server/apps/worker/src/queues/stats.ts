import type { Job } from 'bullmq';
import { statsLiveJob } from '../stats/live.js';
import { statsRollupJob } from '../stats/rollup.js';
import type { QueueDefinition } from './types.js';

/**
 * The dashboard's statistics (queue `stats`, always on: not behind
 * MAINT_ENABLED):
 *
 * - `live` every minute: the snapshot the live dashboard reads (`stats/live.ts`);
 * - `rollup` daily at 00:41 UTC (after `maint/active-drain` at 00:23):
 *   yesterday and any missed day of the week before (`stats/rollup.ts`);
 *   `{ day }` (yesterday or older) rolls up that day and its missed days
 *   again: an older day keeps its stored subscription snapshot and places,
 *   and cohort windows that have closed keep their figures.
 */

export const STATS_QUEUE = 'stats';

export const statsQueue: QueueDefinition<{ day?: unknown }, unknown> = {
  name: STATS_QUEUE,
  concurrency: 1,
  schedules: [
    { id: 'live', name: 'live', repeat: { every: 60_000 }, opts: { attempts: 1 } },
    {
      id: 'rollup',
      name: 'rollup',
      repeat: { pattern: '41 0 * * *', tz: 'UTC' },
      opts: { attempts: 5, backoff: { type: 'exponential', delay: 60_000 } },
    },
  ],
  async process(job: Job<{ day?: unknown }>, context) {
    switch (job.name) {
      case 'live':
        return statsLiveJob(context);
      case 'rollup':
        return statsRollupJob(context, job.data);
      default:
        throw new Error(`the stats queue has no job named "${job.name}"`);
    }
  },
};
