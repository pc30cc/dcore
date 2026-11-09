import { createHash, randomBytes } from 'node:crypto';
import {
  adminAcceptPassword,
  adminCredentials,
  adminLogoutByToken,
  adminMfaState,
  adminRecordFailure,
  adminRefresh,
  adminRevokeSessions,
  adminSetPendingTotp,
  adminSignIn,
  type LockPolicy,
} from '@app/db';
import { adminRevokeReason, wireTime, type AdminAccessToken, type AdminLoginResult, type AdminTotpEnrollment } from '@app/shared';
import type { Limit } from '@app/shared/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ipSegment } from '../auth/otp.js';
import { nextId } from '../auth/sessions.js';
import { HttpProblem } from '../lib/problem.js';
import { auditedTransaction, type AdminActor } from './audit.js';
import { TOTP_SECRET_PURPOSE, base32Encode, checkTotp, generateTotpSecret, otpauthUri } from './totp.js';

/**
 * Admin sign-in and sessions (docs/17 §3.17):
 *
 * 1. `login`: e-mail and password (Argon2id). Every refusal is the same 401
 *    in the same time (an unknown e-mail checks a dummy hash and sends the
 *    same one statement), so the answer never says whether an account
 *    exists, is disabled or is locked. Five failures (wrong passwords and
 *    wrong codes together) lock the account for 15 minutes; the counter is
 *    the row's (`failed_logins`, `locked_until`): it outlives a Valkey
 *    restart, a locked account counts nothing more, and only a full sign-in
 *    clears it, so knowing the password does not reset the code's count.
 *    A password that matched is accepted only by a statement run after the
 *    hash (enabled and not locked at that moment): guesses hashed in
 *    parallel cannot learn anything once their own failures locked the
 *    account. The answer is an `mfaToken` (Valkey, 5 minutes, single use).
 *    Every hash runs through the process's Argon2 gate (`hashing.ts`), and
 *    logins count against a limit across every address as well as their
 *    own address's.
 * 2. `totp` (or, without TOTP yet, `enroll` then `confirm`): the code must
 *    be of a step after the last one that signed in (no replay). Then the
 *    session opens in one transaction with its audit row.
 * 3. The access token (admin audience, `roles`, 10 minutes) is in the
 *    panel's memory; the refresh token is a cookie only the auth routes get
 *    (`Path=/v1/admin/auth`, HttpOnly, Secure, SameSite=Strict), rotated on
 *    every refresh. A rotated token used again after the 30-second grace
 *    revokes its session. Revoking a session (logout, an owner's action)
 *    also writes `deny:sid:<sid>` for an access token's lifetime: the
 *    access token stops at once, not only at its next refresh.
 *
 * Per-IP limits on login, codes and refresh fail closed: without Valkey
 * there is no admin sign-in (503).
 */

export const ADMIN_REFRESH_COOKIE = '__Secure-admin_refresh';
export const ADMIN_AUTH_PATH = '/v1/admin/auth';

export const LOCK_POLICY: LockPolicy = { maxFailures: 5, lockSeconds: 15 * 60 };
export const MFA_TTL_SECONDS = 300;
const GRACE_PURPOSE = 'admin.refresh_grace';

const LOGIN_IP_LIMIT = { cap: 20, windowMs: 15 * 60_000 };
const TOTP_IP_LIMIT = { cap: 30, windowMs: 15 * 60_000 };
const REFRESH_IP_LIMIT = { cap: 240, windowMs: 15 * 60_000 };
const REFRESH_SESSION_LIMIT = { cap: 120, windowMs: 3_600_000 };
const WAIT_STEP_MS = 50;
const WAIT_MAX_MS = 3_000;

const LOGIN_REFUSED = 'E-mail or password not valid (an account is also locked for 15 minutes after 5 failed attempts).';
const MFA_REFUSED = 'The sign-in expired; start again with the e-mail and password.';

const REFRESH = /^ar1\.([1-9][0-9]{0,18})\.([A-Za-z0-9_-]{43})$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

