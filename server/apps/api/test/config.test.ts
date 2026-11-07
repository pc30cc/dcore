import { configSchema } from '@app/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hasInfrastructure } from './support.js';
import { call, migratedDatabase, problemExt, seedUser, setAppConfig, startHarness, statements, type Harness, type TestDatabase } from './accountSupport.js';

/** GET /v1/config and the configuration in memory (app_config, cfg:v, cfg:changed), against PostgreSQL and Valkey. */
describe.skipIf(!hasInfrastructure)('configuration', () => {
  let db: TestDatabase;
  let h: Harness | undefined;

  beforeAll(async () => {
    db = await migratedDatabase();
  }, 60_000);
  afterAll(async () => {
    await db?.drop();
  });
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('serves the document from memory: no statement, an ETag, 304 on revalidation', async () => {
    h = await startHarness(db);
    const first = await call(h, '/v1/config?store=bazaar&locale=fa');
    expect(first.statusCode).toBe(200);
    expect(statements(first)).toBe(0);
    expect(first.headers['cache-control']).toBe('public, max-age=300');
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/^"c\d+-[A-Za-z0-9_-]{16}"$/);
    const doc = configSchema.strict().parse(first.json());
    expect(doc.auth).toEqual({ otpLength: 6, methods: ['phone'] });
    expect(doc.legal.versions).toEqual({ terms: 1, privacy: 1, guidelines: 1 });
    expect(doc.minVersion).toEqual({ required: 1, recommended: 1 });
    expect(doc.limits).toMatchObject({ photosMax: 9, photosMin: 2, messageMax: 2000 });
    expect(doc.catalog.intentions.map((i) => i.key)).toEqual(['serious', 'marriage', 'friendship', 'not_sure']);
    expect(doc.catalog.intentions[1]?.label).toBe('ازدواج');
    expect(doc.catalog.reportReasons.map((r) => r.key)).toContain('child_safety');
    expect(doc.planNames).toEqual({ plus: 'پلاس', premium: 'پریمیوم' });

    const again = await call(h, '/v1/config?store=bazaar&locale=fa', { headers: { 'if-none-match': etag } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    expect(statements(again)).toBe(0);
    // Another language is another document.
    const en = await call(h, '/v1/config?store=bazaar&locale=en', { headers: { 'if-none-match': etag } });
    expect(en.statusCode).toBe(200);
    expect(configSchema.parse(en.json()).catalog.intentions[1]?.label).toBe('Marriage');
  });

  it('lists Google sign-in for the play build only, when the server can verify Google tokens', async () => {
    h = await startHarness(db, { GOOGLE_WEB_CLIENT_ID: '123-abc.apps.googleusercontent.com' });
    expect(configSchema.parse((await call(h, '/v1/config?store=play&locale=en')).json()).auth.methods).toEqual(['phone', 'google']);
    expect(configSchema.parse((await call(h, '/v1/config?store=bazaar&locale=en')).json()).auth.methods).toEqual(['phone']);
  });

  it('follows the panel: a change announced on cfg:changed is served at once, with a new ETag', async () => {
    h = await startHarness(db);
    const before = await call(h, '/v1/config?store=play&locale=tr');
    await db.sql.query(`INSERT INTO i18n_strings (brand_id, locale, key, value) VALUES (0, 'tr', 'deck.empty', 'Yakında kimse yok')`);
    await db.sql.query(
      `INSERT INTO profile_field_defs (type, key, i18n, options, is_filterable, filter_slot)
       VALUES (1, 'smoking', '{"en": "Smoking", "tr": "Sigara"}', '[{"id": 1, "i18n": {"en": "No", "tr": "Hayır"}}, {"id": 2, "i18n": {"en": "Yes"}, "active": false}]', true, 1)`,
    );
    await db.sql.query(`INSERT INTO prompt_defs (kind, i18n) VALUES (1, '{"en": "A good day", "tr": "İyi bir gün"}'), (2, '{"en": "In my voice"}')`);
    await setAppConfig(h, 'app.min_version', { cafe_bazaar: { required: 1, recommended: 1 }, google_play: { required: 40, recommended: 45 } });
    const after = await call(h, '/v1/config?store=play&locale=tr', { headers: { 'if-none-match': String(before.headers.etag) } });
    expect(after.statusCode).toBe(200);
    expect(after.headers.etag).not.toBe(before.headers.etag);
    const doc = configSchema.strict().parse(after.json());
    expect(doc.strings).toEqual({ 'deck.empty': 'Yakında kimse yok' });
    expect(doc.minVersion).toEqual({ required: 40, recommended: 45 });
    expect(doc.catalog.fields).toEqual([
      { id: expect.any(Number) as number, key: 'smoking', label: 'Sigara', kind: 'single', options: [{ id: 1, label: 'Hayır' }], private: false, filterable: true, sensitive: false, required: false },
    ]);
    expect(doc.catalog.prompts.map((p) => [p.text, p.category])).toEqual([
      ['İyi bir gün', undefined],
      ['In my voice', 'voice'],
    ]);
    // The minimum version reached the client policy: an old play build is refused on app routes, never on config.
    const user = await seedUser(h, { name: 'Ada' });
    const old = await call(h, '/v1/me', { token: user.token, client: 'play/39' });
    expect(old.statusCode).toBe(426);
    expect(problemExt('upgrade_required', old.json())['minVersionCode']).toBe(40);
    expect((await call(h, '/v1/me', { token: user.token, client: 'bazaar/39' })).statusCode).toBe(200);
    expect((await call(h, '/v1/config?store=play&locale=en', { client: 'play/39' })).statusCode).toBe(200);
    await setAppConfig(h, 'app.min_version', { cafe_bazaar: { required: 1, recommended: 1 }, google_play: { required: 1, recommended: 1 } });
  });

  it('answers app routes 503 during maintenance but keeps serving config, in the request language', async () => {
    h = await startHarness(db);
    const user = await seedUser(h, { name: 'Ada' });
    await setAppConfig(h, 'app.maintenance', { enabled: true, message: { fa: 'به‌زودی برمی‌گردیم.', en: 'Back soon.' } });
    try {
      const me = await call(h, '/v1/me', { token: user.token, headers: { 'accept-language': 'fa' } });
      expect(me.statusCode).toBe(503);
      expect(me.json()).toMatchObject({ code: 'maintenance', message: 'به‌زودی برمی‌گردیم.' });
      const doc = configSchema.parse((await call(h, '/v1/config?store=bazaar&locale=fa')).json());
      expect(doc.maintenance).toEqual({ enabled: true, message: 'به‌زودی برمی‌گردیم.' });
      expect(configSchema.parse((await call(h, '/v1/config?store=bazaar&locale=tr')).json()).maintenance).toEqual({ enabled: true });
    } finally {
      await setAppConfig(h, 'app.maintenance', { enabled: false, message: {} });
    }
    expect((await call(h, '/v1/me', { token: user.token })).statusCode).toBe(200);
  });

  it('catches a change whose message was missed by polling cfg:v', async () => {
    h = await startHarness(db, {}, { accountServices: { configPollMs: 50 } });
    const before = h.app.cfg.get().version;
    await db.sql.query(`UPDATE public.app_config SET value = '{"terms": 1, "privacy": 3, "guidelines": 1}' WHERE key = 'legal.versions'`);
    // A new version, without the message.
    await h.redis.set(`${h.prefix}cfg:v`, String(before + 7));
    for (let i = 0; i < 200 && h.app.cfg.get().version !== before + 7; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.app.cfg.get().version).toBe(before + 7);
    expect(configSchema.parse((await call(h, '/v1/config?store=bazaar&locale=en')).json()).legal.versions.privacy).toBe(3);
    await db.sql.query(`UPDATE public.app_config SET value = '{"terms": 1, "privacy": 1, "guidelines": 1}' WHERE key = 'legal.versions'`);
  });

  it('keeps the last good configuration when a saved value does not parse', async () => {
    h = await startHarness(db);
    const good = h.app.cfg.get();
    await db.sql.query(`UPDATE public.app_config SET value = '{"length": 99}' WHERE key = 'auth.otp'`);
    try {
      const version = await h.redis.incr(`${h.prefix}cfg:v`);
      await h.redis.publish(`${h.prefix}cfg:changed`, String(version));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(h.app.cfg.get()).toBe(good);
      expect(h.logs.some((line) => line.includes('config: load failed'))).toBe(true);
      expect((await call(h, '/v1/config?store=bazaar&locale=en')).statusCode).toBe(200);
    } finally {
      await db.sql.query(`UPDATE public.app_config SET value = '{"length": 6, "ttl_seconds": 300, "max_attempts": 5}' WHERE key = 'auth.otp'`);
    }
  });

  it('feeds the sign-in settings from app_config', async () => {
    h = await startHarness(db);
    expect(h.app.authSettings.get().otp.length).toBe(6);
    await setAppConfig(h, 'auth.otp', { length: 5, ttl_seconds: 300, max_attempts: 5 });
    try {
      expect(h.app.authSettings.get().otp.length).toBe(5);
      expect(configSchema.parse((await call(h, '/v1/config?store=bazaar&locale=en')).json()).auth.otpLength).toBe(5);
    } finally {
      await setAppConfig(h, 'auth.otp', { length: 6, ttl_seconds: 300, max_attempts: 5 });
    }
  });

  it('limits config reads per address and refuses an unknown store', async () => {
    h = await startHarness(db);
    expect((await call(h, '/v1/config?store=appstore&locale=en')).json()).toMatchObject({ code: 'validation_failed' });
    let last = 0;
    for (let i = 0; i < 61; i += 1) last = (await call(h, '/v1/config?store=bazaar&locale=en')).statusCode;
    expect(last).toBe(429);
  });
});
