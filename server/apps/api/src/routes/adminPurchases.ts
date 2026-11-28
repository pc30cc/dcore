import {
  adminLockPurchase,
  adminPurchaseEvents,
  adminPurchaseList,
  adminPurchaseSearch,
  applyStorePurchase,
  purchaseById,
  type KnownPurchase,
  type PurchaseApplied,
  type PurchaseMatch,
} from '@app/db';
import {
  ID_PATTERN,
  PUBLIC_UID_PATTERN,
  PURCHASE_ACTIONS_PER_HOUR,
  PURCHASE_LOOKUPS_PER_HOUR,
  PURCHASE_RECHECKS_PER_HOUR,
  adminPurchaseActionResultSchema,
  adminPurchaseCancelSchema,
  adminPurchaseDetailSchema,
  adminPurchaseEventPageSchema,
  adminPurchaseListQuerySchema,
  adminPurchaseListSchema,
  adminPurchaseRecheckSchema,
  adminPurchaseRefundSchema,
  adminPurchaseRevokeSchema,
  adminPurchaseSearchResultSchema,
  adminPurchaseSearchSchema,
  idSchema,
  pageQuerySchema,
  purchaseState,
  storeEventSource,
  store as storeCodes,
  type AdminPurchaseActionResult,
  type AppStore,
  type PurchaseAction,
  type PurchaseOutcome,
  type SideEffects,
} from '@app/shared';
import {
  FOLLOW_UP_ATTEMPTS,
  FOLLOW_UP_BACKOFF_MS,
  iapJobIds,
  isStoreError,
  tokenHash,
  verifiedFromRow,
  type ApplyContext,
  type StoreActionOutcome,
  type StoreVerifier,
  type VerifiedPurchase,
} from '@app/shared/server';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, adminWrite, auditedTransaction, type AuditEntry } from '../admin/audit.js';
import { pageOf, readCursorKey } from '../admin/cursors.js';
import { afterCommit, withIdLease, worst } from '../admin/effects.js';
import { takeAdminLimit } from '../admin/limits.js';
import { adminConflict } from '../admin/problems.js';
import {
  appStoreOf,
  noSuchPurchase,
  purchaseDetail,
  purchaseEventOf,
  purchaseListItemOf,
  purchaseRefOf,
  purchaseSummaryOf,
  requireAction,
  requireState,
  storeRefusal,
  storeUnavailable,
  verifierOf,
  withPurchaseLock,
} from '../admin/purchases.js';
import { scrubbed } from '../lib/dbErrors.js';

/**
 * The purchases of both stores in the admin panel:
 *
 *   GET  /v1/admin/purchases?store=&state=     a store's purchases newest first, without order ids (billing.read)
 *   POST /v1/admin/purchases/search            purchase id, public id, order id or token, in the body (billing.read);
 *                                              a hit by order id or token is audited and metered (120/h per admin)
 *   GET  /v1/admin/purchases/{id}              every stored column but the token material, events, admin history (billing.read)
 *   GET  /v1/admin/purchases/{id}/events       older events (billing.read)
 *   POST /v1/admin/purchases/{id}/recheck      the store asked now, its answer applied (billing.write)
 *   POST /v1/admin/purchases/{id}/cancel       the renewal stopped at the store (billing.refund)
 *   POST /v1/admin/purchases/{id}/refund       refunded at the store, access ended now (billing.refund)
 *   POST /v1/admin/purchases/{id}/revoke       marked refunded here, nothing asked of the store (billing.refund)
 *
 * An action is offered only where the store's API documents it, this
 * server is connected to the store, the state allows it and the caller's
 * roles grant it (`available` on the page; the same rule refuses here).
 * One action per purchase at a time (`iap:adm:<id>`); the admin's `from`
 * is the state they saw. A stop of renewal or a refund writes its audit row
 * before the store is asked, so a refused row asks nothing; a store that
 * refuses or cannot be reached leaves a `purchase.action_failed` row. The
 * store's own "already done" counts as done (a subscription's refund: the
 * state the store shows is applied, never a refund assumed), and a lost
 * answer is read again by the admin's retry. A re-check that finds the
 * store naming an account that is not ours records it, then queues the
 * store's refund and revoke (409 `foreign_account`). A re-check and "mark refunded" write their
 * audit row with the purchase's own statement. The token never leaves the
 * server: not in an answer, an audit row or a log line.
 */