// ─── Tokens and the cookie ─────────────────────────────────────────────────

export interface AdminRefreshToken {
  token: string;
  sessionId: string;
  hash: Buffer;
}

export function newAdminRefreshToken(sessionId: string): AdminRefreshToken {
  const token = `ar1.${sessionId}.${randomBytes(32).toString('base64url')}`;
  return { token, sessionId, hash: sha256(token) };
}

export function parseAdminRefreshToken(token: string): AdminRefreshToken | null {
  const match = REFRESH.exec(token);
  if (!match?.[1]) return null;
  return { token, sessionId: match[1], hash: sha256(token) };
}

/** The value of cookie `name` in a Cookie header, or null. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

const COOKIE_ATTRIBUTES = `Path=${ADMIN_AUTH_PATH}; HttpOnly; Secure; SameSite=Strict`;

export function refreshCookie(token: string, maxAgeSeconds: number): string {
  return `${ADMIN_REFRESH_COOKIE}=${token}; ${COOKIE_ATTRIBUTES}; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

export function clearedRefreshCookie(): string {
  return `${ADMIN_REFRESH_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;
}

function cookieToken(request: FastifyRequest): string | null {
  return readCookie(request.headers.cookie, ADMIN_REFRESH_COOKIE);
}

// ─── Limits, the MFA ticket, the actor ─────────────────────────────────────

async function takeIpLimit(
  app: FastifyInstance,
  request: FastifyRequest,
  route: string,
  limit: { cap: number; windowMs: number },
  more: readonly Limit[] = [],
): Promise<void> {
  const entry: Limit = { name: route, key: app.keys.signInIpLimit(route, ipSegment(request)), ...limit };
  let verdict;
  try {
    // All or none: a request refused by one limit counts against no other.
    verdict = await app.limits.take([entry, ...more]);
  } catch (error) {
    throw new HttpProblem('service_unavailable', { detail: 'Admin sign-in is unavailable right now.', headers: { 'retry-after': '30' }, cause: error });
  }
  if (!verdict.ok) {
    const retryAfterSeconds = Math.max(1, Math.ceil(verdict.retryAfterMs / 1_000));
    throw new HttpProblem('rate_limited', { retryAfterSeconds, headers: { 'retry-after': String(retryAfterSeconds) } });
  }
}

interface MfaTicket {
  adminId: number;
  /** No TOTP yet: only enrolment and its confirmation take this ticket. */
  enroll: boolean;
}

const mfaKey = (app: FastifyInstance, token: string) => app.keys.adminMfa(sha256(token).toString('hex'));

function valkeyDown(error: unknown): HttpProblem {
  return new HttpProblem('service_unavailable', { detail: 'Admin sign-in is unavailable right now.', headers: { 'retry-after': '30' }, cause: error });
}

async function openMfa(app: FastifyInstance, ticket: MfaTicket): Promise<{ token: string; expiresAt: Date }> {
  const token = `amf1.${randomBytes(32).toString('base64url')}`;
  try {
    await app.redis.set(mfaKey(app, token), JSON.stringify(ticket), 'EX', MFA_TTL_SECONDS);
  } catch (error) {
    throw valkeyDown(error);
  }
  return { token, expiresAt: new Date(Date.now() + MFA_TTL_SECONDS * 1_000) };
}

async function readMfa(app: FastifyInstance, token: string): Promise<MfaTicket | null> {
  let raw: string | null;
  try {
    raw = await app.redis.get(mfaKey(app, token));
  } catch (error) {
    throw valkeyDown(error);
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MfaTicket>;
    return typeof parsed.adminId === 'number' && typeof parsed.enroll === 'boolean' ? { adminId: parsed.adminId, enroll: parsed.enroll } : null;
  } catch {
    return null;
  }
}

async function closeMfa(app: FastifyInstance, request: FastifyRequest, token: string): Promise<void> {
  await app.redis.del(mfaKey(app, token)).catch((error: unknown) => request.log.warn({ err: error }, 'admin: mfa ticket not removed; it expires on its own'));
}

