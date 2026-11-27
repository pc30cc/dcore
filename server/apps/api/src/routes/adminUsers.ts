import {
  adminUserActions,
  adminUserAudit,
  adminUserConsents,
  adminUserDevices,
  adminUserList,
  adminUserPhotos,
  adminUserPurchases,
  adminUserReports,
  adminUserSearchByPhone,
  adminUserSearchByText,
  adminUserSessions,
  adminUserView,
  adminUserWallet,
  type AdminUserHit,
} from '@app/db';
import {
  PUBLIC_UID_PATTERN,
  adminActionPageSchema,
  adminReasonsSchema,
  adminReportPageSchema,
  adminUserConsentsSchema,
  adminUserDetailSchema,
  adminUserDevicesSchema,
  adminUserListQuerySchema,
  adminUserListSchema,
  adminUserPhotosSchema,
  adminUserPurchasesSchema,
  adminUserReportsQuerySchema,
  adminUserSearchRequestSchema,
  adminUserSearchResultSchema,
  adminUserSessionsSchema,
  adminUserWalletSchema,
  auditPageSchema,
  consentKind,
  idSchema,
  integrity,
  ledgerReason,
  pageQuerySchema,
  photoModFlags,
  photoRejectReason,
  photoStatus,
  platform,
  productKind,
  publicUidSchema,
  purchaseState,
  revokeReason,
  store as storeCodes,
  subscriptionStatus,
  walletItem,
  wireTime,
} from '@app/shared';
import { hashDomains, tokenHash } from '@app/shared/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { adminWrite } from '../admin/audit.js';
import { pageOf, readCursorKey } from '../admin/cursors.js';
import { takeAdminLimit } from '../admin/limits.js';
import { reasonsOf } from '../admin/reasons.js';
import {
  actionOf,
  adminRefOf,
  auditEntryOf,
  callerMay,
  noSuchUser,
  photoUrls,
  readUserParam,
  reportSummaryOf,
  userDetailOf,
  userReadScope,
  userRefOf,
  userSummaryOf,
} from '../admin/refs.js';
import { normalizePhone } from '../auth/otp.js';
import { scrubbed } from '../lib/dbErrors.js';
import { adminForbidden } from '../admin/problems.js';
import { PHONE_LOOKUP_LIMIT, PHONE_LOOKUPS_PER_HOUR } from './adminDeviceBans.js';

/**
 * The admin panel's reads of people:
 *
 *   GET  /v1/admin/users                  newest first; ?filter= from its partial index
 *   POST /v1/admin/users/search           public id, phone, order id, purchase token or name (the text in the body, never a URL);
 *                                         a phone, order or token lookup is audited and metered (30/h per admin, with the
 *                                         device-ban lookup)
 *   GET  /v1/admin/users/{id}             the page's header and profile
 *   GET  /v1/admin/users/{id}/{photos,reports,moderation,purchases,wallet,devices,sessions,consents,audit}
 *   GET  /v1/admin/moderation/reasons     every reason with the text a person reads (0 statements)
 *
 * `{id}` is the person's public id. What a role reads beyond `users.read`
 * (shadowbans, notes, holds, linked accounts) follows its other permissions
 * (`userReadScope`). One statement each; a purged account
 * (a tombstone) is 404 here and absent from every list. The phone number
 * is never in these answers (POST /users/{id}/reveal-phone, audited), nor a
 * message body (the chats routes, adminUserChats.ts, read those), a token or
 * a hash.
 */

const userParams = z.object({ id: publicUidSchema });
// The shared id schema also checks the value fits in 63 bits: a cursor is unsigned, and a bigger number would fail the ::bigint cast.
const idCursor = z.object({ id: idSchema });
const readCursor = (cursor: string | undefined): string | null => readCursorKey(idCursor, cursor)?.id ?? null;
const paged = <R extends { id: string }, T>(rows: readonly R[], limit: number, map: (row: R) => T) => pageOf(rows, limit, map, (row) => ({ id: row.id }));

const storeName = (code: number) => (code === 0 ? null : storeCodes.name(code));
const ms = (value: number | null) => (value === null ? null : wireTime(value));

