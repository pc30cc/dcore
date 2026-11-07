import { createHash, randomBytes } from 'node:crypto';
import {
  IdentityTakenError,
  createAccount,
  refreshSession,
  revokeSessions,
  signInExisting,
  signInLookup,
  withTransaction,
  type AccountState,
  type CreatedSession,
  type SignInIdentity,
} from '@app/db';
import { accountStatus, revokeReason, wireTime, type AuthResult, type ErrorCode, type TokenPair } from '@app/shared';
import { IdGeneratorUnavailableError, hashDomains, type KeyedHash } from '@app/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpProblem } from '../lib/problem.js';
import type { SessionScope } from './tokens.js';

/**
 * Refresh sessions: the token format, signing in (new or existing
 * account), rotating, and the account-state answers that come with a
 * restricted account.
 *
 * A refresh token is `rt1.<session id>.<32 random bytes, base64url>`; only
 * its SHA-256 is stored (`sessions.refresh_hash`). Each use rotates it, and
 * the previous hash stays in `prev_hash`, so a rotated token used again
 * after the grace revokes the session (reuse means a copy is loose).
 */

const REFRESH = /^rt1\.([1-9][0-9]{0,18})\.([A-Za-z0-9_-]{43})$/;

export interface RefreshToken {
  token: string;
  sessionId: string;
  hash: Buffer;
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function newRefreshToken(sessionId: string): RefreshToken {
  const token = `rt1.${sessionId}.${randomBytes(32).toString('base64url')}`;
  return { token, sessionId, hash: sha256(token) };
}

export function parseRefreshToken(token: string): RefreshToken | null {
  const match = REFRESH.exec(token);
  if (!match?.[1]) return null;
  return { token, sessionId: match[1], hash: sha256(token) };
}

/** What a session of an account in `status` may do; null for a purged account (no session at all). */
export function scopeOf(status: number): SessionScope | null {
  if (status >= 1 && status <= 4) return 'full';
  if (status === 5 || status === 6) return 'restricted';
  if (status === 7) return 'restore';
  return null;
}

/** A fresh application id, or 503 while this process holds no id lease. */
export function nextId(app: FastifyInstance): string {
  try {
    return app.ids.nextId();
  } catch (error) {
    if (error instanceof IdGeneratorUnavailableError) {
      throw new HttpProblem('service_unavailable', { detail: 'Try again in a moment.', headers: { 'retry-after': '2' }, cause: error });
    }
    throw error;
  }
}

export interface PairInput {
  userId: string;
  sessionId: string;
  deviceId: string | null;
  store: number;
  scope: SessionScope;
  refreshToken: string;
  refreshExpiresAtMs: number;
}

export async function issuePair(app: FastifyInstance, input: PairInput): Promise<TokenPair> {
  const access = await app.tokens.issue({
    kind: 'app',
    subject: app.publicIds.user.encode(input.userId),
    sessionId: input.sessionId,
    deviceId: input.deviceId ?? undefined,
    storeCode: input.store,
    scope: input.scope,
  });
  return {
    accessToken: access.token,
    accessExpiresAt: wireTime(access.expiresAt),
    refreshToken: input.refreshToken,
    refreshExpiresAt: wireTime(input.refreshExpiresAtMs),
  };
}

const NEUTRAL_REASON = 'This account is restricted.';

/**
 * The 403 an account that may not use the app gets: banned or suspended
 * (with the reason the person sees and the action to appeal), or deleted
 * (with the last day it can be restored). `pair` is the restricted or
 * restore session handed out with it (on a refresh).
 */
export function accountStateProblem(state: AccountState, pair?: TokenPair): HttpProblem | null {
  const tokens = pair ? { ...pair } : {};
  if (state.status === 5 || state.status === 6) {
    const code: ErrorCode = state.status === 6 ? 'account_banned' : 'account_suspended';
    const r = state.restriction;
    return new HttpProblem(code, {
      extensions: {
        reasonText: r?.reasonText || NEUTRAL_REASON,
        actionId: r?.actionId,
        until: r?.endsAtMs === undefined ? undefined : wireTime(r.endsAtMs),
        appealable: r?.appealable ?? false,
        ...tokens,
      },
    });
  }
  if (state.status === 7) {
    return new HttpProblem('account_deleted', {
      extensions: { restorableUntil: state.purgeAtMs === undefined ? undefined : wireTime(state.purgeAtMs), ...tokens },
    });
  }
  return null;
}

// ─── Signing in ────────────────────────────────────────────────────────────

export interface SignInSubject {
  provider: 1 | 2;
  /** The subject's keyed hash under every pepper, the current one first. */
  hashes: KeyedHash[];
  /** The phone number sealed for `auth_identities.subject_enc`; null for Google. */
  sealed: Buffer | null;
  /** A review account (users.flags 1) when a new account is made. */
  testAccount: boolean;
}

export interface DeviceBody {
  installId: string;
  deviceKey: string;
  device: { model: string; osVersion: string; appVersion: string; locale: string };
}

const BAN_CODES: Readonly<Record<number, ErrorCode>> = { 1: 'device_banned', 2: 'phone_banned', 3: 'phone_banned' };

/**
 * Signs in to the subject's account, or makes one: 1 read (identity,
 * account state, bans), then one transaction (3 statements for an existing
 * account, 4 for a new one). A ban of the subject or of this build's device
 * key refuses it. Suspended and banned accounts get a `restricted` session,
 * deleted ones a `restore` session.
 */
export async function signIn(app: FastifyInstance, request: FastifyRequest, subject: SignInSubject, body: DeviceBody): Promise<AuthResult> {
  const client = request.client;
  if (!client) throw new HttpProblem('bad_request', { detail: 'X-Client is required.' });
  const hasher = app.secrets.hasher;
  const deviceHashes = hasher.hashAll(hashDomains.device, body.deviceKey);
  const fingerprint = deviceHashes[0];
  const subjectHash = subject.hashes[0];
  if (!fingerprint || !subjectHash) throw new Error('no pepper');
  const settings = app.authSettings.get();
  const locale = body.device.locale;

  const lookup = () =>
    signInLookup(app.pg, {
      provider: subject.provider,
      subjectHashes: subject.hashes.map((h) => h.hash),
      deviceHashes: deviceHashes.map((h) => h.hash),
      store: client.storeCode,
    });
  const deviceInput = () => ({ newId: nextId(app), fingerprint: fingerprint.hash, store: client.storeCode, appVersion: client.versionCode, locale });
  const sessionInput = (refresh: { hash: Buffer }, sessionId: string) => ({
    id: sessionId,
    refreshHash: refresh.hash,
    idleDays: settings.sessionIdleDays,
    store: client.storeCode,
    appVersion: client.versionCode,
  });

  let found = await lookup();
  const ban = found.bans[0];
  if (ban !== undefined) throw new HttpProblem(BAN_CODES[ban] ?? 'device_banned');

  const sessionId = nextId(app);
  const refresh = newRefreshToken(sessionId);
  let identity: SignInIdentity | null = found.identity;
  let created: CreatedSession | null = null;
  let isNew = false;
  if (identity === null) {
    const userId = nextId(app);
    try {
      created = await withTransaction(app.pg, (tx) =>
        createAccount(tx, {
          userId,
          identityId: nextId(app),
          provider: subject.provider,
          subject: subjectHash,
          subjectSealed: subject.sealed,
          tombstoneIdentityId: found.tombstoneIdentityId,
          flags: subject.testAccount ? 1 : 0,
          locale,
          device: deviceInput(),
          session: sessionInput(refresh, sessionId),
        }),
      );
      isNew = true;
      identity = { identityId: '', userId, hashKid: subjectHash.kid, state: { status: 1, onboardingStep: 0, flags: subject.testAccount ? 1 : 0 } };
    } catch (error) {
      if (!(error instanceof IdentityTakenError)) throw error;
      // Signed up by a parallel request a moment ago: sign in to that account.
      found = await lookup();
      identity = found.identity;
      if (identity === null) throw new HttpProblem('conflict', { detail: 'Try again.' });
    }
  }
  if (created === null) {
    const existing = identity;
    created = await withTransaction(app.pg, (tx) =>
      signInExisting(tx, { userId: existing.userId, identityId: existing.identityId, device: deviceInput(), session: sessionInput(refresh, sessionId) }),
    );
  }

  // The sign-in wrote the device row (version, locale, enabled again): the next device report must reach the database.
  const deviceId = created.deviceId;
  await app.redis.del(app.keys.device(deviceId)).catch((error: unknown) => request.log.warn({ err: error }, 'device: fingerprint not cleared'));

  const scope = scopeOf(identity.state.status);
  if (scope === null) throw new HttpProblem('internal');
  const pair = await issuePair(app, {
    userId: identity.userId,
    sessionId,
    deviceId,
    store: client.storeCode,
    scope,
    refreshToken: refresh.token,
    refreshExpiresAtMs: created.expiresAtMs,
  });
  request.log.info({ isNew, scope, provider: subject.provider }, 'signed in');
  return {
    ...pair,
    user: {
      id: app.publicIds.user.encode(identity.userId),
      status: accountStatus.name(identity.state.status) as AuthResult['user']['status'],
      onboardingStep: identity.state.onboardingStep,
    },
    isNew,
  };
}

// ─── Refreshing ────────────────────────────────────────────────────────────

/** A refresh's answer, as stored for the grace: the status and the body. */
export interface RefreshAnswer {
  status: 200 | 403;
  body: Record<string, unknown>;
}

const GRACE_PURPOSE = 'auth.refresh_grace';
const REFRESH_LIMIT = { cap: 30, windowMs: 3_600_000 };
const WAIT_STEP_MS = 50;
const WAIT_MAX_MS = 3_000;

function sealAnswer(app: FastifyInstance, answer: RefreshAnswer): string {
  return app.secrets.sealer.seal(JSON.stringify(answer), GRACE_PURPOSE).toString('base64');
}

function openAnswer(app: FastifyInstance, sealed: string): RefreshAnswer | null {
  try {
    return JSON.parse(app.secrets.sealer.openText(Buffer.from(sealed, 'base64'), GRACE_PURPOSE)) as RefreshAnswer;
  } catch {
    return null;
  }
}

/**
 * Rotates a refresh token: 1 statement. A second refresh with the same
 * token within 30 s (two parts of the app at once, a retried request) gets
 * the first one's answer from `rtg:<sid>` and costs nothing; one after that
 * revokes the session (`refresh_reused`). When Valkey cannot be asked the
 * rotation still works, without the grace (and without the per-session
 * limit, which is not one that must fail closed).
 */
export async function refresh(app: FastifyInstance, request: FastifyRequest, token: string): Promise<RefreshAnswer> {
  const parsed = parseRefreshToken(token);
  if (!parsed) throw new HttpProblem('refresh_invalid');
  const { sessionId } = parsed;
  const tokenHash = parsed.hash.toString('hex');
  const grace = app.refreshGrace;

  let claimed = false;
  let graceUp = true;
  try {
    const deadline = Date.now() + WAIT_MAX_MS;
    let count = true;
    for (;;) {
      const claim = await grace.claim(sessionId, tokenHash, { count, ...REFRESH_LIMIT });
      count = false;
      if (claim.state === 'limited') {
        const retryAfterSeconds = Math.max(1, Math.ceil(claim.retryAfterMs / 1_000));
        throw new HttpProblem('rate_limited', { retryAfterSeconds, headers: { 'retry-after': String(retryAfterSeconds) } });
      }
      if (claim.state === 'done') {
        const answer = openAnswer(app, claim.answer);
        if (answer) return answer;
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
    graceUp = false;
    request.log.warn({ err: error }, 'refresh grace unavailable; rotating without it');
  }

  try {
    const next = newRefreshToken(sessionId);
    const outcome = await refreshSession(app.pg, {
      sessionId,
      oldHash: parsed.hash,
      newHash: next.hash,
      idleDays: app.authSettings.get().sessionIdleDays,
      graceSeconds: Math.ceil(grace.graceMs / 1_000),
      appVersion: request.client?.versionCode ?? null,
    });
    if (outcome.outcome === 'reused') {
      request.log.warn({ sessionId }, 'refresh token reused: session revoked');
      await Promise.all([app.denyList.revokeSession(sessionId), grace.forget([sessionId])]).catch((error: unknown) =>
        request.log.error({ err: error }, 'reuse: deny list not written'),
      );
      claimed = false;
      throw new HttpProblem('refresh_reused');
    }
    if (outcome.outcome === 'invalid') throw new HttpProblem('refresh_invalid');

    const scope = scopeOf(outcome.state.status);
    if (scope === null) throw new HttpProblem('refresh_invalid');
    const pair = await issuePair(app, {
      userId: outcome.userId,
      sessionId,
      deviceId: outcome.deviceId,
      store: outcome.store,
      scope,
      refreshToken: next.token,
      refreshExpiresAtMs: outcome.expiresAtMs,
    });
    const problem = accountStateProblem(outcome.state, pair);
    const answer: RefreshAnswer = problem
      ? { status: 403, body: problem.toProblem(request.id, request.url.split('?')[0]) }
      : { status: 200, body: pair };
    if (claimed && graceUp) {
      await grace.complete(sessionId, tokenHash, sealAnswer(app, answer)).catch((error: unknown) => request.log.warn({ err: error }, 'refresh grace not stored'));
      claimed = false;
    }
    return answer;
  } finally {
    if (claimed && graceUp) await grace.release(sessionId, tokenHash).catch(() => undefined);
  }
}

// ─── Signing out ───────────────────────────────────────────────────────────

/** Ends this session, or every session of the user; their access tokens stop at once. */
export async function logout(app: FastifyInstance, request: FastifyRequest, all: boolean): Promise<void> {
  const principal = request.principal;
  if (!principal) throw new HttpProblem('unauthorized');
  const userId = app.publicIds.user.decodeId(principal.subject);
  if (userId === null) throw new HttpProblem('unauthorized');
  const revoked = all
    ? await revokeSessions(app.pg, { userId }, revokeReason.code('logout_all'))
    : await revokeSessions(app.pg, { sessionId: principal.sessionId }, revokeReason.code('logout'));
  try {
    if (all) await app.denyList.revokeUser(userId);
    else await app.denyList.revokeSession(principal.sessionId);
    await app.refreshGrace.forget([...new Set([principal.sessionId, ...revoked])]);
  } catch (error) {
    // The sessions are revoked (no refresh works); only the access tokens'
    // last minutes are not. The client may send it again.
    request.log.error({ err: error }, 'logout: deny list not written');
    throw new HttpProblem('service_unavailable', { detail: 'Signed out; try again to end the access token too.', cause: error });
  }
}
