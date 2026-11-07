import type { AuthResult, GoogleNonce } from '@app/shared';
import { GoogleIdTokenError, hashDomains, randomToken, type Limit } from '@app/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpProblem } from '../lib/problem.js';
import { ipSegment } from './otp.js';
import { signIn, type DeviceBody } from './sessions.js';

/**
 * Google sign-in, play build only (the bazaar build has no Google sign-in,
 * and its routes answer `403 store_not_supported`). The app asks for a
 * nonce, has Google put it in the ID token, and sends the token back; the
 * nonce works once (`gn:<nonceId>`, 5 minutes). The account is found by
 * the keyed hash of Google's `sub`, never by the e-mail, which is not kept.
 */

const NONCE_TTL_SECONDS = 300;
const HOUR_MS = 3_600_000;

function playOnly(app: FastifyInstance, request: FastifyRequest): string {
  if (request.client?.store !== 'play') throw new HttpProblem('store_not_supported', { detail: 'Google sign-in is offered in the Google Play build only.' });
  const audience = app.config.google.webClientId;
  if (!audience || !app.google) throw new HttpProblem('service_unavailable', { detail: 'Google sign-in is not configured.' });
  return audience;
}

async function countIp(app: FastifyInstance, request: FastifyRequest, route: string): Promise<void> {
  const limit: Limit = { name: `google_${route}`, key: app.keys.signInIpLimit(`g${route}`, ipSegment(request)), cap: app.authSettings.get().caps.verify_ip_hourly, windowMs: HOUR_MS };
  let verdict;
  try {
    verdict = await app.limits.take([limit]);
  } catch (error) {
    throw new HttpProblem('service_unavailable', { detail: 'Sign-in is unavailable right now.', headers: { 'retry-after': '30' }, cause: error });
  }
  if (!verdict.ok) {
    const retryAfterSeconds = Math.max(1, Math.ceil(verdict.retryAfterMs / 1_000));
    throw new HttpProblem('rate_limited', { retryAfterSeconds, headers: { 'retry-after': String(retryAfterSeconds) } });
  }
}

export async function googleNonce(app: FastifyInstance, request: FastifyRequest): Promise<GoogleNonce> {
  playOnly(app, request);
  await countIp(app, request, 'n');
  const nonceId = randomToken(12);
  const nonce = randomToken(24);
  try {
    await app.redis.set(app.keys.googleNonce(nonceId), nonce, 'EX', NONCE_TTL_SECONDS);
  } catch (error) {
    throw new HttpProblem('service_unavailable', { detail: 'Sign-in is unavailable right now.', cause: error });
  }
  return { nonceId, nonce, ttlSeconds: NONCE_TTL_SECONDS };
}

export async function googleSignIn(
  app: FastifyInstance,
  request: FastifyRequest,
  body: DeviceBody & { idToken: string; nonceId: string },
): Promise<AuthResult> {
  const audience = playOnly(app, request);
  await countIp(app, request, 's');
  let nonce: string | null;
  try {
    nonce = await app.redis.getdel(app.keys.googleNonce(body.nonceId));
  } catch (error) {
    throw new HttpProblem('service_unavailable', { detail: 'Sign-in is unavailable right now.', cause: error });
  }
  if (nonce === null) throw new HttpProblem('google_token_invalid', { detail: 'The sign-in expired; start again.' });
  let identity;
  try {
    identity = await (app.google ?? { verify: () => Promise.reject(new GoogleIdTokenError('unavailable')) }).verify(body.idToken, { audience, nonce });
  } catch (error) {
    if (error instanceof GoogleIdTokenError) {
      request.log.info({ reason: error.reason }, 'google token refused');
      if (error.reason === 'unavailable') throw new HttpProblem('service_unavailable', { detail: 'Google could not be reached.', cause: error });
      throw new HttpProblem('google_token_invalid');
    }
    throw error;
  }
  return signIn(
    app,
    request,
    { provider: 2, hashes: app.secrets.hasher.hashAll(hashDomains.google, identity.sub), sealed: null, testAccount: false },
    body,
  );
}
