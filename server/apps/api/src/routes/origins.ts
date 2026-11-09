import { originsDocumentSchema } from '@app/shared';
import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { HttpProblem } from '../lib/problem.js';
import { notModified } from './me.js';

/**
 * `GET /v1/origins`: the signed origins document (where the apps find the
 * API, realtime, call signalling, the CDN and the website). Built in memory
 * from the configuration, so it sends no statement; `If-None-Match` with the
 * current ETag gets a 304. Any build may ask: no `X-Client` is needed, and
 * neither the minimum version nor maintenance applies (an old app must still
 * learn where the server moved). Cacheable at the edge for five minutes; the
 * same bytes are published as static copies by the worker.
 */
export const originsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/v1/origins',
    {
      config: {
        pgBudget: 0,
        client: { header: 'none', minVersion: false, maintenance: false },
        rateLimit: { max: 60, timeWindow: 60_000 },
      },
      schema: {
        tags: ['config'],
        summary: 'The signed list of the hosts apps connect to',
        response: { 200: originsDocumentSchema },
      },
    },
    async (request, reply) => {
      app.cfg.get(); // 503 until the configuration loaded
      const served = app.origins.current();
      if (!served) {
        throw new HttpProblem('service_unavailable', { detail: 'The origins document is not configured.', headers: { 'retry-after': '300' } });
      }
      reply.header('etag', served.etag);
      reply.header('cache-control', 'public, max-age=300, stale-if-error=86400');
      const inm = request.headers['if-none-match'];
      if (typeof inm === 'string' && inm.split(',').some((tag) => tag.trim() === served.etag || tag.trim() === `W/${served.etag}`)) {
        return notModified(reply);
      }
      // Signed and serialized when it was built; the bytes are what the signature covers.
      return (reply as unknown as FastifyReply).type('application/json; charset=utf-8').serializer((payload) => payload as string).send(served.body);
    },
  );
};
