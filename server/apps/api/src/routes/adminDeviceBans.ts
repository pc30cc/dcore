import { adminBanFromUser, adminBanPhone, adminDeleteDeviceBan, adminDeviceBanList, adminPhoneBans, type AdminDeviceBanRow, type CreatedBan } from '@app/db';
import {
  PENALTY_MAX_DAYS,
  adminDeviceBanCreateSchema,
  adminDeviceBanDeleteSchema,
  adminDeviceBanListQuerySchema,
  adminDeviceBanListSchema,
  adminDeviceBanPageSchema,
  adminDeviceBanSearchSchema,
  deviceBanKind,
  idSchema,
  store as storeCodes,
  wireTime,
  type AdminDeviceBan,
} from '@app/shared';
import { hashDomains } from '@app/shared/server';
import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { adminWrite } from '../admin/audit.js';
import { fieldInvalid, pageOf, readCursorKey } from '../admin/cursors.js';
import { withIdLease } from '../admin/effects.js';
import { takeAdminLimit } from '../admin/limits.js';
import { adminRefOf, callerMay, userRefOf } from '../admin/refs.js';
import { normalizePhone } from '../auth/otp.js';
import { HttpProblem } from '../lib/problem.js';
import { adminIdOf } from './adminAuth.js';

/**
 * Bans of a device key, a phone number or a Google account (device_bans):
 *
 *   GET    /v1/admin/device-bans               newest first; ?kind=
 *   POST   /v1/admin/device-bans/search        { phone }: the bans of a number (30/h per admin)
 *   POST   /v1/admin/device-bans               { from: 'user', user, kinds, expiresAt?, reason, forAction? } or { from: 'phone', phone, expiresAt?, reason } → 201
 *   DELETE /v1/admin/device-bans/{id}          { reason } → 204
 *
 * `forAction` ties the bans to the person's standing suspension or ban:
 * lifting it or overturning its appeal removes them (moderation_revoke,
 * 0028). The server's own bans (an under-age sign-up's year: no admin, no
 * record) are removed only with `moderation.device_bans_auto`.
 *
 * A ban is a keyed hash, never shown; a phone number travels only in a
 * request body and is never logged or kept in an audit row. Sign-up and
 * sign-in read the table (a primary-key probe), so a ban needs no
 * announcement; sessions already open are not touched (ban the person or
 * sign them out for that). Each cause of a ban is a row of its own (0028):
 * banning again for the same cause (the same record, or a typed number again)
 * renews that row, the longer expiry winning and a permanent one staying
 * permanent; a ban for another cause never takes over the server's own row,
 * a typed number's or another record's.
 */

const banParams = z.object({ id: idSchema });
const banCursor = z.object({ id: idSchema });

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

function banOf(app: FastifyInstance, row: AdminDeviceBanRow): AdminDeviceBan {
  return {
    id: row.id,
    kind: deviceBanKind.name(row.kind),
    store: row.store === null ? null : (storeCodes.nameOrUndefined(row.store) ?? null),
    reason: row.reason,
    createdAt: wireTime(row.createdAtMs),
    createdBy: adminRefOf(row.createdBy),
    expiresAt: row.expiresAtMs === null ? null : wireTime(row.expiresAtMs),
    active: row.active,
    user: row.user ? userRefOf(app, row.user) : null,
    actionId: row.actionId,
  };
}

function expiryOf(expiresAt: string | undefined, now = Date.now()): string | null {
  if (expiresAt === undefined) return null;
  const at = Date.parse(expiresAt);
  if (at < now + MINUTE_MS) throw fieldInvalid('/expiresAt', 'ends_in_past', 'The end must be in the future.');
  if (at > now + PENALTY_MAX_DAYS * DAY_MS) throw fieldInvalid('/expiresAt', 'ends_too_far', 'The end is too far ahead.');
  return new Date(at).toISOString();
}

/** What the audit row keeps of a ban: never the hash or the number. */
function banAudit(app: FastifyInstance, row: AdminDeviceBanRow, extra: Record<string, unknown> = {}) {
  const ban = banOf(app, row);
  return {
    kind: ban.kind,
    store: ban.store,
    expiresAt: ban.expiresAt,
    reason: ban.reason,
    ...(ban.user ? { user: ban.user.id } : {}),
    ...(ban.actionId ? { actionId: ban.actionId } : {}),
    ...extra,
  };
}

/** A lookup by phone is never unmetered: one budget per admin and hour, shared with the user search by phone. */
export const PHONE_LOOKUP_LIMIT = 'admin_ban_search';
export const PHONE_LOOKUPS_PER_HOUR = 30;

function e164Of(phone: string): string {
  const e164 = normalizePhone(phone);
  if (e164 === null) throw fieldInvalid('/phone', 'phone_invalid', 'Not a phone number.');
  return e164;
}

