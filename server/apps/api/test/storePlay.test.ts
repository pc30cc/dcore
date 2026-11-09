import { entitlementsSchema, purchasePendingSchema, purchaseResultSchema, restoreResultSchema } from '@app/shared';
import { FakeGooglePlay, PlayStoreVerifier, PubSubOidcVerifier, tokenHash } from '@app/shared/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, json, migratedDatabase, row, seedUser, startHarness, statements, type Harness, type SeededUser, type TestDatabase } from './accountSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * Google Play end to end through the API, on PostgreSQL and Valkey, with the
 * real Play integration (`PlayStoreVerifier` on the Developer API client)
 * talking to a local fake of Google: every subscriptionState of the state
 * table reaches the person's entitlements as documented, a purchase is one
 * statement and one Developer API call, a repeat none, a PENDING purchase
 * grants nothing, an account reference that is not the caller's is refused,
 * and the RTDN webhook authenticates Pub/Sub's OIDC token, drops what is not
 * ours, deduplicates by message id and queues with no statement.
 */

const DAY = 86_400_000;
const PACKAGE = 'com.example.app';
const AUDIENCE = 'https://api.example.test/v1/webhooks/play/rtdn';
const PUSH_EMAIL = 'rtdn-push@example-project.iam.gserviceaccount.com';

