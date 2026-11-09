import { applyStorePurchase } from '@app/db';
import { entitlementsSchema, purchaseResultSchema, restoreResultSchema, storeProductsSchema, type Entitlements } from '@app/shared';
import { FakeRealtimePublisher, FakeStoreVerifier, StoreError, tokenHash } from '@app/shared/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, migratedDatabase, row, seedUser, setAppConfig, startHarness, statements, type Harness, type SeededUser, type TestDatabase } from './accountSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * The store routes after W5's follow-ups:
 *
 * - the products of a store this process cannot verify purchases of (no
 *   verifier) are not listed, at 0 statements, under an ETag no listing
 *   shares (a configured store is never hidden by a stored 304, nor a
 *   listing kept once the store is gone), and the process says so once;
 * - entitlements name the product (and Play base plan) of the subscription
 *   that gives the plan, only for a subscription of the session's own
 *   store, with no statement more on any path;
 * - a restore says per token whether this call added it (`fresh`); known
 *   tokens still cost no statement and no write.
 */

const DAY = 86_400_000;

describe.skipIf(!hasInfrastructure)('store follow-ups: hidden catalogues, the plan’s product, fresh restores', () => {
  let db: TestDatabase;
  let h: Harness;
  const jobs = new MemoryJobProducer();
  const realtime = new FakeRealtimePublisher();
  const play = new FakeStoreVerifier('play');
  const bazaar = new FakeStoreVerifier('bazaar');

  beforeAll(async () => {
    db = await migratedDatabase();
    await db.sql.query(`UPDATE store_products SET is_active = true WHERE product_id IN ('sub.plus', 'sub.premium', 'sub.plus.1m', 'sub.premium.1m', 'cons.superlike.5', 'cons.boost.1')`);
    // Only Play is configured in this process to begin with.
    h = await startHarness(db, {}, { jobs, realtime, store: { verifiers: { play } } });
  }, 90_000);

  afterAll(async () => {
    await h?.close();
    await db?.drop();
  });

  beforeEach(() => {
    play.calls.length = 0;
    play.failures.length = 0;
    bazaar.calls.length = 0;
    bazaar.failures.length = 0;
  });

  const billingRef = (u: SeededUser) => h.app.publicIds.billing.encode(u.id);
  const client = (store: 1 | 2) => (store === 1 ? 'play/120' : 'bazaar/120');
  const products = (u: SeededUser, store: 1 | 2, headers: Record<string, string> = {}) => call(h, '/v1/store/products', { token: u.token, client: client(store), headers });
  const entitlements = (token: string, store: 1 | 2) => call(h, '/v1/me/entitlements', { token, client: client(store) });
  const buyPlay = (u: SeededUser, purchaseToken: string, productId: string, kind: 'subscription' | 'consumable' = 'subscription') =>
    call(h, '/v1/store/play/purchases', { method: 'POST', token: u.token, client: 'play/120', body: { productId, purchaseToken, kind } });
  const restorePlay = (u: SeededUser, purchases: { productId: string; purchaseToken: string; kind: 'subscription' | 'consumable' }[]) =>
    call(h, '/v1/store/restore', { method: 'POST', token: u.token, client: 'play/120', body: { purchases } });
  const hiddenLines = () => h.logs.filter((line) => line.includes('products not listed'));
  const events = (u: SeededUser) => realtime.on(`u:#${u.publicUid}`).filter((e) => e.t === 'entitlement');
  /** Rows a purchase path writes. */
  const written = async () =>
    Number(
      (
        await row<{ n: string }>(
          db,
          `SELECT (SELECT count(*) FROM store_purchases) + (SELECT count(*) FROM store_events) + (SELECT count(*) FROM wallet_ledger) + (SELECT count(*) FROM subscriptions) AS n`,
        )
      ).n,
    );

  async function session(u: SeededUser, store: 1 | 2): Promise<string> {
    const { token } = await h.app.tokens.issue({ kind: 'app', subject: u.publicUid, sessionId: h.app.ids.nextId(), deviceId: u.deviceId, storeCode: store, scope: 'full' });
    return token;
  }

  // ─── S1: no verifier, nothing listed ───────────────────────────────────────

  it('lists nothing for a store this process cannot verify, at 0 statements, and says so once in the log', async () => {
    const u = await seedUser(h, { store: 2, name: 'Bita' });
    const res = await products(u, 2);
    expect(res.statusCode).toBe(200);
    expect(statements(res)).toBe(0);
    expect(storeProductsSchema.parse(res.json())).toEqual({ store: 'bazaar', billingRef: billingRef(u), subscriptions: [], consumables: [] });
    const etag = String(res.headers['etag']);
    expect(etag.startsWith('"p')).toBe(false);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    // Its own ETag answers 304, still at 0 statements.
    const same = await products(u, 2, { 'if-none-match': etag });
    expect(same.statusCode).toBe(304);
    expect(statements(same)).toBe(0);
    // Said once for the process, naming the store and nothing else of the request.
    const other = await seedUser(h, { store: 2, name: 'Dara' });
    expect((await products(other, 2)).statusCode).toBe(200);
    const lines = hiddenLines();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ store: 'bazaar', level: 40 });
    expect(lines[0]).not.toContain(billingRef(u));
    expect(lines[0]).not.toContain(u.publicUid);
    // The configured store lists as before.
    const p = await seedUser(h, { store: 1, name: 'Pari' });
    const listed = storeProductsSchema.parse((await products(p, 1)).json());
    expect(listed.subscriptions.length).toBeGreaterThan(0);
    expect(listed.consumables.length).toBeGreaterThan(0);
  });

  it('a store configured later is listed at once: the stored ETag of the empty answer does not match', async () => {
    const u = await seedUser(h, { store: 2, name: 'Nima' });
    const hidden = await products(u, 2);
    const hiddenTag = String(hidden.headers['etag']);
    h.app.store.verifiers.bazaar = bazaar;
    try {
      const res = await products(u, 2, { 'if-none-match': hiddenTag });
      expect(res.statusCode).toBe(200);
      const body = storeProductsSchema.parse(res.json());
      expect(body.subscriptions.map((s) => s.productId)).toEqual(['sub.plus.1m', 'sub.premium.1m']);
      expect(body.consumables.map((c) => c.productId)).toEqual(['cons.superlike.5', 'cons.boost.1']);
      const listedTag = String(res.headers['etag']);
      expect(listedTag).not.toBe(hiddenTag);
      expect((await products(u, 2, { 'if-none-match': listedTag })).statusCode).toBe(304);

      // And the other way: a store no longer configured never answers 304 to a listing's ETag.
      delete h.app.store.verifiers.bazaar;
      const gone = await products(u, 2, { 'if-none-match': listedTag });
      expect(gone.statusCode).toBe(200);
      expect(storeProductsSchema.parse(gone.json())).toMatchObject({ subscriptions: [], consumables: [] });
    } finally {
      h.app.store.verifiers.bazaar = bazaar;
    }
    // Still one line: the store was said once.
    expect(hiddenLines()).toHaveLength(1);
  });

  // ─── S3: the plan's product ─────────────────────────────────────────────────

  it('names the Play product and base plan of the plan, in the purchase answer, the event and the warm read (0 statements)', async () => {
    const u = await seedUser(h, { store: 1, name: 'Sara' });
    const token = `fu-play-sub-${u.id}`;
    play.put(token, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm3', accountRef: billingRef(u) });
    const bought = await buyPlay(u, token, 'sub.plus');
    expect(bought.statusCode).toBe(200);
    expect(statements(bought)).toBe(1);
    expect(purchaseResultSchema.parse(bought.json()).entitlements).toMatchObject({ plan: 'plus', source: 'play', productId: 'sub.plus', basePlanId: 'm3' });
    expect(events(u).at(-1)?.d).toMatchObject({ store: 'play', productId: 'sub.plus', basePlanId: 'm3' });
    const warm = await entitlements(u.token, 1);
    expect(statements(warm)).toBe(0);
    expect(entitlementsSchema.parse(warm.json())).toMatchObject({ productId: 'sub.plus', basePlanId: 'm3' });
    // A miss (the cached base gone) reads it in its one statement.
    await h.redis.del(h.app.keys.entitlements(u.id, 1));
    const miss = await entitlements(u.token, 1);
    expect(statements(miss)).toBe(1);
    expect(entitlementsSchema.parse(miss.json())).toMatchObject({ productId: 'sub.plus', basePlanId: 'm3' });

    // A plan change in the store (the upgrade names the old token): the new product shows.
    const upgrade = `fu-play-upgrade-${u.id}`;
    play.put(upgrade, { kind: 'subscription', productId: 'sub.premium', basePlanId: 'm1', accountRef: billingRef(u), linkedPurchaseToken: token });
    expect(purchaseResultSchema.parse((await buyPlay(u, upgrade, 'sub.premium')).json()).entitlements).toMatchObject({ plan: 'premium', productId: 'sub.premium', basePlanId: 'm1' });
  });

  it('names a Bazaar product without a base plan; never another store’s product, a grant’s or a free plan’s', async () => {
    const u = await seedUser(h, { store: 2, name: 'Taha' });
    const token = `fu-bz-sub-${u.id}`;
    bazaar.put(token, { kind: 'subscription', productId: 'sub.plus.1m', accountRef: billingRef(u) });
    const bought = await call(h, '/v1/store/bazaar/purchases', {
      method: 'POST',
      token: u.token,
      body: { productId: 'sub.plus.1m', purchaseToken: token, originalJson: '{"x":1}', signature: `fake-sig-${billingRef(u)}`, kind: 'subscription' },
    });
    expect(bought.statusCode).toBe(200);
    const body = purchaseResultSchema.parse(bought.json()).entitlements;
    expect(body).toMatchObject({ plan: 'plus', source: 'bazaar', productId: 'sub.plus.1m' });
    expect(body).not.toHaveProperty('basePlanId');

    // Counted in the Play build too (cross-store on): the plan shows, the Bazaar product does not.
    await setAppConfig(h, 'billing.cross_store_entitlements', true);
    try {
      const inPlay = entitlementsSchema.parse((await entitlements(await session(u, 1), 1)).json());
      expect(inPlay).toMatchObject({ plan: 'plus', source: 'bazaar' });
      expect(inPlay).not.toHaveProperty('productId');
      expect(inPlay).not.toHaveProperty('basePlanId');
    } finally {
      await setAppConfig(h, 'billing.cross_store_entitlements', false);
    }

    // A grant names no product; nor does a free plan.
    const g = await seedUser(h, { store: 1, name: 'Yas' });
    const plus = (await row<{ id: number }>(db, `SELECT id FROM plans WHERE key = 'plus'`)).id;
    await db.sql.query(
      `INSERT INTO entitlement_grants (id, user_id, starts_at, ends_at, plan_id, reason) VALUES ($1, $2, now() - interval '1 minute', now() + interval '7 days', $3, 'test')`,
      [h.app.ids.nextId(), g.id, plus],
    );
    await db.sql.query('SELECT subscription_recompute($1, 0::smallint)', [g.id]);
    await h.app.store.entitlements.changed(null, g.id, 1, { publish: false });
    const granted: Entitlements = entitlementsSchema.parse((await entitlements(g.token, 1)).json());
    expect(granted).toMatchObject({ plan: 'plus', source: 'grant' });
    expect(granted).not.toHaveProperty('productId');
    const free = entitlementsSchema.parse((await entitlements((await seedUser(h, { store: 1, name: 'Zed' })).token, 1)).json());
    expect(free.plan).toBe('free');
    expect(free).not.toHaveProperty('productId');
  });

  // ─── S4: fresh restores ─────────────────────────────────────────────────────

  it('says which tokens this restore added: a new one is fresh once, a known one never, at 0 statements and 0 writes', async () => {
    const u = await seedUser(h, { store: 1, name: 'Omid' });
    const sub = `fu-restore-sub-${u.id}`;
    const pack = `fu-restore-pack-${u.id}`;
    play.put(sub, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1', accountRef: billingRef(u), expiresAtMs: Date.now() + 30 * DAY });
    play.put(pack, { kind: 'consumable', productId: 'cons.boost.1', accountRef: billingRef(u) });
    const items = [
      { productId: 'sub.plus', purchaseToken: sub, kind: 'subscription' as const },
      { productId: 'cons.boost.1', purchaseToken: pack, kind: 'consumable' as const },
    ];
    const first = await restorePlay(u, items);
    expect(first.statusCode).toBe(200);
    const added = restoreResultSchema.parse(first.json());
    expect(added.results).toEqual([
      { purchaseToken: sub, state: 'active', fresh: true },
      { purchaseToken: pack, state: 'purchased', fresh: true },
    ]);
    expect(added.entitlements).toMatchObject({ plan: 'plus', wallet: { boost: 1 } });

    // Again: both known, nothing added, no statement, no write, no store call.
    await entitlements(u.token, 1);
    const before = await written();
    const calls = play.count();
    const again = await restorePlay(u, items);
    expect(statements(again)).toBe(0);
    expect(await written()).toBe(before);
    expect(play.count()).toBe(calls);
    expect(restoreResultSchema.parse(again.json()).results).toEqual([
      { purchaseToken: sub, state: 'active', fresh: false },
      { purchaseToken: pack, state: 'purchased', fresh: false },
    ]);

    // Known from its row only (the record left the cache): one read, still not fresh, no write.
    await h.redis.del(h.app.keys.iapToken(1, tokenHash(pack)));
    const fromRow = await restorePlay(u, [items[1]!]);
    expect(statements(fromRow)).toBe(1);
    expect(await written()).toBe(before);
    expect(restoreResultSchema.parse(fromRow.json()).results).toEqual([{ purchaseToken: pack, state: 'purchased', fresh: false }]);

    // Bought through the purchase route first: a restore of it is not fresh.
    const bought = `fu-restore-bought-${u.id}`;
    play.put(bought, { kind: 'consumable', productId: 'cons.superlike.5', accountRef: billingRef(u) });
    expect((await buyPlay(u, bought, 'cons.superlike.5', 'consumable')).statusCode).toBe(200);
    expect(restoreResultSchema.parse((await restorePlay(u, [{ productId: 'cons.superlike.5', purchaseToken: bought, kind: 'consumable' }])).json()).results).toEqual([
      { purchaseToken: bought, state: 'purchased', fresh: false },
    ]);
  });

  it('a pending purchase the store has since completed is fresh when the restore credits it; nothing that grants nothing is fresh', async () => {
    const u = await seedUser(h, { store: 1, name: 'Lale' });
    const pending = `fu-pending-${u.id}`;
    play.put(pending, { kind: 'consumable', productId: 'cons.superlike.5', state: 'pending', accountRef: billingRef(u) });
    expect((await buyPlay(u, pending, 'cons.superlike.5', 'consumable')).statusCode).toBe(202);
    const item = { productId: 'cons.superlike.5', purchaseToken: pending, kind: 'consumable' as const };
    expect(restoreResultSchema.parse((await restorePlay(u, [item])).json()).results).toEqual([{ purchaseToken: pending, state: 'pending', fresh: false }]);
    play.put(pending, { kind: 'consumable', productId: 'cons.superlike.5', state: 'purchased', accountRef: billingRef(u), eventMs: Date.now() + 1 });
    const paid = restoreResultSchema.parse((await restorePlay(u, [item])).json());
    expect(paid.results).toEqual([{ purchaseToken: pending, state: 'purchased', fresh: true }]);
    expect(paid.entitlements.wallet.superlike).toBe(5);

    // Refused, another account's, the store away, on hold: never fresh.
    const other = await seedUser(h, { store: 1, name: 'Kian' });
    const theirs = `fu-theirs-${other.id}`;
    play.put(theirs, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1', accountRef: billingRef(other) });
    const held = `fu-held-${u.id}`;
    play.put(held, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1', accountRef: billingRef(u), state: 'on_hold', expiresAtMs: Date.now() - DAY });
    const mixed = restoreResultSchema.parse(
      (
        await restorePlay(u, [
          { productId: 'sub.plus', purchaseToken: `fu-junk-${u.id}`, kind: 'subscription' },
          { productId: 'sub.plus', purchaseToken: theirs, kind: 'subscription' },
          { productId: 'sub.plus', purchaseToken: held, kind: 'subscription' },
        ])
      ).json(),
    );
    expect(mixed.results).toEqual([
      { purchaseToken: `fu-junk-${u.id}`, state: 'invalid', fresh: false },
      { purchaseToken: theirs, state: 'other_account', fresh: false },
      { purchaseToken: held, state: 'on_hold', fresh: false },
    ]);
    play.failures.push(new StoreError('unavailable', 'down'));
    const away = `fu-away-${u.id}`;
    play.put(away, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1', accountRef: billingRef(u) });
    expect(restoreResultSchema.parse((await restorePlay(u, [{ productId: 'sub.plus', purchaseToken: away, kind: 'subscription' }])).json()).results).toEqual([
      { purchaseToken: away, state: 'unavailable', fresh: false },
    ]);
    // Sent again once the store answers: added now.
    expect(restoreResultSchema.parse((await restorePlay(u, [{ productId: 'sub.plus', purchaseToken: away, kind: 'subscription' }])).json()).results).toEqual([
      { purchaseToken: away, state: 'active', fresh: true },
    ]);

    // A subscription that recovered from hold grants again, but was granted before: not fresh.
    play.put(held, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1', accountRef: billingRef(u), state: 'active', expiresAtMs: Date.now() + 30 * DAY, eventMs: Date.now() + 1 });
    await h.redis.del(h.app.keys.iapReverify(tokenHash(held)));
    expect(restoreResultSchema.parse((await restorePlay(u, [{ productId: 'sub.plus', purchaseToken: held, kind: 'subscription' }])).json()).results).toEqual([
      { purchaseToken: held, state: 'active', fresh: false },
    ]);
  });

  it('a purchase the server holds without an owner (a notification came first) is fresh for the account that restores it', async () => {
    const u = await seedUser(h, { store: 1, name: 'Arya' });
    const token = `fu-unclaimed-${u.id}`;
    const productRef = (await row<{ id: number }>(db, `SELECT id FROM store_products WHERE store = 1 AND product_id = 'sub.plus' AND base_plan_id = 'm6'`)).id;
    const now = Date.now();
    const stored = await applyStorePurchase(h.app.pg, {
      id: h.app.ids.nextId(),
      eventId: h.app.ids.nextId(),
      linkedEventId: h.app.ids.nextId(),
      ledgerId: h.app.ids.nextId(),
      store: 1,
      tokenHash: tokenHash(token),
      token,
      linkedTokenHash: null,
      callerId: null,
      accountUserId: null,
      productRef,
      kind: 1,
      state: 2,
      purchasedAtMs: now - 60_000,
      expiresAtMs: now + 30 * DAY,
      autoRenew: true,
      quantity: 1,
      isTest: true,
      region: null,
      orderId: null,
      acknowledged: false,
      consumed: false,
      eventMs: now - 60_000,
      nextCheckAtMs: null,
      source: 2,
      amountMicros: null,
      currency: null,
    });
    expect(stored).toMatchObject({ outcome: 'applied', state: 11, userId: null });
    play.put(token, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm6', expiresAtMs: now + 30 * DAY });
    const res = await restorePlay(u, [{ productId: 'sub.plus', purchaseToken: token, kind: 'subscription' }]);
    const body = restoreResultSchema.parse(res.json());
    expect(body.results).toEqual([{ purchaseToken: token, state: 'active', fresh: true }]);
    expect(body.entitlements).toMatchObject({ plan: 'plus', productId: 'sub.plus', basePlanId: 'm6' });
  });
});
