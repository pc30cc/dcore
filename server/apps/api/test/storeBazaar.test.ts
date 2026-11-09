import { generateKeyPairSync } from 'node:crypto';
import { entitlementsSchema, problemSchemaFor, purchaseResultSchema, restoreResultSchema } from '@app/shared';
import {
  BAZAAR_RECHECK_DELAY_MS,
  BAZAAR_RENEWAL_GRACE_MS,
  BazaarVerifier,
  FakePardakht,
  FakeRealtimePublisher,
  PardakhtClient,
  RedisBazaarCallMeter,
  bazaarCheckSpread,
  signBazaarPurchase,
} from '@app/shared/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, migratedDatabase, row, seedUser, startHarness, statements, type Harness, type SeededUser, type TestDatabase } from './accountSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * `POST /v1/store/bazaar/purchases` and restore end to end on PostgreSQL and
 * Valkey with the real Cafe Bazaar integration (the pardakht v2 client, the
 * call meter on kv-core, the SHA1withRSA check) against a local server that
 * answers as Bazaar documents: nothing signed wrongly reaches Bazaar or the
 * database, a new purchase is exactly one Bazaar call and one statement, a
 * known token is neither, the follow-up checks are scheduled at
 * validUntil + 1 h (plus the token's spread) and after day 7, and Bazaar's
 * outages answer 503 with nothing written.
 */

const PACKAGE = 'app.example.bazaar';
const SECRET = 'pishkhan-api-secret-for-tests-0001';
const DAY = 86_400_000;

describe.skipIf(!hasInfrastructure)('store: Cafe Bazaar purchases against a fake developer API', () => {
  let db: TestDatabase;
  let h: Harness;
  let server: { url: string; close(): Promise<void> };
  const fake = new FakePardakht({ packageName: PACKAGE, pishkhanToken: SECRET });
  const jobs = new MemoryJobProducer();
  const realtime = new FakeRealtimePublisher();
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const tokens: string[] = [];

  beforeAll(async () => {
    db = await migratedDatabase();
    await db.sql.query(`UPDATE store_products SET is_active = true WHERE store = 2 AND product_id IN ('sub.plus.1m', 'sub.premium.1m', 'cons.superlike.5', 'cons.boost.1')`);
    await db.sql.query(`UPDATE store_products SET list_price_minor = 150000000, list_currency = 'IRR' WHERE store = 2 AND product_id = 'sub.plus.1m'`);
    server = await fake.listen();
    h = await startHarness(db, { BAZAAR_PACKAGE_NAME: PACKAGE, BAZAAR_RSA_PUBLIC_KEY: publicKey, BAZAAR_PISHKHAN_API_TOKEN: SECRET }, { jobs, realtime });
  }, 90_000);

  afterAll(async () => {
    for (const line of h?.logs ?? []) {
      expect(line.includes(SECRET), 'the Pishkhan token in a log line').toBe(false);
      for (const t of tokens) expect(line.includes(t), 'a purchase token in a log line').toBe(false);
    }
    await h?.close();
    await server?.close();
    await db?.drop();
  });

  beforeEach(() => {
    fake.requests.length = 0;
    fake.forced.length = 0;
  });

  it('is built from BAZAAR_* by the API itself; the test then points it at the local server', () => {
    expect(h.app.store.verifiers.bazaar).toBeInstanceOf(BazaarVerifier);
    expect(h.app.store.verifiers.play).toBeUndefined();
    h.app.store.verifiers.bazaar = new BazaarVerifier({
      packageName: PACKAGE,
      rsaPublicKey: publicKey,
      api: new PardakhtClient({ packageName: PACKAGE, auth: { kind: 'pishkhan', token: SECRET }, baseUrl: server.url, meter: new RedisBazaarCallMeter(h.app.redis, h.app.keys) }),
      log: h.app.log,
    });
  });

  async function user(options: { status?: number; scope?: 'full' | 'restricted' } = {}): Promise<SeededUser> {
    return seedUser(h, { store: 2, name: 'Sara', ...options });
  }

  const billingRef = (u: SeededUser) => h.app.publicIds.billing.encode(u.id);

  function body(u: SeededUser, token: string, productId: string, kind: 'subscription' | 'consumable', over: Partial<Parameters<typeof signBazaarPurchase>[1]> = {}, key = keys.privateKey) {
    tokens.push(token);
    const signed = signBazaarPurchase(key, { purchaseToken: token, developerPayload: billingRef(u), packageName: PACKAGE, purchaseTime: Date.now() - 30_000, productId, ...over });
    return { productId, purchaseToken: token, kind, ...signed };
  }

  const post = (u: SeededUser, payload: unknown, token = u.token) => call(h, '/v1/store/bazaar/purchases', { method: 'POST', token, body: payload });
  const written = async () =>
    Number((await row<{ n: string }>(db, `SELECT (SELECT count(*) FROM store_purchases) + (SELECT count(*) FROM store_events) + (SELECT count(*) FROM wallet_ledger) AS n`)).n);

  it('a wrong signature, package, product, token or payload costs no Bazaar call and no write', async () => {
    const u = await user();
    const other = await user();
    const before = await written();
    const t = `bz-refused-${u.id}`;
    const good = body(u, t, 'sub.plus.1m', 'subscription');
    const cases: [unknown, number][] = [
      [{ ...good, signature: body(u, t, 'sub.plus.1m', 'subscription', {}, otherKeys.privateKey).signature }, 422],
      [{ ...good, originalJson: good.originalJson.replace('sub.plus.1m', 'sub.premium.1m') }, 422],
      [body(u, t, 'sub.plus.1m', 'subscription', { packageName: 'app.other.bazaar' }), 422],
      [{ ...body(u, t, 'sub.premium.1m', 'subscription'), productId: 'sub.plus.1m' }, 422],
      [{ ...body(u, `${t}-x`, 'sub.plus.1m', 'subscription'), purchaseToken: t }, 422],
      [body(u, t, 'sub.plus.1m', 'subscription', { developerPayload: '' }), 422],
      [body(u, t, 'sub.plus.1m', 'subscription', { purchaseState: 1 }), 422],
      [body(u, t, 'sub.plus.1m', 'subscription', { developerPayload: 'not-a-billing-ref' }), 422],
      [body(u, t, 'sub.plus.1m', 'subscription', { developerPayload: billingRef(other) }), 409],
    ];
    for (const [payload, status] of cases) {
      const res = await post(u, payload);
      expect(res.statusCode).toBe(status);
      expect(statements(res)).toBe(0);
    }
    expect(fake.count()).toBe(0);
    expect(await written()).toBe(before);
  });

  it('a new subscription: one Bazaar call with the Pishkhan header, one statement, checks at validUntil + 1 h and after day 7', async () => {
    const u = await user();
    const token = `bz-sub-${u.id}`;
    const validUntil = Date.now() + 30 * DAY;
    fake.putSubscription(token, { sku: 'sub.plus.1m', validUntilMs: validUntil, account: `acct-${u.id}` });
    const res = await post(u, body(u, token, 'sub.plus.1m', 'subscription'));
    expect(res.statusCode).toBe(200);
    expect(statements(res)).toBe(1);
    expect(fake.requests.map((r) => [r.method, r.operation, r.credential])).toEqual([['GET', 'subscription', `pishkhan:${SECRET}`]]);
    const out = purchaseResultSchema.parse(res.json());
    expect(out.purchase).toMatchObject({ state: 'active', productId: 'sub.plus.1m', expiresAt: new Date(validUntil + BAZAAR_RENEWAL_GRACE_MS).toISOString() });
    expect(out.entitlements).toMatchObject({ plan: 'plus', source: 'bazaar', autoRenew: true });
    expect(out.entitlements.features.see_likes).toBe(true);
    const ids = jobs.jobs.filter((j) => j.queue === 'iap').map((j) => j.id);
    expect(ids).toContain(`recheck.${out.purchase.id}.${validUntil + BAZAAR_RECHECK_DELAY_MS + bazaarCheckSpread(token)}`);
    expect(ids).toContain(`refund-check.${out.purchase.id}`);
    expect(ids.some((id) => id.startsWith(`sub-end.${u.id}.2.`))).toBe(true);
    expect(ids.some((id) => id.startsWith(`ack.${out.purchase.id}`))).toBe(false);
    // The event carries the list price of the moment, marked as an estimate (Bazaar reports no amount).
    const event = await row<{ event: number; amount_micros: string; amount_estimated: boolean; currency: string; source: number }>(
      db,
      `SELECT event, amount_micros::text, amount_estimated, currency, source FROM store_events WHERE purchase_id = $1`,
      [out.purchase.id],
    );
    expect(event).toEqual({ event: 1, amount_micros: String(150_000_000 * 10_000), amount_estimated: true, currency: 'IRR', source: 1 });
    // A repeat of the token: no Bazaar call, no statement.
    fake.requests.length = 0;
    const again = await post(u, body(u, token, 'sub.plus.1m', 'subscription'));
    expect(again.statusCode).toBe(200);
    expect(statements(again)).toBe(0);
    expect(fake.count()).toBe(0);
    // A restore of the known token: no call, no statement, no write.
    await call(h, '/v1/me/entitlements', { token: u.token });
    const before = await written();
    const restore = await call(h, '/v1/store/restore', { method: 'POST', token: u.token, body: { purchases: [body(u, token, 'sub.plus.1m', 'subscription')] } });
    expect(restore.statusCode).toBe(200);
    expect(statements(restore)).toBe(0);
    expect(restoreResultSchema.parse(restore.json()).results).toEqual([{ purchaseToken: token, state: 'active', fresh: false }]);
    expect(fake.count()).toBe(0);
    expect(await written()).toBe(before);
  });

  it('a one-time product: one call, credited once, then consumed by the worker and checked once after day 7', async () => {
    const u = await user();
    const token = `bz-cons-${u.id}`;
    fake.putInapp(token, { productId: 'cons.superlike.5', developerPayload: billingRef(u) });
    const res = await post(u, body(u, token, 'cons.superlike.5', 'consumable'));
    expect(res.statusCode).toBe(200);
    expect(statements(res)).toBe(1);
    expect(fake.requests.map((r) => r.operation)).toEqual(['inapp']);
    const out = purchaseResultSchema.parse(res.json());
    expect(out.purchase.state).toBe('purchased');
    expect(out.entitlements.wallet.superlike).toBe(5);
    const ids = jobs.jobs.filter((j) => j.queue === 'iap').map((j) => j.id);
    expect(ids).toContain(`consume.${out.purchase.id}`);
    expect(ids).toContain(`refund-check.${out.purchase.id}`);
    expect(ids.some((id) => id.startsWith(`recheck.${out.purchase.id}.`))).toBe(false);
  });

  it('Bazaar down, refusing or out of quota: 503 or 422 with nothing written, then one call when it is back', async () => {
    const u = await user();
    const token = `bz-down-${u.id}`;
    fake.putSubscription(token, { sku: 'sub.premium.1m', validUntilMs: Date.now() + 30 * DAY, account: `acct-${u.id}` });
    const before = await written();
    for (const forced of [{ status: 503, body: {} }, { status: 429, body: {}, headers: { 'retry-after': '40' } }, { status: 403, body: { error: 'quota_exceeded' } }]) {
      fake.forced.push(forced);
      const res = await post(u, body(u, token, 'sub.premium.1m', 'subscription'));
      expect(res.statusCode).toBe(503);
      expect(problemSchemaFor('store_unavailable').parse(res.json()).code).toBe('store_unavailable');
      expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(5);
    }
    expect(await written()).toBe(before);
    // A token Bazaar does not know.
    const unknown = `bz-unknown-${u.id}`;
    const refused = await post(u, body(u, unknown, 'sub.premium.1m', 'subscription'));
    expect(refused.statusCode).toBe(422);
    expect(await written()).toBe(before);
    fake.requests.length = 0;
    const ok = await post(u, body(u, token, 'sub.premium.1m', 'subscription'));
    expect(ok.statusCode).toBe(200);
    expect(fake.count()).toBe(1);
    expect(purchaseResultSchema.parse(ok.json()).entitlements.plan).toBe('premium');
  });

  it('two posts of one token at once make one Bazaar call', async () => {
    const u = await user();
    const token = `bz-twice-${u.id}`;
    fake.putInapp(token, { productId: 'cons.boost.1', developerPayload: billingRef(u) });
    const payload = body(u, token, 'cons.boost.1', 'consumable');
    const [a, b] = await Promise.all([post(u, payload), post(u, payload)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(fake.count()).toBe(1);
    expect(entitlementsSchema.parse((await call(h, '/v1/me/entitlements', { token: u.token })).json()).wallet.boost).toBe(1);
  });

  it('a banned account restores a new Bazaar subscription and reads its entitlements', async () => {
    const u = await user();
    await db.sql.query('UPDATE users SET status = 6 WHERE id = $1', [u.id]);
    const { token: restricted } = await h.app.tokens.issue({ kind: 'app', subject: u.publicUid, sessionId: u.sessionId, deviceId: u.deviceId, storeCode: 2, scope: 'restricted' });
    const token = `bz-banned-${u.id}`;
    fake.putSubscription(token, { sku: 'sub.plus.1m', validUntilMs: Date.now() + 20 * DAY, account: `acct-${u.id}` });
    const restore = await call(h, '/v1/store/restore', { method: 'POST', token: restricted, body: { purchases: [body(u, token, 'sub.plus.1m', 'subscription')] } });
    expect(restore.statusCode).toBe(200);
    expect(restoreResultSchema.parse(restore.json())).toMatchObject({ results: [{ purchaseToken: token, state: 'active' }], entitlements: { plan: 'plus', source: 'bazaar' } });
    expect(fake.count()).toBe(1);
    const ent = await call(h, '/v1/me/entitlements', { token: restricted });
    expect(ent.statusCode).toBe(200);
    expect(entitlementsSchema.parse(ent.json()).plan).toBe('plus');
  });

  it('counts every Bazaar call of the day in kv-core', async () => {
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const counted = Number(await h.redis.get(h.app.keys.iapStoreCalls(2, `d${day}`)));
    expect(counted).toBeGreaterThanOrEqual(8);
  });
});
