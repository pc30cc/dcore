import { deleteAccount, type DeletionOutcome, type DeletionTarget } from '@app/db';
import { ACCOUNT_QUEUE, accountJobAttempts, accountJobIds, accountJobNames, utcDay } from '@app/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { scrubbed } from '../lib/dbErrors.js';
import { HttpProblem } from '../lib/problem.js';
import { deletionReasonLabels } from './labels.js';

/**
 * What every deletion does, whichever route asked for it (the app, the web
 * page by phone or by Google). The database part is one statement
 * (`deleteAccount`): status 7, sessions revoked, conversations ended,
 * discovery row removed. Then, once it is durable:
 *
 * - `deny:uid` with the deletion time as cutoff, so every access token
 *   issued before it stops at once (a restore session signed in later is
 *   not touched), and the sessions' refresh grace is forgotten;
 * - the own-account version, so `GET /v1/me` shows the deleted form;
 * - the jobs: the fan-out at once (peers' lists, `conversation_end`, the
 *   Centrifugo disconnect, the card and deck queue), the purge at the purge
 *   time.
 *
 * Asking again for an account already deleted runs these steps again with
 * the same times (they are idempotent): that is how a request whose steps
 * failed (Valkey down) is finished by sending it again. Until then the
 * periodic sweep queues the jobs too.
 */

export interface DeletionResult {
  userId: string;
  deletedAtMs: number;
  purgeAtMs: number;
  /** False when the account was deleted before this request. */
  fresh: boolean;
}

const EVENT_TTL_SECONDS = 400 * 86_400;

/** Deletes the account `target` names (null when there is none) and finishes the steps after it. */
export async function deleteAndFinish(
  app: FastifyInstance,
  request: FastifyRequest,
  target: DeletionTarget,
  via: 1 | 2,
  options: { reason?: string | undefined } = {},
): Promise<DeletionResult | null> {
  const outcome: DeletionOutcome = await scrubbed(() => deleteAccount(app.pg, target, via));
  if (outcome.kind === 'none') return null;
  const result: DeletionResult = {
    userId: outcome.userId,
    deletedAtMs: outcome.deletedAtMs,
    purgeAtMs: outcome.purgeAtMs,
    fresh: outcome.kind === 'deleted',
  };
  request.log.info({ via, fresh: result.fresh, ended: outcome.kind === 'deleted' ? outcome.ended.length : 0 }, 'account deleted');
  await finishDeletion(app, request, result, outcome.kind === 'deleted' ? outcome.sessionIds : []);
  if (result.fresh && options.reason !== undefined) await countReason(app, request, options.reason);
  return result;
}

/** The steps after the database part; throws `service_unavailable` when Valkey cannot take them. */
export async function finishDeletion(app: FastifyInstance, request: FastifyRequest, result: DeletionResult, sessionIds: readonly string[]): Promise<void> {
  const { userId, deletedAtMs, purgeAtMs } = result;
  try {
    await app.denyList.revokeUser(userId, new Date(deletedAtMs));
    await app.refreshGrace.forget(sessionIds);
    await app.jobs.add(ACCOUNT_QUEUE, accountJobNames.fanout, accountJobIds.fanout(userId, deletedAtMs), { userId, deletedAtMs }, {
      attempts: accountJobAttempts.fanout.attempts,
      backoffMs: accountJobAttempts.fanout.backoffMs,
    });
    await app.jobs.add(ACCOUNT_QUEUE, accountJobNames.purge, accountJobIds.purge(userId, deletedAtMs), { userId, deletedAtMs, purgeAtMs }, {
      delayMs: Math.max(0, purgeAtMs - Date.now()),
      attempts: accountJobAttempts.purge.attempts,
      backoffMs: accountJobAttempts.purge.backoffMs,
    });
  } catch (error) {
    request.log.error({ err: error }, 'deletion: the steps after the database could not be taken');
    throw new HttpProblem('service_unavailable', {
      detail: 'The account is deleted; send the request again to finish signing it out everywhere.',
      headers: { 'retry-after': '5' },
      cause: error,
    });
  }
  // Logged and carried on when it fails: the view expires by itself (24 h) and the cutoff above already ends the sessions.
  await app.account.changed(userId);
}

/**
 * The reason a person gave in the app, counted for the statistics under one
 * of the catalogue's keys (`ev:deletion.<key>:<day>`); anything else counts
 * as `other`. The text itself is never kept.
 */
async function countReason(app: FastifyInstance, request: FastifyRequest, reason: string): Promise<void> {
  const key = Object.hasOwn(deletionReasonLabels, reason) ? reason : 'other';
  const name = app.keys.raw('ev', `deletion.${key}`, utcDay(Date.now()));
  try {
    await app.redis.multi().incr(name).expire(name, EVENT_TTL_SECONDS).exec();
  } catch (error) {
    request.log.warn({ err: error }, 'deletion: reason not counted');
  }
}
