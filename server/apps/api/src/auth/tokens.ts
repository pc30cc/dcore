import { randomUUID } from 'node:crypto';
import { SignJWT, errors as joseErrors, importPKCS8, importSPKI, jwtVerify, type CryptoKey, type JWTHeaderParameters } from 'jose';
import { z } from 'zod';
import type { ApiConfig, SigningKeyConfig } from '../config.js';

/**
 * Short-lived access tokens (JWT, RFC 9068 profile).
 *
 * The API verifies them on every request with a key it holds in memory, and
 * never reads the database to do so: signature, issuer, audience, type and
 * expiry are the whole check. That is why they are short-lived (15 minutes by
 * default); revocation takes effect at the next refresh.
 *
 * App tokens also carry `did` (the device row), `st` (the store code of
 * the session, 1 play or 2 bazaar) and `scope` (`full`, `restricted` for a
 * suspended or banned account, `restore` for one in its deletion grace);
 * each route says which scopes it serves. Revocation before expiry is the
 * Valkey deny list (`deny:sid`, `deny:uid`); refresh tokens are opaque and
 * live in `sessions` (src/auth/sessions.ts).
 */

/** Who a token is for. A user token is refused by admin routes and the other way round. */
export const audiences = ['app', 'admin'] as const;
export type Audience = (typeof audiences)[number];

export const TOKEN_TYPE = 'at+jwt';

export interface Principal {
  kind: Audience;
  /** The user's or admin's opaque id. */
  subject: string;
  /** The login session (device) the token was issued to. */
  sessionId: string;
  /** Admin roles; always empty for users. */
  roles: readonly string[];
  tokenId: string;
  /** When the token was signed (`iat`): a user-wide revocation refuses tokens issued before it. */
  issuedAt: Date;
  expiresAt: Date;
  /** App tokens: the device row the session signed in from (`did`), when the token names one. */
  deviceId?: string | undefined;
  /** App tokens: the store code of the session (`st`: 1 play, 2 bazaar), when the token names one. */
  storeCode?: number | undefined;
  /** App tokens: what the session may do (`scope`); `full` when the token names none. */
  scope: SessionScope;
}

/** `full` (statuses 1-4), `restricted` (suspended or banned), `restore` (deleted, in its grace period). */
export const sessionScopes = ['full', 'restricted', 'restore'] as const;
export type SessionScope = (typeof sessionScopes)[number];

export interface IssueInput {
  kind: Audience;
  subject: string;
  sessionId: string;
  roles?: readonly string[] | undefined;
  /** App tokens only: `did`, `st` and `scope` claims. */
  deviceId?: string | undefined;
  storeCode?: number | undefined;
  scope?: SessionScope | undefined;
  /** A lifetime shorter than the configured one (admin tokens); never longer. */
  ttlSeconds?: number | undefined;
}

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

export type TokenFailure = 'expired' | 'invalid' | 'revoked';

export class TokenError extends Error {
  readonly reason: TokenFailure;

  constructor(reason: TokenFailure, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TokenError';
    this.reason = reason;
  }
}

export interface AccessTokens {
  issue(input: IssueInput): Promise<IssuedToken>;
  verify(token: string): Promise<Principal>;
}

const opaqueId = z.string().min(1).max(128);
const claimsSchema = z.object({
  sub: opaqueId,
  sid: opaqueId,
  jti: opaqueId,
  aud: z.enum(audiences),
  exp: z.number().int(),
  iat: z.number().int(),
  roles: z.array(z.string().min(1).max(64)).max(32).optional(),
  did: z.string().regex(/^[1-9][0-9]{0,18}$/).optional(),
  st: z.number().int().min(1).max(3).optional(),
  scope: z.enum(sessionScopes).optional(),
});

type Key = CryptoKey | Uint8Array;

function secretBytes(secret: string): Uint8Array {
  return new Uint8Array(Buffer.from(secret, 'base64url'));
}