function refused(): HttpProblem {
  return new HttpProblem('unauthorized', { detail: LOGIN_REFUSED });
}

function mfaRefused(): HttpProblem {
  return new HttpProblem('unauthorized', { detail: MFA_REFUSED });
}

function userAgentOf(request: FastifyRequest): string | null {
  const agent = request.headers['user-agent'];
  return typeof agent === 'string' && agent.length > 0 ? agent.slice(0, 512) : null;
}

/** The name authenticator apps show: the active brand's (the panel's override, else brand.json). */
export function totpIssuer(app: FastifyInstance): string {
  return app.cfg.peek()?.brand.appName ?? app.brand.appName;
}

/** Signs an admin access token (the admin audience; `roles` as the row holds them now). */
export async function issueAdminAccess(app: FastifyInstance, adminId: number, sessionId: string, roles: readonly string[]): Promise<AdminAccessToken> {
  const access = await app.tokens.issue({ kind: 'admin', subject: String(adminId), sessionId, roles, ttlSeconds: app.adminAuth.accessTokenTtlSeconds });
  return { accessToken: access.token, expiresAt: wireTime(access.expiresAt) };
}

/**
 * Ends the access tokens of revoked sessions at once (`deny:sid`) and drops
 * their refresh grace. A failure is logged: the sessions are revoked in the
 * database already (no refresh works), and while Valkey cannot be read every
 * admin token is refused anyway (the deny list fails closed for admins).
 */
export async function denyAdminSessions(app: FastifyInstance, request: FastifyRequest, sessionIds: readonly string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  try {
    await Promise.all([...sessionIds.map((sid) => app.denyList.revokeSession(sid)), app.refreshGrace.forget(sessionIds)]);
  } catch (error) {
    request.log.error({ err: error, sessions: sessionIds.length }, 'admin: revoked sessions not written to the deny list');
  }
}

// ─── 1. E-mail and password ────────────────────────────────────────────────

export async function adminLogin(app: FastifyInstance, request: FastifyRequest, email: string, password: string): Promise<AdminLoginResult> {
  const runtime = app.adminAuth;
  await takeIpLimit(app, request, 'admin_login', LOGIN_IP_LIMIT, [{ name: 'admin_login_all', key: app.keys.adminLoginLimit(), ...runtime.loginLimit }]);
  const passwords = runtime.passwords;
  const normalized = email.trim().toLowerCase();
  // Looked up whatever its shape (the schema bounds its length), so a malformed address costs what a real one does.
  const found = await adminCredentials(app.pg, normalized);
  const account = EMAIL.test(normalized) ? found : null;
  if (!account?.passwordHash) {
    await passwords.burn(password);
    // The same statement a wrong password costs (it matches no row), so the time says nothing either.
    await adminRecordFailure(app.pg, 0, LOCK_POLICY);
    throw refused();
  }
  const matches = await passwords.verify(password, account.passwordHash);
  if (!matches || account.disabled || account.locked) {
    // A locked account counts nothing more (the statement matches no row then).
    await adminRecordFailure(app.pg, account.id, LOCK_POLICY);
    throw refused();
  }
  // The row as it is now decides, not the read before the hash: failures counted meanwhile may have locked it.
  const rehash = passwords.needsRehash(account.passwordHash) ? { oldHash: account.passwordHash, newHash: await passwords.hash(password) } : null;
  if (!(await adminAcceptPassword(app.pg, account.id, rehash))) throw refused();
  const mfa = await openMfa(app, { adminId: account.id, enroll: !account.totpEnabled });
  return { mfaToken: mfa.token, enrollRequired: !account.totpEnabled, expiresAt: wireTime(mfa.expiresAt) };
}

// ─── 2. TOTP ───────────────────────────────────────────────────────────────

