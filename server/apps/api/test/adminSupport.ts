import { randomBytes } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import type { DataSealer } from '@app/shared/server';
import type { AppDependencies } from '../src/app.js';
import { hashPassword, type Argon2Params } from '../src/admin/password.js';
import { TOTP_SECRET_PURPOSE, generateTotpSecret, totpAt } from '../src/admin/totp.js';
import { ADMIN_REFRESH_COOKIE } from '../src/admin/session.js';
import { row, startHarness, type Harness, type TestDatabase } from './accountSupport.js';
import { ADMIN_ORIGIN } from './support.js';

/**
 * Admin sign-in suites: the app with cheap Argon2 parameters (the hash
 * format and checks are the real ones), a clock the TOTP check reads, and a
 * short refresh grace. Admins are seeded with SQL (a real hash, a sealed
 * secret) and sign in through the routes.
 */

export const CHEAP_ARGON2: Argon2Params = { memory: 1_024, passes: 1, parallelism: 1 };

export interface AdminHarness extends Harness {
  clock: { now: number };
  /** Moves the TOTP clock on by one 30-second step. */
  tick(steps?: number): void;
}

/** The suites sign in far more often than an hour of real use: the limit across addresses is tested with its own harness. */
export const TEST_LOGIN_LIMIT = { cap: 1_000_000, windowMs: 60_000 };

