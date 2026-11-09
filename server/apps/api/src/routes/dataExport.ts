import { exportStartedSchema, idTime } from '@app/shared';
import { ACCOUNT_QUEUE, EXPORT_EVERY_SECONDS, EXPORT_JOB, accountJobAttempts, exportJobId } from '@app/shared/server';
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
 */

/** A request this soon after the last one is the same request. */
export const REPEAT_WINDOW_MS = 2 * 60_000;

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
      const key = app.keys.raw('exp', session.userId);
      const exportId = nextId(app);
      const taken = await app.redis.set(key, exportId, 'EX', EXPORT_EVERY_SECONDS, 'NX');
      if (taken !== 'OK') {
        const [current, ttl] = await Promise.all([app.redis.get(key), app.redis.ttl(key)]);
        if (current && /^[1-9][0-9]{0,18}$/.test(current) && Date.now() - idTime(current).getTime() < REPEAT_WINDOW_MS) {
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
};
