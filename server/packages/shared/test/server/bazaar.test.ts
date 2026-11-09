import { generateKeyPairSync } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BAZAAR_BACKGROUND_DAILY_CAP,
  BAZAAR_CHECK_SPREAD_MS,
  BAZAAR_DAILY_QUOTA,
  BAZAAR_RECHECK_DELAY_MS,
  BAZAAR_REFUND_CHECK_DELAY_MS,
  BAZAAR_REFUND_WINDOW_MS,
  BAZAAR_RENEWAL_GRACE_MS,
  BazaarApiError,
  BazaarVerifier,
  FakePardakht,
  MemoryBazaarCallMeter,
  PardakhtClient,
  RedisBazaarCallMeter,
  StoreError,
  bazaarCheckSpread,
  bazaarPublicKey,
  createKeys,
  isBazaarApiError,
  parseBazaarPurchaseData,
  signBazaarPurchase,
  utcDay,
  verifyBazaarSignature,
  type PurchaseRef,
  type PurchaseSubmission,
} from '../../src/server/index.js';
import { dropPrefix, hasRedis, testPrefix, testRedis } from './support.js';

/**
 * Cafe Bazaar's side: the pardakht v2 client against a local HTTP server
 * that answers as Bazaar documents (paths, methods, the Pishkhan header, the
 * OAuth refresh, every documented error), the SHA1withRSA check of the
 * purchase data Poolakey hands the app, the verifier behind the store core's
 * interface (no call before the signed data is checked, one call per
 * purchase, renewal and refund checks spread per token), and the call meter
 * on Valkey.
 */

const PACKAGE = 'app.example.bazaar';
const SECRET = 'pishkhan-secret-value-0123456789';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);

const keys = generateKeyPairSync('rsa', { modulusLength: 1024 });
const publicKeyB64 = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 1024 });

function bad(fn: () => unknown): StoreError {
  try {
    fn();
  } catch (error) {
    if (error instanceof StoreError) return error;
    throw error;
  }
  throw new Error('no error');
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('no rejection');
}

describe('the signed purchase data', () => {
  const data = { purchaseToken: 'tok-0001-abcdef', developerPayload: 'ref123', packageName: PACKAGE, purchaseTime: NOW, productId: 'sub.plus.1m' };

  it('verifies SHA1withRSA over the UTF-8 bytes, base64 or base64url, and nothing else', () => {
    const key = bazaarPublicKey(publicKeyB64);
    const signed = signBazaarPurchase(keys.privateKey, data);
    expect(verifyBazaarSignature(key, signed.originalJson, signed.signature)).toBe(true);
    const url = signed.signature.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    expect(verifyBazaarSignature(key, signed.originalJson, url)).toBe(true);
    expect(verifyBazaarSignature(key, signed.originalJson.replace('ref123', 'ref124'), signed.signature)).toBe(false);
    expect(verifyBazaarSignature(key, signed.originalJson, signBazaarPurchase(otherKeys.privateKey, data).signature)).toBe(false);
    expect(verifyBazaarSignature(key, signed.originalJson, '')).toBe(false);
    expect(verifyBazaarSignature(key, signed.originalJson, '!!!')).toBe(false);
    const unicode = signBazaarPurchase(keys.privateKey, { ...data, developerPayload: 'پرداخت' });
    expect(verifyBazaarSignature(key, unicode.originalJson, unicode.signature)).toBe(true);
  });

  it('refuses a key that is not an RSA public key', () => {
    expect(() => bazaarPublicKey('bm90IGEga2V5')).toThrow(/not a base64 X.509/);
    const ed = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    expect(() => bazaarPublicKey(ed)).toThrow(/not an RSA key/);
  });

  it("reads Poolakey's fields; a missing purchaseState is a purchase, anything but 0 a refund", () => {
    const parsed = parseBazaarPurchaseData(JSON.stringify({ ...data, orderId: 'o-1', purchaseState: 0 }));
    expect(parsed).toEqual({ orderId: 'o-1', purchaseToken: data.purchaseToken, developerPayload: 'ref123', packageName: PACKAGE, refunded: false, purchaseTimeMs: NOW, productId: 'sub.plus.1m' });
    expect(parseBazaarPurchaseData(JSON.stringify({ ...data, purchaseState: undefined }))?.refunded).toBe(false);
    expect(parseBazaarPurchaseData(JSON.stringify({ ...data, purchaseState: 1 }))?.refunded).toBe(true);
    expect(parseBazaarPurchaseData(JSON.stringify({ ...data, developerPayload: '' }))?.developerPayload).toBeNull();
    expect(parseBazaarPurchaseData('not json')).toBeNull();
    expect(parseBazaarPurchaseData(JSON.stringify({ productId: 'x' }))).toBeNull();
  });
});