describe.skipIf(!hasInfrastructure)('Google Play: purchases and notifications (fake Google)', () => {
  let db: TestDatabase;
  let h: Harness;
  const google = new FakeGooglePlay({ packageName: PACKAGE });
  const jobs = new MemoryJobProducer();

  beforeAll(async () => {
    await google.start();
    db = await migratedDatabase();
    await db.sql.query(`UPDATE store_products SET is_active = true WHERE store = 1`);
    const verifier = new PlayStoreVerifier({ api: google.api() });
    h = await startHarness(
      db,
      {
        PLAY_PACKAGE_NAME: PACKAGE,
        PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: google.account.clientEmail, private_key: google.account.privateKey, private_key_id: google.account.privateKeyId }),
        PLAY_RTDN_AUDIENCE: AUDIENCE,
        PLAY_RTDN_PUSH_SA_EMAIL: PUSH_EMAIL,
      },
      {
        jobs,
        store: { verifiers: { play: verifier } },
        playRtdn: { authenticator: new PubSubOidcVerifier({ audience: AUDIENCE, serviceAccountEmail: PUSH_EMAIL, jwksUrl: google.jwksUrl }) },
      },
    );
  }, 90_000);

  afterAll(async () => {
    await h?.close();
    await db?.drop();
    await google.stop();
  });

  beforeEach(() => {
    google.reset();
    jobs.jobs.length = 0;
  });

  const user = (options: { status?: number; scope?: 'full' | 'restricted' } = {}) => seedUser(h, { store: 1, name: 'Sam', ...options });
  const billingRef = (u: SeededUser) => h.app.publicIds.billing.encode(u.id);
  const buy = (u: SeededUser, token: string, productId: string, kind: 'subscription' | 'consumable' = 'subscription') =>
    call(h, '/v1/store/play/purchases', { method: 'POST', token: u.token, client: 'play/120', body: { productId, purchaseToken: token, kind } });
  const entitlements = async (u: SeededUser) => entitlementsSchema.parse((await call(h, '/v1/me/entitlements', { token: u.token, client: 'play/120' })).json());

  describe('the state table, as the person sees it', () => {
    const future = () => Date.now() + 20 * DAY;
    const past = () => Date.now() - 3 * DAY;
    const cases: [state: string, expiry: () => number | undefined, status: number, wireState: string, plan: 'plus' | 'free'][] = [
      ['SUBSCRIPTION_STATE_ACTIVE', future, 200, 'active', 'plus'],
      ['SUBSCRIPTION_STATE_CANCELED', future, 200, 'canceled', 'plus'],
      ['SUBSCRIPTION_STATE_IN_GRACE_PERIOD', future, 200, 'grace', 'plus'],
      ['SUBSCRIPTION_STATE_ON_HOLD', past, 200, 'on_hold', 'free'],
      ['SUBSCRIPTION_STATE_PAUSED', past, 200, 'paused', 'free'],
      ['SUBSCRIPTION_STATE_EXPIRED', past, 200, 'expired', 'free'],
      ['SUBSCRIPTION_STATE_PENDING', () => undefined, 202, 'pending', 'free'],
      ['SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED', () => undefined, 200, 'expired', 'free'],
    ];
    for (const [state, expiry, status, wireState, plan] of cases) {
      it(`${state}: ${status} ${wireState}, plan ${plan}`, async () => {
        const u = await user();
        const token = `tok-table-${state.toLowerCase()}-${u.id}`;
        google.putSubscription(token, { state, productId: 'sub.plus', basePlanId: 'm1', expiryTimeMs: expiry(), startTimeMs: Date.now() - DAY, accountRef: billingRef(u) });
        const res = await buy(u, token, 'sub.plus');
        expect(res.statusCode).toBe(status);
        expect(google.apiCalls()).toBe(1);
        if (status === 202) expect(purchasePendingSchema.parse(res.json())).toEqual({ purchase: { state: 'pending' } });
        else {
          const body = purchaseResultSchema.parse(res.json());
          expect(body.purchase.state).toBe(wireState);
          expect(body.entitlements.plan).toBe(plan);
        }
        expect((await entitlements(u)).plan).toBe(plan);
        const stored = await row<{ state: number }>(db, `SELECT state::integer AS state FROM store_purchases WHERE token_hash = decode($1, 'hex')`, [tokenHash(token)]);
        expect(stored.state).toBeGreaterThan(0);
      });
    }
  });

  it('a purchase: one Developer API call and one statement, the acknowledgement queued; a repeat costs nothing', async () => {
    const u = await user();
    const token = `tok-budget-${u.id}`;
    google.putSubscription(token, { productId: 'sub.premium', basePlanId: 'm3', expiryTimeMs: Date.now() + 90 * DAY, accountRef: billingRef(u) });
    const res = await buy(u, token, 'sub.premium');
    expect(res.statusCode).toBe(200);
    expect(statements(res)).toBe(1);
    expect(google.count('subscriptionsv2.get')).toBe(1);
    expect(google.apiCalls()).toBe(1);
    const body = purchaseResultSchema.parse(res.json());
    expect(body.entitlements).toMatchObject({ plan: 'premium', source: 'play', autoRenew: true });
    expect(body.entitlements.manageUrl).toContain('play.google.com/store/account/subscriptions');
    expect(jobs.jobs.map((j) => j.id)).toContain(`ack.${body.purchase.id}`);
    const ack = jobs.jobs.find((j) => j.id === `ack.${body.purchase.id}`)!;
    expect(Number(ack.data['deadlineMs']) - Date.now()).toBeLessThanOrEqual(60 * 3_600_000);
    const repeat = await buy(u, token, 'sub.premium');
    expect(repeat.statusCode).toBe(200);
    expect(statements(repeat)).toBe(0);
    expect(google.apiCalls()).toBe(1);
  });

  it('a consumable is credited once and its consume queued; Google down answers 503 with nothing written', async () => {
    const u = await user();
    const token = `tok-cons-${u.id}`;
    google.putProduct(token, { productId: 'cons.superlike.5', accountRef: billingRef(u) });
    const res = await buy(u, token, 'cons.superlike.5', 'consumable');
    expect(res.statusCode).toBe(200);
    expect(statements(res)).toBe(1);
    const body = purchaseResultSchema.parse(res.json());
    expect(body.purchase.state).toBe('purchased');
    expect(body.entitlements.wallet.superlike).toBe(5);
    expect(jobs.jobs.map((j) => j.id)).toContain(`consume.${body.purchase.id}`);
    expect(jobs.jobs.some((j) => j.name === 'ack')).toBe(false);

    const down = `tok-down-${u.id}`;
    google.putProduct(down, { productId: 'cons.superlike.5', accountRef: billingRef(u) });
    google.failNext('productsv2.get', 503, { times: 3, retryAfter: 9 });
    const refused = await buy(u, down, 'cons.superlike.5', 'consumable');
    expect(refused.statusCode).toBe(503);
    expect(json(refused)['code']).toBe('store_unavailable');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(9);
    expect(statements(refused)).toBe(0);
    expect((await entitlements(u)).wallet.superlike).toBe(5);
  });

  it('PENDING grants nothing (202); the completed purchase grants once it is sent again', async () => {
    const u = await user();
    const token = `tok-pending-${u.id}`;
    google.putProduct(token, { productId: 'cons.boost.1', state: 'PENDING', accountRef: billingRef(u) });
    const pending = await buy(u, token, 'cons.boost.1', 'consumable');
    expect(pending.statusCode).toBe(202);
    expect((await entitlements(u)).wallet.boost).toBe(0);
    expect(jobs.jobs.some((j) => j.name === 'consume')).toBe(false);
    google.putProduct(token, { productId: 'cons.boost.1', accountRef: billingRef(u) });
    const done = await buy(u, token, 'cons.boost.1', 'consumable');
    expect(done.statusCode).toBe(200);
    expect(purchaseResultSchema.parse(done.json()).entitlements.wallet.boost).toBe(1);
  });

  it('an account reference that is not the caller\'s: 409 for another account (kept for its owner), 422 and a revoke for a reference that is nobody', async () => {
    const owner = await user();
    const caller = await user();
    const token = `tok-theirs-${owner.id}`;
    google.putSubscription(token, { productId: 'sub.plus', expiryTimeMs: Date.now() + 20 * DAY, accountRef: billingRef(owner) });
    const theirs = await buy(caller, token, 'sub.plus');
    expect(theirs.statusCode).toBe(409);
    expect(json(theirs)['code']).toBe('purchase_other_account');
    expect((await entitlements(caller)).plan).toBe('free');
    expect((await entitlements(owner)).plan).toBe('plus');

    const forged = `tok-forged-${caller.id}`;
    google.putSubscription(forged, { productId: 'sub.plus', expiryTimeMs: Date.now() + 20 * DAY, accountRef: 'zzzzzzzzzzzzzzzzzzzz' });
    const nobody = await buy(caller, forged, 'sub.plus');
    expect(nobody.statusCode).toBe(422);
    expect((await entitlements(caller)).plan).toBe('free');
    const revoke = jobs.jobs.find((j) => j.name === 'revoke');
    expect(revoke?.id).toBe(`revoke.play.${tokenHash(forged)}`);
    expect(revoke?.data).toMatchObject({ store: 'play', kind: 'subscription', productId: 'sub.plus' });
    expect(Number((await row<{ n: string }>(db, `SELECT count(*)::text AS n FROM store_purchases WHERE token_hash = decode($1, 'hex')`, [tokenHash(forged)])).n)).toBe(0);
  });

  it('an upgrade (linkedPurchaseToken) replaces the old row and keeps the person', async () => {
    const u = await user();
    const old = `tok-up-old-${u.id}`;
    const fresh = `tok-up-new-${u.id}`;
    google.putSubscription(old, { productId: 'sub.plus', expiryTimeMs: Date.now() + 20 * DAY, accountRef: billingRef(u), acknowledged: true });
    expect((await buy(u, old, 'sub.plus')).statusCode).toBe(200);
    google.putSubscription(old, { state: 'SUBSCRIPTION_STATE_EXPIRED', productId: 'sub.plus', expiryTimeMs: Date.now(), accountRef: billingRef(u), acknowledged: true });
    google.putSubscription(fresh, { productId: 'sub.premium', expiryTimeMs: Date.now() + 30 * DAY, accountRef: billingRef(u), linkedPurchaseToken: old });
    const res = await buy(u, fresh, 'sub.premium');
    expect(res.statusCode).toBe(200);
    expect(statements(res)).toBe(1);
    expect(purchaseResultSchema.parse(res.json()).entitlements.plan).toBe('premium');
    const rows = await db.sql.query<{ state: number; user_id: string }>(
      `SELECT state::integer AS state, user_id::text FROM store_purchases WHERE token_hash IN (decode($1, 'hex'), decode($2, 'hex')) ORDER BY id`,
      [tokenHash(old), tokenHash(fresh)],
    );
    expect(rows.rows).toEqual([{ state: 9, user_id: u.id }, { state: 2, user_id: u.id }]);
  });

  it('a purchase made outside the app (no reference) belongs to the caller who sends it', async () => {
    const u = await user();
    const token = `tok-promo-${u.id}`;
    google.putSubscription(token, { productId: 'sub.plus', expiryTimeMs: Date.now() + 20 * DAY });
    const res = await buy(u, token, 'sub.plus');
    expect(res.statusCode).toBe(200);
    expect((await entitlements(u)).plan).toBe('plus');
  });

  it('a banned account restores its Play purchase and sees the manage link; a token Google does not know is invalid', async () => {
    const u = await user({ status: 6, scope: 'restricted' });
    const token = `tok-banned-${u.id}`;
    google.putSubscription(token, { productId: 'sub.plus', expiryTimeMs: Date.now() + 20 * DAY, accountRef: billingRef(u) });
    const res = await call(h, '/v1/store/restore', {
      method: 'POST',
      token: u.token,
      client: 'play/120',
      body: { purchases: [{ productId: 'sub.plus', purchaseToken: token, kind: 'subscription' }, { productId: 'sub.plus', purchaseToken: `tok-nobody-${u.id}`, kind: 'subscription' }] },
    });
    expect(res.statusCode).toBe(200);
    const body = restoreResultSchema.parse(res.json());
    expect(body.results.map((r) => r.state)).toEqual(['active', 'invalid']);
    expect(body.entitlements.plan).toBe('plus');
    expect(body.entitlements.manageUrl).toContain('play.google.com');
  });

  describe('POST /v1/webhooks/play/rtdn', () => {
    const push = (data: string, messageId: string) => ({ message: { data, messageId, message_id: messageId, publishTime: '2026-11-09T08:00:00.000Z', attributes: {} }, subscription: 'projects/example/subscriptions/rtdn' });
    const notification = (body: Record<string, unknown>) => FakeGooglePlay.data({ version: '1.0', packageName: PACKAGE, eventTimeMillis: String(Date.now()), ...body });
    const post = async (payload: unknown, authorization?: string) =>
      h.app.inject({ method: 'POST', url: '/v1/webhooks/play/rtdn', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, payload: JSON.stringify(payload) });
    const bearer = async (claims: Partial<Parameters<FakeGooglePlay['pushToken']>[0]> = {}) => `Bearer ${await google.pushToken({ audience: AUDIENCE, email: PUSH_EMAIL, ...claims })}`;
    const sub = (token: string, type = 4) => notification({ subscriptionNotification: { version: '1.0', notificationType: type, purchaseToken: token } });

    it('refuses a push without a valid Pub/Sub token, before reading it', async () => {
      const body = push(sub('tok-rtdn-unauth-1'), '9000000001');
      expect((await post(body)).statusCode).toBe(401);
      expect((await post(body, await bearer({ audience: 'https://elsewhere.example/x' }))).statusCode).toBe(401);
      expect((await post(body, await bearer({ email: 'other@example-project.iam.gserviceaccount.com' }))).statusCode).toBe(401);
      expect((await post(body, await bearer({ emailVerified: false }))).statusCode).toBe(401);
      expect((await post({ not: 'json at all' }, 'Bearer x.y.z')).statusCode).toBe(401);
      expect(jobs.jobs).toHaveLength(0);
    });

    it('queues one job with no statement, and a duplicate message id makes nothing (no job, no write)', async () => {
      const before = Number((await row<{ n: string }>(db, 'SELECT count(*)::text AS n FROM store_events')).n);
      const body = push(sub('tok-rtdn-dup-1'), '9000000002');
      const first = await post(body, await bearer());
      expect(first.statusCode).toBe(204);
      expect(statements(first)).toBe(0);
      expect(jobs.jobs.map((j) => `${j.queue}/${j.name}/${j.id}`)).toEqual(['iap/rtdn/rtdn.9000000002']);
      expect(jobs.jobs[0]!.data).toMatchObject({ messageId: '9000000002', data: body.message.data, publishTime: '2026-11-09T08:00:00.000Z' });
      expect(jobs.jobs[0]!.options).toMatchObject({ attempts: 10 });
      const again = await post(body, await bearer());
      expect(again.statusCode).toBe(204);
      expect(statements(again)).toBe(0);
      expect(jobs.jobs).toHaveLength(1);
      expect(await h.redis.exists(`${h.prefix}rtdn:9000000002`)).toBe(1);
      expect(Number((await row<{ n: string }>(db, 'SELECT count(*)::text AS n FROM store_events')).n)).toBe(before);
      expect(google.apiCalls()).toBe(0);
    });

    it('acknowledges and drops a test notification, another package, and data that is no notification', async () => {
      expect((await post(push(notification({ testNotification: { version: '1.0' } }), '9000000003'), await bearer())).statusCode).toBe(204);
      const other = FakeGooglePlay.data({ version: '1.0', packageName: 'com.example.other', eventTimeMillis: '1', subscriptionNotification: { version: '1.0', notificationType: 4, purchaseToken: 'tok-other-pkg-1' } });
      expect((await post(push(other, '9000000004'), await bearer())).statusCode).toBe(204);
      expect((await post(push(Buffer.from('{"x":1}').toString('base64'), '9000000005'), await bearer())).statusCode).toBe(204);
      expect((await post({ message: 42 }, await bearer())).statusCode).toBe(204);
      expect(jobs.jobs).toHaveLength(0);
    });

    it('answers 503 and takes its mark back when the queue cannot take the job, so the next delivery queues it', async () => {
      const body = push(sub('tok-rtdn-503-1'), '9000000006');
      jobs.failWith = new Error('valkey down');
      try {
        const res = await post(body, await bearer());
        expect(res.statusCode).toBe(503);
        expect(json(res)['code']).toBe('store_unavailable');
      } finally {
        jobs.failWith = null;
      }
      expect(await h.redis.exists(`${h.prefix}rtdn:9000000006`)).toBe(0);
      expect((await post(body, await bearer())).statusCode).toBe(204);
      expect(jobs.jobs.map((j) => j.id)).toEqual(['rtdn.9000000006']);
    });

    it('is refused (503) while notifications are not configured', async () => {
      const bare = await startHarness(db, {}, { jobs: new MemoryJobProducer(), playRtdn: { authenticator: null } });
      try {
        const res = await bare.app.inject({ method: 'POST', url: '/v1/webhooks/play/rtdn', headers: { authorization: await bearer(), 'content-type': 'application/json' }, payload: JSON.stringify(push(sub('tok-x-1'), '9000000007')) });
        expect(res.statusCode).toBe(503);
        expect(res.json<{ code: string }>().code).toBe('store_unavailable');
      } finally {
        await bare.close();
      }
    });
  });

  it('never writes a purchase token, the access token or a push token into a log line', () => {
    const logs = h.logs.join('\n');
    const tokens = [...google.subscriptions.keys(), ...google.products.keys()];
    expect(tokens.length).toBeGreaterThan(10);
    for (const token of tokens) expect(logs.includes(token), token).toBe(false);
    expect(logs).not.toMatch(/ya29\.fake-/);
    expect(logs).not.toMatch(/Bearer ey/);
  });
});
