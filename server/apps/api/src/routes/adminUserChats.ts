import { adminUserChatPage, adminUserChatRequests, adminUserChats } from '@app/db';
import {
  adminChatListQuerySchema,
  adminChatListSchema,
  adminChatPageQuerySchema,
  adminChatPageSchema,
  adminChatRequestListQuerySchema,
  adminChatRequestListSchema,
  encodeCursor,
  idTime,
  requestStatus,
  wireTime,
  idSchema,
  publicUidSchema,
  type AdminChatList,
  type AdminChatPage,
  type AdminChatRequestList,
} from '@app/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { adminMessageOf, chatSummaryOf, heldEntries, lowestId, mergeMessagePage, pendingMessagesOf, type PendingMessages, type StreamReadLimits } from '../admin/chats.js';
import { pageOf, readCursorKey } from '../admin/cursors.js';
import { noSuchUser, readUserParam, userReadScope, userRefOf } from '../admin/refs.js';
import { HttpProblem } from '../lib/problem.js';

/**
 * A person's conversations in the admin panel (users.chats):
 *
 *   GET /v1/admin/users/{id}/chats                     newest conversation first; cursor { c: conversation id }
 *   GET /v1/admin/users/{id}/chats/{conversationId}    a page of messages, newest page first, oldest first in
 *                                                      the page; cursor { m: oldest message id shown, w: the
 *                                                      stream's place }
 *   GET /v1/admin/users/{id}/chat-requests             the message requests the person sent or received,
 *                                                      newest first; cursor { q: request id }
 *
 * Pure reads: one statement each, plus read-only Valkey commands (GET of the
 * flush watermark, XREVRANGE of wb:msg above it) for the messages not in
 * PostgreSQL yet, read before the statement: a message the writer stores
 * in between is then in the statement's answer (and counted once, by id),
 * never in neither. No audit row and no other record of the read is written
 * (decided 2026-11-27); no read or delivered pointer, unread count, list
 * state, cache entry, realtime event or job comes from it. Nothing here goes
 * through ChatService or ConversationService, whose reads write state. Not
 * even the request log keeps a read: these routes log at `warn` only, so no
 * line says who opened whose conversation when (a failure logs its error,
 * never the URL); no message text reaches a log line either.
 *
 * Each admin reads at most CHATS_LIST_PER_MINUTE list pages and
 * CHAT_PAGES_PER_MINUTE message pages a minute (the route's own counter,
 * named by the route pattern and the admin only). No HEAD route is exposed:
 * it would run the same reads on a counter of its own.
 */

export const CHATS_LIST_PER_MINUTE = 60;
export const CHAT_REQUESTS_PER_MINUTE = 60;
export const CHAT_PAGES_PER_MINUTE = 120;

const userParams = z.object({ id: publicUidSchema });
const chatParams = z.object({ id: publicUidSchema, conversationId: idSchema });
// Different keys, so a cursor of one route (or of another tab) is a 400 on the other.
const listCursor = z.object({ c: idSchema });
const requestCursor = z.object({ q: idSchema });
const streamId = z.string().regex(/^\d{1,20}-\d{1,20}$/);
/** The next page's bound, and where the stream reads stand (a: the stop; t: the newest entry seen; d: the entries held). */
const pageCursor = z.object({ m: idSchema, w: z.object({ a: streamId.nullable(), t: streamId, d: z.array(streamId).max(32) }).optional() });

/** The next page's cursor: with the stream's place when it fits a cursor, else the bound alone (the next read covers the window again). */
function nextPageCursor(next: string, pending: PendingMessages, conversation: Parameters<typeof heldEntries>[1]): string {
  if (pending.place !== null) {
    const held = heldEntries(pending, conversation, next);
    if (held.length <= 32) {
      try {
        return encodeCursor({ m: next, w: { a: pending.place.stop, t: pending.place.top, d: held } });
      } catch {
        // Too long for a cursor: the bound alone.
      }
    }
  }
  return encodeCursor({ m: next });
}

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
      logLevel: 'warn',
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
      const settings = { ...options(), streamComplete: pending.read === 'complete' };
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
      logLevel: 'warn',
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
      const key = readCursorKey(pageCursor, cursor);
      const beforeId = key?.m ?? null;
      const resume = key?.w ? { stop: key.w.a, top: key.w.t, held: key.w.d } : null;
      // The stream before the database: an entry stored and trimmed in between is in the statement's answer.
      const pending = await pendingMessagesOf(app, request.log, { matchIds: new Set([conversationId]), before: beforeId, resume }, limits());
      const ofConversation = pending.byMatch.get(conversationId) ?? [];
      const page = await adminUserChatPage(app.pg, { userId, conversationId, beforeId, limit: limit + 1, since: lowestId(ofConversation) });
      if (!page.found) throw noSuchUser();
      if (!page.matched) throw noSuchConversation();
      const scope = userReadScope(app, request);
      const merged = mergeMessagePage(page.rows, ofConversation, { before: beforeId, limit, cutAt: pending.cutAt, unsends: pending.unsends });
      reply.header('cache-control', 'no-store');
      return {
        conversation: page.conversation ? chatSummaryOf(app, page.conversation, ofConversation, scope, { ...options(), streamComplete: pending.read === 'complete' }) : null,
        items: merged.rows.map((row) => adminMessageOf(row, userId, scope, page.shadows)),
        nextCursor: merged.next === null ? null : nextPageCursor(merged.next, pending, ofConversation),
        stream: pending.read,
      };
    },
  );
  app.get(
    '/v1/admin/users/:id/chat-requests',
    {
      preHandler: chats,
      exposeHeadRoute: false,
      logLevel: 'warn',
      config: { pgBudget: 1, rateLimit: { max: CHAT_REQUESTS_PER_MINUTE, timeWindow: 60_000 } },
      schema: {
        tags,
        summary: 'Every message request a person sent or received, newest first (read only)',
        params: userParams,
        querystring: adminChatRequestListQuerySchema,
        response: { 200: adminChatRequestListSchema },
      },
    },
    async (request, reply): Promise<AdminChatRequestList> => {
      const userId = readUserParam(app, request.params.id);
      const { limit, cursor } = request.query;
      const beforeId = readCursorKey(requestCursor, cursor)?.q ?? null;
      const { found, value } = await adminUserChatRequests(app.pg, userId, { beforeId, limit: limit + 1 });
      if (!found) throw noSuchUser();
      reply.header('cache-control', 'no-store');
      return pageOf(
        value,
        limit,
        (row) => ({
          id: row.id,
          direction: row.direction === 1 ? 'sent' : 'received',
          other: userRefOf(app, row.other),
          status: requestStatus.name(row.status),
          sentAt: wireTime(idTime(row.id)),
          decidedAt: row.decidedAtMs === null ? null : wireTime(row.decidedAtMs),
          body: row.body,
          conversationId: row.matchId,
        }),
        (row) => ({ q: row.id }),
      );
    },
  );
};
