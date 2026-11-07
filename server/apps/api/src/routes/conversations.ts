import { conversationParamsSchema, conversationsPageSchema, conversationsQuerySchema } from '@app/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ConversationService } from '../services/conversations.js';
import { requireScope, sessionOf } from '../services/session.js';
import { notModified } from './me.js';

/**
 * `GET /v1/conversations`: the person's conversations, newest activity
 * first (a snoozed account keeps its own). The first page carries the
 * list's version as its ETag (`cv:<uid>`): a 304 costs no statement and no
 * list read. Warm, the page costs no statement either.
 *
 * `DELETE /v1/conversations/:id`: an unmatch (one statement).
 */

function etagOf(version: number): string {
  return `"cv-${version}"`;
}

function matches(header: string | string[] | undefined, etag: string): boolean {
  return typeof header === 'string' && header.split(',').some((tag) => tag.trim() === etag || tag.trim() === `W/${etag}`);
}

export const conversationRoutes: FastifyPluginAsyncZod = async (app) => {
  const fullOnly = requireScope(app, app.account, ['full']);

  app.get(
    '/v1/conversations',
    {
      preHandler: fullOnly,
      config: { pgBudget: 0 },
      schema: {
        tags: ['conversations'],
        summary: 'The conversation list',
        querystring: conversationsQuerySchema,
        response: { 200: conversationsPageSchema },
      },
    },
    async (request, reply) => {
      const session = sessionOf(app, request);
      const service = new ConversationService(app, request);
      const first = request.query.cursor === undefined;
      if (first) {
        const etag = etagOf(await service.version(session.userId));
        reply.header('etag', etag).header('cache-control', 'private, no-cache');
        if (matches(request.headers['if-none-match'], etag)) return notModified(reply);
      }
      return service.page(session.userId, request.query.limit, request.query.cursor);
    },
  );

  app.delete(
    '/v1/conversations/:id',
    {
      preHandler: fullOnly,
      config: { pgBudget: 0 },
      schema: {
        tags: ['conversations'],
        summary: 'Unmatch',
        params: conversationParamsSchema,
      },
    },
    async (request, reply) => {
      const session = sessionOf(app, request);
      await new ConversationService(app, request).unmatch(session.userId, request.params.id, app.cfg.get());
      return reply.code(204).send();
    },
  );
};
