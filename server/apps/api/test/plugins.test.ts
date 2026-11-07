import { afterEach, describe, expect, it } from 'vitest';
import type { ApiApp } from '../src/app.js';
import { ClientPolicyHolder, OPEN_POLICY, clientPolicyFromConfig, parseClientHeader, pickLocale } from '../src/plugins/client.js';
import { rateLimitKey } from '../src/plugins/rateLimit.js';
import { testApp, testConfig } from './support.js';

let app: ApiApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const policy = new ClientPolicyHolder();

async function started(): Promise<ApiApp> {
  policy.set(OPEN_POLICY);
  app = await testApp(testConfig(), { clientPolicy: policy });
  const echo = async (request: { client: unknown; locale: string }) => ({ client: request.client, locale: request.locale });
  app.get('/v1/test/echo', { config: { pgBudget: 0 } }, echo);
  // Stand-ins for routes another part of the API may already serve.
  if (!app.hasRoute({ method: 'POST', url: '/v1/auth/logout' })) app.post('/v1/auth/logout', { config: { pgBudget: 1 } }, echo);
  if (!app.hasRoute({ method: 'POST', url: '/v1/me/deletion' })) app.post('/v1/me/deletion', { config: { pgBudget: 4 } }, echo);
  if (!app.hasRoute({ method: 'POST', url: '/v1/public/account-deletion/start' })) app.post('/v1/public/account-deletion/start', { config: { pgBudget: 1 } }, echo);
  app.post('/v1/webhooks/play', { config: { pgBudget: 1 } }, echo);
  app.get('/v1/test/optional', { config: { pgBudget: 0, client: { header: 'optional' } } }, echo);
  await app.ready();
  return app;
}