const purchaseParams = z.object({ id: idSchema });
const idCursor = z.object({ id: idSchema });
const readCursor = (cursor: string | undefined): string | null => readCursorKey(idCursor, cursor)?.id ?? null;

const ADMIN_SOURCE = storeEventSource.code('admin');

/** 409 `foreign_account`: the store names an account that is not ours; recorded, and its refund and revoke at the store queued. */
function foreignAccount() {
  return adminConflict('foreign_account', 'The store names an account that is not ours: the purchase is refunded and revoked at the store.');
}
const MATCH_ORDER: readonly PurchaseMatch[] = ['id', 'person', 'order', 'token'];
/** An order id is at most this long (store_purchases.order_id); a purchase token at least this. */
const ORDER_ID_MAX = 200;
const TOKEN_MIN = 20;

/** What the store's state is after an action, and whether it is a refund the store made (not a read). */
interface AfterStore {
  verified: VerifiedPurchase;
  refunded: boolean;
}

/** The time of an admin's state: later than the row's last store event, or the statement ignores it as stale. */
function eventMsAfter(row: KnownPurchase): number {
  return Math.max(Date.now(), (row.lastEventMs ?? 0) + 1);
}

export const adminPurchaseRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['admin'];
  const read = app.requirePermission('billing.read');

  app.get(
    '/v1/admin/purchases',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: "A store's purchases, newest first (optionally in one state)", querystring: adminPurchaseListQuerySchema, response: { 200: adminPurchaseListSchema } },
    },
    async (request) => {
      const { store, state, limit, cursor } = request.query;
      const rows = await adminPurchaseList(app.pg, {
        store: storeCodes.code(store),
        state: state === undefined ? undefined : purchaseState.code(state),
        beforeId: readCursor(cursor),
        limit: limit + 1,
      });
      return {
        ...pageOf(rows, limit, (row) => purchaseListItemOf(app, row), (row) => ({ id: row.id })),
        connected: verifierOf(app, store) !== undefined,
      };
    },
  );

  app.post(
    '/v1/admin/purchases/search',
    {
      preHandler: read,
      // The search (1); a hit by order id or token, its audit row (2).
      config: { pgBudget: 2 },
      schema: { tags, summary: 'Find purchases by purchase id, public id, order id or token', body: adminPurchaseSearchSchema, response: { 200: adminPurchaseSearchResultSchema } },
    },
    async (request) => {
      // The text may be a token or an order id: never logged, never in an address or an audit row.
      const q = request.body.q;
      const id = ID_PATTERN.test(q) && idSchema.safeParse(q).success ? q : null;
      const userId = PUBLIC_UID_PATTERN.test(q) ? app.publicIds.user.decodeId(q) : null;
      const orderId = q.length <= ORDER_ID_MAX ? q : null;
      const hash = q.length >= TOKEN_MIN ? Buffer.from(tokenHash(q), 'hex') : null;
      const hits = await scrubbed(() => adminPurchaseSearch(app.pg, { id, userId, orderId, tokenHash: hash }));
      const matchedBy = MATCH_ORDER.find((kind) => hits.some((hit) => hit.matched === kind)) ?? null;
      const rows = hits.filter((hit) => hit.matched === matchedBy).map((hit) => hit.row);
      if (matchedBy === 'order' || matchedBy === 'token') {
        // A purchase found by its order id or token links it to an account: metered, and a row (never the text).
        const ticket = await takeAdminLimit(app, request, 'purchase-lookup', PURCHASE_LOOKUPS_PER_HOUR);
        try {
          await adminWrite(app, request, async (_tx, trail) => {
            trail.record({ action: 'purchase.search', target: 'none', detail: { by: matchedBy, hits: rows.length } });
          });
        } catch (error) {
          await ticket.refund();
          throw error;
        }
      }
      return { items: rows.map((row) => purchaseSummaryOf(app, row)), matchedBy };
    },
  );

  app.get(
    '/v1/admin/purchases/:id',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'A purchase: every stored field but the token, its store events, its admin history', params: purchaseParams, response: { 200: adminPurchaseDetailSchema } },
    },
    async (request) => purchaseDetail(app, request, request.params.id),
  );

  app.get(
    '/v1/admin/purchases/:id/events',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: "A purchase's store events, newest first", params: purchaseParams, querystring: pageQuerySchema, response: { 200: adminPurchaseEventPageSchema } },
    },
    async (request) => {
      const { limit, cursor } = request.query;
      const { found, events } = await adminPurchaseEvents(app.pg, request.params.id, { beforeId: readCursor(cursor), limit: limit + 1 });
      if (!found) throw noSuchPurchase();
      return pageOf(events, limit, purchaseEventOf, (row) => ({ id: row.id }));
    },
  );

  /** The stored purchase, its app store and its integration (none: not connected); 404 for an unknown id. */
  async function load(id: string): Promise<{ row: KnownPurchase; store: AppStore | null; verifier: StoreVerifier | undefined }> {
    const row = await purchaseById(app.pg, id);
    if (!row) throw noSuchPurchase();
    const store = appStoreOf(row.store);
    return { row, store, verifier: verifierOf(app, store) };
  }

  function context(row: KnownPurchase, store: AppStore): ApplyContext {
    return { store, token: row.token, callerId: null, source: ADMIN_SOURCE, ownerHint: row.userId };
  }

  /** A store's refusal or outage of an action, recorded (best effort) after its own audit row. */
  async function recordFailure(request: FastifyRequest, row: KnownPurchase, action: PurchaseAction, error: unknown): Promise<void> {
    const kind = isStoreError(error, 'invalid') ? 'refused' : 'unavailable';
    if (!isStoreError(error)) request.log.error({ err: error, purchaseId: row.id, action }, 'purchase: the store call failed unexpectedly');
    await auditedTransaction(app, actorOf(request), async (_tx, trail) => {
      trail.record({ action: 'purchase.action_failed', target: 'purchase', targetId: row.id, detail: { store: storeCodes.name(row.store), action, error: kind } });
    }).catch((failure: unknown) => request.log.error({ err: failure, purchaseId: row.id, action }, 'purchase: the failed action was not recorded'));
  }

  /**
   * The purchase's state is learnt later, by the worker: a re-check now
   * (the store asked), or with `refunded` the refund the store made applied
   * from the stored row (a read cannot tell it: Google shows a refunded
   * subscription as EXPIRED).
   */
  async function queueRecheck(request: FastifyRequest, row: KnownPurchase, store: AppStore, refunded = false): Promise<SideEffects> {
    const at = Date.now();
    return afterCommit(
      request,
      'queue the re-check',
      () =>
        app.jobs.add('iap', 'recheck', iapJobIds.recheck(row.id, at), { purchaseId: row.id, store, atMs: at, ...(refunded ? { refunded: true } : {}) }, { attempts: FOLLOW_UP_ATTEMPTS, backoffMs: FOLLOW_UP_BACKOFF_MS }),
      { purchaseId: row.id },
    );
  }

  /** Applies a verified state on its own (after the store acted); false when it could not be written (a re-check is queued). */
  async function applyAfterStore(request: FastifyRequest, row: KnownPurchase, store: AppStore, next: AfterStore): Promise<{ applied: boolean; sideEffects: SideEffects }> {
    try {
      const out = await withIdLease(() => app.store.core.apply(next.verified, context(row, store)));
      if (out.outcome === 'foreign_account' || out.outcome === 'unknown_product') throw new Error(`purchase: the store's state was not applied (${out.outcome})`);
      return { applied: true, sideEffects: 'done' };
    } catch (error) {
      request.log.error({ err: error, purchaseId: row.id }, 'purchase: the store acted, its state was not applied here; a re-check is queued');
      const queued = await queueRecheck(request, row, store, next.refunded);
      return { applied: false, sideEffects: worst('failed', queued) };
    }
  }

  const answer = async (request: FastifyRequest, id: string, outcome: PurchaseOutcome, sideEffects: SideEffects): Promise<AdminPurchaseActionResult> => ({
    purchase: await purchaseDetail(app, request, id),
    outcome,
    sideEffects,
  });

  app.post(
    '/v1/admin/purchases/:id/recheck',
    {
      preHandler: app.requirePermission('billing.write'),
      // The row (1), the statement and its audit row in one transaction (2), the page (1).
      config: { pgBudget: 4 },
      schema: { tags, summary: "Ask the store for the purchase's state now and apply it", params: purchaseParams, body: adminPurchaseRecheckSchema, response: { 200: adminPurchaseActionResultSchema } },
    },
    async (request) => {
      await takeAdminLimit(app, request, 'purchase-recheck', PURCHASE_RECHECKS_PER_HOUR);
      const { row, store, verifier } = await load(request.params.id);
      if (!verifier || store === null) throw storeUnavailable();
      requireAction(app, request, row, verifier, 'recheck');
      return withPurchaseLock(app, request, row.id, async () => {
        let verified: VerifiedPurchase;
        try {
          verified = await verifier.recheck(purchaseRefOf(row, store), { urgent: true });
        } catch (error) {
          throw storeRefusal(error);
        }
        const note = request.body.note;
        // The store names no account of ours: the row says so, then the store's refund and revoke is queued (never before it).
        const foreign: AuditEntry = {
          action: 'purchase.recheck',
          target: 'purchase',
          targetId: row.id,
          detail: { store, from: purchaseState.name(row.state), outcome: 'foreign_account', revoke: 'queued', ...(note ? { note } : {}) },
        };
        const prepared = await withIdLease(() => app.store.core.prepare(verified, context(row, store), { deferForeign: true }));
        if (prepared.status === 'answered') {
          if (prepared.applied.outcome !== 'foreign_account') throw adminConflict('store_refused', `The store's answer cannot be applied (${prepared.applied.outcome}).`);
          await adminWrite(app, request, async (_tx, trail) => {
            trail.record(foreign);
          });
          await afterCommit(request, 'queue the store revoke', () => app.store.core.queueForeignRevoke(verified, context(row, store)), { purchaseId: row.id });
          throw foreignAccount();
        }
        const out = await adminWrite(app, request, async (tx, trail): Promise<PurchaseApplied> => {
          const applied = await applyStorePurchase(tx, prepared.prepared.input);
          if (applied.outcome === 'foreign_account') {
            trail.record(foreign);
            return applied;
          }
          trail.record({
            action: 'purchase.recheck',
            target: 'purchase',
            targetId: row.id,
            detail: { store, from: purchaseState.name(row.state), to: purchaseState.name(applied.state), outcome: applied.outcome, ...(note ? { note } : {}) },
          });
          return applied;
        });
        // A foreign account's revoke is queued here, after its row committed.
        const sideEffects = await afterCommit(request, 'apply the store state', () => app.store.core.complete(prepared.prepared, out), { purchaseId: row.id });
        if (out.outcome === 'foreign_account') throw foreignAccount();
        return answer(request, row.id, out.outcome === 'applied' ? 'done' : 'unchanged', sideEffects);
      });
    },
  );

  /**
   * A stop of renewal or a refund: the audit row (with the row locked and
   * its state checked) commits before the store is asked; then the store's
   * call, then the state applied.
   */
  async function storeAction(
    request: FastifyRequest,
    id: string,
    action: Extract<PurchaseAction, 'cancel' | 'refund' | 'refund_prorated'>,
    from: string,
    detail: Record<string, unknown>,
    call: (verifier: StoreVerifier, row: KnownPurchase, store: AppStore) => Promise<StoreActionOutcome>,
    after: (verifier: StoreVerifier, row: KnownPurchase, store: AppStore, done: StoreActionOutcome) => Promise<AfterStore>,
  ): Promise<AdminPurchaseActionResult> {
    await takeAdminLimit(app, request, 'purchase-action', PURCHASE_ACTIONS_PER_HOUR);
    const { row, store, verifier } = await load(id);
    if (!verifier || store === null) throw storeUnavailable();
    requireAction(app, request, row, verifier, action);
    requireState(row.state, from);
    return withPurchaseLock(app, request, row.id, async () => {
      await adminWrite(app, request, async (tx, trail) => {
        const locked = await adminLockPurchase(tx, row.id);
        if (!locked) throw noSuchPurchase();
        requireState(locked.state, from);
        requireAction(app, request, { ...row, state: locked.state, autoRenew: locked.autoRenew }, verifier, action);
        trail.record({ action: action === 'cancel' ? 'purchase.cancel' : 'purchase.refund', target: 'purchase', targetId: row.id, detail: { store, from, ...detail } });
      });
      let done: StoreActionOutcome;
      try {
        done = await call(verifier, row, store);
      } catch (error) {
        await recordFailure(request, row, action, error);
        throw storeRefusal(error);
      }
      let next: AfterStore | null = null;
      try {
        next = await after(verifier, row, store, done);
      } catch (error) {
        request.log.warn({ err: error, purchaseId: row.id }, 'purchase: the store acted, its state could not be read; a re-check is queued');
      }
      if (!next) {
        const queued = await queueRecheck(request, row, store);
        return answer(request, row.id, 'pending', queued);
      }
      const applied = await applyAfterStore(request, row, store, next);
      return answer(request, row.id, applied.applied ? done : 'pending', applied.sideEffects);
    });
  }

  app.post(
    '/v1/admin/purchases/:id/cancel',
    {
      preHandler: app.requirePermission('billing.refund'),
      // The row (1), the locked state and the audit row (2), the store's state applied (1), the page (1).
      config: { pgBudget: 5 },
      schema: { tags, summary: "Stop a subscription's renewal at the store (access runs to its expiry)", params: purchaseParams, body: adminPurchaseCancelSchema, response: { 200: adminPurchaseActionResultSchema } },
    },
    async (request) => {
      const { from, note } = request.body;
      return storeAction(
        request,
        request.params.id,
        'cancel',
        from,
        { note },
        (verifier, row, store) => verifier.cancel(purchaseRefOf(row, store)),
        // What the store shows now (renewal off), read again.
        async (verifier, row, store) => ({ verified: await verifier.recheck(purchaseRefOf(row, store), { urgent: true }), refunded: false }),
      );
    },
  );

  app.post(
    '/v1/admin/purchases/:id/refund',
    {
      preHandler: app.requirePermission('billing.refund'),
      // The row (1), the locked state and the audit row (2), the refunded state applied (1), the page (1).
      config: { pgBudget: 5 },
      schema: { tags, summary: 'Refund a purchase at the store (access ends now; a subscription in full or for its unused time)', params: purchaseParams, body: adminPurchaseRefundSchema, response: { 200: adminPurchaseActionResultSchema } },
    },
    async (request) => {
      const { from, note } = request.body;
      const prorated = request.body.prorated ?? false;
      return storeAction(
        request,
        request.params.id,
        prorated ? 'refund_prorated' : 'refund',
        from,
        { prorated, note },
        (verifier, row, store) => verifier.refund(purchaseRefOf(row, store), { prorated }),
        async (verifier, row, store, done) =>
          // A subscription the store would not refund was over there: refunded before, or simply run out (Google shows
          // both as EXPIRED). Its own state is applied; a refund that did happen comes by notification or the voided list.
          done === 'already' && row.kind === 1
            ? { verified: await verifier.recheck(purchaseRefOf(row, store), { urgent: true }), refunded: false }
            : // The store refunded it: the refund is the state (its own record follows by notification or re-check).
              { verified: verifiedFromRow(row, 'revoked', eventMsAfter(row)), refunded: true },
      );
    },
  );

  app.post(
    '/v1/admin/purchases/:id/revoke',
    {
      preHandler: app.requirePermission('billing.refund'),
      // The row (1), the statement and its audit row in one transaction (2), the page (1).
      config: { pgBudget: 4 },
      schema: { tags, summary: 'Mark a purchase refunded here (refunded elsewhere): access ends now, nothing asked of the store', params: purchaseParams, body: adminPurchaseRevokeSchema, response: { 200: adminPurchaseActionResultSchema } },
    },
    async (request) => {
      await takeAdminLimit(app, request, 'purchase-action', PURCHASE_ACTIONS_PER_HOUR);
      const { from, note } = request.body;
      const { row, verifier } = await load(request.params.id);
      const store = appStoreOf(row.store);
      if (store === null) throw adminConflict('action_not_available', 'This purchase is of a store no build ships in.');
      requireAction(app, request, row, verifier, 'revoke');
      requireState(row.state, from);
      return withPurchaseLock(app, request, row.id, async () => {
        const prepared = await withIdLease(() => app.store.core.prepare(verifiedFromRow(row, 'revoked', eventMsAfter(row)), context(row, store)));
        if (prepared.status === 'answered') throw adminConflict('action_not_available', `This purchase cannot be marked refunded (${prepared.applied.outcome}).`);
        const out = await adminWrite(app, request, async (tx, trail) => {
          const applied = await applyStorePurchase(tx, prepared.prepared.input);
          // The statement locked the row: the state it found is the one the admin saw, or nothing is written.
          if (applied.outcome !== 'applied' && applied.outcome !== 'unchanged') throw adminConflict('purchase_changed', 'The purchase changed meanwhile.');
          if (applied.stateFrom === null) throw adminConflict('purchase_changed', 'The purchase changed meanwhile.');
          requireState(applied.stateFrom, from);
          trail.record({
            action: 'purchase.revoke',
            target: 'purchase',
            targetId: row.id,
            detail: { store, from, note, debited: applied.debited, shortfall: applied.shortfall },
          });
          return applied;
        });
        const sideEffects = await afterCommit(request, 'apply the refunded state', () => app.store.core.complete(prepared.prepared, out), { purchaseId: row.id });
        return answer(request, row.id, 'done', sideEffects);
      });
    },
  );
};
