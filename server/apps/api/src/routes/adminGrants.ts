import {
  adminGiftTarget,
  adminGrantById,
  adminGrantList,
  adminWalletAdjustments,
  creditWallet,
  debitWallet,
  grantPlan,
  revokePlanGrant,
  type AdminGrantRow,
  type AdminWalletAdjustmentRow,
  type GrantCursor,
} from '@app/db';
import {
  BILLING_GIFTS_PER_HOUR,
  FREE_PLAN_KEY,
  GRANT_START_AHEAD_DAYS_MAX,
  adminGrantCreateSchema,
  adminGrantListQuerySchema,
  adminGrantListSchema,
  adminGrantResultSchema,
  adminGrantRevokeSchema,
  adminWalletAdjustResultSchema,
  adminWalletAdjustSchema,
  adminWalletAdjustmentListSchema,
  idSchema,
  idTime,
  ledgerReason,
  pageQuerySchema,
  publicUidSchema,
  store as storeCodes,
  walletItem,
  wireTime,
  type AdminGrant,
  type AdminWalletAdjustment,
  type GrantState,
  type Permission,
} from '@app/shared';
import { FOLLOW_UP_ATTEMPTS, FOLLOW_UP_BACKOFF_MS, iapJobIds } from '@app/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { adminWrite } from '../admin/audit.js';
import { pageOf, readCursorKey } from '../admin/cursors.js';
import { afterCommit, worst } from '../admin/effects.js';
import { takeAdminLimit } from '../admin/limits.js';
import { adminConflict, adminForbidden, fieldInvalid } from '../admin/problems.js';
import { claimRequestOnce, viewStoreOf } from '../admin/purchases.js';
import { adminRefOf, callerMay, noSuchUser, readUserParam, userRefOf } from '../admin/refs.js';
import { nextId } from '../auth/sessions.js';
import { HttpProblem } from '../lib/problem.js';
import { adminIdOf } from './adminAuth.js';

/**
 * Plan days given in the panel and admin wallet rows:
 *
 *   GET    /v1/admin/grants?state=&user=          grants, newest first or the active ones by end (billing.read)
 *   POST   /v1/admin/grants                       days of a plan for a person (billing.grant or users.gift)
 *   DELETE /v1/admin/grants/{id}                  end a grant now (billing.grant)
 *   POST   /v1/admin/users/{id}/wallet-adjust     a gift (billing.grant or users.gift) or a correction (billing.grant)
 *   GET    /v1/admin/wallet-adjustments           every admin gift and correction, newest first (billing.read)
 *
 * A grant or wallet write carries the dialog's `requestId` (`adm:once:`),
 * so a repeat does it once; the person's subscription or wallet changes in
 * the write's transaction with its audit row, and the app hears it through
 * the `entitlement` event of the build the person used lately. A grant's
 * start and end are recomputed by the worker's `sub-end` jobs. A balance
 * never goes below zero. Notes and reasons stay in the panel: the person
 * never sees them.
 */

const DAY_MS = 86_400_000;
/** A start this far in the past is "now" given by a slow dialog; earlier is refused. */
const START_SLACK_MS = 5 * 60_000;
const GIFT_LIMIT = 'billing-gift';

const grantParams = z.object({ id: idSchema });
const userParams = z.object({ id: publicUidSchema });
const allCursor = z.object({ id: idSchema });
const activeCursor = z.object({ e: z.number().int().nonnegative(), id: idSchema });

/** The balance a correction names, as wallet_balances.store. */
const BALANCE_STORE = { gifts: 0, play: storeCodes.code('play'), bazaar: storeCodes.code('bazaar') } as const;

const ms = (value: number | null) => (value === null ? null : wireTime(value));