/** A new TOTP secret for an account without one, shown once (each call replaces the one before). */
export async function adminEnrollTotp(app: FastifyInstance, request: FastifyRequest, mfaToken: string): Promise<AdminTotpEnrollment> {
  await takeIpLimit(app, request, 'admin_totp', TOTP_IP_LIMIT);
  const ticket = await readMfa(app, mfaToken);
  if (!ticket) throw mfaRefused();
  if (!ticket.enroll) throw new HttpProblem('already_set', { detail: 'TOTP is set up for this account: sign in with a code.' });
  const state = await adminMfaState(app.pg, ticket.adminId);
  if (!state || state.disabled || state.locked) {
    await closeMfa(app, request, mfaToken);
    throw mfaRefused();
  }
  if (state.totpEnabled) throw new HttpProblem('already_set', { detail: 'TOTP is set up for this account: sign in with a code.' });
  const secret = generateTotpSecret();
  const sealed = app.secrets.sealer.seal(secret, TOTP_SECRET_PURPOSE);
  const actor: AdminActor = { adminId: state.id, sessionId: null, ip: request.clientIp };
  await auditedTransaction(app, actor, async (tx, trail) => {
    if (!(await adminSetPendingTotp(tx, state.id, sealed))) throw mfaRefused();
    trail.record({ action: 'admin.totp_issue', target: 'admin', targetId: state.id });
  });
  return { otpauthUri: otpauthUri(totpIssuer(app), state.email, secret), secret: base32Encode(secret) };
}

/**
 * The second step: `confirm` takes the first code of a new secret (and
 * enrols it), `verify` a code of the enrolled one. On success the session
 * opens, the refresh cookie is set and the access token is the answer.
 */
export async function adminCheckTotp(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  input: { mfaToken: string; code: string; mode: 'confirm' | 'verify' },
): Promise<AdminAccessToken> {
  await takeIpLimit(app, request, 'admin_totp', TOTP_IP_LIMIT);
  const enroll = input.mode === 'confirm';
  const ticket = await readMfa(app, input.mfaToken);
  if (!ticket) throw mfaRefused();
  if (ticket.enroll !== enroll) {
    throw enroll
      ? new HttpProblem('already_set', { detail: 'TOTP is set up for this account: sign in with a code.' })
      : new HttpProblem('conflict', { detail: 'Set up TOTP first.' });
  }
  const state = await adminMfaState(app.pg, ticket.adminId);
  if (!state || state.disabled || state.locked) {
    await closeMfa(app, request, input.mfaToken);
    throw mfaRefused();
  }
  if (state.totpEnabled === enroll) {
    await closeMfa(app, request, input.mfaToken);
    throw mfaRefused();
  }
  if (!state.totpSecret) throw new HttpProblem('conflict', { detail: 'Set up TOTP first.' });
  let secret: Buffer;
  try {
    secret = app.secrets.sealer.open(state.totpSecret, TOTP_SECRET_PURPOSE);
  } catch (error) {
    request.log.error({ err: error }, 'admin: the stored TOTP secret cannot be opened (DATA_KEYS?)');
    throw new HttpProblem('service_unavailable', { detail: 'The second factor cannot be checked right now.', cause: error });
  }

  const attemptsLeft = (failures: number) => Math.max(0, LOCK_POLICY.maxFailures - failures);
  const check = checkTotp(secret, input.code, app.adminAuth.now(), state.totpLastStep);
  if (!check.ok) {
    // A replay is refused without counting (a code typed twice is not a guess).
    if (check.replayed) throw new HttpProblem('otp_invalid', { detail: 'That code was used already; wait for the next one.', extensions: { attemptsLeft: attemptsLeft(state.failures) } });
    const outcome = await adminRecordFailure(app.pg, state.id, LOCK_POLICY);
    if (outcome.locked) {
      await closeMfa(app, request, input.mfaToken);
      throw new HttpProblem('otp_locked', { detail: 'Too many failed attempts: the account is locked for 15 minutes.' });
    }
    throw new HttpProblem('otp_invalid', { detail: 'Wrong code.', extensions: { attemptsLeft: attemptsLeft(outcome.failures) } });
  }

  const runtime = app.adminAuth;
  const sessionId = nextId(app);
  const refresh = newAdminRefreshToken(sessionId);
  const idleSeconds = Math.min(runtime.sessionIdleSeconds, runtime.sessionMaxSeconds);
  const actor: AdminActor = { adminId: state.id, sessionId, ip: request.clientIp };
  const signed = await auditedTransaction(app, actor, async (tx, trail) => {
    const result = await adminSignIn(tx, {
      adminId: state.id,
      step: check.step,
      secret: state.totpSecret!,
      enroll,
      session: { id: sessionId, refreshHash: refresh.hash, idleSeconds, ip: request.clientIp, userAgent: userAgentOf(request) },
    });
    // The account changed since it was read (another sign-in took this step, a reset, a lock): nothing is written.
    if (!result) throw new HttpProblem('otp_invalid', { detail: 'That code cannot be used; wait for the next one.', extensions: { attemptsLeft: attemptsLeft(state.failures) } });
    if (enroll) trail.record({ action: 'admin.totp_enroll', target: 'admin', targetId: state.id });
    trail.record({ action: 'admin.login', target: 'admin', targetId: state.id, detail: { sessionId, enrolled: enroll } });
    return result;
  });
  await closeMfa(app, request, input.mfaToken);
  reply.header('set-cookie', refreshCookie(refresh.token, (signed.expiresAtMs - Date.now()) / 1_000));
  request.log.info({ adminId: state.id, enrolled: enroll }, 'admin signed in');
  return issueAdminAccess(app, state.id, sessionId, signed.roles);
}

