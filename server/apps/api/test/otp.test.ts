import { createHash } from 'node:crypto';
import { REVIEW_WRONG_DAILY, hashDomains, reviewCodeHash } from '@app/shared/server';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BAZAAR,
  authApp,
  device,
  migratedDatabase,
  phone,
  post,
  row,
  rows,
  settingsWith,
  signInWithPhone,
  statements,
  type AuthHarness,
  type TempDatabase,
} from './authSupport.js';
import { normalizePhone } from '../src/auth/otp.js';
import { TEST_REDIS_URL, hasInfrastructure, testConfig } from './support.js';

describe('phone numbers', () => {
  it('normalises what people type and refuses what cannot take an SMS', () => {
    expect(normalizePhone('+98 912 123 4567')).toBe('+989121234567');
    expect(normalizePhone('+۹۸۹۱۲۱۲۳۴۵۶۷')).toBe('+989121234567');
    expect(normalizePhone('00989121234567')).toBe('+989121234567');
    expect(normalizePhone('+1 (415) 555-0123')).toBe('+14155550123');
    expect(normalizePhone('+982188776655')).toBeNull();
    expect(normalizePhone('09121234567')).toBeNull();
    expect(normalizePhone('+12')).toBeNull();
    expect(normalizePhone('+1415555012345678')).toBeNull();
  });
});

describe('sign-in configuration', () => {
  it('needs each provider\'s template with its key, and never runs the fake provider in production', () => {
    expect(() => testConfig({ SMS_KAVENEGAR_API_KEY: 'kv-0123456789' })).toThrow(/SMS_KAVENEGAR_TEMPLATE/);
    expect(() => testConfig({ SMS_TELNYX_API_KEY: 'tx-0123456789' })).toThrow(/SMS_TELNYX_VERIFY_PROFILE_ID/);
    expect(() => testConfig({ NODE_ENV: 'production', SMS_FAKE: 'log' })).toThrow(/SMS_FAKE/);
    expect(testConfig().sms).toMatchObject({ fake: 'memory', kavenegar: undefined, smsir: undefined, telnyx: undefined });
    expect(testConfig({ SMS_SMSIR_API_KEY: 'si-0123456789', SMS_SMSIR_TEMPLATE_ID: '123' }).sms.smsir).toEqual({
      apiKey: 'si-0123456789',
      templateId: 123,
      parameter: 'CODE',
    });
  });
});

