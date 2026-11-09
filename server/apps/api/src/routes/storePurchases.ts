import { bazaarPurchaseRequestSchema, playPurchaseRequestSchema, purchasePendingSchema, purchaseResultSchema } from '@app/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireScope, sessionOf } from '../services/session.js';

/**
 * A purchase the app made, sent for verification: the same core for both
 * stores (services/billing/purchases.ts), through each store's
 * `StoreVerifier`. A store without credentials answers 503
 * `store_unavailable`; a session of the other store build 403
 * `store_not_supported`. 30 an hour per account. Restricted accounts may
 * send purchases (a paid period is never cut silently).
 *
 * Statements: none for a token the server has recorded; one (the purchase
 * core's one transaction) after a store call, plus one on an entitlements
 * cache miss when the answer is built for another store's view.
 */
export const storePurchaseRoutes: FastifyPluginAsyncZod = async (app) => {
  const signedIn = requireScope(app, app.account, ['full', 'restricted']);
  const response = { 200: purchaseResultSchema, 202: purchasePendingSchema };
  const limits = { pgBudget: 0, rateLimit: { max: 30, timeWindow: 3_600_000 } };

  app.post(
    '/v1/store/play/purchases',
    {
      preHandler: signedIn,
      config: limits,
      schema: { tags: ['store'], summary: 'A Google Play purchase to verify', body: playPurchaseRequestSchema, response },
    },
    async (request, reply) => {
      const answer = await app.store.purchases.submit(request, sessionOf(app, request), { store: 'play', ...request.body });
      reply.code(answer.status);
      return answer.body;
    },
  );

  app.post(
    '/v1/store/bazaar/purchases',
    {
      preHandler: signedIn,
      config: limits,
      schema: { tags: ['store'], summary: 'A Cafe Bazaar purchase to verify', body: bazaarPurchaseRequestSchema, response },
    },
    async (request, reply) => {
      const answer = await app.store.purchases.submit(request, sessionOf(app, request), { store: 'bazaar', ...request.body });
      reply.code(answer.status);
      return answer.body;
    },
  );
};
