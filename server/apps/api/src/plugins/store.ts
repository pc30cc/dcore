import { applyStorePurchase } from '@app/db';
import { PurchaseCore, StoreCatalog } from '@app/shared/server';
import fp from 'fastify-plugin';
import { nextId } from '../auth/sessions.js';
import { BoostService } from '../services/billing/boosts.js';
import { PurchaseService } from '../services/billing/purchases.js';
import { storeVerifiersFrom, type StoreVerifiers } from '../services/billing/verifiers.js';
import type { ConfigSnapshot } from '../services/cfg.js';
import { EntitlementService } from '../services/entitlements.js';

/**
 * The store services of the API: the catalogue (plans and products, built
 * from the configuration snapshot, again after every `cfg:changed`, so a
 * plan or product the panel edits reaches the paywall without a restart), the store integrations
 * (`StoreVerifier` per store; none for a store without credentials), the
 * purchase core shared with the worker, entitlements, purchases and boosts.
 */

export interface StoreServices {
  verifiers: StoreVerifiers;
  /** The catalogue of the configuration loaded now (empty before the first load). */
  catalog(): StoreCatalog;
  core: PurchaseCore;
  entitlements: EntitlementService;
  purchases: PurchaseService;
  boosts: BoostService;
}

declare module 'fastify' {
  interface FastifyInstance {
    store: StoreServices;
  }
}

export interface StoreOptions {
  /** Store integrations (tests pass fakes); otherwise built from the store credentials. */
  verifiers?: StoreVerifiers | undefined;
  now?: (() => number) | undefined;
}

export const storePlugin = fp<StoreOptions>(
  async (app, options) => {
    const verifiers = options.verifiers ?? storeVerifiersFrom(app.config, app.log, { redis: app.redis, keys: app.keys });
    const catalogs = new WeakMap<ConfigSnapshot, StoreCatalog>();
    const empty = StoreCatalog.empty();
    const catalog = (): StoreCatalog => {
      const snapshot = app.cfg.peek();
      if (!snapshot) return empty;
      let built = catalogs.get(snapshot);
      if (!built) {
        built = new StoreCatalog(snapshot.storeProducts, snapshot.plans, { planNames: snapshot.brand.planNames });
        catalogs.set(snapshot, built);
      }
      return built;
    };
    const entitlements = new EntitlementService(app);
    const core = new PurchaseCore({
      apply: (input) => applyStorePurchase(app.pg, input),
      redis: app.redis,
      cache: app.cache,
      keys: app.keys,
      publicIds: app.publicIds,
      realtime: app.realtime,
      ids: { nextId: () => nextId(app) },
      jobs: { add: (name, id, data, opts) => app.jobs.add('iap', name, id, data, opts) },
      settings: () => {
        const cfg = app.cfg.get();
        return { plans: cfg.plans, crossStore: cfg.app['billing.cross_store_entitlements'], catalog: catalog() };
      },
      manageUrl: (store, productId) => entitlements.manageUrl(store, productId),
      log: app.log,
      now: options.now,
    });
    app.decorate('store', {
      verifiers,
      catalog,
      core,
      entitlements,
      purchases: new PurchaseService(app),
      boosts: new BoostService(app),
    });
    app.log.info({ stores: Object.keys(verifiers) }, 'store services ready');
  },
  { name: 'store', fastify: '5.x' },
);
