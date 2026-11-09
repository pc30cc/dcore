import { createHash } from 'node:crypto';
import { planBadge, productBadge, store as storeCodes, walletItem, type AppStore } from '../../codes.js';
import type { Locale } from '../../locale.js';
import { FREE_PLAN_KEY, localizedText, planDisplayName, planFlags, planQuotas } from '../../plans.js';
import type { ConsumableProduct, StorePlan, SubscriptionProduct } from '../../api/store.js';

/**
 * The store catalogue in process memory (`store_products` and `plans`,
 * loaded with the configuration snapshot and again after every
 * `cfg:changed`): request paths look products and plans up without a
 * statement. Inactive rows stay in the lookups (a product no longer sold
 * still names what its buyers hold) and out of the listing apps get.
 * Prices are not here: apps show the store SDK's.
 *
 * A plan is on sale when it is active, not archived and not the free plan;
 * a subscription row is listed when it is active, its plan is on sale and
 * its period is one the apps know; a plan is listed (with its names in the
 * session's language, badge, switches and quotas) when at least one of its
 * subscriptions is.
 */

export interface StoreProductRow {
  id: number;
  store: number;
  /** 1 subscription, 2 consumable. */
  kind: number;
  planId: number | null;
  period: string | null;
  /** walletItem code of a consumable. */
  item: number | null;
  quantity: number | null;
  productId: string;
  basePlanId: string | null;
  badge: number;
  sort: number;
  active: boolean;
  listPriceMinor: number | null;
  listCurrency: string | null;
}

export interface CatalogPlan {
  id: number;
  key: string;
  rank: number;
  sort: number;
  active: boolean;
  archivedAtMs: number | null;
  /** planBadge code. */
  badge: number;
  names: Readonly<Record<string, unknown>>;
  descriptions: Readonly<Record<string, unknown>>;
  features: Readonly<Record<string, number | boolean>>;
}

export interface CatalogOptions {
  /** The active brand's plan names, for a locale a plan's own names lack. */
  planNames?: Readonly<Record<string, Partial<Record<Locale, string>>>> | undefined;
}

const PERIODS = new Set(['P1W', 'P1M', 'P3M', 'P6M', 'P12M']);

export interface CatalogListing {
  plans: StorePlan[];
  subscriptions: SubscriptionProduct[];
  consumables: ConsumableProduct[];
}

/** Whether a plan is sold: active, not archived, not everyone's free plan. */
export function planOnSale(plan: Pick<CatalogPlan, 'key' | 'active' | 'archivedAtMs'>): boolean {
  return plan.active && plan.archivedAtMs === null && plan.key !== FREE_PLAN_KEY;
}

export class StoreCatalog {
  readonly rows: readonly StoreProductRow[];
  /** Moves whenever any row, any plan field or the brand's plan names change (part of the products ETag). */
  readonly version: string;
  private readonly byId = new Map<number, StoreProductRow>();
  private readonly byProduct = new Map<string, StoreProductRow[]>();
  private readonly plans: ReadonlyMap<number, CatalogPlan>;
  private readonly planNames: CatalogOptions['planNames'];
  private readonly listings = new Map<string, CatalogListing>();

  constructor(rows: readonly StoreProductRow[], plans: readonly CatalogPlan[], options: CatalogOptions = {}) {
    this.rows = rows;
    this.plans = new Map(plans.map((p) => [p.id, p]));
    this.planNames = options.planNames;
    this.version = createHash('sha256')
      .update(JSON.stringify(rows))
      .update(JSON.stringify(plans))
      .update(JSON.stringify(options.planNames ?? {}))
      .digest('base64url')
      .slice(0, 12);
    for (const row of rows) {
      this.byId.set(row.id, row);
      const key = `${row.store}:${row.productId}`;
      const list = this.byProduct.get(key) ?? [];
      list.push(row);
      this.byProduct.set(key, list);
    }
  }

  static empty(): StoreCatalog {
    return new StoreCatalog([], []);
  }

  product(id: number): StoreProductRow | undefined {
    return this.byId.get(id);
  }

  /** Every row of a product id in a store (Play: one per base plan). */
  productRows(store: number, productId: string): readonly StoreProductRow[] {
    return this.byProduct.get(`${store}:${productId}`) ?? [];
  }

  /** The row of (store, product, base plan); a product with a single row matches without a base plan. */
  find(store: number, productId: string, basePlanId: string | null): StoreProductRow | undefined {
    const rows = this.productRows(store, productId);
    const exact = rows.find((r) => r.basePlanId === basePlanId);
    if (exact) return exact;
    return basePlanId === null && rows.length === 1 ? rows[0] : undefined;
  }

  /** The plans on sale and the active products apps may buy in a store, in `locale` (built once per store and locale). */
  listing(name: AppStore, locale: Locale): CatalogListing {
    const code = storeCodes.code(name);
    const key = `${code}:${locale}`;
    let built = this.listings.get(key);
    if (!built) {
      built = this.build(code, locale);
      this.listings.set(key, built);
    }
    return built;
  }

  private build(code: number, locale: Locale): CatalogListing {
    const active = this.rows.filter((r) => r.store === code && r.active).sort((a, b) => a.sort - b.sort || a.id - b.id);
    const subscriptions: SubscriptionProduct[] = [];
    const consumables: ConsumableProduct[] = [];
    const sold = new Set<number>();
    for (const row of active) {
      const badge = row.badge > 0 ? productBadge.nameOrUndefined(row.badge) : undefined;
      if (row.kind === 1) {
        const plan = row.planId === null ? undefined : this.plans.get(row.planId);
        if (!plan || !planOnSale(plan) || row.period === null || !PERIODS.has(row.period)) continue;
        sold.add(plan.id);
        subscriptions.push({
          productId: row.productId,
          ...(row.basePlanId ? { basePlanId: row.basePlanId } : {}),
          plan: plan.key,
          period: row.period as SubscriptionProduct['period'],
          ...(badge && badge !== 'none' ? { badge } : {}),
          sort: row.sort,
        });
      } else {
        const item = walletItem.nameOrUndefined(row.item);
        if (!item || row.quantity === null) continue;
        consumables.push({ productId: row.productId, item, quantity: row.quantity, ...(badge && badge !== 'none' ? { badge } : {}), sort: row.sort });
      }
    }
    const plans = [...this.plans.values()]
      .filter((plan) => sold.has(plan.id))
      .sort((a, b) => a.sort - b.sort || a.rank - b.rank || a.id - b.id)
      .map((plan): StorePlan => {
        const badge = plan.badge > 0 ? planBadge.nameOrUndefined(plan.badge) : undefined;
        const description = localizedText(plan.descriptions, locale);
        return {
          key: plan.key,
          rank: plan.rank,
          sort: plan.sort,
          name: planDisplayName(plan.key, plan.names, this.planNames, locale),
          ...(description ? { description } : {}),
          ...(badge && badge !== 'none' ? { badge } : {}),
          features: planFlags(plan.features),
          quotas: planQuotas(plan.features),
        };
      });
    return { plans, subscriptions, consumables };
  }
}
