import { profileReviewApprove, profileReviewDecide, profileReviewForUpdate, profileReviewQueue, type ProfileReviewItemRow } from '@app/db';
import {
  accountStatus,
  adminProfileApproveSchema,
  adminProfileDecisionSchema,
  adminProfileNeedsChangesSchema,
  adminProfileRejectSchema,
  adminProfileReviewPageSchema,
  adminProfileReviewQuerySchema,
  gender,
  isLocale,
  photoStatus,
  profileReviewState,
  publicUidSchema,
  wireTime,
  type AdminProfileDecision,
  type AdminProfileReviewItem,
  type AuditAction,
  type ProfileReviewState,
} from '@app/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, adminWrite } from '../admin/audit.js';
import { badCursor, pageOf, readCursorKey } from '../admin/cursors.js';
import { afterCommit, publishToUser } from '../admin/effects.js';
import { adminConflict } from '../admin/problems.js';
import { adminRefOf, noSuchUser, photoUrls, promptOf, readUserParam, userRefOf } from '../admin/refs.js';
import type { ConfigSnapshot } from '../services/cfg.js';

/**
 * New profiles waiting for review (the waitlist: app_config
 * `onboarding.waitlist` makes sign-up finish in `pending_review`):
 *
 *   GET  /v1/admin/moderation/profiles?state=   moderation.read: one review state, oldest account first
 *   POST /v1/admin/users/{id}/approve           moderation.decide: active and listable
 *   POST /v1/admin/users/{id}/needs-changes     moderation.decide: back to the person with a message
 *   POST /v1/admin/users/{id}/reject            moderation.decide: not accepted, with a message
 *
 * The message is what the person reads, in their language (the panel
 * prefills nothing: the admin writes it in the person's `locale`). A
 * decision names the state the admin saw (`from`): another one is a 409
 * `stale`, an account no longer waiting 409 `already_decided`. Each is one
 * transaction with its audit row; after the commit the own view moves and
 * the person's app hears it: `account` (approved: the main screens) or
 * `profile` with the review. Approving makes the account listable at once
 * (discovery follows the status in the same transaction).
 */

const userParams = z.object({ id: publicUidSchema });
/** The cursor names the last account shown by its public id, never the internal one. */
const cursorSchema = z.object({ u: publicUidSchema });

function itemOf(app: FastifyInstance, cfg: ConfigSnapshot, row: ProfileReviewItemRow): AdminProfileReviewItem {
  return {
    user: {
      ...userRefOf(app, row.user),
      age: row.user.age,
      gender: row.user.gender === null ? null : (gender.nameOrUndefined(row.user.gender) ?? null),
      country: row.user.country,
      verified: row.user.verified,
    },
    locale: isLocale(row.locale.split('-')[0] ?? '') ? (row.locale.split('-')[0] as AdminProfileReviewItem['locale']) : 'en',
    signedUpAt: wireTime(row.signedUpAtMs),
    state: profileReviewState.name(row.state),
    submittedAt: wireTime(row.submittedAtMs),
    rounds: row.rounds,
    about: row.about,
    job: row.job,
    prompts: row.prompts.map((p) => promptOf(cfg, p)),
    photos: row.photos.map((photo) => {
      const thumbUrl = photo.status === photoStatus.code('processing') ? undefined : photoUrls(app, photo.id, photo.blobVer).thumbUrl;
      return { id: photo.id, position: photo.position, status: photoStatus.name(photo.status), ...(thumbUrl ? { thumbUrl } : {}) };
    }),
    decision: row.decision
      ? {
          kind: row.decision.kind === profileReviewState.code('rejected') ? 'rejected' : 'needs_changes',
          reasonText: row.decision.reasonText,
          decidedAt: wireTime(row.decision.decidedAtMs),
          decidedBy: adminRefOf(row.decision.decidedBy),
        }
      : null,
  };
}

type Decision = { to: 'approved' } | { to: 'needs_changes' | 'rejected'; reasonText: string };

const ACTION = { approved: 'profile.approve', needs_changes: 'profile.needs_changes', rejected: 'profile.reject' } as const satisfies Record<Decision['to'], AuditAction>;

