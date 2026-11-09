import { describe, expect, it } from 'vitest';
import { entitlementsSchema } from '../../src/index.js';
import {
  FakeStoreVerifier,
  StoreCatalog,
  StoreError,
  boostPeriod,
  buildEntitlements,
  cachedPlanIds,
  entitlementBase,
  entitlementBaseTtl,
  entitlementsEtag,
  parseEntitlementBase,
  retryPlan,
  stateCode,
  tokenHash,
  type EntitlementRowsLike,
  type PlanLike,
  type QuotaCounters,
  type StoreProductRow,
} from '../../src/server/index.js';

/**
 * The store core's pure parts: what a session of each store counts (the
 * cross-store rule), the cached base and its versions, the wire object and
 * its ETag, the catalogue in memory, and the fake store the tests use.
 */

const NOW = Date.UTC(2026, 10, 9, 8, 0, 0);
const DAY = 86_400_000;

const plans: PlanLike[] = [
  { id: 1, key: 'free', rank: 0, features: { daily_likes: 25, weekly_superlikes: 1, daily_dm: 0, monthly_boosts: 0, see_likes: false } },
  { id: 2, key: 'plus', rank: 1, features: { daily_likes: 100, weekly_superlikes: 5, daily_dm: 3, monthly_boosts: 1, see_likes: true, incognito: true } },
  { id: 3, key: 'premium', rank: 2, features: { daily_likes: -1, weekly_superlikes: -1, daily_dm: -1, monthly_boosts: 4, see_likes: true, travel_mode: true } },
];

const use: QuotaCounters = { likes: 3, superlikes: 1, dm: 0, boosts: 0, boostEndsMs: null, version: 4, walletVersion: 7 };

function sub(store: number, planId: number, days = 30): EntitlementRowsLike['subs'][number] {
  return { store, planId, status: store === 0 ? 4 : 1, autoRenew: store !== 0, startedAtMs: NOW - DAY, expiresAtMs: NOW + days * DAY, productId: store === 0 ? null : 'sub.plus', basePlanId: store === 1 ? 'm1' : null };
}

