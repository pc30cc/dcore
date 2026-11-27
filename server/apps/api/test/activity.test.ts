import { utcDay } from '@app/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, migratedDatabase, seedUser, type SeededUser, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, startAdminHarness, type AdminHarness } from './adminSupport.js';
import { authApp, phone, post, type AuthHarness } from './authSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * "Active today" (`la:<yyyymmdd>`): a signed-in person's request marks them
 * once per process and UTC day, an admin never, a revoked session or person
 * never, a background route never (push registration, purchases and
 * restore, the token refresh and the sign-out, the ring report); a Valkey failure never changes an answer and
 * the next request marks again. And the day counters the API writes:
 * accepted swipes (resends, quota refusals and test accounts left out) and
 * the SMS provider's outcomes.
 */

describe.skipIf(!hasInfrastructure)('activity marks and day counters', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  const clock = { now: Date.now() };

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startAdminHarness(db, {}, { activity: { now: () => clock.now } });
    await h.redis.set(h.app.keys.likesReady(), '1');
  }, 90_000);

  afterAll(async () => {
    await h?.close();
    await db?.drop();
  });

  const members = (now: number) => h.redis.smembers(h.app.keys.activeDay(utcDay(now)));

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  it('marks a person once a day per process with a 3-day life, and again the next day', async () => {
    const person = await seedUser(h, { name: 'Ana' });
    const multi = h.app.redis.multi.bind(h.app.redis);
    let multis = 0;
    h.app.redis.multi = ((...args: Parameters<typeof multi>) => {
      multis += 1;
      return multi(...args);
    }) as typeof h.app.redis.multi;
    try {
      for (let i = 0; i < 20; i += 1) expect((await call(h, '/v1/me', { token: person.token })).statusCode).toBe(200);
      await settle();
    } finally {
      h.app.redis.multi = multi;
    }
    expect(await members(clock.now)).toContain(person.id);
    expect(multis).toBe(1);
    const ttl = await h.redis.ttl(h.app.keys.activeDay(utcDay(clock.now)));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3 * 86_400);

    const before = clock.now;
    clock.now += 86_400_000;
    try {
      await call(h, '/v1/me', { token: person.token });
      await settle();
      expect(await members(clock.now)).toContain(person.id);
    } finally {
      clock.now = before;
    }
  });

  it('never marks for an admin, or for the routes the app calls in the background', async () => {
    const owner = await adminAs(h, 'superadmin');
    expect((await admin(h, '/v1/admin/stats/live', undefined, { token: owner.accessToken })).statusCode).toBe(200);
    const quiet: SeededUser = await seedUser(h, { name: 'Bo' });
    const background: [string, 'POST' | 'PUT', unknown][] = [
      ['/v1/devices/current', 'PUT', { appVersion: 120, locale: 'en', notificationsEnabled: true }],
      ['/v1/store/restore', 'POST', { purchases: [] }],
      ['/v1/store/play/purchases', 'POST', {}],
      ['/v1/store/bazaar/purchases', 'POST', {}],
      ['/v1/calls/1234567890123/rang', 'POST', undefined],
      ['/v1/auth/logout', 'POST', undefined],
    ];
    for (const [url, method, body] of background) await call(h, url, { method, token: quiet.token, body });
    await call(h, '/v1/auth/refresh', { method: 'POST', token: quiet.token, body: { refreshToken: 'x'.repeat(40) } });
    await settle();
    const marked = await members(clock.now);
    expect(marked).not.toContain(quiet.id);
    expect(marked.every((m) => /^[1-9][0-9]*$/.test(m))).toBe(true);
  });

  it('never marks for a revoked session or a revoked person: the deny list answers first', async () => {
    const session = await seedUser(h, { name: 'Di' });
    const person = await seedUser(h, { name: 'Ed' });
    await h.app.denyList.revokeSession(session.sessionId);
    await h.app.denyList.revokeUser(person.id);
    for (const who of [session, person]) expect((await call(h, '/v1/me', { token: who.token })).statusCode).toBe(401);
    await settle();
    const marked = await members(clock.now);
    expect(marked).not.toContain(session.id);
    expect(marked).not.toContain(person.id);
  });

  it('answers when Valkey refuses the mark, and marks on the next request', async () => {
    const person = await seedUser(h, { name: 'Cy' });
    const multi = h.app.redis.multi.bind(h.app.redis);
    h.app.redis.multi = (() => ({
      sadd() {
        return this;
      },
      expire() {
        return this;
      },
      exec: () => Promise.reject(new Error('valkey down')),
    })) as unknown as typeof h.app.redis.multi;
    try {
      expect((await call(h, '/v1/me', { token: person.token })).statusCode).toBe(200);
      await settle();
    } finally {
      h.app.redis.multi = multi;
    }
    expect(await members(clock.now)).not.toContain(person.id);
    await call(h, '/v1/me', { token: person.token });
    await settle();
    expect(await members(clock.now)).toContain(person.id);
  });

  it('counts accepted likes, super likes and passes; resends, quota refusals and test accounts count nothing', async () => {
    const day = utcDay(Date.now());
    const counter = async (name: string) => Number((await h.redis.get(h.app.keys.statsCounter(name, day))) ?? 0);
    const before = { like: await counter('like'), superlike: await counter('superlike'), pass: await counter('pass') };
    const [me, b, c, d, e] = [await seedUser(h, { name: 'Me' }), await seedUser(h, { name: 'B' }), await seedUser(h, { name: 'C' }), await seedUser(h, { name: 'D' }), await seedUser(h, { name: 'E' })];
    const swipe = (who: SeededUser, swipes: unknown[]) => call(h, '/v1/swipes', { method: 'POST', token: who.token, body: { swipes } });
    const results = async (response: Awaited<ReturnType<typeof swipe>>) => {
      expect(response.statusCode).toBe(200);
      return response.json<{ results: { result: string }[] }>().results.map((r) => r.result);
    };
    expect(await results(await swipe(me, [{ target: b.publicUid, action: 'like' }, { target: d.publicUid, action: 'pass' }]))).toEqual(['liked', 'passed']);
    expect(await results(await swipe(me, [{ target: b.publicUid, action: 'like' }]))).toEqual(['duplicate']);
    const superliked = await results(await swipe(me, [{ target: c.publicUid, action: 'superlike' }]));
    await h.redis.set(h.app.keys.quota('likes', me.id, day), '1000000', 'EX', 3_600);
    expect(await results(await swipe(me, [{ target: e.publicUid, action: 'like' }]))).toEqual(['quota']);

    const tester = await seedUser(h, { name: 'T' });
    await h.db.sql.query(`UPDATE users SET flags = 1 WHERE id = $1`, [tester.id]);
    expect(await results(await swipe(tester, [{ target: b.publicUid, action: 'like' }, { target: c.publicUid, action: 'pass' }]))).toHaveLength(2);
    await settle();
    expect(await counter('like')).toBe(before.like + 1);
    expect(await counter('pass')).toBe(before.pass + 1);
    expect(await counter('superlike')).toBe(before.superlike + (superliked[0] === 'liked' ? 1 : 0));
    expect(await h.redis.ttl(h.app.keys.statsCounter('like', day))).toBeGreaterThan(40 * 86_400);
  });
});

describe.skipIf(!hasInfrastructure)('SMS provider outcomes', () => {
  let db: TestDatabase;
  let auth: AuthHarness;

  beforeAll(async () => {
    db = await migratedDatabase();
  }, 60_000);
  afterAll(async () => {
    await auth?.close();
    await db?.drop();
  });

  it('counts a code sent and a provider that was down', async () => {
    auth = await authApp(db);
    const day = utcDay(Date.now());
    const counter = async (name: string) => Number((await auth.app.redis.get(auth.app.keys.statsCounter(name, day))) ?? 0);
    expect((await post(auth, '/v1/auth/otp/start', { phone: phone('ir'), locale: 'fa' })).statusCode).toBe(200);
    auth.sms.kavenegar.fail = 'unavailable';
    expect((await post(auth, '/v1/auth/otp/start', { phone: phone('ir'), locale: 'fa' })).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await counter('sms_ok')).toBe(2);
    expect(await counter('sms_fail')).toBe(1);
  });
});