async function verificationKey(alg: ApiConfig['auth']['alg'], key: SigningKeyConfig): Promise<Key> {
  if (alg === 'HS256') {
    if (!key.secret) throw new Error(`no secret for key ${key.kid}`);
    return secretBytes(key.secret);
  }
  if (!key.publicKey) throw new Error(`no public key for key ${key.kid}`);
  return importSPKI(key.publicKey, 'EdDSA');
}

async function signingKey(alg: ApiConfig['auth']['alg'], key: SigningKeyConfig): Promise<Key> {
  if (alg === 'HS256') return verificationKey(alg, key);
  if (!key.privateKey) throw new Error(`no private key for key ${key.kid}`);
  return importPKCS8(key.privateKey, 'EdDSA');
}

/** Builds the token service from the auth configuration; keys are imported once. */
export async function createAccessTokens(config: ApiConfig['auth']): Promise<AccessTokens> {
  const { alg, issuer, accessTokenTtlSeconds, clockSkewSeconds } = config;
  const signer = await signingKey(alg, config.current);
  const verifiers = new Map<string, Key>([[config.current.kid, await verificationKey(alg, config.current)]]);
  if (config.previous) verifiers.set(config.previous.kid, await verificationKey(alg, config.previous));

  const keyFor = (header: JWTHeaderParameters): Key => {
    const key = header.kid === undefined ? undefined : verifiers.get(header.kid);
    if (!key) throw new TokenError('invalid', 'unknown signing key');
    return key;
  };

  return {
    async issue(input) {
      const now = Math.floor(Date.now() / 1_000);
      const ttl = input.ttlSeconds === undefined ? accessTokenTtlSeconds : Math.min(accessTokenTtlSeconds, Math.max(1, Math.floor(input.ttlSeconds)));
      const exp = now + ttl;
      const payload: Record<string, unknown> = { sid: input.sessionId };
      if (input.kind === 'admin') payload['roles'] = [...(input.roles ?? [])];
      if (input.kind === 'app') {
        if (input.deviceId !== undefined) payload['did'] = input.deviceId;
        if (input.storeCode !== undefined) payload['st'] = input.storeCode;
        payload['scope'] = input.scope ?? 'full';
      }
      const token = await new SignJWT(payload)
        .setProtectedHeader({ alg, kid: config.current.kid, typ: TOKEN_TYPE })
        .setIssuer(issuer)
        .setSubject(input.subject)
        .setAudience(input.kind)
        .setIssuedAt(now)
        .setExpirationTime(exp)
        .setJti(randomUUID())
        .sign(signer);
      return { token, expiresAt: new Date(exp * 1_000) };
    },

    async verify(token) {
      let payload: unknown;
      try {
        ({ payload } = await jwtVerify(token, keyFor, {
          algorithms: [alg],
          issuer,
          audience: [...audiences],
          typ: TOKEN_TYPE,
          clockTolerance: clockSkewSeconds,
          requiredClaims: ['sub', 'sid', 'jti', 'exp', 'iat'],
        }));
      } catch (error) {
        if (error instanceof TokenError) throw error;
        if (error instanceof joseErrors.JWTExpired) throw new TokenError('expired', 'token expired', { cause: error });
        throw new TokenError('invalid', 'token rejected', { cause: error });
      }
      const claims = claimsSchema.safeParse(payload);
      if (!claims.success) throw new TokenError('invalid', 'token claims malformed', { cause: claims.error });
      const { sub, sid, jti, aud, exp, iat, roles, did, st, scope } = claims.data;
      return {
        kind: aud,
        subject: sub,
        sessionId: sid,
        roles: aud === 'admin' ? (roles ?? []) : [],
        tokenId: jti,
        issuedAt: new Date(iat * 1_000),
        expiresAt: new Date(exp * 1_000),
        ...(aud === 'app' ? { deviceId: did, storeCode: st } : {}),
        scope: aud === 'app' ? (scope ?? 'full') : 'full',
      };
    },
  };
}
