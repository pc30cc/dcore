import { adminDecidePhoto, adminPhotoQueue, type AdminQueuePhotoRow } from '@app/db';
import {
  adminPhotoApproveRequestSchema,
  adminPhotoDecisionSchema,
  adminPhotoQueueQuerySchema,
  adminPhotoQueueSchema,
  adminPhotoRejectRequestSchema,
  gender,
  idSchema,
  photoModFlags,
  photoRejectReason,
  photoStatus,
  wireTime,
  type AdminPhotoDecision,
  type AdminQueuePhoto,
  type PhotoRejectReason,
  type PhotoStatus,
} from '@app/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { adminWrite } from '../admin/audit.js';
import { fieldInvalid, pageOf, readCursorKey } from '../admin/cursors.js';
import { afterCommit, publishToUser, withIdLease } from '../admin/effects.js';
import { englishReason } from '../admin/reasons.js';
import { personLocale, photoUrls, userRefOf } from '../admin/refs.js';
import { HttpProblem } from '../lib/problem.js';
import { rejectText } from '../services/me.js';
import { adminIdOf } from './adminAuth.js';

/**
 * The photo queue and the decisions on a photo:
 *
 *   GET  /v1/admin/moderation/photos                 waiting for a human, oldest first
 *   POST /v1/admin/moderation/photos/{id}/approve
 *   POST /v1/admin/moderation/photos/{id}/reject     { reason }
 *
 * A decision is one statement (photo_decide) and its audit row, about the
 * person (their audit tab shows it). After the commit the person's own view
 * and card move on, and their app hears `profile` with the photo's state
 * and, when rejected, the reason in their language. Approving a rejected
 * photo and rejecting an approved one are allowed (a report on a live
 * photo). `from` is the status the admin saw: a photo another admin decided
 * meanwhile answers 409 and keeps their decision. Repeating a decision
 * answers the photo as it is and runs the after-commit side again.
 */

const photoParams = z.object({ id: idSchema });
const photoCursor = z.object({ id: idSchema });

function modFlagNames(mask: number): string[] {
  return photoModFlags.names.filter((name) => (mask & photoModFlags.code(name)) !== 0);
}

function queuePhotoOf(app: FastifyInstance, row: AdminQueuePhotoRow): AdminQueuePhoto {
  return {
    id: row.id,
    position: row.position,
    modFlags: modFlagNames(row.modFlags),
    hasFace: row.hasFace,
    width: row.width,
    height: row.height,
    uploadedAt: wireTime(row.uploadedAtMs),
    ...photoUrls(app, row.id, row.blobVer),
    user: {
      ...userRefOf(app, row.user),
      age: row.user.age,
      gender: row.user.gender === null ? null : (gender.nameOrUndefined(row.user.gender) ?? null),
      country: row.user.country,
      verified: row.user.verified,
    },
    others: row.others.map((o) => {
      const thumbUrl = o.status === photoStatus.code('processing') ? undefined : photoUrls(app, o.id, o.blobVer).thumbUrl;
      return { id: o.id, status: photoStatus.name(o.status), ...(thumbUrl ? { thumbUrl } : {}) };
    }),
  };
}

function stateOf(state: { status: number; rejectReason?: number | undefined }) {
  const reason = state.rejectReason === undefined ? undefined : (photoRejectReason.nameOrUndefined(state.rejectReason) ?? 'other');
  return { status: photoStatus.name(state.status), ...(reason ? { rejectReason: reason } : {}) };
}

