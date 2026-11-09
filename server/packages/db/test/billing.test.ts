import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyStorePurchase,
  creditWallet,
  createPool,
  entitlementRows,
  grantPlan,
  instrumentPool,
  purchaseById,
  purchaseByToken,
  recomputeSubscription,
  recordStoreAction,
  revokePlanGrant,
  runMigrations,
  statementCounter,
  useWalletItem,
  withTransaction,
  type Pool,
  type PurchaseApply,
} from '../src/index.js';
import { createTempDatabase, hasDatabase, type TempDatabase } from './support.js';

/**
 * Migration 0022 on the real migrations: the catalogue in each store's
 * shape, and the purchase core's one statement (`store_purchase_apply()`):
 * idempotent upserts, older events ignored, linked tokens replaced, the
 * subscription recomputed only when it changes, consumables credited once
 * and reversed once (never below zero), attribution, grants and the wallet.
 */

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const DAY = 86_400_000;

describe.skipIf(!hasDatabase)('store purchases (migration 0022)', () => {
  let db: TempDatabase;
  let client: pg.Client;
  let pool: Pool;
  const products = new Map<string, number>();

  beforeAll(async () => {
    db = await createTempDatabase();
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await runMigrations({ connectionString: db.url, directory: MIGRATIONS, log: { info: () => undefined, warn: () => undefined } });
    pool = instrumentPool(createPool({ connectionString: db.url, applicationName: 'db-test', max: 4 }));
    const { rows } = await client.query<{ id: number; store: number; product_id: string; base_plan_id: string | null }>(
      `SELECT id, store, product_id, base_plan_id FROM store_products`,
    );
    for (const r of rows) products.set(`${r.store}:${r.product_id}:${r.base_plan_id ?? ''}`, r.id);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await client?.end();
    await db?.drop();
  });

  async function value<T>(text: string, values: unknown[] = []): Promise<T> {
    const { rows } = await client.query(text, values);
    if (rows[0] === undefined) throw new Error(`no row: ${text}`);
    return Object.values(rows[0] as Record<string, T>)[0] as T;
  }

  async function newUser(): Promise<string> {
    return value<string>(`INSERT INTO users (id, birth_date, status, gender, onboarding_step, country) VALUES (id_next(), '1994-01-01', 3, 2, 30, 'IR') RETURNING id::text`);
  }

  async function id(): Promise<string> {
    return value<string>('SELECT id_next()::text');
  }

  function product(store: number, productId: string, basePlan = ''): number {
    const ref = products.get(`${store}:${productId}:${basePlan}`);
    if (ref === undefined) throw new Error(`no product ${store}:${productId}:${basePlan}`);
    return ref;
  }

  const hash = (token: string) => createHash('sha256').update(token).digest('hex');

  async function input(over: Partial<PurchaseApply> & Pick<PurchaseApply, 'token' | 'productRef' | 'kind' | 'state'>): Promise<PurchaseApply> {
    return {
      id: await id(),
      eventId: await id(),
      linkedEventId: await id(),
      ledgerId: await id(),
      store: 1,
      tokenHash: hash(over.token),
      linkedTokenHash: null,
      callerId: null,
      accountUserId: null,
      purchasedAtMs: Date.now() - 60_000,
      expiresAtMs: over.kind === 1 ? Date.now() + 30 * DAY : null,
      autoRenew: over.kind === 1 ? true : null,
      quantity: 1,
      isTest: true,
      region: 'TR',
      orderId: null,
      acknowledged: false,
      consumed: false,
      eventMs: Date.now(),
      nextCheckAtMs: null,
      source: 1,
      amountMicros: null,
      currency: null,
      ...over,
    };
  }

  async function events(purchaseId: string): Promise<{ event: number; state_from: number | null; state_to: number; amount_estimated: boolean }[]> {
    const { rows } = await client.query<{ event: number; state_from: number | null; state_to: number; amount_estimated: boolean }>(
      `SELECT event, state_from, state_to, amount_estimated FROM store_events WHERE purchase_id = $1 ORDER BY id`,
      [purchaseId],
    );
    return rows;
  }

  it('reshapes the catalogue: Play base plans, no weekly Bazaar plan, a year added, everything inactive', async () => {
    const rows = (await client.query<{ store: number; product_id: string; base_plan_id: string | null; period: string | null; is_active: boolean }>(
      `SELECT store, product_id, base_plan_id, period, is_active FROM store_products WHERE kind = 1 ORDER BY store, sort`,
    )).rows;
    expect(rows.filter((r) => r.store === 1).map((r) => `${r.product_id}/${r.base_plan_id}/${r.period}`)).toEqual([
      'sub.plus/w1/P1W', 'sub.plus/m1/P1M', 'sub.plus/m3/P3M', 'sub.plus/m6/P6M',
      'sub.premium/w1/P1W', 'sub.premium/m1/P1M', 'sub.premium/m3/P3M', 'sub.premium/m6/P6M',
    ]);
    expect(rows.filter((r) => r.store === 2).map((r) => `${r.product_id}/${r.period}`)).toEqual([
      'sub.plus.1m/P1M', 'sub.plus.3m/P3M', 'sub.plus.6m/P6M', 'sub.plus.12m/P12M',
      'sub.premium.1m/P1M', 'sub.premium.3m/P3M', 'sub.premium.6m/P6M', 'sub.premium.12m/P12M',
    ]);
    expect(await value<number>(`SELECT count(*)::int FROM store_products WHERE is_active`)).toBe(0);
    expect(await value<number>(`SELECT count(*)::int FROM store_products WHERE product_id LIKE '%.1w'`)).toBe(0);
  });

  it('applies a subscription in one statement, idempotently, and ignores an older event', async () => {
    const user = await newUser();
    const token = `play-sub-${user}`;
    const first = await input({ token, productRef: product(1, 'sub.plus', 'm1'), kind: 1, state: 2, callerId: user, eventMs: 1_000_000 });
    const tally = await statementCounter.measure(() => applyStorePurchase(pool, first));
    expect(tally.result.outcome).toBe('applied');
    expect(tally.tally.statements).toBe(1);
    if (tally.result.outcome !== 'applied') throw new Error('not applied');
    expect(tally.result).toMatchObject({ userId: user, state: 2, created: true, event: 1, subscriptionChanged: true });
    expect(tally.result.rows?.subs).toEqual([expect.objectContaining({ store: 1, status: 1, autoRenew: true, productId: 'sub.plus', basePlanId: 'm1' })]);
    const purchaseId = tally.result.purchaseId;

    // The same state again: nothing written, no event.
    const again = await applyStorePurchase(pool, { ...(await input({ token, productRef: first.productRef, kind: 1, state: 2, callerId: user, eventMs: 1_000_500 })), expiresAtMs: first.expiresAtMs });
    expect(again).toMatchObject({ outcome: 'unchanged', purchaseId });
    expect(await events(purchaseId)).toHaveLength(1);

    // An older event (a notification delivered late) changes nothing.
    const stale = await applyStorePurchase(pool, await input({ token, productRef: first.productRef, kind: 1, state: 7, callerId: user, eventMs: 999_000 }));
    expect(stale).toMatchObject({ outcome: 'stale', state: 2 });
    expect(await value<number>(`SELECT state FROM store_purchases WHERE id = $1`, [purchaseId])).toBe(2);

    // A renewal: the expiry moves, one event, the subscription follows.
    const renewed = await applyStorePurchase(pool, await input({ token, productRef: first.productRef, kind: 1, state: 2, callerId: user, eventMs: 2_000_000, expiresAtMs: first.expiresAtMs! + 30 * DAY }));
    expect(renewed).toMatchObject({ outcome: 'applied', event: 2, subscriptionChanged: true });
    expect((await events(purchaseId)).map((e) => e.event)).toEqual([1, 2]);
    expect(Number(await value<string>(`SELECT (extract(epoch FROM expires_at) * 1000)::bigint::text FROM subscriptions WHERE user_id = $1 AND store = 1`, [user]))).toBe(first.expiresAtMs! + 30 * DAY);

    // Canceled: access until the expiry, status 2; then expired: the row goes.
    const canceled = await applyStorePurchase(pool, await input({ token, productRef: first.productRef, kind: 1, state: 3, autoRenew: false, callerId: user, eventMs: 3_000_000, expiresAtMs: first.expiresAtMs! + 30 * DAY }));
    expect(canceled).toMatchObject({ outcome: 'applied', event: 3, subscriptionChanged: true });
    expect(await value<number>(`SELECT status FROM subscriptions WHERE user_id = $1 AND store = 1`, [user])).toBe(2);
    const expired = await applyStorePurchase(pool, await input({ token, productRef: first.productRef, kind: 1, state: 7, autoRenew: false, callerId: user, eventMs: 4_000_000, expiresAtMs: Date.now() - 1_000 }));
    expect(expired).toMatchObject({ outcome: 'applied', event: 9, subscriptionChanged: true });
    expect(await value<number>(`SELECT count(*)::int FROM subscriptions WHERE user_id = $1`, [user])).toBe(0);
  });

  it('replaces a linked token for the same person and keeps one subscription row per store', async () => {
    const user = await newUser();
    const old = await applyStorePurchase(pool, await input({ token: `old-${user}`, productRef: product(1, 'sub.plus', 'm1'), kind: 1, state: 2, callerId: user }));
    if (old.outcome !== 'applied') throw new Error('not applied');
    // The upgrade comes from a notification: no caller, no account reference; the linked token names the person.
    const upgrade = await applyStorePurchase(
      pool,
      await input({ token: `new-${user}`, productRef: product(1, 'sub.premium', 'm1'), kind: 1, state: 2, linkedTokenHash: hash(`old-${user}`), source: 2 }),
    );
    expect(upgrade).toMatchObject({ outcome: 'applied', userId: user, replaced: old.purchaseId, subscriptionChanged: true });
    expect(await value<number>(`SELECT state FROM store_purchases WHERE id = $1`, [old.purchaseId])).toBe(9);
    expect((await events(old.purchaseId)).map((e) => e.event)).toEqual([1, 11]);
    const rows = await entitlementRows(pool, user);
    expect(rows.subs).toHaveLength(1);
    expect(rows.subs[0]).toMatchObject({ store: 1, productId: 'sub.premium' });
  });

  it('attributes a token to the account its reference names, and refuses a reference that names no account', async () => {
    const caller = await newUser();
    const owner = await newUser();
    const theirs = await applyStorePurchase(pool, await input({ token: `ref-${owner}`, productRef: product(2, 'sub.plus.1m'), store: 2, kind: 1, state: 2, callerId: caller, accountUserId: owner }));
    expect(theirs).toMatchObject({ outcome: 'applied', userId: owner });
    const before = await value<number>('SELECT count(*)::int FROM store_purchases');
    const foreign = await applyStorePurchase(pool, await input({ token: `foreign-${caller}`, productRef: product(2, 'sub.plus.1m'), store: 2, kind: 1, state: 2, callerId: caller, accountUserId: '4611686018427387000' }));
    expect(foreign).toEqual({ outcome: 'foreign_account' });
    expect(await value<number>('SELECT count(*)::int FROM store_purchases')).toBe(before);
    // Without a caller or any reference the row is unclaimed and grants nothing; a later post claims it.
    const unclaimed = await applyStorePurchase(pool, await input({ token: `nobody-${caller}`, productRef: product(1, 'sub.plus', 'm3'), kind: 1, state: 2 }));
    expect(unclaimed).toMatchObject({ outcome: 'applied', userId: null, state: 11, rows: null });
    const claimed = await applyStorePurchase(pool, await input({ token: `nobody-${caller}`, productRef: product(1, 'sub.plus', 'm3'), kind: 1, state: 2, callerId: caller }));
    expect(claimed).toMatchObject({ outcome: 'applied', userId: caller, state: 2, stateFrom: 11, event: 1, subscriptionChanged: true });
  });

  it('credits a consumable once and reverses it once, never below zero', async () => {
    const user = await newUser();
    const token = `cons-${user}`;
    const ref = product(1, 'cons.superlike.5');
    const bought = await applyStorePurchase(pool, await input({ token, productRef: ref, kind: 2, state: 12, callerId: user }));
    expect(bought).toMatchObject({ outcome: 'applied', credited: 5, state: 12 });
    if (bought.outcome !== 'applied') throw new Error('not applied');
    // A retry of the same verified purchase credits nothing more.
    const retried = await applyStorePurchase(pool, await input({ token, productRef: ref, kind: 2, state: 12, callerId: user }));
    expect(retried).toMatchObject({ credited: 0 });
    expect(await value<number>(`SELECT balance FROM wallet_balances WHERE user_id = $1 AND item = 1 AND store = 1`, [user])).toBe(5);

    // Consumed at the store: state 10, once.
    expect(await recordStoreAction(pool, { purchaseId: bought.purchaseId, action: 'consumed', eventId: await id(), source: 3 })).toBe(true);
    expect(await recordStoreAction(pool, { purchaseId: bought.purchaseId, action: 'consumed', eventId: await id(), source: 3 })).toBe(false);
    expect((await purchaseById(pool, bought.purchaseId))?.state).toBe(10);

    // Three are spent, then a refund: two left are taken back, three are a shortfall.
    for (let i = 0; i < 3; i += 1) {
      expect(await useWalletItem(pool, { userId: user, item: 1, store: 1, crossStore: false, ledgerId: await id(), refId: await id() })).not.toBeNull();
    }
    const refunded = await applyStorePurchase(pool, await input({ token, productRef: ref, kind: 2, state: 8, callerId: user, source: 4, eventMs: Date.now() + 1_000 }));
    expect(refunded).toMatchObject({ outcome: 'applied', debited: 2, shortfall: 3, event: 10 });
    expect(await value<number>(`SELECT balance FROM wallet_balances WHERE user_id = $1 AND item = 1 AND store = 1`, [user])).toBe(0);
    const twice = await applyStorePurchase(pool, await input({ token, productRef: ref, kind: 2, state: 8, callerId: user, source: 4, eventMs: Date.now() + 2_000 }));
    expect(twice).toMatchObject({ outcome: 'unchanged', debited: 0 });
    expect(await value<number>(`SELECT count(*)::int FROM wallet_ledger WHERE ref_id = $1 AND reason = 3`, [bought.purchaseId])).toBe(1);
    expect(await value<number>(`SELECT min(balance_after)::int FROM wallet_ledger WHERE user_id = $1`, [user])).toBeGreaterThanOrEqual(0);
  });

  it('a pending purchase grants nothing until it completes', async () => {
    const user = await newUser();
    const token = `pending-${user}`;
    const pending = await applyStorePurchase(pool, await input({ token, productRef: product(1, 'cons.boost.5'), kind: 2, state: 1, callerId: user }));
    expect(pending).toMatchObject({ outcome: 'applied', state: 1, credited: 0 });
    expect(await value<number>(`SELECT count(*)::int FROM wallet_balances WHERE user_id = $1`, [user])).toBe(0);
    const done = await applyStorePurchase(pool, await input({ token, productRef: product(1, 'cons.boost.5'), kind: 2, state: 12, callerId: user, eventMs: Date.now() + 1_000 }));
    expect(done).toMatchObject({ outcome: 'applied', state: 12, stateFrom: 1, event: 1, credited: 5 });
  });

  it('estimates Bazaar revenue from the list price of the moment', async () => {
    const user = await newUser();
    const ref = product(2, 'sub.premium.3m');
    await client.query(`UPDATE store_products SET list_price_minor = 2500000, list_currency = 'IRR' WHERE id = $1`, [ref]);
    const out = await applyStorePurchase(pool, await input({ token: `bz-${user}`, productRef: ref, store: 2, kind: 1, state: 2, callerId: user, source: 7 }));
    if (out.outcome !== 'applied') throw new Error('not applied');
    const event = (await client.query<{ amount_micros: string; currency: string; amount_estimated: boolean }>(
      `SELECT amount_micros::text, currency, amount_estimated FROM store_events WHERE purchase_id = $1`,
      [out.purchaseId],
    )).rows[0]!;
    expect(event).toEqual({ amount_micros: String(2_500_000n * 10_000n), currency: 'IRR', amount_estimated: true });
    // A later price edit does not rewrite it.
    await client.query(`UPDATE store_products SET list_price_minor = 9900000 WHERE id = $1`, [ref]);
    expect(await value<string>(`SELECT amount_micros::text FROM store_events WHERE purchase_id = $1`, [out.purchaseId])).toBe(String(2_500_000n * 10_000n));
  });

  it('keeps one row per store, so a person subscribed in both stores is premium in both', async () => {
    const user = await newUser();
    await applyStorePurchase(pool, await input({ token: `both-play-${user}`, productRef: product(1, 'sub.premium', 'm1'), kind: 1, state: 2, callerId: user }));
    await applyStorePurchase(pool, await input({ token: `both-bz-${user}`, productRef: product(2, 'sub.premium.1m'), store: 2, kind: 1, state: 2, callerId: user }));
    const rows = await entitlementRows(pool, user);
    expect(rows.subs.map((s) => s.store).sort()).toEqual([1, 2]);
    expect(await purchaseByToken(pool, 2, hash(`both-bz-${user}`))).toMatchObject({ userId: user, productId: 'sub.premium.1m', store: 2 });
  });

  it('grants plan days on store 0 and takes them back', async () => {
    const user = await newUser();
    const plus = await value<number>(`SELECT id FROM plans WHERE key = 'plus'`);
    const grantId = await id();
    const changed = await withTransaction(pool, (tx) =>
      grantPlan(tx, { id: grantId, userId: user, planId: plus, startsAtMs: Date.now() - 1_000, endsAtMs: Date.now() + 7 * DAY, reason: 'support', adminId: null }),
    );
    expect(changed).toBe(true);
    expect((await entitlementRows(pool, user)).subs).toEqual([expect.objectContaining({ store: 0, status: 4, productId: null })]);
    expect(await recomputeSubscription(pool, user, 0)).toBe(false);
    const revoked = await withTransaction(pool, (tx) => revokePlanGrant(tx, grantId));
    expect(revoked).toEqual({ userId: user, changed: true });
    expect((await entitlementRows(pool, user)).subs).toEqual([]);
  });

  it('spends the session store first, then gifts, every store with cross-store; never below zero', async () => {
    const user = await newUser();
    await creditWallet(pool, { userId: user, item: 2, store: 0, quantity: 1, reason: 4, ledgerId: await id(), refId: null, adminId: null });
    await applyStorePurchase(pool, await input({ token: `boosts-${user}`, productRef: product(2, 'cons.boost.1'), store: 2, kind: 2, state: 12, callerId: user }));
    const use = async (store: number, crossStore = false) => useWalletItem(pool, { userId: user, item: 2, store, crossStore, ledgerId: await id(), refId: await id() });
    // A Play session cannot spend the Bazaar balance with cross-store off: the gift goes first.
    expect(await use(1)).toEqual({ store: 0, balance: 0 });
    expect(await use(1)).toBeNull();
    expect(await use(1, true)).toEqual({ store: 2, balance: 0 });
    expect(await use(2)).toBeNull();
    expect(await value<number>(`SELECT count(*)::int FROM wallet_balances WHERE user_id = $1 AND balance < 0`, [user])).toBe(0);
  });

  it('names its statements: every query is one statement', async () => {
    const user = await newUser();
    const runs: (() => Promise<unknown>)[] = [
      () => entitlementRows(pool, user),
      () => recomputeSubscription(pool, user, 1),
      () => purchaseByToken(pool, 1, hash('none')),
    ];
    for (const run of runs) {
      expect((await statementCounter.measure(run)).tally.statements).toBe(1);
    }
  });
});
