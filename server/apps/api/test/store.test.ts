import { createHash } from 'node:crypto';
import {
  boostStartedSchema,
  entitlementsSchema,
  problemSchemaFor,
  purchasePendingSchema,
  purchaseResultSchema,
  restoreResultSchema,
  storeProductsSchema,
  type Entitlements,
} from '@app/shared';
import { FakeRealtimePublisher, FakeStoreVerifier, StoreError, homeCell, parentCell, tokenHash } from '@app/shared/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, json, migratedDatabase, row, seedUser, startHarness, statements, type Harness, type SeededUser, type TestDatabase } from './accountSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * The store core end to end on PostgreSQL and Valkey, with fake stores
 * behind the `StoreVerifier` interface: the catalogue, purchases of both
 * stores, restore, entitlements with their cache and ETag, the gates that
 * read them, boosts, and the statement budgets of W5 (a purchase is one
 * transaction, a warm entitlements read and a restore of known tokens cost
 * nothing, a repeat of a known token costs nothing).
 */

const DAY = 86_400_000;

describe.skipIf(!hasInfrastructure)('store: products, purchases, restore, entitlements, boosts', () => {
  let db: TestDatabase;
  let h: Harness;
  const jobs = new MemoryJobProducer();
  const realtime = new FakeRealtimePublisher();
  const play = new FakeStoreVerifier('play');
  const bazaar = new FakeStoreVerifier('bazaar');
  const rawIds: string[] = [];

  beforeAll(async () => {
    db = await migratedDatabase();
    // Products exist in both consoles: the panel turned some on.
    await db.sql.query(`UPDATE store_products SET is_active = true WHERE product_id IN ('sub.plus', 'sub.premium', 'sub.plus.1m', 'sub.premium.1m', 'cons.superlike.5', 'cons.boost.1', 'cons.dm.5')`);
    await db.sql.query(`UPDATE store_products SET badge = 1 WHERE product_id = 'sub.plus' AND base_plan_id = 'm1'`);
    h = await startHarness(db, {}, { jobs, realtime, store: { verifiers: { play, bazaar } } });
  }, 90_000);

  afterAll(async () => {
    for (const id of rawIds) for (const body of h?.bodies ?? []) expect(body.includes(`"${id}"`), `raw id ${id} in a response`).toBe(false);
    await h?.close();
    await db?.drop();
  });

  beforeEach(() => {
    play.calls.length = 0;
    bazaar.calls.length = 0;
    play.failures.length = 0;
    bazaar.failures.length = 0;
  });

  async function user(store: 1 | 2, options: { status?: number; scope?: 'full' | 'restricted' } = {}): Promise<SeededUser> {
    const u = await seedUser(h, { store, name: 'Sam', ...options });
    rawIds.push(u.id);
    return u;
  }

  const client = (store: 1 | 2) => (store === 1 ? 'play/120' : 'bazaar/120');

  async function entitlements(u: SeededUser, store: 1 | 2, headers: Record<string, string> = {}) {
    return call(h, '/v1/me/entitlements', { token: u.token, client: client(store), headers });
  }

  function billingRef(u: SeededUser): string {
    return h.app.publicIds.billing.encode(u.id);
  }

  /** A second session of the same person in the other store build. */
  async function otherBuild(u: SeededUser, store: 1 | 2): Promise<string> {
    const { token } = await h.app.tokens.issue({ kind: 'app', subject: u.publicUid, sessionId: h.app.ids.nextId(), deviceId: u.deviceId, storeCode: store, scope: 'full' });
    return token;
  }

  async function buyPlay(u: SeededUser, token: string, productId: string, kind: 'subscription' | 'consumable' = 'subscription') {
    return call(h, '/v1/store/play/purchases', { method: 'POST', token: u.token, client: 'play/120', body: { productId, purchaseToken: token, kind } });
  }

  it('lists the active products of the session store only, with a billing reference that is not the user id', async () => {
    const u = await user(1);
    const res = await call(h, '/v1/store/products', { token: u.token, client: 'play/120' });
    expect(res.statusCode).toBe(200);
    expect(statements(res)).toBe(0);
    const body = storeProductsSchema.parse(res.json());
    expect(body.store).toBe('play');
    expect(body.billingRef).toBe(billingRef(u));
    expect(body.billingRef).not.toBe(u.publicUid);
    expect(body.subscriptions.map((s) => `${s.productId}/${s.basePlanId}`)).toEqual([
      'sub.plus/w1', 'sub.plus/m1', 'sub.plus/m3', 'sub.plus/m6', 'sub.premium/w1', 'sub.premium/m1', 'sub.premium/m3', 'sub.premium/m6',
    ]);
    expect(body.subscriptions.find((s) => s.basePlanId === 'm1' && s.plan === 'plus')?.badge).toBe('popular');
    expect(body.consumables.map((c) => c.productId)).toEqual(['cons.superlike.5', 'cons.boost.1', 'cons.dm.5']);
    expect(JSON.stringify(body)).not.toMatch(/price/i);
    // The same answer is a 304 on its ETag; the Bazaar build sees only Bazaar's products.
    const again = await call(h, '/v1/store/products', { token: u.token, client: 'play/120', headers: { 'if-none-match': String(res.headers['etag']) } });
    expect(again.statusCode).toBe(304);
    const b = await user(2);
    const theirs = storeProductsSchema.parse((await call(h, '/v1/store/products', { token: b.token })).json());
    expect(theirs.store).toBe('bazaar');
    expect(theirs.subscriptions.map((s) => s.productId)).toEqual(['sub.plus.1m', 'sub.premium.1m']);
    expect(theirs.subscriptions.every((s) => s.basePlanId === undefined)).toBe(true);
  });

  it('serves entitlements with 0 statements warm, 1 on a miss, and a 304 on its ETag', async () => {
    const u = await user(2);
    const cold = await entitlements(u, 2);
    expect(cold.statusCode).toBe(200);
    expect(statements(cold)).toBe(1);
    const body = entitlementsSchema.parse(cold.json());
    expect(body.plan).toBe('free');
    expect(body.features.see_likes).toBe(false);
    expect(body.quotas.likes?.limit).toBe(25);
    expect(body.wallet).toEqual({ superlike: 0, boost: 0, spotlight: 0, dm: 0 });
    const warm = await entitlements(u, 2);
    expect(statements(warm)).toBe(0);
    const etag = String(warm.headers['etag']);
    const same = await entitlements(u, 2, { 'if-none-match': etag });
    expect(same.statusCode).toBe(304);
    expect(statements(same)).toBe(0);
  });

  it('a Play subscription: one store call, one transaction, entitlements in the answer and the event, the follow-up jobs', async () => {
    const u = await user(1);
    const token = `play-sub-token-${u.id}`;
    play.put(token, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1', accountRef: billingRef(u), needsAcknowledge: true, expiresAtMs: Date.now() + 30 * DAY });
    const res = await buyPlay(u, token, 'sub.plus');
    expect(res.statusCode).toBe(200);
    expect(statements(res)).toBe(1);
    expect(play.count('verify')).toBe(1);
    const body = purchaseResultSchema.parse(res.json());
    expect(body.purchase).toMatchObject({ state: 'active', productId: 'sub.plus' });
    expect(body.entitlements).toMatchObject({ plan: 'plus', source: 'play', autoRenew: true });
    expect(body.entitlements.manageUrl).toContain('play.google.com/store/account/subscriptions');
    expect(body.entitlements.features.see_likes).toBe(true);
    // The person hears it on their channel.
    const events = realtime.on(`u:#${u.publicUid}`).filter((e) => e.t === 'entitlement');
    expect((events.at(-1)?.d as Entitlements).plan).toBe('plus');
    // Acknowledge from the server, and a look at the end of the period.
    const ids = jobs.jobs.filter((j) => j.queue === 'iap').map((j) => j.id);
    expect(ids).toContain(`ack.${body.purchase.id}`);
    expect(ids.some((id) => id.startsWith(`sub-end.${u.id}.1.`))).toBe(true);
    // The entitlements are warm right away: 0 statements.
    const warm = await entitlements(u, 1);
    expect(statements(warm)).toBe(0);
    expect(entitlementsSchema.parse(warm.json()).plan).toBe('plus');

    // A repeat of the same token (the app's outbox) costs no statement and no store call.
    const repeat = await buyPlay(u, token, 'sub.plus');
    expect(repeat.statusCode).toBe(200);
    expect(statements(repeat)).toBe(0);
    expect(play.count('verify')).toBe(1);
    expect(purchaseResultSchema.parse(repeat.json()).purchase.id).toBe(body.purchase.id);

    // Someone else sending the same token is refused without a statement.
    const other = await user(1);
    const theirs = await buyPlay(other, token, 'sub.plus');
    expect(theirs.statusCode).toBe(409);
    expect(problemSchemaFor('purchase_other_account').parse(theirs.json()).code).toBe('purchase_other_account');
    expect(statements(theirs)).toBe(0);
  });

  it('a pending purchase grants nothing (202)', async () => {
    const u = await user(1);
    const token = `play-pending-token-${u.id}`;
    play.put(token, { kind: 'consumable', productId: 'cons.superlike.5', state: 'pending', accountRef: billingRef(u) });
    const res = await buyPlay(u, token, 'cons.superlike.5', 'consumable');
    expect(res.statusCode).toBe(202);
    expect(purchasePendingSchema.parse(res.json())).toEqual({ purchase: { state: 'pending' } });
    expect(entitlementsSchema.parse((await entitlements(u, 1)).json()).wallet.superlike).toBe(0);
  });

  it('refuses what the store does not confirm, a foreign reference, the other build, and a store without credentials', async () => {
    const u = await user(1);
    // Unknown to the store: 422, nothing written.
    const unknown = await buyPlay(u, `play-unknown-token-${u.id}`, 'sub.plus');
    expect(unknown.statusCode).toBe(422);
    expect(json(unknown)['code']).toBe('purchase_invalid');
    expect(statements(unknown)).toBe(0);
    // Not a product of the catalogue: refused before any store call.
    const notOurs = await buyPlay(u, `play-other-product-${u.id}`, 'sub.gold');
    expect(notOurs.statusCode).toBe(422);
    expect(play.count()).toBe(1);
    // A reference that decodes to nobody: refused, and the purchase is revoked by a job.
    const forged = `play-forged-token-${u.id}`;
    play.put(forged, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1', accountRef: 'aaaaaaaaaaaaa' });
    const refused = await buyPlay(u, forged, 'sub.plus');
    expect(refused.statusCode).toBe(422);
    expect(jobs.jobs.some((j) => j.queue === 'iap' && j.name === 'revoke' && j.id === `revoke.play.${tokenHash(forged)}`)).toBe(true);
    // The store answers 503: the app retries later.
    play.failures.push(new StoreError('unavailable', 'down'));
    const down = await buyPlay(u, `play-down-token-${u.id}`, 'sub.plus');
    expect(down.statusCode).toBe(503);
    expect(json(down)['code']).toBe('store_unavailable');
    // A Bazaar purchase from the Play build.
    const wrong = await call(h, '/v1/store/bazaar/purchases', {
      method: 'POST',
      token: u.token,
      client: 'play/120',
      body: { productId: 'sub.plus.1m', purchaseToken: 'bazaar-token-0001', originalJson: '{}', signature: 'fake-sig-xxxxxxxxxxxxxx', kind: 'subscription' },
    });
    expect(wrong.statusCode).toBe(403);
    expect(json(wrong)['code']).toBe('store_not_supported');
    // A store without credentials answers 503 and the rest keeps working.
    const b = await user(2);
    const saved = h.app.store.verifiers.bazaar;
    delete h.app.store.verifiers.bazaar;
    try {
      const off = await call(h, '/v1/store/bazaar/purchases', {
        method: 'POST',
        token: b.token,
        body: { productId: 'sub.plus.1m', purchaseToken: `bazaar-off-${b.id}`, originalJson: '{}', signature: 'fake-sig-xxxxxxxxxxxxxx', kind: 'subscription' },
      });
      expect(off.statusCode).toBe(503);
      expect(json(off)['code']).toBe('store_unavailable');
      expect((await entitlements(b, 2)).statusCode).toBe(200);
    } finally {
      if (saved) h.app.store.verifiers.bazaar = saved;
    }
  });

  it('Bazaar: a bad signature costs no store call and no write; a payload of another account is refused before the call; a new purchase costs exactly one call', async () => {
    const u = await user(2);
    const before = Number((await row<{ n: string }>(db, 'SELECT count(*)::text AS n FROM store_purchases')).n);
    const bad = await call(h, '/v1/store/bazaar/purchases', {
      method: 'POST',
      token: u.token,
      body: { productId: 'sub.plus.1m', purchaseToken: `bz-bad-${u.id}`, originalJson: '{"x":1}', signature: 'bm90IGEgc2lnbmF0dXJlIGF0IGFsbA==', kind: 'subscription' },
    });
    expect(bad.statusCode).toBe(422);
    expect(statements(bad)).toBe(0);
    expect(bazaar.count()).toBe(0);
    const other = await user(2);
    const theirs = await call(h, '/v1/store/bazaar/purchases', {
      method: 'POST',
      token: u.token,
      body: { productId: 'sub.plus.1m', purchaseToken: `bz-theirs-${u.id}`, originalJson: '{"x":1}', signature: `fake-sig-${billingRef(other)}`, kind: 'subscription' },
    });
    expect(theirs.statusCode).toBe(409);
    expect(bazaar.count()).toBe(0);
    expect(Number((await row<{ n: string }>(db, 'SELECT count(*)::text AS n FROM store_purchases')).n)).toBe(before);

    const token = `bz-good-${u.id}`;
    bazaar.put(token, { kind: 'subscription', productId: 'sub.plus.1m', accountRef: billingRef(u), nextCheckAtMs: Date.now() + 30 * DAY + 3_600_000, refundCheckAtMs: Date.now() + 7 * DAY });
    const good = await call(h, '/v1/store/bazaar/purchases', {
      method: 'POST',
      token: u.token,
      body: { productId: 'sub.plus.1m', purchaseToken: token, originalJson: '{"x":1}', signature: `fake-sig-${billingRef(u)}`, kind: 'subscription' },
    });
    expect(good.statusCode).toBe(200);
    expect(bazaar.count('verify')).toBe(1);
    expect(statements(good)).toBe(1);
    const purchase = purchaseResultSchema.parse(good.json()).purchase;
    const queued = jobs.jobs.filter((j) => j.queue === 'iap').map((j) => j.id);
    expect(queued.some((id) => id.startsWith(`recheck.${purchase.id}.`))).toBe(true);
    expect(queued).toContain(`refund-check.${purchase.id}`);
  });

  it('two requests with one token make one store call', async () => {
    const u = await user(1);
    const token = `play-twice-token-${u.id}`;
    play.put(token, { kind: 'consumable', productId: 'cons.superlike.5', accountRef: billingRef(u) });
    const [a, b] = await Promise.all([buyPlay(u, token, 'cons.superlike.5', 'consumable'), buyPlay(u, token, 'cons.superlike.5', 'consumable')]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(play.count('verify')).toBe(1);
    const ent = entitlementsSchema.parse((await entitlements(u, 1)).json());
    expect(ent.wallet.superlike).toBe(5);
    expect(jobs.jobs.some((j) => j.queue === 'iap' && j.name === 'consume')).toBe(true);
  });

  it('cross-store off: a store subscription counts only in its own build, grants in both, and both subscriptions make premium in both', async () => {
    const u = await user(1);
    const bazaarToken = await otherBuild(u, 2);
    const token = `play-cross-token-${u.id}`;
    play.put(token, { kind: 'subscription', productId: 'sub.premium', basePlanId: 'm1', accountRef: billingRef(u) });
    expect((await buyPlay(u, token, 'sub.premium')).statusCode).toBe(200);
    expect(entitlementsSchema.parse((await entitlements(u, 1)).json()).plan).toBe('premium');
    const inBazaar = entitlementsSchema.parse((await call(h, '/v1/me/entitlements', { token: bazaarToken })).json());
    expect(inBazaar.plan).toBe('free');

    // A Bazaar subscription too: premium in both builds, one row per store.
    const bz = `bz-cross-token-${u.id}`;
    bazaar.put(bz, { kind: 'subscription', productId: 'sub.premium.1m', accountRef: billingRef(u) });
    const bought = await call(h, '/v1/store/bazaar/purchases', {
      method: 'POST',
      token: bazaarToken,
      body: { productId: 'sub.premium.1m', purchaseToken: bz, originalJson: '{"x":1}', signature: `fake-sig-${billingRef(u)}`, kind: 'subscription' },
    });
    expect(bought.statusCode).toBe(200);
    expect(entitlementsSchema.parse((await call(h, '/v1/me/entitlements', { token: bazaarToken })).json()).plan).toBe('premium');
    expect(entitlementsSchema.parse((await entitlements(u, 1)).json()).plan).toBe('premium');
    expect(Number((await row<{ n: string }>(db, 'SELECT count(*)::text AS n FROM subscriptions WHERE user_id = $1', [u.id])).n)).toBe(2);

    // A grant (store 0) counts in both builds.
    const g = await user(2);
    const plus = (await row<{ id: number }>(db, `SELECT id FROM plans WHERE key = 'plus'`)).id;
    await db.sql.query(
      `INSERT INTO entitlement_grants (id, user_id, starts_at, ends_at, plan_id, reason) VALUES ($1, $2, now() - interval '1 minute', now() + interval '7 days', $3, 'test')`,
      [h.app.ids.nextId(), g.id, plus],
    );
    await db.sql.query('SELECT subscription_recompute($1, 0::smallint)', [g.id]);
    await h.app.store.entitlements.changed(null, g.id, 2, { publish: false });
    expect(entitlementsSchema.parse((await entitlements(g, 2)).json())).toMatchObject({ plan: 'plus', source: 'grant' });
    expect(entitlementsSchema.parse((await call(h, '/v1/me/entitlements', { token: await otherBuild(g, 1), client: 'play/120' })).json()).plan).toBe('plus');
  });

  it('banned and suspended accounts still read their entitlements and the manage link, and restore', async () => {
    const u = await user(1);
    const token = `play-banned-token-${u.id}`;
    play.put(token, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm3', accountRef: billingRef(u) });
    expect((await buyPlay(u, token, 'sub.plus')).statusCode).toBe(200);
    await db.sql.query('UPDATE users SET status = 6 WHERE id = $1', [u.id]);
    const { token: restricted } = await h.app.tokens.issue({ kind: 'app', subject: u.publicUid, sessionId: u.sessionId, deviceId: u.deviceId, storeCode: 1, scope: 'restricted' });
    const ent = await call(h, '/v1/me/entitlements', { token: restricted, client: 'play/120' });
    expect(ent.statusCode).toBe(200);
    const body = entitlementsSchema.parse(ent.json());
    expect(body.plan).toBe('plus');
    expect(body.manageUrl).toContain('sku=sub.plus');
    const restore = await call(h, '/v1/store/restore', { method: 'POST', token: restricted, client: 'play/120', body: { purchases: [{ productId: 'sub.plus', purchaseToken: token, kind: 'subscription' }] } });
    expect(restore.statusCode).toBe(200);
    expect(restoreResultSchema.parse(restore.json()).results).toEqual([{ purchaseToken: token, state: 'active', fresh: false }]);
    // The social routes stay closed to them.
    const boost = await call(h, '/v1/boosts', { method: 'POST', token: restricted, client: 'play/120', body: { kind: 'boost' } });
    expect(boost.statusCode).toBe(403);
  });

  it('restore: known tokens cost no statement and no write, a lost record one read, a new token a verification', async () => {
    const u = await user(1);
    const known = `play-restore-known-${u.id}`;
    play.put(known, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1', accountRef: billingRef(u) });
    expect((await buyPlay(u, known, 'sub.plus')).statusCode).toBe(200);
    await entitlements(u, 1);
    const writes = async () => Number((await row<{ n: string }>(db, `SELECT (SELECT count(*) FROM store_events) + (SELECT count(*) FROM store_purchases) AS n`)).n);
    const before = await writes();
    const calls = play.count();
    const res = await call(h, '/v1/store/restore', { method: 'POST', token: u.token, client: 'play/120', body: { purchases: [{ productId: 'sub.plus', purchaseToken: known, kind: 'subscription' }] } });
    expect(res.statusCode).toBe(200);
    expect(statements(res)).toBe(0);
    expect(play.count()).toBe(calls);
    expect(await writes()).toBe(before);

    // The record left the cache: one read, still no write and no store call.
    await h.redis.del(h.app.keys.iapToken(1, tokenHash(known)));
    const lost = await call(h, '/v1/store/restore', { method: 'POST', token: u.token, client: 'play/120', body: { purchases: [{ productId: 'sub.plus', purchaseToken: known, kind: 'subscription' }] } });
    expect(statements(lost)).toBe(1);
    expect(play.count()).toBe(calls);
    expect(await writes()).toBe(before);

    // A token the server never saw is verified; one the store refuses is invalid; another account's is other_account.
    const fresh = `play-restore-new-${u.id}`;
    play.put(fresh, { kind: 'consumable', productId: 'cons.boost.1', accountRef: billingRef(u) });
    const other = await user(1);
    const theirs = `play-restore-theirs-${other.id}`;
    play.put(theirs, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1', accountRef: billingRef(other) });
    expect((await buyPlay(other, theirs, 'sub.plus')).statusCode).toBe(200);
    const mixed = await call(h, '/v1/store/restore', {
      method: 'POST',
      token: u.token,
      client: 'play/120',
      body: {
        purchases: [
          { productId: 'cons.boost.1', purchaseToken: fresh, kind: 'consumable' },
          { productId: 'sub.plus', purchaseToken: `play-restore-junk-${u.id}`, kind: 'subscription' },
          { productId: 'sub.plus', purchaseToken: theirs, kind: 'subscription' },
        ],
      },
    });
    expect(mixed.statusCode).toBe(200);
    const result = restoreResultSchema.parse(mixed.json());
    expect(result.results.map((r) => r.state)).toEqual(['purchased', 'invalid', 'other_account']);
    expect(result.entitlements.wallet.boost).toBe(1);

    const many = Array.from({ length: 21 }, (_, i) => ({ productId: 'sub.plus', purchaseToken: `play-restore-many-${i}-${u.id}`, kind: 'subscription' }));
    expect((await call(h, '/v1/store/restore', { method: 'POST', token: u.token, client: 'play/120', body: { purchases: many } })).statusCode).toBe(400);
  });

  it('a gate reads the same entitlements: incognito opens right after the purchase, without raising the route budget', async () => {
    const u = await user(1);
    const off = await call(h, '/v1/me/settings', { method: 'PATCH', token: u.token, client: 'play/120', body: { incognito: true } });
    expect(off.statusCode).toBe(403);
    expect(json(off)['code']).toBe('entitlement_required');
    const token = `play-gate-token-${u.id}`;
    play.put(token, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'w1', accountRef: billingRef(u) });
    expect((await buyPlay(u, token, 'sub.plus')).statusCode).toBe(200);
    const on = await call(h, '/v1/me/settings', { method: 'PATCH', token: u.token, client: 'play/120', body: { incognito: true } });
    expect(on.statusCode).toBe(200);
    expect(statements(on)).toBeLessThanOrEqual(3);
  });

  it('boosts: the allowance costs no statement, the wallet one; a running boost spends nothing; the cell zset is written in the same MULTI', async () => {
    const u = await user(1);
    const r7 = homeCell({ lat: 41.01, lng: 28.97 });
    await h.redis.set(h.app.keys.location(u.id), `${r7}:1::TR`);
    // Free: no allowance and an empty wallet.
    const none = await call(h, '/v1/boosts', { method: 'POST', token: u.token, client: 'play/120', body: { kind: 'boost' } });
    expect(none.statusCode).toBe(429);
    expect(problemSchemaFor('quota_exceeded').parse(none.json())).toMatchObject({ feature: 'boosts', canBuy: true });

    // Plus has one boost a month.
    const token = `play-boost-plan-${u.id}`;
    play.put(token, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1', accountRef: billingRef(u) });
    expect((await buyPlay(u, token, 'sub.plus')).statusCode).toBe(200);
    await entitlements(u, 1);
    const first = await call(h, '/v1/boosts', { method: 'POST', token: u.token, client: 'play/120', body: { kind: 'boost' } });
    expect(first.statusCode).toBe(201);
    expect(statements(first)).toBeLessThanOrEqual(1);
    const ends = Date.parse(boostStartedSchema.parse(first.json()).endsAt);
    const cell = h.app.keys.boosted(parentCell(r7, 5));
    expect(Number(await h.redis.zscore(cell, u.id))).toBe(ends);
    expect(await h.redis.pttl(h.app.keys.boostActive(u.id))).toBeGreaterThan(29 * 60_000);
    // Running: the same end, nothing spent.
    const again = await call(h, '/v1/boosts', { method: 'POST', token: u.token, client: 'play/120', body: { kind: 'boost' } });
    expect(again.statusCode).toBe(201);
    expect(Date.parse(boostStartedSchema.parse(again.json()).endsAt)).toBe(ends);
    expect(entitlementsSchema.parse((await entitlements(u, 1)).json())).toMatchObject({ boostEndsAt: new Date(ends).toISOString(), quotas: { boosts: { limit: 1, used: 1 } } });

    // The month's boost is used: the next comes from the wallet (one statement), after the running one ends.
    await h.redis.del(h.app.keys.boostActive(u.id));
    const pack = `play-boost-pack-${u.id}`;
    play.put(pack, { kind: 'consumable', productId: 'cons.boost.1', accountRef: billingRef(u) });
    expect((await buyPlay(u, pack, 'cons.boost.1', 'consumable')).statusCode).toBe(200);
    const paid = await call(h, '/v1/boosts', { method: 'POST', token: u.token, client: 'play/120', body: { kind: 'boost' } });
    expect(paid.statusCode).toBe(201);
    expect(statements(paid)).toBe(1);
    expect(entitlementsSchema.parse((await entitlements(u, 1)).json()).wallet.boost).toBe(0);
    // A spotlight comes from the wallet only.
    await h.redis.del(h.app.keys.boostActive(u.id));
    const spot = await call(h, '/v1/boosts', { method: 'POST', token: u.token, client: 'play/120', body: { kind: 'spotlight' } });
    expect(spot.statusCode).toBe(429);
    expect(json(spot)['feature']).toBe('spotlight');
  });

  it('keeps purchase tokens out of every log line', () => {
    const tokens = [...play.purchases.keys(), ...bazaar.purchases.keys()];
    expect(tokens.length).toBeGreaterThan(5);
    for (const line of h.logs) for (const t of tokens) expect(line.includes(t), 'a purchase token in a log line').toBe(false);
    for (const line of h.logs) expect(line.includes(createHash('sha256').update(tokens[0]!).digest('hex'))).toBe(false);
  });
});
