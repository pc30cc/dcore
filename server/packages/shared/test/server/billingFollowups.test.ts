import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { brandSchema, entitlementsSchema, restoreResultSchema, type Brand } from '../../src/index.js';
import {
  PLAY_SUBSCRIPTIONS_URL,
  buildEntitlements,
  entitlementBase,
  manageUrlByCode,
  manageUrlOf,
  parseEntitlementBase,
  type EntitlementRowsLike,
  type PlanLike,
  type QuotaCounters,
} from '../../src/server/index.js';

/**
 * The one manage-link rule of the API and the worker, and the product of
 * the plan in the entitlements (only the session store's, never another
 * store's, a grant's or a free plan's), read from the base the cache already
 * holds.
 */

const NOW = Date.UTC(2026, 10, 9, 8, 0, 0);
const DAY = 86_400_000;
const plans: PlanLike[] = [
  { id: 1, key: 'free', rank: 0, features: {} },
  { id: 2, key: 'plus', rank: 1, features: { see_likes: true } },
  { id: 3, key: 'premium', rank: 2, features: { see_likes: true } },
];
const use: QuotaCounters = { likes: 0, superlikes: 0, dm: 0, boosts: 0, boostEndsMs: null, version: 1, walletVersion: 1 };

function template(): Record<string, unknown> & { android: { applicationId: Record<string, string> }; stores: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(new URL('../../../../../brands/_template/brand.json', import.meta.url), 'utf8')) as ReturnType<typeof template>;
}

function brand(edit: (raw: ReturnType<typeof template>) => void = () => undefined): Brand {
  const raw = template();
  edit(raw);
  return brandSchema.parse(raw);
}

function row(store: number, planId: number, productId: string | null, basePlanId: string | null): EntitlementRowsLike['subs'][number] {
  return { store, planId, status: 1, autoRenew: true, startedAtMs: NOW - DAY, expiresAtMs: NOW + 30 * DAY, productId, basePlanId };
}

describe('manage links', () => {
  it('uses the brand’s link of the store, else Play’s centre with the product and the Play build’s id, and none for Bazaar', () => {
    const plain = brand((b) => {
      b.android.applicationId['play'] = 'com.example.playbuild';
    });
    expect(manageUrlOf(plain, 'play', 'sub.plus')).toBe(`${PLAY_SUBSCRIPTIONS_URL}?sku=sub.plus&package=com.example.playbuild`);
    expect(manageUrlOf(plain, 'play', null)).toBe(PLAY_SUBSCRIPTIONS_URL);
    expect(manageUrlOf(plain, 'bazaar', 'sub.plus.1m')).toBeUndefined();
    const own = brand((b) => {
      b.stores['bazaar']!['subscriptionsUrl'] = 'https://bazaar.example.test/subs';
      b.stores['play']!['subscriptionsUrl'] = 'https://play.example.test/subs';
    });
    expect(manageUrlOf(own, 'bazaar', 'sub.plus.1m')).toBe('https://bazaar.example.test/subs');
    expect(manageUrlOf(own, 'play', 'sub.plus')).toBe('https://play.example.test/subs');
    // By store code: 1 Play, 2 Bazaar; grants (0) and unknown codes have none.
    expect(manageUrlByCode(own, 2, 'sub.plus.1m')).toBe('https://bazaar.example.test/subs');
    expect(manageUrlByCode(plain, 1, 'sub.plus')).toBe(manageUrlOf(plain, 'play', 'sub.plus'));
    expect(manageUrlByCode(own, 0, null)).toBeUndefined();
    expect(manageUrlByCode(own, 7, 'x')).toBeUndefined();
  });
});

describe('the plan’s product in the entitlements', () => {
  const build = (rows: EntitlementRowsLike, store: number, crossStore = false) =>
    buildEntitlements({ base: entitlementBase(rows, store, crossStore, 1, 1, NOW), plans, use, now: NOW });

  it('names the Play product and base plan, and a Bazaar product without one, for the session’s own store', () => {
    const play = build({ subs: [row(1, 2, 'sub.plus', 'm3')], wallet: [] }, 1);
    expect(play).toMatchObject({ plan: 'plus', source: 'play', productId: 'sub.plus', basePlanId: 'm3' });
    expect(entitlementsSchema.parse(play)).toEqual(play);
    const bazaar = build({ subs: [row(2, 3, 'sub.premium.12m', null)], wallet: [] }, 2);
    expect(bazaar).toMatchObject({ plan: 'premium', source: 'bazaar', productId: 'sub.premium.12m' });
    expect(bazaar).not.toHaveProperty('basePlanId');
  });

  it('never names another store’s product, a grant’s, or one for a free plan', () => {
    const fromBazaar = build({ subs: [row(2, 3, 'sub.premium.1m', null)], wallet: [] }, 1, true);
    expect(fromBazaar).toMatchObject({ plan: 'premium', source: 'bazaar' });
    expect(fromBazaar).not.toHaveProperty('productId');
    // The session store's lower plan does not stand in for the plan's own source.
    const mixed = build({ subs: [row(1, 2, 'sub.plus', 'm1'), row(2, 3, 'sub.premium.1m', null)], wallet: [] }, 1, true);
    expect(mixed).toMatchObject({ plan: 'premium', source: 'bazaar' });
    expect(mixed).not.toHaveProperty('productId');
    expect(mixed).not.toHaveProperty('basePlanId');
    const grant = build({ subs: [row(0, 2, null, null)], wallet: [] }, 1);
    expect(grant).toMatchObject({ plan: 'plus', source: 'grant' });
    expect(grant).not.toHaveProperty('productId');
    const free = build({ subs: [], wallet: [] }, 1);
    expect(free).not.toHaveProperty('productId');
    // A session of no store (0) is never told a store's product.
    expect(build({ subs: [row(1, 2, 'sub.plus', 'm1')], wallet: [] }, 0, true)).not.toHaveProperty('productId');
  });

  it('comes from a base cached before this field existed: its rows already carry the product, so no cache version moves', () => {
    // A v2 base as the cache holds it (its JSON, written by the earlier code): the counted rows have productId and basePlanId.
    const cached = JSON.stringify({
      v: 2,
      n: 1,
      w: 1,
      x: false,
      st: 1,
      plans: [2],
      subs: [{ store: 1, planId: 2, status: 1, autoRenew: true, expiresAtMs: NOW + 30 * DAY, productId: 'sub.plus', basePlanId: 'w1' }],
      wallet: { superlike: 0, boost: 0, spotlight: 0, dm: 0 },
      d: 'abcdefghijkl',
    });
    const base = parseEntitlementBase(cached, false, 1, 1, NOW);
    expect(base).not.toBeNull();
    expect(buildEntitlements({ base: base!, plans, use, now: NOW })).toMatchObject({ productId: 'sub.plus', basePlanId: 'w1' });
  });
});

describe('restore results', () => {
  it('carry `fresh` on every token', () => {
    const entitlements = build();
    expect(restoreResultSchema.safeParse({ results: [{ purchaseToken: 'opaque-token-0001', state: 'active', fresh: true }], entitlements }).success).toBe(true);
    expect(restoreResultSchema.safeParse({ results: [{ purchaseToken: 'opaque-token-0001', state: 'active' }], entitlements }).success).toBe(false);
  });

  function build() {
    return buildEntitlements({ base: entitlementBase({ subs: [], wallet: [] }, 1, false, 1, 1, NOW), plans, use, now: NOW });
  }
});