describe('entitlements', () => {
  const rows: EntitlementRowsLike = {
    subs: [sub(1, 3), sub(0, 2, 3), { ...sub(2, 2), expiresAtMs: NOW - 1 }],
    wallet: [
      { item: 1, store: 1, balance: 4 },
      { item: 1, store: 2, balance: 9 },
      { item: 1, store: 0, balance: 1 },
      { item: 2, store: 0, balance: 2 },
    ],
  };

  it('counts the session store and the grants with cross-store off, every store with it on', () => {
    const play = entitlementBase(rows, 1, false, 4, 7, NOW);
    expect(play.plans.sort()).toEqual([2, 3]);
    expect(play.wallet).toEqual({ superlike: 5, boost: 2, spotlight: 0, dm: 0 });
    const bazaar = entitlementBase(rows, 2, false, 4, 7, NOW);
    // The Bazaar row expired; the grant counts in both builds.
    expect(bazaar.plans).toEqual([2]);
    expect(bazaar.wallet.superlike).toBe(10);
    const cross = entitlementBase(rows, 2, true, 4, 7, NOW);
    expect(cross.plans.sort()).toEqual([2, 3]);
    expect(cross.wallet.superlike).toBe(14);
  });

  it('is cached at most an hour and never past the earliest expiry it counts', () => {
    expect(entitlementBaseTtl(entitlementBase(rows, 1, false, 0, 0, NOW), NOW)).toBe(3_600);
    const soon = entitlementBase({ subs: [sub(1, 2, 0.01)], wallet: [] }, 1, false, 0, 0, NOW);
    expect(entitlementBaseTtl(soon, NOW)).toBe(864);
    expect(entitlementBaseTtl(entitlementBase({ subs: [], wallet: [] }, 1, false, 0, 0, NOW), NOW)).toBe(3_600);
  });

  it('refuses a cached base of another version, flag or wallet version, or one that counts an expired row', () => {
    const base = entitlementBase(rows, 1, false, 4, 7, NOW);
    const raw = JSON.stringify(base);
    expect(parseEntitlementBase(raw, false, 4, 7, NOW)).toEqual(base);
    expect(parseEntitlementBase(raw, false, 5, 7, NOW)).toBeNull();
    expect(parseEntitlementBase(raw, true, 4, 7, NOW)).toBeNull();
    expect(parseEntitlementBase(raw, false, 4, 8, NOW)).toBeNull();
    // The gates do not look at the wallet's version; without kv-core they take the cached plan.
    expect(parseEntitlementBase(raw, false, 4, undefined, NOW)).toEqual(base);
    expect(parseEntitlementBase(raw, false, null, undefined, NOW)).toEqual(base);
    expect(parseEntitlementBase(raw, false, 4, 7, NOW + 4 * DAY)).toBeNull();
    expect(parseEntitlementBase('{"v":1,"plans":[2]}', false, 0, 0, NOW)).toBeNull();
    expect(cachedPlanIds(raw)?.sort()).toEqual([2, 3]);
  });

  it('builds the wire object from the best plan, with its source and the store centre', () => {
    const base = entitlementBase(rows, 1, false, 4, 7, NOW);
    const e = buildEntitlements({ base, plans, use: { ...use, boostEndsMs: NOW + 60_000 }, manageUrl: (store, product) => `https://store.test/${store}/${product}`, now: NOW });
    expect(entitlementsSchema.parse(e)).toEqual(e);
    expect(e).toMatchObject({ plan: 'premium', source: 'play', autoRenew: true, manageUrl: 'https://store.test/1/sub.plus', boostEndsAt: new Date(NOW + 60_000).toISOString() });
    expect(e.features.travel_mode).toBe(true);
    expect(e.quotas).toMatchObject({ likes: { limit: -1, used: 3 }, boosts: { limit: 4, used: 0, resetsAt: '2026-12-01T00:00:00.000Z' } });
    // In the Bazaar build only the grant counts: plus, from a grant, no store centre.
    const grant = buildEntitlements({ base: entitlementBase(rows, 2, false, 4, 7, NOW), plans, use, manageUrl: () => 'https://store.test/x', now: NOW });
    expect(grant).toMatchObject({ plan: 'plus', source: 'grant' });
    expect(grant.manageUrl).toBeUndefined();
    const free = buildEntitlements({ base: entitlementBase({ subs: [], wallet: [] }, 2, false, 0, 0, NOW), plans, use, now: NOW });
    expect(free).toMatchObject({ plan: 'free', quotas: { likes: { limit: 25 }, dm: { limit: 0 } } });
    expect(free.planExpiresAt).toBeUndefined();
    expect(free.source).toBeUndefined();
  });

  it('shows a tier the contract does not name as the highest named tier it reaches', () => {
    const gold: PlanLike[] = [...plans, { id: 4, key: 'gold', rank: 3, features: { see_likes: true } }];
    const e = buildEntitlements({ base: entitlementBase({ subs: [{ ...sub(1, 4) }], wallet: [] }, 1, false, 0, 0, NOW), plans: gold, use, now: NOW });
    expect(e.plan).toBe('premium');
    expect(e.features.see_likes).toBe(true);
  });

  it('has an ETag that moves with the rows, the configuration and the counters, and only with them', () => {
    const base = entitlementBase(rows, 1, false, 4, 7, NOW);
    const tag = entitlementsEtag(base, 'cfg1', use, NOW);
    expect(entitlementsEtag(entitlementBase(rows, 1, false, 4, 7, NOW), 'cfg1', use, NOW)).toBe(tag);
    expect(entitlementsEtag(base, 'cfg2', use, NOW)).not.toBe(tag);
    expect(entitlementsEtag(base, 'cfg1', { ...use, likes: 4 }, NOW)).not.toBe(tag);
    expect(entitlementsEtag({ ...base, n: 5 }, 'cfg1', use, NOW)).not.toBe(tag);
    expect(entitlementsEtag(base, 'cfg1', use, NOW + DAY)).not.toBe(tag);
  });

  it('counts boosts per calendar month', () => {
    expect(boostPeriod(Date.UTC(2026, 11, 31, 23, 59))).toMatchObject({ period: '202612', resetsAtMs: Date.UTC(2027, 0, 1) });
    expect(boostPeriod(Date.UTC(2027, 0, 1))).toMatchObject({ period: '202701' });
  });
});

