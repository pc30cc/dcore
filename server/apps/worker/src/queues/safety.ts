import { dueModeration, settleModeration } from '@app/db';
import {
  SAFETY_QUEUE,
  applyModerationEffects,
  blockDeckDataSchema,
  dropPairFromDecks,
  moderationEndDataSchema,
  plannedEventIds,
  queueRetention,
  safetyJobAttempts,
  safetyJobIds,
  safetyJobNames,
  type BlockDeckData,
  type ModerationEndData,
} from '@app/shared/server';
import { Queue, type Job } from 'bullmq';
import { takeLease } from '../lease.js';
import type { JobContext, QueueDefinition } from './types.js';

/**
 * Queue `safety`:
 *
 * - `moderation-end` (delayed to the end of a suspension, timed ban or
 *   shadowban): the account is settled (`moderation_settle()`: back to the
 *   status it rests at, or still penalised when another action stands),
 *   then its Valkey and realtime side: the person comes back into its
 *   peers' lists on their next read and hears `account` with the new status.
 *   Settling an account that is already in line changes nothing and
 *   publishes nothing. Event ids are planned and stored with the job first,
 *   so a retry publishes the same events.
 * - `moderation-sweep` (every 10 minutes, under a lease): an end whose job
 *   was lost (Valkey lost it, the API could not queue it) is queued again.
 * - `block-deck`: a block made while a deck refill of one of the pair was
 *   running drops the two from each other's queue once more, after that
 *   refill's guard expired.
 */

export const MODERATION_SWEEP_EVERY_MS = 10 * 60_000;
const SWEEP_LIMIT = 500;

export type ModerationEndResult = { outcome: 'missing' } | { outcome: 'settled'; changed: boolean; published: number };
export interface ModerationSweepResult {
  leased: boolean;
  queued: number;
}

export async function moderationEndJob(job: Job<ModerationEndData>, context: JobContext): Promise<ModerationEndResult> {
  const { services, log } = context;
  const data = moderationEndDataSchema.parse(job.data);
  const outcome = await settleModeration(services.pg, data.userId);
  if (outcome.outcome === 'missing') return { outcome: 'missing' };
  const changed = outcome.before.status !== outcome.after.status || outcome.before.shadowbanned !== outcome.after.shadowbanned;
  if (!changed) {
    log.info({ actionId: data.actionId }, 'moderation end: the account was already settled');
    return { outcome: 'settled', changed: false, published: 0 };
  }
  const eventIds = plannedEventIds(outcome, data.eventIds ?? {}, () => services.ids.nextId());
  if (JSON.stringify(eventIds) !== JSON.stringify(data.eventIds ?? {})) await job.updateData({ ...data, eventIds });
  const effects = await applyModerationEffects(
    {
      redis: context.redis,
      cache: services.cache,
      keys: services.keys,
      publicIds: services.publicIds,
      realtime: services.realtime,
      denyList: null,
      nextId: () => services.ids.nextId(),
      log,
    },
    outcome,
    { eventIds },
  );
  log.info({ actionId: data.actionId, status: outcome.after.status, published: effects.published }, 'moderation end: settled');
  return { outcome: 'settled', changed: true, published: effects.published };
}

export async function moderationSweepJob(context: JobContext): Promise<ModerationSweepResult> {
  const { services, config, log } = context;
  if (!(await takeLease(context.redis, services.keys.jobLease(safetyJobNames.moderationSweep), MODERATION_SWEEP_EVERY_MS - 30_000, config.workerId))) {
    return { leased: false, queued: 0 };
  }
  const due = await dueModeration(services.pg, SWEEP_LIMIT);
  if (due.length === 0) return { leased: true, queued: 0 };
  const queue = new Queue(SAFETY_QUEUE, { connection: context.redis, prefix: config.queuePrefix });
  queue.on('error', () => undefined);
  try {
    for (const row of due) {
      // A job of the same id that is still delayed or waiting makes this a no-op.
      await queue.add(safetyJobNames.moderationEnd, { actionId: row.actionId, userId: row.userId } satisfies ModerationEndData, {
        jobId: safetyJobIds.moderationEnd(row.actionId),
        attempts: safetyJobAttempts.moderationEnd.attempts,
        backoff: { type: 'exponential', delay: safetyJobAttempts.moderationEnd.backoffMs },
        ...queueRetention(SAFETY_QUEUE),
      });
    }
  } finally {
    await queue.close();
  }
  log.info({ queued: due.length }, 'moderation sweep');
  return { leased: true, queued: due.length };
}

export async function blockDeckJob(job: Job<BlockDeckData>, context: JobContext): Promise<{ refilling: boolean }> {
  const { a, b } = blockDeckDataSchema.parse(job.data);
  return dropPairFromDecks({ redis: context.redis, cache: context.services.cache, keys: context.services.keys }, a, b);
}

export const safetyQueue: QueueDefinition<ModerationEndData | BlockDeckData | Record<string, never>, ModerationEndResult | ModerationSweepResult | { refilling: boolean }> = {
  name: SAFETY_QUEUE,
  concurrency: 4,
  schedules: [{ id: safetyJobNames.moderationSweep, name: safetyJobNames.moderationSweep, repeat: { every: MODERATION_SWEEP_EVERY_MS } }],
  async process(job, context) {
    if (job.name === safetyJobNames.moderationEnd) return moderationEndJob(job as Job<ModerationEndData>, context);
    if (job.name === safetyJobNames.moderationSweep) return moderationSweepJob(context);
    if (job.name === safetyJobNames.blockDeck) return blockDeckJob(job as Job<BlockDeckData>, context);
    throw new Error(`the safety queue has no job named "${job.name}"`);
  },
};
