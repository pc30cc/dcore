import { accountStatus, appStores, store as storeCodes, wireTime, type AppStore } from '@app/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionScope } from '../auth/tokens.js';
import { HttpProblem } from '../lib/problem.js';
import type { AccountStore } from './account.js';

/**
 * Who is calling an account route: the user (raw id and public id), the
 * session, its device and store, and what its scope allows. Routes declare
 * the scopes they serve: `full` for the own-profile edits, plus
 * `restricted` for the reads a suspended or banned person still needs (their
 * account, the reasons, appeals, consents), plus `restore` for the minimal
 * account read of a deleted account in its grace period. A session outside
 * a route's scopes gets the account's own answer: `account_suspended` or
 * `account_banned` with the reason and the action to appeal,
 * `account_deleted` with the date until which it can be restored.
 */

export interface AppSession {
  userId: string;
  publicUid: string;
  sessionId: string;
  deviceId: string | undefined;
  storeCode: number | undefined;
  store: AppStore | undefined;
  scope: SessionScope;
}

declare module 'fastify' {
  interface FastifyRequest {
    appSession: AppSession | null;
  }
}

const APP_STORE_CODES = new Map<number, AppStore>(appStores.map((name) => [storeCodes.code(name), name]));

export function unauthorized(): HttpProblem {
  return new HttpProblem('unauthorized', { headers: { 'www-authenticate': 'Bearer error="invalid_token"' } });
}

/** The caller of an app route; 401 without a valid app token. */
export function sessionOf(app: FastifyInstance, request: FastifyRequest): AppSession {
  if (request.appSession) return request.appSession;
  const principal = request.principal;
  if (principal?.kind !== 'app') throw unauthorized();
  const userId = app.publicIds.user.decodeId(principal.subject);
  if (userId === null) throw unauthorized();
  const storeCode = principal.storeCode;
  const store = (storeCode !== undefined ? APP_STORE_CODES.get(storeCode) : undefined) ?? request.client?.store;
  const session: AppSession = {
    userId,
    publicUid: principal.subject,
    sessionId: principal.sessionId,
    deviceId: principal.deviceId,
    storeCode: storeCode ?? (store ? storeCodes.code(store) : undefined),
    store,
    scope: principal.scope,
  };
  request.appSession = session;
  return session;
}

/** The problem a session outside a route's scopes gets, from the account's own state. */
export async function accountProblem(account: AccountStore, userId: string): Promise<HttpProblem> {
  const loaded = await account.load(userId);
  const result = loaded.result;
  if (result.kind === 'deleted') {
    return new HttpProblem('account_deleted', { extensions: { restorableUntil: wireTime(result.purgeAtMs) } });
  }
  if (result.kind !== 'account') return unauthorized();
  const status = accountStatus.name(result.view.status);
  if (status === 'suspended' || status === 'banned') {
    const wanted = status === 'banned' ? 3 : 2;
    const action = result.view.moderation.find((a) => a.kind === wanted) ?? result.view.moderation[0];
    if (!action) {
      return new HttpProblem('forbidden', { detail: 'This account cannot use this feature now.' });
    }
    return new HttpProblem(status === 'banned' ? 'account_banned' : 'account_suspended', {
      extensions: {
        reasonText: action.reasonText,
        actionId: action.id,
        ...(action.endsAtMs !== undefined ? { until: wireTime(action.endsAtMs) } : {}),
        appealable: action.appeal === undefined,
      },
    });
  }
  // The token's scope is older than the account's state (a lifted ban): a refresh brings the new one.
  return unauthorized();
}

export type AccountGuard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** preHandler: an app session whose scope is one of `scopes`. */
export function requireScope(app: FastifyInstance, account: AccountStore, scopes: readonly SessionScope[]): AccountGuard {
  return async (request, reply) => {
    // The auth plugin's own answer first (401 token_expired tells the app to refresh).
    await app.requireUser(request, reply);
    const session = sessionOf(app, request);
    if (!scopes.includes(session.scope)) throw await accountProblem(account, session.userId);
  };
}
