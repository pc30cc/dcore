import { ACTIVE_DAY_TTL_SECONDS, DailyMarks, utcDay } from '@app/shared/server';
import type { FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

/**
 * "Active today": every request of a signed-in person puts their raw id in
 * `la:<yyyymmdd>` (kv-core, 3 days), which the worker drains into
 * users.last_active_on at night (and the deck's recency with it) and the
 * statistics read (DAU, retention). At most one SADD per person per process
 * per UTC day (`DailyMarks`), not awaited, never changing an answer; a
 * failed write forgets the mark so the next request tries again.
 *
 * Only what a person does counts: a route the app calls from the
 * background (push registration, purchase sync and restore, the token
 * refresh, the ring report) says `config: { activity: false }`.
 * Registered right after the deny list, so a revoked token marks nothing.
 */

declare module 'fastify' {
  interface FastifyContextConfig {
    /** false: the app calls this route without the person (a background job); it does not mark them active. */
    activity?: boolean;
  }
}

export interface ActivityPluginOptions {
  /** The raw user id of an app token's subject (its public id), or null. */
  userIdOf: (subject: string) => string | null;
  now?: (() => number) | undefined;
  /** Marks kept per process before the set is dropped (default 200,000). */
  cap?: number | undefined;
}

export const activityPlugin = fp<ActivityPluginOptions>(
  async (app, { userIdOf, now = Date.now, cap }) => {
    const marks = new DailyMarks({ cap });
    app.addHook('onRequest', async (request: FastifyRequest) => {
      const principal = request.principal;
      if (principal?.kind !== 'app' || request.routeOptions.config?.activity === false) return;
      const uid = userIdOf(principal.subject);
      if (uid === null) return;
      const day = utcDay(now());
      if (!marks.mark(day, uid)) return;
      const key = app.keys.activeDay(day);
      app.redis
        .multi()
        .sadd(key, uid)
        .expire(key, ACTIVE_DAY_TTL_SECONDS, 'NX')
        .exec()
        .then((replies) => {
          const failed = replies?.find(([error]) => error !== null)?.[0];
          if (failed) throw failed;
        })
        .catch((error: unknown) => {
          marks.forget(day, uid);
          request.log.debug({ err: error }, 'activity not marked');
        });
    });
  },
  { name: 'activity', fastify: '5.x', dependencies: ['deny-list'] },
);