function modFlagNames(mask: number): string[] {
  return photoModFlags.names.filter((name) => (mask & photoModFlags.code(name)) !== 0);
}

export const adminUserRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['admin'];
  const read = app.requirePermission('users.read');

  app.get(
    '/v1/admin/users',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'People, newest first (filters from their indexes)', querystring: adminUserListQuerySchema, response: { 200: adminUserListSchema } },
    },
    async (request) => {
      const { filter, limit, cursor } = request.query;
      const scope = userReadScope(app, request);
      if (filter === 'shadowbanned' && !scope.shadow) throw adminForbidden('shadow_hidden', 'Shadowbans are not shown to this role.');
      const rows = await adminUserList(app.pg, { filter, beforeId: readCursor(cursor), limit: limit + 1 });
      return paged(rows, limit, (row) => userSummaryOf(app, row, scope));
    },
  );

  app.post(
    '/v1/admin/users/search',
    {
      preHandler: read,
      // A name, id or no hit: 1. A lookup by phone, or a hit by order id or purchase token: the search and its audit row (2).
      config: { pgBudget: 2 },
      schema: { tags, summary: 'Find people by public id, phone, order id, purchase token or name', body: adminUserSearchRequestSchema, response: { 200: adminUserSearchResultSchema } },
    },
    async (request) => {
      // The text is personal data: it is never logged, here or in the URL, nor kept in the audit row.
      const q = request.body.q;
      const scope = userReadScope(app, request);
      let hits: AdminUserHit[];
      const byId = PUBLIC_UID_PATTERN.test(q) ? app.publicIds.user.decodeId(q) : null;
      const e164 = byId === null ? normalizePhone(q) : null;
      if (e164 !== null) {
        // Linking a number to an account: metered (the budget of the device-ban lookup) and audited, as that lookup.
        const ticket = await takeAdminLimit(app, request, PHONE_LOOKUP_LIMIT, PHONE_LOOKUPS_PER_HOUR);
        const hashes = app.secrets.hasher.hashAll(hashDomains.phone, e164).map((h) => h.hash);
        try {
          hits = await adminWrite(app, request, async (tx, trail) => {
            const found = await scrubbed(() => adminUserSearchByPhone(tx, hashes));
            trail.record({ action: 'user.search', target: 'none', detail: { by: 'phone', hits: found.length } });
            return found;
          });
        } catch (error) {
          await ticket.refund();
          throw error;
        }
      } else {
        const token = q.length >= 20 ? Buffer.from(tokenHash(q), 'hex') : null;
        hits = await scrubbed(() => adminUserSearchByText(app.pg, { q, userId: byId, tokenHash: token, names: q.length >= 3 }));
        // A purchase found by its order id or token links it to the account: the same budget, and a row.
        const purchase = hits.filter((hit) => hit.matchedBy === 'order' || hit.matchedBy === 'token');
        if (purchase.length > 0) {
          await takeAdminLimit(app, request, PHONE_LOOKUP_LIMIT, PHONE_LOOKUPS_PER_HOUR);
          await adminWrite(app, request, async (_tx, trail) => {
            trail.record({ action: 'user.search', target: 'none', detail: { by: purchase[0]!.matchedBy, hits: purchase.length } });
          });
        }
      }
      return { items: hits.map((hit) => ({ ...userSummaryOf(app, hit.summary, scope), matchedBy: hit.matchedBy })) };
    },
  );

  app.get(
    '/v1/admin/users/:id',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: "A person's page: header, profile, standing actions", params: userParams, response: { 200: adminUserDetailSchema } },
    },
    async (request) => {
      const userId = readUserParam(app, request.params.id);
      const row = await adminUserView(app.pg, userId);
      if (!row) throw noSuchUser();
      return userDetailOf(app, app.cfg.get(), row, userReadScope(app, request));
    },
  );

  app.get(
    '/v1/admin/users/:id/photos',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: "Every photo of a person, in any state", params: userParams, response: { 200: adminUserPhotosSchema } },
    },
    async (request) => {
      const userId = readUserParam(app, request.params.id);
      const { found, value } = await adminUserPhotos(app.pg, userId);
      if (!found) throw noSuchUser();
      return {
        items: value.map((ph) => {
          const status = photoStatus.name(ph.status);
          const rejectReason = status === 'rejected' && ph.rejectReason !== null ? (photoRejectReason.nameOrUndefined(ph.rejectReason) ?? 'other') : undefined;
          return {
            id: ph.id,
            position: ph.position,
            status,
            ...(rejectReason ? { rejectReason } : {}),
            modFlags: modFlagNames(ph.modFlags),
            hasFace: ph.hasFace,
            width: ph.width,
            height: ph.height,
            uploadedAt: wireTime(ph.uploadedAtMs),
            decidedAt: ms(ph.decidedAtMs),
            decidedBy: adminRefOf(ph.decidedBy),
            ...(status === 'processing' ? {} : photoUrls(app, ph.id, ph.blobVer)),
          };
        }),
      };
    },
  );

  app.get(
    '/v1/admin/users/:id/reports',
    {
      preHandler: app.requirePermission('reports.read'),
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Reports against a person or filed by them, newest first', params: userParams, querystring: adminUserReportsQuerySchema, response: { 200: adminReportPageSchema } },
    },
    async (request) => {
      const userId = readUserParam(app, request.params.id);
      const { side, limit, cursor } = request.query;
      const { found, value } = await adminUserReports(app.pg, userId, { side, beforeId: readCursor(cursor), limit: limit + 1 });
      if (!found) throw noSuchUser();
      const scope = userReadScope(app, request);
      return paged(value, limit, (row) => reportSummaryOf(app, row, scope));
    },
  );

  app.get(
    '/v1/admin/users/:id/moderation',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: "Every moderation record of a person, newest first", params: userParams, querystring: pageQuerySchema, response: { 200: adminActionPageSchema } },
    },
    async (request) => {
      const userId = readUserParam(app, request.params.id);
      const { limit, cursor } = request.query;
      const scope = userReadScope(app, request);
      const { found, value } = await adminUserActions(app.pg, userId, { beforeId: readCursor(cursor), limit: limit + 1, withShadowbans: scope.shadow });
      if (!found) throw noSuchUser();
      return paged(value, limit, (row) => actionOf(row, scope));
    },
  );

  app.get(
    '/v1/admin/users/:id/purchases',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: "A person's subscriptions and newest purchases (read only)", params: userParams, response: { 200: adminUserPurchasesSchema } },
    },
    async (request) => {
      const userId = readUserParam(app, request.params.id);
      const { found, value } = await adminUserPurchases(app.pg, userId);
      if (!found) throw noSuchUser();
      return {
        subscriptions: value.subscriptions.map((s) => ({
          store: storeName(s.store),
          plan: s.plan,
          status: subscriptionStatus.name(s.status),
          startedAt: wireTime(s.startedAtMs),
          expiresAt: wireTime(s.expiresAtMs),
          autoRenew: s.autoRenew,
        })),
        items: value.items.map((p) => ({
          id: p.id,
          store: storeCodes.name(p.store),
          productId: p.productId,
          kind: productKind.name(p.kind),
          state: purchaseState.name(p.state),
          quantity: p.quantity,
          purchasedAt: wireTime(p.purchasedAtMs),
          expiresAt: ms(p.expiresAtMs),
          orderId: p.orderId,
          autoRenew: p.autoRenew,
          isTest: p.isTest,
          region: p.region,
        })),
      };
    },
  );

  app.get(
    '/v1/admin/users/:id/wallet',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: "A person's balances and wallet ledger (read only)", params: userParams, querystring: pageQuerySchema, response: { 200: adminUserWalletSchema } },
    },
    async (request) => {
      const userId = readUserParam(app, request.params.id);
      const { limit, cursor } = request.query;
      const { found, value } = await adminUserWallet(app.pg, userId, { beforeId: readCursor(cursor), limit: limit + 1 });
      if (!found) throw noSuchUser();
      return {
        balances: value.balances.map((b) => ({ item: walletItem.name(b.item), store: storeName(b.store), balance: b.balance })),
        ledger: paged(value.ledger, limit, (l) => ({
          id: l.id,
          at: wireTime(l.atMs),
          item: walletItem.name(l.item),
          store: storeName(l.store),
          delta: l.delta,
          balanceAfter: l.balanceAfter,
          reason: ledgerReason.name(l.reason),
          admin: adminRefOf(l.admin),
        })),
      };
    },
  );

  app.get(
    '/v1/admin/users/:id/devices',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: "A person's devices and the other accounts seen on them", params: userParams, response: { 200: adminUserDevicesSchema } },
    },
    async (request) => {
      const userId = readUserParam(app, request.params.id);
      const { found, value } = await adminUserDevices(app.pg, userId);
      if (!found) throw noSuchUser();
      const { linked } = userReadScope(app, request);
      return {
        items: value.map((d) => ({
          id: d.id,
          platform: platform.name(d.platform),
          store: storeCodes.name(d.store),
          appVersion: d.appVersion,
          integrity: integrity.name(d.integrity),
          locale: d.locale,
          updatedAt: wireTime(d.updatedAtMs),
          disabledAt: ms(d.disabledAtMs),
          push: d.push,
          // The accounts seen on the device: moderation's to read (ban evasion), not every reader's.
          linked: linked ? d.linked.map((ref) => userRefOf(app, ref)) : [],
        })),
      };
    },
  );

  app.get(
    '/v1/admin/users/:id/sessions',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: "A person's newest 50 sessions", params: userParams, response: { 200: adminUserSessionsSchema } },
    },
    async (request) => {
      const userId = readUserParam(app, request.params.id);
      const { found, value } = await adminUserSessions(app.pg, userId);
      if (!found) throw noSuchUser();
      return {
        items: value.map((s) => ({
          id: s.id,
          createdAt: wireTime(s.createdAtMs),
          refreshedAt: wireTime(s.refreshedAtMs),
          expiresAt: wireTime(s.expiresAtMs),
          revokedAt: ms(s.revokedAtMs),
          revokeReason: s.revokeReason === null ? null : (revokeReason.nameOrUndefined(s.revokeReason) ?? null),
          store: storeCodes.name(s.store),
          appVersion: s.appVersion,
          deviceId: s.deviceId,
        })),
      };
    },
  );

  app.get(
    '/v1/admin/users/:id/consents',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: "A person's consent records", params: userParams, response: { 200: adminUserConsentsSchema } },
    },
    async (request) => {
      const userId = readUserParam(app, request.params.id);
      const { found, value } = await adminUserConsents(app.pg, userId);
      if (!found) throw noSuchUser();
      return {
        items: value.map((c) => ({
          kind: consentKind.name(c.kind),
          version: c.version,
          acceptedAt: wireTime(c.acceptedAtMs),
          withdrawnAt: ms(c.withdrawnAtMs),
          store: c.store === null ? null : storeCodes.name(c.store),
        })),
      };
    },
  );

  app.get(
    '/v1/admin/users/:id/audit',
    {
      preHandler: app.requirePermission('audit.read'),
      config: { pgBudget: 1 },
      schema: { tags, summary: 'The audit rows about a person, newest first', params: userParams, querystring: pageQuerySchema, response: { 200: auditPageSchema } },
    },
    async (request) => {
      const userId = readUserParam(app, request.params.id);
      const { limit, cursor } = request.query;
      const { shadow } = userReadScope(app, request);
      const { found, value } = await adminUserAudit(app.pg, userId, { beforeId: readCursor(cursor), limit: limit + 1, withShadowbans: shadow });
      if (!found) throw noSuchUser();
      const adminDetails = callerMay(app, request, 'admins.read');
      return paged(value, limit, (row) => auditEntryOf(app, row, { adminDetails, shadow }));
    },
  );

  app.get(
    '/v1/admin/moderation/reasons',
    {
      preHandler: read,
      config: { pgBudget: 0 },
      schema: { tags, summary: 'Every moderation, photo and text reason with the text a person reads, per language', response: { 200: adminReasonsSchema } },
    },
    async () => reasonsOf(app.cfg.get()),
  );
};
