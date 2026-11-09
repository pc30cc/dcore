import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyStorePurchase,
  createPool,
  deferPurchaseCheck,
  overduePurchaseChecks,
  owedPurchaseActions,
  runMigrations,
  uncheckedExpiredPurchases,
  type Pool,
  type PurchaseApply,
} from '../src/index.js';
import { createTempDatabase, hasDatabase, type TempDatabase } from './support.js';

/**
 * Migration 0022 after review: the person's lock in a bare
 * subscription_recompute(), the server's own end states kept against later
 * reads, the amount of a recovered payment, a revoked consumable reversed
 * once, a pending purchase's completion time, the owner of a replaced token
 * of someone else, a recomputed subscription reported as a write, and the
 * sweep's queries.
 */

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const DAY = 86_400_000;
const HOUR = 3_600_000;

describe.skipIf(!hasDatabase)('store purchases after review (migration 0022)', () => {
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
    pool = createPool({ connectionString: db.url, applicationName: 'db-review-test', max: 4 });
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

  const newUser = () =>
    value<string>(`INSERT INTO users (id, birth_date, status, gender, onboarding_step, country) VALUES (id_next(), '1994-01-01', 3, 2, 30, 'IR') RETURNING id::text`);
  const id = () => value<string>('SELECT id_next()::text');
  const hash = (token: string) => createHash('sha256').update(token).digest('hex');

  function product(store: number, productId: string, basePlan = ''): number {
    const ref = products.get(`${store}:${productId}:${basePlan}`);
    if (ref === undefined) throw new Error(`no product ${store}:${productId}:${basePlan}`);
    return ref;
  }

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
      region: null,
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

  async function apply(over: Partial<PurchaseApply> & Pick<PurchaseApply, 'token' | 'productRef' | 'kind' | 'state'>) {
    return applyStorePurchase(pool, await input(over));
  }

  async function events(purchaseId: string): Promise<{ event: number; state_to: number; amount_micros: string | null; amount_estimated: boolean }[]> {
    const { rows } = await client.query<{ event: number; state_to: number; amount_micros: string | null; amount_estimated: boolean }>(
      `SELECT event, state_to, amount_micros::text, amount_estimated FROM store_events WHERE purchase_id = $1 ORDER BY id`,
      [purchaseId],
    );
    return rows;
  }

  const stateOf = (purchaseId: string) => value<number>(`SELECT state FROM store_purchases WHERE id = $1`, [purchaseId]);

  it('a bare subscription_recompute() waits for a purchase of the same person and never deletes the renewal it wrote', async () => {
    const user = await newUser();
    const token = `race-${user}`;
    const ref = product(1, 'sub.plus', 'm1');
    const first = await apply({ token, productRef: ref, kind: 1, state: 2, callerId: user, eventMs: 1_000 });
    if (first.outcome !== 'applied') throw new Error('not applied');
    // The period just ran out (the sub-end job is due), the row still stands.
    await client.query(`UPDATE store_purchases SET expires_at = now() - interval '1 minute' WHERE id = $1`, [first.purchaseId]);
    await client.query(`UPDATE subscriptions SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND store = 1`, [user]);

    // A renewal holds its transaction open (the person's lock, the subscription row updated) ...
    const renewal = await pool.connect();
    const recompute = await pool.connect();
    try {
      await renewal.query('BEGIN');
      const renewed = await input({ token, productRef: ref, kind: 1, state: 2, callerId: user, eventMs: 2_000, expiresAtMs: Date.now() + 30 * DAY });
      await renewal.query(`SELECT store_purchase_apply($1::jsonb)`, [JSON.stringify(renewed)]);
      // ... while the subscription's end recomputes the row on another connection.
      const pid = (await recompute.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      const ended = recompute.query<{ changed: boolean }>(`SELECT subscription_recompute($1::bigint, 1::smallint) AS changed`, [user]);
      for (let i = 0; i < 100; i += 1) {
        const waiting = await value<boolean>(`SELECT wait_event_type = 'Lock' FROM pg_stat_activity WHERE pid = $1`, [pid]);
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(await value<boolean>(`SELECT wait_event_type = 'Lock' FROM pg_stat_activity WHERE pid = $1`, [pid])).toBe(true);
      await renewal.query('COMMIT');
      expect((await ended).rows[0]!.changed).toBe(false);
    } finally {
      renewal.release();
      recompute.release();
    }
    expect(await value<number>(`SELECT count(*)::int FROM subscriptions WHERE user_id = $1 AND store = 1 AND expires_at > now()`, [user])).toBe(1);
  });

  it('keeps a replaced token replaced unless the store shows it giving access again', async () => {
    const user = await newUser();
    const old = await apply({ token: `t1-${user}`, productRef: product(1, 'sub.plus', 'm1'), kind: 1, state: 2, callerId: user, eventMs: 1_000 });
    if (old.outcome !== 'applied') throw new Error('not applied');
    await apply({ token: `t2-${user}`, productRef: product(1, 'sub.premium', 'm1'), kind: 1, state: 2, callerId: user, linkedTokenHash: hash(`t1-${user}`), eventMs: 2_000 });
    expect(await stateOf(old.purchaseId)).toBe(9);
    // The old token's re-check after its expiry: Google says EXPIRED. Still replaced, no churn event.
    const late = await apply({ token: `t1-${user}`, productRef: product(1, 'sub.plus', 'm1'), kind: 1, state: 7, autoRenew: false, callerId: user, eventMs: 3_000, expiresAtMs: Date.now() - 1_000 });
    expect(late).toMatchObject({ outcome: 'unchanged', state: 9, event: null });
    expect(await stateOf(old.purchaseId)).toBe(9);
    expect((await events(old.purchaseId)).map((e) => e.event)).toEqual([1, 11]);
    // Shown active again (a deferred replacement still running): it counts again.
    const back = await apply({ token: `t1-${user}`, productRef: product(1, 'sub.plus', 'm1'), kind: 1, state: 2, callerId: user, eventMs: 4_000 });
    expect(back).toMatchObject({ outcome: 'applied', state: 2 });
  });

  it('keeps a revoked subscription revoked against a later expiry, and lets a later paid period through', async () => {
    const user = await newUser();
    const token = `rv-${user}`;
    const ref = product(1, 'sub.plus', 'm1');
    const expires = Date.now() + 10 * DAY;
    const bought = await apply({ token, productRef: ref, kind: 1, state: 2, callerId: user, eventMs: 1_000, expiresAtMs: expires, orderId: 'GPA.1' });
    if (bought.outcome !== 'applied') throw new Error('not applied');
    expect(await apply({ token, productRef: ref, kind: 1, state: 8, callerId: user, eventMs: 2_000, expiresAtMs: expires, orderId: 'GPA.1' })).toMatchObject({ state: 8, event: 10 });
    // A re-check that was queued before the refund reads EXPIRED: still revoked, no second refund, no `expired` event.
    const late = await apply({ token, productRef: ref, kind: 1, state: 7, autoRenew: false, callerId: user, eventMs: 3_000, expiresAtMs: Date.now() - 1_000 });
    expect(late).toMatchObject({ outcome: 'unchanged', state: 8, event: null });
    // The same period shown canceled: no access again for a refunded period.
    expect(await apply({ token, productRef: ref, kind: 1, state: 3, autoRenew: false, callerId: user, eventMs: 4_000, expiresAtMs: expires, orderId: 'GPA.1' })).toMatchObject({ state: 8 });
    expect((await events(bought.purchaseId)).map((e) => e.event)).toEqual([1, 10]);
    expect(await value<number>(`SELECT count(*)::int FROM subscriptions WHERE user_id = $1`, [user])).toBe(0);
    // A later period was paid (a renewal after a refund without revocation): it counts.
    const renewed = await apply({ token, productRef: ref, kind: 1, state: 2, callerId: user, eventMs: 5_000, expiresAtMs: expires + 30 * DAY, orderId: 'GPA.1..0' });
    expect(renewed).toMatchObject({ outcome: 'applied', state: 2, event: 2 });
  });

  it('a revoked consumable stays revoked: a later read never moves it back, and the credit is reversed once', async () => {
    const user = await newUser();
    const token = `cons-${user}`;
    const ref = product(1, 'cons.superlike.5');
    const bought = await apply({ token, productRef: ref, kind: 2, state: 12, callerId: user, eventMs: 1_000 });
    if (bought.outcome !== 'applied') throw new Error('not applied');
    expect(await apply({ token, productRef: ref, kind: 2, state: 8, callerId: user, eventMs: 2_000 })).toMatchObject({ state: 8, debited: 5 });
    // A one-time notification read later without the refund showing: still revoked.
    expect(await apply({ token, productRef: ref, kind: 2, state: 10, consumed: true, callerId: user, eventMs: 3_000 })).toMatchObject({ outcome: 'unchanged', state: 8 });
    expect(await stateOf(bought.purchaseId)).toBe(8);
    // The daily voided list sees it again: nothing, and no unique violation.
    expect(await apply({ token, productRef: ref, kind: 2, state: 8, callerId: user, eventMs: 4_000 })).toMatchObject({ outcome: 'unchanged', debited: 0 });
    // Even a row moved back by hand is reversed only once (the ledger is the guard).
    await client.query(`UPDATE store_purchases SET state = 10 WHERE id = $1`, [bought.purchaseId]);
    await client.query(`UPDATE wallet_balances SET balance = 5 WHERE user_id = $1 AND item = 1 AND store = 1`, [user]);
    expect(await apply({ token, productRef: ref, kind: 2, state: 8, callerId: user, eventMs: 5_000 })).toMatchObject({ state: 8, debited: 0 });
    expect(await value<number>(`SELECT count(*)::int FROM wallet_ledger WHERE ref_id = $1 AND reason = 3`, [bought.purchaseId])).toBe(1);
    expect(await value<number>(`SELECT balance FROM wallet_balances WHERE user_id = $1 AND item = 1 AND store = 1`, [user])).toBe(5);
  });

  it('a payment recovered after grace or account hold carries the amount', async () => {
    const user = await newUser();
    const token = `grace-${user}`;
    const ref = product(1, 'sub.plus', 'm1');
    await client.query(`UPDATE store_products SET list_price_minor = 499, list_currency = 'EUR' WHERE id = $1`, [ref]);
    const expires = Date.now() + 2 * DAY;
    const bought = await apply({ token, productRef: ref, kind: 1, state: 2, callerId: user, eventMs: 1_000, expiresAtMs: expires });
    if (bought.outcome !== 'applied') throw new Error('not applied');
    // The card fails: grace, then hold (no money).
    await apply({ token, productRef: ref, kind: 1, state: 4, callerId: user, eventMs: 2_000, expiresAtMs: expires + DAY });
    await apply({ token, productRef: ref, kind: 1, state: 5, callerId: user, eventMs: 3_000, expiresAtMs: expires - 3 * DAY });
    // Recovered: one more period paid.
    const recovered = await apply({ token, productRef: ref, kind: 1, state: 2, callerId: user, eventMs: 4_000, expiresAtMs: expires + 30 * DAY });
    expect(recovered).toMatchObject({ event: 7 });
    const all = await events(bought.purchaseId);
    expect(all.map((e) => [e.event, e.amount_micros])).toEqual([
      [1, '4990000'],
      [5, null],
      [6, null],
      [7, '4990000'],
    ]);
    expect(all.at(-1)?.amount_estimated).toBe(true);
    // A move back to active inside the same period (nothing paid) carries none.
    const token2 = `grace2-${user}`;
    const second = await apply({ token: token2, productRef: ref, kind: 1, state: 2, callerId: user, eventMs: 1_000, expiresAtMs: expires });
    if (second.outcome !== 'applied') throw new Error('not applied');
    await apply({ token: token2, productRef: ref, kind: 1, state: 6, callerId: user, eventMs: 2_000, expiresAtMs: expires });
    await apply({ token: token2, productRef: ref, kind: 1, state: 2, callerId: user, eventMs: 3_000, expiresAtMs: expires });
    expect((await events(second.purchaseId)).map((e) => [e.event, e.amount_micros])).toEqual([
      [1, '4990000'],
      [8, null],
      [7, null],
    ]);
  });

  it('a pending purchase that completes takes the completion time as its purchase time', async () => {
    const user = await newUser();
    const token = `pending-${user}`;
    const ref = product(1, 'cons.superlike.5');
    const seenAt = Date.now() - 70 * HOUR;
    const pending = await apply({ token, productRef: ref, kind: 2, state: 1, callerId: user, eventMs: 1_000, purchasedAtMs: seenAt });
    if (pending.outcome !== 'applied') throw new Error('not applied');
    const completedAt = Date.now() - 60_000;
    await apply({ token, productRef: ref, kind: 2, state: 12, callerId: user, eventMs: 2_000, purchasedAtMs: completedAt });
    expect(Number(await value<string>(`SELECT (extract(epoch FROM purchased_at) * 1000)::bigint::text FROM store_purchases WHERE id = $1`, [pending.purchaseId]))).toBe(completedAt);
    // Later reads never move it again.
    await apply({ token, productRef: ref, kind: 2, state: 10, consumed: true, callerId: user, eventMs: 3_000, purchasedAtMs: Date.now() });
    expect(Number(await value<string>(`SELECT (extract(epoch FROM purchased_at) * 1000)::bigint::text FROM store_purchases WHERE id = $1`, [pending.purchaseId]))).toBe(completedAt);
  });

  it('names the owner of a replaced token of someone else, with their rows after the change', async () => {
    const a = await newUser();
    const b = await newUser();
    const old = await apply({ token: `a-${a}`, productRef: product(1, 'sub.plus', 'm1'), kind: 1, state: 2, callerId: a });
    if (old.outcome !== 'applied') throw new Error('not applied');
    const upgrade = await apply({
      token: `b-${b}`,
      productRef: product(1, 'sub.premium', 'm1'),
      kind: 1,
      state: 2,
      accountUserId: b,
      linkedTokenHash: hash(`a-${a}`),
    });
    expect(upgrade).toMatchObject({ outcome: 'applied', userId: b, replaced: old.purchaseId, replacedUserId: a, replacedRows: { subs: [] } });
    // The same person's own replacement names nobody else.
    const own = await apply({ token: `b2-${b}`, productRef: product(1, 'sub.plus', 'm1'), kind: 1, state: 2, accountUserId: b, linkedTokenHash: hash(`b-${b}`) });
    expect(own).toMatchObject({ replacedUserId: null, replacedRows: null });
  });

  it('reports a write when only the subscription row or a linked token changed', async () => {
    const user = await newUser();
    const token = `sub-only-${user}`;
    const input1 = await input({ token, productRef: product(2, 'sub.plus.1m'), store: 2, kind: 1, state: 2, callerId: user, eventMs: 1_000 });
    expect(await applyStorePurchase(pool, input1)).toMatchObject({ outcome: 'applied' });
    // The subscription row went (a race of the subscription's end): the same state again puts it back.
    await client.query(`DELETE FROM subscriptions WHERE user_id = $1`, [user]);
    const again = await applyStorePurchase(pool, { ...input1, id: await id(), eventId: await id(), eventMs: 2_000 });
    expect(again).toMatchObject({ outcome: 'applied', subscriptionChanged: true, event: null });
    expect(await value<number>(`SELECT count(*)::int FROM subscriptions WHERE user_id = $1`, [user])).toBe(1);
  });

  it('finds overdue re-checks, live rows without one, and owed actions; defers a refused check', async () => {
    const user = await newUser();
    const now = Date.now();
    const due = await apply({ token: `due-${user}`, productRef: product(2, 'sub.plus.1m'), store: 2, kind: 1, state: 2, callerId: user, nextCheckAtMs: now - HOUR });
    const later = await apply({ token: `later-${user}`, productRef: product(2, 'sub.plus.3m'), store: 2, kind: 1, state: 2, callerId: user, nextCheckAtMs: now + HOUR });
    const bare = await apply({ token: `bare-${user}`, productRef: product(2, 'sub.premium.1m'), store: 2, kind: 1, state: 2, callerId: user, expiresAtMs: now - HOUR });
    const unacked = await apply({ token: `owed-${user}`, productRef: product(1, 'sub.plus', 'm1'), kind: 1, state: 2, callerId: user, purchasedAtMs: now - 2 * HOUR });
    const acked = await apply({ token: `acked-${user}`, productRef: product(1, 'sub.plus', 'm3'), kind: 1, state: 2, callerId: user, purchasedAtMs: now - 2 * HOUR, acknowledged: true });
    const credited = await apply({ token: `credited-${user}`, productRef: product(2, 'cons.boost.1'), store: 2, kind: 2, state: 12, callerId: user, purchasedAtMs: now - 2 * HOUR });
    const old = await apply({ token: `old-${user}`, productRef: product(1, 'sub.plus', 'm6'), kind: 1, state: 2, callerId: user, purchasedAtMs: now - 70 * HOUR });
    for (const o of [due, later, bare, unacked, acked, credited, old]) if (o.outcome !== 'applied') throw new Error('not applied');
    const idOf = (o: typeof due) => (o.outcome === 'applied' ? o.purchaseId : '');

    const overdue = (await overduePurchaseChecks(pool, { beforeMs: now - 15 * 60_000, after: null, limit: 500 })).map((r) => r.id);
    expect(overdue).toContain(idOf(due));
    expect(overdue).not.toContain(idOf(later));
    const unchecked = (await uncheckedExpiredPurchases(pool, now - 15 * 60_000, 500)).map((r) => r.id);
    expect(unchecked).toContain(idOf(bare));
    expect(unchecked).not.toContain(idOf(due));
    const owed = await owedPurchaseActions(pool, { fromMs: now - 60 * HOUR, beforeMs: now - 10 * 60_000, after: null, limit: 500 });
    expect(owed.filter((r) => [idOf(unacked), idOf(credited)].includes(r.id)).map((r) => r.kind).sort()).toEqual([1, 2]);
    expect(owed.map((r) => r.id)).not.toContain(idOf(acked));
    expect(owed.map((r) => r.id)).not.toContain(idOf(old));
    // Keyset: the page after the first row starts after it.
    const first = (await overduePurchaseChecks(pool, { beforeMs: now, after: null, limit: 1 }))[0]!;
    const rest = await overduePurchaseChecks(pool, { beforeMs: now, after: { atMs: first.atMs, id: first.id }, limit: 500 });
    expect(rest.map((r) => r.id)).not.toContain(first.id);

    // A refused check moves a day on (a live row without one gets one); a future check is left alone.
    expect(await deferPurchaseCheck(pool, idOf(due), now + DAY)).toBe(true);
    expect(await deferPurchaseCheck(pool, idOf(bare), now + DAY)).toBe(true);
    expect(await deferPurchaseCheck(pool, idOf(later), now + DAY)).toBe(false);
    expect((await overduePurchaseChecks(pool, { beforeMs: now, after: null, limit: 500 })).map((r) => r.id)).not.toContain(idOf(due));
    expect((await uncheckedExpiredPurchases(pool, now, 500)).map((r) => r.id)).not.toContain(idOf(bare));
  });
});
