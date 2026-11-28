import type { InjectOptions } from 'fastify';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AdminPasswords, HashGate } from '../src/admin/hashing.js';
import type { ApiApp } from '../src/app.js';
import { HttpProblem } from '../src/lib/problem.js';
import { ClientPolicyHolder, OPEN_POLICY, clientPolicyFromConfig, parseClientHeader, pickLocale } from '../src/plugins/client.js';
import { rateLimitKey } from '../src/plugins/rateLimit.js';
import { CHEAP_ARGON2 } from './adminSupport.js';
import { testApp, testConfig } from './support.js';

let app: ApiApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const policy = new ClientPolicyHolder();

/** A password gate held full by one run that never ends until released: every other run is refused at once. */
const fullGate = new HashGate({ concurrency: 1, queue: 0 });
let releaseGate: () => void = () => undefined;

async function started(logLines?: string[]): Promise<ApiApp> {
  policy.set(OPEN_POLICY);
  const logger = logLines ? { logger: pino({ level: 'debug' }, { write: (line: string) => void logLines.push(line) }) } : {};
  app = await testApp(testConfig(), { clientPolicy: policy, ...logger });
  const echo = async (request: { client: unknown; locale: string }) => ({ client: request.client, locale: request.locale });
  app.get('/v1/test/echo', { config: { pgBudget: 0 } }, echo);
  app.get('/v1/test/broken', { config: { pgBudget: 0 } }, async () => {
    throw new Error('broken on purpose');
  });
  // A dependency that is down: the same code a planned answer may carry, but a failure.
  app.get('/v1/test/down', { config: { pgBudget: 0 } }, async () => {
    throw new HttpProblem('service_unavailable', { detail: 'Try again in a moment.', cause: new Error('dependency down') });
  });
  // The admin password queue full: load shed on purpose.
  const passwords = new AdminPasswords(CHEAP_ARGON2, fullGate);
  app.get('/v1/test/busy', { config: { pgBudget: 0 } }, async () => {
    await passwords.burn('x');
    return {};
  });
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

  it('logs answers given on purpose at info on the request\'s own line, without a stack, and real failures at error', async () => {
    const lines: string[] = [];
    const instance = await started(lines);
    type Line = { level: number; msg: string; requestId?: string; code?: string; res?: { statusCode?: number }; err?: { stack?: string } };
    const linesOf = async (inject: InjectOptions) => {
      const response = await instance.inject(inject);
      const id = String(response.headers['x-request-id']);
      return { response, logged: lines.map((line) => JSON.parse(line) as Line).filter((line) => line.requestId === id) };
    };
    /** A refusal leaves Fastify's two lines and no other: "request completed" carries the code and the status. */
    const answeredOnPurpose = (logged: readonly Line[], code: string, status: number) => {
      expect(logged.filter((line) => line.level >= 40 || line.err !== undefined)).toEqual([]);
      expect(logged.map((line) => line.msg)).toEqual(['incoming request', 'request completed']);
      expect(logged[1]).toMatchObject({ level: 30, code, res: { statusCode: status } });
    };

    policy.set({ ...OPEN_POLICY, maintenance: { enabled: true, message: { en: 'Back soon.' } } });
    const maintenance = await linesOf({ method: 'GET', url: '/v1/test/echo', headers: { 'x-client': 'bazaar/1' } });
    expect(maintenance.response.statusCode).toBe(503);
    answeredOnPurpose(maintenance.logged, 'maintenance', 503);

    policy.set({ ...OPEN_POLICY, minVersion: { bazaar: 10, play: 10 } });
    const upgrade = await linesOf({ method: 'GET', url: '/v1/test/echo', headers: { 'x-client': 'bazaar/1' } });
    expect(upgrade.response.statusCode).toBe(426);
    answeredOnPurpose(upgrade.logged, 'upgrade_required', 426);
    const header = await linesOf({ method: 'GET', url: '/v1/test/echo' });
    expect(header.response.statusCode).toBe(400);
    answeredOnPurpose(header.logged, 'bad_request', 400);

    policy.set(OPEN_POLICY);
    // The password queue full: a 503 shed on purpose, no error line and no stack.
    const holding = fullGate.run(() => new Promise<void>((resolve) => (releaseGate = resolve)));
    try {
      const busy = await linesOf({ method: 'GET', url: '/v1/test/busy', headers: { 'x-client': 'bazaar/1' } });
      expect(busy.response.statusCode).toBe(503);
      expect(busy.response.headers['retry-after']).toBe('5');
      answeredOnPurpose(busy.logged, 'service_unavailable', 503);
    } finally {
      releaseGate();
      await holding;
    }
    const ok = await linesOf({ method: 'GET', url: '/v1/test/echo', headers: { 'x-client': 'bazaar/1' } });
    expect(ok.logged.find((line) => line.msg === 'request completed')).not.toHaveProperty('code');

    // Real failures: a problem with a 5xx code (a dependency down) and an error that is not a problem.
    for (const [url, stack] of [
      ['/v1/test/down', 'dependency down'],
      ['/v1/test/broken', 'broken on purpose'],
    ] as const) {
      const failed = await linesOf({ method: 'GET', url, headers: { 'x-client': 'bazaar/1' } });
      expect(failed.response.statusCode, url).toBeGreaterThanOrEqual(500);
      const errors = failed.logged.filter((line) => line.level >= 50);
      expect(errors.map((line) => line.msg), url).toEqual(['request failed']);
      expect(JSON.stringify(errors[0]?.err), url).toContain(stack);
      expect(errors[0]?.err?.stack, url).toBeTruthy();
      expect(failed.logged.filter((line) => line.level < 50 && line.err !== undefined), url).toEqual([]);
    }
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
      CENTRIFUGO_API_URL: 'http://centrifugo:8000',
      CENTRIFUGO_API_KEY: 'a'.repeat(32),
      CENTRIFUGO_PROXY_KEY: 'p'.repeat(32),
      // Photo storage and its CDN are required in production.
      S3_ENDPOINT: 'https://s3.example.com',
      S3_BUCKET_PRIVATE: 'uploads',
      S3_BUCKET_MEDIA: 'media',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'secret',
      CDN_BASE_URL: 'https://cdn.example.com',
      CDN_SIGNING_KEY: 'k'.repeat(32),
      // The origins document is signed in production, always.
      ORIGINS_SIGNING_KEY: 'A'.repeat(43),
    };
    expect(testConfig({ ...production, LOG_LEVEL: 'info', PG_BUDGET: 'count' }).pgBudget).toBe('count');
    expect(() => testConfig({ ...production, PG_BUDGET: 'enforce' })).toThrow(/PG_BUDGET/);
  });

  it('refuses to start in production without the origins signing key, and runs without it elsewhere', () => {
    const production = {
      NODE_ENV: 'production',
      BRAND: 'live',
      LOG_LEVEL: 'info',
      PG_BUDGET: 'count',
      CENTRIFUGO_TOKEN_HMAC_SECRET: 'c'.repeat(32),
      CENTRIFUGO_API_URL: 'http://centrifugo:8000',
      CENTRIFUGO_API_KEY: 'a'.repeat(32),
      CENTRIFUGO_PROXY_KEY: 'p'.repeat(32),
      S3_ENDPOINT: 'https://s3.example.com',
      S3_BUCKET_PRIVATE: 'uploads',
      S3_BUCKET_MEDIA: 'media',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'secret',
      CDN_BASE_URL: 'https://cdn.example.com',
      CDN_SIGNING_KEY: 'k'.repeat(32),
    };
    let message = '';
    try {
      testConfig(production);
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/ORIGINS_SIGNING_KEY/);
    expect(message).toMatch(/required in production/);
    expect(() => testConfig({ ...production, ORIGINS_SIGNING_KEY: 'not-a-seed' })).toThrow(/ORIGINS_SIGNING_KEY/);
    expect(testConfig({ ...production, ORIGINS_SIGNING_KEY: 'A'.repeat(43) }).origins.signingKey).toBe('A'.repeat(43));
    // Development and tests may run without it (GET /v1/origins then answers 503).
    expect(testConfig({ NODE_ENV: 'development' }).origins.signingKey).toBeUndefined();
    expect(testConfig().origins.signingKey).toBeUndefined();
  });

  it('refuses connection tokens without the subscribe-check key (in production and elsewhere), a key shared with another secret, and a port shared with the API', () => {
    const production = {
      NODE_ENV: 'production',
      BRAND: 'live',
      LOG_LEVEL: 'info',
      PG_BUDGET: 'count',
      CENTRIFUGO_TOKEN_HMAC_SECRET: 'c'.repeat(32),
      CENTRIFUGO_API_URL: 'http://centrifugo:8000',
      CENTRIFUGO_API_KEY: 'a'.repeat(32),
      S3_ENDPOINT: 'https://s3.example.com',
      S3_BUCKET_PRIVATE: 'uploads',
      S3_BUCKET_MEDIA: 'media',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'secret',
      CDN_BASE_URL: 'https://cdn.example.com',
      CDN_SIGNING_KEY: 'k'.repeat(32),
      ORIGINS_SIGNING_KEY: 'A'.repeat(43),
    };
    expect(() => testConfig(production)).toThrow(/CENTRIFUGO_PROXY_KEY/);
    for (const same of ['c'.repeat(32), 'a'.repeat(32)]) expect(() => testConfig({ ...production, CENTRIFUGO_PROXY_KEY: same })).toThrow(/CENTRIFUGO_PROXY_KEY/);
    expect(() => testConfig({ ...production, CENTRIFUGO_PROXY_KEY: 'short' })).toThrow(/CENTRIFUGO_PROXY_KEY/);
    expect(() => testConfig({ ...production, CENTRIFUGO_PROXY_KEY: `${'p'.repeat(32)}"` })).toThrow(/CENTRIFUGO_PROXY_KEY/);
    expect(() => testConfig({ ...production, CENTRIFUGO_PROXY_KEY: 'p'.repeat(32), PORT: '8081' })).toThrow(/REALTIME_PROXY_PORT/);
    expect(testConfig({ ...production, CENTRIFUGO_PROXY_KEY: 'p'.repeat(32) }).realtime.proxy).toEqual({ key: 'p'.repeat(32), port: 8081 });
    expect(testConfig({ ...production, CENTRIFUGO_PROXY_KEY: 'p'.repeat(32), REALTIME_PROXY_PORT: '9101' }).realtime.proxy?.port).toBe(9101);
    // Elsewhere too, connection tokens come with the check (every Centrifugo configuration here asks it); without tokens, no key and no listener.
    for (const NODE_ENV of ['development', 'test']) {
      expect(() => testConfig({ NODE_ENV, CENTRIFUGO_TOKEN_HMAC_SECRET: 'c'.repeat(32) }), NODE_ENV).toThrow(/CENTRIFUGO_PROXY_KEY.*CENTRIFUGO_TOKEN_HMAC_SECRET/s);
      expect(testConfig({ NODE_ENV, CENTRIFUGO_TOKEN_HMAC_SECRET: 'c'.repeat(32), CENTRIFUGO_PROXY_KEY: 'p'.repeat(32) }).realtime.proxy?.key, NODE_ENV).toBe('p'.repeat(32));
    }
    expect(testConfig().realtime.proxy).toBeUndefined();
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

  it('takes PROVIDER_KEYS as a ring of its own: required in production, optional elsewhere, never sharing a key with DATA_KEYS', () => {
    const production = {
      NODE_ENV: 'production',
      BRAND: 'live',
      LOG_LEVEL: 'info',
      PG_BUDGET: 'count',
      CENTRIFUGO_TOKEN_HMAC_SECRET: 'c'.repeat(32),
      CENTRIFUGO_API_URL: 'http://centrifugo:8000',
      CENTRIFUGO_API_KEY: 'a'.repeat(32),
      CENTRIFUGO_PROXY_KEY: 'p'.repeat(32),
      S3_ENDPOINT: 'https://s3.example.com',
      S3_BUCKET_PRIVATE: 'uploads',
      S3_BUCKET_MEDIA: 'media',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'secret',
      CDN_BASE_URL: 'https://cdn.example.com',
      CDN_SIGNING_KEY: 'k'.repeat(32),
      ORIGINS_SIGNING_KEY: 'A'.repeat(43),
    };
    // An empty value is an unset one (as an .env file copied from the example leaves it).
    let message = '';
    try {
      testConfig({ ...production, PROVIDER_KEYS: '' });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/PROVIDER_KEYS/);
    expect(message).toMatch(/required in production/);
    expect(testConfig(production).secrets.providerKeys).toBeDefined();
    // Development and tests start without it (panel provider entries then read `unreadable`, saves are refused).
    for (const NODE_ENV of ['development', 'test']) expect(testConfig({ NODE_ENV, PROVIDER_KEYS: '' }).secrets.providerKeys, NODE_ENV).toBeUndefined();
    // Wherever it is set, it is checked: its id names one of its keys, and no key is one of DATA_KEYS.
    const shared = 'S'.repeat(43);
    for (const NODE_ENV of ['production', 'development']) {
      const env = NODE_ENV === 'production' ? production : { NODE_ENV };
      let refused = '';
      try {
        testConfig({ ...env, DATA_KEYS: JSON.stringify({ 1: shared }), PROVIDER_KEYS: JSON.stringify({ 1: 'P'.repeat(43), 2: shared }) });
      } catch (error) {
        refused = String(error);
      }
      expect(refused, NODE_ENV).toMatch(/PROVIDER_KEYS.*must not hold a key of DATA_KEYS/s);
      expect(refused, NODE_ENV).not.toContain(shared);
      expect(() => testConfig({ ...env, PROVIDER_KEYS: JSON.stringify({ 1: 'P'.repeat(43) }), PROVIDER_KEY_ID: '2' }), NODE_ENV).toThrow(/PROVIDER_KEY_ID/);
      expect(() => testConfig({ ...env, PROVIDER_KEYS: '{"1":"c2VjcmV0"}' }), NODE_ENV).toThrow(/PROVIDER_KEYS/);
    }
  });

  it('decorates the app with the codecs, secrets and key names', async () => {
    app = await testApp();
    const uid = app.publicIds.user.encode(112314686237569028n);
    expect(app.publicIds.user.decodeId(uid)).toBe('112314686237569028');
    expect(app.keys.denyUser('5')).toMatch(/^t[0-9a-f]{8}:deny:uid:5$/);
    expect(app.secrets.sealer.openText(app.secrets.sealer.seal('x', 'p'), 'p')).toBe('x');
  });
});