async function decide(
  app: FastifyInstance,
  request: FastifyRequest,
  photoId: string,
  reason: PhotoRejectReason | null,
  from: PhotoStatus | undefined,
): Promise<AdminPhotoDecision> {
  const cfg = app.cfg.get();
  const adminId = adminIdOf(request);
  const reasonCode = reason === null ? null : photoRejectReason.code(reason);
  if (reason === 'unreadable') throw fieldInvalid('/reason', 'wrong_reason', 'This reason is set by the automatic checks only.');
  const actionId = reason === null ? null : await withIdLease(() => app.ids.nextId());
  const outcome = await adminWrite(app, request, async (tx, trail) => {
    const decided = await adminDecidePhoto(tx, {
      photoId,
      adminId,
      approve: reason === null,
      reasonCode,
      actionId,
      reasonText: reasonCode === null ? null : englishReason(cfg, 'photo', reasonCode),
      expect: from === undefined ? null : photoStatus.code(from),
    });
    switch (decided.outcome) {
      case 'missing':
        throw new HttpProblem('not_found', { detail: 'No such photo.' });
      case 'processing':
        throw new HttpProblem('conflict', { detail: 'The photo is still being processed.' });
      case 'decided_elsewhere':
        // Another admin decided it since this one saw it: nothing is written, their decision stands.
        throw new HttpProblem('conflict', { detail: 'Already decided.' });
      case 'unchanged':
        trail.unchanged();
        break;
      case 'decided':
        trail.record({
          action: reason === null ? 'photo.approve' : 'photo.reject',
          target: 'user',
          targetId: decided.userId,
          detail: { photoId, reason, before: stateOf(decided.before), after: stateOf(decided.after), actionId: decided.actionId },
        });
        break;
    }
    return decided;
  });
  if (outcome.outcome !== 'decided' && outcome.outcome !== 'unchanged') throw new Error('unreachable');
  // A repeated decision (unchanged) runs the side again: it is idempotent and repairs one that failed before.
  const current = outcome.outcome === 'decided' ? outcome.after : outcome;
  const after = stateOf(current);
  const sideEffects = await afterCommit(
    request,
    'photo decision',
    async () => {
      // The own view is read again and prepared decks build the card again (as the worker's decisions do).
      if ((await app.account.changed(outcome.userId)) === null) throw new Error('account version not bumped');
      await publishToUser(app, outcome.userId, 'profile', {
        photo: {
          id: photoId,
          status: after.status,
          ...(current.status === photoStatus.code('rejected') && current.rejectReason !== undefined
            ? { rejectReason: rejectText(cfg, current.rejectReason, personLocale(outcome.locale)) }
            : {}),
        },
      });
    },
    { photoId },
  );
  return { photo: { id: photoId, ...after }, sideEffects };
}

export const adminPhotoRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['admin'];
  const decideGuard = app.requirePermission('moderation.decide');

  app.get(
    '/v1/admin/moderation/photos',
    {
      preHandler: app.requirePermission('moderation.read'),
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Photos waiting for a human, oldest first', querystring: adminPhotoQueueQuerySchema, response: { 200: adminPhotoQueueSchema } },
    },
    async (request) => {
      const { limit, cursor } = request.query;
      const key = readCursorKey(photoCursor, cursor);
      const rows = await adminPhotoQueue(app.pg, { afterId: key?.id ?? null, limit: limit + 1 });
      return pageOf(rows, limit, (row) => queuePhotoOf(app, row), (row) => ({ id: row.id }));
    },
  );

  app.post(
    '/v1/admin/moderation/photos/:id/approve',
    {
      preHandler: decideGuard,
      config: { pgBudget: 2 },
      schema: { tags, summary: 'Approve a photo', params: photoParams, body: adminPhotoApproveRequestSchema, response: { 200: adminPhotoDecisionSchema } },
    },
    async (request) => decide(app, request, request.params.id, null, request.body.from),
  );

  app.post(
    '/v1/admin/moderation/photos/:id/reject',
    {
      preHandler: decideGuard,
      config: { pgBudget: 2 },
      schema: { tags, summary: 'Reject a photo with the reason the person reads', params: photoParams, body: adminPhotoRejectRequestSchema, response: { 200: adminPhotoDecisionSchema } },
    },
    async (request) => decide(app, request, request.params.id, request.body.reason, request.body.from),
  );
};
