import { createHash, timingSafeEqual } from 'node:crypto';
import { REALTIME_DISCONNECT_REVOKED, realtimeConnectionMetaSchema, userChannel } from '@app/shared';
import type { DenyList, PublicIds } from '@app/shared/server';
import Fastify, { LogController } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import { withTimeout } from '../lib/timeout.js';

/**
 * Centrifugo's subscribe proxy: an internal listener of its own (its own
 * port, reached on the stack network only, no database pool, no plugins)
 * that Centrifugo asks before every subscription to a `user:` channel. It
 * reads Valkey only (`MGET deny:sid deny:uid`, the access-token deny list):
 *
 * - the person's own channel, with the connection token's `meta` (session
 *   and access-token issue time) not revoked: `{result: {}}`;
 * - someone else's channel, or not a personal channel: error 403;
 * - no or malformed `meta`, or a revoked session or account: disconnect
 *   4501, so that connection closes;
 * - Valkey not answering: error 503, temporary (fails closed; existing
 *   subscriptions are untouched and the client retries).
 *
 * Only subscriptions are checked here, never a connect: Centrifugo accepts
 * any unexpired connection token, and the 3005 kick of a revocation does not
 * void it. A copy of a revoked token can still open connections that never
 * subscribe (they receive nothing) and so hold some of the person's
 * connections under `client.user_connection_limit` until the token's `exp`
 * plus Centrifugo's close delay (REALTIME_EXPIRED_CLOSE_DELAY_SECONDS); a
 * short REALTIME_TOKEN_TTL_SECONDS keeps that window short.
 *
 * Every answer is HTTP 200 with JSON and never `{}` (an empty answer allows
 * the subscription). A request without the shared key gets HTTP 401 with no
 * body, which Centrifugo reports to the client as a temporary internal
 * error. Nothing of the request is logged.
 */

export const SUBSCRIBE_PROXY_PATH = '/internal/realtime/subscribe';
export const SUBSCRIBE_PROXY_KEY_HEADER = 'x-realtime-proxy-key';
/** Below Centrifugo's own timeout of the call (1 s), so a hung read answers temporary instead of nothing. */
const CHECK_TIMEOUT_MS = 800;

const requestSchema = z.looseObject({
  user: z.string(),
  channel: z.string(),
  meta: z.unknown().optional(),
});

const DENIED = { error: { code: 403, message: 'permission denied' } } as const;
const REVOKED = { disconnect: { code: REALTIME_DISCONNECT_REVOKED.code, reason: REALTIME_DISCONNECT_REVOKED.reason } } as const;
const UNAVAILABLE = { error: { code: 503, message: 'try again', temporary: true } } as const;
const ALLOWED = { result: {} } as const;

export interface SubscribeProxyOptions {
  denyList: Pick<DenyList, 'check'>;
  publicIds: PublicIds;
  /** The key Centrifugo sends in X-Realtime-Proxy-Key. */
  key: string;
  logger: Logger;
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

function ownChannel(user: string, channel: string): boolean {
  try {
    return channel === userChannel(user);
  } catch {
    return false;
  }
}

export async function buildSubscribeProxy(options: SubscribeProxyOptions) {
  const expected = digest(options.key);
  const proxy = Fastify({
    loggerInstance: options.logger.child({ part: 'realtime-proxy' }),
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 8_192,
    requestTimeout: 5_000,
    // Centrifugo's HTTP client keeps idle connections open without a timeout of its own.
    keepAliveTimeout: 600_000,
  });

  proxy.addHook('onRequest', async (request, reply) => {
    const sent = request.headers[SUBSCRIBE_PROXY_KEY_HEADER];
    if (typeof sent !== 'string' || !timingSafeEqual(digest(sent), expected)) {
      reply.code(401).send();
      return reply;
    }
    return undefined;
  });

  proxy.post(SUBSCRIBE_PROXY_PATH, async (request) => {
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return DENIED;
    const { user, channel, meta } = parsed.data;
    if (!ownChannel(user, channel)) return DENIED;
    const userId = options.publicIds.user.decodeId(user);
    if (userId === null) return DENIED;
    const connection = realtimeConnectionMetaSchema.safeParse(meta);
    if (!connection.success) return REVOKED;
    try {
      const verdict = await withTimeout(options.denyList.check(connection.data.sid, userId, new Date(connection.data.ati * 1_000)), CHECK_TIMEOUT_MS);
      return verdict === 'allowed' ? ALLOWED : REVOKED;
    } catch {
      request.log.warn('realtime subscribe check: the deny list could not be read');
      return UNAVAILABLE;
    }
  });

  return proxy;
}

export type SubscribeProxy = Awaited<ReturnType<typeof buildSubscribeProxy>>;
