import { fileAppeal, ownModeration, type OwnAction } from '@app/db';
import { appealBodySchema, appealRequestSchema, appealStatus, moderationHistorySchema, moderationKind, wireTime, type ModerationAction } from '@app/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { scrubbed } from '../lib/dbErrors.js';
import { HttpProblem } from '../lib/problem.js';
import { requireScope, sessionOf } from '../services/session.js';

/**
 * `GET /v1/me/moderation` (the person's warnings, suspensions and bans,
 * with the reason written for them; a shadowban never appears) and
 * `POST /v1/appeals`. Both answer suspended and banned sessions: every
 * penalty carries its reason and an appeal in the app. The actions
 * themselves are written by moderation (reports, the panel).
 */

function actionOf(row: OwnAction): ModerationAction {
  return {
    id: row.id,
    kind: moderationKind.name(row.kind) as ModerationAction['kind'],
    reasonText: row.reasonText,
    startsAt: wireTime(row.startsAtMs),
    ...(row.endsAtMs !== null ? { endsAt: wireTime(row.endsAtMs) } : {}),
    ...(row.appeal
      ? {
          appeal: {
            id: row.appeal.id,
            status: appealStatus.name(row.appeal.status),
            ...(row.appeal.decisionText ? { decisionText: row.appeal.decisionText } : {}),
          },
        }
      : {}),
  };
}

export const moderationRoutes: FastifyPluginAsyncZod = async (app) => {
  const restrictedOk = requireScope(app, app.account, ['full', 'restricted']);

  app.get(
    '/v1/me/moderation',
    {
      preHandler: restrictedOk,
      config: { pgBudget: 1 },
      schema: { tags: ['moderation'], summary: 'Penalties on this account and their appeals', response: { 200: moderationHistorySchema } },
    },
    async (request) => {
      const session = sessionOf(app, request);
      const rows = await scrubbed(() => ownModeration(app.pg, session.userId));
      return { active: rows.filter((r) => r.active).map(actionOf), history: rows.filter((r) => !r.active).map(actionOf) };
    },
  );

  app.post(
    '/v1/appeals',
    {
      preHandler: restrictedOk,
      config: { pgBudget: 1, rateLimit: { max: 10, timeWindow: 86_400_000 } },
      schema: { tags: ['moderation'], summary: 'Appeal a penalty', body: appealRequestSchema, response: { 201: appealBodySchema } },
    },
    async (request, reply) => {
      const session = sessionOf(app, request);
      const { actionId, body } = request.body;
      const outcome = await scrubbed(() => fileAppeal(app.pg, session.userId, actionId, app.ids.nextId(), body));
      switch (outcome.kind) {
        case 'not_found':
          throw new HttpProblem('not_found', { detail: 'No such action on this account.' });
        case 'open':
          throw new HttpProblem('appeal_open', { detail: 'An appeal of this action is already open.' });
        case 'not_appealable':
          throw new HttpProblem('not_appealable', { detail: 'This action can no longer be appealed.' });
        case 'filed':
          await app.account.changed(session.userId);
          return reply.code(201).send({ appeal: { id: outcome.appealId, status: 'open' as const } });
      }
    },
  );
};
