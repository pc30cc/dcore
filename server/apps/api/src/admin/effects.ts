import { realtimeEnvelope, userChannel, type RealtimeEventType, type SideEffects } from '@app/shared';
import { IdGeneratorUnavailableError } from '@app/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpProblem } from '../lib/problem.js';
import { ModerationActions } from '../services/moderationActions.js';

/**
 * What an admin write does once its transaction (and audit row) committed:
 * the Valkey and realtime side (deny list, deck and list visibility,
 * Centrifugo). That side never runs inside the transaction, and its failure
 * never undoes the write: the database state is final and the app side
 * converges by itself (a refresh reads the account from the database, the
 * minute visibility check drops hidden peers, decks refill). The route
 * answers its normal result with `sideEffects: 'failed'` and the error is
 * logged with the route and the row.
 */

/** Runs the after-commit side of a write; `'failed'` (logged at error) when any step throws. */
export async function afterCommit(
  request: FastifyRequest,
  label: string,
  fn: () => Promise<unknown>,
  context: Record<string, unknown> = {},
): Promise<SideEffects> {
  try {
    await fn();
    return 'done';
  } catch (error) {
    request.log.error({ err: error, route: request.routeOptions.url, step: label, ...context }, 'admin write: committed, but its after-commit side failed');
    return 'failed';
  }
}

/** The worse of several after-commit results. */
export function worst(...results: SideEffects[]): SideEffects {
  return results.includes('failed') ? 'failed' : 'done';
}

/**
 * Runs `fn`, which mints ids from the app's lease (`app.ids.nextId()`); no
 * lease (Valkey unreachable at start) answers 503 with a retry hint
 * instead of a 500.
 */
export async function withIdLease<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof IdGeneratorUnavailableError) {
      throw new HttpProblem('service_unavailable', { detail: 'Try again in a moment.', headers: { 'retry-after': '2' }, cause: error });
    }
    throw error;
  }
}

const actions = new WeakMap<FastifyInstance, ModerationActions>();

/** The app's moderation actions (one instance per app; live calls of ended conversations end with them). */
export function adminModeration(app: FastifyInstance): ModerationActions {
  let instance = actions.get(app);
  if (!instance) {
    instance = new ModerationActions({ ...appClients(app), calls: app.calls, log: app.log });
    actions.set(app, instance);
  }
  return instance;
}

function appClients(app: FastifyInstance) {
  return {
    pg: app.pg,
    redis: app.redis,
    cache: app.cache,
    keys: app.keys,
    publicIds: app.publicIds,
    realtime: app.realtime,
    denyList: app.denyList,
    ids: app.ids,
    jobs: app.jobs,
  };
}

/** Publishes one event on the person's channel (nothing without Centrifugo); throws on a failed publish. */
export async function publishToUser<T extends RealtimeEventType>(
  app: FastifyInstance,
  userId: string,
  type: T,
  data: Parameters<typeof realtimeEnvelope<T>>[3],
): Promise<boolean> {
  if (!app.realtime) return false;
  const envelope = realtimeEnvelope(type, app.ids.nextId(), Date.now(), data);
  await app.realtime.publish(userChannel(app.publicIds.user.encode(userId)), envelope);
  return true;
}
