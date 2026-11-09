import { adminAccessTokenSchema, adminLoginResultSchema, adminMeSchema, adminTotpEnrollmentSchema, problemSchemaFor } from '@app/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, totpAt } from '../src/admin/totp.js';
import { migratedDatabase, row, rows, type TestDatabase } from './accountSupport.js';
import {
  admin,
  auditCount,
  code,
  installAuditFailure,
  refuseAudit,
  seedAdmin,
  setCookie,
  signIn,
  stableProblem,
  startAdminHarness,
  type AdminHarness,
} from './adminSupport.js';
import { statements } from './authSupport.js';
import { ADMIN_ORIGIN, hasInfrastructure } from './support.js';

/**
 * Admin sign-in against PostgreSQL and Valkey (docs/17 §3.17, W7
 * acceptance criterion 1): the password and TOTP steps, enrolment, the
 * lockout, uniform refusals, refresh rotation and reuse, revocation of a
 * session's access token, the panel's origin, permissions, and the audit
 * row of every write in the write's own transaction.
 */

let ipSeq = 0;
/** A fresh client address per test, so the per-IP limits of one test never touch another. */
function freshIp(): string {
  ipSeq += 1;
  return `10.${Math.floor(ipSeq / 250) % 250}.${ipSeq % 250}.7`;
}

