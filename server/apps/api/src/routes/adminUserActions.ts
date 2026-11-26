import {
  adminApplyModeration,
  adminRenameUser,
  adminReportTarget,
  adminRevokeModeration,
  adminRevokeUserSessions,
  adminSealedPhone,
  adminSetTestAccount,
  adminUserView,
  deleteAccount,
  type AdminUserDetailRow,
  type DeletionOutcome,
  type ModerationEffect,
} from '@app/db';
import {
  PENALTY_MAX_DAYS,
  accountStatus,
  adminActionResultSchema,
  adminDeleteUserRequestSchema,
  adminDeleteUserResultSchema,
  adminLiftRequestSchema,
  adminPenaltySchemas,
  adminRenameRequestSchema,
  adminRevealPhoneSchema,
  adminRevokeSessionsRequestSchema,
  adminRevokeSessionsResultSchema,
  adminTestAccountRequestSchema,
  adminUserChangeSchema,
  moderationKind,
  moderationReason,
  publicUidSchema,
  textRejectReason,
  wireTime,
  type AdminPenaltyKind,
  type ModerationReason,
  type AuditAction,
} from '@app/shared';
import { dropConversationVisibility, markHiddenFromDecks, recheckConversationLists } from '@app/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { adminWrite } from '../admin/audit.js';
import { fieldInvalid } from '../admin/cursors.js';
import { takeAdminLimit } from '../admin/limits.js';
import { adminModeration, afterCommit, publishToUser, withIdLease, worst } from '../admin/effects.js';
import { englishReason } from '../admin/reasons.js';
import { accountStateOf as stateOf, actionOf, noSuchUser, personLocale, readUserParam, removedBanAuditOf, userDetailOf, userReadScope } from '../admin/refs.js';
import { scrubbed } from '../lib/dbErrors.js';
import { HttpProblem } from '../lib/problem.js';
import { adminDeleteAndFinish } from '../services/deletion.js';
import { textRejectText } from '../services/me.js';
import { adminIdOf } from './adminAuth.js';

/**
 * The admin panel's writes on a person, each one transaction with its audit
 * row (`adminWrite`), the Valkey and realtime side after the commit
 * (`afterCommit`, `sideEffects` in the answer):
 *
 *   POST  /v1/admin/users/{id}/reveal-phone      the number, audited (users.view_phone; 20/h per admin)
 *   POST  /v1/admin/users/{id}/test-account      { test } (owner only)
 *   POST  /v1/admin/users/{id}/{warn,suspend,ban,shadowban}
 *   POST  /v1/admin/users/{id}/lift              { actionId, reasonText? }
 *   POST  /v1/admin/users/{id}/revoke-sessions   signed out everywhere
 *   POST  /v1/admin/users/{id}/delete            as an app deletion (restorable in the grace)
 *   PATCH /v1/admin/users/{id}/profile           a new display name, with the reason
 *
 * What the person sees: a warning, suspension or ban carries the message the
 * admin wrote (in the person's language, pre-filled by the panel) and can be
 * appealed in the app; a shadowban is never shown to them anywhere.
 */

const userParams = z.object({ id: publicUidSchema });
const MINUTE_MS = 60_000;
const REVEAL_PER_HOUR = 20;
const DAY_MS = 86_400_000;

const PENALTY_KIND: Record<AdminPenaltyKind, 1 | 2 | 3 | 4> = { warn: 1, suspend: 2, ban: 3, shadowban: 4 };
const PENALTY_ACTION = { warn: 'user.warn', suspend: 'user.suspend', ban: 'user.ban', shadowban: 'user.shadowban' } as const satisfies Record<AdminPenaltyKind, AuditAction>;
const PENALTY_PERMISSION = { warn: 'users.warn', suspend: 'users.suspend', ban: 'users.ban', shadowban: 'users.shadowban' } as const;

