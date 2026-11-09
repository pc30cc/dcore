import { boostRequestSchema, boostStartedSchema, entitlementsSchema, restoreRequestSchema, restoreResultSchema, storeProductsSchema } from '@app/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { HttpProblem } from '../lib/problem.js';
import { activeAccount } from '../services/active.js';
import { requireScope, sessionOf } from '../services/session.js';
import { notModified } from './me.js';

/**
 * The store routes of every build (§3.12); the purchase routes of each store
 * are in storePurchases.ts.
 *
 * - `GET /v1/store/products`: the plans on sale (names in the session's
 *   language, switches, quotas, badge, order) and the active products of the
 *   session's store, and the session's `billingRef`, from memory
 *   (0 statements). The ETag carries the catalogue version (every plan and
 *   product field) and the language, so a plan edited in the panel is never
 *   hidden behind a stored 304. A store this process cannot verify purchases
 *   of (no verifier: its credentials are not set) lists nothing, so no build
 *   sells what the server would refuse; its ETag differs from every ETag of
 *   a listing, so once the store is configured a client's stored ETag
 *   cannot keep the empty answer.
 * - `GET /v1/me/entitlements`: 0 statements warm, one on a miss; 304 on its ETag.
 * - `POST /v1/store/restore`: up to 20 tokens; 0 statements for tokens the
 *   server has recorded, one read for a recorded token whose cache entry is
 *   gone, a verification and one statement for a new one.
 * - `POST /v1/boosts`: 0 statements from the month's allowance, one from the wallet.
 *
 * Products, entitlements and restore serve suspended and banned accounts too.
 */

function ifNoneMatch(request: FastifyRequest, etag: string): boolean {
  const header = request.headers['if-none-match'];
  return typeof header === 'string' && header.split(',').some((tag) => tag.trim() === etag || tag.trim() === `W/${etag}`);
}

export const storeRoutes: FastifyPluginAsyncZod = async (app) => {
  const signedIn = requireScope(app, app.account, ['full', 'restricted']);
  const fullOnly = requireScope(app, app.account, ['full']);
  // Each store whose catalogue was hidden, said once in this process's log.
  const hiddenSaid = new Set<string>();

  app.get(
    '/v1/store/products',
    {
      preHandler: signedIn,
      config: { pgBudget: 0 },
      schema: { tags: ['store'], summary: 'The products of this store build', response: { 200: storeProductsSchema } },
    },
    async (request, reply) => {
      const session = sessionOf(app, request);
      if (!session.store) throw new HttpProblem('store_not_supported', { detail: 'This session belongs to no store build.' });
      app.cfg.get();
      const billingRef = app.publicIds.billing.encode(session.userId);
      if (!app.store.verifiers[session.store]) {
        if (!hiddenSaid.has(session.store)) {
          hiddenSaid.add(session.store);
          app.log.warn({ store: session.store }, 'store: products not listed: this store is not configured in this process');
        }
        // Every listing's ETag starts with `"p`: this one never matches one.
        const etag = `"u-${billingRef}"`;
        reply.header('etag', etag);
        reply.header('cache-control', 'private, no-cache');
        if (ifNoneMatch(request, etag)) return notModified(reply);
        return { store: session.store, billingRef, plans: [], subscriptions: [], consumables: [] };
      }
      const catalog = app.store.catalog();
      const locale = request.locale;
      const etag = `"p${catalog.version}.${locale}-${billingRef}"`;
      reply.header('etag', etag);
      reply.header('cache-control', 'private, no-cache');
      reply.header('vary', 'accept-language');
      if (ifNoneMatch(request, etag)) return notModified(reply);
      const listing = catalog.listing(session.store, locale);
      return { store: session.store, billingRef, plans: listing.plans, subscriptions: listing.subscriptions, consumables: listing.consumables };
    },
  );

  app.get(
    '/v1/me/entitlements',
    {
      preHandler: signedIn,
      // One statement on a cache miss, raised on the budget when it happens.
      config: { pgBudget: 0 },
      schema: { tags: ['store'], summary: 'What this session may use', response: { 200: entitlementsSchema } },
    },
    async (request, reply) => {
      const session = sessionOf(app, request);
      const view = await app.store.entitlements.forSession(request, session.userId, session.storeCode ?? 0);
      reply.header('etag', view.etag);
      reply.header('cache-control', 'private, no-cache');
      if (ifNoneMatch(request, view.etag)) return notModified(reply);
      return view.entitlements;
    },
  );

  app.post(
    '/v1/store/restore',
    {
      preHandler: signedIn,
      config: { pgBudget: 0, rateLimit: { max: 30, timeWindow: 3_600_000 } },
      schema: { tags: ['store'], summary: 'Restore purchases the server may not have', body: restoreRequestSchema, response: { 200: restoreResultSchema } },
    },
    async (request) => {
      const session = sessionOf(app, request);
      return app.store.purchases.restore(request, session, request.body.purchases);
    },
  );

  app.post(
    '/v1/boosts',
    {
      preHandler: fullOnly,
      config: { pgBudget: 0, rateLimit: { max: 20, timeWindow: 3_600_000 } },
      schema: { tags: ['store'], summary: 'Start a boost or a spotlight', body: boostRequestSchema, response: { 201: boostStartedSchema } },
    },
    async (request, reply) => {
      const account = await activeAccount(app, request);
      const started = await app.store.boosts.start(request, account, request.body.kind);
      reply.code(201);
      return { endsAt: started.endsAt };
    },
  );
};