// ─── 3. Refresh and sign-out ───────────────────────────────────────────────

interface GraceAnswer {
  accessToken: string;
  expiresAt: string;
  refreshToken: string;
  refreshExpiresAtMs: number;
}

function sealAnswer(app: FastifyInstance, answer: GraceAnswer): string {
  return app.secrets.sealer.seal(JSON.stringify(answer), GRACE_PURPOSE).toString('base64');
}

function openAnswer(app: FastifyInstance, sealed: string): GraceAnswer | null {
  try {
    return JSON.parse(app.secrets.sealer.openText(Buffer.from(sealed, 'base64'), GRACE_PURPOSE)) as GraceAnswer;
  } catch {
    return null;
  }
}

function answerWith(reply: FastifyReply, answer: GraceAnswer): AdminAccessToken {
  reply.header('set-cookie', refreshCookie(answer.refreshToken, (answer.refreshExpiresAtMs - Date.now()) / 1_000));
  return { accessToken: answer.accessToken, expiresAt: answer.expiresAt };
}

function refreshRefused(reply: FastifyReply, code: 'refresh_invalid' | 'refresh_reused' = 'refresh_invalid'): HttpProblem {
  reply.header('set-cookie', clearedRefreshCookie());
  return new HttpProblem(code, { detail: 'Sign in again.' });
}

/**
 * Rotates the refresh cookie: one statement. Two refreshes with the same
 * cookie within 30 s (two tabs of the panel) get the same answer from the
 * grace (`rtg:<sid>`); one after that revokes the session.
 */
