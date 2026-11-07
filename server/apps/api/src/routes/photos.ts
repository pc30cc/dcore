import { deletePhoto, insertPhoto, reorderPhotos, withTransaction, type AccountView, type PhotoInsertResult, type Queryable } from '@app/db';
import {
  idSchema,
  ownProfileSchema,
  PHOTO_MAX_BYTES,
  photoCompletedSchema,
  photoOrderRequestSchema,
  photoParamsSchema,
  photoUploadTicketSchema,
  wireTime,
} from '@app/shared';
import { IdGeneratorUnavailableError, jobId, photoUploadKey } from '@app/shared/server';
import type { FastifyBaseLogger } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { dbErrorInfo, scrubbed, withoutRowData } from '../lib/dbErrors.js';
import { HttpProblem } from '../lib/problem.js';
import { PHOTOS_MIN } from '../services/cfg.js';
import { JobsUnavailableError } from '../services/jobs.js';
import { ownProfileOf } from '../services/me.js';
import { ACCEPTED_PHOTO_MIMES, readUploadIntent, saveUploadIntent, UPLOAD_TTL_SECONDS } from '../services/photos.js';
import { requireScope, sessionOf, unauthorized } from '../services/session.js';
import { meContextOf } from './me.js';

/**
 * The account's photos (§3.4):
 *
 * - `POST /v1/me/photos` hands out a presigned PUT to the private bucket
 *   (`u/<photoId>`; content type and length are signed) and keeps the
 *   intent in Valkey. It costs no statement while the own-account view is
 *   cached (it says which positions are taken), one when it is not.
 * - `POST /v1/me/photos/:photoId/complete` checks the object is there,
 *   queues the worker's job and writes the row (status 1). The job is
 *   queued first, a little delayed: a row therefore always has a job, and
 *   a job that finds no row (the insert failed or the photo was deleted)
 *   cleans the upload up.
 * - `PUT /v1/me/photos/order` puts every photo at its index, in one UPDATE.
 * - `DELETE /v1/me/photos/:photoId` removes the row; the blobs are deleted
 *   by a job (kept while a legal hold names the account). The job is queued
 *   inside the delete's transaction, so a photo is never gone while its
 *   blobs stay without a job to remove them.
 *
 * Nothing is public until the worker has stripped the metadata, made the
 * variants and moderation approved it.
 */

/** Room to commit the row before the worker looks for it. */
const PROCESS_DELAY_MS = 1_000;
/** The blob delete waits until the delete's transaction has most likely ended; it deletes only once the row is gone. */
const DELETE_DELAY_MS = 10_000;
/** Storage or the moderation provider failing for a while: retried with backoff (5 s, 10 s, 20 s, ...). */
const PROCESS_ATTEMPTS = 6;
const DELETE_ATTEMPTS = 10;
const UPLOADS_PER_DAY = 30;
const PHOTO_SLOTS = 9;
const POSITION_TAKEN = 'photos_user_position_key';

/** Looser than the shared request schema, so a size or type the server refuses gets its own status (413, 415). */
const uploadBodySchema = z.object({
  position: z.number().int().min(0).max(8),
  mime: z.string().min(1).max(100),
  bytes: z.number().int().positive(),
});

function unavailable(what: string, cause?: unknown): HttpProblem {
  return new HttpProblem('service_unavailable', { detail: `${what} is not available; try again shortly.`, headers: { 'retry-after': '30' }, cause });
}

/** The account as the route needs it; 401 when it is gone (purged or unknown). */
function accountOf(result: { kind: string; view?: AccountView }): AccountView {
  if (result.kind !== 'account' || !result.view) throw unauthorized();
  return result.view;
}

async function insertOnce(db: Queryable, userId: string, photoId: string, position: number, log: FastifyBaseLogger): Promise<PhotoInsertResult> {
  // Two uploads finishing at once can pick the same free position: the unique constraint refuses one, which tries again.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await insertPhoto(db, userId, photoId, position);
    } catch (error) {
      const info = dbErrorInfo(error);
      if (info?.code === '23505' && info.constraint === POSITION_TAKEN && attempt === 0) {
        log.info('photos: position taken meanwhile; trying the next free one');
        continue;
      }
      if (info?.code === '23505' && info.constraint === POSITION_TAKEN) {
        throw new HttpProblem('position_taken', { detail: 'Another photo took that position; try again.' });
      }
      throw withoutRowData(error);
    }
  }
}

