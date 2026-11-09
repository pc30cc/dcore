import { entitlementsSchema, purchaseResultSchema, realtimeEnvelopeSchema, restoreResultSchema } from '@app/shared';
import { FakeRealtimePublisher, FakeStoreVerifier, StoreError, homeCell } from '@app/shared/server';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, migratedDatabase, seedUser, startHarness, statements, type Harness, type SeededUser, type TestDatabase } from './accountSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * Store purchases after review: a known subscription whose record grants
 * nothing but may have recovered (or whose expiry passed) is asked at the
 * store again on a restore or a repeated post, at most once per token every
 * 15 minutes, and answered from the record when the store cannot say; every
 * `entitlement` event names the store build whose view it is.
 */

const DAY = 86_400_000;

describe.skipIf(!hasInfrastructure)('store after review: re-verifying stale tokens, events that name their store', () => {
  let db: TestDatabase;
  let h: Harness;
  const jobs = new MemoryJobProducer();
  const realtime = new FakeRealtimePublisher();
  const play = new FakeStoreVerifier('play');
  const bazaar = new FakeStoreVerifier('bazaar');

  beforeAll(async () => {
    db = await migratedDatabase();
    await db.sql.query(`UPDATE store_products SET is_active = true WHERE product_id IN ('sub.plus', 'sub.plus.1m', 'cons.boost.1')`);
    h = await startHarness(db, {}, { jobs, realtime, store: { verifiers: { play, bazaar } } });
  }, 90_000);

  afterAll(async () => {
    await h?.close();
    await db?.drop();
  });

  beforeEach(() => {
    play.calls.length = 0;
    play.failures.length = 0;
    bazaar.calls.length = 0;
  });

  const billingRef = (u: SeededUser) => h.app.publicIds.billing.encode(u.id);
  const restore = (u: SeededUser, token: string) =>
    call(h, '/v1/store/restore', { method: 'POST', token: u.token, client: 'play/120', body: { purchases: [{ productId: 'sub.plus', purchaseToken: token, kind: 'subscription' }] } });
  const buy = (u: SeededUser, token: string, productId = 'sub.plus', kind: 'subscription' | 'consumable' = 'subscription') =>
    call(h, '/v1/store/play/purchases', { method: 'POST', token: u.token, client: 'play/120', body: { productId, purchaseToken: token, kind } });
  const events = (u: SeededUser) => realtime.on(`u:#${u.publicUid}`).filter((e) => e.t === 'entitlement');

  it('asks the store again about a subscription on hold the person restores, once per 15 minutes', async () => {
    const u = await seedUser(h, { store: 1, name: 'Sam' });
    const token = `on-hold-${u.id}`;
    play.put(token, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1', accountRef: billingRef(u), state: 'on_hold', expiresAtMs: Date.now() - DAY });
    expect(purchaseResultSchema.parse((await buy(u, token)).json()).purchase.state).toBe('on_hold');
    play.calls.length = 0;
    // Google recovered the payment; the notification never came.
    play.put(token, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1', accountRef: billingRef(u), state: 'active', expiresAtMs: Date.now() + 30 * DAY, eventMs: Date.now() + 1 });
    const recovered = await restore(u, token);
    expect(recovered.statusCode).toBe(200);
    const body = restoreResultSchema.parse(recovered.json());
    expect(body.results).toEqual([{ purchaseToken: token, state: 'active', fresh: false }]);
    expect(body.entitlements.plan).toBe('plus');
    expect(play.count('verify')).toBe(1);
    expect(statements(recovered)).toBe(1);
    // The record is current again: the next restore costs no call and no statement.
    const again = await restore(u, token);
    expect(restoreResultSchema.parse(again.json()).results[0]?.state).toBe('active');
    expect(play.count('verify')).toBe(1);
    expect(statements(again)).toBe(0);

    // Still on hold at the store: asked once, then answered from the record for 15 minutes.
    const held = `still-held-${u.id}`;
    play.put(held, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1', accountRef: billingRef(u), state: 'on_hold', expiresAtMs: Date.now() - DAY });
    await buy(u, held);
    play.calls.length = 0;
    expect(restoreResultSchema.parse((await restore(u, held)).json()).results[0]?.state).toBe('on_hold');
    expect(play.count('verify')).toBe(1);
    const quiet = await restore(u, held);
    expect(restoreResultSchema.parse(quiet.json()).results[0]?.state).toBe('on_hold');
    expect(play.count('verify')).toBe(1);
    expect(statements(quiet)).toBe(0);

    // The store cannot be reached: the record answers, never `unavailable`.
    const down = `down-${u.id}`;
    play.put(down, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1', accountRef: billingRef(u), state: 'on_hold', expiresAtMs: Date.now() - DAY });
    await buy(u, down);
    play.failures.push(new StoreError('unavailable', 'down'));
    expect(restoreResultSchema.parse((await restore(u, down)).json()).results[0]?.state).toBe('on_hold');
  });

  it('asks the store again when a known subscription is posted after its expiry passed (a renewal that was not heard)', async () => {
    const u = await seedUser(h, { store: 1, name: 'Ali' });
    const token = `ran-out-${u.id}`;
    play.put(token, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1', accountRef: billingRef(u), expiresAtMs: Date.now() + 1_200 });
    expect((await buy(u, token)).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    const renewedUntil = Date.now() + 30 * DAY;
    play.put(token, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1', accountRef: billingRef(u), expiresAtMs: renewedUntil, eventMs: Date.now() + 1 });
    play.calls.length = 0;
    const res = await buy(u, token);
    expect(res.statusCode).toBe(200);
    const body = purchaseResultSchema.parse(res.json());
    expect(body.purchase).toMatchObject({ state: 'active', expiresAt: new Date(renewedUntil).toISOString() });
    expect(body.entitlements.plan).toBe('plus');
    expect(play.count('verify')).toBe(1);
  });

  it('names the store build on every entitlement event: a purchase, a wallet spend, a change', async () => {
    const u = await seedUser(h, { store: 1, name: 'Mina' });
    const token = `event-sub-${u.id}`;
    play.put(token, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1', accountRef: billingRef(u) });
    expect((await buy(u, token)).statusCode).toBe(200);
    const bought = events(u).at(-1)!;
    expect(realtimeEnvelopeSchema.parse(bought)).toBeTruthy();
    expect(bought.d).toMatchObject({ plan: 'plus', store: 'play' });

    // A boost from the wallet (the month's allowance used).
    await h.redis.set(h.app.keys.location(u.id), `${homeCell({ lat: 41.01, lng: 28.97 })}:1::TR`);
    expect((await call(h, '/v1/boosts', { method: 'POST', token: u.token, client: 'play/120', body: { kind: 'boost' } })).statusCode).toBe(201);
    await h.redis.del(h.app.keys.boostActive(u.id));
    const pack = `event-pack-${u.id}`;
    play.put(pack, { kind: 'consumable', productId: 'cons.boost.1', accountRef: billingRef(u) });
    expect((await buy(u, pack, 'cons.boost.1', 'consumable')).statusCode).toBe(200);
    const before = events(u).length;
    expect((await call(h, '/v1/boosts', { method: 'POST', token: u.token, client: 'play/120', body: { kind: 'boost' } })).statusCode).toBe(201);
    expect(events(u).length).toBe(before + 1);
    expect(events(u).at(-1)?.d).toMatchObject({ store: 'play', wallet: { boost: 0 } });

    // A change announced for a session of the other build.
    const fake = { log: h.app.log } as unknown as FastifyRequest;
    await h.app.store.entitlements.changed(fake, u.id, 2);
    const changed = events(u).at(-1)!;
    expect(changed.d).toMatchObject({ store: 'bazaar', plan: 'free' });
    expect(entitlementsSchema.parse((await call(h, '/v1/me/entitlements', { token: u.token, client: 'play/120' })).json())).toMatchObject({ plan: 'plus' });
  });
});
