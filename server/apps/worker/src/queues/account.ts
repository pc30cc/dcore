import { deletionFanoutTarget, deletionSweep, purgeAccount, purgePhotos, type EndedConversation } from '@app/db';
import { realtimeEnvelope, userChannel } from '@app/shared';
import {
  ACCOUNT_QUEUE,
  accountJobAttempts,
  accountJobIds,
  accountJobNames,
  bumpVersion,
  deletionFanoutDataSchema,
  EXPORT_JOB,
  MATCH_ENDED_TTL_SECONDS,
  photoUploadKey,
  photoVariantKeys,
  purgeDataSchema,
  queueRetention,
  type DeletionFanoutData,
  type MediaStore,
  type PurgeData,
} from '@app/shared/server';
import { DelayedError, Queue, type Job } from 'bullmq';
import { endCallsOf } from '../calls/queue.js';
import { exportJob, type ExportResult } from '../export/job.js';
import { takeLease } from '../lease.js';
import { unmatchPurgeJob, type UnmatchPurgeResult } from './unmatch.js';
import type { JobContext, QueueDefinition } from './types.js';

/**
 * Account deletion in the background (queue `account`):
 *
 * - `deletion-fanout` (queued by the API right after a deletion): the
 *   conversations the deletion ended leave both people's Valkey lists
 *   (`cl:`, `unr:`, `mt:`, `lm:`, read and delivered pointers), each peer
 *   hears `conversation_end` (it looks the same as an unmatch), the person
 *   is put in `vis:out` (deck queues built before skip them), their card,
 *   deck queue and presence go, and every connection of theirs to
 *   Centrifugo is closed. One read. When the account was restored before
 *   it ran, the conversations still end (they ended in the database) but
 *   the person is not hidden.
 * - `purge` (delayed to the purge time): `account_purge()` (the tombstone,
 *   one statement), then the Valkey keys of the account, then the photo
 *   blobs of every version and the uploads, then the photo rows (a second
 *   statement). Not due yet (the grace was lengthened, or a deletion after
 *   a restore): back to the delayed set until it is. A legal hold on the
 *   account, or on one of its conversations: looked at again a day later.
 * - `deletion-sweep` (every 30 minutes, under a lease): queues a purge for
 *   every account whose purge time has passed (a lost job), and a fan-out
 *   for every account deleted in the last 50 minutes (one the API could not
 *   queue; a fan-out finished within the hour is still kept, so it is not
 *   run twice).
 *
 * Conversation media (`m/<matchId>/`) does not exist yet; its deletion
 * belongs with chat media.
 */

const DAY_MS = 86_400_000;
const STORAGE_WAIT_MS = 60_000;
const HOLD_RECHECK_MS = DAY_MS;
const HIDDEN_WINDOW_MS = 3 * 3_600_000;
export const SWEEP_EVERY_MS = 30 * 60_000;
export const SWEEP_RECENT_MS = 50 * 60_000;
const SWEEP_LIMIT = 1_000;

export interface AccountQueueOptions {
  /** The clock purges are due against (tests move it on). */
  now?: (() => number) | undefined;
  concurrency?: number | undefined;
}

export type FanoutResult = { outcome: 'missing' } | { outcome: 'done'; ended: number; hidden: boolean; published: number; disconnected: boolean };

export type PurgeResult =
  | { outcome: 'purged'; matches: number; heldMatches: number; photos: number; objects: number }
  | { outcome: 'not_deleted' | 'missing' };

export interface SweepResult {
  leased: boolean;
  purges: number;
  fanouts: number;
}

/** Puts the running job back in the delayed set; BullMQ then counts no attempt and logs no failure. */
async function later(job: Job, context: JobContext, delayMs: number, data?: Record<string, unknown>): Promise<never> {
  if (!context.token) throw new Error('a delayed retry needs the job token');
  if (data) await job.updateData(data);
  await job.moveToDelayed(Date.now() + Math.max(1_000, delayMs), context.token);
  throw new DelayedError();
}

function lists(context: JobContext, userId: string, ended: readonly EndedConversation[]) {
  const { keys } = context.services;
  const pipeline = context.redis.pipeline();
  for (const { matchId, peerId } of ended) {
    // The tombstone first: an announcement that read the match as active does nothing after it.
    pipeline.set(keys.matchEnded(matchId), 1, 'EX', MATCH_ENDED_TTL_SECONDS);
    pipeline.del(keys.raw('mt', matchId), keys.raw('lm', matchId), keys.raw('rp', matchId), keys.raw('dl', matchId));
    pipeline.zrem(keys.raw('cl', peerId), matchId);
    pipeline.hdel(keys.raw('unr', peerId), matchId);
    pipeline.srem(keys.raw('rp', 'dirty'), matchId);
  }
  // Every conversation of the person has ended.
  pipeline.del(keys.raw('cl', userId), keys.raw('unr', userId));
  return pipeline;
}

