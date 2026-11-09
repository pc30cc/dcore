import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { GOOGLE_ISSUERS, GOOGLE_JWKS_URL } from './googleIdToken.js';

/**
 * Authentication of Pub/Sub push requests (Google Play's real-time
 * developer notifications). A push subscription with authentication sends
 * `Authorization: Bearer <OIDC token>`, a Google-signed RS256 JWT. A request
 * is accepted only when:
 *
 * - the signature verifies against Google's published keys (fetched once
 *   and cached; a key id not in the cache fetches them again, at most every
 *   30 seconds) and `exp` has not passed (`iat` alone is not checked: the
 *   token may be up to an hour old);
 * - `iss` is `accounts.google.com` or `https://accounts.google.com`;
 * - `aud` is the audience configured on the push subscription;
 * - `email` is the push subscription's service account and
 *   `email_verified` is true (Google's samples send a boolean or the
 *   string "true"): the JWT libraries do not check these two.
 */

export type PubSubAuthFailure = 'missing' | 'malformed' | 'signature' | 'expired' | 'issuer' | 'audience' | 'email' | 'email_unverified' | 'unavailable';

export class PubSubAuthError extends Error {
  readonly reason: PubSubAuthFailure;

  constructor(reason: PubSubAuthFailure, options?: ErrorOptions) {
    super(`Pub/Sub push token refused: ${reason}`, options);
    this.name = 'PubSubAuthError';
    this.reason = reason;
  }
}

export interface PubSubPushClaims {
  email: string;
  audience: string;
  subject: string | undefined;
  issuedAt: Date | undefined;
  expiresAt: Date;
}

export interface PubSubPushAuthenticator {
  /** The `Authorization` header of a push request; throws `PubSubAuthError`. */
  verify(authorization: string | undefined): Promise<PubSubPushClaims>;
}

export interface PubSubOidcOptions {
  /** The audience the push subscription was created with (we use the endpoint's full URL). */
  audience: string;
  /** The service account the push subscription authenticates as. */
  serviceAccountEmail: string;
  /** Google's keys; tests pass a local key set or a fake server's URL. Default: Google's JWKS, cached 6 h. */
  keys?: JWTVerifyGetKey | undefined;
  jwksUrl?: string | undefined;
  clockToleranceSeconds?: number | undefined;
  now?: (() => Date) | undefined;
}

export class PubSubOidcVerifier implements PubSubPushAuthenticator {
  private readonly keys: JWTVerifyGetKey;
  private readonly audience: string;
  private readonly email: string;
  private readonly tolerance: number;
  private readonly now: () => Date;

  constructor(options: PubSubOidcOptions) {
    if (!options.audience || !options.serviceAccountEmail) throw new Error('PubSubOidcVerifier needs an audience and a service account e-mail');
    this.audience = options.audience;
    this.email = options.serviceAccountEmail.trim().toLowerCase();
    this.keys =
      options.keys ??
      createRemoteJWKSet(new URL(options.jwksUrl ?? GOOGLE_JWKS_URL), { cooldownDuration: 30_000, cacheMaxAge: 6 * 3_600_000, timeoutDuration: 5_000 });
    this.tolerance = options.clockToleranceSeconds ?? 60;
    this.now = options.now ?? (() => new Date());
  }

  async verify(authorization: string | undefined): Promise<PubSubPushClaims> {
    if (!authorization) throw new PubSubAuthError('missing');
    const match = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization.trim());
    if (!match) throw new PubSubAuthError('malformed');
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(match[1]!, this.keys, {
        algorithms: ['RS256'],
        issuer: GOOGLE_ISSUERS,
        audience: this.audience,
        clockTolerance: this.tolerance,
        currentDate: this.now(),
        requiredClaims: ['exp', 'email'],
      }));
    } catch (error) {
      throw new PubSubAuthError(failureOf(error), { cause: error });
    }
    const email = payload['email'];
    if (typeof email !== 'string' || email.trim().toLowerCase() !== this.email) throw new PubSubAuthError('email');
    const verified = payload['email_verified'];
    if (verified !== true && verified !== 'true') throw new PubSubAuthError('email_unverified');
    const iat = payload['iat'];
    const sub = payload['sub'];
    return {
      email,
      audience: this.audience,
      subject: typeof sub === 'string' ? sub : undefined,
      issuedAt: typeof iat === 'number' ? new Date(iat * 1_000) : undefined,
      expiresAt: new Date((payload['exp'] as number) * 1_000),
    };
  }
}

function failureOf(error: unknown): PubSubAuthFailure {
  if (error instanceof joseErrors.JWTExpired) return 'expired';
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    if (error.claim === 'aud') return 'audience';
    if (error.claim === 'iss') return 'issuer';
    if (error.claim === 'email') return 'email';
    return 'malformed';
  }
  if (error instanceof joseErrors.JWSSignatureVerificationFailed || error instanceof joseErrors.JWKSNoMatchingKey || error instanceof joseErrors.JOSEAlgNotAllowed) return 'signature';
  // Google's keys could not be fetched (a timeout, a network error, a bad answer): not the sender's fault.
  if (error instanceof joseErrors.JWKSTimeout || error instanceof joseErrors.JWKSInvalid || !(error instanceof joseErrors.JOSEError)) return 'unavailable';
  if (error.code === 'ERR_JOSE_GENERIC' && error.message.includes('JSON Web Key Set')) return 'unavailable';
  return 'malformed';
}
