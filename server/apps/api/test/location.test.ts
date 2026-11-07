import { createHash } from 'node:crypto';
import { cityListSchema, locationResultSchema, PUBLIC_UID_PATTERN, realtimeTokenSchema } from '@app/shared';
import { cellCentre, homeCell } from '@app/shared/server';
import { jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CityIndex, foldName } from '../src/services/cities.js';
import { hasInfrastructure } from './support.js';
import { REALTIME_SECRET, call, migratedDatabase, row, rows, seedUser, startHarness, statements, type Harness, type TestDatabase } from './accountSupport.js';

/** The bundled city table (no infrastructure needed). */
describe('city table', () => {
  const cities = CityIndex.bundled();

  it('finds cities by any of their names, best match first', () => {
    expect(cities.size).toBeGreaterThan(30_000);
    expect(cities.search('tehr', 'en')[0]).toEqual({ id: 112931, name: 'Tehran', country: 'IR' });
    expect(cities.search('تهر', 'fa')[0]).toEqual({ id: 112931, name: 'تهران', country: 'IR' });
    expect(cities.search('istanbul', 'tr')[0]).toEqual({ id: 745044, name: 'İstanbul', country: 'TR' });
    expect(cities.search('İstanbul', 'en')[0]?.id).toBe(745044);
    expect(cities.search('استانبول', 'fa')[0]?.name).toBe('استانبول');
    expect(cities.search('a', 'en', 'TR').every((c) => c.country === 'TR')).toBe(true);
    expect(cities.search('a', 'en')).toHaveLength(20);
    expect(cities.search('zzzzqqq', 'en')).toEqual([]);
  });

  it('folds case, diacritics and Arabic letter forms', () => {
    expect(foldName('İzmir')).toBe('izmir');
    expect(foldName('Şanlıurfa')).toBe('sanliurfa');
    expect(foldName('كرمان')).toBe(foldName('کرمان'));
    expect(foldName('شهر‌کرد')).toBe('شهر کرد');
  });

  it('names the nearest city of a point, and nothing far from every city', () => {
    const near = cities.nearest({ lat: 35.7, lng: 51.4 }, 40);
    expect(near?.city.id).toBe(112931);
    expect(near?.km).toBeLessThan(5);
    expect(cities.nearest({ lat: -45, lng: -140 }, 400)).toBeUndefined();
  });
});

