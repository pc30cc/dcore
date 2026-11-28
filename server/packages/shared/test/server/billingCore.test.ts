import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PurchaseCore,
  StoreCatalog,
  createKeys,
  createPublicIds,
  verifiedFromRow,
  type CatalogPlan,
  type PurchaseApplyInput,
  type PurchaseApplyOutcome,
  type StoreProductRow,
  type VerifiedPurchase,
} from '../../src/server/index.js';
import { dropPrefix, hasRedis, testPrefix, testRedis } from './support.js';

/**
 * The purchase core split in two: `prepare()` makes the statement's input
 * without writing, `complete()` does everything after it. `apply()` is the
 * two around the process's own statement, so a caller that runs the
 * statement in its own transaction (an admin action with its audit row)
 * gets exactly what `apply()` would have done.
 */

const DAY = 86_400_000;

describe('the stored purchase as a verified state', () => {
  const stored = {
    kind: 1,
    productId: 'sub.plus',
    basePlanId: 'm1',
    purchasedAtMs: 1_000,
    expiresAtMs: 5_000,
    orderId: 'GPA.1',
    quantity: 1,
    acknowledged: true,
    consumed: false,
  };

  it('keeps the row, stops the renewal and the next check, and carries the time asked', () => {
    expect(verifiedFromRow(stored, 'revoked', 9_000)).toEqual({
      kind: 'subscription',
      productId: 'sub.plus',
      basePlanId: 'm1',
      state: 'revoked',
      purchasedAtMs: 1_000,
      expiresAtMs: 5_000,
      autoRenew: false,
      accountRef: null,
      orderId: 'GPA.1',
      linkedPurchaseToken: null,
      quantity: 1,
      isTest: false,
      region: null,
      acknowledged: true,
      consumed: false,
      eventMs: 9_000,
      amount: null,
      nextCheckAtMs: null,
      refundCheckAtMs: null,
      needsAcknowledge: false,
      needsConsume: false,
    });
    expect(verifiedFromRow({ ...stored, kind: 2, expiresAtMs: null }, 'revoked', 9_000)).toMatchObject({ kind: 'consumable', autoRenew: null });
  });
});