describe('the pardakht v2 client (against a local server)', () => {
  let now = NOW;
  const fake = new FakePardakht({ packageName: PACKAGE, pishkhanToken: SECRET, now: () => now });
  let server: { url: string; close(): Promise<void> };
  let client: PardakhtClient;

  beforeAll(async () => {
    server = await fake.listen();
    client = new PardakhtClient({ packageName: PACKAGE, auth: { kind: 'pishkhan', token: SECRET }, baseUrl: server.url, timeoutMs: 1_000, now: () => now });
  });
  afterAll(() => server.close());
  beforeEach(() => {
    fake.requests.length = 0;
    fake.forced.length = 0;
    fake.stall = false;
    now = NOW;
  });

  it('reads a one-time purchase with the Pishkhan header on the documented path', async () => {
    fake.putInapp('inapp/tok 1', { productId: 'cons.superlike.5', developerPayload: 'ref123', purchaseTimeMs: NOW - 1000 });
    expect(await client.inappPurchase('cons.superlike.5', 'inapp/tok 1', 'urgent')).toEqual({ consumed: false, refunded: false, developerPayload: 'ref123', purchaseTimeMs: NOW - 1000 });
    expect(fake.requests).toEqual([
      { method: 'GET', operation: 'inapp', path: `/devapi/v2/api/validate/${PACKAGE}/inapp/cons.superlike.5/purchases/inapp%2Ftok%201/`, atMs: NOW, credential: `pishkhan:${SECRET}` },
    ]);
  });

  it('reads a subscription and the active subscriptions; ended ones are returned too', async () => {
    fake.putSubscription('sub-tok-1', { sku: 'sub.plus.1m', validUntilMs: NOW + 10 * DAY, startedAtMs: NOW - 20 * DAY });
    expect(await client.subscription('sub.plus.1m', 'sub-tok-1', 'background')).toEqual({ startedAtMs: NOW - 20 * DAY, validUntilMs: NOW + 10 * DAY, autoRenewing: true, chainToken: 'sub-tok-1' });
    expect(fake.requests.at(-1)?.path).toBe(`/devapi/v2/api/applications/${PACKAGE}/subscriptions/sub.plus.1m/purchases/sub-tok-1/`);
    expect(await client.activeSubscriptions('sub-tok-1', 'urgent')).toEqual([{ startedAtMs: NOW - 20 * DAY, validUntilMs: NOW + 10 * DAY, autoRenewing: true, chainToken: 'sub-tok-1', sku: 'sub.plus.1m' }]);
    expect(fake.requests.at(-1)?.path).toBe(`/devapi/v2/api/applications/${PACKAGE}/active-subscriptions/sub-tok-1/`);
    now = NOW + 11 * DAY;
    expect((await client.subscription('sub.plus.1m', 'sub-tok-1', 'background')).validUntilMs).toBe(NOW + 10 * DAY);
    // "no subscription found!" is an empty list; "token not found!" is not_found.
    expect(await client.activeSubscriptions('sub-tok-1', 'urgent')).toEqual([]);
    const unknown = await rejection(client.activeSubscriptions('no-such-token', 'urgent'));
    expect(isBazaarApiError(unknown, 'not_found')).toBe(true);
  });

  it('consumes (POST, JSON body), counts already_consumed as done before, and reports a refund', async () => {
    fake.putInapp('cons-tok-1', { productId: 'cons.boost.1' });
    expect(await client.consume('cons-tok-1', 'background')).toBe('done');
    expect(fake.requests.at(-1)).toMatchObject({ method: 'POST', operation: 'consume', path: `/devapi/v2/api/consume/${PACKAGE}/purchases/` });
    expect(await client.consume('cons-tok-1', 'background')).toBe('already');
    fake.putInapp('cons-tok-2', { productId: 'cons.boost.1', refunded: true });
    expect(isBazaarApiError(await rejection(client.consume('cons-tok-2', 'background')), 'refunded')).toBe(true);
    fake.putSubscription('sub-tok-2', { sku: 'sub.plus.1m', validUntilMs: NOW + DAY });
    expect(isBazaarApiError(await rejection(client.consume('sub-tok-2', 'background')), 'invalid')).toBe(true);
  });

  it('refunds once and cancels once; repeats are "already"', async () => {
    fake.putInapp('ref-tok-1', { productId: 'cons.boost.1' });
    expect(await client.refund('ref-tok-1', 'background')).toBe('done');
    expect(fake.requests.at(-1)).toMatchObject({ method: 'POST', operation: 'refund', path: `/devapi/v2/api/refund/${PACKAGE}/purchases/ref-tok-1/` });
    expect(await client.refund('ref-tok-1', 'background')).toBe('already');
    fake.putSubscription('can-tok-1', { sku: 'sub.plus.1m', validUntilMs: NOW + DAY });
    expect(await client.cancelSubscription('sub.plus.1m', 'can-tok-1', 'background')).toBe('done');
    expect(fake.requests.at(-1)).toMatchObject({ method: 'GET', operation: 'cancel', path: `/devapi/v2/api/applications/${PACKAGE}/subscriptions/sub.plus.1m/purchases/can-tok-1/cancel/` });
    expect(await client.cancelSubscription('sub.plus.1m', 'can-tok-1', 'background')).toBe('already');
    now = NOW + 2 * DAY;
    // "Subscription has been expired", with the page's own spelling of the code.
    expect(await client.cancelSubscription('sub.plus.1m', 'can-tok-1', 'background')).toBe('already');
  });

  it('maps every documented failure, and no message carries the token or the secret', async () => {
    const token = 'secret-looking-purchase-token-0001';
    fake.putInapp(token, { productId: 'cons.boost.1' });
    const cases: [() => void, string, Record<string, unknown>][] = [
      [() => undefined, 'invalid', { kind: 'invalid', status: 404, code: 'invalid_value' }], // another product
      [() => fake.forced.push({ status: 503, body: { error: 'server_error' } }), 'cons.boost.1', { kind: 'unavailable', status: 503 }],
      [() => fake.forced.push({ status: 429, body: {}, headers: { 'retry-after': '17' } }), 'cons.boost.1', { kind: 'unavailable', retryAfterSeconds: 17 }],
      [() => fake.forced.push({ status: 403, body: { error: 'quota_exceeded', error_description: 'quota' } }), 'cons.boost.1', { kind: 'quota', status: 403 }],
      [() => fake.forced.push({ status: 401, body: { error: 'invalid_credentials' } }), 'cons.boost.1', { kind: 'auth', status: 401 }],
      [() => fake.forced.push({ status: 404, body: { error: 'invalid_value', error_description: 'Package name is invalid' } }), 'cons.boost.1', { kind: 'config', status: 404 }],
      [() => fake.forced.push({ status: 200, body: { purchaseState: 'refunded?' } }), 'cons.boost.1', { kind: 'unavailable', status: 0 }],
      [() => fake.forced.push({ status: 404, body: { error: 'not_found', error_desciption: 'The requested purchase is not found!' } }), 'cons.boost.1', { kind: 'not_found' }],
    ];
    for (const [arrange, product, expected] of cases) {
      arrange();
      const error = await rejection(client.inappPurchase(product === 'invalid' ? 'cons.superlike.5' : product, token, 'urgent'));
      expect(error).toBeInstanceOf(BazaarApiError);
      expect(error).toMatchObject(expected);
      expect((error as Error).message).not.toContain(token);
      expect((error as Error).message).not.toContain(SECRET);
    }
    // The quota answer is good until the next UTC day.
    fake.forced.push({ status: 403, body: { error: 'quota_exceeded' } });
    const quota = (await rejection(client.inappPurchase('cons.boost.1', token, 'urgent'))) as BazaarApiError;
    expect(quota.retryAfterSeconds).toBe(12 * 3600);
    // A server that never answers is a timeout, then unavailable.
    fake.stall = true;
    const slow = (await rejection(client.inappPurchase('cons.boost.1', token, 'urgent'))) as BazaarApiError;
    expect(slow).toMatchObject({ kind: 'unavailable' });
    expect(slow.message).toContain('timeout');
    // A wrong Pishkhan token.
    fake.stall = false;
    const wrong = new PardakhtClient({ packageName: PACKAGE, auth: { kind: 'pishkhan', token: 'wrong-token-value' }, baseUrl: server.url });
    const refused = (await rejection(wrong.inappPurchase('cons.boost.1', token, 'urgent'))) as BazaarApiError;
    expect(refused).toMatchObject({ kind: 'auth', status: 401, code: 'invalid_credentials' });
    expect(refused.message).not.toContain('wrong-token-value');
  });

  it('an unreachable Bazaar is unavailable', async () => {
    const away = new PardakhtClient({ packageName: PACKAGE, auth: { kind: 'pishkhan', token: SECRET }, baseUrl: 'http://127.0.0.1:1/devapi/v2', timeoutMs: 1_000 });
    expect(await rejection(away.inappPurchase('cons.boost.1', 'tok-unreachable', 'urgent'))).toMatchObject({ kind: 'unavailable' });
  });
});

