import { purchaseByToken } from '@app/db';
import {
  purchaseState,
  storeEventSource,
  store as storeCodes,
  wireTime,
  type AppStore,
  type Entitlements,
  type PurchasePending,
  type PurchaseResult,
  type RestorePurchase,
  type RestoreResult,
  type RestoreState,
} from '@app/shared';
import {
  isStoreError,
  lockPurchaseToken,
  readTokenRecords,
  tokenHash,
  unlockPurchaseToken,
  writeTokenRecord,
  type PurchaseSubmission,
  type StoreError,
  type TokenRecord,
} from '@app/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpProblem } from '../../lib/problem.js';
import type { AppSession } from '../session.js';

/**
 * Purchases the app sends (`POST /v1/store/<store>/purchases`) and restores
 * (`POST /v1/store/restore`). Nothing is granted before the store's own API
 * verified the purchase.
 *
 * A token the server has verified before costs no statement: its record in
 * kv-cache (`iap:t:`) answers, and a token owned by someone else is refused
 * the same way. Otherwise, in order and before anything is written:
 *
 * 1. the store must be configured (503 `store_unavailable`) and be the
 *    session's own (403 `store_not_supported`);
 * 2. the product must be in the catalogue (422 `purchase_invalid`);
 * 3. the store's local checks (Bazaar: the RSA signature over
 *    `originalJson`) and the account reference the purchase carries must
 *    match the session's `billingRef` (422 / 409), at no store call;
 * 4. one verification per token at a time (`iap:lock:`): a second request
 *    waits up to 3 s for the first one's record;
 * 5. one store call, then one statement (the purchase core), then the
 *    answer: 200 with the purchase and the session's entitlements, 202 while
 *    the store holds the payment (nothing granted), 409 when the purchase
 *    belongs to another of our accounts (it is recorded for its owner).
 *
 * A known subscription whose record grants nothing now but could again (on
 * hold, paused, expired) or whose expiry has passed is asked at the store
 * again (a notification or a re-check may have been missed), at most once
 * per token every 15 minutes (`iap:rv:`); the core writes only a change, so
 * a token whose state the store confirms costs one statement and no write.
 * When the store cannot be reached, the record answers as before.
 *
 * Suspended and banned accounts may send purchases and restore: a paid
 * period is never cut silently.
 */

const FINAL_STATES = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 12]);
/** Subscription states that grant nothing now but can grant again at the store. */
const RECOVERABLE_STATES = new Set([5, 6, 7]);
/** Subscription states that grant until the expiry. */
const GRANTING_STATES = new Set([2, 3, 4]);
export const REVERIFY_EVERY_SECONDS = 15 * 60;
const LOCK_WAIT_MS = 3_000;
const LOCK_POLL_MS = 100;

export type PurchaseAnswer = { status: 200; body: PurchaseResult } | { status: 202; body: PurchasePending };
/** An answer, and whether this call's write granted or credited the token for the first time (a restore says so). */
type AppliedAnswer = PurchaseAnswer & { fresh: boolean };

function storeProblem(error: StoreError): HttpProblem {
  if (error.kind === 'invalid') return new HttpProblem('purchase_invalid', { detail: 'The store does not confirm this purchase.' });
  const retry = String(Math.max(5, error.retryAfterSeconds ?? 30));
  return new HttpProblem('store_unavailable', { detail: 'The store cannot be reached now; try again later.', headers: { 'retry-after': retry }, cause: error });
}

function budget(request: FastifyRequest, statements: number): void {
  if (request.pgTally?.budget !== undefined) request.pgTally.budget += statements;
}

export class PurchaseService {
  constructor(private readonly app: FastifyInstance) {}

  private storeOf(session: AppSession): AppStore {
    if (!session.store) throw new HttpProblem('store_not_supported', { detail: 'This session belongs to no store build.' });
    return session.store;
  }

  /** The answer for a token the server knows, from its record: no statement when the entitlements are warm. */
  private async known(request: FastifyRequest, session: AppSession, record: TokenRecord): Promise<PurchaseAnswer> {
    if (record.u !== session.userId) throw new HttpProblem('purchase_other_account');
    if (record.s === purchaseState.code('pending')) return { status: 202, body: { purchase: { state: 'pending' } } };
    const product = this.app.store.catalog().product(record.r);
    const view = await this.app.store.entitlements.forSession(request, session.userId, session.storeCode ?? 0);
    return {
      status: 200,
      body: {
        purchase: {
          id: record.p,
          state: purchaseState.name(record.s) as PurchaseResult['purchase']['state'],
          productId: product?.productId ?? 'unknown',
          ...(record.x !== null ? { expiresAt: wireTime(record.x) } : {}),
        },
        entitlements: view.entitlements,
      },
    };
  }

