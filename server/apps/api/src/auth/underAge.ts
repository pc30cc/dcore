import { closeUnderAge, withTransaction } from '@app/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpProblem } from '../lib/problem.js';
import { nextId } from './sessions.js';

/**
 * The under-18 rule. Onboarding (`PUT /v1/me/basics`) calls
 * {@link isUnderAge} with the birth date the person typed and, when it
 * holds, {@link refuseUnderAge} before storing anything: the account
 * becomes a tombstone at once (status 8, `deleted_via` 4, no birth date or
 * gender ever stored), its number (or Google account) and this build's
 * device key are refused for a year in `device_bans` (so losing Valkey
 * forgets nothing), its sessions, devices and identities are deleted, and
 * its access tokens stop at once (`deny:uid`). `minor:<phoneHash>` and
 * `minor:d:<deviceKeyHash>` in Valkey are only a cache of the refusal; no
 * sign-in path reads them. Sign-in reads the bans themselves, at otp/verify
 * (otp/start answers a refused number like any other, so it tells no one
 * which numbers are refused).
 *
 * The database refuses an under-age birth date on its own too (CHECK
 * `users_adult`, against the sign-up time the id carries).
 */

const YEAR_SECONDS = 366 * 86_400;

/** True when `birthDate` (YYYY-MM-DD) is less than 18 years before `today` (UTC). */
export function isUnderAge(birthDate: string, today: Date = new Date()): boolean {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(birthDate);
  if (!match) throw new RangeError('birth date must be YYYY-MM-DD');
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1;
  const d = today.getUTCDate();
  const age = y - year - (m < month || (m === month && d < day) ? 1 : 0);
  return age < 18;
}

/**
 * Closes the calling account for age (see above). Returns false when the
 * account was no longer in onboarding or its basics were already set
 * (nothing changed). 4 statements in one transaction.
 */
export async function refuseUnderAge(app: FastifyInstance, request: FastifyRequest): Promise<boolean> {
  const principal = request.principal;
  const userId = principal ? app.publicIds.user.decodeId(principal.subject) : null;
  if (!principal || userId === null) throw new HttpProblem('unauthorized');
  const result = await withTransaction(app.pg, (tx) =>
    closeUnderAge(tx, {
      userId,
      deviceId: principal.deviceId ?? null,
      banIds: [nextId(app), nextId(app), nextId(app)],
      reason: 'under_age',
    }),
  );
  if (!result.closed) return false;
  request.log.info('account closed: under age');
  try {
    await app.denyList.revokeUser(userId);
    const pipeline = app.redis.multi();
    for (const hash of result.phoneHashes) pipeline.set(app.keys.minorPhone(hash.toString('hex')), '1', 'EX', YEAR_SECONDS);
    for (const hash of result.deviceHashes) pipeline.set(app.keys.minorDevice(hash.toString('hex')), '1', 'EX', YEAR_SECONDS);
    pipeline.del(...[principal.sessionId, ...result.sessionIds].map((sid) => app.keys.refreshGrace(sid)));
    await pipeline.exec();
  } catch (error) {
    // The database holds the refusal and the sessions are gone (no refresh works); only the cache is missing.
    request.log.error({ err: error }, 'under age: Valkey not written');
  }
  return true;
}