export async function adminRefreshSession(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply): Promise<AdminAccessToken> {
  const raw = cookieToken(request);
  const parsed = raw === null ? null : parseAdminRefreshToken(raw);
  if (!parsed) throw refreshRefused(reply);
  await takeIpLimit(app, request, 'admin_refresh', REFRESH_IP_LIMIT);
  const { sessionId } = parsed;
  const tokenHash = parsed.hash.toString('hex');
  const grace = app.refreshGrace;

  let claimed = false;
  const deadline = Date.now() + WAIT_MAX_MS;
  let count = true;
  try {
    for (;;) {
      const claim = await grace.claim(sessionId, tokenHash, { count, ...REFRESH_SESSION_LIMIT });
      count = false;
      if (claim.state === 'limited') {
        const retryAfterSeconds = Math.max(1, Math.ceil(claim.retryAfterMs / 1_000));
        throw new HttpProblem('rate_limited', { retryAfterSeconds, headers: { 'retry-after': String(retryAfterSeconds) } });
      }
      if (claim.state === 'done') {
        const answer = openAnswer(app, claim.answer);
        if (answer) return answerWith(reply, answer);
        break;
      }
      if (claim.state === 'claimed') {
        claimed = true;
        break;
      }
      if (Date.now() >= deadline) throw new HttpProblem('service_unavailable', { detail: 'Try again.', headers: { 'retry-after': '1' } });
      await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
    }
  } catch (error) {
    if (error instanceof HttpProblem) throw error;
    throw valkeyDown(error);
  }

  try {
    const runtime = app.adminAuth;
    const next = newAdminRefreshToken(sessionId);
    const outcome = await adminRefresh(app.pg, {
      sessionId,
      oldHash: parsed.hash,
      newHash: next.hash,
      idleSeconds: runtime.sessionIdleSeconds,
      maxSeconds: runtime.sessionMaxSeconds,
      graceSeconds: Math.ceil(grace.graceMs / 1_000),
    });
    if (outcome.outcome === 'reused') {
      request.log.warn({ adminId: outcome.adminId }, 'admin refresh token reused: session revoked');
      claimed = false;
      await denyAdminSessions(app, request, [sessionId]);
      throw refreshRefused(reply, 'refresh_reused');
    }
    if (outcome.outcome === 'invalid') throw refreshRefused(reply);
    const access = await issueAdminAccess(app, outcome.adminId, sessionId, outcome.roles);
    const answer: GraceAnswer = { ...access, refreshToken: next.token, refreshExpiresAtMs: outcome.expiresAtMs };
    if (claimed) {
      await grace.complete(sessionId, tokenHash, sealAnswer(app, answer)).catch((error: unknown) => request.log.warn({ err: error }, 'admin refresh grace not stored'));
      claimed = false;
    }
    return answerWith(reply, answer);
  } finally {
    if (claimed) await grace.release(sessionId, tokenHash).catch(() => undefined);
  }
}

/**
 * Signs out the cookie's session (or, without a cookie, the access token's),
 * and with `all` every session of the admin. Always clears the cookie; a
 * cookie that names no live session is already signed out (204).
 */
export async function adminLogout(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply, all: boolean): Promise<void> {
  reply.header('set-cookie', clearedRefreshCookie());
  const raw = cookieToken(request);
  const parsed = raw === null ? null : parseAdminRefreshToken(raw);
  const principal = request.principal?.kind === 'admin' ? request.principal : null;
  let revoked: string[] = [];
  if (parsed) {
    revoked = await auditedTransaction(app, { adminId: null, sessionId: parsed.sessionId, ip: request.clientIp }, async (tx, trail) => {
      const outcome = await adminLogoutByToken(tx, { sessionId: parsed.sessionId, hash: parsed.hash, all });
      if (!outcome) {
        trail.unchanged();
        return [];
      }
      trail.actAs(outcome.adminId);
      trail.record({ action: all ? 'admin.logout_all' : 'admin.logout', target: 'admin', targetId: outcome.adminId, detail: { sessions: outcome.revoked.length } });
      return outcome.revoked;
    });
  } else if (principal && /^[1-9][0-9]{0,9}$/.test(principal.subject)) {
    const adminId = Number(principal.subject);
    revoked = await auditedTransaction(app, { adminId, sessionId: principal.sessionId, ip: request.clientIp }, async (tx, trail) => {
      const ids = await adminRevokeSessions(
        tx,
        all ? { adminId } : { sessionId: principal.sessionId, adminId },
        adminRevokeReason.code(all ? 'logout_all' : 'logout'),
      );
      if (ids.length === 0) {
        trail.unchanged();
        return ids;
      }
      trail.record({ action: all ? 'admin.logout_all' : 'admin.logout', target: 'admin', targetId: adminId, detail: { sessions: ids.length } });
      return ids;
    });
    // The access token itself stops too, even when its session was gone already.
    if (!revoked.includes(principal.sessionId)) revoked.push(principal.sessionId);
  }
  await denyAdminSessions(app, request, revoked);
}