describe.skipIf(!hasInfrastructure)('admin sign-in', () => {
  let db: TestDatabase;
  let h: AdminHarness;

  beforeAll(async () => {
    db = await migratedDatabase();
    await installAuditFailure(db);
    h = await startAdminHarness(db);
  }, 60_000);
  afterEach(async () => {
    await refuseAudit(db);
  });
  afterAll(async () => {
    await h?.close();
    await db?.drop();
  });

  it('signs in with a password and a TOTP code, and sets the refresh cookie the contract asks for', async () => {
    const account = await seedAdmin(h);
    const ip = freshIp();
    const login = await admin(h, '/v1/admin/auth/login', { email: account.email.toUpperCase(), password: account.password }, { ip });
    expect(login.statusCode).toBe(200);
    expect(statements(login)).toBeLessThanOrEqual(2);
    const first = adminLoginResultSchema.parse(login.json());
    expect(first.enrollRequired).toBe(false);
    expect(setCookie(login)).toBeNull();

    h.tick();
    const second = await admin(h, '/v1/admin/auth/totp', { mfaToken: first.mfaToken, code: code(h, account.secret!) }, { ip });
    expect(second.statusCode).toBe(200);
    expect(statements(second)).toBeLessThanOrEqual(3);
    const access = adminAccessTokenSchema.parse(second.json());
    const expiresIn = Date.parse(access.expiresAt) - Date.now();
    expect(expiresIn).toBeGreaterThan(590_000);
    expect(expiresIn).toBeLessThanOrEqual(600_000);

    const cookie = setCookie(second);
    expect(cookie?.value).toMatch(/^ar1\.[1-9][0-9]*\.[A-Za-z0-9_-]{43}$/);
    expect(cookie?.attributes).toEqual(expect.arrayContaining(['Path=/v1/admin/auth', 'HttpOnly', 'Secure', 'SameSite=Strict']));
    const maxAge = Number(cookie?.attributes.find((a) => a.startsWith('Max-Age='))?.slice(8));
    expect(maxAge).toBeGreaterThan(12 * 3_600 - 60);
    expect(maxAge).toBeLessThanOrEqual(12 * 3_600);

    const me = await admin(h, '/v1/admin/me', undefined, { token: access.accessToken });
    expect(me.statusCode).toBe(200);
    const view = adminMeSchema.parse(me.json());
    expect(view).toMatchObject({ id: String(account.id), email: account.email, roles: ['superadmin'], totpEnabled: true, lockedUntil: null });
    expect(view.permissions).toContain('admins.manage');
    expect(view.sessionId).toBe(cookie?.value.split('.')[1]);

    // The ticket is single use, and the sign-in left its audit row and its session row.
    const again = await admin(h, '/v1/admin/auth/totp', { mfaToken: first.mfaToken, code: code(h, account.secret!) }, { ip });
    expect(again.statusCode).toBe(401);
    expect(await auditCount(db, 'admin.login', account.id)).toBe(1);
    const session = await row<{ admin_id: number; revoked_at: Date | null; ip: string | null }>(db, `SELECT admin_id, revoked_at, host(ip) AS ip FROM admin_sessions WHERE id = $1`, [view.sessionId]);
    expect(session).toMatchObject({ admin_id: account.id, revoked_at: null });
  });

  it('answers every refused password the same way, at the same statement cost', async () => {
    const ip = freshIp();
    const account = await seedAdmin(h);
    const disabled = await seedAdmin(h);
    await db.sql.query(`UPDATE admin_users SET disabled_at = now() WHERE id = $1`, [disabled.id]);
    const locked = await seedAdmin(h);
    await db.sql.query(`UPDATE admin_users SET locked_until = now() + interval '10 minutes' WHERE id = $1`, [locked.id]);

    const attempts = [
      { email: 'nobody-here@example.com', password: 'whatever whatever' },
      { email: account.email, password: 'not the password at all' },
      { email: disabled.email, password: disabled.password },
      { email: locked.email, password: locked.password },
      { email: 'not an address', password: 'x' },
    ];
    const answers = [];
    for (const attempt of attempts) {
      const response = await admin(h, '/v1/admin/auth/login', attempt, { ip });
      expect(response.statusCode, attempt.email).toBe(401);
      expect(statements(response), attempt.email).toBe(2);
      problemSchemaFor('unauthorized').parse(response.json());
      answers.push(stableProblem(response));
    }
    for (const answer of answers) expect(answer).toEqual(answers[0]);
  });

  it('locks an account for 15 minutes after 5 wrong passwords, the right one included', async () => {
    const ip = freshIp();
    const account = await seedAdmin(h);
    for (let i = 0; i < 5; i += 1) {
      expect((await admin(h, '/v1/admin/auth/login', { email: account.email, password: `wrong password ${i}` }, { ip })).statusCode).toBe(401);
    }
    const state = await row<{ failed_logins: number; minutes: number }>(
      db,
      `SELECT failed_logins, (extract(epoch FROM locked_until - now()) / 60)::float8 AS minutes FROM admin_users WHERE id = $1`,
      [account.id],
    );
    expect(state.failed_logins).toBe(0);
    expect(state.minutes).toBeGreaterThan(14.9);
    expect(state.minutes).toBeLessThanOrEqual(15);

    // Locked: the right password gets the same refusal, and more tries do not move the lock.
    const right = await admin(h, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip });
    expect(right.statusCode).toBe(401);
    await admin(h, '/v1/admin/auth/login', { email: account.email, password: 'wrong again and again' }, { ip });
    const still = await row<{ minutes: number }>(db, `SELECT (extract(epoch FROM locked_until - now()) / 60)::float8 AS minutes FROM admin_users WHERE id = $1`, [account.id]);
    expect(still.minutes).toBeLessThanOrEqual(state.minutes);

    // Fifteen minutes later the right password works, and a full sign-in clears the count.
    await db.sql.query(`UPDATE admin_users SET locked_until = now() - interval '1 second' WHERE id = $1`, [account.id]);
    await signIn(h, account, ip);
    const cleared = await row<{ failed_logins: number; locked_until: Date | null }>(db, `SELECT failed_logins, locked_until FROM admin_users WHERE id = $1`, [account.id]);
    expect(cleared).toEqual({ failed_logins: 0, locked_until: null });
  });

  it('counts wrong codes with wrong passwords, and a right password does not reset the count', async () => {
    const ip = freshIp();
    const account = await seedAdmin(h);
    for (let i = 0; i < 2; i += 1) await admin(h, '/v1/admin/auth/login', { email: account.email, password: `bad password ${i}` }, { ip });
    const login = await admin(h, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip });
    const { mfaToken } = login.json<{ mfaToken: string }>();
    const wrong = (n: number) => admin(h, '/v1/admin/auth/totp', { mfaToken, code: String((Number(code(h, account.secret!)) + n) % 1_000_000).padStart(6, '0') }, { ip });
    const first = await wrong(1);
    expect(first.statusCode).toBe(400);
    expect(first.json()).toMatchObject({ code: 'otp_invalid', attemptsLeft: 2 });
    expect((await wrong(2)).json()).toMatchObject({ code: 'otp_invalid', attemptsLeft: 1 });
    const fifth = await wrong(3);
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json()).toMatchObject({ code: 'otp_locked' });
    // The ticket is gone and the account is locked: even the right code is refused.
    h.tick();
    expect((await admin(h, '/v1/admin/auth/totp', { mfaToken, code: code(h, account.secret!) }, { ip })).statusCode).toBe(401);
    expect((await admin(h, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip })).statusCode).toBe(401);
  });

  /** Until the gate of this process runs (or waits for) `count` hashes. */
  async function gateHolds(count: number): Promise<void> {
    for (let i = 0; i < 400; i += 1) {
      const load = h.app.adminAuth.passwords.gate.load;
      if (load.running + load.waiting >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`the hash gate never held ${count} hashes`);
  }

  /** A hash that takes a while to check (a few hundred milliseconds), so a test can act while it runs. */
  const SLOW_ARGON2 = { memory: 65_536, passes: 6, parallelism: 1 };

  it('accepts the right password only while the account is open after the hash: a lock written meanwhile refuses it', async () => {
    const ip = freshIp();
    const account = await seedAdmin(h, { argon2: SLOW_ARGON2 });
    // A lock committed while the password is being hashed (other guesses failed meanwhile).
    const pending = admin(h, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip });
    await gateHolds(1);
    await db.sql.query(`UPDATE admin_users SET locked_until = now() + interval '15 minutes', failed_logins = 0 WHERE id = $1`, [account.id]);
    const late = await pending;
    expect(late.statusCode).toBe(401);
    expect(stableProblem(late)).toEqual(stableProblem(await admin(h, '/v1/admin/auth/login', { email: account.email, password: 'not the password at all' }, { ip })));

    // A failure being counted at the very moment of the decision (its row lock held): it is waited for, and its lock seen.
    await db.sql.query(`UPDATE admin_users SET locked_until = NULL WHERE id = $1`, [account.id]);
    const other = await db.sql.connect();
    try {
      await other.query('BEGIN');
      await other.query(`UPDATE admin_users SET locked_until = now() + interval '15 minutes' WHERE id = $1`, [account.id]);
      const racing = admin(h, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip });
      for (let i = 0; i < 400; i += 1) {
        const waiting = await row<{ n: number }>(db, `SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
        if (waiting.n > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await other.query('COMMIT');
      expect((await racing).statusCode).toBe(401);
    } finally {
      await other.query('ROLLBACK').catch(() => undefined);
      other.release();
    }
    // Open again, the same password signs in (and the slow hash is replaced by one of the current parameters).
    await db.sql.query(`UPDATE admin_users SET locked_until = NULL, failed_logins = 0 WHERE id = $1`, [account.id]);
    const open = await admin(h, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip });
    expect(open.statusCode).toBe(200);
    expect(statements(open)).toBe(2);
    expect((await row<{ hash: string }>(db, `SELECT password_hash AS hash FROM admin_users WHERE id = $1`, [account.id])).hash).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$/);
  });

  it('never confirms the right password once parallel wrong guesses locked the account', async () => {
    const ip = freshIp();
    const account = await seedAdmin(h, { argon2: SLOW_ARGON2 });
    // Nine wrong guesses at once; the right one queued behind them (the gate runs them in order).
    const wrong = Array.from({ length: 9 }, (_, i) => admin(h, '/v1/admin/auth/login', { email: account.email, password: `parallel wrong guess ${i}` }, { ip }));
    await gateHolds(9);
    const right = admin(h, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip });
    const answers = await Promise.all([...wrong, right]);
    for (const answer of answers) expect(answer.statusCode, answer.body).toBe(401);
    const state = await row<{ locked: boolean }>(db, `SELECT locked_until > now() AS locked FROM admin_users WHERE id = $1`, [account.id]);
    expect(state.locked).toBe(true);
  });

  it('hashes at most two passwords at once and refuses logins past the queue with 503 and Retry-After', async () => {
    const account = await seedAdmin(h, { argon2: SLOW_ARGON2 });
    // Every guess checks the slow hash (a locked account still costs its check), from as many addresses.
    const answers = await Promise.all(
      Array.from({ length: 40 }, (_, i) => admin(h, '/v1/admin/auth/login', { email: account.email, password: `flood guess ${i}` }, { ip: freshIp() })),
    );
    const busy = answers.filter((a) => a.statusCode === 503);
    expect(busy.length).toBeGreaterThan(0);
    for (const answer of busy) {
      expect(answer.headers['retry-after']).toBe('5');
      expect(answer.json()).toMatchObject({ code: 'service_unavailable' });
    }
    expect(answers.every((a) => a.statusCode === 401 || a.statusCode === 503)).toBe(true);
    expect(h.app.adminAuth.passwords.gate.load).toEqual({ running: 0, waiting: 0 });
    await db.sql.query(`UPDATE admin_users SET locked_until = NULL, failed_logins = 0 WHERE id = $1`, [account.id]);
  });

  it('limits logins from every address together, failing closed', async () => {
    const limited = await startAdminHarness(db, {}, { adminAuth: { loginLimit: { cap: 3, windowMs: 60_000 } } });
    try {
      for (let i = 0; i < 3; i += 1) {
        expect((await admin(limited, '/v1/admin/auth/login', { email: `all-${i}@example.com`, password: 'no such account here' }, { ip: freshIp() })).statusCode).toBe(401);
      }
      const refused = await admin(limited, '/v1/admin/auth/login', { email: 'all-4@example.com', password: 'no such account here' }, { ip: freshIp() });
      expect(refused.statusCode).toBe(429);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(statements(refused)).toBe(0);
      // A refused login counts nothing (all or none): the shared window still holds the three that went through.
      expect(Number(await limited.redis.get(limited.app.keys.adminLoginLimit()))).toBe(3);
    } finally {
      await limited.close();
    }
  });

  it('refuses a code twice (replay), without counting it as a guess', async () => {
    const ip = freshIp();
    const account = await seedAdmin(h);
    await signIn(h, account, ip);
    const login = await admin(h, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip });
    const { mfaToken } = login.json<{ mfaToken: string }>();
    // The same clock: the code that signed in a moment ago.
    const replay = await admin(h, '/v1/admin/auth/totp', { mfaToken, code: code(h, account.secret!) }, { ip });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({ code: 'otp_invalid', attemptsLeft: 5 });
    // The previous step is refused too (it is older than the one used).
    const older = await admin(h, '/v1/admin/auth/totp', { mfaToken, code: totpAt(account.secret!, h.clock.now - 30_000) }, { ip });
    expect(older.statusCode).toBe(400);
    h.tick();
    expect((await admin(h, '/v1/admin/auth/totp', { mfaToken, code: code(h, account.secret!) }, { ip })).statusCode).toBe(200);
    expect((await row<{ failed_logins: number }>(db, `SELECT failed_logins FROM admin_users WHERE id = $1`, [account.id])).failed_logins).toBe(0);
  });

  it('lets nothing but enrolment work before TOTP is set up', async () => {
    const ip = freshIp();
    const account = await seedAdmin(h, { totp: 'none' });
    const login = await admin(h, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip });
    expect(login.statusCode).toBe(200);
    const { mfaToken, enrollRequired } = adminLoginResultSchema.parse(login.json());
    expect(enrollRequired).toBe(true);

    // The ticket is no access token, and the sign-in step for enrolled accounts does not take it.
    expect((await admin(h, '/v1/admin/me', undefined, { token: mfaToken })).statusCode).toBe(401);
    expect((await admin(h, '/v1/admin/admins', undefined, { token: mfaToken })).statusCode).toBe(401);
    expect((await admin(h, '/v1/admin/auth/totp', { mfaToken, code: '123456' }, { ip })).json()).toMatchObject({ code: 'conflict' });
    expect((await admin(h, '/v1/admin/auth/totp/confirm', { mfaToken, code: '123456' }, { ip })).json()).toMatchObject({ code: 'conflict' });
    expect(await rows(db, `SELECT 1 FROM admin_sessions WHERE admin_id = $1`, [account.id])).toHaveLength(0);

    const enrol = await admin(h, '/v1/admin/auth/totp/enroll', { mfaToken }, { ip });
    expect(enrol.statusCode).toBe(200);
    const enrolment = adminTotpEnrollmentSchema.parse(enrol.json());
    // The issuer is the brand's app name, never a fixed word.
    expect(enrolment.otpauthUri).toMatch(new RegExp(`^otpauth://totp/${encodeURIComponent(h.app.brand.appName)}:`));
    expect(enrolment.otpauthUri).toContain(`secret=${enrolment.secret}`);
    const secret = base32Decode(enrolment.secret);
    // Stored sealed, never in clear.
    const stored = await row<{ totp_secret_enc: Buffer; totp_enabled_at: Date | null }>(db, `SELECT totp_secret_enc, totp_enabled_at FROM admin_users WHERE id = $1`, [account.id]);
    expect(stored.totp_enabled_at).toBeNull();
    expect(stored.totp_secret_enc.includes(secret)).toBe(false);
    expect(h.app.secrets.sealer.open(stored.totp_secret_enc, 'admin_users.totp_secret_enc').equals(secret)).toBe(true);
    expect(await auditCount(db, 'admin.totp_issue', account.id)).toBe(1);

    const bad = await admin(h, '/v1/admin/auth/totp/confirm', { mfaToken, code: String((Number(totpAt(secret, h.clock.now)) + 1) % 1_000_000).padStart(6, '0') }, { ip });
    expect(bad.json()).toMatchObject({ code: 'otp_invalid' });
    h.tick();
    const confirm = await admin(h, '/v1/admin/auth/totp/confirm', { mfaToken, code: totpAt(secret, h.clock.now) }, { ip });
    expect(confirm.statusCode).toBe(200);
    expect(setCookie(confirm)).not.toBeNull();
    const token = confirm.json<{ accessToken: string }>().accessToken;
    expect((await admin(h, '/v1/admin/me', undefined, { token })).json()).toMatchObject({ totpEnabled: true });
    expect(await auditCount(db, 'admin.totp_enroll', account.id)).toBe(1);

    // Enrolled now: the next sign-in asks for a code, and enrolment is closed.
    const next = await admin(h, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip });
    const ticket = adminLoginResultSchema.parse(next.json());
    expect(ticket.enrollRequired).toBe(false);
    expect((await admin(h, '/v1/admin/auth/totp/enroll', { mfaToken: ticket.mfaToken }, { ip })).json()).toMatchObject({ code: 'already_set' });
  });

  it('rotates the refresh cookie; two tabs at once share the answer; a reuse later revokes the session', async () => {
    const ip = freshIp();
    const account = await seedAdmin(h);
    const session = await signIn(h, account, ip);

    const [a, b] = await Promise.all([
      admin(h, '/v1/admin/auth/refresh', {}, { cookie: session.cookie, ip }),
      admin(h, '/v1/admin/auth/refresh', {}, { cookie: session.cookie, ip }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(Math.max(statements(a), statements(b))).toBeLessThanOrEqual(1);
    const rotated = setCookie(a)!;
    expect(rotated.value).not.toBe(session.cookie);
    expect(setCookie(b)?.value).toBe(rotated.value);
    expect(rotated.attributes).toEqual(expect.arrayContaining(['Path=/v1/admin/auth', 'HttpOnly', 'Secure', 'SameSite=Strict']));
    const fresh = adminAccessTokenSchema.parse(a.json()).accessToken;
    expect((await admin(h, '/v1/admin/me', undefined, { token: fresh })).statusCode).toBe(200);

    // After the grace, the replaced cookie is a copy on the loose: the session ends, its access tokens too.
    await new Promise((resolve) => setTimeout(resolve, 350));
    await db.sql.query(`UPDATE admin_sessions SET refreshed_at = refreshed_at - interval '1 minute' WHERE id = $1`, [session.sessionId]);
    const reuse = await admin(h, '/v1/admin/auth/refresh', {}, { cookie: session.cookie, ip });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json()).toMatchObject({ code: 'refresh_reused' });
    expect(setCookie(reuse)?.attributes).toContain('Max-Age=0');
    const revoked = await row<{ revoke_reason: number }>(db, `SELECT revoke_reason FROM admin_sessions WHERE id = $1`, [session.sessionId]);
    expect(revoked.revoke_reason).toBe(3);
    expect((await admin(h, '/v1/admin/me', undefined, { token: fresh })).statusCode).toBe(401);
    expect((await admin(h, '/v1/admin/auth/refresh', {}, { cookie: rotated.value, ip })).statusCode).toBe(401);
  });

  it('stops a revoked session: its access token at once (deny list), its cookie at the next refresh', async () => {
    const ip = freshIp();
    const account = await seedAdmin(h);
    const one = await signIn(h, account, ip);
    const two = await signIn(h, account, ip);

    // A revocation the deny list never heard of (written straight to the database): the stolen access token
    // works until it expires, but the next refresh fails, so no new one comes.
    await db.sql.query(`UPDATE admin_sessions SET revoked_at = now(), revoke_reason = 4 WHERE id = $1`, [one.sessionId]);
    expect((await admin(h, '/v1/admin/me', undefined, { token: one.accessToken })).statusCode).toBe(200);
    const refused = await admin(h, '/v1/admin/auth/refresh', {}, { cookie: one.cookie, ip });
    expect(refused.json()).toMatchObject({ code: 'refresh_invalid' });

    // Through the API: the session's access token stops at once, the other session goes on.
    const out = await admin(h, '/v1/admin/auth/logout', {}, { cookie: two.cookie, token: two.accessToken, ip });
    expect(out.statusCode).toBe(204);
    expect(setCookie(out)?.attributes).toContain('Max-Age=0');
    expect((await admin(h, '/v1/admin/me', undefined, { token: two.accessToken })).statusCode).toBe(401);
    expect((await admin(h, '/v1/admin/auth/refresh', {}, { cookie: two.cookie, ip })).statusCode).toBe(401);
    expect(await auditCount(db, 'admin.logout', account.id)).toBe(1);

    // Signing out everywhere ends every session, the ones on other devices included.
    const three = await signIn(h, account, ip);
    const four = await signIn(h, account, ip);
    const all = await admin(h, '/v1/admin/auth/logout', { all: true }, { cookie: three.cookie, ip });
    expect(all.statusCode).toBe(204);
    for (const s of [three, four]) {
      expect((await admin(h, '/v1/admin/me', undefined, { token: s.accessToken })).statusCode).toBe(401);
      expect((await admin(h, '/v1/admin/auth/refresh', {}, { cookie: s.cookie, ip })).statusCode).toBe(401);
    }
    expect(await auditCount(db, 'admin.logout_all', account.id)).toBe(1);

    // A sign-out with a cookie that names no live session changes nothing and still clears the cookie.
    const stale = await admin(h, '/v1/admin/auth/logout', {}, { cookie: three.cookie, ip });
    expect(stale.statusCode).toBe(204);
    expect(await auditCount(db, 'admin.logout', account.id)).toBe(1);

    // One session signed out from the session list.
    const five = await signIn(h, account, ip);
    const six = await signIn(h, account, ip);
    const list = await admin(h, '/v1/admin/me/sessions', undefined, { token: five.accessToken });
    expect(list.json<{ items: { id: string; current: boolean }[] }>().items.map((s) => [s.id, s.current])).toEqual([
      [six.sessionId, false],
      [five.sessionId, true],
    ]);
    const drop = await admin(h, `/v1/admin/me/sessions/${six.sessionId}`, undefined, { token: five.accessToken, method: 'DELETE' });
    expect(drop.statusCode).toBe(204);
    expect((await admin(h, '/v1/admin/me', undefined, { token: six.accessToken })).statusCode).toBe(401);
    expect((await admin(h, '/v1/admin/me', undefined, { token: five.accessToken })).statusCode).toBe(200);
    expect((await admin(h, `/v1/admin/me/sessions/${six.sessionId}`, undefined, { token: five.accessToken, method: 'DELETE' })).statusCode).toBe(404);
  });

  it("refuses every origin but the panel's on /v1/admin/*, and the cookie routes without one", async () => {
    const account = await seedAdmin(h);
    const session = await signIn(h, account, freshIp());
    const evil = 'https://evil.example.net';

    const preflight = await h.app.inject({
      method: 'OPTIONS',
      url: '/v1/admin/auth/refresh',
      headers: { origin: evil, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    // No allowed origin in the answer: the browser does not send the request.
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();

    for (const [url, body] of [['/v1/admin/me', undefined], ['/v1/admin/auth/login', { email: account.email, password: account.password }], ['/v1/admin/auth/refresh', {}]] as const) {
      const response = await admin(h, url, body, { origin: evil, token: session.accessToken, cookie: session.cookie });
      expect(response.statusCode, url).toBe(403);
      expect(response.headers['access-control-allow-origin'], url).toBeUndefined();
    }

    const ok = await admin(h, '/v1/admin/me', undefined, { token: session.accessToken });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe(ADMIN_ORIGIN);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const allowed = await h.app.inject({
      method: 'OPTIONS',
      url: '/v1/admin/auth/refresh',
      headers: { origin: ADMIN_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe(ADMIN_ORIGIN);

    // The cookie routes need the panel's Origin (a request no browser page sent is refused).
    expect((await admin(h, '/v1/admin/auth/refresh', {}, { origin: null, cookie: session.cookie })).statusCode).toBe(403);
    expect((await admin(h, '/v1/admin/auth/logout', {}, { origin: null, cookie: session.cookie })).statusCode).toBe(403);
    // A server-side client without an Origin may still use a bearer token.
    expect((await admin(h, '/v1/admin/me', undefined, { origin: null, token: session.accessToken })).statusCode).toBe(200);
  });

  it('limits sign-in attempts per address, failing closed', async () => {
    const ip = freshIp();
    for (let i = 0; i < 20; i += 1) {
      expect((await admin(h, '/v1/admin/auth/login', { email: `x${i}@example.com`, password: 'no such account here' }, { ip })).statusCode).toBe(401);
    }
    const limited = await admin(h, '/v1/admin/auth/login', { email: 'x@example.com', password: 'no such account here' }, { ip });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Another address is not affected.
    expect((await admin(h, '/v1/admin/auth/login', { email: 'x@example.com', password: 'no such account here' }, { ip: freshIp() })).statusCode).toBe(401);
  });

  it('lets a route through by permission, from the roles in memory, at no statement', async () => {
    const owner = await seedAdmin(h);
    const moderator = await seedAdmin(h, { roles: ['moderator'] });
    const adminRole = await seedAdmin(h, { roles: ['admin'] });
    const [o, m, a] = [await signIn(h, owner, freshIp()), await signIn(h, moderator, freshIp()), await signIn(h, adminRole, freshIp())];

    const list = await admin(h, '/v1/admin/admins', undefined, { token: o.accessToken });
    expect(list.statusCode).toBe(200);
    expect(statements(list)).toBe(1);
    expect((await admin(h, '/v1/admin/roles', undefined, { token: o.accessToken })).statusCode).toBe(200);
    expect(statements(await admin(h, '/v1/admin/roles', undefined, { token: o.accessToken }))).toBe(0);
    for (const token of [m.accessToken, a.accessToken]) {
      const refused = await admin(h, '/v1/admin/admins', undefined, { token });
      expect(refused.statusCode).toBe(403);
      expect(statements(refused)).toBe(0);
      expect((await admin(h, '/v1/admin/admins', { email: 'new@example.com', displayName: 'New', roles: ['support'] }, { token })).statusCode).toBe(403);
    }
    // The admin role's config.* does not reach the owner-only provider settings (restricted), nor do the older
    // superadmin-only routes take anything but a token of the owner role.
    expect((await admin(h, '/v1/admin/providers/rtc', undefined, { token: a.accessToken })).statusCode).toBe(403);
    expect((await admin(h, '/v1/admin/origins', undefined, { token: o.accessToken })).statusCode).toBe(200);
    expect((await admin(h, '/v1/admin/providers/rtc', undefined, { token: o.accessToken })).statusCode).toBe(200);
    const meView = adminMeSchema.parse((await admin(h, '/v1/admin/me', undefined, { token: m.accessToken })).json());
    expect(meView.permissions).toEqual(expect.arrayContaining(['moderation.decide', 'reports.view_chat', 'dashboard.read']));
    expect(meView.permissions).not.toContain('admins.read');
    // An app token is never an admin token.
    expect((await admin(h, '/v1/admin/admins', undefined, { token: (await h.app.tokens.issue({ kind: 'app', subject: 'abcdefghijklm', sessionId: '5' })).token })).statusCode).toBe(401);
  });

  it('manages admins (owner only): create, roles, disable, enable, reset TOTP and password, each signing the target out', async () => {
    const owner = await seedAdmin(h);
    const o = await signIn(h, owner, freshIp());
    const ip = freshIp();

    // Create, with a password the server makes and shows once.
    const created = await admin(h, '/v1/admin/admins', { email: 'New.Person@Example.com', displayName: 'New person', roles: ['support', 'moderator'] }, { token: o.accessToken });
    expect(created.statusCode).toBe(201);
    expect(statements(created)).toBeLessThanOrEqual(3);
    const body = created.json<{ admin: { id: string; email: string; roles: string[]; totpEnabled: boolean; createdBy: string }; initialPassword: string }>();
    expect(body.admin).toMatchObject({ email: 'new.person@example.com', roles: ['moderator', 'support'], totpEnabled: false, createdBy: String(owner.id) });
    expect(body.initialPassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const id = Number(body.admin.id);
    expect(await auditCount(db, 'admin.create', id)).toBe(1);
    const auditDetail = await row<{ detail: string }>(db, `SELECT detail::text FROM audit_log WHERE action = 'admin.create' AND target_id = $1`, [id]);
    expect(auditDetail.detail).not.toContain(body.initialPassword);
    expect(auditDetail.detail).not.toContain('argon2');
    expect((await admin(h, '/v1/admin/admins', { email: 'new.person@example.com', displayName: 'Again', roles: ['support'] }, { token: o.accessToken })).statusCode).toBe(409);
    expect((await admin(h, '/v1/admin/admins', { email: 'short@example.com', displayName: 'Short', roles: ['support'], password: 'too short' }, { token: o.accessToken })).json()).toMatchObject({ code: 'field_invalid' });
    expect((await admin(h, '/v1/admin/admins', { email: 'role@example.com', displayName: 'Role', roles: ['nope'] }, { token: o.accessToken })).json()).toMatchObject({ code: 'field_invalid' });

    // The new admin signs in (enrolment first) with that password.
    const newcomer = { id, email: 'new.person@example.com', password: body.initialPassword, secret: null as Buffer | null };
    const login = await admin(h, '/v1/admin/auth/login', { email: newcomer.email, password: newcomer.password }, { ip });
    const { mfaToken } = login.json<{ mfaToken: string; enrollRequired: boolean }>();
    const enrol = adminTotpEnrollmentSchema.parse((await admin(h, '/v1/admin/auth/totp/enroll', { mfaToken }, { ip })).json());
    newcomer.secret = base32Decode(enrol.secret);
    h.tick();
    const confirm = await admin(h, '/v1/admin/auth/totp/confirm', { mfaToken, code: code(h, newcomer.secret) }, { ip });
    expect(confirm.statusCode).toBe(200);
    let token = confirm.json<{ accessToken: string }>().accessToken;
    let cookie = setCookie(confirm)!.value;

    // A role change signs the account out everywhere (at once), so the new roles hold from the next sign-in.
    const patched = await admin(h, `/v1/admin/admins/${id}`, { roles: ['analyst'], displayName: 'Renamed' }, { token: o.accessToken, method: 'PATCH' });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ roles: ['analyst'], displayName: 'Renamed' });
    expect((await admin(h, '/v1/admin/me', undefined, { token })).statusCode).toBe(401);
    expect((await admin(h, '/v1/admin/auth/refresh', {}, { cookie, ip })).statusCode).toBe(401);
    const update = await row<{ detail: { before: { roles: string[] }; after: { roles: string[] } } }>(db, `SELECT detail FROM audit_log WHERE action = 'admin.update' AND target_id = $1`, [id]);
    expect(update.detail.before.roles).toEqual(['moderator', 'support']);
    expect(update.detail.after.roles).toEqual(['analyst']);
    const fresh = await signIn(h, newcomer, ip);
    expect(adminMeSchema.parse((await admin(h, '/v1/admin/me', undefined, { token: fresh.accessToken })).json()).roles).toEqual(['analyst']);
    token = fresh.accessToken;
    cookie = fresh.cookie;

    // Disable: tokens stop at once, sign-in is refused like a wrong password.
    const disabled = await admin(h, `/v1/admin/admins/${id}/disable`, {}, { token: o.accessToken });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json<{ disabledAt: string | null }>().disabledAt).not.toBeNull();
    expect((await admin(h, '/v1/admin/me', undefined, { token })).statusCode).toBe(401);
    expect((await admin(h, '/v1/admin/auth/refresh', {}, { cookie, ip })).statusCode).toBe(401);
    expect((await admin(h, '/v1/admin/auth/login', { email: newcomer.email, password: newcomer.password }, { ip })).statusCode).toBe(401);
    expect(await auditCount(db, 'admin.disable', id)).toBe(1);

    const enabled = await admin(h, `/v1/admin/admins/${id}/enable`, {}, { token: o.accessToken });
    expect(enabled.json<{ disabledAt: string | null }>().disabledAt).toBeNull();
    expect(await auditCount(db, 'admin.enable', id)).toBe(1);
    await signIn(h, newcomer, ip);

    // Reset TOTP: the next sign-in enrols again.
    expect((await admin(h, `/v1/admin/admins/${id}/reset-totp`, {}, { token: o.accessToken })).json()).toMatchObject({ totpEnabled: false });
    const relogin = await admin(h, '/v1/admin/auth/login', { email: newcomer.email, password: newcomer.password }, { ip });
    expect(relogin.json()).toMatchObject({ enrollRequired: true });
    expect(await auditCount(db, 'admin.totp_reset', id)).toBe(1);

    // Reset the password: the old one is refused, the new one (shown once) works.
    const reset = await admin(h, `/v1/admin/admins/${id}/reset-password`, {}, { token: o.accessToken });
    const { initialPassword } = reset.json<{ initialPassword: string }>();
    expect((await admin(h, '/v1/admin/auth/login', { email: newcomer.email, password: newcomer.password }, { ip })).statusCode).toBe(401);
    expect((await admin(h, '/v1/admin/auth/login', { email: newcomer.email, password: initialPassword }, { ip })).statusCode).toBe(200);
    expect(await auditCount(db, 'admin.password_reset', id)).toBe(1);

    // Nobody changes their own account here, and the list pages by id.
    for (const path of ['disable', 'reset-totp', 'reset-password', 'enable']) {
      expect((await admin(h, `/v1/admin/admins/${owner.id}/${path}`, {}, { token: o.accessToken })).statusCode, path).toBe(409);
    }
    expect((await admin(h, `/v1/admin/admins/${owner.id}`, { roles: ['support'] }, { token: o.accessToken, method: 'PATCH' })).statusCode).toBe(409);
    expect((await admin(h, `/v1/admin/admins/99999`, {}, { token: o.accessToken })).statusCode).toBe(404);
    const page = await admin(h, '/v1/admin/admins?limit=2', undefined, { token: o.accessToken });
    const first = page.json<{ items: { id: string }[]; nextCursor: string | null }>();
    expect(first.items).toHaveLength(2);
    const second = (await admin(h, `/v1/admin/admins?limit=2&cursor=${first.nextCursor}`, undefined, { token: o.accessToken })).json<{ items: { id: string }[] }>();
    expect(Number(second.items[0]?.id)).toBeGreaterThan(Number(first.items[1]?.id));
  });

  it('keeps at least one enabled owner', async () => {
    const ownerA = await seedAdmin(h);
    const ownerB = await seedAdmin(h);
    const a = await signIn(h, ownerA, freshIp());
    // A role that is not the owner role but grants everything (every permission, the restricted ones too) may manage
    // owners: the last enabled one stays all the same.
    await db.sql.query(`INSERT INTO admin_role_permissions (role_id, permission) SELECT id, '*' FROM admin_roles WHERE key = 'support' ON CONFLICT DO NOTHING`);
    await h.app.adminAuth.roles.reload();
    try {
      const helper = await seedAdmin(h, { roles: ['support'] });
      const s = await signIn(h, helper, freshIp());
      // Every other enabled owner off: the helper disables B, then may not disable A, the last one.
      const owners = await rows<{ id: number }>(db, `SELECT u.id FROM admin_users u JOIN admin_user_roles r ON r.admin_id = u.id AND r.role_id = 1 WHERE u.disabled_at IS NULL AND u.id NOT IN ($1, $2)`, [ownerA.id, ownerB.id]);
      for (const other of owners) await db.sql.query(`UPDATE admin_users SET disabled_at = now() WHERE id = $1`, [other.id]);
      expect((await admin(h, `/v1/admin/admins/${ownerB.id}/disable`, {}, { token: s.accessToken })).statusCode).toBe(200);
      const last = await admin(h, `/v1/admin/admins/${ownerA.id}/disable`, {}, { token: s.accessToken });
      expect(last.statusCode).toBe(409);
      expect((await admin(h, `/v1/admin/admins/${ownerA.id}`, { roles: ['support'] }, { token: s.accessToken, method: 'PATCH' })).statusCode).toBe(409);
      expect((await admin(h, '/v1/admin/me', undefined, { token: a.accessToken })).statusCode).toBe(200);
      for (const other of owners) await db.sql.query(`UPDATE admin_users SET disabled_at = NULL WHERE id = $1`, [other.id]);
    } finally {
      await db.sql.query(`DELETE FROM admin_role_permissions WHERE role_id = 4 AND permission = '*'`);
      await h.app.adminAuth.roles.reload();
    }
  });

  it('lets admins.manage granted by name reach no account and give no role beyond its own access', async () => {
    const owner = await seedAdmin(h);
    const adminRole = await seedAdmin(h, { roles: ['admin'] });
    await db.sql.query(`INSERT INTO admin_role_permissions (role_id, permission) SELECT id, p FROM admin_roles, unnest(ARRAY['admins.manage', 'admins.read']) p WHERE key = 'support' ON CONFLICT DO NOTHING`);
    await h.app.adminAuth.roles.reload();
    try {
      const lead = await seedAdmin(h, { roles: ['support'] });
      const t = (await signIn(h, lead, freshIp())).accessToken;
      const ownerBefore = await row<{ hash: string; totp: boolean; disabled: boolean; name: string }>(
        db,
        `SELECT password_hash AS hash, totp_enabled_at IS NOT NULL AS totp, disabled_at IS NOT NULL AS disabled, display_name AS name FROM admin_users WHERE id = $1`,
        [owner.id],
      );

      // No account with more than the caller has, the owner role least of all.
      for (const roles of [['superadmin'], ['admin'], ['support', 'moderator']]) {
        const made = await admin(h, '/v1/admin/admins', { email: `lead-${roles.join('-')}@example.com`, displayName: 'Made', roles, password: 'a password the lead chose' }, { token: t });
        expect(made.statusCode, roles.join()).toBe(403);
        expect(problemSchemaFor('forbidden').parse(made.json()).code).toBe('forbidden');
      }
      expect(await rows(db, `SELECT 1 FROM admin_users WHERE email LIKE 'lead-%'`)).toHaveLength(0);

      // No change to an account with more than the caller has: no password or TOTP reset, no disable, no rename, no roles.
      for (const [path, body, method] of [
        [`/v1/admin/admins/${owner.id}/reset-password`, {}, 'POST'],
        [`/v1/admin/admins/${owner.id}/reset-totp`, {}, 'POST'],
        [`/v1/admin/admins/${owner.id}/disable`, {}, 'POST'],
        [`/v1/admin/admins/${owner.id}/enable`, {}, 'POST'],
        [`/v1/admin/admins/${owner.id}`, { displayName: 'Taken over' }, 'PATCH'],
        [`/v1/admin/admins/${owner.id}`, { roles: ['support'] }, 'PATCH'],
        [`/v1/admin/admins/${adminRole.id}/reset-password`, {}, 'POST'],
      ] as const) {
        const res = await admin(h, path, body, { token: t, method });
        expect(res.statusCode, `${method} ${path}`).toBe(403);
        expect(res.json()).not.toHaveProperty('initialPassword');
      }
      expect(
        await row(db, `SELECT password_hash AS hash, totp_enabled_at IS NOT NULL AS totp, disabled_at IS NOT NULL AS disabled, display_name AS name FROM admin_users WHERE id = $1`, [owner.id]),
      ).toEqual(ownerBefore);
      expect(await auditCount(db, 'admin.password_reset', owner.id)).toBe(0);
      expect(await auditCount(db, 'admin.totp_reset', owner.id)).toBe(0);
      // The owner signs in as before.
      await signIn(h, owner, freshIp());

      // Within its own access it manages: an account of its own role or less, and its roles within the same bound.
      const made = await admin(h, '/v1/admin/admins', { email: 'lead-made@example.com', displayName: 'Made', roles: ['analyst'] }, { token: t });
      expect(made.statusCode).toBe(201);
      const id = made.json<{ admin: { id: string } }>().admin.id;
      expect((await admin(h, `/v1/admin/admins/${id}`, { roles: ['superadmin'] }, { token: t, method: 'PATCH' })).statusCode).toBe(403);
      expect((await admin(h, `/v1/admin/admins/${id}`, { roles: ['analyst', 'moderator'] }, { token: t, method: 'PATCH' })).statusCode).toBe(403);
      const promoted = await admin(h, `/v1/admin/admins/${id}`, { roles: ['support'] }, { token: t, method: 'PATCH' });
      expect(promoted.statusCode).toBe(200);
      expect(promoted.json()).toMatchObject({ roles: ['support'] });
      expect((await admin(h, `/v1/admin/admins/${id}/reset-password`, {}, { token: t })).statusCode).toBe(200);
      expect((await admin(h, `/v1/admin/admins/${id}/disable`, {}, { token: t })).statusCode).toBe(200);
    } finally {
      await db.sql.query(`DELETE FROM admin_role_permissions WHERE role_id = 4 AND permission IN ('admins.manage', 'admins.read')`);
      await h.app.adminAuth.roles.reload();
    }
  });

  describe('every admin write writes its audit row in its own transaction', () => {
    it('rolls the change back when its audit row cannot be written, route by route', async () => {
      const owner = await seedAdmin(h);
      const o = await signIn(h, owner, freshIp());
      const ip = freshIp();

      const account = async (id: number) =>
        row<{ display_name: string; disabled: boolean; totp: boolean; hash: string; sessions: number }>(
          db,
          `SELECT display_name, disabled_at IS NOT NULL AS disabled, totp_enabled_at IS NOT NULL AS totp, password_hash AS hash,
                  (SELECT count(*)::integer FROM admin_sessions s WHERE s.admin_id = u.id AND s.revoked_at IS NULL) AS sessions
             FROM admin_users u WHERE id = $1`,
          [id],
        );

      // Admin management.
      const target = await seedAdmin(h, { roles: ['support'] });
      await signIn(h, target, ip);
      const before = await account(target.id);
      const cases: [action: string, run: () => Promise<{ statusCode: number }>][] = [
        ['admin.create', () => admin(h, '/v1/admin/admins', { email: 'rolled.back@example.com', displayName: 'Rolled back', roles: ['support'] }, { token: o.accessToken })],
        ['admin.update', () => admin(h, `/v1/admin/admins/${target.id}`, { displayName: 'Changed', roles: ['analyst'] }, { token: o.accessToken, method: 'PATCH' })],
        ['admin.disable', () => admin(h, `/v1/admin/admins/${target.id}/disable`, {}, { token: o.accessToken })],
        ['admin.totp_reset', () => admin(h, `/v1/admin/admins/${target.id}/reset-totp`, {}, { token: o.accessToken })],
        ['admin.password_reset', () => admin(h, `/v1/admin/admins/${target.id}/reset-password`, {}, { token: o.accessToken })],
      ];
      for (const [action, run] of cases) {
        await refuseAudit(db, action);
        const response = await run();
        expect(response.statusCode, action).toBe(500);
        expect(await account(target.id), action).toEqual(before);
        expect(await auditCount(db, action, target.id), action).toBe(0);
      }
      expect(await rows(db, `SELECT 1 FROM admin_users WHERE email = 'rolled.back@example.com'`)).toHaveLength(0);

      await db.sql.query(`UPDATE admin_users SET disabled_at = now() WHERE id = $1`, [target.id]);
      await refuseAudit(db, 'admin.enable');
      expect((await admin(h, `/v1/admin/admins/${target.id}/enable`, {}, { token: o.accessToken })).statusCode).toBe(500);
      expect((await account(target.id)).disabled).toBe(true);
      await refuseAudit(db);
      expect((await admin(h, `/v1/admin/admins/${target.id}/enable`, {}, { token: o.accessToken })).statusCode).toBe(200);

      // Sign-in: no session without its audit row, no enrolment without its own.
      const fresh = await seedAdmin(h, { totp: 'none' });
      const login = await admin(h, '/v1/admin/auth/login', { email: fresh.email, password: fresh.password }, { ip });
      const { mfaToken } = login.json<{ mfaToken: string }>();
      await refuseAudit(db, 'admin.totp_issue');
      expect((await admin(h, '/v1/admin/auth/totp/enroll', { mfaToken }, { ip })).statusCode).toBe(500);
      expect((await row<{ s: Buffer | null }>(db, `SELECT totp_secret_enc AS s FROM admin_users WHERE id = $1`, [fresh.id])).s).toBeNull();
      await refuseAudit(db);
      const secret = base32Decode(adminTotpEnrollmentSchema.parse((await admin(h, '/v1/admin/auth/totp/enroll', { mfaToken }, { ip })).json()).secret);
      for (const action of ['admin.totp_enroll', 'admin.login']) {
        await refuseAudit(db, action);
        h.tick();
        expect((await admin(h, '/v1/admin/auth/totp/confirm', { mfaToken, code: code(h, secret) }, { ip })).statusCode, action).toBe(500);
        const state = await row<{ totp: boolean; step: string | null; sessions: number }>(
          db,
          `SELECT totp_enabled_at IS NOT NULL AS totp, totp_last_step::text AS step, (SELECT count(*)::integer FROM admin_sessions WHERE admin_id = $1) AS sessions FROM admin_users WHERE id = $1`,
          [fresh.id],
        );
        expect(state, action).toEqual({ totp: false, step: null, sessions: 0 });
      }
      await refuseAudit(db);

      // The signed-in admin's own writes.
      const self = await seedAdmin(h, { roles: ['support'] });
      const mine = await signIn(h, self, ip);
      const other = await signIn(h, self, ip);
      const ownBefore = await account(self.id);
      const ownCases: [action: string, run: () => Promise<{ statusCode: number }>][] = [
        ['admin.password_change', () => admin(h, '/v1/admin/me/password', { currentPassword: self.password, newPassword: 'a brand new password' }, { token: mine.accessToken, method: 'PUT' })],
        ['admin.session_revoke', () => admin(h, `/v1/admin/me/sessions/${other.sessionId}`, undefined, { token: mine.accessToken, method: 'DELETE' })],
        ['admin.logout', () => admin(h, '/v1/admin/auth/logout', {}, { cookie: mine.cookie, ip })],
        ['admin.logout_all', () => admin(h, '/v1/admin/auth/logout', { all: true }, { cookie: mine.cookie, ip })],
      ];
      for (const [action, run] of ownCases) {
        await refuseAudit(db, action);
        expect((await run()).statusCode, action).toBe(500);
        expect(await account(self.id), action).toEqual(ownBefore);
      }
      await refuseAudit(db);
      expect((await admin(h, '/v1/admin/me', undefined, { token: mine.accessToken })).statusCode).toBe(200);
      expect((await admin(h, '/v1/admin/me', undefined, { token: other.accessToken })).statusCode).toBe(200);

      // And each of them, allowed, leaves exactly its row.
      expect((await ownCases[0]![1]()).statusCode).toBe(204);
      expect(await auditCount(db, 'admin.password_change', self.id)).toBe(1);
      expect((await admin(h, '/v1/admin/me', undefined, { token: other.accessToken })).statusCode).toBe(401);
      expect((await admin(h, '/v1/admin/me', undefined, { token: mine.accessToken })).statusCode).toBe(200);
    });

    it('refuses a write that records no audit row', async () => {
      const { auditedTransaction, UnauditedWriteError } = await import('../src/admin/audit.js');
      const app = h.app as unknown as FastifyInstance;
      const owner = await seedAdmin(h);
      await expect(
        auditedTransaction(app, { adminId: null, sessionId: null, ip: null }, async (tx) => {
          await tx.query(`UPDATE admin_users SET display_name = 'Unaudited' WHERE id = $1`, [owner.id]);
        }),
      ).rejects.toBeInstanceOf(UnauditedWriteError);
      expect((await row<{ display_name: string }>(db, `SELECT display_name FROM admin_users WHERE id = $1`, [owner.id])).display_name).not.toBe('Unaudited');
      // With its row, the same change commits, both together.
      await auditedTransaction(app, { adminId: owner.id, sessionId: null, ip: '203.0.113.5' }, async (tx, trail) => {
        await tx.query(`UPDATE admin_users SET display_name = 'Audited' WHERE id = $1`, [owner.id]);
        trail.record({ action: 'admin.update', target: 'admin', targetId: owner.id, detail: { after: { displayName: 'Audited' } } });
      });
      const audit = await row<{ admin_id: number; ip: string; detail: unknown }>(db, `SELECT admin_id, host(ip) AS ip, detail FROM audit_log WHERE action = 'admin.update' AND target_id = $1`, [owner.id]);
      expect(audit).toEqual({ admin_id: owner.id, ip: '203.0.113.5', detail: { after: { displayName: 'Audited' } } });
    });
  });

  it('changes the own password: the current one must be right, the policy holds, the other sessions end', async () => {
    const ip = freshIp();
    const account = await seedAdmin(h, { roles: ['analyst'] });
    const mine = await signIn(h, account, ip);
    const other = await signIn(h, account, ip);
    const wrong = await admin(h, '/v1/admin/me/password', { currentPassword: 'not it at all', newPassword: 'a brand new password' }, { token: mine.accessToken, method: 'PUT' });
    expect(wrong.json()).toMatchObject({ code: 'field_invalid', errors: [{ pointer: '/currentPassword' }] });
    const weak = await admin(h, '/v1/admin/me/password', { currentPassword: account.password, newPassword: 'short' }, { token: mine.accessToken, method: 'PUT' });
    expect(weak.json()).toMatchObject({ code: 'field_invalid', errors: [{ pointer: '/newPassword', code: 'too_short' }] });
    const changed = await admin(h, '/v1/admin/me/password', { currentPassword: account.password, newPassword: 'a brand new password' }, { token: mine.accessToken, method: 'PUT' });
    expect(changed.statusCode).toBe(204);
    expect((await admin(h, '/v1/admin/me', undefined, { token: other.accessToken })).statusCode).toBe(401);
    expect((await admin(h, '/v1/admin/me', undefined, { token: mine.accessToken })).statusCode).toBe(200);
    expect((await admin(h, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip })).statusCode).toBe(401);
    expect((await admin(h, '/v1/admin/auth/login', { email: account.email, password: 'a brand new password' }, { ip })).statusCode).toBe(200);
  });

  it('refuses admin tokens while the deny list cannot be read (fails closed), and app tokens go on', async () => {
    const account = await seedAdmin(h);
    const session = await signIn(h, account, freshIp());
    const original = h.app.denyList.check.bind(h.app.denyList);
    h.app.denyList.check = async () => {
      throw new Error('valkey down');
    };
    try {
      expect((await admin(h, '/v1/admin/me', undefined, { token: session.accessToken })).statusCode).toBe(401);
    } finally {
      h.app.denyList.check = original;
    }
    expect((await admin(h, '/v1/admin/me', undefined, { token: session.accessToken })).statusCode).toBe(200);
  });
});