describe.skipIf(!hasRedis)('prepare and complete', () => {
  let redis: Redis;
  const prefix = testPrefix();
  const keys = createKeys(prefix);
  const publicIds = createPublicIds(Buffer.alloc(32, 7).toString('base64url'), Buffer.alloc(32, 9).toString('base64url'));
  const plan: CatalogPlan = { id: 2, key: 'plus', rank: 1, sort: 0, active: true, archivedAtMs: null, badge: 0, names: {}, descriptions: {}, features: {} };
  const product: StoreProductRow = {
    id: 11, store: 1, kind: 1, planId: 2, period: 'P1M', item: null, quantity: null, productId: 'sub.plus', basePlanId: 'm1', badge: 0, sort: 0, active: true, listPriceMinor: null, listCurrency: null,
  };
  const catalog = new StoreCatalog([product], [plan]);
  let next = 1_000;
  const now = Date.now();

  beforeAll(() => {
    redis = testRedis();
  });
  afterAll(async () => {
    await dropPrefix(redis, prefix);
    await redis.quit();
  });

  function core(written: PurchaseApplyInput[], jobs: string[]) {
    return new PurchaseCore({
      apply: async (input) => {
        written.push(input);
        return outcome(input);
      },
      redis,
      cache: redis,
      keys,
      publicIds,
      realtime: null,
      ids: { nextId: () => String((next += 1)) },
      jobs: { add: async (_name, id) => void jobs.push(id) },
      settings: () => ({ plans: [{ id: 2, key: 'plus', rank: 1, features: {} }], crossStore: false, catalog }),
      manageUrl: () => undefined,
      log: { warn: () => undefined, error: () => undefined },
      now: () => now,
    });
  }

  function outcome(input: PurchaseApplyInput): PurchaseApplyOutcome {
    return {
      outcome: 'applied', purchaseId: '77', userId: '5', state: input.state, stateFrom: null, created: true, event: 1, productRef: input.productRef, kind: 1,
      expiresAtMs: input.expiresAtMs, acknowledged: input.acknowledged, consumed: false, credited: 0, debited: 0, shortfall: 0, subscriptionChanged: true,
      replaced: null, replacedUserId: null, replacedRows: null,
      rows: { subs: [{ store: 1, planId: 2, status: 1, autoRenew: true, startedAtMs: now - DAY, expiresAtMs: now + 30 * DAY, productId: 'sub.plus', basePlanId: 'm1' }], wallet: [] },
    };
  }

  const verified = (over: Partial<VerifiedPurchase> = {}): VerifiedPurchase => ({
    ...verifiedFromRow({ kind: 1, productId: 'sub.plus', basePlanId: 'm1', purchasedAtMs: now - DAY, expiresAtMs: now + 30 * DAY, orderId: 'GPA.2', quantity: 1, acknowledged: true, consumed: false }, 'active', now),
    autoRenew: true,
    nextCheckAtMs: now + 31 * DAY,
    ...over,
  });

  it('writes nothing in prepare, and the two halves do what apply does', async () => {
    const viaApply: PurchaseApplyInput[] = [];
    const applyJobs: string[] = [];
    const a = await core(viaApply, applyJobs).apply(verified(), { store: 'play', token: 'tok-core-1', callerId: '5', source: 5 });
    const viaParts: PurchaseApplyInput[] = [];
    const partJobs: string[] = [];
    const split = core(viaParts, partJobs);
    const prepared = await split.prepare(verified(), { store: 'play', token: 'tok-core-1', callerId: '5', source: 5 });
    expect(viaParts).toEqual([]);
    expect(prepared.status).toBe('ready');
    if (prepared.status !== 'ready') return;
    const b = await split.complete(prepared.prepared, outcome(prepared.prepared.input));
    const { id: _a, eventId: _ae, linkedEventId: _al, ledgerId: _ad, ...inputA } = viaApply[0]!;
    const { id: _b, eventId: _be, linkedEventId: _bl, ledgerId: _bd, ...inputB } = prepared.prepared.input;
    expect(inputB).toEqual(inputA);
    expect(inputB).toMatchObject({ source: 5, state: 2, productRef: 11, callerId: '5' });
    expect(partJobs).toEqual(applyJobs);
    expect(partJobs.some((id) => id.startsWith('recheck.77.'))).toBe(true);
    expect({ ...b, entitlements: null, base: null }).toEqual({ ...a, entitlements: null, base: null });
    expect(b).toMatchObject({ outcome: 'applied', changed: true, firstGrant: true });
    // The token's record was written, as apply writes it.
    expect(await redis.exists(keys.iapToken(1, prepared.prepared.input.tokenHash))).toBe(1);
  });

  it('answers a product the catalogue lacks and an account reference of nobody without a statement', async () => {
    const written: PurchaseApplyInput[] = [];
    const jobs: string[] = [];
    const c = core(written, jobs);
    expect(await c.prepare(verified({ productId: 'sub.gone' }), { store: 'play', token: 'tok-core-2', callerId: null, source: 5 })).toEqual({
      status: 'answered',
      applied: { outcome: 'unknown_product', productId: 'sub.gone', basePlanId: 'm1' },
    });
    expect(await c.prepare(verified({ accountRef: 'not-a-billing-ref' }), { store: 'play', token: 'tok-core-3', callerId: null, source: 5 })).toEqual({
      status: 'answered',
      applied: { outcome: 'foreign_account' },
    });
    expect(written).toEqual([]);
    // A reference of no account is refunded and revoked by a job.
    expect(jobs.some((id) => id.startsWith('revoke.play.'))).toBe(true);
  });
});
