import {
  conversationBodySchema,
  messageRequestCreateSchema,
  messageRequestParamsSchema,
  messageRequestsPageSchema,
  messageRequestsQuerySchema,
  sentRequestBodySchema,
} from '@app/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { activeAccount } from '../services/active.js';
import { RequestService } from '../services/requests.js';
import { requireScope, sessionOf } from '../services/session.js';

/**
 * Message requests (to someone not matched yet), for active accounts:
 *
 * - `POST /v1/message-requests`: one statement (a cold plan one more); the
 *   free quota, the week's gift, then the wallet; 20 a day at most.
 * - `GET /v1/message-requests?box=inbox|sent`: one statement (the requests
 *   and the other side's visibility and card).
 * - `POST /:id/accept`: one statement; 201 with the new conversation.
 * - `POST /:id/decline` (the sender is never told), `DELETE /:id` (the
 *   sender takes it back): one statement each, 204 whatever the state.
 */
export const requestRoutes: FastifyPluginAsyncZod = async (app) => {
  const fullOnly = requireScope(app, app.account, ['full']);

  app.post(
    '/v1/message-requests',
    {
      preHandler: fullOnly,
      config: { pgBudget: 1, rateLimit: { max: 60, timeWindow: 3_600_000 } },
      schema: {
        tags: ['requests'],
        summary: 'Write to someone not matched yet',
        body: messageRequestCreateSchema,
        response: { 200: sentRequestBodySchema, 201: sentRequestBodySchema },
      },
    },
    async (request, reply) => {
      const account = await activeAccount(app, request);
      const sent = await new RequestService(app, request).send(account, request.body);
      return reply.code(sent.replayed ? 200 : 201).send({ request: sent.request });
    },
  );

  app.get(
    '/v1/message-requests',
    {
      preHandler: fullOnly,
      config: { pgBudget: 1 },
      schema: {
        tags: ['requests'],
        summary: 'Requests received or sent',
        querystring: messageRequestsQuerySchema,
        response: { 200: messageRequestsPageSchema },
      },
    },
    async (request) => {
      const account = await activeAccount(app, request);
      return new RequestService(app, request).box(account.session.userId, request.query.box, request.query.limit, request.query.cursor);
    },
  );

  app.post(
    '/v1/message-requests/:id/accept',
    {
      preHandler: fullOnly,
      config: { pgBudget: 1 },
      schema: {
        tags: ['requests'],
        summary: 'Accept a request: it becomes a conversation',
        params: messageRequestParamsSchema,
        response: { 201: conversationBodySchema },
      },
    },
    async (request, reply) => {
      const account = await activeAccount(app, request);
      const conversation = await new RequestService(app, request).accept(account, request.params.id);
      return reply.code(201).send({ conversation });
    },
  );

  app.post(
    '/v1/message-requests/:id/decline',
    {
      preHandler: fullOnly,
      config: { pgBudget: 1 },
      schema: { tags: ['requests'], summary: 'Decline a request (the sender is never told)', params: messageRequestParamsSchema },
    },
    async (request, reply) => {
      const account = await activeAccount(app, request);
      await new RequestService(app, request).decline(account.session.userId, request.params.id);
      return reply.code(204).send();
    },
  );

  app.delete(
    '/v1/message-requests/:id',
    {
      preHandler: fullOnly,
      config: { pgBudget: 1 },
      schema: { tags: ['requests'], summary: 'Take a request back', params: messageRequestParamsSchema },
    },
    async (request, reply) => {
      const session = sessionOf(app, request);
      await new RequestService(app, request).withdraw(session.userId, request.params.id);
      return reply.code(204).send();
    },
  );
};