describe('X-Client', () => {
  it('parses store and version code, and nothing else', () => {
    expect(parseClientHeader('bazaar/12031')).toEqual({ store: 'bazaar', storeCode: 2, versionCode: 12031 });
    expect(parseClientHeader(' play/1 ')).toEqual({ store: 'play', storeCode: 1, versionCode: 1 });
    for (const bad of [undefined, '', 'bazaar', 'bazaar/', 'bazaar/0', 'bazaar/012', 'appstore/1', 'play/1.2', 'play/99999999999', ['play/1']]) {
      expect(parseClientHeader(bad as string | undefined), String(bad)).toBeNull();
    }
  });

  it('is required on app routes, and not on probes, webhooks or the public deletion routes', async () => {
    const instance = await started();
    const missing = await instance.inject({ method: 'GET', url: '/v1/test/echo' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: 'bad_request' });
    expect((await instance.inject({ method: 'GET', url: '/v1/test/echo', headers: { 'x-client': 'ios/3' } })).statusCode).toBe(400);
    const ok = await instance.inject({ method: 'GET', url: '/v1/test/echo', headers: { 'x-client': 'bazaar/12031' } });
    expect(ok.json()).toEqual({ client: { store: 'bazaar', storeCode: 2, versionCode: 12031 }, locale: 'en' });
    expect((await instance.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    // The stand-in answers 200; the real route refuses this empty body itself (phone_invalid), never for the missing header.
    const publicStart = await instance.inject({ method: 'POST', url: '/v1/public/account-deletion/start' });
    expect(publicStart.json<{ code?: string }>().code).not.toBe('bad_request');
    expect(publicStart.statusCode).not.toBe(426);
    expect((await instance.inject({ method: 'POST', url: '/v1/webhooks/play' })).statusCode).toBe(200);
    expect((await instance.inject({ method: 'GET', url: '/v1/test/optional' })).json()).toEqual({ client: null, locale: 'en' });
    expect((await instance.inject({ method: 'GET', url: '/v1/test/optional', headers: { 'x-client': 'nonsense' } })).statusCode).toBe(400);
  });

  it('answers 426 below the store minimum, except config, logout and deletion', async () => {
    const instance = await started();
    policy.set({ ...OPEN_POLICY, minVersion: { bazaar: 12040, play: 10 } });
    const old = await instance.inject({ method: 'GET', url: '/v1/test/echo', headers: { 'x-client': 'bazaar/12031' } });
    expect(old.statusCode).toBe(426);
    expect(old.json()).toMatchObject({ code: 'upgrade_required', minVersionCode: 12040 });
    expect((await instance.inject({ method: 'GET', url: '/v1/test/echo', headers: { 'x-client': 'play/12031' } })).statusCode).toBe(200);
    for (const [method, url] of [['POST', '/v1/auth/logout'], ['POST', '/v1/me/deletion']] as const) {
      // The stand-in answers 200; a real route refuses this bare request in its own way, never with 426.
      expect((await instance.inject({ method, url, headers: { 'x-client': 'bazaar/1' } })).statusCode, url).not.toBe(426);
    }
    // The real config route (its configuration is not loaded without a database: 503, but never 426).
    expect((await instance.inject({ method: 'GET', url: '/v1/config?store=bazaar&locale=en', headers: { 'x-client': 'bazaar/1' } })).json()).toMatchObject({ code: 'service_unavailable' });
  });

  it('answers 503 maintenance in the request language, except config, probes and webhooks', async () => {
    const instance = await started();
    policy.set({ ...OPEN_POLICY, maintenance: { enabled: true, message: { fa: 'به‌زودی برمی‌گردیم.', en: 'Back soon.' } } });
    const fa = await instance.inject({ method: 'GET', url: '/v1/test/echo', headers: { 'x-client': 'bazaar/1', 'accept-language': 'fa-IR,fa;q=0.9,en;q=0.5' } });
    expect(fa.statusCode).toBe(503);
    expect(fa.json()).toMatchObject({ code: 'maintenance', message: 'به‌زودی برمی‌گردیم.' });
    expect(fa.headers['retry-after']).toBe('120');
    const tr = await instance.inject({ method: 'GET', url: '/v1/test/echo', headers: { 'x-client': 'play/1', 'accept-language': 'tr' } });
    expect(tr.json()).toMatchObject({ code: 'maintenance', message: 'Back soon.' });
    expect((await instance.inject({ method: 'GET', url: '/v1/config?store=play&locale=en', headers: { 'x-client': 'play/1' } })).json()).toMatchObject({ code: 'service_unavailable' });
    expect((await instance.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await instance.inject({ method: 'POST', url: '/v1/webhooks/play' })).statusCode).toBe(200);
  });

  it('reads the policy from app_config with its store words', () => {
    expect(
      clientPolicyFromConfig({
        'app.min_version': { cafe_bazaar: { required: 3, recommended: 4 }, google_play: { required: 5, recommended: 5 } },
        'app.maintenance': { enabled: true, message: { en: 'x' } },
      }),
    ).toEqual({ minVersion: { bazaar: 3, play: 5 }, maintenance: { enabled: true, message: { en: 'x' } } });
  });
});

describe('request language', () => {
  it('takes the best of our languages from Accept-Language', () => {
    expect(pickLocale('fa-IR,fa;q=0.9,en;q=0.5', 'en')).toBe('fa');
    expect(pickLocale('de-DE, tr;q=0.8, en;q=0.9', 'en')).toBe('en');
    expect(pickLocale('de, fr', 'fa')).toBe('fa');
    expect(pickLocale('en;q=0, tr', 'fa')).toBe('tr');
    expect(pickLocale(undefined, 'en')).toBe('en');
  });
});

describe('client address', () => {
  it('resolves cf-connecting-ip from a Cloudflare peer only', async () => {
    app = await testApp();
    app.get('/test/ip', { config: { pgBudget: 0 } }, async (request) => ({ ip: request.clientIp, country: request.clientCountry, key: rateLimitKey(request) }));
    await app.ready();
    const cf = await app.inject({ method: 'GET', url: '/test/ip', remoteAddress: '162.158.1.1', headers: { 'cf-connecting-ip': '5.160.1.2', 'cf-ipcountry': 'IR' } });
    expect(cf.json()).toEqual({ ip: '5.160.1.2', country: 'IR', key: 'ip:5.160.1.2' });
    const direct = await app.inject({ method: 'GET', url: '/test/ip', remoteAddress: '8.8.4.4', headers: { 'cf-connecting-ip': '5.160.1.2', 'cf-ipcountry': 'IR' } });
    expect(direct.json()).toEqual({ ip: '8.8.4.4', country: null, key: 'ip:8.8.4.4' });
  });
});

describe('statement budgets', () => {
  it('are declared by every route the app registers', async () => {
    app = await testApp();
    await app.ready();
    expect(app.routesWithoutBudget()).toEqual([]);
  });

  it('are enforced in tests by default and off in production', () => {
    expect(testConfig().pgBudget).toBe('enforce');
    const production = {
      NODE_ENV: 'production',
      BRAND: 'live',
      CENTRIFUGO_TOKEN_HMAC_SECRET: 'c'.repeat(32),
      // Photo storage and its CDN are required in production.
      S3_ENDPOINT: 'https://s3.example.com',
      S3_BUCKET_PRIVATE: 'uploads',
      S3_BUCKET_MEDIA: 'media',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'secret',
      CDN_BASE_URL: 'https://cdn.example.com',
      CDN_SIGNING_KEY: 'k'.repeat(32),
    };
    expect(testConfig({ ...production, LOG_LEVEL: 'info', PG_BUDGET: 'count' }).pgBudget).toBe('count');
    expect(() => testConfig({ ...production, PG_BUDGET: 'enforce' })).toThrow(/PG_BUDGET/);
  });
});

describe('configuration of ids and secrets', () => {
  it('refuses missing or equal id keys and bad key rings, naming the variable only', () => {
    const key = 'A'.repeat(43);
    expect(() => testConfig({ ID_PUBLIC_KEY: key, ID_BILLING_KEY: key })).toThrow(/ID_BILLING_KEY/);
    expect(() => testConfig({ ID_PUBLIC_KEY: 'short' })).toThrow(/ID_PUBLIC_KEY/);
    let message = '';
    try {
      testConfig({ HASH_PEPPERS: '{"1":"c2VjcmV0"}' });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/HASH_PEPPERS/);
    expect(message).not.toContain('c2VjcmV0');
  });

  it('decorates the app with the codecs, secrets and key names', async () => {
    app = await testApp();
    const uid = app.publicIds.user.encode(112314686237569028n);
    expect(app.publicIds.user.decodeId(uid)).toBe('112314686237569028');
    expect(app.keys.denyUser('5')).toMatch(/^t[0-9a-f]{8}:deny:uid:5$/);
    expect(app.secrets.sealer.openText(app.secrets.sealer.seal('x', 'p'), 'p')).toBe('x');
  });
});