describe('the older OAuth client', () => {
  let now = NOW;
  const oauth = { clientId: 'client-id-1', clientSecret: 'client-secret-value-1', refreshToken: 'refresh-token-value-1' };
  const fake = new FakePardakht({ packageName: PACKAGE, oauth, now: () => now });
  let server: { url: string; close(): Promise<void> };

  beforeAll(async () => {
    server = await fake.listen();
  });
  afterAll(() => server.close());

  it('refreshes once, sends Bearer, refreshes again when the token runs out or is refused', async () => {
    const client = new PardakhtClient({ packageName: PACKAGE, auth: { kind: 'oauth', ...oauth }, baseUrl: server.url, now: () => now });
    fake.putInapp('oauth-tok-1', { productId: 'cons.boost.1' });
    await Promise.all([client.inappPurchase('cons.boost.1', 'oauth-tok-1', 'urgent'), client.inappPurchase('cons.boost.1', 'oauth-tok-1', 'urgent')]);
    expect(fake.count('token')).toBe(1);
    expect(fake.requests.filter((r) => r.operation === 'inapp').every((r) => r.credential?.startsWith('bearer:access-'))).toBe(true);
    now += 3_600_000;
    await client.inappPurchase('cons.boost.1', 'oauth-tok-1', 'urgent');
    expect(fake.count('token')).toBe(2);
    fake.expireAccessTokens();
    expect(await rejection(client.inappPurchase('cons.boost.1', 'oauth-tok-1', 'urgent'))).toMatchObject({ kind: 'auth' });
    await client.inappPurchase('cons.boost.1', 'oauth-tok-1', 'urgent');
    expect(fake.count('token')).toBe(3);
    const wrong = new PardakhtClient({ packageName: PACKAGE, auth: { kind: 'oauth', ...oauth, clientSecret: 'not-the-secret' }, baseUrl: server.url });
    const refused = (await rejection(wrong.inappPurchase('cons.boost.1', 'oauth-tok-1', 'urgent'))) as Error;
    expect(refused).toMatchObject({ kind: 'auth' });
    expect(refused.message).not.toContain('not-the-secret');
    expect(refused.message).not.toContain(oauth.refreshToken);
  });
});