describe.skipIf(!hasInfrastructure)('location, devices and the realtime token', () => {
  let db: TestDatabase;
  let h: Harness;
  /** A position inside Tehran with digits a cell centre never has. */
  const POSITION = { lat: 35.712345, lng: 51.398765 };
  const PUSH_TOKEN = 'fcm-token-ffd39ac1e2b74c5aa8f0-' + 'x'.repeat(100);

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startHarness(db);
  }, 60_000);
  afterAll(async () => {
    await h?.close();
    await db?.drop();
  });

  describe('PUT /v1/me/location', () => {
    it('keeps the cell and its centre only: one statement for a new cell, none for the same one', async () => {
      const user = await seedUser(h, { name: 'Sam', country: null });
      const first = await call(h, '/v1/me/location', { method: 'PUT', token: user.token, body: { ...POSITION, accuracyM: 30, source: 'gps' } });
      expect(first.statusCode).toBe(200);
      expect(statements(first)).toBe(1);
      expect(locationResultSchema.strict().parse(first.json())).toEqual({ city: { id: 112931, name: 'Tehran' }, country: 'IR' });

      const cell = homeCell(POSITION);
      const centre = cellCentre(cell);
      const stored = await row<{ home_h3: string; lat: number; lng: number; source: number; home_city_id: number; country: string }>(
        db,
        'SELECT home_h3::text, ST_Y(home_geo::geometry) AS lat, ST_X(home_geo::geometry) AS lng, source, home_city_id, country FROM user_locations WHERE user_id = $1',
        [user.id],
      );
      expect(stored).toMatchObject({ home_h3: cell, source: 1, home_city_id: 112931, country: 'IR' });
      expect(stored.lat).toBeCloseTo(centre.lat, 9);
      expect(stored.lng).toBeCloseTo(centre.lng, 9);
      expect(Math.abs(stored.lat - POSITION.lat) + Math.abs(stored.lng - POSITION.lng)).toBeGreaterThan(1e-5);
      // The account's own country is filled in from it.
      expect((await row<{ country: string }>(db, 'SELECT country FROM users WHERE id = $1', [user.id])).country).toBe('IR');
      // The discovery row (if any) carries the same centre; no column anywhere holds the position.
      const raw = await rows<{ table: string }>(
        db,
        `SELECT c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'`,
      );
      for (const { table } of raw) {
        const hits = await rows(db, `SELECT 1 FROM public.${table} t WHERE t::text LIKE '%35.7123%' OR t::text LIKE '%51.3987%' LIMIT 1`);
        expect(hits, table).toHaveLength(0);
      }

      // A few metres away, same cell: nothing written, no limit spent.
      const again = await call(h, '/v1/me/location', { method: 'PUT', token: user.token, body: { lat: POSITION.lat + 0.0001, lng: POSITION.lng, source: 'gps' } });
      expect(again.statusCode).toBe(200);
      expect(statements(again)).toBe(0);

      // Another cell within the minute: refused; after it, one statement.
      const moved = { lat: 35.75, lng: 51.25, source: 'gps' };
      const early = await call(h, '/v1/me/location', { method: 'PUT', token: user.token, body: moved });
      expect(early.statusCode).toBe(429);
      expect(early.json()).toMatchObject({ code: 'rate_limited', retryAfterSeconds: expect.any(Number) as number });
      await h.redis.del(`${h.prefix}rl:loc:${user.id}`);
      const later = await call(h, '/v1/me/location', { method: 'PUT', token: user.token, body: moved });
      expect(later.statusCode).toBe(200);
      expect(statements(later)).toBe(1);
      expect((await row<{ home_h3: string }>(db, 'SELECT home_h3::text FROM user_locations WHERE user_id = $1', [user.id])).home_h3).toBe(homeCell(moved as { lat: number; lng: number }));
    });

    it('takes a city picked by hand as its cell, and refuses unknown cities and unserved places', async () => {
      const user = await seedUser(h, { name: 'Ada' });
      const res = await call(h, '/v1/me/location', { method: 'PUT', token: user.token, body: { source: 'city', cityId: 745044 }, headers: { 'accept-language': 'fa' } });
      expect(res.json()).toEqual({ city: { id: 745044, name: 'استانبول' }, country: 'TR' });
      expect((await row<{ source: number; home_city_id: number }>(db, 'SELECT source, home_city_id FROM user_locations WHERE user_id = $1', [user.id]))).toEqual({ source: 2, home_city_id: 745044 });
      const other = await seedUser(h, { name: 'Bo' });
      expect((await call(h, '/v1/me/location', { method: 'PUT', token: other.token, body: { source: 'city', cityId: 1 } })).json()).toMatchObject({ code: 'field_invalid' });
      expect((await call(h, '/v1/me/location', { method: 'PUT', token: other.token, body: { lat: -45, lng: -140, source: 'gps' } })).json()).toMatchObject({ code: 'field_invalid' });
      expect((await call(h, '/v1/me/location', { method: 'PUT', token: other.token, body: { source: 'gps' } })).json()).toMatchObject({ code: 'validation_failed' });
    });
  });

  describe('GET /v1/cities', () => {
    it('searches the bundled table in the request language without a statement', async () => {
      const user = await seedUser(h, { name: 'Ida' });
      const res = await call(h, '/v1/cities?q=tabr', { token: user.token, headers: { 'accept-language': 'fa' } });
      expect(res.statusCode).toBe(200);
      expect(statements(res)).toBe(0);
      const list = cityListSchema.strict().parse(res.json());
      expect(list.items[0]).toEqual({ id: 113646, name: 'تبریز', country: 'IR' });
      expect(cityListSchema.parse((await call(h, '/v1/cities?q=a&country=TR', { token: user.token })).json()).items.every((c) => c.country === 'TR')).toBe(true);
      expect((await call(h, '/v1/cities?q=', { token: user.token })).statusCode).toBe(400);
    });
  });

  describe('PUT /v1/devices/current', () => {
    it('writes a change in one transaction and an unchanged state with no statement', async () => {
      const user = await seedUser(h, { name: 'Lu' });
      const body = { pushToken: PUSH_TOKEN, notificationsEnabled: true, appVersion: '1.4.2', locale: 'fa' };
      const first = await call(h, '/v1/devices/current', { method: 'PUT', token: user.token, body, client: 'bazaar/12031' });
      expect(first.statusCode).toBe(204);
      expect(statements(first)).toBe(2);
      const device = await row<{ push_token: string; push_token_hash: Buffer; app_version: number; locale: string; disabled_at: Date | null }>(
        db,
        'SELECT push_token, push_token_hash, app_version, locale, disabled_at FROM devices WHERE id = $1',
        [user.deviceId],
      );
      expect(device).toMatchObject({ push_token: PUSH_TOKEN, app_version: 12031, locale: 'fa', disabled_at: null });
      expect(device.push_token_hash.equals(createHash('sha256').update(PUSH_TOKEN).digest())).toBe(true);

      const same = await call(h, '/v1/devices/current', { method: 'PUT', token: user.token, body, client: 'bazaar/12031' });
      expect(same.statusCode).toBe(204);
      expect(statements(same)).toBe(0);
      // Not even Valkey keeps the token.
      const stored = await h.redis.get(`${h.prefix}dev:${user.deviceId}`);
      expect(stored).not.toContain('fcm');

      // The same token on another account's device (a shared phone) moves there.
      const other = await seedUser(h, { name: 'Mo' });
      const moved = await call(h, '/v1/devices/current', { method: 'PUT', token: other.token, body, client: 'bazaar/12031' });
      expect(moved.statusCode).toBe(204);
      expect((await row<{ push_token: string | null }>(db, 'SELECT push_token FROM devices WHERE id = $1', [user.deviceId])).push_token).toBeNull();
      expect((await row<{ push_token: string | null }>(db, 'SELECT push_token FROM devices WHERE id = $1', [other.deviceId])).push_token).toBe(PUSH_TOKEN);

      // No push on this phone (or notifications off): one statement.
      const none = await call(h, '/v1/devices/current', { method: 'PUT', token: other.token, body: { ...body, pushToken: null, notificationsEnabled: false }, client: 'bazaar/12031' });
      expect(none.statusCode).toBe(204);
      expect(statements(none)).toBe(1);
      const cleared = await row<{ push_token: string | null; disabled_at: Date | null }>(db, 'SELECT push_token, disabled_at FROM devices WHERE id = $1', [other.deviceId]);
      expect(cleared.push_token).toBeNull();
      expect(cleared.disabled_at).not.toBeNull();
    });

    it('refuses a session without its own device row', async () => {
      const user = await seedUser(h, { name: 'Jo' });
      const stranger = await seedUser(h, { name: 'Kai' });
      const { token } = await h.app.tokens.issue({ kind: 'app', subject: user.publicUid, sessionId: user.sessionId, deviceId: stranger.deviceId, storeCode: 2 });
      const body = { pushToken: null, notificationsEnabled: true, appVersion: '1.0.0', locale: 'en' };
      expect((await call(h, '/v1/devices/current', { method: 'PUT', token, body })).statusCode).toBe(404);
      const { token: noDevice } = await h.app.tokens.issue({ kind: 'app', subject: user.publicUid, sessionId: user.sessionId, storeCode: 2 });
      expect((await call(h, '/v1/devices/current', { method: 'PUT', token: noDevice, body })).statusCode).toBe(400);
    });
  });

  describe('POST /v1/realtime/token', () => {
    it('signs a Centrifugo token for the personal channel without a statement', async () => {
      const user = await seedUser(h, { name: 'Rin' });
      const res = await call(h, '/v1/realtime/token', { method: 'POST', token: user.token });
      expect(res.statusCode).toBe(200);
      expect(statements(res)).toBe(0);
      const body = realtimeTokenSchema.strict().parse(res.json());
      expect(body.channel).toBe(`u:#${user.publicUid}`);
      expect(body.wsUrl).toBe('wss://rt.example.com/connection/websocket');
      const { payload, protectedHeader } = await jwtVerify(body.token, new TextEncoder().encode(REALTIME_SECRET), { algorithms: ['HS256'] });
      expect(protectedHeader.alg).toBe('HS256');
      expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'sub']);
      expect(payload.sub).toMatch(PUBLIC_UID_PATTERN);
      expect(payload.sub).toBe(user.publicUid);
      expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(3_600);
      expect(new Date(body.expiresAt).getTime()).toBe((payload.exp ?? 0) * 1_000);
    });

    it('answers 503 while realtime is not configured', async () => {
      const other = await startHarness(db, { CENTRIFUGO_TOKEN_HMAC_SECRET: undefined });
      try {
        const user = await seedUser(other, { name: 'Zed' });
        expect((await call(other, '/v1/realtime/token', { method: 'POST', token: user.token })).json()).toMatchObject({ code: 'service_unavailable' });
      } finally {
        await other.close();
      }
    });
  });

  describe('privacy', () => {
    it('kept no coordinate, push token or refresh token in any log line of this suite', () => {
      const text = h.logs.join('\n');
      expect(text.length).toBeGreaterThan(0);
      for (const needle of ['35.7123', '51.3987', '35.75', '51.25', 'fcm-token', 'rt1.']) expect(text, needle).not.toContain(needle);
      // Only JSON lines, each with a level.
      for (const line of h.logs) expect(z.object({ level: z.number() }).safeParse(JSON.parse(line)).success).toBe(true);
    });
  });
});
