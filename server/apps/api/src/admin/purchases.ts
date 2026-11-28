import { randomBytes } from 'node:crypto';
import { adminPurchaseView, type AdminPurchaseEventRow, type AdminPurchaseRow, type AdminPurchaseView, type KnownPurchase } from '@app/db';
import {
  auditActions,
  encodeCursor,
  idTime,
  productKind,
  purchaseActions,
  purchaseState,
  storeEventKind,
  storeEventSource,
  store as storeCodes,
  walletItem,
  wireTime,
  type AdminPurchaseDetail,
  type AdminPurchaseEvent,
  type AdminPurchaseHistory,
  type AdminPurchaseListItem,
  type AdminPurchaseSummary,
  type AppStore,
  type AuditAction,
  type PurchaseAction,
} from '@app/shared';
import { isStoreError, offersAdminAction, type PurchaseRef, type StoreError, type StoreVerifier } from '@app/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpProblem } from '../lib/problem.js';
import { adminIdOf } from '../routes/adminAuth.js';
import { adminConflict } from './problems.js';
import { callerMay, userRefOf } from './refs.js';

/**
 * What the revenue routes share: the store integration of a purchase (read
 * from `app.store.verifiers` on every call, so a store connected or
 * disconnected at run time is followed), what an admin may do with a
 * purchase now, the one-action-at-a-time lock of a purchase, the
 * once-per-dialog key of grant and wallet writes, and the purchase as the
 * admin wire shows it (never its token or a hash of it).
 */

/** The first page of a purchase's events on its page, and every later page's size by default. */
export const PURCHASE_EVENTS_PAGE = 50;
/** One admin action per purchase at a time; longer than any store call it waits for. */
export const PURCHASE_LOCK_SECONDS = 120;
/** A grant or wallet dialog's `requestId` is remembered this long. */
export const ADMIN_ONCE_SECONDS = 3_600;

/** Subscription states with a live paid period (a refund gives money back). */
const REFUNDABLE_SUBSCRIPTION = new Set([2, 3, 4]);
/** Consumable states that were credited. */
const REFUNDABLE_CONSUMABLE = new Set([10, 12]);
/** Subscription states whose renewal can still be stopped (with auto-renew on). */
const CANCELLABLE = new Set([2, 4, 5, 6]);
/** States that granted or may grant again: what "mark refunded" may end. */
const REVOCABLE = new Set([2, 3, 4, 5, 6, 10, 12]);

/** The app store of a store code (null for one no build ships in). */
export function appStoreOf(code: number): AppStore | null {
  const name = storeCodes.nameOrUndefined(code);
  return name === 'play' || name === 'bazaar' ? name : null;
}

/** The integration of a store, as this process holds it now (none without credentials). */
export function verifierOf(app: FastifyInstance, store: AppStore | null): StoreVerifier | undefined {
  return store === null ? undefined : app.store.verifiers[store];
}

/** A stored purchase as the store integrations take it. */
export function purchaseRefOf(row: KnownPurchase, store: AppStore): PurchaseRef {
  return {
    purchaseId: row.id,
    store,
    kind: row.kind === 1 ? 'subscription' : 'consumable',
    token: row.token,
    productId: row.productId,
    basePlanId: row.basePlanId,
    orderId: row.orderId,
    purchasedAtMs: row.purchasedAtMs,
    expiresAtMs: row.expiresAtMs,
    quantity: row.quantity,
  };
}

export interface ActionSubject {
  store: number;
  /** 1 subscription, 2 consumable. */
  kind: number;
  state: number;
  autoRenew: boolean | null;
}

/**
 * What the caller may do with a purchase now: what its store's API offers
 * for the kind (and this server is connected to it), what the state allows,
 * and what the caller's roles grant. Re-check: any state, `billing.write`.
 * Stop renewal, refund and mark refunded: `billing.refund`. Mark refunded
 * needs no store.
 */
export function availableActions(app: FastifyInstance, request: FastifyRequest, row: ActionSubject, verifier: StoreVerifier | undefined): PurchaseAction[] {
  const kind = row.kind === 1 ? 'subscription' : 'consumable';
  const out: PurchaseAction[] = [];
  const refunds = callerMay(app, request, 'billing.refund');
  if (verifier && callerMay(app, request, 'billing.write')) out.push('recheck');
  if (verifier && refunds) {
    if (kind === 'subscription' && row.autoRenew === true && CANCELLABLE.has(row.state) && offersAdminAction(verifier, kind, 'cancel')) out.push('cancel');
    const refundable = kind === 'subscription' ? REFUNDABLE_SUBSCRIPTION.has(row.state) : REFUNDABLE_CONSUMABLE.has(row.state);
    if (refundable && offersAdminAction(verifier, kind, 'refund')) out.push('refund');
    if (refundable && kind === 'subscription' && offersAdminAction(verifier, kind, 'refund_prorated')) out.push('refund_prorated');
  }
  if (refunds && REVOCABLE.has(row.state)) out.push('revoke');
  return out;
}

