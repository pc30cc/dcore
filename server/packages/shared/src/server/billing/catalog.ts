import { createHash } from 'node:crypto';
import { productBadge, store as storeCodes, walletItem, type AppStore } from '../../codes.js';
import type { ConsumableProduct, SubscriptionProduct } from '../../api/store.js';

/**
 * The store catalogue in process memory (`store_products`, loaded with the
 * configuration snapshot and again after every `cfg:changed`): request paths
 * look products up without a statement. Inactive rows stay in the lookups
 * (a product no longer sold still names what its buyers hold) and out of
 * the listing apps get. Prices are not here: apps show the store SDK's.
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
}

const PERIODS = new Set(['P1W', 'P1M', 'P3M', 'P6M', 'P12M']);

export interface CatalogListing {
  subscriptions: SubscriptionProduct[];
  consumables: ConsumableProduct[];
}

export class StoreCatalog {
  readonly rows: readonly StoreProductRow[];
  /** Moves whenever any row or plan key changes (part of the products ETag). */
  readonly version: string;
  private readonly byId = new Map<number, StoreProductRow>();
  private readonly byProduct = new Map<string, StoreProductRow[]>();
  private readonly listings = new Map<number, CatalogListing>();

  constructor(rows: readonly StoreProductRow[], plans: readonly CatalogPlan[]) {
    this.rows = rows;
    const planKeys = new Map(plans.map((p) => [p.id, p.key]));
    this.version = createHash('sha256')
      .update(JSON.stringify(rows))
      .update(JSON.stringify(plans.map((p) => [p.id, p.key])))
      .digest('base64url')
      .slice(0, 12);
    for (const row of rows) {
      this.byId.set(row.id, row);
      const key = `${row.store}:${row.productId}`;
      const list = this.byProduct.get(key) ?? [];
      list.push(row);
      this.byProduct.set(key, list);
    }
    for (const code of new Set(rows.map((r) => r.store))) {
      const active = rows.filter((r) => r.store === code && r.active).sort((a, b) => a.sort - b.sort || a.id - b.id);
      const subscriptions: SubscriptionProduct[] = [];
      const consumables: ConsumableProduct[] = [];
      for (const row of active) {
        const badge = row.badge > 0 ? productBadge.nameOrUndefined(row.badge) : undefined;
        if (row.kind === 1) {
          const plan = row.planId === null ? undefined : planKeys.get(row.planId);
          if ((plan !== 'plus' && plan !== 'premium') || row.period === null || !PERIODS.has(row.period)) continue;
          subscriptions.push({
            productId: row.productId,
            ...(row.basePlanId ? { basePlanId: row.basePlanId } : {}),
            plan,
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
      this.listings.set(code, { subscriptions, consumables });
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

  /** The active products apps may buy in a store. */
  listing(name: AppStore): CatalogListing {
    return this.listings.get(storeCodes.code(name)) ?? { subscriptions: [], consumables: [] };
  }
}