/** The end of a period: at least a minute ahead, at most ten years. */
function checkEnd(endsAt: string | undefined, now: number): Date | undefined {
  if (endsAt === undefined) return undefined;
  const at = Date.parse(endsAt);
  if (at < now + MINUTE_MS) throw fieldInvalid('/endsAt', 'ends_in_past', 'The end must be in the future.');
  if (at > now + PENALTY_MAX_DAYS * DAY_MS) throw fieldInvalid('/endsAt', 'ends_too_far', 'The end is too far ahead.');
  return new Date(at);
}

function sameState(effect: Pick<ModerationEffect, 'before' | 'after'>): boolean {
  return effect.before.status === effect.after.status && effect.before.shadowbanned === effect.after.shadowbanned;
}

function viewOrMissing(view: AdminUserDetailRow | null): AdminUserDetailRow {
  if (!view) throw noSuchUser();
  return view;
}

/** Bumps the own-account version (and marks the card); a version that could not be written is a failed side. */
async function accountChanged(app: FastifyInstance, userId: string, card = true): Promise<void> {
  if ((await app.account.changed(userId, undefined, { card })) === null) throw new Error('account version not bumped');
}

/** Opens the sealed number, after the commit (a refused audit row never reveals); a value that does not open is a 500, logged. */
function openPhone(app: FastifyInstance, request: FastifyRequest, sealed: Buffer): string {
  try {
    return app.secrets.sealer.openText(sealed, 'auth_identities.subject_enc');
  } catch (error) {
    request.log.error({ err: error }, 'reveal phone: the sealed number does not open');
    throw new HttpProblem('internal', { detail: 'The number could not be read.' });
  }
}

