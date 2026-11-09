import { renewingSubscription, restoreAccount } from '@app/db';
import {
  accountStatus,
  deletionPreflightSchema,
  deletionRequestSchema,
  deletionScheduledSchema,
  restoredAccountSchema,
  store as storeCodes,
  wireTime,
  type AppStore,
  type AuthUser,
} from '@app/shared';
import { manageUrlOf } from '@app/shared/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { scrubbed } from '../lib/dbErrors.js';
import { HttpProblem } from '../lib/problem.js';
import { deleteAndFinish } from '../services/deletion.js';
import { requireScope, sessionOf, unauthorized } from '../services/session.js';

/**
 * Deleting the account in the app, and undoing it within the grace:
 *
 * - `GET /v1/me/deletion/preflight`: a store subscription that renews by
 *   itself, which deleting does not cancel (the app says so and links the
 *   store's subscription centre). One read of `subscriptions`.
 * - `POST /v1/me/deletion`: status 7 (see services/deletion.ts); suspended
 *   and banned accounts may delete too. 3 a day.
 * - `POST /v1/me/restore`: back to the status the account had, until the
 *   purge time. The session that asks is a `restore` session (a sign-in of
 *   a deleted account); a refresh then gives it the full scope.
 */

export const deletionRoutes: FastifyPluginAsyncZod = async (app) => {
  const deletable = requireScope(app, app.account, ['full', 'restricted']);
  const restorable = requireScope(app, app.account, ['restore', 'full', 'restricted']);

  app.get(
    '/v1/me/deletion/preflight',
    {
      preHandler: deletable,
      config: { pgBudget: 1 },
      schema: { tags: ['deletion'], summary: 'What deleting does not cancel', response: { 200: deletionPreflightSchema } },
    },
    async (request) => {
      const session = sessionOf(app, request);
      const renewing = await scrubbed(() => renewingSubscription(app.pg, session.userId, session.storeCode ?? null));
      if (!renewing) return {};
      const store = storeCodes.name(renewing.store) as AppStore;
      const manageUrl = manageUrlOf(app.brand, store, renewing.productId);
      return { subscription: { store, active: true as const, ...(manageUrl ? { manageUrl } : {}) } };
    },
  );

  app.post(
    '/v1/me/deletion',
    {
      preHandler: deletable,
      // One statement; a second (a read) when the account was deleted before.
      config: { pgBudget: 2, rateLimit: { max: 3, timeWindow: 86_400_000 } },
      schema: {
        tags: ['deletion'],
        summary: 'Delete this account (restorable until the purge time)',
        body: deletionRequestSchema.nullish(),
        response: { 202: deletionScheduledSchema },
      },
    },
    async (request, reply) => {
      const session = sessionOf(app, request);
      const result = await deleteAndFinish(app, request, { userId: session.userId }, 1, { reason: request.body?.reason });
      if (!result) throw unauthorized();
      reply.header('cache-control', 'no-store');
      return reply.code(202).send({ purgeAt: wireTime(result.purgeAtMs) });
    },
  );

  app.post(
    '/v1/me/restore',
    {
      preHandler: restorable,
      config: { pgBudget: 2, rateLimit: { max: 10, timeWindow: 3_600_000 } },
      schema: { tags: ['deletion'], summary: 'Undo the deletion of this account', response: { 200: restoredAccountSchema } },
    },
    async (request) => {
      const session = sessionOf(app, request);
      const outcome = await scrubbed(() => restoreAccount(app.pg, session.userId));
      if (outcome.kind === 'gone') throw unauthorized();
      if (outcome.kind === 'expired') {
        throw new HttpProblem('conflict', { detail: 'The time to restore this account is over.' });
      }
      if (outcome.kind === 'restored') {
        request.log.info({ status: outcome.status }, 'account restored');
        await app.account.changed(session.userId);
        // Out of the hidden set at once (it is trimmed after three hours anyway).
        await app.redis.zrem(app.keys.accountsHidden(), session.userId).catch((error: unknown) => request.log.warn({ err: error }, 'restore: vis:out not updated'));
      }
      const user: AuthUser = {
        id: session.publicUid,
        status: accountStatus.name(outcome.status) as AuthUser['status'],
        onboardingStep: outcome.onboardingStep,
      };
      return { user };
    },
  );
};
