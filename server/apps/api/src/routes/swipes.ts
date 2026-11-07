import { swipesRequestSchema, swipesResponseSchema } from '@app/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { activeAccount } from '../services/active.js';
import { requireScope } from '../services/session.js';
import { SwipeService } from '../services/swipes.js';

/**
 * `POST /v1/swipes`: 1-20 swipes in the order they were made. A pass costs
 * no statement and a like none on this path (Valkey: the quota, the like
 * script, the stream); a match costs one INSERT, a `check` one look-up, a
 * super like paid from the wallet one transaction of three statements, and
 * a cold own-account view or plan one each. The budget is raised for each
 * of those as it happens. The whole request is refused only past the hourly
 * cap (600 swipes) or for a refused comment.
 */
export const swipeRoutes: FastifyPluginAsyncZod = async (app) => {
  const fullOnly = requireScope(app, app.account, ['full']);

  app.post(
    '/v1/swipes',
    {
      preHandler: fullOnly,
      config: { pgBudget: 0 },
      schema: {
        tags: ['swipes'],
        summary: 'Passes, likes and super likes',
        body: swipesRequestSchema,
        response: { 200: swipesResponseSchema },
      },
    },
    async (request) => {
      const account = await activeAccount(app, request);
      const service = new SwipeService({ app, request, account, cfg: app.cfg.get() });
      return service.run(request.body.swipes);
    },
  );
};
