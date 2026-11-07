import {
  blockListSchema,
  blockParamsSchema,
  blockRequestSchema,
  blocksQuerySchema,
  reportReceiptSchema,
  reportRequestSchema,
} from '@app/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { HttpProblem } from '../lib/problem.js';
import { SafetyService } from '../services/safety.js';
import { requireScope, sessionOf } from '../services/session.js';

/**
 * Safety from the app: blocks and reports. Both are open to every signed-in
 * account with a full session (a snoozed one included: a person must be
 * able to block and report from an existing conversation at any time).
 *
 * - `POST /v1/blocks` (50 a day): one statement; the pair leaves each
 *   other's decks, likes and lists, and an active conversation ends as an
 *   unmatch would (the blocked person cannot tell the difference). 404 when
 *   the target names nobody.
 * - `GET /v1/blocks`: the people this account blocked, newest first; one
 *   statement.
 * - `DELETE /v1/blocks/:target` (50 a day): lifts this account's block; one
 *   statement; 204 whatever the target (nothing to reveal).
 * - `POST /v1/reports` (10 a day): one statement (with its optional block
 *   and, for child safety, the automatic legal hold); 202 with the report id.
 *   404 when the target, or the conversation, photo or call the report
 *   names, is not the reported person's.
 */

const DAY_MS = 86_400_000;

export const safetyRoutes: FastifyPluginAsyncZod = async (app) => {
  const fullOnly = requireScope(app, app.account, ['full']);

  app.post(
    '/v1/blocks',
    {
      preHandler: fullOnly,
      config: { pgBudget: 1, rateLimit: { max: 50, timeWindow: DAY_MS } },
      schema: { tags: ['safety'], summary: 'Block a person', body: blockRequestSchema },
    },
    async (request, reply) => {
      const session = sessionOf(app, request);
      const targetId = app.publicIds.user.decodeId(request.body.target);
      if (targetId === null || targetId === session.userId) throw new HttpProblem('not_found');
      const found = await new SafetyService(app, request).block(session.userId, targetId);
      if (!found) throw new HttpProblem('not_found');
      return reply.code(204).send();
    },
  );

  app.get(
    '/v1/blocks',
    {
      preHandler: fullOnly,
      config: { pgBudget: 1 },
      schema: { tags: ['safety'], summary: 'The people this account blocked', querystring: blocksQuerySchema, response: { 200: blockListSchema } },
    },
    async (request, reply) => {
      const session = sessionOf(app, request);
      reply.header('cache-control', 'private, no-store');
      return new SafetyService(app, request).list(session.userId, request.query.limit, request.query.cursor);
    },
  );

  app.delete(
    '/v1/blocks/:target',
    {
      preHandler: fullOnly,
      config: { pgBudget: 0, rateLimit: { max: 50, timeWindow: DAY_MS } },
      schema: { tags: ['safety'], summary: 'Lift a block', params: blockParamsSchema },
    },
    async (request, reply) => {
      const session = sessionOf(app, request);
      const targetId = app.publicIds.user.decodeId(request.params.target);
      await new SafetyService(app, request).unblock(session.userId, targetId === session.userId ? null : targetId);
      return reply.code(204).send();
    },
  );

  app.post(
    '/v1/reports',
    {
      preHandler: fullOnly,
      config: { pgBudget: 1, rateLimit: { max: 10, timeWindow: DAY_MS } },
      schema: { tags: ['safety'], summary: 'Report a person', body: reportRequestSchema, response: { 202: reportReceiptSchema } },
    },
    async (request, reply) => {
      const session = sessionOf(app, request);
      const targetId = app.publicIds.user.decodeId(request.body.target);
      if (targetId === null || targetId === session.userId) throw new HttpProblem('not_found');
      const reportId = await new SafetyService(app, request).report(session.userId, targetId, request.body);
      if (reportId === null) throw new HttpProblem('not_found');
      return reply.code(202).send({ reportId });
    },
  );
};
