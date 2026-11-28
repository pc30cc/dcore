import { randomUUID } from 'node:crypto';
import { adminConfigListSchema, adminConfigResultSchema, adminConfigKeyList, type AdminConfigItem, type AppConfig } from '@app/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkConfigRules, settingsVersion, stableJson } from '../src/admin/configRules.js';
import { HttpProblem } from '../src/lib/problem.js';
import { call, migratedDatabase, row, seedUser, statements, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, lastAudit, seedAdmin, startAdminHarness, type AdminHarness, type AdminSession } from './adminSupport.js';
import { matchOf } from './chatSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * The admin panel's app settings (`/v1/admin/config`): the allow-list, the
 * permission of each key (config.legal and config.providers are the
 * superadmin's), versions, the rules beyond the schemas, and the effects in the
 * same process right after a save (maintenance, minimum version, limits),
 * with in-app deletion, the session refresh and logout still answered
 * during maintenance.
 */

describe.skipIf(!hasInfrastructure)('admin: app settings', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  let superadmin: AdminSession;
  let adminRole: AdminSession;
  let support: AdminSession;

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startAdminHarness(db);
    superadmin = await adminAs(h, 'superadmin');
    adminRole = await adminAs(h, 'admin');
    support = await adminAs(h, 'support');
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await db?.drop();
  });

  const read = async (session: AdminSession, keys?: string) => {
    const res = await admin(h, `/v1/admin/config${keys ? `?keys=${keys}` : ''}`, undefined, { token: session.accessToken });
    return { res, items: res.statusCode === 200 ? adminConfigListSchema.parse(res.json()).items : [] };
  };
  const item = async (key: string): Promise<AdminConfigItem> => (await read(superadmin, key)).items[0]!;
  const put = (session: AdminSession, key: string, value: unknown, baseVersion: string) =>
    admin(h, `/v1/admin/config/${key}`, { value, baseVersion }, { token: session.accessToken, method: 'PUT' });
  /** Saves `value` from the current version and waits until this process loaded it. */
  const save = async (key: string, value: unknown) => {
    const res = await put(superadmin, key, value, (await item(key)).version);
    expect(res.statusCode, res.body).toBe(200);
    for (let i = 0; i < 300; i += 1) {
      const loaded = (h.app.cfg.peek()?.app as Record<string, unknown> | undefined)?.[key];
      if (stableJson(loaded) === stableJson(value)) return res;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`${key} was not loaded`);
  };
  const cfgVersion = async () => Number((await h.redis.get(`${h.prefix}cfg:v`)) ?? '0');
  const fieldOf = (res: { json: () => unknown }) => (res.json() as { errors?: { pointer: string; code: string }[] }).errors?.[0];

  beforeEach(async () => {
    await save('app.maintenance', { enabled: false, message: {} }).catch(() => undefined);
  });

  it('reads every allow-listed key in one statement, with who may write it', async () => {
    const { res, items } = await read(superadmin);
    expect(res.statusCode).toBe(200);
    expect(statements(res)).toBe(1);
    expect(items.map((i) => i.key)).toEqual(adminConfigKeyList);
    const write = Object.fromEntries(items.map((i) => [i.key, i.write]));
    expect(write['app.maintenance']).toBe('config.write');
    expect(write['legal.versions']).toBe('config.legal');
    expect(write['auth.sms_routing']).toBe('config.providers');
    expect(write['retention.deleted_account_days']).toBeNull();
    expect((await read(superadmin, 'calls.enabled,signup.countries')).items.map((i) => i.key)).toEqual(['calls.enabled', 'signup.countries']);
    expect((await read(superadmin, 'calls.enabled,auth.otp')).res.statusCode).toBe(400);
    expect((await read(support)).res.statusCode).toBe(403);
  });

  it('writes a key with its audit row; an unchanged save writes nothing and announces nothing', async () => {
    const before = await item('calls.enabled');
    const res = await put(superadmin, 'calls.enabled', { audio: true, video: false }, before.version);
    expect(res.statusCode, res.body).toBe(200);
    expect(statements(res)).toBeLessThanOrEqual(3);
    const saved = adminConfigResultSchema.parse(res.json()).item;
    expect(saved.value).toEqual({ audio: true, video: false });
    expect(saved.version).not.toBe(before.version);
    expect(saved.updatedBy?.id).toBe(String(superadmin.account.id));
    const audit = await lastAudit(db, { action: 'config.update', targetType: 6 });
    expect(audit?.detail).toMatchObject({ key: 'calls.enabled', after: { audio: true, video: false } });
    // The stale version: refused, nothing written.
    const stale = await put(superadmin, 'calls.enabled', { audio: false, video: false }, before.version);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'conflict', reason: 'settings_changed' });
    // The same value again: no row, no announcement.
    const version = await cfgVersion();
    const count = (await row<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_log WHERE action = 'config.update'`)).n;
    const again = await put(superadmin, 'calls.enabled', { video: false, audio: true }, saved.version);
    expect(again.statusCode).toBe(200);
    expect((await row<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_log WHERE action = 'config.update'`)).n).toBe(count);
    expect(await cfgVersion()).toBe(version);
    await save('calls.enabled', { audio: true, video: true });
  });

  it('holds each key to its permission: legal values and the SMS routing are the superadmin\'s, the restore period is read-only', async () => {
    const maintenance = await item('app.maintenance');
    expect((await put(adminRole, 'app.maintenance', { enabled: false, message: { en: 'Back soon' } }, maintenance.version)).statusCode).toBe(200);
    const legal = await item('legal.versions');
    const refused = await put(adminRole, 'legal.versions', legal.value, legal.version);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ reason: 'role' });
    const routing = await item('auth.sms_routing');
    expect((await put(adminRole, 'auth.sms_routing', routing.value, routing.version)).statusCode).toBe(403);
    for (const key of ['retention.unsent_body_hours', 'safety.child_safety_contact']) {
      const current = await item(key);
      expect((await put(adminRole, key, current.value, current.version)).statusCode, key).toBe(403);
    }
    const restore = await item('retention.deleted_account_days');
    const readOnly = await put(superadmin, 'retention.deleted_account_days', 20, restore.version);
    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json()).toMatchObject({ reason: 'read_only' });
    expect((await put(superadmin, 'auth.otp', {}, restore.version)).statusCode).toBe(404);
    // The superadmin writes the legal values.
    const raised = await put(superadmin, 'legal.versions', { ...(legal.value as object), terms: (legal.value as { terms: number }).terms + 1 }, legal.version);
    expect(raised.statusCode, raised.body).toBe(200);
  });

  it('refuses values outside the schemas and the panel\'s bounds, at their field', async () => {
    const versions = await item('app.min_version');
    const below = await put(superadmin, 'app.min_version', { cafe_bazaar: { required: 10, recommended: 5 }, google_play: { required: 0, recommended: 0 } }, versions.version);
    expect(below.statusCode).toBe(422);
    expect(fieldOf(below)).toMatchObject({ pointer: '/value/cafe_bazaar/recommended', code: 'below_required' });
    const tooHigh = await put(superadmin, 'app.min_version', { cafe_bazaar: { required: 2_100_000_001, recommended: 2_100_000_001 }, google_play: { required: 0, recommended: 0 } }, versions.version);
    expect(fieldOf(tooHigh)).toMatchObject({ pointer: '/value/cafe_bazaar/required', code: 'out_of_range' });
    const unsent = await item('retention.unsent_body_hours');
    expect(fieldOf(await put(superadmin, 'retention.unsent_body_hours', 500, unsent.version))).toMatchObject({ pointer: '/value', code: 'out_of_range' });
    const legal = await item('legal.versions');
    const lowered = await put(superadmin, 'legal.versions', { ...(legal.value as object), privacy: 0 }, legal.version);
    expect(fieldOf(lowered)?.pointer).toBe('/value/privacy');
    const value = legal.value as { terms: number; privacy: number; guidelines: number };
    if (value.privacy > 1) expect(fieldOf(await put(superadmin, 'legal.versions', { ...value, privacy: value.privacy - 1 }, legal.version))?.code).toBe('version_lowered');
    const limits = await item('limits.rates');
    const rates = limits.value as Record<string, number>;
    expect(fieldOf(await put(superadmin, 'limits.rates', { ...rates, reports_per_day: 0 }, limits.version))?.pointer).toBe('/value/reports_per_day');
    expect(fieldOf(await put(superadmin, 'limits.rates', { ...rates, swipes_per_hour: 10 }, limits.version))).toMatchObject({ pointer: '/value/swipes_per_hour', code: 'out_of_range' });
    // Reports never below the shipped 10 a day (a safety path); the other caps stay near what shipped.
    for (const [field, value] of [
      ['reports_per_day', 9],
      ['reports_per_day', 51],
      ['messages_per_minute', 121],
      ['messages_per_conversation', 41],
      ['swipes_per_hour', 1_201],
    ] as const) {
      expect(fieldOf(await put(superadmin, 'limits.rates', { ...rates, [field]: value }, limits.version)), `${field} ${value}`).toMatchObject({ pointer: `/value/${field}`, code: 'out_of_range' });
    }
    for (const [field, value] of [
      ['reports_per_day', 10],
      ['messages_per_minute', 120],
      ['swipes_per_hour', 1_200],
    ] as const) {
      const next = { ...(rates as AppConfig['limits.rates']), [field]: value };
      expect(() => checkConfigRules('limits.rates', null, next, { production: true }), `${field} ${value}`).not.toThrow();
    }
    const countries = await item('signup.countries');
    const twice = await put(superadmin, 'signup.countries', { default: { allowed: true }, countries: [{ code: 'TR', allowed: true, unit: 'km', language: 'tr' }, { code: 'TR', allowed: false, unit: 'km', language: null }] }, countries.version);
    expect(twice.statusCode).toBe(422);
  });

  it('never routes to the test SMS provider in production', () => {
    const routing = { routes: [{ prefix: '+98', providers: ['kavenegar', 'fake'] as const }], default: ['fake'] as const };
    expect(() => checkConfigRules('auth.sms_routing', null, { routes: [{ prefix: '+98', providers: [...routing.routes[0]!.providers] }], default: [] }, { production: true })).toThrow(HttpProblem);
    try {
      checkConfigRules('auth.sms_routing', null, { routes: [], default: [...routing.default] }, { production: true });
      expect.unreachable();
    } catch (error) {
      expect((error as HttpProblem).init?.errors?.[0]).toMatchObject({ pointer: '/value/default/0', code: 'fake_provider' });
    }
    expect(() => checkConfigRules('auth.sms_routing', null, { routes: [], default: ['fake'] }, { production: false })).not.toThrow();
    expect(settingsVersion({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(settingsVersion({ a: [1, { c: 3, d: 2 }], b: 1 }));
    expect(settingsVersion(undefined)).not.toBe(settingsVersion({}));
  });

  it('applies at once: maintenance answers 503 but deletion, the refresh and logout still answer; a higher minimum answers 426', async () => {
    const person = await seedUser(h, { name: 'Maintained' });
    await save('app.maintenance', { enabled: true, message: { en: 'Back soon' } });
    const me = await call(h, '/v1/me', { token: person.token });
    expect(me.statusCode).toBe(503);
    expect(me.json()).toMatchObject({ code: 'maintenance', message: 'Back soon' });
    expect((await call(h, '/v1/config?store=bazaar&locale=en')).statusCode).toBe(200);
    expect((await call(h, '/v1/me/deletion/preflight', { token: person.token })).statusCode).not.toBe(503);
    expect((await call(h, '/v1/auth/refresh', { method: 'POST', body: { refreshToken: 'not-a-token-at-all-0000000000000000000000000' } })).statusCode).not.toBe(503);
    const leaving = await seedUser(h, { name: 'Leaving' });
    expect((await call(h, '/v1/auth/logout', { method: 'POST', token: leaving.token, body: {} })).statusCode).not.toBe(503);
    await save('app.maintenance', { enabled: false, message: {} });
    expect((await call(h, '/v1/me', { token: person.token })).statusCode).toBe(200);
    await save('app.min_version', { cafe_bazaar: { required: 500, recommended: 500 }, google_play: { required: 0, recommended: 0 } });
    const old = await call(h, '/v1/me', { token: person.token, client: 'bazaar/120' });
    expect(old.statusCode).toBe(426);
    expect((await call(h, '/v1/me', { token: person.token, client: 'play/120' })).statusCode).toBe(200);
    expect((await call(h, '/v1/me/deletion/preflight', { token: person.token, client: 'bazaar/120' })).statusCode).not.toBe(426);
    await save('app.min_version', { cafe_bazaar: { required: 0, recommended: 0 }, google_play: { required: 0, recommended: 0 } });
  });

  it('takes the per-person limits from the panel: reports, message sends and swipes', async () => {
    const rates = (await item('limits.rates')).value as Record<string, number>;
    // Reports: 12 a day instead of the shipped 10.
    await save('limits.rates', { ...rates, reports_per_day: 12 });
    const reporter = await seedUser(h, { name: 'Reporter' });
    const target = await seedUser(h, { name: 'Target' });
    const report = () => call(h, '/v1/reports', { method: 'POST', token: reporter.token, body: { target: target.publicUid, context: 'profile', reason: 'scam' } });
    for (let i = 0; i < 12; i += 1) expect((await report()).statusCode, `report ${i + 1}`).toBe(202);
    expect((await report()).statusCode).toBe(429);
    // Messages: 5 per conversation in 10 s.
    await save('limits.rates', { ...rates, messages_per_conversation: 5 });
    const ava = await seedUser(h, { name: 'Ava' });
    const ben = await seedUser(h, { name: 'Ben' });
    const match = await matchOf(h, ava.id, ben.id);
    const send = (n: number) => call(h, `/v1/conversations/${match.id}/messages`, { method: 'POST', token: ava.token, body: { clientId: randomUUID(), kind: 'text', body: `m${n}` } });
    for (let i = 0; i < 5; i += 1) expect((await send(i)).statusCode, `message ${i + 1}`).toBe(201);
    expect((await send(5)).statusCode).toBe(429);
    // Swipes: 60 an hour; a batch past the cap is refused whole.
    await save('limits.rates', { ...rates, swipes_per_hour: 60 });
    const swiper = await seedUser(h, { name: 'Swiper' });
    const passes = (n: number) => Array.from({ length: n }, () => ({ target: h.app.publicIds.user.encode(h.app.ids.nextId()), action: 'pass' }));
    const swipe = (batch: { target: string; action: string }[]) => call(h, '/v1/swipes', { method: 'POST', token: swiper.token, body: { swipes: batch } });
    for (let i = 0; i < 3; i += 1) expect((await swipe(passes(20))).statusCode, `batch ${i + 1}`).toBe(200);
    const over = await swipe(passes(1));
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ code: 'rate_limited' });
    await save('limits.rates', rates);
  });

  it('closes sign-up in a country: the location step and the sign-up finish refuse it, people already in are not held back', async () => {
    await save('signup.countries', { default: { allowed: true }, countries: [{ code: 'IR', allowed: false, unit: 'km', language: 'fa' }] });
    const signingUp = await seedUser(h, { status: 1, country: null });
    const place = (token: string) => call(h, '/v1/me/location', { method: 'PUT', token, body: { source: 'gps', lat: 35.7, lng: 51.4 } });
    const refused = await place(signingUp.token);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'country_not_supported' });
    expect(statements(refused)).toBeLessThanOrEqual(2);
    const active = await seedUser(h, { name: 'Already in' });
    expect((await place(active.token)).statusCode).toBe(200);
    // A country listed as open, and every other one by default.
    await save('signup.countries', { default: { allowed: false }, countries: [{ code: 'IR', allowed: true, unit: 'km', language: 'fa' }] });
    expect((await place(signingUp.token)).statusCode).toBe(200);
    await save('signup.countries', { default: { allowed: true }, countries: [] });
  });

  it('shows distances in the unit of the account\'s country (GET /v1/me), kilometres where it is not listed', async () => {
    const home = await seedUser(h, { name: 'Unit at home' });
    const away = await seedUser(h, { name: 'Unit away', country: 'TR' });
    const me = (token: string) => call(h, '/v1/me', { token });
    const unitOf = async (token: string) => {
      const res = await me(token);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ distanceUnit?: string }>().distanceUnit;
    };
    expect(await unitOf(home.token)).toBe('km');
    const etag = (await me(home.token)).headers.etag;
    await save('signup.countries', { default: { allowed: true }, countries: [{ code: 'IR', allowed: true, unit: 'mi', language: null }] });
    expect(await unitOf(home.token)).toBe('mi');
    expect(await unitOf(away.token)).toBe('km');
    // The answer a phone holds is not taken as current: the ETag follows the settings, and a warm read stays free.
    const warm = await me(home.token);
    expect(warm.headers.etag).not.toBe(etag);
    expect(statements(warm)).toBe(0);
    expect((await call(h, '/v1/me', { token: home.token, headers: { 'if-none-match': String(etag) } })).statusCode).toBe(200);
    await save('signup.countries', { default: { allowed: true }, countries: [] });
    expect(await unitOf(home.token)).toBe('km');
  });

  it('asks for the second factor on the superadmin-only writes while one is required', async () => {
    const guard = h.app.requireMfa;
    const request = (mfa: boolean | undefined) => ({ principal: { kind: 'admin', subject: '1', sessionId: '1', roles: ['superadmin'], mfa } }) as unknown as FastifyRequest;
    const reply = {} as FastifyReply;
    await expect(guard(request(false), reply)).rejects.toMatchObject({ code: 'forbidden', init: { extensions: { reason: 'mfa_required' } } });
    await expect(guard(request(true), reply)).resolves.toBeUndefined();
    h.app.adminAuth.totpRequired = false;
    try {
      await expect(guard(request(false), reply)).resolves.toBeUndefined();
    } finally {
      h.app.adminAuth.totpRequired = true;
    }
    expect(h.app.routesRequiringMfa().sort()).toEqual(
      [
        'GET /v1/admin/providers',
        'PUT /v1/admin/providers/:kind',
        'DELETE /v1/admin/providers/:kind',
        'GET /v1/admin/providers/rtc',
        'PUT /v1/admin/providers/rtc',
        // system: the role editor and the jobs page's actions
        'PUT /v1/admin/roles/:key/permissions',
        'POST /v1/admin/system/dead-letters/delete',
        'POST /v1/admin/system/jobs/retry',
        'POST /v1/admin/system/jobs/remove',
        'POST /v1/admin/system/tasks/run',
      ].sort(),
    );
  });
});

describe.skipIf(!hasInfrastructure)('admin: app settings with the second factor off (a test stack)', () => {
  let db: TestDatabase;
  let h: AdminHarness;

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startAdminHarness(db, { ADMIN_TOTP_REQUIRED: 'false' });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await db?.drop();
  });

  it('lets a password-only superadmin session write the legal values and providers', async () => {
    const account = await seedAdmin(h, { roles: ['superadmin'] });
    const login = await admin(h, '/v1/admin/auth/login', { email: account.email, password: account.password });
    expect(login.statusCode, login.body).toBe(200);
    const token = login.json<{ session: { accessToken: string } }>().session.accessToken;
    const legal = (await admin(h, '/v1/admin/config?keys=legal.versions', undefined, { token })).json<{ items: AdminConfigItem[] }>().items[0]!;
    const res = await admin(h, '/v1/admin/config/legal.versions', { value: legal.value, baseVersion: legal.version }, { token, method: 'PUT' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await admin(h, '/v1/admin/providers', undefined, { token })).statusCode).toBe(200);
  });
});