function grantOf(app: FastifyInstance, row: AdminGrantRow): AdminGrant {
  return {
    id: row.id,
    user: userRefOf(app, row.user),
    plan: row.plan,
    startsAt: wireTime(row.startsAtMs),
    endsAt: wireTime(row.endsAtMs),
    state: row.state,
    reason: row.reason,
    grantedBy: adminRefOf(row.grantedBy),
    revokedAt: ms(row.revokedAtMs),
    revokedBy: adminRefOf(row.revokedBy),
    revokeReason: row.revokeReason,
  };
}

function adjustmentOf(app: FastifyInstance, row: AdminWalletAdjustmentRow): AdminWalletAdjustment {
  return {
    id: row.id,
    at: wireTime(row.atMs),
    user: userRefOf(app, row.user),
    item: walletItem.name(row.item),
    store: row.store === 0 ? null : storeCodes.name(row.store),
    delta: row.delta,
    balanceAfter: row.balanceAfter,
    reason: ledgerReason.name(row.reason),
    admin: adminRefOf(row.admin),
    note: row.note,
  };
}

/** 403 `role` unless the caller holds one of `permissions`. */
function requireAny(app: FastifyInstance, request: FastifyRequest, permissions: readonly Permission[]): void {
  if (!permissions.some((permission) => callerMay(app, request, permission))) {
    throw adminForbidden('role', `This needs ${permissions.join(' or ')}.`, { permissions });
  }
}

