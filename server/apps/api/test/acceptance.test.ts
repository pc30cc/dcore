import { randomBytes } from 'node:crypto';
import { meSchema } from '@app/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BAZAAR,
  PLAY,
  authApp,
  device,
  migratedDatabase,
  phone,
  post,
  row,
  rows,
  signInWithPhone,
  statements,
  type AuthHarness,
  type TempDatabase,
} from './authSupport.js';
import { ME_VIEW_SHAPE } from '../src/services/account.js';
import { REALTIME_SECRET } from './accountSupport.js';
import { TEST_REDIS_URL, hasInfrastructure } from './support.js';

/**
 * The milestone's acceptance checks that cross the parts of the API, run on
 * one app with every route registered, against real PostgreSQL and Valkey,
 * starting from a real sign-in (the SMS provider is a fake behind its
 * interface). Each block names the criterion it proves; the other criteria
 * are proved by the suites the notes list.
 */

type Pair = { accessToken: string; refreshToken: string; user: { id: string; status: string } };

const TEHRAN = { lat: 35.6892, lng: 51.389 };
/** About 30 km away: another r7 cell. */
const KARAJ = { lat: 35.8327, lng: 50.9915 };

describe.skipIf(!hasInfrastructure)('W2 acceptance', () => {
  let db: TempDatabase;
  let h: AuthHarness;
  let redis: Redis;
  const tokens: string[] = [];
  const numbers: string[] = [];

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await authApp(db, { env: { CENTRIFUGO_TOKEN_HMAC_SECRET: REALTIME_SECRET } });
    redis = new Redis(TEST_REDIS_URL ?? '');
  }, 60_000);
  afterAll(async () => {
    await redis?.quit();
    await h?.close();
    await db?.drop();
  });

  const as = (token: string, client = PLAY) => ({ authorization: `Bearer ${token}`, 'x-client': client, 'accept-language': 'en' });
  const send = (method: 'GET' | 'PUT' | 'PATCH' | 'POST', url: string, token: string, body?: unknown, headers: Record<string, string> = {}) =>
    h.app.inject({ method, url, headers: { ...as(token), ...headers }, ...(body === undefined ? {} : { payload: body as Record<string, unknown> }) });

  async function signIn(number = phone('ir'), dev = device()): Promise<Pair> {
    numbers.push(number);
    const res = await signInWithPhone(h, number, dev);
    expect(res.statusCode, res.body).toBe(200);
    const pair = res.json<Pair>();
    tokens.push(pair.accessToken, pair.refreshToken);
    return pair;
  }

  /** Sets an app_config value and announces it as the panel does, then waits until the API serves it. */
  async function setAppConfig(key: string, value: unknown): Promise<void> {
    await db.sql.query(`UPDATE public.app_config SET value = $2::jsonb, updated_at = now() WHERE key = $1`, [key, JSON.stringify(value)]);
    const version = await redis.incr(`${h.prefix}cfg:v`);
    await redis.publish(`${h.prefix}cfg:changed`, String(version));
    for (let i = 0; i < 300 && h.app.cfg.peek()?.version !== version; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.app.cfg.peek()?.version).toBe(version);
  }

  const userIdOf = (publicUid: string) => String(h.app.publicIds.user.decodeId(publicUid));

  describe('criterion 3: the statement budgets of the steady-state routes', () => {
    it('costs what the table says, measured by the statement counter on one signed-in account', async () => {
      const budgets: Record<string, number> = {};

      const config = await h.app.inject({ method: 'GET', url: '/v1/config?store=play&locale=en', headers: { 'x-client': PLAY } });
      expect(config.statusCode).toBe(200);
      budgets['GET /v1/config'] = statements(config);
      const revalidated = await h.app.inject({ method: 'GET', url: '/v1/config?store=play&locale=en', headers: { 'x-client': PLAY, 'if-none-match': String(config.headers.etag) } });
      expect(revalidated.statusCode).toBe(304);
      budgets['GET /v1/config (304)'] = statements(revalidated);

      const number = phone('ir');
      const start = await post(h, '/v1/auth/otp/start', { phone: number, locale: 'fa' });
      expect(start.statusCode).toBe(200);
      budgets['POST /v1/auth/otp/start'] = statements(start);
      await redis.del(h.app.keys.otpResendWait(h.app.otp.phoneKeyHash(number)));
      const pair = await signIn(number);

      const miss = await send('GET', '/v1/me', pair.accessToken);
      expect(miss.statusCode).toBe(200);
      budgets['GET /v1/me, miss'] = statements(miss);
      const warm = await send('GET', '/v1/me', pair.accessToken);
      expect(warm.json()).toEqual(miss.json());
      budgets['GET /v1/me, warm'] = statements(warm);
      const notModified = await send('GET', '/v1/me', pair.accessToken, undefined, { 'if-none-match': String(warm.headers.etag) });
      expect(notModified.statusCode).toBe(304);
      budgets['GET /v1/me, 304'] = statements(notModified);

      const refreshed = await h.app.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { 'x-client': PLAY }, payload: { refreshToken: pair.refreshToken } });
      expect(refreshed.statusCode).toBe(200);
      budgets['POST /v1/auth/refresh'] = statements(refreshed);
      const access = refreshed.json<{ accessToken: string; refreshToken: string }>();
      tokens.push(access.accessToken, access.refreshToken);

      const firstCell = await send('PUT', '/v1/me/location', access.accessToken, { ...TEHRAN, accuracyM: 30, source: 'gps' });
      expect(firstCell.statusCode, firstCell.body).toBe(200);
      budgets['PUT /v1/me/location, new cell'] = statements(firstCell);
      const sameCell = await send('PUT', '/v1/me/location', access.accessToken, { lat: TEHRAN.lat + 0.0004, lng: TEHRAN.lng - 0.0004, accuracyM: 25, source: 'gps' });
      expect(sameCell.statusCode).toBe(200);
      budgets['PUT /v1/me/location, same cell'] = statements(sameCell);

      const pushToken = `fcm-${randomBytes(24).toString('base64url')}`;
      tokens.push(pushToken);
      const deviceBody = { pushToken, notificationsEnabled: true, appVersion: '1.2.0', locale: 'en' };
      const firstDevice = await send('PUT', '/v1/devices/current', access.accessToken, deviceBody);
      expect(firstDevice.statusCode).toBe(204);
      expect(statements(firstDevice)).toBeGreaterThanOrEqual(1);
      const unchanged = await send('PUT', '/v1/devices/current', access.accessToken, deviceBody);
      expect(unchanged.statusCode).toBe(204);
      budgets['PUT /v1/devices/current, unchanged'] = statements(unchanged);

      const realtime = await send('POST', '/v1/realtime/token', access.accessToken);
      expect(realtime.statusCode).toBe(200);
      budgets['POST /v1/realtime/token'] = statements(realtime);

      expect(budgets).toEqual({
        'GET /v1/config': 0,
        'GET /v1/config (304)': 0,
        'POST /v1/auth/otp/start': 0,
        'GET /v1/me, miss': 1,
        'GET /v1/me, warm': 0,
        'GET /v1/me, 304': 0,
        'POST /v1/auth/refresh': 1,
        'PUT /v1/me/location, new cell': 1,
        'PUT /v1/me/location, same cell': 0,
        'PUT /v1/devices/current, unchanged': 0,
        'POST /v1/realtime/token': 0,
      });

      // The new cell is stored as the cell and its centre only, never the reported point.
      const stored = await row<{ cell: string }>(db, 'SELECT home_h3::text AS cell FROM user_locations WHERE user_id = $1', [userIdOf(pair.user.id)]);
      expect(stored.cell).toMatch(/^\d+$/);
      // A move to another cell after the change limit is one statement again.
      await redis.del(h.app.keys.raw('rl', 'loc', userIdOf(pair.user.id)));
      const moved = await send('PUT', '/v1/me/location', access.accessToken, { ...KARAJ, source: 'network' });
      expect(moved.statusCode, moved.body).toBe(200);
      expect(statements(moved)).toBe(1);
    });
  });

  describe('two Valkey roles: kv-core and kv-cache (REDIS_CACHE_URL)', () => {
    it('keeps own-account views in kv-cache and their versions in kv-core', async () => {
      const cacheUrl = new URL(TEST_REDIS_URL ?? '');
      cacheUrl.pathname = '/13';
      const split = await authApp(db, { env: { REDIS_CACHE_URL: cacheUrl.toString() } });
      const cache = new Redis(cacheUrl.toString());
      try {
        expect(split.app.cache).not.toBe(split.app.redis);
        const number = phone('ir');
        numbers.push(number);
        const pair = (await signInWithPhone(split, number)).json<Pair>();
        tokens.push(pair.accessToken, pair.refreshToken);
        const userId = String(split.app.publicIds.user.decodeId(pair.user.id));
        const headers = { authorization: `Bearer ${pair.accessToken}`, 'x-client': PLAY };
        const miss = await split.app.inject({ method: 'GET', url: '/v1/me', headers });
        expect(statements(miss)).toBe(1);
        const version = await redis.get(`${split.prefix}mev:${userId}`);
        expect(version).not.toBeNull();
        const view = `${split.prefix}me:${userId}:${version}:s${ME_VIEW_SHAPE}`;
        expect(await cache.exists(view)).toBe(1);
        expect(await redis.exists(view)).toBe(0);
        expect(await cache.exists(`${split.prefix}mev:${userId}`)).toBe(0);
        const warm = await split.app.inject({ method: 'GET', url: '/v1/me', headers });
        expect(statements(warm)).toBe(0);
        // Losing the cache costs one statement, never a wrong answer.
        await cache.del(view);
        const rebuilt = await split.app.inject({ method: 'GET', url: '/v1/me', headers });
        expect(statements(rebuilt)).toBe(1);
        expect(rebuilt.json()).toEqual(warm.json());
      } finally {
        const keys = await cache.keys(`${split.prefix}*`);
        if (keys.length > 0) await cache.del(...keys);
        await cache.quit();
        await split.close();
      }
    });
  });

  describe('the cached device fingerprints follow every write of a device row', () => {
    const deviceRow = async (deviceId: string) =>
      row<{ token: string | null; disabled: boolean }>(db, 'SELECT push_token AS token, disabled_at IS NOT NULL AS disabled FROM devices WHERE id = $1', [deviceId]);
    const deviceOf = (accessToken: string) => String((JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { did: string }).did);

    it('writes again on a phone whose token another account took, and after a sign-in rewrote the row', async () => {
      const shared = device();
      const a = await signIn(phone('ir'), shared);
      const pushToken = `fcm-${randomBytes(24).toString('base64url')}`;
      tokens.push(pushToken);
      const report = (accessToken: string, notificationsEnabled = true) =>
        send('PUT', '/v1/devices/current', accessToken, { pushToken, notificationsEnabled, appVersion: '1.2.0', locale: 'en' });
      const aDevice = deviceOf(a.accessToken);
      expect((await report(a.accessToken)).statusCode).toBe(204);
      expect(await deviceRow(aDevice)).toEqual({ token: pushToken, disabled: false });

      // Another account signs in on the same phone: the token moves to its device row.
      const b = await signIn(phone('ir'), shared);
      const bDevice = deviceOf(b.accessToken);
      expect(bDevice).not.toBe(aDevice);
      expect((await report(b.accessToken)).statusCode).toBe(204);
      expect(await deviceRow(aDevice)).toEqual({ token: null, disabled: false });
      // The first account reports the same token again: it is written back, not skipped as unchanged.
      const back = await report(a.accessToken);
      expect(statements(back)).toBeGreaterThanOrEqual(1);
      expect(await deviceRow(aDevice)).toEqual({ token: pushToken, disabled: false });
      expect((await deviceRow(bDevice)).token).toBeNull();

      // Notifications off, then a sign-in on the same device enables the row again; the next report must write.
      expect((await report(a.accessToken, false)).statusCode).toBe(204);
      expect((await deviceRow(aDevice)).disabled).toBe(true);
      const number = phone('ir');
      const c = await signIn(number, shared);
      const cDevice = deviceOf(c.accessToken);
      expect((await report(c.accessToken, false)).statusCode).toBe(204);
      expect((await deviceRow(cDevice)).disabled).toBe(true);
      await redis.del(h.app.keys.otpResendWait(h.app.otp.phoneKeyHash(number)));
      const again = await signIn(number, shared);
      expect(deviceOf(again.accessToken)).toBe(cDevice);
      expect((await deviceRow(cDevice)).disabled).toBe(false);
      const off = await report(again.accessToken, false);
      expect(statements(off)).toBeGreaterThanOrEqual(1);
      expect((await deviceRow(cDevice)).disabled).toBe(true);
    });
  });

  describe('criterion 6: under 18, and the consents of onboarding', () => {
    it('closes the account from the basics step, and refuses its number and device key from device_bans after the cache is gone', async () => {
      // Its own Valkey database, which the test empties (FLUSHDB stands for FLUSHALL without touching the other suites).
      const lostUrl = new URL(TEST_REDIS_URL ?? '');
      lostUrl.pathname = '/12';
      const own = await authApp(db, { redisUrl: lostUrl.toString(), waitForValkey: true });
      try {
        const number = phone('ir');
        numbers.push(number);
        const dev = device();
        const signedIn = await signInWithPhone(own, number, dev);
        expect(signedIn.statusCode).toBe(200);
        const pair = signedIn.json<Pair>();
        tokens.push(pair.accessToken, pair.refreshToken);
        // This app has keys of its own.
        const userId = String(own.app.publicIds.user.decodeId(pair.user.id));
        const headers = { authorization: `Bearer ${pair.accessToken}`, 'x-client': PLAY };

        expect((await own.app.inject({ method: 'PATCH', url: '/v1/me/profile', headers, payload: { displayName: 'Kim', onboardingStep: 2 } })).statusCode).toBe(200);
        const young = new Date();
        young.setUTCFullYear(young.getUTCFullYear() - 17);
        const basics = await own.app.inject({
          method: 'PUT',
          url: '/v1/me/basics',
          headers,
          payload: { birthDate: young.toISOString().slice(0, 10), gender: 'woman', consents: { terms: 1, privacy: 1, guidelines: 1 } },
        });
        expect(basics.statusCode).toBe(422);
        expect(basics.json()).toMatchObject({ code: 'under_age' });

        // Straight to the tombstone: no birth date or gender stored, closed as under age.
        expect(await row(db, 'SELECT status, birth_date, gender, deleted_via FROM users WHERE id = $1', [userId])).toEqual({
          status: 8,
          birth_date: null,
          gender: null,
          deleted_via: 4,
        });
        const bans = await rows<{ kind: number; year: boolean }>(
          db,
          `SELECT kind, expires_at > now() + interval '364 days' AND expires_at <= now() + interval '366 days' AS year FROM device_bans WHERE reason = 'under_age' AND created_at > now() - interval '1 minute' ORDER BY kind`,
        );
        expect(bans).toEqual([
          { kind: 1, year: true },
          { kind: 2, year: true },
        ]);
        expect((await own.app.inject({ method: 'GET', url: '/v1/me', headers })).statusCode).toBe(401);

        // Valkey forgets everything; the refusal comes from device_bans.
        const lost = new Redis(lostUrl.toString());
        await lost.flushdb();
        expect(await lost.dbsize()).toBe(0);
        await lost.quit();
        const samePhone = await signInWithPhone(own, number, device());
        expect(samePhone.statusCode).toBe(403);
        expect(samePhone.json()).toMatchObject({ code: 'phone_banned' });
        const sameDevice = await signInWithPhone(own, phone('ir'), dev);
        expect(sameDevice.statusCode).toBe(403);
        expect(sameDevice.json()).toMatchObject({ code: 'device_banned' });
      } finally {
        await own.close();
      }
    });

    it('is refused by the database too (users_adult)', async () => {
      const pair = await signIn();
      const young = new Date();
      young.setUTCFullYear(young.getUTCFullYear() - 17);
      await expect(db.sql.query('UPDATE users SET birth_date = $2, gender = 1 WHERE id = $1', [userIdOf(pair.user.id), young.toISOString().slice(0, 10)])).rejects.toMatchObject({
        code: '23514',
        constraint: 'users_adult',
      });
    });

    it('writes the consent rows with the basics, and asks again once legal.versions is raised', async () => {
      const pair = await signIn();
      const userId = userIdOf(pair.user.id);
      expect((await send('PATCH', '/v1/me/profile', pair.accessToken, { displayName: 'Ana', onboardingStep: 2 })).statusCode).toBe(200);
      const basics = await send('PUT', '/v1/me/basics', pair.accessToken, { birthDate: '1995-04-02', gender: 'woman', consents: { terms: 1, privacy: 1, guidelines: 1 } });
      expect(basics.statusCode, basics.body).toBe(200);
      expect(await rows(db, 'SELECT kind, version FROM user_consents WHERE user_id = $1 AND withdrawn_at IS NULL ORDER BY kind', [userId])).toEqual([
        { kind: 1, version: 1 },
        { kind: 2, version: 1 },
        { kind: 3, version: 1 },
      ]);
      expect(meSchema.parse((await send('GET', '/v1/me', pair.accessToken)).json()).consentsDue).toEqual([]);

      await setAppConfig('legal.versions', { terms: 2, privacy: 1, guidelines: 1 });
      try {
        expect(meSchema.parse((await send('GET', '/v1/me', pair.accessToken)).json()).consentsDue).toEqual(['terms']);
        const accepted = await send('PUT', '/v1/me/consents/terms', pair.accessToken, { version: 2, accepted: true });
        expect(accepted.statusCode).toBe(200);
        expect(meSchema.parse((await send('GET', '/v1/me', pair.accessToken)).json()).consentsDue).toEqual([]);
      } finally {
        await setAppConfig('legal.versions', { terms: 1, privacy: 1, guidelines: 1 });
      }
    });
  });

  describe('criterion 9: privacy, and Google sign-in on the play build only', () => {
    it('refuses Google sign-in to a bazaar client before anything else', async () => {
      const nonce = await h.app.inject({ method: 'POST', url: '/v1/auth/google/nonce', headers: { 'x-client': BAZAAR } });
      expect(nonce.statusCode).toBe(403);
      expect(nonce.json()).toMatchObject({ code: 'store_not_supported' });
      const signInGoogle = await h.app.inject({
        method: 'POST',
        url: '/v1/auth/google',
        headers: { 'x-client': BAZAAR },
        payload: { idToken: 'x'.repeat(40), nonceId: randomBytes(16).toString('base64url'), ...device() },
      });
      expect(signInGoogle.statusCode).toBe(403);
      expect(signInGoogle.json()).toMatchObject({ code: 'store_not_supported' });
      expect(statements(signInGoogle)).toBe(0);
      // The play build gets a nonce.
      expect((await h.app.inject({ method: 'POST', url: '/v1/auth/google/nonce', headers: { 'x-client': PLAY } })).statusCode).toBe(200);
    });

    it('wrote no phone number, code, coordinate, push token or refresh token to the log of this suite', () => {
      const log = h.logs.join('\n');
      expect(log.length).toBeGreaterThan(0);
      expect(log).not.toMatch(/\+\d{8,}/);
      for (const number of numbers) expect(log).not.toContain(number.slice(1));
      for (const token of tokens) expect(log).not.toContain(token);
      for (const { lat, lng } of [TEHRAN, KARAJ]) {
        expect(log).not.toContain(String(lat));
        expect(log).not.toContain(String(lng));
      }
      for (const sent of [...h.sms.kavenegar.sent, ...h.sms.telnyx.sent]) expect(log).not.toContain(`"${sent.code}"`);
    });
  });
});
