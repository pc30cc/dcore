import { likesPageSchema, likesQuerySchema, profileCardSchema, profileParamsSchema } from '@app/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { HttpProblem } from '../lib/problem.js';
import { activeAccount } from '../services/active.js';
import { LikesService } from '../services/likes.js';
import { requireScope } from '../services/session.js';

/**
 * `GET /v1/likes`: who liked the account, from its like buckets; one
 * statement for the page's visibility and cards, a second for the liked
 * items and comments with see-likes.
 *
 * `GET /v1/profiles/:publicUid`: a profile opened from chat, likes or
 * requests; one statement (the visibility rule and the card). A person the
 * viewer may not see is `404 not_found`, as an unknown one.
 */
export const likeRoutes: FastifyPluginAsyncZod = async (app) => {
  const fullOnly = requireScope(app, app.account, ['full']);

  app.get(
    '/v1/likes',
    {
      preHandler: fullOnly,
      config: { pgBudget: 0 },
      schema: {
        tags: ['likes'],
        summary: 'People who liked the account',
        querystring: likesQuerySchema,
        response: { 200: likesPageSchema },
      },
    },
    async (request) => {
      const account = await activeAccount(app, request);
      return new LikesService(app, request, account, app.cfg.get()).page(request.query.limit, request.query.cursor);
    },
  );

  app.get(
    '/v1/profiles/:publicUid',
    {
      preHandler: fullOnly,
      config: {
        pgBudget: 0,
        rateLimit: {
          max: 120,
          timeWindow: 3_600_000,
          keyGenerator: (request) => `profiles:${request.principal?.subject ?? request.clientIp ?? request.ip}`,
        },
      },
      schema: {
        tags: ['likes'],
        summary: 'A profile opened from a list',
        params: profileParamsSchema,
        response: { 200: profileCardSchema },
      },
    },
    async (request) => {
      const account = await activeAccount(app, request);
      const targetId = app.publicIds.user.decodeId(request.params.publicUid);
      if (targetId === null) throw new HttpProblem('not_found');
      return new LikesService(app, request, account, app.cfg.get()).profile(targetId);
    },
  );
};
