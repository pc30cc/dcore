import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, createLocalJWKSet, exportJWK, importPKCS8 } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeGooglePlay,
  PLAY_SUBSCRIPTION_STATES,
  PlayApiError,
  PlayStoreVerifier,
  PubSubAuthError,
  PubSubOidcVerifier,
  StoreError,
  decodeRtdn,
  nextStep,
  playProductResource,
  playSubscriptionResource,
  productPurchaseV2Schema,
  pushMessageId,
  subscriptionPurchaseV2Schema,
  verifiedProduct,
  verifiedSubscription,
  type PurchaseRef,
} from '../../src/server/index.js';

/**
 * Google Play's side of store purchases against a local fake of Google
 * (no real Google): the service-account token exchange and its cache, the
 * Developer API calls with their deadlines and retries, the state table of
 * subscriptions and one-time products, the `StoreVerifier` built on them,
 * Pub/Sub push authentication (OIDC) and the notification decoder.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('the Play Developer API client (fake Google)', () => {
  const google = new FakeGooglePlay({ packageName: 'com.example.app' });

  beforeAll(async () => {
    await google.start();
  });
  afterAll(async () => {
    await google.stop();
  });
  beforeEach(() => google.reset());

  it('signs the service-account assertion, caches the access token, and exchanges again after a 401', async () => {
    const api = google.api();
    google.putSubscription('tok-cache-1', { productId: 'sub.plus', expiryTimeMs: Date.now() + DAY });
    for (let i = 0; i < 3; i += 1) await api.getSubscription('tok-cache-1');
    expect(google.count('token')).toBe(1);
    expect(api.tokenExchanges).toBe(1);
    google.expireAccessTokens();
    await api.getSubscription('tok-cache-1');
    expect(google.count('token')).toBe(2);
    // The refused request is answered 401 before the fake records the call; the client sent it.
    expect(google.count('subscriptionsv2.get')).toBe(4);
    expect(api.requests).toBe(5);
  });

  it('refuses a key that is not the service account\'s at the token endpoint', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const api = google.api({ account: { ...google.account, privateKey: other } });
    google.putSubscription('tok-key', { productId: 'sub.plus', expiryTimeMs: Date.now() + DAY });
    await expect(api.getSubscription('tok-key')).rejects.toMatchObject({ name: 'PlayApiError', status: 0 });
  });

  it('reads both resources in the documented shapes', async () => {
    const api = google.api();
    google.putSubscription('tok-shape-s', { productId: 'sub.premium', basePlanId: 'm3', expiryTimeMs: Date.now() + DAY, accountRef: 'ref1' });
    google.putProduct('tok-shape-p', { productId: 'cons.superlike.5', accountRef: 'ref2' });
    const sub = await api.getSubscription('tok-shape-s');
    expect(sub.lineItems[0]).toMatchObject({ productId: 'sub.premium', offerDetails: { basePlanId: 'm3' } });
    expect(sub.externalAccountIdentifiers?.obfuscatedExternalAccountId).toBe('ref1');
    const product = await api.getProduct('tok-shape-p');
    expect(product.productLineItem[0]?.productOfferDetails?.consumptionState).toBe('CONSUMPTION_STATE_YET_TO_BE_CONSUMED');
    expect(product.obfuscatedExternalAccountId).toBe('ref2');
  });

  it('retries a read on 5xx, 429 and a dropped connection, honours Retry-After, and stops after its retries', async () => {
    const waits: number[] = [];
    const api = google.api({ sleep: async (ms) => void waits.push(ms) });
    google.putSubscription('tok-retry', { productId: 'sub.plus', expiryTimeMs: Date.now() + DAY });
    google.failNext('subscriptionsv2.get', 503);
    google.failNext('subscriptionsv2.get', 429, { retryAfter: 1 });
    await api.getSubscription('tok-retry');
    expect(google.count('subscriptionsv2.get')).toBe(3);
    expect(waits).toEqual([250, 1_000]);
    google.reset();
    google.failNext('subscriptionsv2.get', 0, { drop: true });
    await api.getSubscription('tok-retry');
    expect(google.count('subscriptionsv2.get')).toBe(2);
    google.reset();
    google.failNext('subscriptionsv2.get', 500, { times: 5 });
    const error = await api.getSubscription('tok-retry').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlayApiError);
    expect((error as PlayApiError).retryable).toBe(true);
    expect(google.count('subscriptionsv2.get')).toBe(3);
  });

  it('does not retry a refused call, nor a revoke or a refund that failed', async () => {
    const api = google.api();
    const refused = await api.getSubscription('tok-unknown').catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 400, reason: 'invalid', retryable: false });
    expect(google.count('subscriptionsv2.get')).toBe(1);
    google.putSubscription('tok-rev-503', { productId: 'sub.plus', expiryTimeMs: Date.now() + DAY });
    google.failNext('subscriptionsv2.revoke', 503, { times: 3 });
    await expect(api.revokeSubscription('tok-rev-503')).rejects.toMatchObject({ status: 503 });
    expect(google.count('subscriptionsv2.revoke')).toBe(1);
    google.putProduct('tok-ref-503', { productId: 'cons.boost.1', orderId: 'GPA.0000-0000-0000-00001' });
    google.failNext('orders.refund', 502, { times: 3 });
    await expect(api.refundOrder('GPA.0000-0000-0000-00001')).rejects.toMatchObject({ status: 502 });
    expect(google.count('orders.refund')).toBe(1);
  });

  it('keeps tokens out of error messages', async () => {
    const secret = 'tok-secret-0123456789abcdef';
    const api = google.api();
    google.failNext('subscriptionsv2.get', 503, { times: 3 });
    const errors = await Promise.all([api.getSubscription(secret).catch((e: unknown) => e), api.getProduct(secret).catch((e: unknown) => e)]);
    for (const e of errors) {
      expect(e).toBeInstanceOf(PlayApiError);
      expect(String((e as Error).message)).not.toContain(secret);
    }
  });

  it('pages the voided purchases with the page token and asks for subscriptions too', async () => {
    const api = google.api();
    google.voided.length = 0;
    for (let i = 0; i < 5; i += 1) google.addVoided({ purchaseToken: `tok-void-${i}`, orderId: `GPA.void-${i}`, subscription: i % 2 === 0 });
    const first = await api.listVoided({ startTimeMs: Date.now() - DAY, endTimeMs: Date.now() + 1_000, type: 1, maxResults: 2 });
    expect(first.purchases.map((p) => p.orderId)).toEqual(['GPA.void-0', 'GPA.void-1']);
    expect(first.nextPageToken).not.toBeNull();
    const rest: string[] = [];
    let token = first.nextPageToken;
    while (token) {
      const page = await api.listVoided({ pageToken: token, maxResults: 2 });
      rest.push(...page.purchases.map((p) => p.orderId ?? ''));
      token = page.nextPageToken;
    }
    expect(rest).toEqual(['GPA.void-2', 'GPA.void-3', 'GPA.void-4']);
    expect(google.calls.find((c) => c.route === 'voidedpurchases.list')?.query).toMatchObject({ type: '1', maxResults: '2' });
    const productsOnly = await api.listVoided({ startTimeMs: Date.now() - DAY, endTimeMs: Date.now() + 1_000, type: 0 });
    expect(productsOnly.purchases.map((p) => p.orderId)).toEqual(['GPA.void-1', 'GPA.void-3']);
  });
});

describe('the subscription state table (research note §2.6)', () => {
  const now = Date.UTC(2026, 10, 9, 12);
  const future = now + 20 * DAY;
  const past = now - 3 * DAY;

  /** Each documented subscriptionState, with the expiry Google gives it in its lifecycle page. */
  const cases: [state: string, expiry: number | undefined, verified: string, access: boolean][] = [
    ['SUBSCRIPTION_STATE_ACTIVE', future, 'active', true],
    ['SUBSCRIPTION_STATE_CANCELED', future, 'canceled', true],
    ['SUBSCRIPTION_STATE_IN_GRACE_PERIOD', future, 'grace', true],
    ['SUBSCRIPTION_STATE_ON_HOLD', past, 'on_hold', false],
    ['SUBSCRIPTION_STATE_PAUSED', past, 'paused', false],
    ['SUBSCRIPTION_STATE_EXPIRED', past, 'expired', false],
    ['SUBSCRIPTION_STATE_PENDING', undefined, 'pending', false],
    ['SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED', undefined, 'expired', false],
  ];

  it('names every documented state and only those', () => {
    expect(Object.keys(PLAY_SUBSCRIPTION_STATES).sort()).toEqual(cases.map((c) => c[0]).sort());
  });

  for (const [state, expiry, verified, access] of cases) {
    it(`${state} → ${verified}${access ? ', access until expiryTime' : ', no access'}`, () => {
      const raw = subscriptionPurchaseV2Schema.parse(playSubscriptionResource({ state, productId: 'sub.plus', basePlanId: 'm1', expiryTimeMs: expiry, startTimeMs: now - DAY, accountRef: 'r1' }));
      const v = verifiedSubscription(raw, { readAtMs: now });
      expect(v.state).toBe(verified);
      expect(PLAY_SUBSCRIPTION_STATES[state]!.access).toBe(access ? 'until_expiry' : 'none');
      // What the database counts: states active, canceled and grace while the expiry is in the future.
      const counts = ['active', 'canceled', 'grace'].includes(v.state) && v.expiresAtMs !== null && v.expiresAtMs > now;
      expect(counts).toBe(access);
      expect(v).toMatchObject({ kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1', accountRef: 'r1', eventMs: now, quantity: 1 });
    });
  }

  it('reads a revocation: a REVOKED notification turns EXPIRED into revoked; a refunded current order always', () => {
    const expired = subscriptionPurchaseV2Schema.parse(playSubscriptionResource({ state: 'SUBSCRIPTION_STATE_EXPIRED', productId: 'sub.plus', expiryTimeMs: now }));
    expect(verifiedSubscription(expired, { readAtMs: now, revoked: 'if_expired' }).state).toBe('revoked');
    const active = subscriptionPurchaseV2Schema.parse(playSubscriptionResource({ state: 'SUBSCRIPTION_STATE_ACTIVE', productId: 'sub.plus', expiryTimeMs: future }));
    expect(verifiedSubscription(active, { readAtMs: now, revoked: 'if_expired' }).state).toBe('active');
    expect(verifiedSubscription(active, { readAtMs: now, revoked: 'always' }).state).toBe('revoked');
    const pendingCanceled = subscriptionPurchaseV2Schema.parse(playSubscriptionResource({ state: 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED', productId: 'sub.plus' }));
    expect(verifiedSubscription(pendingCanceled, { readAtMs: now, revoked: 'if_expired' }).state).toBe('expired');
  });

  it('refuses a state it does not know (nothing is written, it is asked again) and an active one without expiry', () => {
    const unknown = subscriptionPurchaseV2Schema.parse({ ...playSubscriptionResource({ productId: 'sub.plus', expiryTimeMs: future }), subscriptionState: 'SUBSCRIPTION_STATE_SOMETHING_NEW' });
    expect(() => verifiedSubscription(unknown, { readAtMs: now })).toThrow(StoreError);
    expect(() => verifiedSubscription(subscriptionPurchaseV2Schema.parse({ ...playSubscriptionResource({ productId: 'sub.plus' }) }), { readAtMs: now })).toThrow(/without an expiry/);
  });

  it('carries the fields the core needs: acknowledgement, auto-renew, order, linked token, test, region', () => {
    const raw = subscriptionPurchaseV2Schema.parse(
      playSubscriptionResource({ productId: 'sub.premium', basePlanId: 'w1', expiryTimeMs: future, startTimeMs: now - HOUR, orderId: 'GPA.1-2-3-4..0', linkedPurchaseToken: 'tok-old-123', test: true, regionCode: 'tr', autoRenew: false, state: 'SUBSCRIPTION_STATE_CANCELED' }),
    );
    const v = verifiedSubscription(raw, { readAtMs: now });
    expect(v).toMatchObject({ purchasedAtMs: now - HOUR, expiresAtMs: future, autoRenew: false, orderId: 'GPA.1-2-3-4..0', linkedPurchaseToken: 'tok-old-123', isTest: true, region: 'TR', acknowledged: false, needsAcknowledge: true, needsConsume: false, amount: null, refundCheckAtMs: null });
    const acked = verifiedSubscription(subscriptionPurchaseV2Schema.parse(playSubscriptionResource({ productId: 'sub.plus', expiryTimeMs: future, acknowledged: true })), { readAtMs: now });
    expect(acked).toMatchObject({ acknowledged: true, needsAcknowledge: false });
    const trial = verifiedSubscription(subscriptionPurchaseV2Schema.parse(playSubscriptionResource({ productId: 'sub.plus', expiryTimeMs: future, freeTrial: true })), { readAtMs: now });
    expect(trial.amount).toEqual({ micros: '0', currency: 'EUR' });
  });

  it('attributes a re-signup after expiry through outOfAppPurchaseContext', () => {
    const raw = subscriptionPurchaseV2Schema.parse(playSubscriptionResource({ productId: 'sub.plus', expiryTimeMs: future, outOfApp: { expiredPurchaseToken: 'tok-expired-1', accountRef: 'ref-old' } }));
    expect(verifiedSubscription(raw, { readAtMs: now })).toMatchObject({ accountRef: 'ref-old', linkedPurchaseToken: 'tok-expired-1' });
  });

  it('schedules the safety-net re-check after the expiry, the same for every read inside a step', () => {
    const raw = subscriptionPurchaseV2Schema.parse(playSubscriptionResource({ productId: 'sub.plus', expiryTimeMs: future }));
    expect(verifiedSubscription(raw, { readAtMs: now }).nextCheckAtMs).toBe(future + 2 * HOUR);
    const hold = subscriptionPurchaseV2Schema.parse(playSubscriptionResource({ state: 'SUBSCRIPTION_STATE_ON_HOLD', productId: 'sub.plus', expiryTimeMs: past }));
    const a = verifiedSubscription(hold, { readAtMs: now }).nextCheckAtMs!;
    const b = verifiedSubscription(hold, { readAtMs: now + HOUR }).nextCheckAtMs!;
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(now);
    expect(a - now).toBeLessThanOrEqual(3 * DAY);
    expect(verifiedSubscription(subscriptionPurchaseV2Schema.parse(playSubscriptionResource({ state: 'SUBSCRIPTION_STATE_EXPIRED', productId: 'sub.plus', expiryTimeMs: past })), { readAtMs: now }).nextCheckAtMs).toBeNull();
    expect(nextStep(10, 5, 3)).toBe(10);
    expect(nextStep(10, 5, 10)).toBe(15);
    expect(nextStep(10, 5, 14)).toBe(15);
  });

  it('maps one-time products: pending, purchased, consumed, refunded, canceled', () => {
    const read = (input: Parameters<typeof playProductResource>[0], revoked?: boolean) => verifiedProduct(productPurchaseV2Schema.parse(playProductResource(input)), { readAtMs: now, revoked });
    expect(read({ productId: 'cons.boost.1', state: 'PENDING' })).toMatchObject({ state: 'pending', needsConsume: false, purchasedAtMs: now });
    expect(read({ productId: 'cons.boost.1' })).toMatchObject({ state: 'purchased', needsConsume: true, needsAcknowledge: false, consumed: false, kind: 'consumable' });
    expect(read({ productId: 'cons.boost.1', consumed: true })).toMatchObject({ state: 'consumed', needsConsume: false, consumed: true, acknowledged: true });
    expect(read({ productId: 'cons.boost.1', refundableQuantity: 0 })).toMatchObject({ state: 'revoked' });
    expect(read({ productId: 'cons.boost.1', state: 'CANCELLED' })).toMatchObject({ state: 'revoked' });
    expect(read({ productId: 'cons.boost.1', state: 'CANCELLED', completedAtMs: undefined }).state).toBe('revoked');
    const neverPaid = verifiedProduct(productPurchaseV2Schema.parse({ ...playProductResource({ productId: 'cons.boost.1', state: 'CANCELLED' }), purchaseCompletionTime: undefined }), { readAtMs: now });
    expect(neverPaid.state).toBe('expired');
    expect(read({ productId: 'cons.boost.1' }, true).state).toBe('revoked');
    expect(read({ productId: 'cons.boost.1', quantity: 3 }).quantity).toBe(3);
  });
});

describe('PlayStoreVerifier (fake Google)', () => {
  const google = new FakeGooglePlay({ packageName: 'com.example.app' });
  let verifier: PlayStoreVerifier;
  const ref = (token: string, kind: 'subscription' | 'consumable', productId: string | null, orderId: string | null = null): PurchaseRef => ({
    purchaseId: '1',
    store: 'play',
    kind,
    token,
    productId,
    basePlanId: null,
    orderId,
    purchasedAtMs: null,
    expiresAtMs: null,
    quantity: 1,
  });

  beforeAll(async () => {
    await google.start();
    verifier = new PlayStoreVerifier({ api: google.api() });
  });
  afterAll(async () => {
    await google.stop();
  });
  beforeEach(() => google.reset());

  it('verifies with one call and nothing before it', async () => {
    google.putSubscription('tok-v-1', { productId: 'sub.plus', basePlanId: 'm1', expiryTimeMs: Date.now() + DAY, accountRef: 'abc' });
    expect(verifier.inspect({ store: 'play', productId: 'sub.plus', purchaseToken: 'tok-v-1', kind: 'subscription' })).toEqual({ productId: 'sub.plus', accountRef: null });
    expect(google.apiCalls()).toBe(0);
    const v = await verifier.verify({ store: 'play', productId: 'sub.plus', purchaseToken: 'tok-v-1', kind: 'subscription' });
    expect(v).toMatchObject({ state: 'active', accountRef: 'abc', needsAcknowledge: true });
    expect(google.apiCalls()).toBe(1);
  });

  it('maps Google\'s refusals and outages to the core\'s errors', async () => {
    const invalid = await verifier.verify({ store: 'play', productId: 'sub.plus', purchaseToken: 'tok-nobody', kind: 'subscription' }).catch((e: unknown) => e);
    expect(invalid).toMatchObject({ name: 'StoreError', kind: 'invalid' });
    google.putProduct('tok-v-out', { productId: 'cons.boost.1' });
    google.failNext('productsv2.get', 503, { times: 3, retryAfter: 7 });
    const down = await verifier.verify({ store: 'play', productId: 'cons.boost.1', purchaseToken: 'tok-v-out', kind: 'consumable' }).catch((e: unknown) => e);
    expect(down).toMatchObject({ kind: 'unavailable', retryAfterSeconds: 7 });
    google.failNext('productsv2.get', 403);
    expect(await verifier.verify({ store: 'play', productId: 'cons.boost.1', purchaseToken: 'tok-v-out', kind: 'consumable' }).catch((e: unknown) => e)).toMatchObject({ kind: 'unavailable' });
    // A token of another package is Google's to refuse.
    const other = new PlayStoreVerifier({ api: google.api({ packageName: 'com.example.other' }) });
    expect(await other.verify({ store: 'play', productId: 'cons.boost.1', purchaseToken: 'tok-v-out', kind: 'consumable' }).catch((e: unknown) => e)).toMatchObject({ kind: 'invalid' });
  });

  it('acknowledges once; a second time reads the purchase and answers already', async () => {
    google.putSubscription('tok-ack', { productId: 'sub.plus', expiryTimeMs: Date.now() + DAY });
    expect(await verifier.acknowledge(ref('tok-ack', 'subscription', 'sub.plus'))).toBe('done');
    expect(await verifier.acknowledge(ref('tok-ack', 'subscription', 'sub.plus'))).toBe('already');
    expect(google.count('subscriptions.acknowledge')).toBe(2);
    // Without the product id, it is read first.
    google.putSubscription('tok-ack-2', { productId: 'sub.premium', expiryTimeMs: Date.now() + DAY });
    expect(await verifier.acknowledge(ref('tok-ack-2', 'subscription', null))).toBe('done');
    expect(google.calls.filter((c) => c.route === 'subscriptions.acknowledge').length).toBe(3);
  });

  it('consumes once; already consumed counts as done', async () => {
    google.putProduct('tok-cons', { productId: 'cons.superlike.5' });
    expect(await verifier.consume(ref('tok-cons', 'consumable', 'cons.superlike.5'))).toBe('done');
    expect(await verifier.consume(ref('tok-cons', 'consumable', 'cons.superlike.5'))).toBe('already');
    expect((await verifier.recheck(ref('tok-cons', 'consumable', 'cons.superlike.5'))).state).toBe('consumed');
  });

  it('revokes a subscription with a full refund, and refunds a one-time order with revoke=true', async () => {
    google.putSubscription('tok-rv', { productId: 'sub.plus', expiryTimeMs: Date.now() + DAY });
    expect(await verifier.revoke(ref('tok-rv', 'subscription', 'sub.plus'))).toBe('done');
    expect(google.calls.find((c) => c.route === 'subscriptionsv2.revoke')?.body).toEqual({ revocationContext: { fullRefund: {} } });
    expect(await verifier.revoke(ref('tok-rv', 'subscription', 'sub.plus'))).toBe('already');
    google.putProduct('tok-rf', { productId: 'cons.boost.1', orderId: 'GPA.1111-2222-3333-44444' });
    expect(await verifier.revoke(ref('tok-rf', 'consumable', 'cons.boost.1'))).toBe('done');
    expect(google.calls.find((c) => c.route === 'orders.refund')).toMatchObject({ subject: 'GPA.1111-2222-3333-44444', query: { revoke: 'true' } });
    expect(await verifier.revoke(ref('tok-rf', 'consumable', 'cons.boost.1'))).toBe('already');
    expect(google.count('orders.refund')).toBe(1);
  });
});

describe('Pub/Sub push authentication (OIDC)', () => {
  const google = new FakeGooglePlay();
  const audience = 'https://api.example.test/v1/webhooks/play/rtdn';
  const email = 'rtdn-push@example-project.iam.gserviceaccount.com';
  let verifier: PubSubOidcVerifier;

  beforeAll(async () => {
    await google.start();
    verifier = new PubSubOidcVerifier({ audience, serviceAccountEmail: email, jwksUrl: google.jwksUrl });
  });
  afterAll(async () => {
    await google.stop();
  });

  const bearer = async (claims: Partial<Parameters<FakeGooglePlay['pushToken']>[0]> = {}) => `Bearer ${await google.pushToken({ audience, email, ...claims })}`;

  it('accepts Google\'s token for our audience and push account, fetching the keys once', async () => {
    google.reset();
    for (let i = 0; i < 5; i += 1) expect((await verifier.verify(await bearer())).email).toBe(email);
    expect(await verifier.verify(await bearer({ issuer: 'accounts.google.com', emailVerified: 'true' }))).toMatchObject({ audience });
    // An hour-old token (Pub/Sub's own) still passes: only exp counts.
    expect(await verifier.verify(await bearer({ issuedAtMs: Date.now() - 55 * 60_000 }))).toMatchObject({ email });
    expect(google.count('certs')).toBe(1);
  });

  const refusals: [string, Partial<Parameters<FakeGooglePlay['pushToken']>[0]>, string][] = [
    ['another audience', { audience: 'https://elsewhere.example/v1' }, 'audience'],
    ['another issuer', { issuer: 'https://evil.example' }, 'issuer'],
    ['expired', { issuedAtMs: Date.now() - 2 * HOUR, expiresInSeconds: 3_600 }, 'expired'],
    ['another service account', { email: 'someone@example-project.iam.gserviceaccount.com' }, 'email'],
    ['an unverified e-mail', { emailVerified: false }, 'email_unverified'],
    ['no e-mail', { omitEmail: true }, 'email'],
    ['a key Google does not publish', { kid: 'kid-unknown' }, 'signature'],
  ];
  for (const [what, claims, reason] of refusals) {
    it(`refuses ${what}`, async () => {
      const error = await verifier.verify(await bearer(claims)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PubSubAuthError);
      expect((error as PubSubAuthError).reason).toBe(reason);
    });
  }

  it('refuses a missing or malformed header and a token signed by someone else', async () => {
    expect(await verifier.verify(undefined).catch((e: PubSubAuthError) => e.reason)).toBe('missing');
    expect(await verifier.verify('Basic abc').catch((e: PubSubAuthError) => e.reason)).toBe('malformed');
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = await importPKCS8(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'RS256');
    // Google's key id, someone else's key.
    const kid = (JSON.parse(Buffer.from((await google.pushToken({ audience, email })).split('.')[0]!, 'base64url').toString()) as { kid: string }).kid;
    const forged = await new SignJWT({ email, email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer('https://accounts.google.com')
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);
    expect(await verifier.verify(`Bearer ${forged}`).catch((e: PubSubAuthError) => e.reason)).toBe('signature');
    const hs = await new SignJWT({ email, email_verified: true }).setProtectedHeader({ alg: 'HS256' }).setAudience(audience).setIssuer('https://accounts.google.com').setExpirationTime('1h').sign(new Uint8Array(32));
    expect(await verifier.verify(`Bearer ${hs}`).catch((e: PubSubAuthError) => e.reason)).toBe('signature');
  });

  it('says unavailable (not the sender\'s fault) when Google\'s keys cannot be fetched', async () => {
    const down: Server = createServer((_req, res) => res.writeHead(503).end());
    await new Promise<void>((resolve) => down.listen(0, '127.0.0.1', resolve));
    try {
      const offline = new PubSubOidcVerifier({ audience, serviceAccountEmail: email, jwksUrl: `http://127.0.0.1:${(down.address() as AddressInfo).port}/certs` });
      expect(await offline.verify(await bearer()).catch((e: PubSubAuthError) => e.reason)).toBe('unavailable');
    } finally {
      await new Promise<void>((resolve) => down.close(() => resolve()));
    }
  });

  it('takes a local key set too', async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'local', alg: 'RS256' };
    const local = new PubSubOidcVerifier({ audience, serviceAccountEmail: email, keys: createLocalJWKSet({ keys: [jwk] }) });
    const token = await new SignJWT({ email, email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'local' })
      .setIssuer('https://accounts.google.com')
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(await importPKCS8(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'RS256'));
    expect((await local.verify(`Bearer ${token}`)).email).toBe(email);
  });
});

describe('real-time developer notifications', () => {
  const pkg = 'com.example.app';
  it('decode every kind, with eventTimeMillis as a string or a number', () => {
    const sub = decodeRtdn(FakeGooglePlay.data({ version: '1.0', packageName: pkg, eventTimeMillis: '1503349566168', subscriptionNotification: { version: '1.0', notificationType: 4, purchaseToken: 'PURCHASE_TOKEN' } }));
    expect(sub).toEqual({ packageName: pkg, event: { kind: 'subscription', token: 'PURCHASE_TOKEN', notificationType: 4, eventTimeMs: 1503349566168 } });
    const one = decodeRtdn(FakeGooglePlay.data({ version: '1.0', packageName: pkg, eventTimeMillis: 1503349566168, oneTimeProductNotification: { version: '1.0', notificationType: 1, purchaseToken: 'PURCHASE_TOKEN', sku: 'my.sku' } }));
    expect(one?.event).toEqual({ kind: 'one_time', token: 'PURCHASE_TOKEN', notificationType: 1, productId: 'my.sku', eventTimeMs: 1503349566168 });
    const voided = decodeRtdn(FakeGooglePlay.data({ version: '1.0', packageName: pkg, eventTimeMillis: '1503349566168', voidedPurchaseNotification: { purchaseToken: 'PURCHASE_TOKEN', orderId: 'GS.0000-0000-0000', productType: 1, refundType: 1 } }));
    expect(voided?.event).toMatchObject({ kind: 'voided', orderId: 'GS.0000-0000-0000', productType: 1, refundType: 1 });
    expect(decodeRtdn(FakeGooglePlay.data({ version: '1.0', packageName: pkg, eventTimeMillis: '1503350156918', testNotification: { version: '1.0' } }))?.event.kind).toBe('test');
    expect(decodeRtdn(FakeGooglePlay.data({ version: '1.0', packageName: pkg, eventTimeMillis: '1503350156918', pendingRefundReviewNotification: { version: '1.0', pendingRefundToken: 'x', orderId: 'GPA.1', refundReason: 7 } }))?.event.kind).toBe('refund_review');
  });

  it('refuse what is not a notification', () => {
    expect(decodeRtdn('')).toBeNull();
    expect(decodeRtdn('not base64 json')).toBeNull();
    expect(decodeRtdn(FakeGooglePlay.data({ hello: 'world' }))).toBeNull();
    expect(decodeRtdn(FakeGooglePlay.data({ packageName: pkg, subscriptionNotification: { notificationType: 'four', purchaseToken: 'PURCHASE_TOKEN' } }))).toBeNull();
  });

  it('take the push message id in either spelling, else a hash of the data', () => {
    expect(pushMessageId({ message: { data: 'e30=', messageId: '136969346945' } })).toBe('136969346945');
    expect(pushMessageId({ message: { data: 'e30=', message_id: '136969346946' } })).toBe('136969346946');
    expect(pushMessageId({ message: { data: 'e30=', messageId: 'bad id!' } })).toMatch(/^h[0-9a-f]{40}$/);
  });
});
