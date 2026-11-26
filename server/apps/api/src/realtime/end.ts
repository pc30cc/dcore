import { ACCOUNT_QUEUE, accountJobAttempts, accountJobIds, accountJobNames, type RealtimeEndData } from '@app/shared/server';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

/**
 * The realtime side of a revocation (sign-out, refresh reuse, under-age
 * closure, deletion, sign-out by an admin, a restriction): every connection
 * of the person expires (Centrifugo answers 3005), so apps ask for a new
 * connection token, which a revoked session or account does not get. It
 * runs after the deny list was written. A kick that fails is queued as the
 * worker's `realtime-end` job, retried for longer than a connection token
 * lives; the subscribe check refuses the old token meanwhile.
 */

type RealtimeApp = Pick<FastifyInstance, 'realtime' | 'publicIds' | 'jobs'>;

/** Queues the kick for the worker (each revocation its own job). */
export async function queueRealtimeEnd(app: RealtimeApp, userId: string): Promise<void> {
  const atMs = Date.now();
  await app.jobs.add(ACCOUNT_QUEUE, accountJobNames.realtimeEnd, accountJobIds.realtimeEnd(userId, atMs), { userId, atMs } satisfies RealtimeEndData, {
    attempts: accountJobAttempts.realtimeEnd.attempts,
    backoffMs: accountJobAttempts.realtimeEnd.backoffMs,
  });
}

/** Expires every connection of the person now, or queues it; throws only when neither worked. */
export async function endRealtime(app: RealtimeApp, log: FastifyBaseLogger, userId: string): Promise<void> {
  if (!app.realtime) return;
  try {
    await app.realtime.disconnect(app.publicIds.user.encode(userId));
  } catch (error) {
    log.warn({ err: error }, 'realtime end: the kick failed; queued for the worker');
    await queueRealtimeEnd(app, userId);
  }
}
