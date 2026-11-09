import { conversationParamsSchema, conversationsPageSchema, conversationsQuerySchema } from '@app/shared';
import { PRESENCE_TTL_SECONDS } from '@app/shared/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ConversationService } from '../services/conversations.js';
import { requireScope, sessionOf } from '../services/session.js';
import { notModified } from './me.js';

/**
 * `GET /v1/conversations`: the person's conversations, newest activity
 * first (a snoozed account keeps its own). The first page carries the
 * list's version (`cv:<uid>`) and the presence epoch as its ETag: a 304
 * costs no statement and no list read, and vouches for the peers' presence
 * (and anything else of theirs that moves no version) for one more epoch at
 * most, so a list a client keeps never shows anyone online for longer than
 * about a minute after they left. Warm, the page costs no statement either.
 *
 * `DELETE /v1/conversations/:id`: an unmatch (one statement).
 */

/** The presence a list shows is cached this long; its ETag changes as often. */
export const LIST_PRESENCE_EPOCH_MS = PRESENCE_TTL_SECONDS * 1_000;

function etagOf(version: number, epoch: number): string {
  return `"cv-${version}-${epoch}"`;
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
        const version = await service.version(session.userId);
        const epoch = Math.floor(Date.now() / LIST_PRESENCE_EPOCH_MS);
        const etag = etagOf(version, epoch);
        reply.header('etag', etag).header('cache-control', 'private, no-cache');
        // The epoch before stands too: a revalidation right after a boundary is not a full read.
        const given = request.headers['if-none-match'];
        if (matches(given, etag) || matches(given, etagOf(version, epoch - 1))) return notModified(reply);
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