export async function deletionFanoutJob(job: Job<DeletionFanoutData>, context: JobContext): Promise<FanoutResult> {
  const { services, log } = context;
  const data = deletionFanoutDataSchema.parse(job.data);
  const target = await deletionFanoutTarget(services.pg, data.userId, data.deletedAtMs);
  if (!target) return { outcome: 'missing' };
  const hidden = target.status === 7 || target.status === 8;
  const now = Date.now();

  const pipeline = lists(context, data.userId, target.ended);
  if (hidden) {
    const { keys } = services;
    pipeline.zadd(keys.accountsHidden(), now, data.userId);
    pipeline.zremrangebyscore(keys.accountsHidden(), '-inf', now - HIDDEN_WINDOW_MS);
  }
  const replies = await pipeline.exec();
  const failed = replies?.find(([error]) => error !== null)?.[0];
  if (failed) throw failed;
  if (hidden) {
    // kv-cache: the deck queue, presence, last seen and the card.
    const { keys } = services;
    const cached = [keys.raw('deck', data.userId), keys.raw('deckm', data.userId), keys.presence(data.userId), keys.lastSeen(data.userId)];
    if (target.profileVersion !== null) {
      const catalogue = (await context.redis.get(keys.catalogueVersion())) ?? '0';
      cached.push(keys.raw('card', data.userId, target.profileVersion, catalogue));
    }
    await services.cache.del(...cached);
  }
  // The peers' conversation lists changed: their list versions move (ETags).
  for (const peerId of new Set(target.ended.map((e) => e.peerId))) await bumpVersion(context.redis, services.keys.raw('cv', peerId));
  // A call the person is in ends with the conversations (the API did it at once; a repeat finds nothing).
  await endCallsOf(
    context,
    target.ended.map(({ matchId, peerId }) => (BigInt(data.userId) < BigInt(peerId) ? { matchId, lo: data.userId, hi: peerId } : { matchId, lo: peerId, hi: data.userId })),
  );

  let published = 0;
  let disconnected = false;
  if (services.realtime) {
    // Event ids are minted once and kept with the job, so a retried publish is delivered once.
    const eventIds: Record<string, string> = { ...data.eventIds };
    let minted = false;
    for (const { matchId } of target.ended) {
      if (!eventIds[matchId]) {
        eventIds[matchId] = services.ids.nextId();
        minted = true;
      }
    }
    if (minted) await job.updateData({ ...data, eventIds });
    for (const { matchId, peerId } of target.ended) {
      const envelope = realtimeEnvelope('conversation_end', eventIds[matchId]!, data.deletedAtMs, { conversationId: matchId });
      await services.realtime.publish(userChannel(services.publicIds.user.encode(peerId)), envelope);
      published += 1;
    }
    if (hidden) {
      await services.realtime.disconnect(services.publicIds.user.encode(data.userId));
      disconnected = true;
    }
  } else if (target.ended.length > 0 || hidden) {
    log.warn('deletion fan-out: no Centrifugo configured; conversation_end and the disconnect were not sent');
  }
  log.info({ ended: target.ended.length, hidden, published }, 'deletion fan-out done');
  return { outcome: 'done', ended: target.ended.length, hidden, published, disconnected };
}

async function deleteBlobs(media: MediaStore, photos: readonly { id: string; blobVer: number }[]): Promise<number> {
  let objects = 0;
  // Sequential: a failure stops the job, which retries; deleting what is gone succeeds.
  for (const photo of photos) {
    for (const key of photoVariantKeys(photo.id, photo.blobVer)) {
      await media.storage.deleteObject(media.mediaBucket, key);
      objects += 1;
    }
    await media.storage.deleteObject(media.privateBucket, photoUploadKey(photo.id));
    objects += 1;
  }
  return objects;
}

