import { createHash } from 'node:crypto';
import { releasePushToken, withTransaction, writeDevice } from '@app/db';
import { deviceUpdateSchema } from '@app/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { scrubbed } from '../lib/dbErrors.js';
import { HttpProblem } from '../lib/problem.js';
import { requireScope, sessionOf } from '../services/session.js';

/**
 * `PUT /v1/devices/current`: the push token, build and language of the
 * session's device (the token's `did`). `dev:<did>` holds a fingerprint of
 * what was last written, so the weekly resend of an unchanged state costs
 * no statement; a change is one transaction: the token is released from any
 * other device row first (a shared phone that changed account), then this
 * row is updated only where something differs.
 *
 * The push token is never logged and never stored in Valkey (the
 * fingerprint is a hash).
 */

const DEVICE_TTL_SECONDS = 30 * 24 * 3_600;

export const deviceRoutes: FastifyPluginAsyncZod = async (app) => {
  const fullOnly = requireScope(app, app.account, ['full']);

  app.put(
    '/v1/devices/current',
    {
      preHandler: fullOnly,
      config: {
        pgBudget: 2,
        rateLimit: {
          max: 10,
          timeWindow: 3_600_000,
          keyGenerator: (request) => `device:${request.principal?.sessionId ?? request.clientIp ?? request.ip}`,
        },
      },
      schema: { tags: ['devices'], summary: 'Push token and build of this device', body: deviceUpdateSchema },
    },
    async (request, reply) => {
      const session = sessionOf(app, request);
      const deviceId = session.deviceId;
      if (!deviceId) throw new HttpProblem('bad_request', { detail: 'This session names no device; sign in again.' });
      const versionCode = request.client?.versionCode;
      if (versionCode === undefined) throw new HttpProblem('bad_request', { detail: 'The X-Client header is required.' });
      const body = request.body;
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([session.userId, body.pushToken, body.notificationsEnabled, versionCode, body.appVersion, body.locale]))
        .digest('base64url')
        .slice(0, 22);
      const key = app.keys.device(deviceId);
      let known: string | null = null;
      try {
        known = await app.redis.get(key);
      } catch (error) {
        request.log.warn({ err: error }, 'device: fingerprint unreadable');
      }
      if (known !== fingerprint) {
        const hash = body.pushToken === null ? null : createHash('sha256').update(body.pushToken).digest();
        const { outcome, released } = await scrubbed(() =>
          withTransaction(app.pg, async (tx) => {
            const released = hash ? await releasePushToken(tx, deviceId, hash) : [];
            const outcome = await writeDevice(tx, session.userId, deviceId, {
              pushToken: body.pushToken,
              pushTokenHash: hash,
              notificationsEnabled: body.notificationsEnabled,
              versionCode,
              locale: body.locale,
            });
            return { outcome, released };
          }),
        );
        if (!outcome.found) throw new HttpProblem('not_found', { detail: 'This device is not registered; sign in again.' });
        // The rows the token was taken from no longer match their cached fingerprints: their next report must write.
        if (released.length > 0) {
          await app.redis.del(...released.map((id) => app.keys.device(id))).catch((error: unknown) => request.log.warn({ err: error }, 'device: fingerprints not cleared'));
        }
        await app.redis.set(key, fingerprint, 'EX', DEVICE_TTL_SECONDS).catch((error: unknown) => request.log.warn({ err: error }, 'device: fingerprint not cached'));
      }
      return reply.code(204).send();
    },
  );
};