export async function startAdminHarness(db: TestDatabase, env: Record<string, string | undefined> = {}, deps: AppDependencies = {}): Promise<AdminHarness> {
  const clock = { now: Date.now() };
  const h = await startHarness(db, env, {
    ...deps,
    adminAuth: { argon2: CHEAP_ARGON2, loginLimit: TEST_LOGIN_LIMIT, now: () => clock.now, ...deps.adminAuth },
    authServices: { refreshGraceMs: 300 },
  });
  for (let i = 0; i < 300 && h.app.adminAuth.roles.current() === null; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  if (h.app.adminAuth.roles.current() === null) throw new Error('the admin roles did not load');
  return {
    ...h,
    clock,
    tick(steps = 1) {
      clock.now += steps * 30_000;
    },
  };
}

export interface SeededAdmin {
  id: number;
  email: string;
  password: string;
  /** The TOTP secret (raw), when one is enrolled or pending. */
  secret: Buffer | null;
}

let counter = 0;

export function sealerOf(h: Harness): DataSealer {
  return h.app.secrets.sealer;
}

/** An admin with these roles; `totp`: enrolled (default), `pending` (a secret waiting for its first code) or `none`. */
export async function seedAdmin(
  h: AdminHarness,
  options: { roles?: string[]; totp?: 'enrolled' | 'pending' | 'none'; password?: string; email?: string; argon2?: Argon2Params } = {},
): Promise<SeededAdmin> {
  counter += 1;
  const email = options.email ?? `admin-${counter}-${randomBytes(3).toString('hex')}@example.com`;
  const password = options.password ?? `correct horse ${counter} battery`;
  const totp = options.totp ?? 'enrolled';
  const secret = totp === 'none' ? null : generateTotpSecret();
  const sealed = secret ? sealerOf(h).seal(secret, TOTP_SECRET_PURPOSE) : null;
  const hash = await hashPassword(password, options.argon2 ?? CHEAP_ARGON2);
  const created = await row<{ id: number }>(
    h.db,
    `INSERT INTO admin_users (email, display_name, password_hash, totp_secret_enc, totp_enabled_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END) RETURNING id`,
    [email, `Admin ${counter}`, hash, sealed, totp === 'enrolled'],
  );
  for (const role of options.roles ?? ['superadmin']) {
    await h.db.sql.query(`INSERT INTO admin_user_roles (admin_id, role_id) SELECT $1, id FROM admin_roles WHERE key = $2`, [created.id, role]);
  }
  return { id: Number(created.id), email, password, secret };
}

export interface PostOptions {
  token?: string | undefined;
  cookie?: string | undefined;
  origin?: string | null | undefined;
  ip?: string | undefined;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
}

/** A request as the panel sends it (its Origin, the bearer token, the refresh cookie). */
export async function admin(h: Harness, url: string, body?: unknown, options: PostOptions = {}): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = {};
  if (options.origin !== null) headers['origin'] = options.origin ?? ADMIN_ORIGIN;
  if (options.token) headers['authorization'] = `Bearer ${options.token}`;
  if (options.cookie) headers['cookie'] = `${ADMIN_REFRESH_COOKIE}=${options.cookie}`;
  return h.app.inject({
    method: options.method ?? (body === undefined ? 'GET' : 'POST'),
    url,
    headers,
    remoteAddress: options.ip ?? '127.0.0.1',
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
}

/** The refresh cookie a response set: its value and attributes. */
export function setCookie(response: LightMyRequestResponse): { value: string; attributes: string[] } | null {
  const header = response.headers['set-cookie'];
  const line = Array.isArray(header) ? header[0] : header;
  if (typeof line !== 'string') return null;
  const [pair, ...attributes] = line.split(';').map((part) => part.trim());
  const [name, value] = (pair ?? '').split('=');
  if (name !== ADMIN_REFRESH_COOKIE) return null;
  return { value: value ?? '', attributes };
}

export function code(h: AdminHarness, secret: Buffer): string {
  return totpAt(secret, h.clock.now);
}

export interface SignedIn {
  accessToken: string;
  cookie: string;
  sessionId: string;
}

/** Password, then a fresh code (the clock moves one step first, so codes never repeat). */
export async function signIn(h: AdminHarness, account: SeededAdmin, ip?: string): Promise<SignedIn> {
  const login = await admin(h, '/v1/admin/auth/login', { email: account.email, password: account.password }, { ip });
  if (login.statusCode !== 200) throw new Error(`login ${login.statusCode}: ${login.body}`);
  const { mfaToken, enrollRequired } = login.json<{ mfaToken: string; enrollRequired: boolean }>();
  if (!account.secret) throw new Error('the admin has no TOTP secret');
  h.tick();
  const second = await admin(h, enrollRequired ? '/v1/admin/auth/totp/confirm' : '/v1/admin/auth/totp', { mfaToken, code: code(h, account.secret) }, { ip });
  if (second.statusCode !== 200) throw new Error(`totp ${second.statusCode}: ${second.body}`);
  const cookie = setCookie(second);
  if (!cookie) throw new Error('no refresh cookie');
  const accessToken = second.json<{ accessToken: string }>().accessToken;
  const sessionId = cookie.value.split('.')[1] ?? '';
  return { accessToken, cookie: cookie.value, sessionId };
}

/** A problem answer without the parts that differ per request. */
export function stableProblem(response: LightMyRequestResponse): unknown {
  const body = response.json<Record<string, unknown>>();
  const { requestId: _requestId, instance: _instance, ...rest } = body;
  return { status: response.statusCode, ...rest };
}

/** Makes inserts of audit rows with `action` fail (the route's transaction must roll back with it). */
export async function installAuditFailure(db: TestDatabase): Promise<void> {
  await db.sql.query(`CREATE TABLE IF NOT EXISTS test_audit_refused (action text PRIMARY KEY)`);
  await db.sql.query(`CREATE OR REPLACE FUNCTION test_audit_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM test_audit_refused r WHERE r.action = NEW.action) THEN
        RAISE EXCEPTION 'audit row refused by the test';
      END IF;
      RETURN NEW;
    END $$`);
  await db.sql.query(`DROP TRIGGER IF EXISTS test_audit_refuse ON audit_log`);
  await db.sql.query(`CREATE TRIGGER test_audit_refuse BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_audit_refuse()`);
}

export async function refuseAudit(db: TestDatabase, ...actions: string[]): Promise<void> {
  await db.sql.query(`DELETE FROM test_audit_refused`);
  for (const action of actions) await db.sql.query(`INSERT INTO test_audit_refused (action) VALUES ($1)`, [action]);
}

export async function auditCount(db: TestDatabase, action: string, targetId: number): Promise<number> {
  const result = await row<{ n: number }>(db, `SELECT count(*)::integer AS n FROM audit_log WHERE action = $1 AND target_type = 7 AND target_id = $2`, [action, targetId]);
  return result.n;
}
