import { adminUserChatPage, adminUserChats } from '@app/db';
import {
  adminChatListQuerySchema,
  adminChatListSchema,
  adminChatPageQuerySchema,
  adminChatPageSchema,
  encodeCursor,
  idSchema,
  publicUidSchema,
  type AdminChatList,
  type AdminChatPage,
} from '@app/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { adminMessageOf, chatSummaryOf, lowestId, mergeMessagePage, pendingMessagesOf, type StreamReadLimits } from '../admin/chats.js';
import { pageOf, readCursorKey } from '../admin/cursors.js';
import { noSuchUser, readUserParam, userReadScope } from '../admin/refs.js';
import { HttpProblem } from '../lib/problem.js';

/**
 * A person's conversations in the admin panel (users.chats):
 *
 *   GET /v1/admin/users/{id}/chats                     newest conversation first; cursor { c: conversation id }
 *   GET /v1/admin/users/{id}/chats/{conversationId}    a page of messages, newest page first, oldest first in
 *                                                      the page; cursor { m: oldest message id shown }
 *
 * Pure reads: one statement each, plus read-only Valkey commands (GET of the
 * flush watermark, XREVRANGE of wb:msg above it) for the messages not in
 * PostgreSQL yet, read before the statement: a message the writer stores
 * in between is then in the statement's answer (and counted once, by id),
 * never in neither. No audit row and no other record of the read is written
 * (decided 2026-11-27); no read or delivered pointer, unread count, list
 * state, cache entry, realtime event or job comes from it. Nothing here goes
 * through ChatService or ConversationService, whose reads write state. No
 * message text reaches a log line: the URL holds ids and an opaque cursor
 * only, and the answer is never logged.
 *
 * Each admin reads at most CHATS_LIST_PER_MINUTE list pages and
 * CHAT_PAGES_PER_MINUTE message pages a minute (the route's own counter,
 * named by the route pattern and the admin only). No HEAD route is exposed:
 * it would run the same reads on a counter of its own.
 */

export const CHATS_LIST_PER_MINUTE = 60;
export const CHAT_PAGES_PER_MINUTE = 120;

const userParams = z.object({ id: publicUidSchema });
const chatParams = z.object({ id: publicUidSchema, conversationId: idSchema });
// Different keys, so a cursor of one route (or of another tab) is a 400 on the other.
const listCursor = z.object({ c: idSchema });
const pageCursor = z.object({ m: idSchema });

const noSuchConversation = () => new HttpProblem('not_found', { detail: 'No such conversation.' });

export interface AdminUserChatRoutesOptions {
  /** The stream read's limits (tests; read on every request). */
  stream?: Partial<StreamReadLimits> | undefined;
}

export const adminUserChatRoutes: FastifyPluginAsyncZod<AdminUserChatRoutesOptions> = async (app, routeOptions) => {
  const tags = ['admin'];
  const chats = app.requirePermission('users.chats');
  const options = () => ({ unmatchedDays: app.cfg.get().app['retention.unmatched_messages_days'], nowMs: Date.now() });
  const limits = () => routeOptions.stream ?? {};

  app.get(
    '/v1/admin/users/:id/chats',
    {
      preHandler: chats,
      exposeHeadRoute: false,
      config: { pgBudget: 1, rateLimit: { max: CHATS_LIST_PER_MINUTE, timeWindow: 60_000 } },
      schema: {
        tags,
        summary: 'Every conversation of a person, newest first (read only)',
        params: userParams,
        querystring: adminChatListQuerySchema,
        response: { 200: adminChatListSchema },
      },
    },
    async (request, reply): Promise<AdminChatList> => {
      const userId = readUserParam(app, request.params.id);
      const { limit, cursor } = request.query;
      const beforeId = readCursorKey(listCursor, cursor)?.c ?? null;
      // The person's conversations are known only after the statement: every conversation's entries (ids and kinds).
      const pending = await pendingMessagesOf(app, request.log, { matchIds: null }, limits());
      const since = lowestId([...pending.byMatch.values()].flat());
      const { found, value } = await adminUserChats(app.pg, userId, { beforeId, limit: limit + 1, since });
      if (!found) throw noSuchUser();
      const scope = userReadScope(app, request);
      const settings = options();
      reply.header('cache-control', 'no-store');
      return {
        ...pageOf(
          value,
          limit,
          (row) => chatSummaryOf(app, row, pending.byMatch.get(row.id) ?? [], scope, settings),
          (row) => ({ c: row.id }),
        ),
        streamComplete: pending.read === 'complete',
      };
    },
  );

  app.get(
    '/v1/admin/users/:id/chats/:conversationId',
    {
      preHandler: chats,
      exposeHeadRoute: false,
      config: { pgBudget: 1, rateLimit: { max: CHAT_PAGES_PER_MINUTE, timeWindow: 60_000 } },
      schema: {
        tags,
        summary: "A page of one of a person's conversations, newest page first (read only)",
        params: chatParams,
        querystring: adminChatPageQuerySchema,
        response: { 200: adminChatPageSchema },
      },
    },
    async (request, reply): Promise<AdminChatPage> => {
      const userId = readUserParam(app, request.params.id);
      const conversationId = request.params.conversationId;
      const { limit, cursor } = request.query;
      const beforeId = readCursorKey(pageCursor, cursor)?.m ?? null;
      // The stream before the database: an entry stored and trimmed in between is in the statement's answer.
      const pending = await pendingMessagesOf(app, request.log, { matchIds: new Set([conversationId]), before: beforeId }, limits());
      const ofConversation = pending.byMatch.get(conversationId) ?? [];
      const page = await adminUserChatPage(app.pg, { userId, conversationId, beforeId, limit: limit + 1, since: lowestId(ofConversation) });
      if (!page.found) throw noSuchUser();
      if (!page.matched) throw noSuchConversation();
      const scope = userReadScope(app, request);
      const merged = mergeMessagePage(page.rows, ofConversation, { before: beforeId, limit, cutAt: pending.cutAt });
      reply.header('cache-control', 'no-store');
      return {
        conversation: page.conversation ? chatSummaryOf(app, page.conversation, ofConversation, scope, options()) : null,
        items: merged.rows.map((row) => adminMessageOf(row, userId, scope, page.shadows)),
        nextCursor: merged.next === null ? null : encodeCursor({ m: merged.next }),
        stream: pending.read,
      };
    },
  );
};
