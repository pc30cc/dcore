import { finishPhoto, photoDeletionState, photoExists, photoToProcess, type PhotoOutcome } from '@app/db';
import { photoStatus, realtimeEnvelope, userChannel } from '@app/shared';
import {
  bumpVersion,
  IdGeneratorUnavailableError,
  PHOTO_VARIANT_CACHE_CONTROL,
  PHOTO_VARIANT_MIME,
  photoUploadKey,
  photoVariantKey,
  photoVariantKeys,
  type MediaStore,
} from '@app/shared/server';
import { DelayedError, type Job } from 'bullmq';
import { processImage, UnreadableImageError, type ProcessedImage } from '../photos/image.js';
import type { ModerationVerdict } from '../photos/moderation.js';
import type { JobContext, QueueDefinition } from './types.js';

/**
 * The photo pipeline (queue `photo`):
 *
 * - `process` (`process.<photoId>`, queued by `complete`): reads the upload
 *   from the private bucket, strips it (see photos/image.ts), runs automatic
 *   moderation on the stripped 640 px variant, writes the variants to the
 *   media bucket, then the outcome to the row (status 2, 3 or 4) in one
 *   statement, deletes the upload, bumps the own-account version and tells
 *   the person (`profile` event). Two statements per photo.
 * - `delete` (`delete.<photoId>.<ms>`, queued by the delete route inside
 *   the delete's transaction): removes the variants of every version and the
 *   upload once the row is gone, unless a legal hold names the account (then
 *   it looks again a day later). While the row is still there it waits a
 *   little (the delete may not have committed yet); if it stays, the delete
 *   failed and the blobs are kept.
 *
 * Both are idempotent: a re-run of `process` finds the row finished and only
 * tidies the upload; deleting objects that are gone succeeds.
 */

export const PHOTO_QUEUE = 'photo';

/** photos.reject_reason codes this pipeline sets (the uploader sees their texts). */
export const REJECT_TOO_SMALL = 6;
export const REJECT_UNREADABLE = 8;

/**
 * Waits while a row's transaction may not have committed yet: `process` waits
 * for its row to appear (then it counts as never written), `delete` for its
 * row to go (then the delete counts as failed).
 */
const ROW_WAITS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
const STORAGE_WAIT_MS = 60_000;
const HOLD_RECHECK_MS = 24 * 3_600_000;
const ID = /^[1-9][0-9]{0,18}$/;

export interface ProcessJobData {
  photoId: string;
  userId?: string | undefined;
  /** How often the row was looked for and not found. */
  waits?: number | undefined;
}

export interface DeleteJobData {
  photoId: string;
  userId: string;
  blobVer: number;
  /** How often the row was found still there. */
  waits?: number | undefined;
}

export type PhotoJobResult =
  | { outcome: 'processed'; status: 'review' | 'approved' | 'rejected' }
  | { outcome: 'skipped'; reason: 'no_row' | 'finished' | 'deleted' | 'not_deleted' }
  | { outcome: 'deleted'; objects: number };

/** Puts the running job back in the delayed set; BullMQ then neither counts an attempt nor logs a failure. */
async function later(job: Job, context: JobContext, delayMs: number, data?: Record<string, unknown>): Promise<never> {
  if (!context.token) throw new Error('a delayed retry needs the job token');
  if (data) await job.updateData(data);
  await job.moveToDelayed(Date.now() + delayMs, context.token);
  throw new DelayedError();
}

function requireMedia(context: JobContext): MediaStore | null {
  return context.services.media;
}

async function deleteObjects(media: MediaStore, bucket: string, keys: readonly string[]): Promise<void> {
  // Sequential: a failure stops the job, which retries; each delete is idempotent.
  for (const key of keys) await media.storage.deleteObject(bucket, key);
}

function rejection(reason: number): PhotoOutcome {
  return { status: 4, rejectReason: reason, modFlags: 0, hasFace: null, width: null, height: null, blurhash: null, phash: null };
}

function outcomeOf(image: ProcessedImage, verdict: ModerationVerdict): PhotoOutcome {
  const base = {
    modFlags: verdict.labels,
    hasFace: verdict.hasFace ?? null,
    width: image.width,
    height: image.height,
    blurhash: image.blurhash,
    phash: image.phash.toString(),
  };
  if (verdict.verdict === 'reject') return { ...base, status: 4, rejectReason: verdict.reason };
  return { ...base, status: verdict.verdict === 'approve' ? 3 : 2, rejectReason: null };
}

/** After a durable change: the own-account view is rebuilt on the next read, and the person's apps hear of it. */
async function announce(context: JobContext, userId: string, photoId: string, status: number): Promise<void> {
  const { services, redis, log } = context;
  try {
    await bumpVersion(redis, services.keys.meVersion(userId));
  } catch (error) {
    log.error({ err: error }, 'photo: own-account version not bumped; the cached view is stale until it expires');
  }
  if (!services.realtime) return;
  try {
    const name = photoStatus.name(status);
    const envelope = realtimeEnvelope('profile', services.ids.nextId(), Date.now(), { photo: { id: photoId, status: name } });
    await services.realtime.publish(userChannel(services.publicIds.user.encode(userId)), envelope);
  } catch (error) {
    // The change is durable and the next read of the account shows it; the event is a convenience.
    if (error instanceof IdGeneratorUnavailableError) log.warn('photo: no id lease; profile event skipped');
    else log.warn({ err: error }, 'photo: profile event not published');
  }
}