describe('the catalogue in memory', () => {
  const row = (over: Partial<StoreProductRow>): StoreProductRow => ({
    id: 1, store: 1, kind: 1, planId: 2, period: 'P1M', item: null, quantity: null, productId: 'sub.plus', basePlanId: 'm1', badge: 0, sort: 10, active: true, listPriceMinor: null, listCurrency: null, ...over,
  });
  const catalog = new StoreCatalog(
    [
      row({ id: 1 }),
      row({ id: 2, basePlanId: 'w1', period: 'P1W', sort: 9, badge: 1 }),
      row({ id: 3, basePlanId: 'm3', period: 'P3M', active: false }),
      row({ id: 4, store: 2, productId: 'sub.plus.12m', basePlanId: null, period: 'P12M' }),
      row({ id: 5, store: 1, kind: 2, planId: null, period: null, item: 2, quantity: 5, productId: 'cons.boost.5', basePlanId: null, sort: 40, badge: 2 }),
      row({ id: 6, store: 1, planId: 9, basePlanId: 'x1' }),
    ],
    [{ id: 2, key: 'plus' }, { id: 9, key: 'gold' }],
  );

  it('finds rows by product and base plan, inactive ones included', () => {
    expect(catalog.find(1, 'sub.plus', 'm3')?.id).toBe(3);
    expect(catalog.find(1, 'sub.plus', null)).toBeUndefined();
    expect(catalog.find(2, 'sub.plus.12m', null)?.id).toBe(4);
    expect(catalog.find(1, 'cons.boost.5', null)?.id).toBe(5);
    expect(catalog.find(1, 'sub.nope', null)).toBeUndefined();
  });

  it('lists the active products of one store in order, without prices, and skips tiers the wire does not name', () => {
    const listing = catalog.listing('play');
    expect(listing.subscriptions).toEqual([
      { productId: 'sub.plus', basePlanId: 'w1', plan: 'plus', period: 'P1W', badge: 'popular', sort: 9 },
      { productId: 'sub.plus', basePlanId: 'm1', plan: 'plus', period: 'P1M', sort: 10 },
    ]);
    expect(listing.consumables).toEqual([{ productId: 'cons.boost.5', item: 'boost', quantity: 5, badge: 'best_value', sort: 40 }]);
    expect(catalog.listing('bazaar').subscriptions.map((s) => s.period)).toEqual(['P12M']);
    expect(new StoreCatalog(catalog.rows, [{ id: 2, key: 'plus' }]).version).not.toBe(catalog.version);
  });
});

describe('the fake store and the helpers', () => {
  it('refuses a signature that does not verify and reads the account reference from one that does', () => {
    const store = new FakeStoreVerifier('bazaar');
    expect(() => store.inspect({ store: 'bazaar', productId: 'sub.plus.1m', purchaseToken: 'tok-0001', kind: 'subscription', signature: 'AAAA' })).toThrow(StoreError);
    expect(store.inspect({ store: 'bazaar', productId: 'sub.plus.1m', purchaseToken: 'tok-0001', kind: 'subscription', signature: 'fake-sig-abcdefghijklm' })).toEqual({
      productId: 'sub.plus.1m',
      accountRef: 'abcdefghijklm',
    });
    expect(store.calls).toEqual([]);
  });

  it('hashes tokens as the database stores them and maps states to codes', () => {
    expect(tokenHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect([stateCode('pending'), stateCode('active'), stateCode('revoked'), stateCode('purchased'), stateCode('consumed')]).toEqual([1, 2, 8, 12, 10]);
  });

  it('retries with growing gaps and stops at the deadline', () => {
    expect(retryPlan(0, 0, 1_000_000)).toEqual({ action: 'retry', atMs: 30_000 });
    expect(retryPlan(20, 0, 10 * 3_600_000)).toEqual({ action: 'retry', atMs: 30 * 60_000 });
    expect(retryPlan(3, 999_000, 1_000_000)).toEqual({ action: 'retry', atMs: 1_000_000 });
    expect(retryPlan(3, 1_000_000, 1_000_000)).toEqual({ action: 'give_up' });
  });
});
