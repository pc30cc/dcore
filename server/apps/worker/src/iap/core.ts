import { loadBrand } from '@app/config';
import { applyStorePurchase, configSnapshot } from '@app/db';
import { parseAppConfig, type AppStore, type Brand } from '@app/shared';
import { PurchaseCore, StoreCatalog, manageUrlByCode, type BillingSettings, type KeyBuilder, type PurchaseRef } from '@app/shared/server';
import type { KnownPurchase, Pool } from '@app/db';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { JobContext } from '../queues/types.js';
import type { WorkerServices } from '../services.js';
import { queueJob } from '../social/jobs.js';

/**
 * The purchase core in the worker: the same one the API runs (one statement
 * per state change, then the token record, the entitlements version, the
 * `entitlement` event and the next jobs), with the plans, the cross-store
 * flag and the store catalogue from the configuration snapshot, loaded
 * again when `cfg:v` moved (looked at no more than every 30 seconds).
 */

export const BILLING_SETTINGS_CHECK_MS = 30_000;

export class BillingSettingsSource {
  private current: (BillingSettings & { version: number }) | null = null;
  private checkedAt = 0;
  private loading: Promise<BillingSettings> | null = null;

  constructor(private readonly options: { pg: Pool; redis: Redis; keys: KeyBuilder; log: Logger }) {}

  async get(): Promise<BillingSettings> {
    if (this.current && Date.now() - this.checkedAt < BILLING_SETTINGS_CHECK_MS) return this.current;
    this.loading ??= this.refresh().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async refresh(): Promise<BillingSettings> {
    const { pg, redis, keys, log } = this.options;
    let version: number;
    try {
      version = Number((await redis.get(keys.configVersion())) ?? '0') || 0;
    } catch (error) {
      if (this.current) return this.current;
      throw error;
    }
    if (this.current?.version === version) {
      this.checkedAt = Date.now();
      return this.current;
    }
    try {
      const rows = await configSnapshot(pg);
      const { config } = parseAppConfig(Object.entries(rows.appConfig).map(([key, value]) => ({ key, value })));
      this.current = {
        version,
        plans: rows.plans,
        crossStore: config['billing.cross_store_entitlements'],
        catalog: new StoreCatalog(rows.storeProducts, rows.plans),
      };
      this.checkedAt = Date.now();
      return this.current;
    } catch (error) {
      if (this.current) {
        log.error({ err: error }, 'billing settings: reload failed; keeping the last good settings');
        return this.current;
      }
      throw error;
    }
  }
}

const sources = new WeakMap<WorkerServices, BillingSettingsSource>();

export function billingSettingsOf(services: WorkerServices, redis: Redis, log: Logger): BillingSettingsSource {
  let source = sources.get(services);
  if (!source) {
    source = new BillingSettingsSource({ pg: services.pg, redis, keys: services.keys, log });
    sources.set(services, source);
  }
  return source;
}

const loadedBrands = new WeakMap<WorkerServices, Brand>();

/** The brand of the process: the one loaded at start, else (services built without it) `config.brand`'s, read once. */
export function brandOf(context: Pick<JobContext, 'services' | 'config'>): Brand {
  const { services, config } = context;
  if (services.brand) return services.brand;
  let brand = loadedBrands.get(services);
  if (!brand) {
    brand = loadBrand({ brandId: config.brand.id, brandsDir: config.brand.dir });
    loadedBrands.set(services, brand);
  }
  return brand;
}

/** The purchase core of one job, with the settings it loaded. */
export function purchaseCoreOf(context: JobContext, settings: BillingSettings, now?: () => number): PurchaseCore {
  const { services, redis, config, log } = context;
  const brand = brandOf(context);
  return new PurchaseCore({
    apply: (input) => applyStorePurchase(services.pg, input),
    redis,
    cache: services.cache,
    keys: services.keys,
    publicIds: services.publicIds,
    realtime: services.realtime,
    ids: services.ids,
    jobs: { add: (name, id, data, opts) => queueJob(redis, config.queuePrefix, { queue: 'iap', name, id, data, ...opts }) },
    settings: () => settings,
    // The API's rule (the brand's link of the store, else Play's centre), so an event and GET /v1/me/entitlements agree.
    manageUrl: (store, productId) => manageUrlByCode(brand, store, productId),
    log,
    now,
  });
}

/** A stored purchase as the store integrations take it. */
export function purchaseRefOf(purchase: KnownPurchase, store: AppStore): PurchaseRef {
  return {
    purchaseId: purchase.id,
    store,
    kind: purchase.kind === 1 ? 'subscription' : 'consumable',
    token: purchase.token,
    productId: purchase.productId,
    basePlanId: purchase.basePlanId,
    orderId: purchase.orderId,
    purchasedAtMs: purchase.purchasedAtMs,
    expiresAtMs: purchase.expiresAtMs,
    quantity: purchase.quantity,
  };
}