export async function processPhotoJob(job: Job<ProcessJobData>, context: JobContext): Promise<PhotoJobResult> {
  const { services, log, config } = context;
  const photoId = job.data.photoId;
  if (!ID.test(photoId)) throw new Error('process: not a photo id');
  const media = requireMedia(context);
  if (!media) return later(job, context, STORAGE_WAIT_MS);
  const uploadKey = photoUploadKey(photoId);

  const row = await photoToProcess(services.pg, photoId);
  if (!row) {
    const waits = job.data.waits ?? 0;
    const wait = ROW_WAITS_MS[waits];
    if (wait !== undefined) return later(job, context, wait, { ...job.data, waits: waits + 1 });
    // Never written (the insert failed) or deleted before processing: the upload is an orphan.
    await media.storage.deleteObject(media.privateBucket, uploadKey);
    log.info('photo: no row; upload removed');
    return { outcome: 'skipped', reason: 'no_row' };
  }
  if (row.status !== photoStatus.code('processing')) {
    // Finished by an earlier run that stopped before tidying up.
    await media.storage.deleteObject(media.privateBucket, uploadKey);
    return { outcome: 'skipped', reason: 'finished' };
  }

  const upload = await media.storage.getObject(media.privateBucket, uploadKey);
  let outcome: PhotoOutcome;
  const written: string[] = [];
  if (!upload) {
    outcome = rejection(REJECT_UNREADABLE);
    log.warn('photo: upload missing in storage; rejected as unreadable');
  } else {
    let image: ProcessedImage | null = null;
    try {
      image = await processImage(upload, { maxPixels: config.photos.maxPixels });
    } catch (error) {
      if (!(error instanceof UnreadableImageError)) throw error;
      log.info({ reason: error.reason }, 'photo: not usable');
      outcome = rejection(error.reason === 'too_small' ? REJECT_TOO_SMALL : REJECT_UNREADABLE);
    }
    if (image) {
      const preview = image.variants.find((v) => v.size === 640) ?? image.variants[0]!;
      const verdict = await services.photoModerator.check({
        photoId,
        image: preview.body,
        mime: PHOTO_VARIANT_MIME,
        width: preview.width,
        height: preview.height,
      });
      // The pixels first: a row that says approved always has its variants.
      for (const variant of image.variants) {
        const key = photoVariantKey(photoId, row.blobVer, variant.size);
        await media.storage.putObject(media.mediaBucket, key, variant.body, {
          contentType: PHOTO_VARIANT_MIME,
          cacheControl: PHOTO_VARIANT_CACHE_CONTROL,
        });
        written.push(key);
      }
      outcome = outcomeOf(image, verdict);
    }
  }

  const finished = await finishPhoto(services.pg, photoId, outcome!);
  if (!finished) {
    if (await photoExists(services.pg, photoId)) return { outcome: 'skipped', reason: 'finished' };
    // Deleted while it was processed: what this run wrote goes too.
    await deleteObjects(media, media.mediaBucket, written);
    await media.storage.deleteObject(media.privateBucket, uploadKey);
    return { outcome: 'skipped', reason: 'deleted' };
  }
  await media.storage.deleteObject(media.privateBucket, uploadKey);
  await announce(context, finished.userId, photoId, finished.status);
  const status = photoStatus.name(finished.status);
  log.info({ status, modFlags: finished.modFlags }, 'photo: processed');
  return { outcome: 'processed', status: status as 'review' | 'approved' | 'rejected' };
}

export async function deletePhotoJob(job: Job<DeleteJobData>, context: JobContext): Promise<PhotoJobResult> {
  const { services, log } = context;
  const { photoId, userId, blobVer } = job.data;
  if (!ID.test(photoId) || !ID.test(userId) || !Number.isInteger(blobVer) || blobVer < 1) throw new Error('delete: bad job data');
  const media = requireMedia(context);
  if (!media) return later(job, context, STORAGE_WAIT_MS);
  const state = await photoDeletionState(services.pg, photoId, userId);
  if (state.present) {
    // The delete's transaction has not committed (yet): its blobs are the photo's.
    const waits = job.data.waits ?? 0;
    const wait = ROW_WAITS_MS[waits];
    if (wait !== undefined) return later(job, context, wait, { ...job.data, waits: waits + 1 });
    log.warn('photo: the row is still there; the delete did not commit, blobs kept');
    return { outcome: 'skipped', reason: 'not_deleted' };
  }
  if (state.held) {
    log.info('photo: a legal hold names the account; blobs kept, looking again tomorrow');
    return later(job, context, HOLD_RECHECK_MS);
  }
  const variants = photoVariantKeys(photoId, blobVer);
  await deleteObjects(media, media.mediaBucket, variants);
  await media.storage.deleteObject(media.privateBucket, photoUploadKey(photoId));
  return { outcome: 'deleted', objects: variants.length + 1 };
}

export function photoQueue(concurrency: number): QueueDefinition<ProcessJobData | DeleteJobData, PhotoJobResult> {
  return {
    name: PHOTO_QUEUE,
    concurrency,
    async process(job, context) {
      if (job.name === 'process') return processPhotoJob(job as Job<ProcessJobData>, context);
      if (job.name === 'delete') return deletePhotoJob(job as Job<DeleteJobData>, context);
      throw new Error(`the photo queue has no job named "${job.name}"`);
    },
  };
}
