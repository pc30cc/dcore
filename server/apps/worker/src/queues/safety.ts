import { dueModeration, settleModeration, sweepReportEvidence, type ActionView } from '@app/db';
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
import { endCallsOf } from '../calls/queue.js';
import { takeLease } from '../lease.js';
import {
  reportEvidenceJob,
  reportFileJob,
  requestsSweepJob,
  type ReportEvidenceResult,
  type ReportFileResult,
  type RequestsSweepResult,
} from './evidence.js';
import type { JobContext, QueueDefinition } from './types.js';

/**
 * Queue `safety`:
 *
 * - `moderation-end` (delayed to the end of a suspension, timed ban or
 *   shadowban): the account is settled (`moderation_settle()`: back to the
 *   status it rests at, or still penalised when another action stands),
 *   then its Valkey and realtime side: the person comes back into its
 *   peers' lists on their next read and hears `account` with the new status.
 *   A suspension or ban whose period ended while another restriction keeps
 *   the status (a ban, a later suspension) changes no state, but `GET /v1/me`
 *   lists only the actions in force: the person's own view version moves and
 *   they hear `account` with the ended action, once per action (a marker in
 *   kv-core outlives the sweep's week). Settling an account that is already
 *   in line, and whose ended action was told, changes nothing and publishes
 *   nothing. A shadowban's end never moves the view by itself. Event ids are
 *   planned and stored with the job first, so a retry publishes the same
 *   events.
 * - `moderation-sweep` (every 10 minutes, under a lease): an end whose job
 *   was lost (Valkey lost it, the API could not queue it) is queued again.
 * - `block-deck`: a block made while a deck refill of one of the pair was
 *   running drops the two from each other's queue once more, after that
 *   refill's guard expired.
 * - `evidence-sweep` (daily, under a lease): closed reports whose evidence
 *   retention is over (`evidence_purge_at`) lose their evidence and the
 *   reporter's words, 500 per statement, at most 20 statements a run; a
 *   report a legal hold names keeps them until the hold is released. The
 *   report row keeps its reason, context, status and resolution.
 */

export const MODERATION_SWEEP_EVERY_MS = 10 * 60_000;
const SWEEP_LIMIT = 500;

export type ModerationEndResult = { outcome: 'missing' } | { outcome: 'settled'; changed: boolean; published: number };
export interface ModerationSweepResult {
  leased: boolean;
  queued: number;
}

/** How long the "ended action told" marker lives: past the sweep's week of re-queued ends. */
export const MODERATION_END_TOLD_TTL_SECONDS = 8 * 86_400;

/** A suspension or ban (what `GET /v1/me` lists while in force) that was not lifted; the query reads it only once its period is over. */
function endedInView(view: ActionView | null): view is ActionView {
  return view !== null && (view.kind === 2 || view.kind === 3) && view.revokedAtMs === undefined;
}

export async function moderationEndJob(job: Job<ModerationEndData>, context: JobContext): Promise<ModerationEndResult> {
  const { services, log } = context;
  const data = moderationEndDataSchema.parse(job.data);
  const outcome = await settleModeration(services.pg, data.userId, data.actionId);
  if (outcome.outcome === 'missing') return { outcome: 'missing' };
  const changed = outcome.before.status !== outcome.after.status || outcome.before.shadowbanned !== outcome.after.shadowbanned;
  const ended = endedInView(outcome.endedAction) ? outcome.endedAction : null;
  const toldKey = services.keys.moderationEndTold(data.actionId);
  if (!changed && (ended === null || (await context.redis.exists(toldKey)) > 0)) {
    log.info({ actionId: data.actionId }, 'moderation end: the account was already settled');
    return { outcome: 'settled', changed: false, published: 0 };
  }
  // Unchanged state with an ended suspension or ban: the action carries the write, so the own view moves and the person hears it.
  const effect = changed ? outcome : { ...outcome, action: ended };
  const eventIds = plannedEventIds(effect, data.eventIds ?? {}, () => services.ids.nextId());
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
    effect,
    { eventIds },
  );
  // After the effects ran: a run that failed before this point is retried and tells the person then.
  if (ended !== null) await context.redis.set(toldKey, '1', 'EX', MODERATION_END_TOLD_TTL_SECONDS);
  // A call in a conversation the change ended ends with it.
  await endCallsOf(context, outcome.ended);
  log.info({ actionId: data.actionId, status: outcome.after.status, published: effects.published }, 'moderation end: settled');
  return { outcome: 'settled', changed, published: effects.published };
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

