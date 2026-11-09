import {
  PubSubAuthError,
  PubSubOidcVerifier,
  decodeRtdn,
  iapJobIds,
  pubsubPushSchema,
  pushMessageId,
  type PubSubPush,
  type PubSubPushAuthenticator,
} from '@app/shared/server';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { HttpProblem } from '../../lib/problem.js';

/**
 * `POST /v1/webhooks/play/rtdn`: Google Play's real-time developer
 * notifications, pushed by a Pub/Sub push subscription with authentication.
 *
 * Before the body is read, the OIDC token in `Authorization` must verify
 * (Google's signature, `exp`, `iss`, `aud` = `PLAY_RTDN_AUDIENCE`, `email` =
 * `PLAY_RTDN_PUSH_SA_EMAIL`, `email_verified`): 401 otherwise, which Pub/Sub
 * delivers again later. Then, without a statement:
 *
 * - a message whose data is not a notification of our package, or a test
 *   notification, is acknowledged (204) and dropped: delivering it again
 *   cannot change it;
 * - `rtdn:<messageId>` is set NX for 7 days: a message seen before is
 *   acknowledged and nothing else happens (no job, no write);
 * - otherwise one `iap` job `rtdn.<messageId>` carries the raw data to the
 *   worker, which reads the purchase from the Developer API and writes only
 *   a change; 204.
 *
 * Play not configured: 503 `store_unavailable` (Pub/Sub keeps the message
 * and tries again). Valkey or the queue down: the mark is taken back and
 * 503 answers, so nothing is lost.
 */

export interface PlayRtdnOptions {
  /** The push authenticator (tests pass one on a fake key set); otherwise from `PLAY_RTDN_*`, none without them. */
  authenticator?: PubSubPushAuthenticator | null | undefined;
}

const SEEN_SECONDS = 7 * 86_400;

export const playRtdnRoutes: FastifyPluginAsync<PlayRtdnOptions> = async (app, options) => {
  const play = app.config.store.play;
  const authenticator =
    options.authenticator !== undefined
      ? options.authenticator
      : play?.rtdn
        ? new PubSubOidcVerifier({ audience: play.rtdn.audience, serviceAccountEmail: play.rtdn.pushServiceAccountEmail })
        : null;
  const packageName = play?.packageName;
  if (play && !play.rtdn) app.log.warn('store: PLAY_RTDN_AUDIENCE and PLAY_RTDN_PUSH_SA_EMAIL are not set; Play notifications are refused (503)');

  // Authentication before the body is parsed: an unauthenticated sender never gets its JSON read.
  const authenticate = async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!authenticator || !packageName) throw new HttpProblem('store_unavailable', { detail: 'Google Play notifications are not configured.', headers: { 'retry-after': '600' } });
    try {
      await authenticator.verify(request.headers.authorization);
    } catch (error) {
      if (error instanceof PubSubAuthError) {
        if (error.reason === 'unavailable') {
          request.log.warn({ reason: error.reason }, 'play rtdn: Google\'s keys cannot be fetched');
          throw new HttpProblem('store_unavailable', { detail: 'Try again later.', headers: { 'retry-after': '30' } });
        }
        request.log.warn({ reason: error.reason }, 'play rtdn: push refused');
        throw new HttpProblem('unauthorized', { detail: 'The push token does not verify.' });
      }
      throw error;
    }
  };

  app.post(
    '/v1/webhooks/play/rtdn',
    {
      onRequest: authenticate,
      config: { pgBudget: 0, rateLimit: false },
      schema: { tags: ['webhooks'], summary: 'Google Play real-time developer notifications (Pub/Sub push)' },
    },
    async (request, reply) => {
      const parsed = pubsubPushSchema.safeParse(request.body);
      if (!parsed.success) {
        request.log.warn('play rtdn: the push is not a Pub/Sub message; dropped');
        return reply.code(204).send();
      }
      const push: PubSubPush = parsed.data;
      const decoded = decodeRtdn(push.message.data);
      if (!decoded) {
        request.log.warn('play rtdn: the message is not a developer notification; dropped');
        return reply.code(204).send();
      }
      if (decoded.packageName !== packageName) {
        request.log.warn('play rtdn: a notification of another package; dropped');
        return reply.code(204).send();
      }
      if (decoded.event.kind === 'test') {
        request.log.info('play rtdn: test notification received');
        return reply.code(204).send();
      }
      const messageId = pushMessageId(push);
      const mark = app.keys.rtdnSeen(messageId);
      let first: string | null;
      try {
        first = await app.redis.set(mark, '1', 'EX', SEEN_SECONDS, 'NX');
      } catch (error) {
        request.log.warn({ err: error }, 'play rtdn: Valkey unavailable');
        throw new HttpProblem('store_unavailable', { detail: 'Try again later.', headers: { 'retry-after': '10' } });
      }
      if (first !== 'OK') return reply.code(204).send();
      try {
        await app.jobs.add(
          'iap',
          'rtdn',
          iapJobIds.rtdn(messageId),
          { messageId, data: push.message.data, ...((push.message.publishTime ?? push.message.publish_time) ? { publishTime: push.message.publishTime ?? push.message.publish_time } : {}) },
          { attempts: 10, backoffMs: 30_000 },
        );
      } catch (error) {
        await app.redis.del(mark).catch(() => undefined);
        request.log.warn({ err: error }, 'play rtdn: not queued; Pub/Sub delivers it again');
        throw new HttpProblem('store_unavailable', { detail: 'Try again later.', headers: { 'retry-after': '10' } });
      }
      request.log.info({ kind: decoded.event.kind }, 'play rtdn: queued');
      return reply.code(204).send();
    },
  );
};
