import {
  conversationParamsSchema,
  conversationPatchSchema,
  conversationSchema,
  messagesPageSchema,
  messagesQuerySchema,
  receiptsSchema,
  sendMessageSchema,
  sentMessageSchema,
} from '@app/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { HttpProblem } from '../lib/problem.js';
import { ChatService } from '../services/chat.js';
import { requireScope, sessionOf } from '../services/session.js';

/**
 * A conversation's messages and settings (a snoozed account keeps its
 * conversations):
 *
 * - `GET /v1/conversations/:id/messages?before=|after=`: a page, oldest
 *   first, with `syncCursor` (below it everything is durable) and the
 *   write-behind lag in `X-Write-Lag-Ms`; one statement (a cold plan one
 *   more). 410 for an ended conversation, 404 for anything else that is not
 *   the person's to read.
 * - `POST /v1/conversations/:id/messages`: no statement (a cold
 *   conversation state one, an unsend of an older message one); 201, or
 *   200 with the same message for a retry with the same client id. 60 a
 *   minute per person, 20 in 10 s per conversation.
 * - `POST …/receipts`: read and delivered pointers, no statement; one of
 *   each per conversation per 2 s.
 * - `POST …/typing`: no statement; one per 3 s.
 * - `PATCH /v1/conversations/:id`: call consent and mute, one statement.
 */

export const WRITE_LAG_HEADER = 'x-write-lag-ms';
const PER_CONVERSATION = { max: 20, windowMs: 10_000 };

export const chatRoutes: FastifyPluginAsyncZod = async (app) => {
  const fullOnly = requireScope(app, app.account, ['full']);

  /** 20 messages per 10 s per person and conversation, counted in Valkey. */
  async function conversationLimit(userId: string, matchId: string): Promise<void> {
    const slot = Math.floor(Date.now() / PER_CONVERSATION.windowMs);
    const key = app.keys.raw('rl', 'msg', userId, matchId, slot);
    let used: number;
    try {
      const replies = await app.redis.multi().incr(key).pexpire(key, PER_CONVERSATION.windowMs * 2).exec();
      used = Number(replies?.[0]?.[1] ?? 0);
    } catch {
      // Valkey is what the send itself needs; its own failure answers then.
      return;
    }
    if (used > PER_CONVERSATION.max) {
      const retry = Math.max(1, Math.ceil(((slot + 1) * PER_CONVERSATION.windowMs - Date.now()) / 1_000));
      throw new HttpProblem('rate_limited', { retryAfterSeconds: retry, headers: { 'retry-after': String(retry) } });
    }
  }

  app.get(
    '/v1/conversations/:id/messages',
    {
      preHandler: fullOnly,
      config: { pgBudget: 1 },
      schema: {
        tags: ['conversations'],
        summary: 'A page of a conversation',
        params: conversationParamsSchema,
        querystring: messagesQuerySchema,
        response: { 200: messagesPageSchema },
      },
    },
    async (request, reply) => {
      const session = sessionOf(app, request);
      const { page, lagMs } = await new ChatService(app, request).history(session, request.params.id, request.query);
      if (lagMs !== null) reply.header(WRITE_LAG_HEADER, String(lagMs));
      reply.header('cache-control', 'private, no-store');
      return page;
    },
  );

  app.post(
    '/v1/conversations/:id/messages',
    {
      preHandler: fullOnly,
      config: { pgBudget: 0, rateLimit: { max: 60, timeWindow: 60_000 } },
      schema: {
        tags: ['conversations'],
        summary: 'Send a message',
        params: conversationParamsSchema,
        body: sendMessageSchema,
        response: { 200: sentMessageSchema, 201: sentMessageSchema },
      },
    },
    async (request, reply) => {
      const session = sessionOf(app, request);
      await conversationLimit(session.userId, request.params.id);
      const sent = await new ChatService(app, request).send(session, request.params.id, request.body);
      return reply.code(sent.replayed ? 200 : 201).send({ message: sent.message });
    },
  );

  app.post(
    '/v1/conversations/:id/receipts',
    {
      preHandler: fullOnly,
      config: { pgBudget: 0 },
      schema: {
        tags: ['conversations'],
        summary: 'Read and delivered pointers',
        params: conversationParamsSchema,
        body: receiptsSchema,
      },
    },
    async (request, reply) => {
      const session = sessionOf(app, request);
      await new ChatService(app, request).receipts(session, request.params.id, request.body.readUpTo, request.body.deliveredUpTo);
      return reply.code(204).send();
    },
  );

  app.post(
    '/v1/conversations/:id/typing',
    {
      preHandler: fullOnly,
      config: { pgBudget: 0 },
      schema: { tags: ['conversations'], summary: 'Typing', params: conversationParamsSchema },
    },
    async (request, reply) => {
      const session = sessionOf(app, request);
      await new ChatService(app, request).typing(session, request.params.id);
      return reply.code(204).send();
    },
  );

  app.patch(
    '/v1/conversations/:id',
    {
      preHandler: fullOnly,
      config: { pgBudget: 1 },
      schema: {
        tags: ['conversations'],
        summary: 'Call consent and mute',
        params: conversationParamsSchema,
        body: conversationPatchSchema,
        response: { 200: conversationSchema },
      },
    },
    async (request) => {
      const session = sessionOf(app, request);
      return new ChatService(app, request).update(session, request.params.id, request.body);
    },
  );
};