export const EVIDENCE_SWEEP_BATCH = 500;
const EVIDENCE_SWEEP_BATCHES = 20;
const EVIDENCE_SWEEP_LEASE_MS = 30 * 60_000;

export interface EvidenceSweepResult {
  leased: boolean;
  purged: number;
}

export async function evidenceSweepJob(context: JobContext): Promise<EvidenceSweepResult> {
  const { services, config, log } = context;
  if (!(await takeLease(context.redis, services.keys.jobLease(safetyJobNames.evidenceSweep), EVIDENCE_SWEEP_LEASE_MS, config.workerId))) {
    return { leased: false, purged: 0 };
  }
  let purged = 0;
  for (let batch = 0; batch < EVIDENCE_SWEEP_BATCHES; batch += 1) {
    const ids = await sweepReportEvidence(services.pg, EVIDENCE_SWEEP_BATCH);
    purged += ids.length;
    if (ids.length < EVIDENCE_SWEEP_BATCH) break;
  }
  log.info({ purged }, 'evidence sweep: done');
  return { leased: true, purged };
}

export async function blockDeckJob(job: Job<BlockDeckData>, context: JobContext): Promise<{ refilling: boolean }> {
  const { a, b } = blockDeckDataSchema.parse(job.data);
  return dropPairFromDecks({ redis: context.redis, cache: context.services.cache, keys: context.services.keys }, a, b);
}

export const safetyQueue: QueueDefinition<
  ModerationEndData | BlockDeckData | Record<string, never>,
  ModerationEndResult | ModerationSweepResult | { refilling: boolean } | ReportEvidenceResult | ReportFileResult | RequestsSweepResult | EvidenceSweepResult
> = {
  name: SAFETY_QUEUE,
  concurrency: 4,
  schedules: [
    { id: safetyJobNames.moderationSweep, name: safetyJobNames.moderationSweep, repeat: { every: MODERATION_SWEEP_EVERY_MS } },
    // Message requests: expiry and retention (the chat's evidence jobs below are queued per report).
    { id: 'requests-sweep', name: 'requests-sweep', repeat: { pattern: '37 2 * * *', tz: 'UTC' }, opts: { attempts: 3, backoff: { type: 'exponential', delay: 10 * 60_000 } } },
    // Reports: the evidence of closed ones once its retention is over.
    {
      id: safetyJobNames.evidenceSweep,
      name: safetyJobNames.evidenceSweep,
      repeat: { pattern: '23 3 * * *', tz: 'UTC' },
      opts: { attempts: 3, backoff: { type: 'exponential', delay: 600_000 } },
    },
  ],
  async process(job, context) {
    if (job.name === 'report-evidence') return reportEvidenceJob(job, context);
    if (job.name === 'report-file') return reportFileJob(job, context);
    if (job.name === 'requests-sweep') return requestsSweepJob(context);
    if (job.name === safetyJobNames.moderationEnd) return moderationEndJob(job as Job<ModerationEndData>, context);
    if (job.name === safetyJobNames.moderationSweep) return moderationSweepJob(context);
    if (job.name === safetyJobNames.blockDeck) return blockDeckJob(job as Job<BlockDeckData>, context);
    if (job.name === safetyJobNames.evidenceSweep) return evidenceSweepJob(context);
    throw new Error(`the safety queue has no job named "${job.name}"`);
  },
};