async function decide(app: FastifyInstance, request: FastifyRequest, publicUid: string, from: ProfileReviewState, decision: Decision, note: string | undefined): Promise<AdminProfileDecision> {
  const userId = readUserParam(app, publicUid);
  const adminId = actorOf(request).adminId;
  const result = await adminWrite(app, request, async (tx, trail) => {
    const locked = await profileReviewForUpdate(tx, userId);
    if (!locked) throw noSuchUser();
    if (locked.status !== accountStatus.code('pending_review')) throw adminConflict('already_decided', 'The account is not waiting for a review.');
    const current = locked.state === null ? 'waiting' : profileReviewState.name(locked.state);
    if (current !== from) throw adminConflict('stale', 'The review changed meanwhile; load it again.');
    if (decision.to === 'approved') {
      if (!(await profileReviewApprove(tx, userId))) throw adminConflict('already_decided', 'The account is not waiting for a review.');
    } else {
      await profileReviewDecide(tx, { userId, state: profileReviewState.code(decision.to) as 2 | 3, reasonText: decision.reasonText, adminId });
    }
    trail.record({
      action: ACTION[decision.to],
      target: 'user',
      targetId: userId,
      detail: {
        from,
        to: decision.to,
        ...(decision.to === 'approved' ? {} : { reasonText: decision.reasonText }),
        note: note ?? null,
        rounds: (locked.rounds ?? 0) + (decision.to === 'approved' ? 0 : 1),
      },
    });
    return locked;
  });
  const sideEffects = await afterCommit(
    request,
    'profile review',
    async () => {
      if ((await app.account.changed(userId)) === null) throw new Error('account version not bumped');
      if (decision.to === 'approved') await publishToUser(app, userId, 'account', { status: 'active' });
      else await publishToUser(app, userId, 'profile', { review: { state: decision.to, message: decision.reasonText, decidedAt: wireTime(Date.now()) } });
    },
    { userId: publicUid },
  );
  const status = decision.to === 'approved' ? accountStatus.code('active') : result.status;
  return adminProfileDecisionSchema.parse({ user: userRefOf(app, { ...result.ref, status }), review: decision.to, sideEffects });
}

export const adminProfileReviewRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['admin'];
  const decideGuard = app.requirePermission('moderation.decide');

  app.get(
    '/v1/admin/moderation/profiles',
    {
      preHandler: app.requirePermission('moderation.read'),
      config: { pgBudget: 1 },
      schema: { tags, summary: 'New profiles by review state, oldest first', querystring: adminProfileReviewQuerySchema, response: { 200: adminProfileReviewPageSchema } },
    },
    async (request, reply) => {
      const { state, limit, cursor } = request.query;
      const key = readCursorKey(cursorSchema, cursor);
      const afterId = key ? app.publicIds.user.decodeId(key.u) : null;
      if (key && afterId === null) throw badCursor();
      const rows = await profileReviewQueue(app.pg, { state: profileReviewState.code(state), afterId, limit: limit + 1 });
      const cfg = app.cfg.get();
      reply.header('cache-control', 'no-store');
      return pageOf(rows, limit, (row) => itemOf(app, cfg, row), (row) => ({ u: app.publicIds.user.encode(row.user.id) }));
    },
  );

  app.post(
    '/v1/admin/users/:id/approve',
    {
      preHandler: decideGuard,
      // The locked read, the status, the audit row.
      config: { pgBudget: 3 },
      schema: { tags, summary: 'Accept a new profile', params: userParams, body: adminProfileApproveSchema, response: { 200: adminProfileDecisionSchema } },
    },
    async (request) => decide(app, request, request.params.id, request.body.from, { to: 'approved' }, request.body.note || undefined),
  );

  app.post(
    '/v1/admin/users/:id/needs-changes',
    {
      preHandler: decideGuard,
      config: { pgBudget: 3 },
      schema: { tags, summary: 'Send a new profile back with what to change', params: userParams, body: adminProfileNeedsChangesSchema, response: { 200: adminProfileDecisionSchema } },
    },
    async (request) => decide(app, request, request.params.id, request.body.from, { to: 'needs_changes', reasonText: request.body.reasonText }, request.body.note || undefined),
  );

  app.post(
    '/v1/admin/users/:id/reject',
    {
      preHandler: decideGuard,
      config: { pgBudget: 3 },
      schema: { tags, summary: 'Refuse a new profile, with the reason the person reads', params: userParams, body: adminProfileRejectSchema, response: { 200: adminProfileDecisionSchema } },
    },
    async (request) => decide(app, request, request.params.id, request.body.from, { to: 'rejected', reasonText: request.body.reasonText }, request.body.note || undefined),
  );
};
