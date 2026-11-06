import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { TokenError, type AccessTokens, type Principal } from '../auth/tokens.js';
import { HttpProblem } from '../lib/problem.js';

/** A preHandler that lets the request through or throws a 401/403 problem. */
export type AuthGuard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

declare module 'fastify' {
  interface FastifyRequest {
    /** The verified bearer of the request's access token, or null. */
    principal: Principal | null;
    /** Why the request's access token was refused, if it had one. */
    authFailure: TokenError | null;
  }
  interface FastifyInstance {
    tokens: AccessTokens;
    /** preHandler: the request must carry a valid user token. */
    requireUser: AuthGuard;
    /** preHandler: the request must carry a valid admin token with one of `roles` (any role when empty). */
    requireAdmin(...roles: string[]): AuthGuard;
  }
}

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

function unauthorized(failure: TokenError | null): HttpProblem {
  if (failure?.reason === 'expired') {
    return new HttpProblem('token_expired', {
      headers: { 'www-authenticate': 'Bearer error="invalid_token", error_description="The access token expired"' },
    });
  }
  return new HttpProblem('unauthorized', {
    headers: { 'www-authenticate': failure ? 'Bearer error="invalid_token"' : 'Bearer' },
  });
}

/**
 * Reads `Authorization: Bearer <jwt>` on every request and verifies it in
 * memory: no database read, no network. A request without a token, or with a
 * bad one, simply has no principal; routes that need one say so with
 * `app.requireUser` or `app.requireAdmin()`. Registered before the rate
 * limiter, which keys signed-in traffic by subject rather than by IP.
 */
export const authPlugin = fp<{ tokens: AccessTokens }>(
  async (app, { tokens }) => {
    app.decorate('tokens', tokens);
    app.decorateRequest('principal', null);
    app.decorateRequest('authFailure', null);

    app.addHook('onRequest', async (request: FastifyRequest) => {
      const header = request.headers.authorization;
      if (header === undefined) return;
      const match = BEARER.exec(header);
      if (!match?.[1]) {
        request.authFailure = new TokenError('invalid', 'malformed Authorization header');
        return;
      }
      try {
        request.principal = await tokens.verify(match[1]);
      } catch (error) {
        request.authFailure = error instanceof TokenError ? error : new TokenError('invalid', 'token rejected', { cause: error });
        request.log.debug({ reason: request.authFailure.reason }, 'access token refused');
      }
    });

    app.decorate('requireUser', async (request: FastifyRequest, _reply: FastifyReply) => {
      if (request.principal?.kind !== 'app') {
        throw unauthorized(request.principal ? new TokenError('invalid', 'not a user token') : request.authFailure);
      }
    });

    app.decorate('requireAdmin', (...roles: string[]): AuthGuard => {
      return async (request: FastifyRequest, _reply: FastifyReply) => {
        const principal = request.principal;
        if (principal?.kind !== 'admin') {
          throw unauthorized(principal ? new TokenError('invalid', 'not an admin token') : request.authFailure);
        }
        if (roles.length > 0 && !roles.some((role) => principal.roles.includes(role))) {
          throw new HttpProblem('forbidden', {
            detail: 'Your role does not allow this action.',
            headers: { 'www-authenticate': 'Bearer error="insufficient_scope"' },
          });
        }
      };
    });
  },
  { name: 'auth', fastify: '5.x' },
);
