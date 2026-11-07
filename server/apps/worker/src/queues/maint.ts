import { deleteStaleSessions, dropExpiredPartition, maintainPartitions, markActive, partitionParents, type PartitionAction } from '@app/db';
import { utcDay } from '@app/shared/server';
import type { Job } from 'bullmq';
import { takeLease } from '../lease.js';
import type { JobContext, QueueDefinition } from './types.js';

/**
 * Maintenance (queue `maint`), each run under a lease:
 *
 * - `partitions` (daily): for every registered parent,
 *   `partitions_maintain(parent)`, then `partition_drop_expired(parent)`
 *   again while it drops one, each its own statement (never a lock of one
 *   parent held while the next is touched). A lock timeout inside them
 *   (`*_deferred`) fails the run, which BullMQ retries two hours later, up
 *   to eight times a day. Runs as the worker's role, which is in
 *   `app_maint` (the API's is not).
 * - `active-drain` (daily, for yesterday): `la:<yyyymmdd>` read with SSCAN
 *   (not emptied: the stats roll-up reads it too; it expires by itself) into
 *   `users_mark_active()` in batches of up to 5,000 ids.
 * - `sessions-cleanup` (weekly): sessions revoked or expired more than 30
 *   days ago, deleted in primary-key chunks of 5,000.
 */

export const MAINT_QUEUE = 'maint';
export const ACTIVE_BATCH = 5_000;
export const SESSIONS_CHUNK = 5_000;
export const SESSIONS_KEEP_DAYS = 30;
const DAY_MS = 86_400_000;
const ID = /^[1-9][0-9]{0,18}$/;

export class PartitionsDeferredError extends Error {
  constructor(parents: readonly string[]) {
    super(`partition maintenance deferred by a lock timeout for ${parents.join(', ')}; retried later`);
    this.name = 'PartitionsDeferredError';
  }
}

export interface PartitionsResult {
  leased: boolean;
  parents: Record<string, PartitionAction[]>;
}

async function leased(context: JobContext, name: string, ttlMs: number): Promise<boolean> {
  return takeLease(context.redis, context.services.keys.jobLease(name), ttlMs, context.config.workerId);
}

export async function partitionsJob(context: JobContext): Promise<PartitionsResult> {
  const { services, log } = context;
  if (!(await leased(context, 'maint-partitions', 15 * 60_000))) return { leased: false, parents: {} };
  const parents: Record<string, PartitionAction[]> = {};
  const deferred: string[] = [];
  for (const parent of await partitionParents(services.pg)) {
    const actions = await maintainPartitions(services.pg, parent);
    if (actions.some((a) => a.action === 'ensure_deferred')) deferred.push(parent);
    // One drop per call; a parent with a long backlog stops after 60 (five years of months).
    for (let i = 0; i < 60; i += 1) {
      const dropped = await dropExpiredPartition(services.pg, parent);
      actions.push(...dropped);
      if (dropped.some((a) => a.action === 'drop_deferred')) {
        deferred.push(parent);
        break;
      }
      if (!dropped.some((a) => a.action === 'dropped')) break;
    }
    parents[parent] = actions;
    const counts = actions.reduce<Record<string, number>>((acc, a) => ({ ...acc, [a.action]: (acc[a.action] ?? 0) + 1 }), {});
    log.info({ parent, ...counts }, 'partitions: maintained');
  }
  if (deferred.length > 0) throw new PartitionsDeferredError(deferred);
  return { leased: true, parents };
}

export interface ActiveDrainResult {
  leased: boolean;
  day: string;
  ids: number;
  written: number;
  batches: number;
}

/** `YYYYMMDD` of the day before `now` (UTC). */
export function previousDay(now: number): string {
  return utcDay(now - DAY_MS);
}

export async function activeDrainJob(context: JobContext, dayArg?: string, now: number = Date.now()): Promise<ActiveDrainResult> {
  const { services, redis, log } = context;
  const day = dayArg ?? previousDay(now);
  if (!/^\d{8}$/.test(day)) throw new Error('active-drain: day must be YYYYMMDD');
  const date = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
  if (!(await leased(context, `maint-active-drain-${day}`, 30 * 60_000))) return { leased: false, day, ids: 0, written: 0, batches: 0 };
  const key = services.keys.activeDay(day);
  let cursor = '0';
  let pending: string[] = [];
  let ids = 0;
  let written = 0;
  let batches = 0;
  const flush = async (batch: string[]) => {
    if (batch.length === 0) return;
    written += await markActive(services.pg, batch, date);
    batches += 1;
  };
  do {
    const [next, members] = await redis.sscan(key, cursor, 'COUNT', ACTIVE_BATCH);
    cursor = next;
    for (const member of members) if (ID.test(member)) pending.push(member);
    while (pending.length >= ACTIVE_BATCH) {
      const batch = pending.slice(0, ACTIVE_BATCH);
      pending = pending.slice(ACTIVE_BATCH);
      ids += batch.length;
      await flush(batch);
    }
  } while (cursor !== '0');
  ids += pending.length;
  await flush(pending);
  log.info({ day, ids, written, batches }, 'active-drain: done');
  return { leased: true, day, ids, written, batches };
}

export interface SessionsCleanupResult {
  leased: boolean;
  deleted: number;
  chunks: number;
}

export async function sessionsCleanupJob(context: JobContext, now: number = Date.now()): Promise<SessionsCleanupResult> {
  const { services, log } = context;
  if (!(await leased(context, 'maint-sessions-cleanup', 6 * 3_600_000))) return { leased: false, deleted: 0, chunks: 0 };
  const cutoff = new Date(now - SESSIONS_KEEP_DAYS * DAY_MS);
  let after = '0';
  let deleted = 0;
  let chunks = 0;
  for (;;) {
    const chunk = await deleteStaleSessions(services.pg, after, SESSIONS_CHUNK, cutoff);
    chunks += 1;
    deleted += chunk.deleted;
    if (chunk.last === null) break;
    after = chunk.last;
  }
  log.info({ deleted, chunks }, 'sessions-cleanup: done');
  return { leased: true, deleted, chunks };
}

export const maintQueue: QueueDefinition<{ day?: string }, unknown> = {
  name: MAINT_QUEUE,
  concurrency: 1,
  schedules: [
    {
      id: 'partitions',
      name: 'partitions',
      repeat: { pattern: '17 3 * * *', tz: 'UTC' },
      opts: { attempts: 8, backoff: { type: 'fixed', delay: 2 * 3_600_000 } },
    },
    {
      id: 'active-drain',
      name: 'active-drain',
      repeat: { pattern: '23 0 * * *', tz: 'UTC' },
      opts: { attempts: 5, backoff: { type: 'exponential', delay: 60_000 } },
    },
    {
      id: 'sessions-cleanup',
      name: 'sessions-cleanup',
      repeat: { pattern: '41 4 * * 0', tz: 'UTC' },
      opts: { attempts: 3, backoff: { type: 'exponential', delay: 10 * 60_000 } },
    },
  ],
  async process(job: Job<{ day?: string }>, context) {
    switch (job.name) {
      case 'partitions':
        return partitionsJob(context);
      case 'active-drain':
        return activeDrainJob(context, job.data.day);
      case 'sessions-cleanup':
        return sessionsCleanupJob(context);
      default:
        throw new Error(`the maint queue has no job named "${job.name}"`);
    }
  },
};
