import { callAcceptanceSchema, callBodySchema, callParamsSchema, callTokenSchema, placeCallSchema } from '@app/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { CallService } from '../services/calls.js';
import { requireScope } from '../services/session.js';

/**
 * `/v1/calls`: calls between the two people of an active conversation.
 * Every route costs no statement while its caches are warm (a placement
 * reads the pair once when they are cold, a `rang` the callee's own view);
 * the finished call reaches PostgreSQL in the worker's finalize job.
 *
 *   POST /v1/calls                 { conversationId, kind }   201 { call }
 *   GET  /v1/calls/:id                                        200 { call }   (only while the socket is down)
 *   POST /v1/calls/:id/rang        callee's phone showed it   204
 *   POST /v1/calls/:id/accept      callee                     200 { call, token }
 *   POST /v1/calls/:id/decline     callee                     200 { call }
 *   POST /v1/calls/:id/cancel      caller, before the answer  200 { call }
 *   POST /v1/calls/:id/end         either                     200 { call }
 *   POST /v1/calls/:id/token       either, while answered     200 CallToken
 */

/** Per person, whichever device asks. */
const perUser = (prefix: string) => (request: FastifyRequest) => `${prefix}:${request.principal?.subject ?? request.ip}`;

export const callRoutes: FastifyPluginAsyncZod = async (app) => {
  const fullOnly = requireScope(app, app.account, ['full']);
  const service = (request: FastifyRequest) => new CallService(app, request);

  app.post(
    '/v1/calls',
    {
      preHandler: fullOnly,
      config: { pgBudget: 0 },
      schema: { tags: ['calls'], summary: 'Place a call in a conversation', body: placeCallSchema, response: { 201: callBodySchema } },
    },
    async (request, reply) => {
      const call = await service(request).place(request.body);
      return reply.code(201).send({ call });
    },
  );

  app.get(
    '/v1/calls/:id',
    {
      preHandler: fullOnly,
      config: { pgBudget: 0 },
      schema: { tags: ['calls'], summary: 'A call (while the realtime socket is down)', params: callParamsSchema, response: { 200: callBodySchema } },
    },
    async (request) => ({ call: await service(request).get(request.params.id) }),
  );

  app.post(
    '/v1/calls/:id/rang',
    {
      preHandler: fullOnly,
      config: { pgBudget: 0, rateLimit: { max: 60, timeWindow: 60_000, keyGenerator: perUser('call-rang') } },
      schema: { tags: ['calls'], summary: 'The ring showed on this phone', params: callParamsSchema },
    },
    async (request, reply) => {
      await service(request).rang(request.params.id);
      return reply.code(204).send();
    },
  );

  app.post(
    '/v1/calls/:id/accept',
    {
      preHandler: fullOnly,
      config: { pgBudget: 0 },
      schema: { tags: ['calls'], summary: 'Answer a ring', params: callParamsSchema, response: { 200: callAcceptanceSchema } },
    },
    async (request) => service(request).accept(request.params.id),
  );

  app.post(
    '/v1/calls/:id/decline',
    {
      preHandler: fullOnly,
      config: { pgBudget: 0 },
      schema: { tags: ['calls'], summary: 'Decline a ring', params: callParamsSchema, response: { 200: callBodySchema } },
    },
    async (request) => ({ call: await service(request).decline(request.params.id) }),
  );

  app.post(
    '/v1/calls/:id/cancel',
    {
      preHandler: fullOnly,
      config: { pgBudget: 0 },
      schema: { tags: ['calls'], summary: 'Cancel a call before the answer', params: callParamsSchema, response: { 200: callBodySchema } },
    },
    async (request) => ({ call: await service(request).cancel(request.params.id) }),
  );

  app.post(
    '/v1/calls/:id/end',
    {
      preHandler: fullOnly,
      config: { pgBudget: 0 },
      schema: { tags: ['calls'], summary: 'Hang up', params: callParamsSchema, response: { 200: callBodySchema } },
    },
    async (request) => ({ call: await service(request).end(request.params.id) }),
  );

  app.post(
    '/v1/calls/:id/token',
    {
      preHandler: fullOnly,
      config: { pgBudget: 0, rateLimit: { max: 30, timeWindow: 60_000, keyGenerator: perUser('call-token') } },
      schema: { tags: ['calls'], summary: 'A join token for the call room', params: callParamsSchema, response: { 200: callTokenSchema } },
    },
    async (request) => service(request).token(request.params.id),
  );
};
