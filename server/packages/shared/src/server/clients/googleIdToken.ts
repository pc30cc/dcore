import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';

/**
 * Google ID tokens (play sign-in, the website's deletion page). A token is
 * accepted only when Google signed it (Google's published keys), it is for
 * our web client id, it has not expired, and, when the caller says so, it
 * carries the nonce we issued and is recent. The account is identified by
 * `sub`, never by the e-mail.
 */

export interface GoogleIdentity {
  /** Google's stable account id. */
  sub: string;
  email?: string | undefined;
  emailVerified?: boolean | undefined;
  issuedAt: Date;
  expiresAt: Date;
}

export interface VerifyOptions {
  /** Our OAuth web client id (`GOOGLE_WEB_CLIENT_ID`). */
  audience: string;
  /** The nonce issued for this sign-in; the token must carry it. */
  nonce?: string | undefined;
  /** Refuse tokens issued longer ago than this (no nonce is possible on the website). */
  maxAgeSeconds?: number | undefined;
}

export type GoogleTokenFailure = 'malformed' | 'signature' | 'expired' | 'audience' | 'issuer' | 'nonce' | 'too_old' | 'unavailable';

export class GoogleIdTokenError extends Error {
  readonly reason: GoogleTokenFailure;

  constructor(reason: GoogleTokenFailure, options?: ErrorOptions) {
    super(`Google ID token refused: ${reason}`, options);
    this.name = 'GoogleIdTokenError';
    this.reason = reason;
  }
}

export interface GoogleIdTokenVerifier {
  verify(idToken: string, options: VerifyOptions): Promise<GoogleIdentity>;
}

export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

export interface GoogleVerifierOptions {
  /** Google's keys; tests pass a local key set. The default fetches and caches Google's published keys. */
  keys?: JWTVerifyGetKey | undefined;
  clockToleranceSeconds?: number | undefined;
  now?: (() => Date) | undefined;
}

export class JoseGoogleIdTokenVerifier implements GoogleIdTokenVerifier {
  private readonly keys: JWTVerifyGetKey;
  private readonly tolerance: number;
  private readonly now: () => Date;

  constructor(options: GoogleVerifierOptions = {}) {
    this.keys = options.keys ?? createRemoteJWKSet(new URL(GOOGLE_JWKS_URL), { cooldownDuration: 30_000, cacheMaxAge: 6 * 3_600_000 });
    this.tolerance = options.clockToleranceSeconds ?? 30;
    this.now = options.now ?? (() => new Date());
  }

  async verify(idToken: string, options: VerifyOptions): Promise<GoogleIdentity> {
    if (!options.audience) throw new GoogleIdTokenError('audience');
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(idToken, this.keys, {
        algorithms: ['RS256'],
        issuer: GOOGLE_ISSUERS,
        audience: options.audience,
        clockTolerance: this.tolerance,
        currentDate: this.now(),
        requiredClaims: ['sub', 'exp', 'iat'],
      }));
    } catch (error) {
      throw new GoogleIdTokenError(failureOf(error), { cause: error });
    }
    const sub = payload['sub'];
    const iat = payload['iat'];
    const exp = payload['exp'];
    if (typeof sub !== 'string' || !/^[0-9]{1,64}$/.test(sub) || typeof iat !== 'number' || typeof exp !== 'number') {
      throw new GoogleIdTokenError('malformed');
    }
    if (options.nonce !== undefined) {
      const nonce = payload['nonce'];
      if (typeof nonce !== 'string' || !equalStrings(nonce, options.nonce)) throw new GoogleIdTokenError('nonce');
    }
    if (options.maxAgeSeconds !== undefined && this.now().getTime() / 1_000 - iat > options.maxAgeSeconds + this.tolerance) {
      throw new GoogleIdTokenError('too_old');
    }
    const email = payload['email'];
    const verified = payload['email_verified'];
    return {
      sub,
      email: typeof email === 'string' ? email : undefined,
      emailVerified: typeof verified === 'boolean' ? verified : verified === 'true' ? true : undefined,
      issuedAt: new Date(iat * 1_000),
      expiresAt: new Date(exp * 1_000),
    };
  }
}

function failureOf(error: unknown): GoogleTokenFailure {
  if (error instanceof joseErrors.JWTExpired) return 'expired';
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    if (error.claim === 'aud') return 'audience';
    if (error.claim === 'iss') return 'issuer';
    return 'malformed';
  }
  if (error instanceof joseErrors.JWSSignatureVerificationFailed || error instanceof joseErrors.JWKSNoMatchingKey) return 'signature';
  // Google's keys could not be fetched: a timeout, or a network error (not a JOSE error).
  if (error instanceof joseErrors.JWKSTimeout || !(error instanceof joseErrors.JOSEError)) return 'unavailable';
  return 'malformed';
}

function equalStrings(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return ha.equals(hb);
}

/**
 * Accepts only the tokens it minted (`mint`), with the same checks as the
 * real verifier: audience, nonce, age and expiry. A token string carries no
 * claims: it is a random handle to what `mint` was given.
 */
export class FakeGoogleIdTokenVerifier implements GoogleIdTokenVerifier {
  private readonly tokens = new Map<string, { sub: string; audience: string; nonce?: string | undefined; email?: string | undefined; issuedAt: Date; expiresAt: Date }>();
  now: () => Date = () => new Date();

  mint(claims: { sub: string; audience: string; nonce?: string | undefined; email?: string | undefined; issuedAt?: Date; lifetimeSeconds?: number }): string {
    const token = `fake-google.${randomBytes(12).toString('base64url')}`;
    const issuedAt = claims.issuedAt ?? this.now();
    this.tokens.set(token, {
      sub: claims.sub,
      audience: claims.audience,
      nonce: claims.nonce,
      email: claims.email,
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + (claims.lifetimeSeconds ?? 3_600) * 1_000),
    });
    return token;
  }

  async verify(idToken: string, options: VerifyOptions): Promise<GoogleIdentity> {
    const claims = this.tokens.get(idToken);
    if (!claims) throw new GoogleIdTokenError('signature');
    if (claims.audience !== options.audience) throw new GoogleIdTokenError('audience');
    if (this.now() >= claims.expiresAt) throw new GoogleIdTokenError('expired');
    if (options.nonce !== undefined && claims.nonce !== options.nonce) throw new GoogleIdTokenError('nonce');
    if (options.maxAgeSeconds !== undefined && (this.now().getTime() - claims.issuedAt.getTime()) / 1_000 > options.maxAgeSeconds) {
      throw new GoogleIdTokenError('too_old');
    }
    return { sub: claims.sub, email: claims.email, emailVerified: claims.email !== undefined, issuedAt: claims.issuedAt, expiresAt: claims.expiresAt };
  }
}