/** 409 `action_not_available` unless the caller may do `action` with the purchase now. */
export function requireAction(app: FastifyInstance, request: FastifyRequest, row: ActionSubject, verifier: StoreVerifier | undefined, action: PurchaseAction): void {
  if (!availableActions(app, request, row, verifier).includes(action)) {
    throw adminConflict('action_not_available', `This purchase does not allow ${action} now (store, kind, state or connection).`);
  }
}

/** 409 `purchase_changed` when the purchase is in another state than the admin saw. */
export function requireState(state: number, from: string): void {
  if (purchaseState.name(state) !== from) throw adminConflict('purchase_changed', 'The purchase changed meanwhile.');
}

/** 503 `store_unavailable`: the store is not connected in this process, or could not be asked now. */
export function storeUnavailable(error?: StoreError): HttpProblem {
  const retry = String(Math.max(5, error?.retryAfterSeconds ?? 30));
  return new HttpProblem('store_unavailable', { detail: 'The store cannot be reached now; try again later.', headers: { 'retry-after': retry }, ...(error ? { cause: error } : {}) });
}

/** A store's answer to an admin action as the route's refusal: `invalid` is the store refusing (409), anything else 503. */
export function storeRefusal(error: unknown): HttpProblem {
  if (isStoreError(error, 'invalid')) return adminConflict('store_refused', 'The store refused this action.');
  return storeUnavailable(isStoreError(error) ? error : undefined);
}

const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

/** Runs `fn` holding the purchase's admin lock: one admin action per purchase at a time (409 `purchase_busy`; Valkey down: 503). */
export async function withPurchaseLock<T>(app: FastifyInstance, request: FastifyRequest, purchaseId: string, fn: () => Promise<T>): Promise<T> {
  const key = app.keys.adminPurchaseLock(purchaseId);
  const value = `${adminIdOf(request)}:${randomBytes(6).toString('base64url')}`;
  let taken: string | null;
  try {
    taken = await app.redis.set(key, value, 'EX', PURCHASE_LOCK_SECONDS, 'NX');
  } catch (error) {
    throw new HttpProblem('service_unavailable', { detail: 'Try again in a moment.', headers: { 'retry-after': '5' }, cause: error });
  }
  if (taken !== 'OK') throw adminConflict('purchase_busy', 'Another admin action on this purchase is running.');
  try {
    return await fn();
  } finally {
    await app.redis.eval(RELEASE, 1, key, value).catch((error: unknown) => request.log.warn({ err: error }, 'purchase lock not released (it runs out by itself)'));
  }
}

export interface OnceClaim {
  /** Forgets the request id again (its write failed: the dialog may send it once more). */
  release(): Promise<void>;
}

/** Takes a dialog's request id for good (409 `duplicate_request` when it was taken before; Valkey down: 503). */
export async function claimRequestOnce(app: FastifyInstance, request: FastifyRequest, requestId: string): Promise<OnceClaim> {
  const key = app.keys.adminOnce(adminIdOf(request), requestId);
  let taken: string | null;
  try {
    taken = await app.redis.set(key, '1', 'EX', ADMIN_ONCE_SECONDS, 'NX');
  } catch (error) {
    throw new HttpProblem('service_unavailable', { detail: 'Try again in a moment.', headers: { 'retry-after': '5' }, cause: error });
  }
  if (taken !== 'OK') throw adminConflict('duplicate_request', 'This request was sent before.');
  return {
    async release() {
      await app.redis.del(key).catch((error: unknown) => request.log.warn({ err: error }, 'request id not released (it runs out within the hour)'));
    },
  };
}

/**
 * The store whose view of a person's entitlements an event of theirs should
 * carry: the build they used lately (the one whose cached view exists;
 * Play first), read before the change removes the cached views. 0: none
 * cached, nothing is published.
 */
export async function viewStoreOf(app: FastifyInstance, request: FastifyRequest, userId: string): Promise<number> {
  try {
    const [play, bazaar] = await app.cache.mget(app.keys.entitlements(userId, storeCodes.code('play')), app.keys.entitlements(userId, storeCodes.code('bazaar')));
    return play ? storeCodes.code('play') : bazaar ? storeCodes.code('bazaar') : 0;
  } catch (error) {
    request.log.warn({ err: error }, 'entitlements: cached views unreadable; the change is not published');
    return 0;
  }
}