export async function purgeJob(job: Job<PurgeData>, context: JobContext, now: () => number): Promise<PurgeResult> {
  const { services, log } = context;
  const data = purgeDataSchema.parse(job.data);
  const at = now();
  const outcome = await purgeAccount(services.pg, data.userId, at);
  switch (outcome.outcome) {
    case 'not_due':
      log.info({ inMs: outcome.purgeAtMs - at }, 'purge: not due yet');
      return later(job, context, outcome.purgeAtMs - at, { ...data, purgeAtMs: outcome.purgeAtMs });
    case 'held':
      log.info('purge: the account is under a legal hold; looked at again tomorrow');
      return later(job, context, HOLD_RECHECK_MS);
    case 'not_deleted':
    case 'missing':
      log.info({ outcome: outcome.outcome }, 'purge: nothing to purge');
      return { outcome: outcome.outcome };
    case 'purged':
      break;
  }

  const { keys } = services;
  const pipeline = context.redis.pipeline();
  pipeline.del(keys.location(data.userId), keys.raw('cl', data.userId), keys.raw('unr', data.userId));
  for (const deviceId of outcome.deviceIds) pipeline.del(keys.device(deviceId));
  for (const sessionId of outcome.sessionIds) pipeline.del(keys.refreshGrace(sessionId));
  const replies = await pipeline.exec();
  const failed = replies?.find(([error]) => error !== null)?.[0];
  if (failed) throw failed;
  // kv-cache: the entitlements of both stores.
  await services.cache.del(keys.entitlements(data.userId, 1), keys.entitlements(data.userId, 2));
  // The own-account view: a cached copy of the deleted form must not outlive the account.
  await bumpVersion(context.redis, keys.meVersion(data.userId));

  let objects = 0;
  if (outcome.photos.length > 0) {
    const media = services.media;
    // The rows stay until their blobs are gone, so nothing is lost while storage is not configured or fails.
    if (!media) {
      log.warn({ photos: outcome.photos.length }, 'purge: no object storage configured; the photos wait');
      return later(job, context, STORAGE_WAIT_MS);
    }
    objects = await deleteBlobs(media, outcome.photos);
    await purgePhotos(services.pg, data.userId, outcome.photos.map((p) => p.id));
  }
  log.info({ matches: outcome.matchIds.length, heldMatches: outcome.heldMatchIds.length, photos: outcome.photos.length, objects }, 'account purged');
  if (outcome.heldMatchIds.length > 0) {
    // The tombstone is made; the held conversations go once their holds are released.
    return later(job, context, HOLD_RECHECK_MS);
  }
  return { outcome: 'purged', matches: outcome.matchIds.length, heldMatches: 0, photos: outcome.photos.length, objects };
}

export async function deletionSweepJob(context: JobContext, now: () => number): Promise<SweepResult> {
  const { services, config, log } = context;
  if (!(await takeLease(context.redis, services.keys.jobLease('deletion-sweep'), SWEEP_EVERY_MS - 60_000, config.workerId))) {
    return { leased: false, purges: 0, fanouts: 0 };
  }
  const at = now();
  const rows = await deletionSweep(services.pg, { nowMs: at, recentSinceMs: at - SWEEP_RECENT_MS, limit: SWEEP_LIMIT });
  if (rows.length === 0) return { leased: true, purges: 0, fanouts: 0 };
  const queue = new Queue(ACCOUNT_QUEUE, { connection: context.redis, prefix: config.queuePrefix });
  queue.on('error', () => undefined);
  const retention = queueRetention(ACCOUNT_QUEUE);
  let purges = 0;
  let fanouts = 0;
  try {
    for (const row of rows) {
      if (row.due) {
        // An existing job of this id (delayed, waiting) makes this a no-op.
        await queue.add(accountJobNames.purge, { userId: row.userId, deletedAtMs: row.deletedAtMs, purgeAtMs: row.purgeAtMs } satisfies PurgeData, {
          jobId: accountJobIds.purge(row.userId, row.deletedAtMs),
          attempts: accountJobAttempts.purge.attempts,
          backoff: { type: 'exponential', delay: accountJobAttempts.purge.backoffMs },
          ...retention,
        });
        purges += 1;
      } else {
        await queue.add(accountJobNames.fanout, { userId: row.userId, deletedAtMs: row.deletedAtMs } satisfies DeletionFanoutData, {
          jobId: accountJobIds.fanout(row.userId, row.deletedAtMs),
          attempts: accountJobAttempts.fanout.attempts,
          backoff: { type: 'exponential', delay: accountJobAttempts.fanout.backoffMs },
          ...retention,
        });
        fanouts += 1;
      }
    }
  } finally {
    await queue.close();
  }
  log.info({ purges, fanouts }, 'deletion sweep');
  return { leased: true, purges, fanouts };
}

export function accountQueue(
  options: AccountQueueOptions = {},
): QueueDefinition<DeletionFanoutData | PurgeData | Record<string, never>, FanoutResult | PurgeResult | SweepResult | UnmatchPurgeResult | ExportResult> {
  const now = options.now ?? Date.now;
  return {
    name: ACCOUNT_QUEUE,
    concurrency: options.concurrency ?? 2,
    schedules: [{ id: accountJobNames.sweep, name: accountJobNames.sweep, repeat: { every: SWEEP_EVERY_MS } }],
    async process(job, context) {
      if (job.name === accountJobNames.fanout) return deletionFanoutJob(job as Job<DeletionFanoutData>, context);
      if (job.name === accountJobNames.purge) return purgeJob(job as Job<PurgeData>, context, now);
      if (job.name === accountJobNames.sweep) return deletionSweepJob(context, now);
      if (job.name === 'unmatch-purge') return unmatchPurgeJob(job, context);
      if (job.name === EXPORT_JOB) return exportJob(job, context);
      throw new Error(`the account queue has no job named "${job.name}"`);
    },
  };
}
