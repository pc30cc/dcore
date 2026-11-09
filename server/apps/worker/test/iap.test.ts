import { randomBytes } from 'node:crypto';
import { applyStorePurchase, createPool, instrumentPool, statementCounter, type Pool, type PurchaseApply } from '@app/db';
import { userChannel, type Entitlements } from '@app/shared';
import {
  ACK_DEADLINE_MS,
  FakePushSender,
  FakeRealtimePublisher,
  FakeStoreVerifier,
  IdGenerator,
  StoreError,
  createKeys,
  createPublicIds,
  retryPlan,
  tokenHash,
} from '@app/shared/server';
import { DelayedError, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { billingSettingsOf, iapQueue, loadConfig, type JobContext } from '../src/index.js';
import { FakePhotoModerator } from '../src/photos/moderation.js';
import type { WorkerServices } from '../src/services.js';
import { ensureGroupRoles, hasDatabase, loginRole, migratedDatabase, type TestDatabase } from './db.js';
import { TEST_REDIS_URL, baseEnv, connect, hasRedis } from './support.js';

/**
 * The `iap` queue against a real database and Valkey, with fake stores: the
 * acknowledgement retried on a fake clock until it is done (inside 60 h) or
 * given up at the deadline, a consume the store says was done before, a
 * scheduled re-check that renews or ends a subscription in one transaction,
 * a refund reversed once, a subscription's end, and the Play-only jobs
 * without an integration. Run as the application role (app_rw).
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type FakeJob = Job & { delayedUntil?: number };

function fakeJob(name: string, data: Record<string, unknown>, timestamp = Date.now()): FakeJob {
  const job = {
    name,
    data,
    id: `${name}.test`,
    timestamp,
    attemptsMade: 0,
    async moveToDelayed(at: number) {
      job.delayedUntil = at;
    },
    async updateData(next: Record<string, unknown>) {
      job.data = next;
    },
  } as unknown as FakeJob;
  return job;
}

describe('the retry plan of acknowledgements', () => {
  it('tries often enough, never past the deadline, and gives up at it', () => {
    const start = 0;
    const deadline = start + ACK_DEADLINE_MS;
    let now = start;
    let tries = 0;
    let gaps = 0;
    for (;;) {
      const plan = retryPlan(tries, now, deadline);
      if (plan.action === 'give_up') break;
      expect(plan.atMs).toBeLessThanOrEqual(deadline);
      gaps = Math.max(gaps, plan.atMs - now);
      now = plan.atMs;
      tries += 1;
      if (tries > 10_000) throw new Error('no end');
    }
    expect(tries).toBeGreaterThan(100);
    expect(gaps).toBeLessThanOrEqual(30 * 60_000);
    expect(now).toBe(deadline);
  });
});

describe.skipIf(!hasDatabase || !hasRedis)('the iap queue (PostgreSQL, Valkey)', () => {
  let db: TestDatabase;
  let pg: Pool;
  let redis: Redis;
  let ids: IdGenerator;
  let context: JobContext;
  let role: Awaited<ReturnType<typeof loginRole>>;
  const realtime = new FakeRealtimePublisher();
  const play = new FakeStoreVerifier('play');
  const bazaar = new FakeStoreVerifier('bazaar');
  const prefix = `t${randomBytes(4).toString('hex')}:`;
  const keys = createKeys(prefix);
  const env = baseEnv();
  const publicIds = createPublicIds(env['ID_PUBLIC_KEY']!, env['ID_BILLING_KEY']!);
  const products = new Map<string, number>();

  beforeAll(async () => {
    await ensureGroupRoles();
    role = await loginRole(['app_rw']);
    db = await migratedDatabase();
    pg = instrumentPool(createPool({ connectionString: db.urlFor(role.name, role.password), applicationName: 'iap-test', max: 4 }), statementCounter);
    redis = connect();
    ids = new IdGenerator({ redis, keyPrefix: prefix });
    await ids.start();
    const services: WorkerServices = {
      pg,
      cache: redis,
      ids,
      keys,
      publicIds,
      realtime,
      media: null,
      photoModerator: new FakePhotoModerator({ autoApprove: false }),
      push: new FakePushSender(),
      iap: { verifiers: { play, bazaar } },
    };
    const config = loadConfig({ ...env, DATABASE_URL: db.url, REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix, WORKER_ID: 'iap-test' });
    context = { config, redis, log: pino({ level: 'silent' }), services, token: 'test-token' };
    const { rows } = await db.admin.query<{ id: number; store: number; product_id: string; base_plan_id: string | null }>(`SELECT id, store, product_id, base_plan_id FROM store_products`);
    for (const r of rows) products.set(`${r.store}:${r.product_id}:${r.base_plan_id ?? ''}`, r.id);
  }, 90_000);

  afterAll(async () => {
    await ids?.stop();
    const left = await redis?.keys(`${prefix}*`);
    if (left?.length) await redis.del(...left);
    await redis?.quit();
    await pg?.end();
    await db?.drop();
    await role?.drop();
  });

  async function newUser(): Promise<string> {
    const { rows } = await db.admin.query<{ id: string }>(
      `INSERT INTO users (id, birth_date, status, gender, onboarding_step, country) VALUES (id_next(), '1994-01-01', 3, 2, 30, 'IR') RETURNING id::text`,
    );
    return rows[0]!.id;
  }

  async function stored(over: Partial<PurchaseApply> & Pick<PurchaseApply, 'token' | 'productRef' | 'kind' | 'state' | 'store'>): Promise<string> {
    const out = await applyStorePurchase(pg, {
      id: ids.nextId(),
      eventId: ids.nextId(),
      linkedEventId: ids.nextId(),
      ledgerId: ids.nextId(),
      tokenHash: tokenHash(over.token),
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
      eventMs: Date.now() - 60_000,
      nextCheckAtMs: null,
      source: 1,
      amountMicros: null,
      currency: null,
      ...over,
    });
    if (out.outcome !== 'applied') throw new Error(`not applied: ${out.outcome}`);
    return out.purchaseId;
  }

  const product = (store: number, id: string, base = '') => products.get(`${store}:${id}:${base}`)!;

  it('acknowledges after the store comes back, before 60 hours (fake clock), once', async () => {
    const user = await newUser();
    const token = `ack-${user}`;
    const purchasedAtMs = Date.now() - HOUR;
    const purchaseId = await stored({ token, store: 1, productRef: product(1, 'sub.plus', 'm1'), kind: 1, state: 2, callerId: user, purchasedAtMs });
    play.put(token, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1' });
    let now = purchasedAtMs;
    const queue = iapQueue({ now: () => now });
    const job = fakeJob('ack', { purchaseId, store: 'play', deadlineMs: purchasedAtMs + ACK_DEADLINE_MS });
    // The store is down for the first 59 hours.
    const backAt = purchasedAtMs + 59 * HOUR;
    let runs = 0;
    for (;;) {
      runs += 1;
      if (now < backAt) play.failures.push(new StoreError('unavailable', 'down'));
      try {
        const out = await queue.process(job, context);
        expect(out.outcome).toBe('done');
        break;
      } catch (error) {
        expect(error).toBeInstanceOf(DelayedError);
        expect(job.delayedUntil).toBeGreaterThan(now);
        now = job.delayedUntil!;
        play.failures.length = 0;
      }
      if (runs > 1_000) throw new Error('never acknowledged');
    }
    expect(now).toBeLessThan(purchasedAtMs + ACK_DEADLINE_MS);
    expect(runs).toBeGreaterThan(100);
    const { rows } = await db.admin.query<{ acked: boolean; n: string }>(
      `SELECT p.acknowledged_at IS NOT NULL AS acked, (SELECT count(*) FROM store_events e WHERE e.purchase_id = p.id AND e.event = 12)::text AS n FROM store_purchases p WHERE p.id = $1`,
      [purchaseId],
    );
    expect(rows[0]).toEqual({ acked: true, n: '1' });
    // A second run finds it done and asks the store nothing.
    const calls = play.count('acknowledge');
    expect(await queue.process(fakeJob('ack', { purchaseId, store: 'play', deadlineMs: purchasedAtMs + ACK_DEADLINE_MS }), context)).toMatchObject({ outcome: 'already' });
    expect(play.count('acknowledge')).toBe(calls);
  });

  it('gives up at the deadline when the store never answers', async () => {
    const user = await newUser();
    const token = `ack-never-${user}`;
    const purchasedAtMs = Date.now() - HOUR;
    const purchaseId = await stored({ token, store: 1, productRef: product(1, 'sub.plus', 'm1'), kind: 1, state: 2, callerId: user, purchasedAtMs });
    let now = purchasedAtMs + ACK_DEADLINE_MS - 10 * 60_000;
    const queue = iapQueue({ now: () => now });
    const job = fakeJob('ack', { purchaseId, store: 'play', deadlineMs: purchasedAtMs + ACK_DEADLINE_MS });
    let outcome: string | undefined;
    for (let i = 0; i < 10 && outcome === undefined; i += 1) {
      play.failures.push(new StoreError('unavailable', 'down'));
      try {
        outcome = (await queue.process(job, context)).outcome;
      } catch (error) {
        expect(error).toBeInstanceOf(DelayedError);
        now = job.delayedUntil!;
      }
    }
    play.failures.length = 0;
    expect(outcome).toBe('gave_up');
  });

  it("counts Bazaar's already_consumed as a done consume", async () => {
    const user = await newUser();
    const token = `consume-${user}`;
    const purchaseId = await stored({ token, store: 2, productRef: product(2, 'cons.superlike.5'), kind: 2, state: 12, callerId: user });
    bazaar.put(token, { kind: 'consumable', productId: 'cons.superlike.5' });
    bazaar.consumed.add(token);
    const out = await iapQueue().process(fakeJob('consume', { purchaseId, store: 'bazaar' }), context);
    expect(out.outcome).toBe('already');
    const { rows } = await db.admin.query<{ state: number; consumed: boolean }>(`SELECT state, consumed_at IS NOT NULL AS consumed FROM store_purchases WHERE id = $1`, [purchaseId]);
    expect(rows[0]).toEqual({ state: 10, consumed: true });
  });

  it('a scheduled re-check renews in one transaction, tells the person, then ends the subscription', async () => {
    const user = await newUser();
    const token = `recheck-${user}`;
    const validUntil = Date.now() + 2 * 60_000;
    const purchaseId = await stored({ token, store: 2, productRef: product(2, 'sub.plus.1m'), kind: 1, state: 2, callerId: user, expiresAtMs: validUntil });
    const renewedUntil = validUntil + 30 * DAY;
    bazaar.put(token, { kind: 'subscription', productId: 'sub.plus.1m', expiresAtMs: renewedUntil, nextCheckAtMs: renewedUntil + HOUR, eventMs: Date.now() });
    // The settings are loaded once per process (and again only after a configuration change).
    await billingSettingsOf(context.services, redis, context.log).get();
    const tally = await statementCounter.measure(() => iapQueue().process(fakeJob('recheck', { purchaseId, store: 'bazaar', atMs: validUntil + HOUR }), context));
    expect(tally.result).toMatchObject({ outcome: 'applied', changed: true });
    // The core's one statement, and the purchase read before it.
    expect(tally.tally.statements).toBe(2);
    expect(bazaar.count('recheck')).toBe(1);
    const sub = await db.admin.query<{ ms: string }>(`SELECT (extract(epoch FROM expires_at) * 1000)::bigint::text AS ms FROM subscriptions WHERE user_id = $1 AND store = 2`, [user]);
    expect(Number(sub.rows[0]!.ms)).toBe(renewedUntil);
    const told = realtime.on(userChannel(publicIds.user.encode(user))).filter((e) => e.t === 'entitlement');
    expect((told.at(-1)?.d as Entitlements).plan).toBe('plus');
    // The next re-check: not renewed, so it ends.
    bazaar.put(token, { kind: 'subscription', productId: 'sub.plus.1m', state: 'expired', autoRenew: false, expiresAtMs: Date.now() - 1_000, eventMs: Date.now() + 1 });
    const ended = await iapQueue().process(fakeJob('recheck', { purchaseId, store: 'bazaar', atMs: renewedUntil + HOUR }), context);
    expect(ended).toMatchObject({ outcome: 'applied', changed: true });
    expect((await db.admin.query(`SELECT 1 FROM subscriptions WHERE user_id = $1`, [user])).rowCount).toBe(0);
  });

  it('a refund found by the refund check reverses the credit once', async () => {
    const user = await newUser();
    const token = `refund-${user}`;
    const purchaseId = await stored({ token, store: 2, productRef: product(2, 'cons.boost.5'), kind: 2, state: 12, callerId: user });
    bazaar.put(token, { kind: 'consumable', productId: 'cons.boost.5', state: 'revoked', eventMs: Date.now() });
    const first = await iapQueue().process(fakeJob('refund-check', { purchaseId, store: 'bazaar' }), context);
    expect(first).toMatchObject({ outcome: 'applied', changed: true });
    bazaar.put(token, { kind: 'consumable', productId: 'cons.boost.5', state: 'revoked', eventMs: Date.now() + 1 });
    // A revoked purchase is the server's own end: a second check asks the store nothing.
    const calls = bazaar.count('recheck');
    const second = await iapQueue().process(fakeJob('refund-check', { purchaseId, store: 'bazaar' }), context);
    expect(second).toMatchObject({ outcome: 'final', state: 8 });
    expect(bazaar.count('recheck')).toBe(calls);
    const { rows } = await db.admin.query<{ balance: number; reversals: string }>(
      `SELECT (SELECT balance FROM wallet_balances WHERE user_id = $1 AND item = 2 AND store = 2) AS balance,
              (SELECT count(*) FROM wallet_ledger WHERE ref_id = $2 AND reason = 3)::text AS reversals`,
      [user, purchaseId],
    );
    expect(rows[0]).toEqual({ balance: 0, reversals: '1' });
  });

  it('ends a subscription row at its expiry and tells the person', async () => {
    const user = await newUser();
    const plus = (await db.admin.query<{ id: number }>(`SELECT id FROM plans WHERE key = 'plus'`)).rows[0]!.id;
    await db.admin.query(
      `INSERT INTO entitlement_grants (id, user_id, starts_at, ends_at, plan_id, reason) VALUES (id_next(), $1, now() - interval '2 days', now() - interval '1 second', $2, 'test')`,
      [user, plus],
    );
    await db.admin.query(`INSERT INTO subscriptions (user_id, started_at, expires_at, plan_id, store, status) VALUES ($1, now() - interval '2 days', now() - interval '1 second', $2, 0, 4)`, [user, plus]);
    await redis.set(keys.entitlements(user, 2), '{}');
    const out = await iapQueue().process(fakeJob('sub-end', { userId: user, store: 0, atMs: Date.now() }), context);
    expect(out).toMatchObject({ outcome: 'changed', published: true, store: 'bazaar' });
    expect((await db.admin.query(`SELECT 1 FROM subscriptions WHERE user_id = $1`, [user])).rowCount).toBe(0);
    const told = realtime.on(userChannel(publicIds.user.encode(user))).filter((e) => e.t === 'entitlement');
    expect((told.at(-1)?.d as Entitlements).plan).toBe('free');
    expect(await iapQueue().process(fakeJob('sub-end', { userId: user, store: 0, atMs: Date.now() }), context)).toMatchObject({ outcome: 'unchanged' });
  });

  it('revokes at the store a purchase bound to no account of ours', async () => {
    const token = `revoke-${randomBytes(4).toString('hex')}`;
    play.put(token, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1' });
    const data = { store: 'play', kind: 'subscription', productId: 'sub.plus', token, tokenHash: tokenHash(token) };
    expect(await iapQueue().process(fakeJob('revoke', data), context)).toMatchObject({ outcome: 'done' });
    expect(play.revoked.has(token)).toBe(true);
    expect(await iapQueue().process(fakeJob('revoke', data), context)).toMatchObject({ outcome: 'already' });
  });

  it('waits for an integration that is missing, and leaves the Play-only jobs to Play', async () => {
    const queue = iapQueue();
    const bare: JobContext = { ...context, services: { ...context.services, iap: { verifiers: {} } } };
    const user = await newUser();
    const purchaseId = await stored({ token: `wait-${user}`, store: 1, productRef: product(1, 'sub.plus', 'm1'), kind: 1, state: 2, callerId: user });
    const job = fakeJob('ack', { purchaseId, store: 'play', deadlineMs: Date.now() + ACK_DEADLINE_MS });
    await expect(queue.process(job, bare)).rejects.toBeInstanceOf(DelayedError);
    await expect(queue.process(fakeJob('rtdn', { messageId: '123', data: 'e30=' }), bare)).rejects.toThrow(/no Google Play integration/);
    expect(await queue.process(fakeJob('voided', {}), bare)).toMatchObject({ outcome: 'skipped' });
  });
});