export const photoRoutes: FastifyPluginAsyncZod = async (app) => {
  const fullOnly = requireScope(app, app.account, ['full']);

  function media() {
    if (!app.media) throw unavailable('Photo storage');
    return app.media;
  }

  // ─── POST /v1/me/photos ────────────────────────────────────────────────
  app.post(
    '/v1/me/photos',
    {
      preHandler: fullOnly,
      config: {
        // 0 while the own-account view is cached; 1 when it is rebuilt.
        pgBudget: 1,
        rateLimit: {
          max: UPLOADS_PER_DAY,
          timeWindow: 86_400_000,
          keyGenerator: (request) => `photo-upload:${request.principal?.subject ?? request.clientIp ?? request.ip}`,
        },
      },
      schema: {
        tags: ['photos'],
        summary: 'A presigned upload for a new photo',
        body: uploadBodySchema,
        response: { 201: photoUploadTicketSchema },
      },
    },
    async (request, reply) => {
      const session = sessionOf(app, request);
      const store = media();
      const { position, mime, bytes } = request.body;
      if (!ACCEPTED_PHOTO_MIMES.has(mime)) {
        throw new HttpProblem('unsupported_media_type', { detail: 'Photos are accepted as JPEG or WebP.' });
      }
      if (bytes > PHOTO_MAX_BYTES) {
        throw new HttpProblem('payload_too_large', { detail: `A photo is at most ${PHOTO_MAX_BYTES} bytes.` });
      }
      const view = accountOf((await app.account.load(session.userId)).result);
      if (view.photos.length >= PHOTO_SLOTS) throw new HttpProblem('photo_limit', { detail: `At most ${PHOTO_SLOTS} photos.` });
      if (view.photos.some((photo) => photo.position === position)) {
        throw new HttpProblem('position_taken', { detail: 'A photo is already at that position.' });
      }
      let photoId: string;
      try {
        photoId = app.ids.nextId();
      } catch (error) {
        if (error instanceof IdGeneratorUnavailableError) throw unavailable('Uploading', error);
        throw error;
      }
      const upload = await store.storage.presignPut({
        bucket: store.privateBucket,
        key: photoUploadKey(photoId),
        contentType: mime,
        contentLength: bytes,
        expiresInSeconds: UPLOAD_TTL_SECONDS,
      });
      try {
        await saveUploadIntent(app.redis, app.keys, photoId, { userId: session.userId, position, mime, bytes });
      } catch (error) {
        throw unavailable('Uploading', error);
      }
      return reply.code(201).send({
        photoId,
        upload: { url: upload.url, method: 'PUT', headers: upload.headers, expiresAt: wireTime(upload.expiresAt.getTime()) },
      });
    },
  );

  // ─── POST /v1/me/photos/:photoId/complete ──────────────────────────────
  app.post(
    '/v1/me/photos/:photoId/complete',
    {
      preHandler: fullOnly,
      // 1; 2 when a concurrent upload took the free position first.
      config: { pgBudget: 2 },
      schema: {
        tags: ['photos'],
        summary: 'The upload is done: processing starts',
        params: photoParamsSchema,
        response: { 202: photoCompletedSchema },
      },
    },
    async (request, reply) => {
      const session = sessionOf(app, request);
      const store = media();
      const { photoId } = request.params;
      let intent;
      try {
        intent = await readUploadIntent(app.redis, app.keys, photoId);
      } catch (error) {
        throw unavailable('Uploading', error);
      }
      if (intent?.userId !== session.userId) throw new HttpProblem('not_found', { detail: 'No such upload.' });
      let object;
      try {
        object = await store.storage.headObject(store.privateBucket, photoUploadKey(photoId));
      } catch (error) {
        throw unavailable('Photo storage', error);
      }
      if (object?.size !== intent.bytes) {
        throw new HttpProblem('upload_missing', { detail: 'The photo has not arrived in storage; send it again.' });
      }
      try {
        await app.jobs.add('photo', 'process', jobId('process', photoId), { photoId, userId: session.userId }, {
          delayMs: PROCESS_DELAY_MS,
          attempts: PROCESS_ATTEMPTS,
          backoffMs: 5_000,
        });
      } catch (error) {
        if (error instanceof JobsUnavailableError) throw unavailable('Processing', error);
        throw error;
      }
      const result = await insertOnce(app.pg, session.userId, photoId, intent.position, request.log);
      if (result.kind === 'full') throw new HttpProblem('photo_limit', { detail: `At most ${PHOTO_SLOTS} photos.` });
      if (result.kind === 'created') await app.account.changed(session.userId);
      return reply.code(202).send({ photo: { id: photoId, position: result.position, status: 'processing' as const } });
    },
  );

  // ─── PUT /v1/me/photos/order ───────────────────────────────────────────
  app.put(
    '/v1/me/photos/order',
    {
      preHandler: fullOnly,
      // The UPDATE and the fresh own-account view the answer is built from, in one transaction.
      config: { pgBudget: 2 },
      schema: {
        tags: ['photos'],
        summary: 'The order of the photos (position = index)',
        body: photoOrderRequestSchema,
        response: { 200: ownProfileSchema },
      },
    },
    async (request) => {
      const session = sessionOf(app, request);
      const ctx = meContextOf(app, request, session);
      // The version before the write: its view is stored only if no other change comes in between.
      const since = await app.account.version(session.userId);
      const fresh = await scrubbed(() =>
        withTransaction(app.pg, async (tx) => {
          await tx.query('SET CONSTRAINTS photos_user_position_key DEFERRED');
          const { ok } = await reorderPhotos(tx, session.userId, request.body.photoIds);
          if (!ok) {
            throw new HttpProblem('field_invalid', {
              detail: 'photoIds must name every photo of the account exactly once.',
              errors: [{ in: 'body', pointer: '/photoIds', code: 'set', message: 'Every photo, once.' }],
            });
          }
          return app.account.build(tx, session.userId);
        }),
      );
      await app.account.changed(session.userId, { since, result: fresh });
      return ownProfileOf(accountOf(fresh), ctx);
    },
  );

  // ─── DELETE /v1/me/photos/:photoId ─────────────────────────────────────
  app.delete(
    '/v1/me/photos/:photoId',
    {
      preHandler: fullOnly,
      config: { pgBudget: 1 },
      schema: { tags: ['photos'], summary: 'Deletes a photo', params: z.object({ photoId: idSchema }) },
    },
    async (request, reply) => {
      const session = sessionOf(app, request);
      const { photoId } = request.params;
      const outcome = await scrubbed(() =>
        withTransaction(app.pg, async (tx) => {
          const result = await deletePhoto(tx, session.userId, photoId, PHOTOS_MIN);
          if (result.kind === 'deleted') {
            try {
              // Each delete has its own job: an earlier one (kept as finished) must not swallow it.
              await app.jobs.add(
                'photo',
                'delete',
                jobId('delete', photoId, Date.now()),
                { photoId, userId: session.userId, blobVer: result.blobVer },
                { delayMs: DELETE_DELAY_MS, attempts: DELETE_ATTEMPTS, backoffMs: 10_000 },
              );
            } catch (error) {
              // Rolls the delete back: the photo stays until its blobs can be removed too.
              if (error instanceof JobsUnavailableError) throw unavailable('Deleting photos', error);
              throw error;
            }
          }
          return result;
        }),
      );
      if (outcome.kind === 'missing') throw new HttpProblem('not_found', { detail: 'No such photo.' });
      if (outcome.kind === 'minimum') {
        throw new HttpProblem('photo_min', { detail: `A profile keeps at least ${PHOTOS_MIN} photos; add another one first.` });
      }
      await app.account.changed(session.userId);
      return reply.code(204).send();
    },
  );
};
