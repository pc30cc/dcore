import { androidApplicationId, type Brand } from '../../brand.js';
import { store as storeCodes, type AppStore } from '../../codes.js';

/**
 * Where a person manages (cancels) a store subscription, for the API's
 * answers and the worker's events alike: the brand's own link of the store
 * (`stores.<store>.subscriptionsUrl`), else Google Play's subscription
 * centre (with the product and the Play build's application id, when both
 * are known); Cafe Bazaar has no web page of its own, so none without the
 * brand's link.
 */

/** Google Play's own subscription centre. */
export const PLAY_SUBSCRIPTIONS_URL = 'https://play.google.com/store/account/subscriptions';

export function manageUrlOf(brand: Brand, store: AppStore, productId: string | null): string | undefined {
  const own = brand.stores?.[store]?.subscriptionsUrl;
  if (own) return own;
  if (store !== 'play') return undefined;
  const url = new URL(PLAY_SUBSCRIPTIONS_URL);
  const packageName = androidApplicationId(brand, 'play');
  if (productId && packageName) {
    url.searchParams.set('sku', productId);
    url.searchParams.set('package', packageName);
  }
  return url.toString();
}

/** {@link manageUrlOf} by store code (`store_purchases.store`); undefined for grants (0) and unknown codes. */
export function manageUrlByCode(brand: Brand, store: number, productId: string | null): string | undefined {
  const name = storeCodes.nameOrUndefined(store);
  if (name !== 'play' && name !== 'bazaar') return undefined;
  return manageUrlOf(brand, name, productId);
}