export const adminGrantRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['admin'];
  const read = app.requirePermission('billing.read');

  /**
   * After a grant or wallet change committed: the person's entitlements
   * move to a new version and the build they use hears it (the view store
   * was read before the change dropped the cached views).
   */
  function told(request: FastifyRequest, userId: string, viewStore: number) {
    return afterCommit(request, 'entitlements changed', () => app.store.entitlements.changed(request, userId, viewStore, { publish: viewStore !== 0 }), { user: app.publicIds.user.encode(userId) });
  }

  app.get(
    '/v1/admin/grants',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Plan days given: newest first, or the active ones soonest end first', querystring: adminGrantListQuerySchema, response: { 200: adminGrantListSchema } },
    },
    async (request) => {
      const { state, user, limit, cursor } = request.query;
      const userId = user === undefined ? null : readUserParam(app, user);
      const after: GrantCursor | null = state === 'active' ? readCursorKey(activeCursor, cursor) : readCursorKey(allCursor, cursor);
      const { found, grants } = await adminGrantList(app.pg, { state, userId, after, limit: limit + 1 });
      if (!found) throw noSuchUser();
      return pageOf(grants, limit, (row) => grantOf(app, row), (row) => (state === 'active' ? { e: row.endsAtMs, id: row.id } : { id: row.id }));
    },
  );

  app.post(
    '/v1/admin/grants',
    {
      preHandler: read,
      // The person and the admin (1), the grant and the store-0 subscription (2), the audit row (1); +1 own for the event's view.
      config: { pgBudget: 4 },
      schema: { tags, summary: 'Give a person days of a plan (now or from a later instant)', body: adminGrantCreateSchema, response: { 201: adminGrantResultSchema } },
    },
    async (request, reply) => {
      requireAny(app, request, ['billing.grant', 'users.gift']);
      const body = request.body;
      const plan = app.cfg.get().plans.find((p) => p.key === body.plan);
      if (!plan) throw fieldInvalid('/plan', 'unknown_plan', 'No such plan.');
      if (plan.key === FREE_PLAN_KEY) throw fieldInvalid('/plan', 'free_plan', 'The free plan is everyone’s already.');
      if (plan.archivedAtMs !== null) throw fieldInvalid('/plan', 'archived_plan', 'The plan is archived.');
      const now = Date.now();
      const startsAtMs = body.startsAt === undefined ? now : Date.parse(body.startsAt);
      if (startsAtMs < now - START_SLACK_MS) throw fieldInvalid('/startsAt', 'starts_in_past', 'The start is in the past.');
      if (startsAtMs > now + GRANT_START_AHEAD_DAYS_MAX * DAY_MS) throw fieldInvalid('/startsAt', 'starts_too_far', 'The start is too far ahead.');
      const endsAtMs = startsAtMs + body.days * DAY_MS;
      const userId = app.publicIds.user.decodeId(body.user);
      if (userId === null) throw fieldInvalid('/user', 'unknown_user', 'No such person.');
      await takeAdminLimit(app, request, GIFT_LIMIT, BILLING_GIFTS_PER_HOUR);
      const adminId = adminIdOf(request);
      const once = await claimRequestOnce(app, request, body.requestId);
      let grant: AdminGrant;
      let viewStore: number;
      // Whatever fails before the commit (the id lease included) frees the request id: the dialog's retry runs.
      try {
        viewStore = await viewStoreOf(app, request, userId);
        const grantId = nextId(app);
        grant = await adminWrite(app, request, async (tx, trail) => {
          const target = await adminGiftTarget(tx, userId, adminId);
          if (!target || target.status === 8) throw fieldInvalid('/user', 'unknown_user', 'No such person.');
          await grantPlan(tx, { id: grantId, userId, planId: plan.id, startsAtMs, endsAtMs, reason: body.reason, adminId });
          trail.record({
            action: 'grant.create',
            target: 'user',
            targetId: userId,
            detail: { grantId, plan: plan.key, startsAt: wireTime(startsAtMs), endsAt: wireTime(endsAtMs), days: body.days, reason: body.reason },
          });
          const state: GrantState = startsAtMs > now ? 'scheduled' : 'active';
          return {
            id: grantId,
            user: userRefOf(app, target.user),
            plan: plan.key,
            startsAt: wireTime(startsAtMs),
            endsAt: wireTime(endsAtMs),
            state,
            reason: body.reason,
            grantedBy: adminRefOf(target.admin),
            revokedAt: null,
            revokedBy: null,
            revokeReason: null,
          };
        });
      } catch (error) {
        await once.release();
        throw error;
      }
      const jobs = (atMs: number) =>
        app.jobs.add('iap', 'sub-end', iapJobIds.subEnd(userId, 0, atMs), { userId, store: 0, atMs }, { delayMs: Math.max(0, atMs - Date.now()), attempts: FOLLOW_UP_ATTEMPTS, backoffMs: FOLLOW_UP_BACKOFF_MS });
      const sideEffects = worst(
        await told(request, userId, viewStore),
        // The grant's end, and a later start, recompute the store-0 subscription when they come.
        await afterCommit(request, 'queue the grant times', async () => {
          await jobs(endsAtMs + 1_000);
          if (startsAtMs > now) await jobs(startsAtMs);
        }),
      );
      reply.code(201);
      return { grant, sideEffects };
    },
  );

  app.delete(
    '/v1/admin/grants/:id',
    {
      preHandler: app.requirePermission('billing.grant'),
      // The grant ended and the store-0 subscription (2), the grant read back (1), the audit row (1); +1 own for the event's view.
      config: { pgBudget: 4 },
      schema: { tags, summary: 'End a grant now (the plan ends for the person)', params: grantParams, body: adminGrantRevokeSchema, response: { 200: adminGrantResultSchema } },
    },
    async (request) => {
      await takeAdminLimit(app, request, GIFT_LIMIT, BILLING_GIFTS_PER_HOUR);
      const reason = request.body.reason;
      const { row, userId } = await adminWrite(app, request, async (tx, trail) => {
        const ended = await revokePlanGrant(tx, request.params.id, { adminId: adminIdOf(request), reason });
        if (ended.outcome === 'not_found') throw new HttpProblem('not_found', { detail: 'No such grant.' });
        if (ended.outcome === 'ended') throw adminConflict('grant_ended', 'The grant has ended already.');
        const after = await adminGrantById(tx, request.params.id);
        if (!after) throw new HttpProblem('not_found', { detail: 'No such grant.' });
        trail.record({
          action: 'grant.revoke',
          target: 'user',
          targetId: ended.userId,
          detail: { grantId: request.params.id, plan: after.plan, endsAt: wireTime(ended.endsAtMs), reason },
        });
        return { row: after, userId: ended.userId };
      });
      const viewStore = await viewStoreOf(app, request, userId);
      return { grant: grantOf(app, row), sideEffects: await told(request, userId, viewStore) };
    },
  );

  app.post(
    '/v1/admin/users/:id/wallet-adjust',
    {
      preHandler: app.requirePermission('users.read'),
      // The person and the admin (1), the balance and its ledger row (1), the audit row (1); +1 own for the event's view.
      config: { pgBudget: 3 },
      schema: { tags, summary: "A gift to a person's wallet, or a correction of one of their balances", params: userParams, body: adminWalletAdjustSchema, response: { 201: adminWalletAdjustResultSchema } },
    },
    async (request, reply) => {
      const body = request.body;
      requireAny(app, request, body.kind === 'gift' ? ['billing.grant', 'users.gift'] : ['billing.grant']);
      const userId = readUserParam(app, request.params.id);
      await takeAdminLimit(app, request, GIFT_LIMIT, BILLING_GIFTS_PER_HOUR);
      const adminId = adminIdOf(request);
      const item = walletItem.code(body.item);
      const store = body.kind === 'gift' ? 0 : BALANCE_STORE[body.balance];
      const delta = body.kind === 'gift' ? body.quantity : body.delta;
      const reason = body.kind === 'gift' ? (4 as const) : (8 as const);
      const once = await claimRequestOnce(app, request, body.requestId);
      let entry: AdminWalletAdjustment;
      let viewStore: number;
      // Whatever fails before the commit (the id lease included) frees the request id: the dialog's retry runs.
      try {
        viewStore = await viewStoreOf(app, request, userId);
        const ledgerId = nextId(app);
        entry = await adminWrite(app, request, async (tx, trail) => {
          const target = await adminGiftTarget(tx, userId, adminId);
          if (!target || target.status === 8) throw noSuchUser();
          let balanceAfter: number;
          if (delta > 0) {
            balanceAfter = await creditWallet(tx, { userId, item, store, quantity: delta, reason, ledgerId, refId: null, adminId, note: body.note });
          } else {
            const left = await debitWallet(tx, { userId, item, store, quantity: -delta, reason: 8, ledgerId, adminId, note: body.note });
            if (left === null) throw fieldInvalid('/delta', 'insufficient_balance', 'The balance does not hold that much.');
            balanceAfter = left;
          }
          const balance = store === 0 ? 'gifts' : storeCodes.name(store);
          trail.record({
            action: body.kind === 'gift' ? 'wallet.gift' : 'wallet.correct',
            target: 'user',
            targetId: userId,
            detail: { ledgerId, item: body.item, balance, delta, balanceAfter, note: body.note },
          });
          return {
            id: ledgerId,
            at: wireTime(idTime(ledgerId)),
            user: userRefOf(app, target.user),
            item: body.item,
            store: store === 0 ? null : storeCodes.name(store),
            delta,
            balanceAfter,
            reason: ledgerReason.name(reason),
            admin: adminRefOf(target.admin),
            note: body.note,
          };
        });
      } catch (error) {
        await once.release();
        throw error;
      }
      reply.code(201);
      return { entry, sideEffects: await told(request, userId, viewStore) };
    },
  );

  app.get(
    '/v1/admin/wallet-adjustments',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Every admin gift and correction, newest first', querystring: pageQuerySchema, response: { 200: adminWalletAdjustmentListSchema } },
    },
    async (request) => {
      const { limit, cursor } = request.query;
      const rows = await adminWalletAdjustments(app.pg, { beforeId: readCursorKey(allCursor, cursor)?.id ?? null, limit: limit + 1 });
      return pageOf(rows, limit, (row) => adjustmentOf(app, row), (row) => ({ id: row.id }));
    },
  );
};
