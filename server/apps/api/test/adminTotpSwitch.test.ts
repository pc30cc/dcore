import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from '@app/config';
import {
  adminAccessTokenSchema,
  adminLoginResultSchema,
  adminLoginSessionSchema,
  adminLoginTicketSchema,
  adminMeSchema,
  adminSessionListSchema,
  adminTotpEnrollmentSchema,
  problemSchemaFor,
} from '@app/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode } from '../src/admin/totp.js';
import { createAccessTokens } from '../src/auth/tokens.js';
import { migratedDatabase, row, rows, type TestDatabase } from './accountSupport.js';
import {
  admin,
  code,
  installAuditFailure,
  lastAudit,
  refuseAudit,
  seedAdmin,
  setCookie,
  signIn,
  stableProblem,
  startAdminHarness,
  type AdminHarness,
} from './adminSupport.js';
import { statements } from './authSupport.js';
import { DEPLOY, composeEnv } from './deploySupport.js';
import { hasInfrastructure, testConfig, testSecret } from './support.js';

/**
 * ADMIN_TOTP_REQUIRED: on (the default) admin sign-in is as it always was;
 * off, the password step completes the sign-in. Both states against one
 * database, side by side (two API instances, one with the switch off), so
 * a session opened while it is off can be presented once it is on again.
 */

const WARNING = 'admin: ADMIN_TOTP_REQUIRED=false';

describe('the ADMIN_TOTP_REQUIRED setting', () => {
  it('requires TOTP unless it is turned off', () => {
    expect(testConfig().admin.totpRequired).toBe(true);
    expect(testConfig({ ADMIN_TOTP_REQUIRED: 'true' }).admin.totpRequired).toBe(true);
    expect(testConfig({ ADMIN_TOTP_REQUIRED: '' }).admin.totpRequired).toBe(true);
    for (const off of ['false', 'FALSE', '0', 'no', 'off']) expect(testConfig({ ADMIN_TOTP_REQUIRED: off }).admin.totpRequired, off).toBe(false);
    // It is allowed in production (test stacks run as production), and only a boolean is taken.
    const production = {
      NODE_ENV: 'production',
      BRAND: 'live',
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
      LOG_LEVEL: 'info',
    };
    expect(testConfig(production).admin.totpRequired).toBe(true);
    expect(testConfig({ ...production, ADMIN_TOTP_REQUIRED: 'false' }).admin.totpRequired).toBe(false);
    let thrown: unknown;
    try {
      testConfig({ ADMIN_TOTP_REQUIRED: 'sometimes' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).issues.map((issue) => issue.variable)).toEqual(['ADMIN_TOTP_REQUIRED']);
  });

  it('stays on in the shared deploy files: the compose default and .env.example (a test stack turns it off in its own variables)', () => {
    expect(composeEnv('api')['ADMIN_TOTP_REQUIRED']).toBe('${ADMIN_TOTP_REQUIRED:-true}');
    for (const file of [join(DEPLOY, 'coolify/.env.example'), new URL('../.env.example', import.meta.url)]) {
      const lines = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => /^\s*(export\s+)?ADMIN_TOTP_REQUIRED\s*=/.test(line));
      expect(lines, String(file)).toEqual(['ADMIN_TOTP_REQUIRED=true']);
    }
  });

  it('says in each admin token whether a second factor opened its session', async () => {
    const tokens = await createAccessTokens(testConfig().auth);
    const verified = async (input: Parameters<typeof tokens.issue>[0]) => tokens.verify((await tokens.issue(input)).token);
    expect((await verified({ kind: 'admin', subject: '1', sessionId: '5', roles: ['superadmin'] })).mfa).toBe(true);
    expect((await verified({ kind: 'admin', subject: '1', sessionId: '5', roles: ['superadmin'], mfa: true })).mfa).toBe(true);
    expect((await verified({ kind: 'admin', subject: '1', sessionId: '5', roles: ['superadmin'], mfa: false })).mfa).toBe(false);
    expect((await verified({ kind: 'app', subject: 'abcdefghijklm', sessionId: '5' })).mfa).toBeUndefined();
  });
});