  /**
   * Whether a known token of the caller is asked at the store again instead
   * of being answered from what the server recorded: a subscription that
   * grants nothing but can recover, or whose expiry passed, once per token
   * every 15 minutes (kv-core unreadable: no).
   */
  private async reverify(session: AppSession, known: { owner: string | null; state: number; productRef: number; expiresAtMs: number | null }, hash: string): Promise<boolean> {
    const { app } = this;
    if (known.owner !== session.userId) return false;
    if (app.store.catalog().product(known.productRef)?.kind !== 1) return false;
    const stale = RECOVERABLE_STATES.has(known.state) || (GRANTING_STATES.has(known.state) && known.expiresAtMs !== null && known.expiresAtMs <= Date.now());
    if (!stale) return false;
    const taken = await app.redis.set(app.keys.iapReverify(hash), '1', 'EX', REVERIFY_EVERY_SECONDS, 'NX').catch(() => null);
    return taken === 'OK';
  }

  /** `POST /v1/store/<store>/purchases`. */
  async submit(request: FastifyRequest, session: AppSession, submission: PurchaseSubmission): Promise<PurchaseAnswer> {
    const store = this.storeOf(session);
    if (submission.store !== store) throw new HttpProblem('store_not_supported', { detail: 'This purchase belongs to the other store build.' });
    const hash = tokenHash(submission.purchaseToken);
    const code = storeCodes.code(store);
    const [record] = await readTokenRecords(this.app.cache, this.app.keys, code, [hash]).catch(() => [null]);
    if (record && FINAL_STATES.has(record.s)) {
      if (!(await this.reverify(session, { owner: record.u, state: record.s, productRef: record.r, expiresAtMs: record.x }, hash))) return this.known(request, session, record);
      try {
        return await this.verifyAndApply(request, session, submission, hash, storeEventSource.code('app'));
      } catch (error) {
        // The store could not say, or refused what it confirmed before: the record answers, as it would have.
        if (error instanceof HttpProblem && ['store_unavailable', 'service_unavailable', 'purchase_invalid'].includes(error.code)) return this.known(request, session, record);
        throw error;
      }
    }
    return this.verifyAndApply(request, session, submission, hash, storeEventSource.code('app'));
  }

  private async verifyAndApply(request: FastifyRequest, session: AppSession, submission: PurchaseSubmission, hash: string, source: number): Promise<AppliedAnswer> {
    const { app } = this;
    const store = submission.store;
    const code = storeCodes.code(store);
    const verifier = app.store.verifiers[store];
    if (!verifier) throw new HttpProblem('store_unavailable', { detail: 'Purchases in this store are not available now.', headers: { 'retry-after': '300' } });
    const rows = app.store.catalog().productRows(code, submission.productId);
    const kind = submission.kind === 'subscription' ? 1 : 2;
    if (rows.length === 0 || !rows.some((r) => r.kind === kind)) throw new HttpProblem('purchase_invalid', { detail: 'Not a product of this store.' });

    const billingRef = app.publicIds.billing.encode(session.userId);
    let claim;
    try {
      claim = verifier.inspect(submission);
    } catch (error) {
      if (isStoreError(error)) throw storeProblem(error);
      throw error;
    }
    if (claim.accountRef !== null && claim.accountRef !== billingRef) {
      // Signed for another account: refused before any store call.
      throw app.publicIds.billing.decodeId(claim.accountRef) === null ? new HttpProblem('purchase_invalid') : new HttpProblem('purchase_other_account');
    }

    const lock = await lockPurchaseToken(app.redis, app.keys, hash).catch((error: unknown) => {
      request.log.warn({ err: error }, 'store: purchase lock unavailable');
      throw new HttpProblem('service_unavailable', { detail: 'Try again in a moment.', headers: { 'retry-after': '2' } });
    });
    // Another request holds the token: whatever it grants, this call did not.
    if (!lock) return { ...(await this.waitForOther(request, session, code, hash)), fresh: false };
    try {
      let verified;
      try {
        verified = await verifier.verify(submission);
      } catch (error) {
        if (isStoreError(error)) throw storeProblem(error);
        throw error;
      }
      if (verified.kind !== submission.kind) throw new HttpProblem('purchase_invalid', { detail: 'The store names another kind of product.' });
      budget(request, 1);
      const applied = await app.store.core.apply(verified, { store, token: submission.purchaseToken, callerId: session.userId, source, viewStore: session.storeCode ?? code });
      if (applied.outcome === 'foreign_account' || applied.outcome === 'unknown_product') throw new HttpProblem('purchase_invalid');
      if (applied.userId !== session.userId) throw new HttpProblem('purchase_other_account');
      if (applied.state === purchaseState.code('pending')) return { status: 202, body: { purchase: { state: 'pending' } }, fresh: false };
      let entitlements: Entitlements | null = applied.entitlements;
      if (!entitlements || (session.storeCode ?? code) !== code) {
        entitlements = (await app.store.entitlements.forSession(request, session.userId, session.storeCode ?? code)).entitlements;
      }
      return {
        status: 200,
        body: {
          purchase: {
            id: applied.purchaseId,
            state: purchaseState.name(applied.state) as PurchaseResult['purchase']['state'],
            productId: applied.product.productId,
            ...(applied.expiresAtMs !== null ? { expiresAt: wireTime(applied.expiresAtMs) } : {}),
          },
          entitlements,
        },
        fresh: applied.firstGrant,
      };
    } finally {
      await unlockPurchaseToken(app.redis, app.keys, hash, lock).catch(() => undefined);
    }
  }

