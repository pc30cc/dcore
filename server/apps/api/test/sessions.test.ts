import { hashDomains } from '@app/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isUnderAge, refuseUnderAge } from '../src/auth/underAge.js';
import {
  BAZAAR,
  GOOGLE_CLIENT,
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
import { TEST_REDIS_URL, hasInfrastructure } from './support.js';

interface Pair {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
}

describe('the under-18 rule', () => {
  it('counts whole years in UTC', () => {
    const today = new Date(Date.UTC(2026, 10, 6));
    expect(isUnderAge('2008-11-06', today)).toBe(false);
    expect(isUnderAge('2008-11-07', today)).toBe(true);
    expect(isUnderAge('1990-01-01', today)).toBe(false);
    expect(() => isUnderAge('06/11/2008', today)).toThrow();
  });
});

describe.skipIf(!hasInfrastructure)('sessions, Google sign-in and the under-18 rule (PostgreSQL and Valkey)', () => {
  let db: TempDatabase;
  let h: AuthHarness;
  let redis: Redis;

  beforeAll(async () => {
    db = await migratedDatabase();
    redis = new Redis(TEST_REDIS_URL ?? '');
  }, 60_000);
  afterAll(async () => {
    await redis.quit();
    await db.drop();
  });
  afterEach(async () => {
    await h?.close();
  });

  const me = (token: string) =>
    h.app.inject({ method: 'POST', url: '/v1/me/phone/start', payload: { phone: '+12', locale: 'en' }, headers: { authorization: `Bearer ${token}`, 'x-client': PLAY } });
  const refresh = (refreshToken: string) => post(h, '/v1/auth/refresh', { refreshToken });
  const userIdOf = (publicUid: string) => h.app.publicIds.user.decodeId(publicUid) ?? '';

  describe('refresh', () => {
    it('rotates with 1 statement, and the old token stops working', async () => {
      h = await authApp(db);
      const signedIn = (await signInWithPhone(h, phone('ir'))).json<Pair & { user: { id: string } }>();
      const rotated = await refresh(signedIn.refreshToken);
      expect(rotated.statusCode).toBe(200);
      expect(statements(rotated)).toBe(1);
      const pair = rotated.json<Pair>();
      expect(pair.refreshToken).not.toBe(signedIn.refreshToken);
      expect(pair.refreshToken.split('.')[1]).toBe(signedIn.refreshToken.split('.')[1]);
      expect(new Date(pair.refreshExpiresAt).getTime()).toBeGreaterThan(Date.now() + 89 * 86_400_000);
      const claims = await h.app.tokens.verify(pair.accessToken);
      expect(claims).toMatchObject({ subject: signedIn.user.id, scope: 'full', storeCode: 1 });
      const session = await row<{ generation: number; has_prev: boolean }>(db, 'SELECT generation, prev_hash IS NOT NULL AS has_prev FROM sessions WHERE id = $1', [claims.sessionId]);
      expect(session).toEqual({ generation: 1, has_prev: true });
      // The next one goes on from the new token.
      expect((await refresh(pair.refreshToken)).statusCode).toBe(200);
      expect((await refresh('rt1.123.not-a-token')).json()).toMatchObject({ code: 'refresh_invalid' });
    });

    it('gives a concurrent double refresh one pair, without touching PostgreSQL again', async () => {
      h = await authApp(db);
      const { refreshToken } = (await signInWithPhone(h, phone('ir'))).json<Pair>();
      const answers = await Promise.all(Array.from({ length: 5 }, () => refresh(refreshToken)));
      expect(answers.map((a) => a.statusCode)).toEqual([200, 200, 200, 200, 200]);
      const pairs = answers.map((a) => a.json<Pair>());
      expect(new Set(pairs.map((p) => p.refreshToken)).size).toBe(1);
      expect(new Set(pairs.map((p) => p.accessToken)).size).toBe(1);
      expect(answers.map(statements).reduce((a, b) => a + b, 0)).toBe(1);
      // A late retry inside the grace gets the same answer too.
      const late = await refresh(refreshToken);
      expect(late.json<Pair>().refreshToken).toBe(pairs[0]?.refreshToken);
      expect(statements(late)).toBe(0);
    });

    it('revokes the session when a rotated token comes back after the grace', async () => {
      h = await authApp(db, { refreshGraceMs: 1_000 });
      const first = (await signInWithPhone(h, phone('ir'))).json<Pair>();
      const second = (await refresh(first.refreshToken)).json<Pair>();
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const reuse = await refresh(first.refreshToken);
      expect(reuse.statusCode).toBe(401);
      expect(reuse.json()).toMatchObject({ code: 'refresh_reused' });
      expect(statements(reuse)).toBe(1);
      const sid = (await h.app.tokens.verify(second.accessToken)).sessionId;
      const session = await row<{ revoke_reason: number }>(db, 'SELECT revoke_reason FROM sessions WHERE id = $1', [sid]);
      expect(session.revoke_reason).toBe(3);
      // Every token of the session is over: the newer refresh token and the access token.
      expect((await refresh(second.refreshToken)).json()).toMatchObject({ code: 'refresh_invalid' });
      expect((await me(second.accessToken)).statusCode).toBe(401);
      expect(await redis.exists(h.app.keys.denySession(sid))).toBe(1);
    });

    it('still rotates when Valkey is down, without the grace', async () => {
      h = await authApp(db);
      const { refreshToken } = (await signInWithPhone(h, phone('ir'))).json<Pair>();
      h.app.redis.disconnect();
      const rotated = await refresh(refreshToken);
      expect(rotated.statusCode).toBe(200);
      expect(statements(rotated)).toBe(1);
    });

    it('answers a restricted account with its reason and a restricted pair', async () => {
      h = await authApp(db);
      const signedIn = (await signInWithPhone(h, phone('ir'))).json<Pair & { user: { id: string } }>();
      const userId = userIdOf(signedIn.user.id);
      const { id: action } = await row<{ id: string }>(
        db,
        `INSERT INTO moderation_actions (id, user_id, kind, reason_code, reason_text) VALUES (id_next(), $1, 3, 1, 'Spam.') RETURNING id::text`,
        [userId],
      );
      await db.sql.query(`UPDATE users SET status = 6, birth_date = DATE '1995-01-01', gender = 2 WHERE id = $1`, [userId]);
      const answer = await refresh(signedIn.refreshToken);
      expect(answer.statusCode).toBe(403);
      expect(statements(answer)).toBe(1);
      expect(answer.headers['content-type']).toContain('application/problem+json');
      const problem = answer.json<Pair & { code: string; reasonText: string; actionId: string; appealable: boolean }>();
      expect(problem).toMatchObject({ code: 'account_banned', reasonText: 'Spam.', actionId: action, appealable: true });
      expect((await h.app.tokens.verify(problem.accessToken)).scope).toBe('restricted');
      // The restricted pair refreshes again; a route of full sessions answers with the reason.
      const refused = await me(problem.accessToken);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: 'account_banned', reasonText: 'Spam.' });
      const again = await refresh(problem.refreshToken);
      expect(again.statusCode).toBe(403);

      // A deletion in its grace: a restore pair and the last day to restore.
      await db.sql.query(`UPDATE users SET status = 7, deleted_at = now() WHERE id = $1`, [userId]);
      const deleted = (await refresh(again.json<Pair>().refreshToken)).json<Pair & { code: string; restorableUntil: string }>();
      expect(deleted.code).toBe('account_deleted');
      expect(new Date(deleted.restorableUntil).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
      expect((await h.app.tokens.verify(deleted.accessToken)).scope).toBe('restore');
    });
  });

  describe('logout', () => {
    it('ends this session, then every session with deny:uid', async () => {
      h = await authApp(db);
      const number = phone('ir');
      const a = (await signInWithPhone(h, number)).json<Pair & { user: { id: string } }>();
      await redis.del(h.app.keys.otpResendWait(h.app.otp.phoneKeyHash(number)));
      const b = (await signInWithPhone(h, number)).json<Pair>();
      await redis.del(h.app.keys.otpResendWait(h.app.otp.phoneKeyHash(number)));
      const c = (await signInWithPhone(h, number)).json<Pair>();

      const one = await h.app.inject({ method: 'POST', url: '/v1/auth/logout', payload: {}, headers: { authorization: `Bearer ${a.accessToken}`, 'x-client': PLAY } });
      expect(one.statusCode).toBe(204);
      expect(statements(one)).toBe(1);
      expect((await refresh(a.refreshToken)).json()).toMatchObject({ code: 'refresh_invalid' });
      expect((await me(a.accessToken)).statusCode).toBe(401);
      expect((await refresh(b.refreshToken)).statusCode).toBe(200);

      const all = await h.app.inject({ method: 'POST', url: '/v1/auth/logout', payload: { all: true }, headers: { authorization: `Bearer ${c.accessToken}`, 'x-client': PLAY } });
      expect(all.statusCode).toBe(204);
      expect(statements(all)).toBe(1);
      const userId = userIdOf(a.user.id);
      const reasons = (await rows<{ revoke_reason: number }>(db, 'SELECT revoke_reason FROM sessions WHERE user_id = $1 ORDER BY id', [userId])).map((r) => r.revoke_reason);
      expect(reasons).toEqual([1, 2, 2]);
      expect(await redis.exists(h.app.keys.denyUser(userId))).toBe(1);
      expect((await me(c.accessToken)).statusCode).toBe(401);
      // A later sign-in is a new session that works (its token is issued after the cutoff).
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await redis.del(h.app.keys.otpResendWait(h.app.otp.phoneKeyHash(number)));
      const d = (await signInWithPhone(h, number)).json<Pair>();
      expect((await me(d.accessToken)).statusCode).toBe(400);
    });
  });

  describe('Google', () => {
    it('is refused to the bazaar build', async () => {
      h = await authApp(db);
      const nonce = await post(h, '/v1/auth/google/nonce', {}, { 'x-client': BAZAAR });
      expect(nonce.statusCode).toBe(403);
      expect(nonce.json()).toMatchObject({ code: 'store_not_supported' });
      const signIn = await post(h, '/v1/auth/google', { idToken: 'x', nonceId: 'abcdefghijkl', ...device() }, { 'x-client': BAZAAR });
      expect(signIn.statusCode).toBe(403);
      expect(signIn.json()).toMatchObject({ code: 'store_not_supported' });
    });

    it('signs in by the keyed hash of sub with a single-use nonce', async () => {
      h = await authApp(db);
      const nonceAnswer = await post(h, '/v1/auth/google/nonce', {});
      expect(nonceAnswer.statusCode).toBe(200);
      expect(statements(nonceAnswer)).toBe(0);
      const { nonceId, nonce } = nonceAnswer.json<{ nonceId: string; nonce: string }>();
      const idToken = h.google.mint({ sub: '109876543210987654321', audience: GOOGLE_CLIENT, nonce, email: 'someone@example.com' });
      const dev = device('en');
      const first = await post(h, '/v1/auth/google', { idToken, nonceId, ...dev });
      expect(first.statusCode).toBe(200);
      expect(statements(first)).toBe(5);
      const result = first.json<{ isNew: boolean; user: { id: string } }>();
      expect(result.isNew).toBe(true);
      const identity = await row<{ provider: number; subject_hash: Buffer; subject_enc: Buffer | null }>(db, 'SELECT provider, subject_hash, subject_enc FROM auth_identities WHERE user_id = $1', [userIdOf(result.user.id)]);
      expect(identity.provider).toBe(2);
      expect(identity.subject_enc).toBeNull();
      expect(Buffer.compare(identity.subject_hash, h.app.secrets.hasher.hash(hashDomains.google, '109876543210987654321').hash)).toBe(0);

      // The nonce worked once.
      const replay = await post(h, '/v1/auth/google', { idToken, nonceId, ...dev });
      expect(replay.statusCode).toBe(400);
      expect(replay.json()).toMatchObject({ code: 'google_token_invalid' });

      // Signing in again: the same account.
      const next = (await post(h, '/v1/auth/google/nonce', {})).json<{ nonceId: string; nonce: string }>();
      const again = await post(h, '/v1/auth/google', { idToken: h.google.mint({ sub: '109876543210987654321', audience: GOOGLE_CLIENT, nonce: next.nonce }), nonceId: next.nonceId, ...dev });
      expect(again.json()).toMatchObject({ isNew: false, user: { id: result.user.id } });
      expect(statements(again)).toBe(4);

      // Wrong audience, wrong nonce.
      const n3 = (await post(h, '/v1/auth/google/nonce', {})).json<{ nonceId: string; nonce: string }>();
      const wrongAudience = await post(h, '/v1/auth/google', { idToken: h.google.mint({ sub: '1', audience: 'other', nonce: n3.nonce }), nonceId: n3.nonceId, ...dev });
      expect(wrongAudience.json()).toMatchObject({ code: 'google_token_invalid' });
      const n4 = (await post(h, '/v1/auth/google/nonce', {})).json<{ nonceId: string; nonce: string }>();
      const wrongNonce = await post(h, '/v1/auth/google', { idToken: h.google.mint({ sub: '1', audience: GOOGLE_CLIENT, nonce: 'other' }), nonceId: n4.nonceId, ...dev });
      expect(wrongNonce.json()).toMatchObject({ code: 'google_token_invalid' });
    });

    it('signs two first sign-ins of one account racing each other in to the same account', async () => {
      h = await authApp(db);
      const nonces = await Promise.all([post(h, '/v1/auth/google/nonce', {}), post(h, '/v1/auth/google/nonce', {})]);
      const bodies = nonces.map((n) => {
        const { nonceId, nonce } = n.json<{ nonceId: string; nonce: string }>();
        return { idToken: h.google.mint({ sub: '424242', audience: GOOGLE_CLIENT, nonce }), nonceId, ...device() };
      });
      // Both look the account up before either creates it: a lock holds their INSERTs until both wait.
      const blocker = await db.sql.connect();
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE users IN SHARE MODE');
      const pending = Promise.all(bodies.map((body) => post(h, '/v1/auth/google', body)));
      for (let waited = 0; ; waited += 20) {
        const waiting = await row<{ n: number }>(
          db,
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'INSERT INTO users%'`,
        );
        if (waiting.n === 2) break;
        if (waited > 5_000) throw new Error('the sign-ins did not reach the INSERT');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await blocker.query('COMMIT');
      blocker.release();
      const answers = await pending;
      expect(answers.map((a) => a.statusCode)).toEqual([200, 200]);
      const results = answers.map((a) => a.json<{ isNew: boolean; user: { id: string } }>());
      expect(results[0]?.user.id).toBe(results[1]?.user.id);
      expect(results.map((r) => r.isNew).sort()).toEqual([false, true]);
      // The loser: its lookup, the two statements before the identity refused it, a second lookup, the sign-in.
      expect(answers.map(statements).sort()).toEqual([5, 7]);
      expect((await row<{ n: number }>(db, 'SELECT count(*)::int AS n FROM users WHERE id IN (SELECT user_id FROM auth_identities WHERE provider = 2 AND subject_hash = $1)', [
        h.app.secrets.hasher.hash(hashDomains.google, '424242').hash,
      ])).n).toBe(1);
    });

    it('refuses a banned Google account', async () => {
      h = await authApp(db);
      await db.sql.query(`INSERT INTO device_bans (id, kind, value_hash, reason) VALUES (id_next(), 3, $1, 'test')`, [
        h.app.secrets.hasher.hash(hashDomains.google, '555').hash,
      ]);
      const { nonceId, nonce } = (await post(h, '/v1/auth/google/nonce', {})).json<{ nonceId: string; nonce: string }>();
      const refused = await post(h, '/v1/auth/google', { idToken: h.google.mint({ sub: '555', audience: GOOGLE_CLIENT, nonce }), nonceId, ...device() });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: 'phone_banned' });
    });
  });

  describe('adding a phone', () => {
    it('adds a number to a Google account, refuses another account\'s, and needs a full session', async () => {
      h = await authApp(db);
      const { nonceId, nonce } = (await post(h, '/v1/auth/google/nonce', {})).json<{ nonceId: string; nonce: string }>();
      const google = (await post(h, '/v1/auth/google', { idToken: h.google.mint({ sub: '777', audience: GOOGLE_CLIENT, nonce }), nonceId, ...device() })).json<Pair & { user: { id: string } }>();
      const auth = { authorization: `Bearer ${google.accessToken}` };
      const number = phone('ir');
      const start = await post(h, '/v1/me/phone/start', { phone: number, locale: 'fa' }, auth);
      expect(start.statusCode).toBe(200);
      expect(statements(start)).toBe(0);
      const code = h.sms.kavenegar.codeFor(number) ?? '';
      const challengeId = start.json<{ challengeId: string }>().challengeId;
      // A sign-in cannot use a code sent for an account's number.
      expect((await post(h, '/v1/auth/otp/verify', { challengeId, code, ...device() })).statusCode).toBe(410);
      await redis.del(h.app.keys.otpResendWait(h.app.otp.phoneKeyHash(number)));
      const start2 = (await post(h, '/v1/me/phone/start', { phone: number, locale: 'fa' }, auth)).json<{ challengeId: string }>();
      const verify = await post(h, '/v1/me/phone/verify', { challengeId: start2.challengeId, code: h.sms.kavenegar.codeFor(number) ?? '' }, auth);
      expect(verify.statusCode).toBe(204);
      expect(statements(verify)).toBe(2);
      const providers = await rows<{ provider: number }>(db, 'SELECT provider FROM auth_identities WHERE user_id = $1 ORDER BY provider', [userIdOf(google.user.id)]);
      expect(providers.map((r) => r.provider)).toEqual([1, 2]);
      // The number now signs in to the Google account.
      await redis.del(h.app.keys.otpResendWait(h.app.otp.phoneKeyHash(number)));
      expect((await signInWithPhone(h, number)).json()).toMatchObject({ isNew: false, user: { id: google.user.id } });

      // Someone else's number.
      const other = phone('ir');
      await signInWithPhone(h, other);
      await redis.del(h.app.keys.otpResendWait(h.app.otp.phoneKeyHash(other)));
      const s3 = (await post(h, '/v1/me/phone/start', { phone: other, locale: 'fa' }, auth)).json<{ challengeId: string }>();
      const taken = await post(h, '/v1/me/phone/verify', { challengeId: s3.challengeId, code: h.sms.kavenegar.codeFor(other) ?? '' }, auth);
      expect(taken.statusCode).toBe(409);

      // A restricted session gets its reason instead.
      await db.sql.query(`INSERT INTO moderation_actions (id, user_id, kind, reason_code, reason_text, ends_at) VALUES (id_next(), $1, 2, 1, 'Cool down.', now() + interval '1 day')`, [userIdOf(google.user.id)]);
      await db.sql.query(`UPDATE users SET status = 5, birth_date = DATE '1995-01-01', gender = 1 WHERE id = $1`, [userIdOf(google.user.id)]);
      const restricted = (await refresh(google.refreshToken)).json<Pair>();
      const refused = await post(h, '/v1/me/phone/start', { phone: phone('ir'), locale: 'fa' }, { authorization: `Bearer ${restricted.accessToken}` });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: 'account_suspended', reasonText: 'Cool down.' });
      expect(statements(refused)).toBe(1);
    });
  });

  describe('under 18', () => {
    it('closes the account at once and refuses its number and device key for a year, also after FLUSHALL', async () => {
      // Its own Valkey database, which the test empties.
      const lost = new URL(TEST_REDIS_URL ?? '');
      lost.pathname = '/7';
      h = await authApp(db, {
        redisUrl: lost.toString(),
        waitForValkey: true,
        // What onboarding's basics step calls when the birth date is under 18.
        routes: (app) =>
          app.post('/test/under-age', { config: { pgBudget: 4 }, preHandler: app.requireUser }, async (request: FastifyRequest) => ({
            closed: await refuseUnderAge(app as unknown as FastifyInstance, request),
          })),
      });
      const number = phone('ir');
      const dev = device();
      const signedIn = (await signInWithPhone(h, number, dev)).json<Pair & { user: { id: string } }>();
      const userId = userIdOf(signedIn.user.id);

      // The database refuses an under-age birth date by itself.
      await expect(db.sql.query(`UPDATE users SET birth_date = (now() - interval '17 years')::date, gender = 1 WHERE id = $1`, [userId])).rejects.toMatchObject({
        code: '23514',
      });

      const closed = await h.app.inject({ method: 'POST', url: '/test/under-age', headers: { authorization: `Bearer ${signedIn.accessToken}`, 'x-client': PLAY } });
      expect(closed.json()).toEqual({ closed: true });
      expect(statements(closed)).toBe(4);
      const user = await row<Record<string, unknown>>(db, 'SELECT status, deleted_via, birth_date, gender, deleted_at IS NOT NULL AS deleted FROM users WHERE id = $1', [userId]);
      expect(user).toEqual({ status: 8, deleted_via: 4, birth_date: null, gender: null, deleted: true });
      const bans = (
        await rows<Record<string, unknown>>(db, `SELECT kind, store, expires_at > now() + interval '364 days' AS year FROM device_bans WHERE reason = 'under_age' ORDER BY kind`)
      );
      expect(bans).toEqual([
        { kind: 1, store: 1, year: true },
        { kind: 2, store: null, year: true },
      ]);
      for (const table of ['auth_identities', 'devices', 'sessions']) {
        expect((await row<{ n: number }>(db, `SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [userId])).n).toBe(0);
      }
      expect((await me(signedIn.accessToken)).statusCode).toBe(401);
      expect((await refresh(signedIn.refreshToken)).json()).toMatchObject({ code: 'refresh_invalid' });

      // The cache refuses the number before any code is sent...
      const cached = await post(h, '/v1/auth/otp/start', { phone: number, locale: 'fa' });
      expect(cached.json()).toMatchObject({ code: 'phone_banned' });
      // ...and without it the bans still do.
      const sameDb = new Redis(lost.toString());
      await sameDb.flushdb();
      await sameDb.quit();
      expect((await signInWithPhone(h, number)).json()).toMatchObject({ code: 'phone_banned' });
      expect((await signInWithPhone(h, phone('ir'), dev)).json()).toMatchObject({ code: 'device_banned' });
      // Closing twice does nothing.
      expect((await row<{ n: number }>(db, 'SELECT count(*)::int AS n FROM device_bans WHERE reason = $1', ['under_age'])).n).toBe(2);
    });
  });
});