export const adminDeviceBanRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['admin'];
  const read = app.requirePermission('moderation.read');
  const write = app.requirePermission('moderation.device_bans');

  app.get(
    '/v1/admin/device-bans',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Device, phone and Google-account bans, newest first', querystring: adminDeviceBanListQuerySchema, response: { 200: adminDeviceBanPageSchema } },
    },
    async (request) => {
      const { kind, limit, cursor } = request.query;
      const key = readCursorKey(banCursor, cursor);
      const rows = await adminDeviceBanList(app.pg, { kind: kind === undefined ? undefined : deviceBanKind.code(kind), beforeId: key?.id ?? null, limit: limit + 1 });
      return pageOf(rows, limit, (row) => banOf(app, row), (row) => ({ id: row.id }));
    },
  );

  app.post(
    '/v1/admin/device-bans/search',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'The bans of a phone number', body: adminDeviceBanSearchSchema, response: { 200: adminDeviceBanListSchema } },
    },
    async (request, reply) => {
      await takeAdminLimit(app, request, PHONE_LOOKUP_LIMIT, PHONE_LOOKUPS_PER_HOUR);
      // The number is personal data: in the body only, never logged.
      const e164 = e164Of(request.body.phone);
      const hashes = app.secrets.hasher.hashAll(hashDomains.phone, e164).map((h) => h.hash);
      const rows = await adminPhoneBans(app.pg, hashes);
      reply.header('cache-control', 'no-store');
      return { items: rows.map((row) => banOf(app, row)) };
    },
  );

  app.post(
    '/v1/admin/device-bans',
    {
      preHandler: write,
      config: { pgBudget: 2 },
      schema: { tags, summary: 'Ban what a person signs in with, or a phone number', body: adminDeviceBanCreateSchema, response: { 201: adminDeviceBanListSchema } },
    },
    async (request, reply) => {
      const body = request.body;
      const adminId = adminIdOf(request);
      const expiresAt = expiryOf(body.expiresAt);
      let bans: CreatedBan[];
      if (body.from === 'user') {
        const userId = app.publicIds.user.decodeId(body.user);
        if (userId === null) throw new HttpProblem('not_found', { detail: 'No such user.' });
        const actionId = await withIdLease(() => app.ids.nextId());
        bans = await adminWrite(app, request, async (tx, trail) => {
          const outcome = await adminBanFromUser(tx, {
            userId,
            kinds: body.kinds.map((k) => deviceBanKind.code(k)),
            expiresAt,
            reason: body.reason,
            adminId,
            actionId,
            forAction: body.forAction,
          });
          if (outcome.outcome === 'missing') throw new HttpProblem('not_found', { detail: 'No such user.' });
          if (outcome.outcome === 'unknown_action') throw fieldInvalid('/forAction', 'unknown_action', 'Not a standing suspension or ban of this person.');
          if (outcome.outcome === 'nothing') throw fieldInvalid('/kinds', 'nothing_to_ban', 'This person has no device key, phone or Google account of these kinds.');
          for (const { ban, renewed } of outcome.bans) {
            trail.record({ action: 'device_ban.create', target: 'device_ban', targetId: ban.id, detail: banAudit(app, ban, { renewed }) });
          }
          return outcome.bans;
        });
      } else {
        const e164 = e164Of(body.phone);
        const hash = app.secrets.hasher.hash(hashDomains.phone, e164).hash;
        bans = await adminWrite(app, request, async (tx, trail) => {
          const created = await adminBanPhone(tx, { hash, expiresAt, reason: body.reason, adminId });
          trail.record({ action: 'device_ban.create', target: 'device_ban', targetId: created.ban.id, detail: banAudit(app, created.ban, { renewed: created.renewed }) });
          return [created];
        });
      }
      return reply.code(201).send({ items: bans.map(({ ban }) => banOf(app, ban)) });
    },
  );

  app.delete(
    '/v1/admin/device-bans/:id',
    {
      preHandler: write,
      config: { pgBudget: 2 },
      schema: { tags, summary: 'Remove a ban (with the reason)', params: banParams, body: adminDeviceBanDeleteSchema },
    },
    async (request, reply) => {
      const automatic = callerMay(app, request, 'moderation.device_bans_auto');
      await adminWrite(app, request, async (tx, trail) => {
        const removed = await adminDeleteDeviceBan(tx, request.params.id, { automatic });
        if (removed.outcome === 'missing') throw new HttpProblem('not_found', { detail: 'No such ban.' });
        if (removed.outcome === 'automatic') throw new HttpProblem('forbidden', { detail: 'An automatic ban is removed by the owner only.' });
        trail.record({
          action: 'device_ban.delete',
          target: 'device_ban',
          targetId: removed.ban.id,
          detail: { before: banAudit(app, removed.ban), reason: request.body.reason },
        });
      });
      return reply.code(204).send();
    },
  );
};