  /** Another request is verifying the same token: its record answers this one too. */
  private async waitForOther(request: FastifyRequest, session: AppSession, code: number, hash: string): Promise<PurchaseAnswer> {
    const { app } = this;
    const until = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      const [record] = await readTokenRecords(app.cache, app.keys, code, [hash]).catch(() => [null]);
      if (record && FINAL_STATES.has(record.s)) return this.known(request, session, record);
      if (record?.s === purchaseState.code('pending')) {
        if (record.u !== session.userId) throw new HttpProblem('purchase_other_account');
        return { status: 202, body: { purchase: { state: 'pending' } } };
      }
    }
    throw new HttpProblem('store_unavailable', { detail: 'This purchase is being checked; try again in a moment.', headers: { 'retry-after': '2' } });
  }

  /**
   * `POST /v1/store/restore`: each token is answered from its record (no
   * statement), else from its row (one read, no write), else verified as a
   * new purchase. A token of another account, or one the store refuses, is
   * answered as such and nothing is granted for it. `fresh` is true only for
   * a token this call's own write granted or credited for the first time; a
   * known token answered from its record or row is never fresh.
   */
  async restore(request: FastifyRequest, session: AppSession, purchases: readonly RestorePurchase[]): Promise<RestoreResult> {
    const { app } = this;
    const store = this.storeOf(session);
    const code = storeCodes.code(store);
    const hashes = purchases.map((p) => tokenHash(p.purchaseToken));
    const records = await readTokenRecords(app.cache, app.keys, code, hashes).catch(() => hashes.map(() => null));
    const results: RestoreResult['results'] = [];
    const seen = new Set<string>();
    for (const [i, item] of purchases.entries()) {
      const hash = hashes[i]!;
      if (seen.has(hash)) continue;
      seen.add(hash);
      const { state, fresh } = await this.restoreOne(request, session, store, code, item, hash, records[i] ?? null);
      results.push({ purchaseToken: item.purchaseToken, state, fresh });
    }
    const view = await app.store.entitlements.forSession(request, session.userId, session.storeCode ?? code);
    return { results, entitlements: view.entitlements };
  }

  private async restoreOne(
    request: FastifyRequest,
    session: AppSession,
    store: AppStore,
    code: number,
    item: RestorePurchase,
    hash: string,
    record: TokenRecord | null,
  ): Promise<{ state: RestoreState; fresh: boolean }> {
    const { app } = this;
    const answer = (owner: string | null, state: number): RestoreState | null => {
      if (!FINAL_STATES.has(state)) return null;
      if (owner !== session.userId) return 'other_account';
      return purchaseState.name(state) as RestoreState;
    };
    // A known answer, and whether the store is asked again first (a subscription that may have recovered or renewed).
    let known: RestoreState | null = null;
    let again = false;
    if (record) {
      known = answer(record.u, record.s);
      if (known) again = await this.reverify(session, { owner: record.u, state: record.s, productRef: record.r, expiresAtMs: record.x }, hash);
    } else {
      budget(request, 1);
      const row = await purchaseByToken(app.pg, code, hash);
      if (row) {
        known = answer(row.userId, row.state);
        if (known) {
          await writeTokenRecord(app.cache, app.keys, code, hash, { p: row.id, u: row.userId, s: row.state, r: row.productRef, x: row.expiresAtMs }).catch(() => undefined);
          again = await this.reverify(session, { owner: row.userId, state: row.state, productRef: row.productRef, expiresAtMs: row.expiresAtMs }, hash);
        }
      }
    }
    if (known && !again) return { state: known, fresh: false };
    if (store === 'bazaar' && (item.originalJson === undefined || item.signature === undefined)) return { state: known ?? 'invalid', fresh: false };
    const submission: PurchaseSubmission = {
      store,
      productId: item.productId,
      purchaseToken: item.purchaseToken,
      kind: item.kind,
      ...(item.originalJson !== undefined ? { originalJson: item.originalJson } : {}),
      ...(item.signature !== undefined ? { signature: item.signature } : {}),
    };
    try {
      const out = await this.verifyAndApply(request, session, submission, hash, storeEventSource.code('restore'));
      return { state: out.status === 202 ? 'pending' : out.body.purchase.state, fresh: out.fresh };
    } catch (error) {
      if (!(error instanceof HttpProblem)) throw error;
      if (error.code === 'purchase_other_account') return { state: 'other_account', fresh: false };
      if (error.code === 'store_unavailable' || error.code === 'service_unavailable') return { state: known ?? 'unavailable', fresh: false };
      if (error.code === 'purchase_invalid' || error.code === 'store_not_supported') return { state: known ?? 'invalid', fresh: false };
      throw error;
    }
  }
}