describe.skipIf(!hasInfrastructure)('OTP sign-in (PostgreSQL and Valkey)', () => {
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

  it('starts with 0 statements, routes by the number and keeps neither the code nor the number in clear', async () => {
    h = await authApp(db);
    const ir = phone('ir');
    const start = await post(h, '/v1/auth/otp/start', { phone: ir, locale: 'fa' });
    expect(start.statusCode).toBe(200);
    expect(statements(start)).toBe(0);
    const body = start.json<{ challengeId: string; codeLength: number; ttlSeconds: number; resendAfterSeconds: number; channel: string }>();
    expect(body).toMatchObject({ codeLength: 6, ttlSeconds: 300, resendAfterSeconds: 60, channel: 'sms' });
    const code = h.sms.kavenegar.codeFor(ir);
    expect(code).toMatch(/^[0-9]{6}$/);
    expect(h.sms.telnyx.sent).toHaveLength(0);

    const keys = await redis.keys(`${h.prefix}*`);
    const values = await Promise.all(
      keys.map(async (key) => ((await redis.type(key)) === 'hash' ? JSON.stringify(await redis.hgetall(key)) : String(await redis.get(key)))),
    );
    const dump = keys.join(' ') + values.join(' ');
    expect(dump).not.toContain(code ?? 'x');
    expect(dump).not.toContain(ir.slice(1));
    expect(dump).not.toContain(ir.slice(3));

    const us = phone('us');
    expect((await post(h, '/v1/auth/otp/start', { phone: us, locale: 'en' })).statusCode).toBe(200);
    expect(h.sms.telnyx.codeFor(us)).toMatch(/^[0-9]{6}$/);
  });

  it('answers phone_invalid and phone_not_allowed by the contract codes', async () => {
    h = await authApp(db, { settings: settingsWith({ routing: { routes: [{ prefix: '+98', providers: ['kavenegar'] }], default: [] } }) });
    const invalid = await post(h, '/v1/auth/otp/start', { phone: '+98218877665', locale: 'fa' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'phone_invalid' });
    const notAllowed = await post(h, '/v1/auth/otp/start', { phone: phone('us'), locale: 'en' });
    expect(notAllowed.statusCode).toBe(403);
    expect(notAllowed.json()).toMatchObject({ code: 'phone_not_allowed' });
    expect(statements(notAllowed)).toBe(0);
  });

  it('holds the resend wait and the daily cap per number', async () => {
    h = await authApp(db, { settings: settingsWith({ caps: { resend_seconds: 10, phone_daily: 3 } }) });
    const number = phone('ir');
    expect((await post(h, '/v1/auth/otp/start', { phone: number, locale: 'fa' })).statusCode).toBe(200);
    const again = await post(h, '/v1/auth/otp/start', { phone: number, locale: 'fa' });
    expect(again.statusCode).toBe(429);
    expect(again.json()).toMatchObject({ code: 'rate_limited' });
    expect(again.json<{ retryAfterSeconds: number }>().retryAfterSeconds).toBeGreaterThan(5);
    expect(again.headers['retry-after']).toBeDefined();
    // Past the wait (dropped here instead of waiting), the daily count still holds.
    const wait = h.app.keys.otpResendWait(h.app.otp.phoneKeyHash(number));
    for (let i = 0; i < 2; i += 1) {
      await redis.del(wait);
      expect((await post(h, '/v1/auth/otp/start', { phone: number, locale: 'fa' })).statusCode).toBe(200);
    }
    await redis.del(wait);
    const daily = await post(h, '/v1/auth/otp/start', { phone: number, locale: 'fa' });
    expect(daily.statusCode).toBe(429);
    expect(h.sms.kavenegar.sent.filter((m) => m.phone === number)).toHaveLength(3);
  });

  it('holds the IP, install and prefix caps', async () => {
    h = await authApp(db, { settings: settingsWith({ caps: { ip_hourly: 2, install_daily: 1, prefix_hourly: { '+98': 100, '+1': 2, default: 1 } } }) });
    expect((await post(h, '/v1/auth/otp/start', { phone: phone('ir'), locale: 'fa' })).statusCode).toBe(200);
    expect((await post(h, '/v1/auth/otp/start', { phone: phone('ir'), locale: 'fa' })).statusCode).toBe(200);
    expect((await post(h, '/v1/auth/otp/start', { phone: phone('ir'), locale: 'fa' })).statusCode).toBe(429);
    await h.close();

    h = await authApp(db, { settings: settingsWith({ caps: { ip_hourly: 100, install_daily: 1, prefix_hourly: { '+98': 100, '+1': 2, default: 1 } } }) });
    const installId = device().installId;
    expect((await post(h, '/v1/auth/otp/start', { phone: phone('ir'), locale: 'fa', installId })).statusCode).toBe(200);
    expect((await post(h, '/v1/auth/otp/start', { phone: phone('ir'), locale: 'fa', installId })).statusCode).toBe(429);
    // +1 numbers: 2 an hour; an unlisted prefix shares the default bucket (1).
    expect((await post(h, '/v1/auth/otp/start', { phone: phone('us'), locale: 'en' })).statusCode).toBe(200);
    expect((await post(h, '/v1/auth/otp/start', { phone: phone('us'), locale: 'en' })).statusCode).toBe(200);
    expect((await post(h, '/v1/auth/otp/start', { phone: phone('us'), locale: 'en' })).statusCode).toBe(429);
    expect((await post(h, '/v1/auth/otp/start', { phone: '+447700900123', locale: 'en' })).statusCode).toBe(200);
    expect((await post(h, '/v1/auth/otp/start', { phone: '+33612345678', locale: 'en' })).statusCode).toBe(429);
  });

  it('fails closed when Valkey is down: no code is sent and none is accepted', async () => {
    h = await authApp(db);
    // Valkey goes away under a running API.
    h.app.redis.disconnect();
    const start = await post(h, '/v1/auth/otp/start', { phone: phone('ir'), locale: 'fa' });
    expect(start.statusCode).toBe(503);
    expect(start.json()).toMatchObject({ code: 'sms_unavailable' });
    expect(h.sms.kavenegar.sent).toHaveLength(0);
    const verify = await post(h, '/v1/auth/otp/verify', { challengeId: 'abcdefghijklmnopqrstuvwx', code: '123456', ...device() });
    expect(verify.statusCode).toBe(503);
    expect(statements(verify)).toBe(0);
  });

  it('gives the counts back when no provider could send, and fails over to the next one', async () => {
    h = await authApp(db);
    const number = phone('ir');
    h.sms.kavenegar.fail = 'unavailable';
    h.sms.smsir.fail = 'unavailable';
    const down = await post(h, '/v1/auth/otp/start', { phone: number, locale: 'fa' });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ code: 'sms_unavailable' });
    h.sms.smsir.fail = null;
    // No resend wait was left behind, and sms.ir takes over.
    const up = await post(h, '/v1/auth/otp/start', { phone: number, locale: 'fa' });
    expect(up.statusCode).toBe(200);
    expect(h.sms.smsir.codeFor(number)).toMatch(/^[0-9]{6}$/);
    // kavenegar is cooling down after its outage, so sms.ir is asked first now.
    h.sms.kavenegar.fail = 'rejected';
    h.sms.smsir.fail = 'rejected';
    const refused = await post(h, '/v1/auth/otp/start', { phone: phone('ir'), locale: 'fa' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: 'phone_invalid' });
  });

  it('kills a challenge after 5 wrong codes and never accepts it again', async () => {
    h = await authApp(db);
    const number = phone('ir');
    const { challengeId } = (await post(h, '/v1/auth/otp/start', { phone: number, locale: 'fa' })).json<{ challengeId: string }>();
    const code = h.sms.kavenegar.codeFor(number) ?? '';
    const wrong = code === '999999' ? '000000' : '999999';
    const dev = device();
    const answers = [];
    for (let i = 0; i < 5; i += 1) answers.push(await post(h, '/v1/auth/otp/verify', { challengeId, code: wrong, ...dev }));
    expect(answers.slice(0, 4).map((a) => [a.statusCode, a.json<{ code: string; attemptsLeft: number }>().attemptsLeft])).toEqual([
      [400, 4],
      [400, 3],
      [400, 2],
      [400, 1],
    ]);
    expect(answers[0]?.json()).toMatchObject({ code: 'otp_invalid' });
    expect(answers[4]?.statusCode).toBe(429);
    expect(answers[4]?.json()).toMatchObject({ code: 'otp_locked' });
    expect(answers.every((a) => statements(a) === 0)).toBe(true);
    const late = await post(h, '/v1/auth/otp/verify', { challengeId, code, ...dev });
    expect(late.statusCode).toBe(410);
    expect(late.json()).toMatchObject({ code: 'otp_expired' });
  });

  it('limits verify attempts per IP', async () => {
    h = await authApp(db, { settings: settingsWith({ caps: { verify_ip_hourly: 3 } }) });
    const dev = device();
    for (let i = 0; i < 3; i += 1) {
      expect((await post(h, '/v1/auth/otp/verify', { challengeId: `nochallenge${i}`, code: '123456', ...dev })).statusCode).toBe(410);
    }
    const limited = await post(h, '/v1/auth/otp/verify', { challengeId: 'nochallenge9', code: '123456', ...dev });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'rate_limited' });
  });

  it('creates an account with 5 statements, signs in to it with 4, and stores only hashes and the sealed number', async () => {
    h = await authApp(db);
    const number = phone('ir');
    const dev = device('fa');
    const first = await signInWithPhone(h, number, dev);
    expect(first.statusCode).toBe(200);
    expect(statements(first)).toBe(5);
    const result = first.json<{ accessToken: string; refreshToken: string; user: { id: string; status: string; onboardingStep: number }; isNew: boolean }>();
    expect(result).toMatchObject({ isNew: true, user: { status: 'onboarding', onboardingStep: 0 } });
    expect(result.user.id).toMatch(/^[a-z2-7]{13}$/);
    expect(result.refreshToken).toMatch(/^rt1\.[0-9]+\.[A-Za-z0-9_-]{43}$/);

    const userId = h.app.publicIds.user.decodeId(result.user.id) ?? '';
    const identity = await row<{ provider: number; hash_kid: number; subject_hash: Buffer; subject_enc: Buffer }>(db, 'SELECT provider, hash_kid, subject_hash, subject_enc FROM auth_identities WHERE user_id = $1', [userId]);
    expect(identity.provider).toBe(1);
    expect(Buffer.compare(identity.subject_hash, h.app.secrets.hasher.hash(hashDomains.phone, number).hash)).toBe(0);
    expect(h.app.secrets.sealer.openText(identity.subject_enc, 'auth_identities.subject_enc')).toBe(number);
    expect(identity.subject_enc.toString('latin1')).not.toContain(number.slice(3));
    const session = await row<{ refresh_hash: Buffer; store: number; device_id: string; app_version: number }>(db, 'SELECT refresh_hash, store, device_id::text, app_version FROM sessions WHERE user_id = $1', [userId]);
    expect(Buffer.compare(session.refresh_hash, createHash('sha256').update(result.refreshToken).digest())).toBe(0);
    expect(session.store).toBe(1);
    expect(session.app_version).toBe(120);
    const deviceRow = await row<{ fingerprint_hash: Buffer; locale: string; store: number }>(db, 'SELECT fingerprint_hash, locale, store FROM devices WHERE id = $1', [session.device_id]);
    expect(Buffer.compare(deviceRow.fingerprint_hash, h.app.secrets.hasher.hash(hashDomains.device, dev.deviceKey).hash)).toBe(0);
    expect(deviceRow).toMatchObject({ locale: 'fa', store: 1 });
    const user = await row<{ status: number; flags: number; locale: string }>(db, 'SELECT status, flags, locale FROM users WHERE id = $1', [userId]);
    expect(user).toEqual({ status: 1, flags: 0, locale: 'fa' });

    // The same number again, from the same phone: the same account and device, 4 statements.
    await redis.del(h.app.keys.otpResendWait(h.app.otp.phoneKeyHash(number)));
    const second = await signInWithPhone(h, number, dev);
    expect(second.statusCode).toBe(200);
    expect(statements(second)).toBe(4);
    expect(second.json()).toMatchObject({ isNew: false, user: { id: result.user.id } });
    expect((await row<{ n: number }>(db, 'SELECT count(*)::int AS n FROM devices WHERE user_id = $1', [userId])).n).toBe(1);
    expect((await row<{ n: number }>(db, 'SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [userId])).n).toBe(2);

    // The token works on an app route.
    const claims = await h.app.tokens.verify(result.accessToken);
    expect(claims).toMatchObject({ kind: 'app', subject: result.user.id, scope: 'full', storeCode: 1, deviceId: session.device_id });
  });

  it('gives the number of a purged account to a new account', async () => {
    h = await authApp(db);
    const number = phone('ir');
    const first = (await signInWithPhone(h, number)).json<{ user: { id: string } }>();
    const oldId = h.app.publicIds.user.decodeId(first.user.id);
    await db.sql.query(`UPDATE users SET status = 8, deleted_at = now(), deleted_via = 1 WHERE id = $1`, [oldId]);
    await redis.del(h.app.keys.otpResendWait(h.app.otp.phoneKeyHash(number)));
    const again = await signInWithPhone(h, number);
    expect(again.statusCode).toBe(200);
    const result = again.json<{ isNew: boolean; user: { id: string } }>();
    expect(result.isNew).toBe(true);
    expect(result.user.id).not.toBe(first.user.id);
    const holders = await rows<{ user_id: string }>(db, 'SELECT user_id::text FROM auth_identities WHERE subject_hash = $1', [
      h.app.secrets.hasher.hash(hashDomains.phone, number).hash,
    ]);
    expect(holders).toEqual([{ user_id: h.app.publicIds.user.decodeId(result.user.id) }]);
  });

  it('signs in a review account with its fixed code and sends nothing', async () => {
    const number = phone('us');
    h = await authApp(db);
    h.settings.set(settingsWith({ reviewAccounts: [{ phone_hash: h.app.otp.phoneKeyHash(number), otp_hash: reviewCodeHash(h.app.secrets.hasher, '135790') }] }));
    const start = await post(h, '/v1/auth/otp/start', { phone: number, locale: 'en' });
    expect(start.statusCode).toBe(200);
    expect(h.sms.telnyx.sent).toHaveLength(0);
    const verify = await post(h, '/v1/auth/otp/verify', { challengeId: start.json<{ challengeId: string }>().challengeId, code: '135790', ...device('en') });
    expect(verify.statusCode).toBe(200);
    const userId = h.app.publicIds.user.decodeId(verify.json<{ user: { id: string } }>().user.id);
    expect((await row<{ flags: number }>(db, 'SELECT flags FROM users WHERE id = $1', [userId])).flags).toBe(1);
  });

  it('locks a review number for the day after its daily wrong codes, however many challenges were started', async () => {
    const number = phone('us');
    h = await authApp(db);
    h.settings.set(settingsWith({ reviewAccounts: [{ phone_hash: h.app.otp.phoneKeyHash(number), otp_hash: reviewCodeHash(h.app.secrets.hasher, '135791') }] }));
    const start = async () => {
      await redis.del(h.app.keys.otpResendWait(h.app.otp.phoneKeyHash(number)));
      const started = await post(h, '/v1/auth/otp/start', { phone: number, locale: 'en' });
      expect(started.statusCode).toBe(200);
      return started.json<{ challengeId: string }>().challengeId;
    };
    const answers: string[] = [];
    let challengeId = await start();
    for (let i = 0; i < REVIEW_WRONG_DAILY; i += 1) {
      if (i > 0 && i % 4 === 0) challengeId = await start();
      answers.push((await post(h, '/v1/auth/otp/verify', { challengeId, code: String(200_000 + i), ...device('en') })).json<{ code: string }>().code);
    }
    expect(answers.slice(0, -1).every((code) => code === 'otp_invalid')).toBe(true);
    expect(answers.at(-1)).toBe('otp_locked');
    const right = await post(h, '/v1/auth/otp/verify', { challengeId: await start(), code: '135791', ...device('en') });
    expect(right.statusCode).toBe(429);
    expect(right.json()).toMatchObject({ code: 'otp_locked' });
  });

  it('refuses a banned number and a banned device key of the same build, not of the other build', async () => {
    h = await authApp(db);
    const bannedNumber = phone('ir');
    const hasher = h.app.secrets.hasher;
    await db.sql.query(`INSERT INTO device_bans (id, kind, value_hash, reason) VALUES (id_next(), 2, $1, 'test')`, [hasher.hash(hashDomains.phone, bannedNumber).hash]);
    const refused = await signInWithPhone(h, bannedNumber);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'phone_banned' });

    const dev = device();
    await db.sql.query(`INSERT INTO device_bans (id, kind, store, value_hash, reason) VALUES (id_next(), 1, 1, $1, 'test')`, [hasher.hash(hashDomains.device, dev.deviceKey).hash]);
    const deviceRefused = await signInWithPhone(h, phone('ir'), dev);
    expect(deviceRefused.statusCode).toBe(403);
    expect(deviceRefused.json()).toMatchObject({ code: 'device_banned' });
    // The same key in the bazaar build is another device key: the ban names the play build only.
    const otherBuild = await signInWithPhone(h, phone('ir'), dev, { 'x-client': BAZAAR });
    expect(otherBuild.statusCode).toBe(200);

    // An expired ban refuses nothing.
    const freed = phone('ir');
    await db.sql.query(`INSERT INTO device_bans (id, kind, value_hash, reason, expires_at) VALUES (id_next(), 2, $1, 'test', now() - interval '1 day')`, [
      hasher.hash(hashDomains.phone, freed).hash,
    ]);
    expect((await signInWithPhone(h, freed)).statusCode).toBe(200);
  });

  it('answers the start of a number refused for age like any other, and counts it against every limit', async () => {
    h = await authApp(db, { settings: settingsWith({ caps: { ip_hourly: 2 } }) });
    const minor = phone('ir');
    // What the under-age refusal leaves: the cache, and the ban it caches.
    await redis.set(h.app.keys.minorPhone(h.app.otp.phoneKeyHash(minor)), '1', 'EX', 3_600);
    await db.sql.query(`INSERT INTO device_bans (id, kind, value_hash, reason, expires_at) VALUES (id_next(), 2, $1, 'under_age', now() + interval '1 year')`, [
      h.app.secrets.hasher.hash(hashDomains.phone, minor).hash,
    ]);
    const shape = (body: Record<string, unknown>) => ({ ...body, challengeId: typeof body['challengeId'] });
    const other = await post(h, '/v1/auth/otp/start', { phone: phone('ir'), locale: 'fa' });
    const refused = await post(h, '/v1/auth/otp/start', { phone: minor, locale: 'fa' });
    expect(refused.statusCode).toBe(200);
    expect(shape(refused.json())).toEqual(shape(other.json()));
    expect(statements(refused)).toBe(0);
    // Counted: the resend wait holds the number, and the two starts filled the IP's hourly cap (2).
    expect((await post(h, '/v1/auth/otp/start', { phone: minor, locale: 'fa' })).statusCode).toBe(429);
    expect((await post(h, '/v1/auth/otp/start', { phone: phone('ir'), locale: 'fa' })).statusCode).toBe(429);
    // Only the holder of the number, with its code, learns that it is refused.
    const code = h.sms.kavenegar.codeFor(minor);
    expect(code).toMatch(/^[0-9]{6}$/);
    const verify = await post(h, '/v1/auth/otp/verify', { challengeId: refused.json<{ challengeId: string }>().challengeId, code, ...device() });
    expect(verify.statusCode).toBe(403);
    expect(verify.json()).toMatchObject({ code: 'phone_banned' });
  });

  it('gives banned and suspended accounts a restricted session and deleted ones a restore session', async () => {
    h = await authApp(db);
    const cases = [
      { status: 6, scope: 'restricted', wire: 'banned' },
      { status: 5, scope: 'restricted', wire: 'suspended' },
      { status: 7, scope: 'restore', wire: 'deleted' },
    ] as const;
    for (const c of cases) {
      const number = phone('ir');
      const made = await signInWithPhone(h, number);
      const userId = h.app.publicIds.user.decodeId(made.json<{ user: { id: string } }>().user.id);
      await db.sql.query(
        `UPDATE users SET status = $2::smallint, birth_date = DATE '1995-01-01', gender = 1, deleted_at = CASE WHEN $2::smallint = 7 THEN now() END WHERE id = $1`,
        [userId, c.status],
      );
      await redis.del(h.app.keys.otpResendWait(h.app.otp.phoneKeyHash(number)));
      const again = await signInWithPhone(h, number);
      expect(again.statusCode).toBe(200);
      const body = again.json<{ accessToken: string; user: { status: string } }>();
      expect(body.user.status).toBe(c.wire);
      expect((await h.app.tokens.verify(body.accessToken)).scope).toBe(c.scope);
    }
  });

  it('writes no number, code or token to the log', async () => {
    h = await authApp(db);
    const number = phone('ir');
    const answer = await signInWithPhone(h, number);
    const { refreshToken, accessToken } = answer.json<{ refreshToken: string; accessToken: string }>();
    const code = h.sms.kavenegar.codeFor(number) ?? 'none';
    await post(h, '/v1/auth/refresh', { refreshToken });
    const log = h.logs.join('\n');
    expect(log.length).toBeGreaterThan(0);
    for (const secret of [number, number.slice(1), number.slice(3), code, refreshToken, accessToken]) expect(log).not.toContain(secret);
  });
});
