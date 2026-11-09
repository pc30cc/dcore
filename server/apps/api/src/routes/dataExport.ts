import { exportStartedSchema, exportStatusSchema, idTime, wireTime, type ExportStatus } from '@app/shared';
import {
  ACCOUNT_QUEUE,
  EXPORT_EVERY_SECONDS,
  EXPORT_JOB,
  EXPORT_LINK_MIN_SECONDS,
  EXPORT_PENDING_MAX_SECONDS,
  accountJobAttempts,
  exportJobId,
  exportObjectKey,
  parseExportReady,
} from '@app/shared/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { nextId } from '../auth/sessions.js';
import { HttpProblem } from '../lib/problem.js';
import { requireScope, sessionOf } from '../services/session.js';

/**
 * `POST /v1/me/export`: a copy of the account's data, built by the worker
 * (`account/export`) and announced over realtime with a link valid 24 h.
 * One a week per person (`exp:<uid>`, holding the export's id); the same
 * request again within {@link REPEAT_WINDOW_MS} (a retry whose answer was
 * lost, a second tap) gets the same export back. Suspended and banned
 * accounts may ask too: it is their data. No statement.
 *
 * `GET /v1/me/export`: where that export is, from the same key and the
 * job's record of the stored archive (`exp:r:<uid>`), so a link announced
 * while the phone was offline is not lost. The link is presigned here, for
 * what is left of its 24 h. No statement.
 */

/** A request this soon after the last one is the same request. */
export const REPEAT_WINDOW_MS = 2 * 60_000;

const EXPORT_ID = /^[1-9][0-9]{0,18}$/;

/**
 * What the two keys say at `nowMs`: `ready` (with the link's end) only for
 * the week's own export while its link has at least
 * {@link EXPORT_LINK_MIN_SECONDS} left; `pending` while it is not stored yet
 * and younger than {@link EXPORT_PENDING_MAX_SECONDS}; else `none`.
 */
export function exportStateOf(
  requested: string | null,
  ready: string | null,
  nowMs: number,
): { status: 'none' | 'pending' } | { status: 'ready'; exportId: string; expiresAtMs: number } {
  if (!requested || !EXPORT_ID.test(requested)) return { status: 'none' };
  const record = parseExportReady(ready);
  if (record?.id === requested) {
    return record.exp - nowMs >= EXPORT_LINK_MIN_SECONDS * 1_000 ? { status: 'ready', exportId: record.id, expiresAtMs: record.exp } : { status: 'none' };
  }
  return nowMs - idTime(requested).getTime() < EXPORT_PENDING_MAX_SECONDS * 1_000 ? { status: 'pending' } : { status: 'none' };
}

export const dataExportRoutes: FastifyPluginAsyncZod = async (app) => {
  const signedIn = requireScope(app, app.account, ['full', 'restricted']);

  app.post(
    '/v1/me/export',
    {
      preHandler: signedIn,
      config: { pgBudget: 0 },
      schema: { tags: ['account'], summary: 'A copy of this account’s data (one a week)', response: { 202: exportStartedSchema } },
    },
    async (request, reply) => {
      const session = sessionOf(app, request);
      if (!app.media) throw new HttpProblem('service_unavailable', { detail: 'Exports are not available now.', headers: { 'retry-after': '60' } });
      const key = app.keys.exportRequest(session.userId);
      const exportId = nextId(app);
      const taken = await app.redis.set(key, exportId, 'EX', EXPORT_EVERY_SECONDS, 'NX');
      if (taken !== 'OK') {
        const [current, ttl] = await Promise.all([app.redis.get(key), app.redis.ttl(key)]);
        if (current && EXPORT_ID.test(current) && Date.now() - idTime(current).getTime() < REPEAT_WINDOW_MS) {
          return reply.code(202).send({ exportId: current });
        }
        const retry = Math.max(1, ttl);
        throw new HttpProblem('rate_limited', { detail: 'One export a week.', retryAfterSeconds: retry, headers: { 'retry-after': String(retry) } });
      }
      try {
        await app.jobs.add(ACCOUNT_QUEUE, EXPORT_JOB, exportJobId(exportId), { userId: session.userId, exportId }, accountJobAttempts.export);
      } catch (error) {
        // Not queued: the week's export is not used up.
        await app.redis.del(key).catch(() => undefined);
        throw new HttpProblem('service_unavailable', { detail: 'Send the request again in a moment.', headers: { 'retry-after': '5' }, cause: error });
      }
      return reply.code(202).send({ exportId });
    },
  );

  app.get(
    '/v1/me/export',
    {
      preHandler: signedIn,
      config: { pgBudget: 0 },
      schema: { tags: ['account'], summary: 'Where this week’s data export is, with its link while valid', response: { 200: exportStatusSchema } },
    },
    async (request, reply): Promise<ExportStatus> => {
      const session = sessionOf(app, request);
      if (!app.media) throw new HttpProblem('service_unavailable', { detail: 'Exports are not available now.', headers: { 'retry-after': '60' } });
      const [requested, ready] = await app.redis.mget(app.keys.exportRequest(session.userId), app.keys.exportReady(session.userId));
      const now = Date.now();
      const state = exportStateOf(requested ?? null, ready ?? null, now);
      // The answer changes as the job moves: never kept by a cache.
      reply.header('cache-control', 'private, no-store');
      if (state.status !== 'ready') return { status: state.status };
      const link = await app.media.storage.presignGet({
        bucket: app.media.privateBucket,
        key: exportObjectKey(state.exportId),
        expiresInSeconds: Math.floor((state.expiresAtMs - now) / 1_000),
      });
      return { status: 'ready', url: link.url, expiresAt: wireTime(state.expiresAtMs) };
    },
  );
};