describe('request bodies', () => {
  const options = (body: z.ZodType) => ({ config: { pgBudget: 0 }, schema: { body } });
  const echo = async (request: { body: unknown }) => ({ body: request.body ?? 'absent' });

  async function withBodies(): Promise<ApiApp> {
    app = await testApp();
    app.post('/v1/test/body/nullish', options(z.object({ all: z.boolean().optional() }).nullish()), echo);
    app.post('/v1/test/body/required', options(z.object({ all: z.boolean() })), echo);
    app.post('/v1/test/body/optional', options(z.object({ all: z.boolean().optional() }).optional()), echo);
    await app.ready();
    return app;
  }

  const send = (instance: ApiApp, url: string, payload?: string, type?: string) =>
    instance.inject({ method: 'POST', url, headers: { 'x-client': 'play/1', ...(type ? { 'content-type': type } : {}) }, ...(payload === undefined ? {} : { payload }) });

  it('takes no body, or zero bytes of JSON, where the body is nullish, and still refuses JSON that does not parse', async () => {
    const instance = await withBodies();
    const url = '/v1/test/body/nullish';
    for (const [payload, type] of [[undefined, undefined], ['', 'application/json'], ['', 'application/json; charset=utf-8'], ['null', 'application/json']] as const) {
      const response = await send(instance, url, payload, type);
      expect(response.statusCode, `${String(type)} ${String(payload)}`).toBe(200);
      expect(response.json()).toEqual({ body: 'absent' });
    }
    expect((await send(instance, url, '{"all":true}', 'application/json')).json()).toEqual({ body: { all: true } });
    for (const payload of ['{', '{"__proto__":{"all":true}}']) {
      const refused = await send(instance, url, payload, 'application/json');
      expect(refused.statusCode, payload).toBe(400);
      expect(refused.json(), payload).toMatchObject({ code: 'bad_request' });
    }
  });

  it('refuses a missing required body by its schema, with or without the JSON header', async () => {
    const instance = await withBodies();
    for (const [payload, type] of [[undefined, undefined], ['', 'application/json']] as const) {
      const response = await send(instance, '/v1/test/body/required', payload, type);
      expect(response.statusCode, String(type)).toBe(400);
      expect(response.json(), String(type)).toMatchObject({ code: 'validation_failed', errors: [{ in: 'body', pointer: '' }] });
    }
  });

  it('lists a route whose body is a bare optional (Fastify validates no body as null, which it refuses)', async () => {
    const instance = await withBodies();
    expect(instance.routesWithUndefinedOnlyBody()).toEqual(['POST /v1/test/body/optional']);
    expect((await send(instance, '/v1/test/body/optional')).statusCode).toBe(400);
  });

  it('starts with a body schema that throws on an absent body, and lists that route', async () => {
    app = await testApp();
    // Parsing these throws instead of reporting issues: a preprocess that reads a property, an async refinement.
    app.post('/v1/test/body/reads', options(z.preprocess((value) => (value as { all: unknown }).all, z.boolean())), echo);
    app.post('/v1/test/body/async', options(z.unknown().refine(async () => true)), echo);
    await app.ready();
    expect(app.routesWithUndefinedOnlyBody()).toEqual(['POST /v1/test/body/reads (schema throws on an absent body)', 'POST /v1/test/body/async (schema throws on an absent body)']);
    expect((await send(app, '/v1/test/body/reads', '{"all":true}', 'application/json')).json()).toEqual({ body: true });
  });
});
