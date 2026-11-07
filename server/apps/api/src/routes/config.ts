import { configQuerySchema, configSchema } from '@app/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply } from 'fastify';
import { documentKey } from '../services/cfg.js';
import { notModified } from './me.js';

/**
 * `GET /v1/config?store=&locale=`: the configuration every client reads
 * before anyone signs in. The documents are built in memory when the
 * configuration loads (one per store and locale), so this route sends no
 * statement; `If-None-Match` with the current ETag gets a 304. Cacheable at
 * the edge for five minutes; nothing in it depends on who asks.
 */
export const configRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/v1/config',
    {
      config: {
        pgBudget: 0,
        rateLimit: { max: 60, timeWindow: 60_000 },
      },
      schema: {
        tags: ['config'],
        summary: 'Run-time configuration for one store and language',
        querystring: configQuerySchema,
        response: { 200: configSchema },
      },
    },
    async (request, reply) => {
      const { store, locale } = request.query;
      const document = app.cfg.get().documents.get(documentKey(store, locale));
      if (!document) throw new Error(`no configuration document for ${store}/${locale}`);
      reply.header('etag', document.etag);
      reply.header('cache-control', 'public, max-age=300');
      const inm = request.headers['if-none-match'];
      if (typeof inm === 'string' && inm.split(',').some((tag) => tag.trim() === document.etag || tag.trim() === `W/${document.etag}`)) {
        return notModified(reply);
      }
      // Already validated and serialized when the configuration loaded.
      return (reply as unknown as FastifyReply).type('application/json; charset=utf-8').serializer((payload) => payload as string).send(document.body);
    },
  );
};
