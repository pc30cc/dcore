import { realtimeTokenSchema, userChannel, wireTime } from '@app/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { SignJWT } from 'jose';
import { HttpProblem } from '../lib/problem.js';
import { requireScope, sessionOf } from '../services/session.js';

/**
 * `POST /v1/realtime/token`: a Centrifugo connection token for the person's
 * one channel, `u:#<publicUid>`. HS256 with the secret Centrifugo verifies
 * it with; `sub` is the public id, it expires after
 * REALTIME_TOKEN_TTL_SECONDS and carries no `info`. No statement, no Valkey.
 */
export const realtimeRoutes: FastifyPluginAsyncZod = async (app) => {
  const fullOnly = requireScope(app, app.account, ['full']);
  const { tokenSecret, tokenTtlSeconds } = app.config.realtime;
  const secret = tokenSecret === undefined ? undefined : new TextEncoder().encode(tokenSecret);
  const wsUrl =
    app.config.realtime.wsUrl ?? (app.brand.domains.realtime ? `wss://${app.brand.domains.realtime}/connection/websocket` : undefined);
  if (!secret || !wsUrl) app.log.warn('realtime: CENTRIFUGO_TOKEN_HMAC_SECRET or the realtime host is not set; POST /v1/realtime/token answers 503');

  app.post(
    '/v1/realtime/token',
    {
      preHandler: fullOnly,
      config: {
        pgBudget: 0,
        rateLimit: {
          max: 30,
          timeWindow: 3_600_000,
          keyGenerator: (request) => `rt:${request.principal?.sessionId ?? request.clientIp ?? request.ip}`,
        },
      },
      schema: { tags: ['realtime'], summary: 'A connection token for the personal channel', response: { 200: realtimeTokenSchema } },
    },
    async (request) => {
      const session = sessionOf(app, request);
      if (!secret || !wsUrl) throw new HttpProblem('service_unavailable', { detail: 'Realtime is not configured.' });
      const now = Math.floor(Date.now() / 1_000);
      const exp = now + tokenTtlSeconds;
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(session.publicUid)
        .setIssuedAt(now)
        .setExpirationTime(exp)
        .sign(secret);
      return { wsUrl, token, expiresAt: wireTime(exp * 1_000), channel: userChannel(session.publicUid) };
    },
  );
};