const ms = (value: number | null) => (value === null ? null : wireTime(value));

/** A row of a store's list: everything but the order id (see `adminPurchaseListItemSchema`). */
export function purchaseListItemOf(app: FastifyInstance, row: AdminPurchaseRow): AdminPurchaseListItem {
  const { orderId: _orderId, ...item } = purchaseSummaryOf(app, row);
  return item;
}

/** A purchase row on the admin wire (the page, the search). */
export function purchaseSummaryOf(app: FastifyInstance, row: AdminPurchaseRow): AdminPurchaseSummary {
  return {
    id: row.id,
    store: storeCodes.name(row.store),
    productId: row.productId,
    basePlanId: row.basePlanId,
    kind: productKind.name(row.kind),
    plan: row.plan,
    item: row.item === null ? null : walletItem.name(row.item),
    grantQuantity: row.grantQuantity,
    quantity: row.quantity,
    state: purchaseState.name(row.state),
    user: row.user ? userRefOf(app, row.user) : null,
    purchasedAt: wireTime(row.purchasedAtMs),
    expiresAt: ms(row.expiresAtMs),
    autoRenew: row.autoRenew,
    orderId: row.orderId,
    isTest: row.isTest,
    region: row.region,
  };
}

/** A store event on the admin wire (an unknown code reads as `other`). */
export function purchaseEventOf(row: AdminPurchaseEventRow): AdminPurchaseEvent {
  return {
    id: row.id,
    at: wireTime(row.atMs),
    event: storeEventKind.nameOrUndefined(row.event) ?? 'other',
    source: storeEventSource.name(row.source),
    stateFrom: row.stateFrom === null ? null : purchaseState.name(row.stateFrom),
    stateTo: purchaseState.name(row.stateTo),
    expiresAt: ms(row.expiresAtMs),
    amount: row.amountMicros !== null && row.currency !== null ? { micros: row.amountMicros, currency: row.currency, estimated: row.estimated } : null,
    orderId: row.orderId,
  };
}

const ACTIONS: ReadonlySet<string> = new Set(auditActions);
const PURCHASE_ACTIONS: ReadonlySet<string> = new Set(purchaseActions);

function historyOf(rows: AdminPurchaseView['history']): AdminPurchaseHistory[] {
  return rows
    .filter((row) => ACTIONS.has(row.action))
    .map((row) => ({
      id: row.id,
      at: wireTime(idTime(row.id)),
      action: row.action as AuditAction,
      admin: row.admin ? { id: row.admin.id, displayName: row.admin.displayName } : null,
      note: row.note,
      error: row.error === 'refused' || row.error === 'unavailable' ? row.error : null,
      failed: row.failed !== null && PURCHASE_ACTIONS.has(row.failed) ? (row.failed as PurchaseAction) : null,
    }));
}

/** The purchase page's answer: every stored column but the token material, its events, its admin history and what the caller may do. */
export function purchaseDetailOf(app: FastifyInstance, request: FastifyRequest, view: AdminPurchaseView): AdminPurchaseDetail {
  const verifier = verifierOf(app, appStoreOf(view.store));
  const page = view.events.slice(0, PURCHASE_EVENTS_PAGE);
  const last = page.at(-1);
  return {
    ...purchaseSummaryOf(app, view),
    period: view.period,
    acknowledgedAt: ms(view.acknowledgedAtMs),
    consumedAt: ms(view.consumedAtMs),
    creditedAt: ms(view.creditedAtMs),
    nextCheckAt: ms(view.nextCheckAtMs),
    updatedAt: wireTime(view.updatedAtMs),
    counts: view.counts,
    replaces: view.replaces,
    replacedBy: view.replacedBy,
    wallet: view.kind === 2 ? { credited: view.credited ?? 0, takenBack: view.takenBack ?? 0 } : null,
    events: {
      items: page.map(purchaseEventOf),
      nextCursor: view.events.length > PURCHASE_EVENTS_PAGE && last ? encodeCursor({ id: last.id }) : null,
    },
    history: historyOf(view.history),
    connected: verifier !== undefined,
    available: availableActions(app, request, view, verifier),
  };
}

/** The purchase page of `purchaseId` (one statement); 404 for an unknown id. */
export async function purchaseDetail(app: FastifyInstance, request: FastifyRequest, purchaseId: string): Promise<AdminPurchaseDetail> {
  const view = await adminPurchaseView(app.pg, purchaseId, { events: PURCHASE_EVENTS_PAGE });
  if (!view) throw noSuchPurchase();
  return purchaseDetailOf(app, request, view);
}

export function noSuchPurchase(): HttpProblem {
  return new HttpProblem('not_found', { detail: 'No such purchase.' });
}
