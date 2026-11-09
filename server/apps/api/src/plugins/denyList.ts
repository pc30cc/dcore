import type { DenyList } from '@app/shared/server';
import type { FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { TokenError } from '../auth/tokens.js';

/**
 * Applies the access-token deny list (`deny:sid`, `deny:uid` in Valkey) to
 * every request whose token verified: one MGET per authenticated request. A
 * revoked token leaves the request without a principal, so `requireUser`
 * answers 401 and the app refreshes; a revoked session cannot refresh.
 *
 * When Valkey cannot be read an app request goes on (logged): access
 * tokens live 15 minutes, and refusing everyone during a Valkey outage would
 * take the whole API down with it. `failClosed` turns that around; admin
 * tokens always fail closed (a revoked admin session must never get through,
 * and the panel cannot sign in without Valkey anyway).
 */

export interface DenyListPluginOptions {
  denyList: DenyList;
  /** The raw user id of an app token's subject (its public id), or null when it is not one. */
  userIdOf: (subject: string) => string | null;
  failClosed?: boolean | undefined;
}

export const denyListPlugin = fp<DenyListPluginOptions>(
  async (app, { denyList, userIdOf, failClosed = false }) => {
    app.addHook('onRequest', async (request: FastifyRequest) => {
      const principal = request.principal;
      if (!principal) return;
      const userId = principal.kind === 'app' ? userIdOf(principal.subject) : null;
      let verdict: Awaited<ReturnType<DenyList['check']>>;
      try {
        verdict = await denyList.check(principal.sessionId, userId, principal.issuedAt);
      } catch (error) {
        request.log.warn({ err: error }, 'deny list unreadable');
        if (!failClosed && principal.kind !== 'admin') return;
        verdict = 'session_revoked';
      }
      if (verdict === 'allowed') return;
      request.principal = null;
      request.authFailure = new TokenError('revoked', verdict === 'session_revoked' ? 'session revoked' : 'user revoked');
    });
  },
  { name: 'deny-list', fastify: '5.x', dependencies: ['auth'] },
);