export const adminUserActionRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['admin'];

  app.post(
    '/v1/admin/users/:id/reveal-phone',
    {
      preHandler: app.requirePermission('users.view_phone'),
      config: { pgBudget: 2 },
      schema: { tags, summary: "A person's phone number (each view is audited)", params: userParams, response: { 200: adminRevealPhoneSchema } },
    },
    async (request, reply) => {
      const userId = readUserParam(app, request.params.id);
      await takeAdminLimit(app, request, 'admin_reveal_phone', REVEAL_PER_HOUR);
      const sealed = await adminWrite(app, request, async (tx, trail) => {
        const enc = await adminSealedPhone(tx, userId);
        if (!enc) throw new HttpProblem('not_found', { detail: 'No phone number on file.' });
        trail.record({ action: 'user.view_phone', target: 'user', targetId: userId, detail: {} });
        return enc;
      });
      const phone = openPhone(app, request, sealed);
      reply.header('cache-control', 'no-store');
      return { phone };
    },
  );

  app.post(
    '/v1/admin/users/:id/test-account',
    {
      preHandler: app.requirePermission('users.test_account'),
      config: { pgBudget: 2 },
      schema: { tags, summary: 'Make a person a test account, or a regular one again', params: userParams, body: adminTestAccountRequestSchema, response: { 200: adminUserChangeSchema } },
    },
    async (request) => {
      const userId = readUserParam(app, request.params.id);
      const test = request.body.test;
      const outcome = await adminWrite(app, request, async (tx, trail) => {
        const result = await adminSetTestAccount(tx, userId, test);
        if (!result.found || !result.view) throw noSuchUser();
        if (!result.changed) trail.unchanged();
        else trail.record({ action: 'user.test_account', target: 'user', targetId: userId, detail: { before: { test: result.before }, after: { test } } });
        return result;
      });
      const view = viewOrMissing(outcome.view);
      // Every step is idempotent: a repeated call (unchanged) runs it again, so it repairs a side that failed before.
      const sideEffects = await afterCommit(
          request,
          'test account',
          async () => {
            await accountChanged(app, userId);
            // A test account sees and is seen by test accounts only: out of every prepared deck, its own deck built again.
            if (test) await markHiddenFromDecks(app.redis, app.keys, [userId], Date.now());
            await app.cache.del(app.keys.deckQueue(userId), app.keys.deckMeta(userId));
            await recheckConversationLists({ redis: app.redis, cache: app.cache, keys: app.keys }, outcome.peers);
            await dropConversationVisibility(app.redis, app.keys, userId);
          },
          { userId: request.params.id },
        );
      return { user: userDetailOf(app, app.cfg.get(), { ...view, test }, userReadScope(app, request)), sideEffects };
    },
  );

  for (const kind of ['warn', 'suspend', 'ban', 'shadowban'] as const) {
    app.post(
      `/v1/admin/users/:id/${kind}`,
      {
        preHandler: app.requirePermission(PENALTY_PERMISSION[kind]),
        config: { pgBudget: 3 },
        schema: {
          tags,
          summary: `${kind === 'warn' ? 'Warn' : kind === 'suspend' ? 'Suspend' : kind === 'ban' ? 'Ban' : 'Shadowban'} a person`,
          params: userParams,
          body: adminPenaltySchemas[kind],
          response: { 200: adminActionResultSchema },
        },
      },
      async (request) => {
        const userId = readUserParam(app, request.params.id);
        const body = request.body as { reason: ModerationReason; reasonText?: string; note?: string; endsAt?: string; reportId?: string };
        const cfg = app.cfg.get();
        const endsAt = checkEnd(body.endsAt, Date.now());
        const reasonCode = moderationReason.code(body.reason);
        // A shadowban is never shown: its stored text is the reason's English label.
        const reasonText = kind === 'shadowban' ? englishReason(cfg, 'moderation', reasonCode) : (body.reasonText ?? '');
        const note = body.note ? body.note : undefined;
        const adminId = adminIdOf(request);
        const actionId = await withIdLease(() => app.ids.nextId());
        const result = await adminWrite(app, request, async (tx, trail) => {
          if (body.reportId !== undefined) {
            const target = await adminReportTarget(tx, body.reportId);
            if (target === null) throw fieldInvalid('/reportId', 'unknown_report', 'No such report.');
            if (target !== userId) throw fieldInvalid('/reportId', 'not_this_user', 'The report is about someone else.');
          }
          const written = await scrubbed(() =>
            adminApplyModeration(tx, { actionId, userId, kind: PENALTY_KIND[kind], reasonCode, reasonText, endsAt, adminId, reportId: body.reportId, note }),
          );
          if (written.outcome.outcome !== 'applied' || !written.view || !written.action) throw noSuchUser();
          const outcome = written.outcome;
          trail.record({
            action: PENALTY_ACTION[kind],
            target: 'user',
            targetId: userId,
            detail: {
              actionId,
              reason: body.reason,
              ...(kind === 'shadowban' ? {} : { reasonText }),
              note: note ?? null,
              endsAt: endsAt ? endsAt.toISOString() : null,
              reportId: body.reportId ?? null,
              before: stateOf(outcome.before),
              after: stateOf(outcome.after),
              ended: outcome.ended.length,
            },
          });
          return { outcome, view: written.view, action: written.action };
        });
        const actions = adminModeration(app);
        const effects = await afterCommit(request, 'moderation effects', () => actions.effects(result.outcome), { userId: request.params.id, actionId });
        const end = endsAt ? await afterCommit(request, 'period end job', () => actions.scheduleEnd(actionId, userId, endsAt), { actionId }) : 'done';
        return { user: userDetailOf(app, cfg, result.view, userReadScope(app, request)), action: actionOf(result.action, userReadScope(app, request)), sideEffects: worst(effects, end) };
      },
    );
  }

  app.post(
    '/v1/admin/users/:id/lift',
    {
      preHandler: app.requirePermission('users.lift'),
      config: { pgBudget: 2 },
      schema: { tags, summary: 'Lift a warning, suspension, ban or shadowban before its end', params: userParams, body: adminLiftRequestSchema, response: { 200: adminActionResultSchema } },
    },
    async (request) => {
      const userId = readUserParam(app, request.params.id);
      const { actionId, reasonText } = request.body;
      const adminId = adminIdOf(request);
      const liftId = await withIdLease(() => app.ids.nextId());
      const result = await adminWrite(app, request, async (tx, trail) => {
        const written = await adminRevokeModeration(tx, actionId, liftId, { adminId, reasonText });
        const outcome = written.outcome;
        if (outcome.outcome !== 'revoked' || outcome.userId !== userId || !written.view || !written.action) {
          throw new HttpProblem('not_found', { detail: 'No such action on this person.' });
        }
        // The bans made for the action go with it, each with its row.
        for (const ban of outcome.deviceBans) trail.record(removedBanAuditOf(app, userId, actionId, ban, 'lift'));
        if (outcome.already && sameState(outcome) && outcome.deviceBans.length === 0) {
          trail.unchanged();
          return { outcome, view: written.view, action: written.action, changed: false };
        }
        const lifted = !outcome.already && outcome.kind >= 2;
        trail.record({
          action: 'user.lift',
          target: 'user',
          targetId: userId,
          detail: {
            actionId,
            kind: moderationKind.name(outcome.kind),
            liftId: lifted ? liftId : null,
            reasonText: reasonText ?? null,
            before: stateOf(outcome.before),
            after: stateOf(outcome.after),
            deviceBansRemoved: outcome.deviceBans.length,
          },
        });
        return { outcome, view: written.view, action: written.action, changed: true };
      });
      let sideEffects: 'done' | 'failed';
      if (result.changed) {
        // The person hears of a lift only when their account moved (a lifted warning reads revoked in their history).
        const effect = sameState(result.outcome) ? { ...result.outcome, action: null } : result.outcome;
        sideEffects = await afterCommit(request, 'moderation effects', () => adminModeration(app).effects(effect), { userId: request.params.id, actionId });
      } else {
        // Lifted before: the own view is read again (it repairs a lift whose side failed).
        sideEffects = await afterCommit(request, 'account version', () => accountChanged(app, userId, false), { userId: request.params.id, actionId });
      }
      return {
        user: userDetailOf(app, app.cfg.get(), result.view, userReadScope(app, request)),
        action: actionOf(result.action, userReadScope(app, request)),
        deviceBansRemoved: result.outcome.deviceBans.length,
        sideEffects,
      };
    },
  );

  app.post(
    '/v1/admin/users/:id/revoke-sessions',
    {
      preHandler: app.requirePermission('users.revoke_sessions'),
      config: { pgBudget: 2 },
      schema: { tags, summary: 'Sign a person out on every device', params: userParams, body: adminRevokeSessionsRequestSchema, response: { 200: adminRevokeSessionsResultSchema } },
    },
    async (request) => {
      const userId = readUserParam(app, request.params.id);
      const note = request.body.note ? request.body.note : null;
      const adminId = adminIdOf(request);
      const actionId = await withIdLease(() => app.ids.nextId());
      const sessionIds = await adminWrite(app, request, async (tx, trail) => {
        const result = await adminRevokeUserSessions(tx, { userId, actionId, adminId, note });
        if (!result.found) throw noSuchUser();
        trail.record({ action: 'user.revoke_sessions', target: 'user', targetId: userId, detail: { sessions: result.sessionIds.length, actionId, note } });
        return result.sessionIds;
      });
      // As a sign-out everywhere: the access tokens stop at once, the refresh grace is forgotten, the socket closes.
      const sideEffects = await afterCommit(
        request,
        'sign out',
        async () => {
          await app.denyList.revokeUser(userId);
          await app.refreshGrace.forget(sessionIds);
          await app.realtime?.disconnect(app.publicIds.user.encode(userId));
        },
        { userId: request.params.id },
      );
      return { sessions: sessionIds.length, sideEffects };
    },
  );

  app.post(
    '/v1/admin/users/:id/delete',
    {
      preHandler: app.requirePermission('users.delete'),
      config: { pgBudget: 3 },
      schema: { tags, summary: "Delete a person's account (restorable in the grace, as an app deletion)", params: userParams, body: adminDeleteUserRequestSchema, response: { 200: adminDeleteUserResultSchema } },
    },
    async (request) => {
      const userId = readUserParam(app, request.params.id);
      const note = request.body.note ? request.body.note : null;
      const { outcome, view } = await adminWrite(app, request, async (tx, trail) => {
        const deleted: DeletionOutcome = await scrubbed(() => deleteAccount(tx, { userId }, 3));
        if (deleted.kind === 'none') throw noSuchUser();
        const done = deleted;
        const after = viewOrMissing(await adminUserView(tx, userId));
        if (deleted.kind === 'already') {
          trail.unchanged();
        } else {
          trail.record({
            action: 'user.delete',
            target: 'user',
            targetId: userId,
            detail: {
              before: { status: after.restoreStatus === null ? null : accountStatus.name(after.restoreStatus) },
              after: { status: 'deleted' },
              purgeAt: wireTime(deleted.purgeAtMs),
              note,
            },
          });
        }
        return { outcome: done, view: after };
      });
      const sideEffects = await afterCommit(
        request,
        'deletion steps',
        async () => {
          if ((await adminDeleteAndFinish(app, request, outcome)) === 'failed') throw new Error('deletion steps not taken');
        },
        { userId: request.params.id },
      );
      return { user: userDetailOf(app, app.cfg.get(), view, userReadScope(app, request)), purgeAt: wireTime(outcome.purgeAtMs), sideEffects };
    },
  );

  app.patch(
    '/v1/admin/users/:id/profile',
    {
      preHandler: app.requirePermission('users.edit'),
      config: { pgBudget: 2 },
      schema: { tags, summary: "Replace a person's display name (with the reason)", params: userParams, body: adminRenameRequestSchema, response: { 200: adminUserChangeSchema } },
    },
    async (request) => {
      const userId = readUserParam(app, request.params.id);
      const { displayName, reason, version } = request.body;
      const cfg = app.cfg.get();
      const refused = () => fieldInvalid('/displayName', 'name_refused', 'This name cannot be used.');
      // Terms of every language refuse at once; one of a language only for a person writing in it (known once the row is read).
      if (cfg.bannedTerms.severity(displayName, 'name', null) >= 2) throw refused();
      const reasonCode = textRejectReason.code(reason);
      const adminId = adminIdOf(request);
      const actionId = await withIdLease(() => app.ids.nextId());
      const outcome = await adminWrite(app, request, async (tx, trail) => {
        const renamed = await adminRenameUser(tx, { userId, version, displayName, reasonCode, reasonText: englishReason(cfg, 'text', reasonCode), actionId, adminId });
        if (renamed.outcome === 'missing') throw noSuchUser();
        if (renamed.outcome === 'stale') throw new HttpProblem('conflict', { detail: 'The profile changed; reload it.' });
        // Thrown inside the transaction: the rename and its record roll back.
        if (renamed.outcome === 'renamed' && cfg.bannedTerms.severity(displayName, 'name', renamed.view.locale) >= 2) throw refused();
        if (renamed.outcome === 'unchanged') trail.unchanged();
        // Never the names themselves: the old one is often contact details, and audit rows outlive the account.
        else trail.record({ action: 'user.rename', target: 'user', targetId: userId, detail: { before: { length: [...renamed.before].length }, reason, actionId } });
        return renamed;
      });
      let view = outcome.view;
      if (outcome.outcome === 'renamed') {
        view = { ...view, name: displayName, profile: view.profile ? { ...view.profile, name: displayName, version: outcome.version } : null };
      }
      // The person reads the new name with its reason in their language (GET /v1/me and the `profile` event). A
      // repeated rename (unchanged) reads the own view again, which repairs a version bump that failed before.
      const renamedNow = outcome.outcome === 'renamed';
      const sideEffects = await afterCommit(
        request,
        'rename',
        async () => {
          await accountChanged(app, userId, renamedNow);
          if (renamedNow) await publishToUser(app, userId, 'profile', { name: displayName, nameRejectReason: textRejectText(cfg, reasonCode, personLocale(view.locale)) });
        },
        { userId: request.params.id },
      );
      return { user: userDetailOf(app, cfg, view, userReadScope(app, request)), sideEffects };
    },
  );
};