let ipSeq = 0;
/** A fresh client address per test, so the per-IP limits of one test never touch another. */
function freshIp(): string {
  ipSeq += 1;
  return `10.77.${ipSeq % 250}.${Math.floor(ipSeq / 250) + 9}`;
}

/** A hash that takes a while to check (a few hundred milliseconds), so a test can act while it runs. */
const SLOW_ARGON2 = { memory: 65_536, passes: 6, parallelism: 1 };

describe.skipIf(!hasInfrastructure)('admin sign-in with ADMIN_TOTP_REQUIRED', () => {
  let db: TestDatabase;
  /** The switch on (the default). */
  let on: AdminHarness;
  /** The switch off. */
  let off: AdminHarness;

  // One deployment seen by two instances: the same signing and sealing keys, so a token or cookie of one is valid at the other.
  const keys = { AUTH_JWT_SECRET: testSecret(), DATA_KEYS: JSON.stringify({ 1: testSecret() }), HASH_PEPPERS: JSON.stringify({ 1: testSecret() }) };

  beforeAll(async () => {
    db = await migratedDatabase();
    await installAuditFailure(db);
    on = await startAdminHarness(db, keys);
    off = await startAdminHarness(db, { ...keys, ADMIN_TOTP_REQUIRED: 'false' });
  }, 60_000);
  afterEach(async () => {
    await refuseAudit(db);
  });
  afterAll(async () => {
    await on?.close();
    await off?.close();
    await db?.drop();
  });

  /** Until the gate of `h`'s process runs (or waits for) `count` hashes. */
  async function gateHolds(h: AdminHarness, count: number): Promise<void> {
    for (let i = 0; i < 400; i += 1) {
      const load = h.app.adminAuth.passwords.gate.load;
      if (load.running + load.waiting >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`the hash gate never held ${count} hashes`);
  }

  const sessionRow = (id: string) =>
    row<{ mfa: boolean; live: boolean; revoked_at: Date | null }>(db, `SELECT mfa, expires_at > now() AS live, revoked_at FROM admin_sessions WHERE id = $1`, [id]);

  it('warns once at start while the switch is off, and not otherwise', () => {
    const warnings = (h: AdminHarness) => h.logs.filter((line) => line.includes(WARNING));
    expect(warnings(off)).toHaveLength(1);
    expect(JSON.parse(warnings(off)[0]!)).toMatchObject({ level: 40, adminTotpRequired: false });
    expect(warnings(on)).toHaveLength(0);
  });

  it('signs in with the password alone: the session answer, the refresh cookie as the code step sets it, mfa false everywhere', async () => {
    const account = await seedAdmin(off);
    const ip = freshIp();
    const login = await admin(off, '/v1/admin/auth/login', { email: account.email.toUpperCase(), password: account.password }, { ip });
    expect(login.statusCode).toBe(200);
    expect(statements(login)).toBeLessThanOrEqual(3);
    const result = adminLoginResultSchema.parse(login.json());
    // The sign-in is complete, and an admin with TOTP gets no ticket: there is no code step to take.
    expect(Object.keys(login.json<object>()).sort()).toEqual(['enrollRequired', 'session']);
    expect(result.enrollRequired).toBe(false);
    const session = adminAccessTokenSchema.parse(result.session);
    const expiresIn = Date.parse(session.expiresAt) - Date.now();
    expect(expiresIn).toBeGreaterThan(590_000);
    expect(expiresIn).toBeLessThanOrEqual(600_000);

    const cookie = setCookie(login);
    expect(cookie?.value).toMatch(/^ar1\.[1-9][0-9]*\.[A-Za-z0-9_-]{43}$/);
    expect(cookie?.attributes).toEqual(expect.arrayContaining(['Path=/v1/admin/auth', 'HttpOnly', 'Secure', 'SameSite=Strict']));
    const maxAge = Number(cookie?.attributes.find((a) => a.startsWith('Max-Age='))?.slice(8));
    expect(maxAge).toBeGreaterThan(12 * 3_600 - 60);
    expect(maxAge).toBeLessThanOrEqual(12 * 3_600);
    const sessionId = cookie!.value.split('.')[1]!;

    const me = adminMeSchema.parse((await admin(off, '/v1/admin/me', undefined, { token: session.accessToken })).json());
    expect(me).toMatchObject({ id: String(account.id), sessionId, totpRequired: false, totpEnabled: true, roles: ['superadmin'] });
    expect((await admin(off, '/v1/admin/admins', undefined, { token: session.accessToken })).statusCode).toBe(200);
    expect((await off.app.tokens.verify(session.accessToken)).mfa).toBe(false);

    // Marked on the session, in the session list and in the audit row of the sign-in.
    expect(await sessionRow(sessionId)).toMatchObject({ mfa: false, live: true, revoked_at: null });
    const list = adminSessionListSchema.parse((await admin(off, '/v1/admin/me/sessions', undefined, { token: session.accessToken })).json());
    expect(list.items).toEqual([expect.objectContaining({ id: sessionId, current: true, mfa: false })]);
    const audit = await lastAudit(db, { action: 'admin.login', targetType: 7, targetId: account.id });
    expect(audit).toMatchObject({ admin_id: account.id, session_id: sessionId, detail: { sessionId, mfa: false } });
    // A full sign-in: the account's counters as a code would leave them.
    expect(await row(db, `SELECT failed_logins, locked_until, last_login_at IS NOT NULL AS seen FROM admin_users WHERE id = $1`, [account.id])).toEqual({
      failed_logins: 0,
      locked_until: null,
      seen: true,
    });

    // The cookie refreshes like any other, and its access tokens still say no second factor.
    const refreshed = await admin(off, '/v1/admin/auth/refresh', {}, { cookie: cookie!.value, ip });
    expect(refreshed.statusCode).toBe(200);
    expect(statements(refreshed)).toBeLessThanOrEqual(1);
    const fresh = adminAccessTokenSchema.parse(refreshed.json()).accessToken;
    expect((await off.app.tokens.verify(fresh)).mfa).toBe(false);
    expect((await admin(off, '/v1/admin/me', undefined, { token: fresh })).statusCode).toBe(200);
  });

  it('asks an admin without TOTP for no enrolment, and still lets one enrol with the ticket', async () => {
    const account = await seedAdmin(off, { totp: 'none' });
    const ip = freshIp();
    const login = await admin(off, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip });
    expect(login.statusCode).toBe(200);
    const result = adminLoginTicketSchema.parse(login.json());
    expect(result.enrollRequired).toBe(true);
    const token = result.session!.accessToken;
    expect((await admin(off, '/v1/admin/me', undefined, { token })).json()).toMatchObject({ totpEnabled: false, totpRequired: false });
    // Not enrolled, the session refreshes all the same.
    const refreshed = await admin(off, '/v1/admin/auth/refresh', {}, { cookie: setCookie(login)!.value, ip });
    expect(refreshed.statusCode).toBe(200);

    // The TOTP routes keep working: the ticket enrols, and that sign-in is one with a second factor.
    const enrolment = adminTotpEnrollmentSchema.parse((await admin(off, '/v1/admin/auth/totp/enroll', { mfaToken: result.mfaToken }, { ip })).json());
    const secret = base32Decode(enrolment.secret);
    off.tick();
    const confirm = await admin(off, '/v1/admin/auth/totp/confirm', { mfaToken: result.mfaToken, code: code(off, secret) }, { ip });
    expect(confirm.statusCode).toBe(200);
    const withCode = adminAccessTokenSchema.parse(confirm.json()).accessToken;
    expect((await off.app.tokens.verify(withCode)).mfa).toBe(true);
    const sid = setCookie(confirm)!.value.split('.')[1]!;
    expect((await sessionRow(sid)).mfa).toBe(true);
    expect((await lastAudit(db, { action: 'admin.login', targetType: 7, targetId: account.id }))?.detail).toEqual({ sessionId: sid, enrolled: true, mfa: true });
  });

  it('gives an admin with TOTP no code ticket, so the sign-in that clears the failure count leaves no codes to guess', async () => {
    const account = await seedAdmin(off);
    const ip = freshIp();
    // Each password sign-in clears the count; with a ticket next to it, wrong codes spread over sign-ins would never lock the account.
    for (let round = 0; round < 3; round += 1) {
      const login = await admin(off, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip });
      expect(login.statusCode, `round ${round}`).toBe(200);
      const answer = login.json<Record<string, unknown>>();
      expect(answer, `round ${round}`).not.toHaveProperty('mfaToken');
      expect(answer, `round ${round}`).not.toHaveProperty('expiresAt');
      expect(adminLoginSessionSchema.parse(answer).enrollRequired).toBe(false);
      expect((await off.app.tokens.verify(adminLoginSessionSchema.parse(answer).session.accessToken)).mfa).toBe(false);
    }
    // No session a code opened came of it: every one of them ends once TOTP is required again.
    expect(await rows(db, `SELECT mfa FROM admin_sessions WHERE admin_id = $1`, [account.id])).toEqual([{ mfa: false }, { mfa: false }, { mfa: false }]);

    // Where TOTP is required the ticket and its count are as they always were: wrong codes add up across password sign-ins and lock.
    for (let round = 0; round < 2; round += 1) {
      const login = await admin(on, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip });
      const { mfaToken } = adminLoginTicketSchema.parse(login.json());
      for (let i = 0; i < (round === 0 ? 3 : 2); i += 1) {
        const wrong = String((Number(code(on, account.secret!)) + 7 + i) % 1_000_000).padStart(6, '0');
        await admin(on, '/v1/admin/auth/totp', { mfaToken, code: wrong }, { ip });
      }
    }
    expect(await row(db, `SELECT locked_until > now() AS locked FROM admin_users WHERE id = $1`, [account.id])).toEqual({ locked: true });
  });

  it('keeps every protection of the password step: the same refusals at the same cost, the lockout, disabled and locked accounts, the origin', async () => {
    const ip = freshIp();
    const account = await seedAdmin(off);
    const disabled = await seedAdmin(off);
    await db.sql.query(`UPDATE admin_users SET disabled_at = now() WHERE id = $1`, [disabled.id]);
    const locked = await seedAdmin(off);
    await db.sql.query(`UPDATE admin_users SET locked_until = now() + interval '10 minutes' WHERE id = $1`, [locked.id]);
    const attempts = [
      { email: 'nobody-here@example.com', password: 'whatever whatever' },
      { email: account.email, password: 'not the password at all' },
      { email: disabled.email, password: disabled.password },
      { email: locked.email, password: locked.password },
      { email: 'not an address', password: 'x' },
    ];
    // The answer the default sign-in gives an unknown e-mail: every refusal here reads the same.
    const reference = stableProblem(await admin(on, '/v1/admin/auth/login', attempts[0], { ip: freshIp() }));
    for (const attempt of attempts) {
      const response = await admin(off, '/v1/admin/auth/login', attempt, { ip });
      expect(response.statusCode, attempt.email).toBe(401);
      expect(statements(response), attempt.email).toBe(2);
      expect(setCookie(response), attempt.email).toBeNull();
      problemSchemaFor('unauthorized').parse(response.json());
      expect(stableProblem(response), attempt.email).toEqual(reference);
    }
    expect(await rows(db, `SELECT 1 FROM admin_sessions WHERE admin_id = ANY($1::integer[])`, [[account.id, disabled.id, locked.id]])).toHaveLength(0);

    // Five wrong passwords lock the account; the right one is then refused the same way and opens nothing.
    for (let i = 1; i < 5; i += 1) await admin(off, '/v1/admin/auth/login', { email: account.email, password: `wrong password ${i}` }, { ip });
    const lock = await row<{ minutes: number }>(db, `SELECT (extract(epoch FROM locked_until - now()) / 60)::float8 AS minutes FROM admin_users WHERE id = $1`, [account.id]);
    expect(lock.minutes).toBeGreaterThan(14.9);
    const right = await admin(off, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip });
    expect(right.statusCode).toBe(401);
    expect(stableProblem(right)).toEqual(reference);
    expect(setCookie(right)).toBeNull();
    expect(await rows(db, `SELECT 1 FROM admin_sessions WHERE admin_id = $1`, [account.id])).toHaveLength(0);
    // Once the lock is over the password signs in, and the sign-in clears the count.
    await db.sql.query(`UPDATE admin_users SET locked_until = now() - interval '1 second', failed_logins = 3 WHERE id = $1`, [account.id]);
    const open = await admin(off, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip });
    expect(open.statusCode).toBe(200);
    expect(await row(db, `SELECT failed_logins, locked_until FROM admin_users WHERE id = $1`, [account.id])).toEqual({ failed_logins: 0, locked_until: null });

    // A page of another origin gets nothing, the password right or not.
    const evil = await admin(off, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip, origin: 'https://evil.example.net' });
    expect(evil.statusCode).toBe(403);
    expect(setCookie(evil)).toBeNull();
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('decides on the account as it is after the hash: a lock or a new password written meanwhile refuses the sign-in', async () => {
    const ip = freshIp();
    const account = await seedAdmin(off, { argon2: SLOW_ARGON2 });
    const pending = admin(off, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip });
    await gateHolds(off, 1);
    await db.sql.query(`UPDATE admin_users SET locked_until = now() + interval '15 minutes', failed_logins = 0 WHERE id = $1`, [account.id]);
    const late = await pending;
    expect(late.statusCode).toBe(401);
    expect(setCookie(late)).toBeNull();

    await db.sql.query(`UPDATE admin_users SET locked_until = NULL WHERE id = $1`, [account.id]);
    const racing = admin(off, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip });
    await gateHolds(off, 1);
    // Reset by someone else while the old password was being checked.
    await db.sql.query(`UPDATE admin_users SET password_hash = $2 WHERE id = $1`, [account.id, '$argon2id$v=19$m=1024,t=1,p=1$c29tZXNhbHRzb21lc2FsdA$c29tZXRhZ3NvbWV0YWdzb21ldGFnc29tZXRhZzA']);
    const changed = await racing;
    expect(changed.statusCode).toBe(401);
    expect(await rows(db, `SELECT 1 FROM admin_sessions WHERE admin_id = $1`, [account.id])).toHaveLength(0);
    expect(await row(db, `SELECT count(*)::integer AS n FROM audit_log WHERE action = 'admin.login' AND target_id = $1`, [account.id])).toEqual({ n: 0 });
  });

  it('hashes through the same gate, and limits logins from every address together, failing closed', async () => {
    // Slow hashes of the current parameters (no rehash), one at a time and one waiting.
    const gated = await startAdminHarness(
      db,
      { ADMIN_TOTP_REQUIRED: 'false' },
      { adminAuth: { argon2: SLOW_ARGON2, hashGate: { concurrency: 1, queue: 1 }, loginLimit: { cap: 8, windowMs: 60_000 } } },
    );
    try {
      const account = await seedAdmin(gated, { argon2: SLOW_ARGON2 });
      const answers = await Promise.all(
        Array.from({ length: 6 }, () => admin(gated, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip: freshIp() })),
      );
      const busy = answers.filter((a) => a.statusCode === 503);
      expect(busy.length).toBeGreaterThan(0);
      for (const answer of busy) {
        expect(answer.headers['retry-after']).toBe('5');
        expect(setCookie(answer)).toBeNull();
      }
      expect(answers.every((a) => a.statusCode === 200 || a.statusCode === 503)).toBe(true);
      expect(answers.some((a) => a.statusCode === 200)).toBe(true);
      expect(gated.app.adminAuth.passwords.gate.load).toEqual({ running: 0, waiting: 0 });

      // Two more of the window's 8, then every address is refused before any hash or statement.
      for (let i = 0; i < 2; i += 1) {
        expect((await admin(gated, '/v1/admin/auth/login', { email: `all-${i}@example.com`, password: 'no such account here' }, { ip: freshIp() })).statusCode).toBe(401);
      }
      const refused = await admin(gated, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip: freshIp() });
      expect(refused.statusCode).toBe(429);
      expect(statements(refused)).toBe(0);
      expect(setCookie(refused)).toBeNull();
    } finally {
      await gated.close();
    }
  });

  it('with TOTP required again: such a session is refused at once, its refresh ends it for good, and sign-in asks for a code', async () => {
    const ip = freshIp();
    const account = await seedAdmin(on);
    const login = await admin(off, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip });
    const token = adminLoginResultSchema.parse(login.json()).session!.accessToken;
    const cookie = setCookie(login)!.value;
    const sid = cookie.split('.')[1]!;
    expect((await admin(off, '/v1/admin/me', undefined, { token })).statusCode).toBe(200);

    // The same token, where TOTP is required: no access, at once (for that alone: the same session with a code's token gets in).
    const refusedNow = await admin(on, '/v1/admin/me', undefined, { token });
    expect(refusedNow.statusCode).toBe(401);
    expect(refusedNow.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    expect((await admin(on, '/v1/admin/admins', undefined, { token })).statusCode).toBe(401);
    const asIf = async (mfa: boolean) =>
      (await on.app.tokens.issue({ kind: 'admin', subject: String(account.id), sessionId: sid, roles: ['superadmin'], mfa, ttlSeconds: 60 })).token;
    expect((await admin(on, '/v1/admin/me', undefined, { token: await asIf(true) })).statusCode).toBe(200);
    expect((await admin(on, '/v1/admin/me', undefined, { token: await asIf(false) })).statusCode).toBe(401);
    // Its refresh ends the session: the cookie is cleared and never works again, whichever way the switch is next.
    const ended = await admin(on, '/v1/admin/auth/refresh', {}, { cookie, ip });
    expect(ended.statusCode).toBe(401);
    expect(ended.json()).toMatchObject({ code: 'refresh_invalid' });
    expect(setCookie(ended)?.attributes).toContain('Max-Age=0');
    expect(statements(ended)).toBe(1);
    expect(await sessionRow(sid)).toMatchObject({ mfa: false, live: false, revoked_at: null });
    expect((await admin(off, '/v1/admin/auth/refresh', {}, { cookie, ip })).statusCode).toBe(401);
    expect((await admin(on, '/v1/admin/me/sessions', undefined, { token: (await signIn(on, account, ip)).accessToken })).json<{ items: { id: string }[] }>().items.map((s) => s.id)).not.toContain(sid);

    // The token the session replaced ends it too (not a reuse: nothing else of the admin is touched).
    const second = await admin(off, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip });
    const first = setCookie(second)!.value;
    const rotated = setCookie(await admin(off, '/v1/admin/auth/refresh', {}, { cookie: first, ip }))!.value;
    const sid2 = first.split('.')[1]!;
    await new Promise((resolve) => setTimeout(resolve, 350));
    await db.sql.query(`UPDATE admin_sessions SET refreshed_at = refreshed_at - interval '1 minute' WHERE id = $1`, [sid2]);
    const old = await admin(on, '/v1/admin/auth/refresh', {}, { cookie: first, ip });
    expect(old.json()).toMatchObject({ code: 'refresh_invalid' });
    expect(await sessionRow(sid2)).toMatchObject({ live: false, revoked_at: null });
    expect((await admin(on, '/v1/admin/auth/refresh', {}, { cookie: rotated, ip })).statusCode).toBe(401);

    // Sign-in where TOTP is required is as it always was: a ticket, no session, no cookie; then the code.
    const asked = await admin(on, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip });
    expect(asked.statusCode).toBe(200);
    expect(statements(asked)).toBeLessThanOrEqual(2);
    expect(asked.json()).not.toHaveProperty('session');
    expect(setCookie(asked)).toBeNull();
    const withCode = await signIn(on, account, ip);
    expect((await on.app.tokens.verify(withCode.accessToken)).mfa).toBe(true);
    expect((await admin(on, '/v1/admin/me', undefined, { token: withCode.accessToken })).json()).toMatchObject({ totpRequired: true });
    expect((await admin(on, '/v1/admin/auth/refresh', {}, { cookie: withCode.cookie, ip })).statusCode).toBe(200);
    expect((await lastAudit(db, { action: 'admin.login', targetType: 7, targetId: account.id }))?.detail).toMatchObject({ mfa: true });
    // A session a code opened goes on where TOTP is not required as well.
    expect((await admin(off, '/v1/admin/me', undefined, { token: withCode.accessToken })).statusCode).toBe(200);
  });

  it('opens no session without its audit row', async () => {
    const account = await seedAdmin(off);
    await refuseAudit(db, 'admin.login');
    const login = await admin(off, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip: freshIp() });
    expect(login.statusCode).toBe(500);
    expect(setCookie(login)).toBeNull();
    expect(await rows(db, `SELECT 1 FROM admin_sessions WHERE admin_id = $1`, [account.id])).toHaveLength(0);
    expect(await row(db, `SELECT last_login_at FROM admin_users WHERE id = $1`, [account.id])).toEqual({ last_login_at: null });
  });
});
