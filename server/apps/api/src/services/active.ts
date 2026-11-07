import { accountStatus } from '@app/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpProblem } from '../lib/problem.js';
import type { AccountView } from './account.js';
import { accountProblem, sessionOf, unauthorized, type AppSession } from './session.js';

/**
 * `auth active`: an app session of an account whose status allows the
 * social routes (deck, swipes, likes, profiles). The status comes from the
 * cached own-account view (no statement when warm, one on a miss, which the
 * request's budget is given only when it happens):
 *
 * - active (3): allowed;
 * - snoozed (4): `403 snoozed` (existing conversations still work);
 * - onboarding and pending review (1, 2): `403 onboarding_incomplete`;
 * - suspended, banned or deleted: their own answer, with the reason.
 */

export interface ActiveAccount {
  session: AppSession;
  view: AccountView;
  /** A test account (users.flags 1): sees only test accounts, no quotas. */
  test: boolean;
}

const ACTIVE = accountStatus.code('active');
const SNOOZED = accountStatus.code('snoozed');
const ONBOARDING = new Set([accountStatus.code('onboarding'), accountStatus.code('pending_review')]);

/** The caller's account through the cached view; `allowSnoozed` for routes a snoozed account keeps (conversations). */
export async function activeAccount(app: FastifyInstance, request: FastifyRequest, options: { allowSnoozed?: boolean } = {}): Promise<ActiveAccount> {
  const session = sessionOf(app, request);
  const tally = request.pgTally;
  if (tally?.budget !== undefined) tally.budget += 1;
  const loaded = await app.account.load(session.userId);
  // A warm view sent no statement: the allowance goes back.
  if (loaded.cached && tally?.budget !== undefined) tally.budget -= 1;
  const result = loaded.result;
  if (result.kind !== 'account') {
    if (result.kind === 'deleted') throw await accountProblem(app.account, session.userId);
    throw unauthorized();
  }
  const status = result.view.status;
  if (status === ACTIVE || (status === SNOOZED && options.allowSnoozed)) {
    return { session, view: result.view, test: (result.view.flags & 1) !== 0 };
  }
  if (status === SNOOZED) throw new HttpProblem('snoozed');
  if (ONBOARDING.has(status)) throw new HttpProblem('onboarding_incomplete');
  // Suspended or banned with a token from before: the account's own answer (cached now, no statement).
  throw await accountProblem(app.account, session.userId);
}