describe('the Bazaar verifier', () => {
  let now = NOW;
  const fake = new FakePardakht({ packageName: PACKAGE, pishkhanToken: SECRET, now: () => now });
  const meter = new MemoryBazaarCallMeter(() => now);
  const api = new PardakhtClient({ packageName: PACKAGE, auth: { kind: 'pishkhan', token: SECRET }, baseUrl: 'http://pardakht.fake/devapi/v2', fetch: fake.fetch, meter, now: () => now });
  const verifier = new BazaarVerifier({ packageName: PACKAGE, rsaPublicKey: publicKeyB64, api, now: () => now });
  const REF = 'billingref0001';

  beforeEach(() => {
    fake.requests.length = 0;
    fake.forced.length = 0;
    fake.statusNeedsInitialToken = false;
    now = NOW;
  });

  function submission(token: string, productId: string, kind: 'subscription' | 'consumable', over: Partial<Parameters<typeof signBazaarPurchase>[1]> = {}, key = keys.privateKey): PurchaseSubmission {
    const signed = signBazaarPurchase(key, { purchaseToken: token, developerPayload: REF, packageName: PACKAGE, purchaseTime: NOW - 60_000, productId, ...over });
    return { store: 'bazaar', productId, purchaseToken: token, kind, ...signed };
  }

  function ref(token: string, productId: string, kind: 'subscription' | 'consumable', over: Partial<PurchaseRef> = {}): PurchaseRef {
    return { purchaseId: '1287390234923417601', store: 'bazaar', kind, token, productId, basePlanId: null, orderId: null, purchasedAtMs: NOW - 60_000, expiresAtMs: null, quantity: 1, ...over };
  }

  it('refuses before any call: no data, a bad signature, another package, product or token, a refund, no payload', async () => {
    const good = submission('tok-inspect-1', 'sub.plus.1m', 'subscription');
    expect(verifier.inspect(good)).toEqual({ productId: 'sub.plus.1m', accountRef: REF });
    const cases: PurchaseSubmission[] = [
      { ...good, originalJson: undefined, signature: undefined },
      { ...good, signature: submission('tok-inspect-1', 'sub.plus.1m', 'subscription', {}, otherKeys.privateKey).signature },
      { ...good, originalJson: good.originalJson!.replace('sub.plus.1m', 'sub.premium.1m') },
      submission('tok-inspect-1', 'sub.plus.1m', 'subscription', { packageName: 'app.other.bazaar' }),
      { ...submission('tok-inspect-1', 'sub.premium.1m', 'subscription'), productId: 'sub.plus.1m' },
      { ...submission('tok-inspect-2', 'sub.plus.1m', 'subscription'), purchaseToken: 'tok-inspect-1' },
      submission('tok-inspect-1', 'sub.plus.1m', 'subscription', { purchaseState: 1 }),
      submission('tok-inspect-1', 'sub.plus.1m', 'subscription', { developerPayload: '' }),
      { ...good, originalJson: '{"productId":"sub.plus.1m"}', signature: signBazaarPurchase(keys.privateKey, { purchaseToken: 'x', developerPayload: REF, packageName: PACKAGE, purchaseTime: 1, productId: 'x' }).signature },
    ];
    for (const s of cases) {
      expect(bad(() => verifier.inspect(s)).kind).toBe('invalid');
      expect(await rejection(verifier.verify(s))).toMatchObject({ kind: 'invalid' });
    }
    expect(fake.count()).toBe(0);
  });

  it('a one-time product: one call, credited state, a consume, one refund check after day 7', async () => {
    fake.putInapp('cons-v-1', { productId: 'cons.superlike.5', developerPayload: REF, purchaseTimeMs: NOW - 60_000 });
    const v = await verifier.verify(submission('cons-v-1', 'cons.superlike.5', 'consumable'));
    expect(fake.count()).toBe(1);
    expect(v).toMatchObject({ kind: 'consumable', productId: 'cons.superlike.5', state: 'purchased', accountRef: REF, needsConsume: true, needsAcknowledge: false, nextCheckAtMs: null, amount: null });
    const spread = bazaarCheckSpread('cons-v-1');
    expect(v.refundCheckAtMs).toBe(NOW - 60_000 + BAZAAR_REFUND_WINDOW_MS + BAZAAR_REFUND_CHECK_DELAY_MS + spread);
    // The store reporting another payload is a refusal.
    fake.putInapp('cons-v-2', { productId: 'cons.superlike.5', developerPayload: 'someone-else' });
    expect(await rejection(verifier.verify(submission('cons-v-2', 'cons.superlike.5', 'consumable')))).toMatchObject({ kind: 'invalid' });
    // A refund found later is a revoked purchase (the core reverses the credit once).
    fake.refund('cons-v-1');
    expect((await verifier.recheck(ref('cons-v-1', 'cons.superlike.5', 'consumable'))).state).toBe('revoked');
    // Consumed by the app first: consumed, nothing left to consume.
    fake.putInapp('cons-v-3', { productId: 'cons.superlike.5', developerPayload: REF, consumed: true });
    expect(await verifier.verify(submission('cons-v-3', 'cons.superlike.5', 'consumable'))).toMatchObject({ state: 'consumed', consumed: true, needsConsume: false });
    expect(await verifier.consume(ref('cons-v-3', 'cons.superlike.5', 'consumable'))).toBe('already');
  });

  it('a subscription: one call, access through the renewal check, re-checked at validUntil + 1 h + its spread', async () => {
    const validUntil = NOW + 30 * DAY;
    fake.putSubscription('sub-v-1', { sku: 'sub.plus.1m', validUntilMs: validUntil, startedAtMs: NOW - 60_000 });
    const v = await verifier.verify(submission('sub-v-1', 'sub.plus.1m', 'subscription'));
    expect(fake.count()).toBe(1);
    expect(fake.requests[0]?.operation).toBe('subscription');
    const spread = bazaarCheckSpread('sub-v-1');
    expect(spread).toBeGreaterThanOrEqual(0);
    expect(spread).toBeLessThan(BAZAAR_CHECK_SPREAD_MS);
    expect(v).toMatchObject({
      kind: 'subscription',
      state: 'active',
      autoRenew: true,
      accountRef: REF,
      expiresAtMs: validUntil + BAZAAR_RENEWAL_GRACE_MS,
      nextCheckAtMs: validUntil + BAZAAR_RECHECK_DELAY_MS + spread,
      refundCheckAtMs: NOW - 60_000 + BAZAAR_REFUND_WINDOW_MS + BAZAAR_REFUND_CHECK_DELAY_MS + spread,
      linkedPurchaseToken: null,
      needsConsume: false,
    });
    // The re-check comes before access ends, whatever the spread.
    expect(v.nextCheckAtMs!).toBeLessThan(v.expiresAtMs! - HOUR);
    // Renewed: extended to the next period, asked again then.
    now = v.nextCheckAtMs!;
    fake.renew('sub-v-1', validUntil + 30 * DAY);
    const renewed = await verifier.recheck(ref('sub-v-1', 'sub.plus.1m', 'subscription', { expiresAtMs: v.expiresAtMs }));
    expect(renewed).toMatchObject({ state: 'active', expiresAtMs: validUntil + 30 * DAY + BAZAAR_RENEWAL_GRACE_MS, nextCheckAtMs: validUntil + 30 * DAY + BAZAAR_RECHECK_DELAY_MS + spread, refundCheckAtMs: null });
    // Not renewed at the next end: expired at once, no further check.
    now = renewed.nextCheckAtMs!;
    const ended = await verifier.recheck(ref('sub-v-1', 'sub.plus.1m', 'subscription', { expiresAtMs: renewed.expiresAtMs }));
    expect(ended).toMatchObject({ state: 'expired', expiresAtMs: validUntil + 30 * DAY, autoRenew: false, nextCheckAtMs: null });
    expect(fake.requests.map((r) => r.operation)).toEqual(['subscription', 'subscription', 'subscription']);
  });

  it('a cancelled renewal ends at validUntil exactly; a refunded subscription has ended at the refund check', async () => {
    fake.putSubscription('sub-v-2', { sku: 'sub.premium.1m', validUntilMs: NOW + 30 * DAY, autoRenewing: false });
    expect(await verifier.verify(submission('sub-v-2', 'sub.premium.1m', 'subscription'))).toMatchObject({ state: 'canceled', autoRenew: false, expiresAtMs: NOW + 30 * DAY });
    fake.putSubscription('sub-v-3', { sku: 'sub.premium.1m', validUntilMs: NOW + 30 * DAY });
    const v = await verifier.verify(submission('sub-v-3', 'sub.premium.1m', 'subscription'));
    now = v.refundCheckAtMs!;
    fake.now = () => NOW + 3 * DAY;
    fake.refund('sub-v-3');
    fake.now = () => now;
    expect(await verifier.recheck(ref('sub-v-3', 'sub.premium.1m', 'subscription', { expiresAtMs: v.expiresAtMs }))).toMatchObject({ state: 'expired', expiresAtMs: NOW + 3 * DAY, nextCheckAtMs: null });
  });

  it('a token the status endpoint does not take is looked up among the active subscriptions (a second call)', async () => {
    fake.statusNeedsInitialToken = true;
    fake.putSubscription('sub-v-4-renewal', { sku: 'sub.plus.1m', validUntilMs: NOW + 20 * DAY, chainToken: 'sub-v-4-initial', account: 'acct-4' });
    const v = await verifier.verify(submission('sub-v-4-renewal', 'sub.plus.1m', 'subscription'));
    expect(fake.requests.map((r) => r.operation)).toEqual(['subscription', 'active']);
    expect(v).toMatchObject({ state: 'active', expiresAtMs: NOW + 20 * DAY + BAZAAR_RENEWAL_GRACE_MS });
    // Nothing of this product live: a new purchase is refused, a stored one has ended.
    fake.requests.length = 0;
    fake.putSubscription('sub-v-5', { sku: 'sub.premium.1m', validUntilMs: NOW + 20 * DAY, chainToken: 'sub-v-5-initial', account: 'acct-5' });
    expect(await rejection(verifier.verify(submission('sub-v-5', 'sub.plus.1m', 'subscription')))).toMatchObject({ kind: 'invalid' });
    expect(await verifier.recheck(ref('sub-v-5', 'sub.plus.1m', 'subscription', { expiresAtMs: NOW + 5 * DAY }))).toMatchObject({ state: 'expired', expiresAtMs: NOW });
    // A token Bazaar does not know at all.
    expect(await rejection(verifier.recheck(ref('sub-v-unknown', 'sub.plus.1m', 'subscription')))).toMatchObject({ kind: 'invalid' });
  });

  it('maps outages to unavailable with a retry time, revokes by refund or cancel, never acknowledges', async () => {
    fake.putInapp('cons-v-9', { productId: 'cons.boost.1', developerPayload: REF });
    fake.forced.push({ status: 502, body: {} });
    expect(await rejection(verifier.verify(submission('cons-v-9', 'cons.boost.1', 'consumable')))).toMatchObject({ kind: 'unavailable' });
    fake.forced.push({ status: 403, body: { error: 'quota_exceeded' } });
    const quota = (await rejection(verifier.verify(submission('cons-v-9', 'cons.boost.1', 'consumable')))) as StoreError;
    expect(quota.kind).toBe('unavailable');
    expect(quota.retryAfterSeconds).toBeGreaterThan(0);
    // After Bazaar's quota answer the background calls wait for the next day; purchases still go.
    expect(await rejection(verifier.recheck(ref('cons-v-9', 'cons.boost.1', 'consumable')))).toMatchObject({ kind: 'unavailable' });
    await verifier.verify(submission('cons-v-9', 'cons.boost.1', 'consumable'));
    meter.days.clear();
    expect(await verifier.revoke(ref('cons-v-9', 'cons.boost.1', 'consumable'))).toBe('done');
    expect(await verifier.revoke(ref('cons-v-9', 'cons.boost.1', 'consumable'))).toBe('already');
    fake.putSubscription('sub-v-9', { sku: 'sub.plus.1m', validUntilMs: NOW + DAY });
    expect(await verifier.revoke(ref('sub-v-9', 'sub.plus.1m', 'subscription'))).toBe('done');
    const before = fake.count();
    expect(await verifier.acknowledge()).toBe('already');
    expect(fake.count()).toBe(before);
  });

  it('spreads checks evenly over the window and keeps each token on its own offset', () => {
    const buckets = new Array<number>(60).fill(0);
    for (let i = 0; i < 60_000; i += 1) {
      const s = bazaarCheckSpread(`spread-token-${i}`);
      expect(s).toBe(bazaarCheckSpread(`spread-token-${i}`));
      buckets[Math.floor(s / (BAZAAR_CHECK_SPREAD_MS / 60))]! += 1;
    }
    expect(Math.min(...buckets)).toBeGreaterThan(850);
    expect(Math.max(...buckets)).toBeLessThan(1150);
  });
});

