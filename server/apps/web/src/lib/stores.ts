import { storeIds, type Locale, type PublicBrand, type StoreId } from '@app/shared';

/** Google Play's own subscription centre (the list of the account's subscriptions). */
export const PLAY_SUBSCRIPTIONS_URL = 'https://play.google.com/store/account/subscriptions';

/** Stores in the order a visitor of `locale` looks for them: Cafe Bazaar first in Persian. */
export function storeOrder(locale: Locale): readonly StoreId[] {
  return locale === 'fa' ? ['bazaar', 'play'] : storeIds;
}

export interface LiveStore {
  id: StoreId;
  listingUrl: string;
}

/** The stores the app is published in (`live: true` with a listing), in the locale's order. */
export function liveStores(brand: PublicBrand, locale: Locale): LiveStore[] {
  const out: LiveStore[] = [];
  for (const id of storeOrder(locale)) {
    const store = brand.stores[id];
    if (store?.live && store.listingUrl) out.push({ id, listingUrl: store.listingUrl });
  }
  return out;
}

export interface SubscriptionCentre {
  id: StoreId;
  /** Absent when the store has no web page for it (the page then says where to go in the store's app). */
  url: string | undefined;
}

/**
 * Where a subscriber cancels, for each store the brand is configured for
 * (both when it names none): deleting an account does not cancel a store
 * subscription.
 */
export function subscriptionCentres(brand: PublicBrand, locale: Locale): SubscriptionCentre[] {
  const configured = storeOrder(locale).filter((id) => brand.stores[id] !== undefined);
  const ids = configured.length > 0 ? configured : storeOrder(locale);
  return ids.map((id) => ({
    id,
    url: brand.stores[id]?.subscriptionsUrl ?? (id === 'play' ? PLAY_SUBSCRIPTIONS_URL : undefined),
  }));
}