describe.skipIf(!hasRedis)('the call meter (Valkey)', () => {
  let redis: Redis;
  const prefix = testPrefix();
  const keys = createKeys(prefix);
  let now = Date.UTC(2026, 10, 9, 10, 0, 30);

  beforeAll(() => {
    redis = testRedis();
  });
  afterAll(async () => {
    await dropPrefix(redis, prefix);
    await redis.quit();
  });

  it('always lets purchases through, paces background calls per minute and keeps the quota for purchases', async () => {
    const meter = new RedisBazaarCallMeter(redis, keys, { perMinute: 5, daily: 12 }, () => now);
    for (let i = 0; i < 5; i += 1) await meter.take('background');
    const paced = (await rejection(meter.take('background'))) as BazaarApiError;
    expect(paced).toMatchObject({ kind: 'unavailable' });
    expect(paced.retryAfterSeconds).toBe(30);
    // A purchase in the same minute goes, and counts.
    await meter.take('urgent');
    expect(await meter.today()).toBe(6);
    now += 60_000;
    for (let i = 0; i < 5; i += 1) await meter.take('background');
    now += 60_000;
    await meter.take('background');
    // The day's background cap: 12 counted, the next background call waits for the next day.
    const waits = (await rejection(meter.take('background'))) as BazaarApiError;
    expect(waits.message).toContain('next day');
    expect(waits.retryAfterSeconds).toBeGreaterThan(13 * 3600);
    await meter.take('urgent');
    expect(await meter.today()).toBe(13);
    expect(await redis.ttl(keys.iapStoreCalls(2, `d${utcDay(now)}`))).toBeGreaterThan(2 * 86_400);
    expect(await redis.ttl(keys.iapStoreCalls(2, `m${Math.floor(now / 60_000)}`))).toBeLessThanOrEqual(180);
  });

  it("stops background calls for the day after Bazaar's quota answer", async () => {
    const meter = new RedisBazaarCallMeter(redis, keys, {}, () => now + 2 * 86_400_000);
    await meter.take('background');
    await meter.exhausted();
    expect(await meter.today()).toBe(BAZAAR_DAILY_QUOTA);
    expect(await rejection(meter.take('background'))).toMatchObject({ kind: 'unavailable' });
    await meter.take('urgent');
    expect(BAZAAR_BACKGROUND_DAILY_CAP).toBeLessThan(BAZAAR_DAILY_QUOTA);
  });

  it('holds nothing back when Valkey cannot be reached', async () => {
    const away = new Redis('redis://127.0.0.1:1', { lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null });
    const seen: unknown[] = [];
    const meter = new RedisBazaarCallMeter(away, keys, {}, () => now, (error) => seen.push(error));
    await meter.take('background');
    expect(seen).toHaveLength(1);
    away.disconnect();
  });
});
