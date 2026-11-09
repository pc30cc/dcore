import { randomBytes } from 'node:crypto';
import { createPool, instrumentPool, statementCounter, type Pool } from '@app/db';
import {
  ACK_DEADLINE_MS,
  FakeGooglePlay,
  FakePushSender,
  FakeRealtimePublisher,
  IdGenerator,
  PlayStoreVerifier,
  createKeys,
  createPublicIds,
  tokenHash,
} from '@app/shared/server';
import { DelayedError, Queue, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PlayJobs } from '../src/iap/play.js';
import { closeSocialQueues } from '../src/social/jobs.js';
import { billingSettingsOf, iapQueue, loadConfig, type JobContext } from '../src/index.js';
import { FakePhotoModerator } from '../src/photos/moderation.js';
import type { WorkerServices } from '../src/services.js';
import { ensureGroupRoles, hasDatabase, loginRole, migratedDatabase, type TestDatabase } from './db.js';
import { TEST_REDIS_URL, baseEnv, connect, hasRedis } from './support.js';

/**
 * Google Play's jobs in the worker against PostgreSQL, Valkey and a local
 * fake of Google, through the real Play integration: notifications (RTDN)
 * read the purchase and write one statement only when it changed, an older
 * read never overwrites a newer one, a linked token replaces the old row
 * and keeps the person, REVOKED and ON_HOLD take access away, a voided
 * consumable is reversed once and never below zero, the daily voided sweep,
 * the acknowledgement retried on a fake clock until Google answers (before
 * 60 h) or given up at the deadline, consume, and revoke with a refund.
 * Run as the application role (app_rw).
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PACKAGE = 'com.example.app';

type FakeJob = Job & { delayedUntil?: number };

function fakeJob(name: string, data: Record<string, unknown>): FakeJob {
  const job = {
    name,
    data,
    id: `${name}.test`,
    timestamp: Date.now(),
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

describe.skipIf(!hasDatabase || !hasRedis)('Google Play jobs (PostgreSQL, Valkey, fake Google)', () => {
  let db: TestDatabase;
  let pg: Pool;
  let redis: Redis;
  let ids: IdGenerator;
  let context: JobContext;
  let role: Awaited<ReturnType<typeof loginRole>>;
  let play: PlayJobs;
  let queue: Queue;
  const google = new FakeGooglePlay({ packageName: PACKAGE });
  const realtime = new FakeRealtimePublisher();
  const prefix = `t${randomBytes(4).toString('hex')}:`;
  const keys = createKeys(prefix);
  const env = baseEnv();
  const publicIds = createPublicIds(env['ID_PUBLIC_KEY']!, env['ID_BILLING_KEY']!);
  let messages = 0;

  beforeAll(async () => {
    await google.start();
    await ensureGroupRoles();
    role = await loginRole(['app_rw']);
    db = await migratedDatabase();
    pg = instrumentPool(createPool({ connectionString: db.urlFor(role.name, role.password), applicationName: 'iap-play-test', max: 4 }), statementCounter);
    redis = connect();
    ids = new IdGenerator({ redis, keyPrefix: prefix });
    await ids.start();
    play = new PlayJobs(new PlayStoreVerifier({ api: google.api() }), PACKAGE);
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
      iap: (() => {
        const integration = play.integration();
        return { verifiers: { play: integration.verifier }, rtdn: integration.rtdn, voided: integration.voided };
      })(),
    };
    const config = loadConfig({ ...env, DATABASE_URL: db.url, REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix, WORKER_ID: 'iap-play-test' });
    context = { config, redis, log: pino({ level: 'silent' }), services, token: 'test-token' };
    queue = new Queue('iap', { connection: redis, prefix: config.queuePrefix });
    // The settings are loaded once per process (and again only after a configuration change).
    await billingSettingsOf(services, redis, context.log).get();
  }, 90_000);

  afterAll(async () => {
    await queue?.close();
    await closeSocialQueues(redis);
    await ids?.stop();
    const left = await redis?.keys(`${prefix}*`);
    if (left?.length) await redis.del(...left);
    await redis?.quit();
    await pg?.end();
    await db?.drop();
    await role?.drop();
    await google.stop();
  });

  beforeEach(() => google.reset());

  async function newUser(): Promise<string> {
    const { rows } = await db.admin.query<{ id: string }>(
      `INSERT INTO users (id, birth_date, status, gender, onboarding_step, country) VALUES (id_next(), '1994-01-01', 3, 2, 30, 'DE') RETURNING id::text`,
    );
    return rows[0]!.id;
  }

  const ref = (user: string) => publicIds.billing.encode(user);
  const notification = (body: Record<string, unknown>) => FakeGooglePlay.data({ version: '1.0', packageName: PACKAGE, eventTimeMillis: String(Date.now()), ...body });
  const subEvent = (token: string, type: number) => ({ messageId: String(++messages), data: notification({ subscriptionNotification: { version: '1.0', notificationType: type, purchaseToken: token } }) });
  const oneTime = (token: string, sku: string, type = 1) => ({ messageId: String(++messages), data: notification({ oneTimeProductNotification: { version: '1.0', notificationType: type, purchaseToken: token, sku } }) });
  const voided = (token: string, orderId: string, productType: number, refundType = 1) => ({
    messageId: String(++messages),
    data: notification({ voidedPurchaseNotification: { purchaseToken: token, orderId, productType, refundType } }),
  });
  /** One `rtdn` job through the queue's processor, with its statements counted. */
  const rtdn = async (job: { messageId: string; data: string }) => {
    const tally = await statementCounter.measure(() => iapQueue().process(fakeJob('rtdn', job), context));
    return { out: tally.result as Record<string, unknown>, statements: tally.tally.statements };
  };

  async function purchase(token: string) {
    const { rows } = await db.admin.query<{ id: string; user_id: string | null; state: number; acked: boolean; consumed: boolean; updated: string; expires_ms: string | null }>(
      `SELECT id::text, user_id::text, state::integer AS state, acknowledged_at IS NOT NULL AS acked, consumed_at IS NOT NULL AS consumed, updated_at::text AS updated,
              (extract(epoch FROM expires_at) * 1000)::bigint::text AS expires_ms
         FROM store_purchases WHERE store = 1 AND token_hash = decode($1, 'hex')`,
      [tokenHash(token)],
    );
    return rows[0];
  }
  async function plan(user: string): Promise<string | null> {
    const { rows } = await db.admin.query<{ key: string }>(`SELECT p.key FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.user_id = $1 AND s.store = 1 AND s.expires_at > now()`, [user]);
    return rows[0]?.key ?? null;
  }
  async function events(): Promise<number> {
    return Number((await db.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM store_events`)).rows[0]!.n);
  }
  async function wallet(user: string, item = 1): Promise<number> {
    const { rows } = await db.admin.query<{ balance: number }>(`SELECT balance FROM wallet_balances WHERE user_id = $1 AND item = $2 AND store = 1`, [user, item]);
    return rows[0]?.balance ?? 0;
  }

  it('SUBSCRIPTION_PURCHASED before the app sends it: one Developer API call, one statement, the account of its reference; the acknowledgement is done at Google', async () => {
    const user = await newUser();
    const token = `rtdn-new-${user}`;
    google.putSubscription(token, { productId: 'sub.plus', basePlanId: 'm1', expiryTimeMs: Date.now() + 30 * DAY, accountRef: ref(user) });
    const { out, statements } = await rtdn(subEvent(token, 4));
    expect(out).toMatchObject({ outcome: 'handled', result: 'applied', changed: true });
    expect(statements).toBe(1);
    expect(google.apiCalls()).toBe(1);
    const row = (await purchase(token))!;
    expect(row).toMatchObject({ user_id: user, state: 2, acked: false });
    expect(await plan(user)).toBe('plus');
    // The core queued the acknowledgement; running it acknowledges at Google once.
    const ack = await queue.getJob(`ack.${row.id}`);
    expect(ack?.data).toMatchObject({ purchaseId: row.id, store: 'play' });
    expect(await iapQueue().process(fakeJob('ack', ack!.data as Record<string, unknown>), context)).toMatchObject({ outcome: 'done' });
    expect(google.subscriptions.get(token)?.['acknowledgementState']).toBe('ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED');
    expect((await purchase(token))!.acked).toBe(true);
    expect(await iapQueue().process(fakeJob('ack', ack!.data as Record<string, unknown>), context)).toMatchObject({ outcome: 'already' });
    expect(google.count('subscriptions.acknowledge')).toBe(1);
  });

  it('the same state notified again writes nothing (0 writes)', async () => {
    const user = await newUser();
    const token = `rtdn-same-${user}`;
    google.putSubscription(token, { productId: 'sub.plus', expiryTimeMs: Date.now() + 30 * DAY, accountRef: ref(user), acknowledged: true });
    await rtdn(subEvent(token, 4));
    const before = { row: await purchase(token), events: await events() };
    const again = await rtdn(subEvent(token, 4));
    expect(again.out).toMatchObject({ result: 'unchanged', changed: false });
    expect(await purchase(token)).toEqual(before.row);
    expect(await events()).toBe(before.events);
  });

  it('an older read never overwrites a newer one (last_event_ms)', async () => {
    const user = await newUser();
    const token = `rtdn-order-${user}`;
    let clock = Date.now();
    const timed = new PlayJobs(new PlayStoreVerifier({ api: google.api(), now: () => clock }), PACKAGE, () => clock);
    google.putSubscription(token, { state: 'SUBSCRIPTION_STATE_CANCELED', productId: 'sub.plus', expiryTimeMs: Date.now() + 10 * DAY, accountRef: ref(user), acknowledged: true, autoRenew: false });
    expect(await timed.rtdn(subEvent(token, 3), context)).toMatchObject({ result: 'applied' });
    expect((await purchase(token))!.state).toBe(3);
    // A read that finished earlier (an ACTIVE answer from before the cancellation) arrives late.
    clock -= 60_000;
    google.putSubscription(token, { state: 'SUBSCRIPTION_STATE_ACTIVE', productId: 'sub.plus', expiryTimeMs: Date.now() + 10 * DAY, accountRef: ref(user), acknowledged: true });
    const before = await events();
    expect(await timed.rtdn(subEvent(token, 7), context)).toMatchObject({ result: 'stale' });
    expect((await purchase(token))!.state).toBe(3);
    expect(await events()).toBe(before);
  });

  it('RENEWED moves the expiry in one statement; REVOKED ends access at once', async () => {
    const user = await newUser();
    const token = `rtdn-renew-${user}`;
    const first = Date.now() + 2 * DAY;
    google.putSubscription(token, { productId: 'sub.premium', basePlanId: 'm1', expiryTimeMs: first, accountRef: ref(user), acknowledged: true, orderId: 'GPA.1000-0000-0000-00001' });
    await rtdn(subEvent(token, 4));
    const renewed = first + 30 * DAY;
    google.putSubscription(token, { productId: 'sub.premium', basePlanId: 'm1', expiryTimeMs: renewed, accountRef: ref(user), acknowledged: true, orderId: 'GPA.1000-0000-0000-00001..0' });
    const { out, statements } = await rtdn(subEvent(token, 2));
    expect(out).toMatchObject({ result: 'applied', changed: true });
    expect(statements).toBe(1);
    expect(Number((await purchase(token))!.expires_ms)).toBe(renewed);
    const { rows } = await db.admin.query<{ event: number }>(`SELECT e.event::integer AS event FROM store_events e JOIN store_purchases p ON p.id = e.purchase_id WHERE p.token_hash = decode($1, 'hex') ORDER BY e.id`, [tokenHash(token)]);
    expect(rows.map((r) => r.event)).toEqual([1, 2]);
    // Revoked (a refund or a chargeback): Google shows EXPIRED, the server records revoked and the plan is gone.
    google.putSubscription(token, { state: 'SUBSCRIPTION_STATE_EXPIRED', productId: 'sub.premium', basePlanId: 'm1', expiryTimeMs: Date.now(), accountRef: ref(user), acknowledged: true });
    expect((await rtdn(subEvent(token, 12))).out).toMatchObject({ result: 'applied', state: 8, changed: true });
    expect(await plan(user)).toBeNull();
  });

  it('ON_HOLD takes access away and RECOVERED gives it back', async () => {
    const user = await newUser();
    const token = `rtdn-hold-${user}`;
    google.putSubscription(token, { productId: 'sub.plus', expiryTimeMs: Date.now() + DAY, accountRef: ref(user), acknowledged: true });
    await rtdn(subEvent(token, 4));
    google.putSubscription(token, { state: 'SUBSCRIPTION_STATE_ON_HOLD', productId: 'sub.plus', expiryTimeMs: Date.now() - HOUR, accountRef: ref(user), acknowledged: true });
    expect((await rtdn(subEvent(token, 5))).out).toMatchObject({ state: 5 });
    expect(await plan(user)).toBeNull();
    google.putSubscription(token, { productId: 'sub.plus', expiryTimeMs: Date.now() + 30 * DAY, accountRef: ref(user), acknowledged: true });
    expect((await rtdn(subEvent(token, 1))).out).toMatchObject({ state: 2 });
    expect(await plan(user)).toBe('plus');
  });

  it('a linked token (an upgrade) replaces the old row and keeps the person, even without a reference', async () => {
    const user = await newUser();
    const old = `rtdn-linked-old-${user}`;
    const fresh = `rtdn-linked-new-${user}`;
    google.putSubscription(old, { productId: 'sub.plus', expiryTimeMs: Date.now() + 10 * DAY, accountRef: ref(user), acknowledged: true });
    await rtdn(subEvent(old, 4));
    google.putSubscription(old, { state: 'SUBSCRIPTION_STATE_EXPIRED', productId: 'sub.plus', expiryTimeMs: Date.now(), accountRef: ref(user), acknowledged: true });
    google.putSubscription(fresh, { productId: 'sub.premium', expiryTimeMs: Date.now() + 30 * DAY, linkedPurchaseToken: old });
    expect((await rtdn(subEvent(fresh, 4))).out).toMatchObject({ result: 'applied', changed: true });
    expect(await purchase(old)).toMatchObject({ state: 9, user_id: user });
    expect(await purchase(fresh)).toMatchObject({ state: 2, user_id: user });
    expect(await plan(user)).toBe('premium');
  });

  it('a token Google does not know is refused; undecodable, test and foreign-package messages do nothing', async () => {
    const before = await events();
    expect((await rtdn(subEvent(`rtdn-nobody-${messages}`, 4))).out).toMatchObject({ result: 'refused' });
    expect((await rtdn({ messageId: 'x1', data: 'bm90IGpzb24=' })).out).toMatchObject({ result: 'undecodable' });
    expect((await rtdn({ messageId: 'x2', data: notification({ testNotification: { version: '1.0' } }) })).out).toMatchObject({ result: 'test' });
    const other = FakeGooglePlay.data({ version: '1.0', packageName: 'com.example.other', subscriptionNotification: { version: '1.0', notificationType: 4, purchaseToken: 'tok-other-package' } });
    expect((await rtdn({ messageId: 'x3', data: other })).out).toMatchObject({ result: 'other_package' });
    expect(await events()).toBe(before);
  });

  it('a voided consumable reverses the wallet once and never below zero', async () => {
    const user = await newUser();
    const token = `rtdn-cons-${user}`;
    google.putProduct(token, { productId: 'cons.superlike.5', accountRef: ref(user), orderId: `GPA.2000-0000-0000-${user.slice(-5)}` });
    expect((await rtdn(oneTime(token, 'cons.superlike.5'))).out).toMatchObject({ result: 'applied', state: 12, changed: true });
    expect(await wallet(user)).toBe(5);
    // Consumed at Google by the core's job.
    const row = (await purchase(token))!;
    expect(await iapQueue().process(fakeJob('consume', { purchaseId: row.id, store: 'play' }), context)).toMatchObject({ outcome: 'done' });
    expect((await purchase(token))!.state).toBe(10);
    // Three of the five were spent before the refund.
    await db.admin.query(`UPDATE wallet_balances SET balance = 2 WHERE user_id = $1 AND item = 1 AND store = 1`, [user]);
    const orderId = String(google.products.get(token)!['orderId']);
    expect((await rtdn(voided(token, orderId, 2))).out).toMatchObject({ result: 'applied', state: 8 });
    expect(await wallet(user)).toBe(0);
    const { rows } = await db.admin.query<{ delta: number; reason: number }>(`SELECT delta, reason::integer AS reason FROM wallet_ledger WHERE user_id = $1 ORDER BY id`, [user]);
    expect(rows).toEqual([{ delta: 5, reason: 1 }, { delta: -2, reason: 3 }]);
    // The same refund again (a second notification, then the daily list): nothing more.
    expect((await rtdn(voided(token, orderId, 2))).out).toMatchObject({ result: 'already' });
    google.voided.length = 0;
    google.addVoided({ purchaseToken: token, orderId, voidedTimeMs: Date.now() - 5 * 60_000, subscription: false });
    await redis.del(keys.jobLease('iap-voided'), keys.playVoidedMark());
    expect(await play.voided(context)).toMatchObject({ leased: true, entries: 1, revoked: 0, failed: 0 });
    expect(await wallet(user)).toBe(0);
    expect((await db.admin.query(`SELECT 1 FROM wallet_ledger WHERE user_id = $1`, [user])).rowCount).toBe(2);
  });

  it('the daily voided sweep: the refunded current period is revoked, an earlier renewal\'s refund keeps access, the window moves on', async () => {
    google.voided.length = 0;
    const a = await newUser();
    const b = await newUser();
    const ta = `sweep-a-${a}`;
    const tb = `sweep-b-${b}`;
    google.putSubscription(ta, { productId: 'sub.plus', expiryTimeMs: Date.now() + 20 * DAY, accountRef: ref(a), acknowledged: true, orderId: `GPA.3000-0000-0000-${a.slice(-5)}` });
    google.putSubscription(tb, { productId: 'sub.plus', expiryTimeMs: Date.now() + 20 * DAY, accountRef: ref(b), acknowledged: true, orderId: `GPA.4000-0000-0000-${b.slice(-5)}..1` });
    await rtdn(subEvent(ta, 4));
    await rtdn(subEvent(tb, 4));
    google.addVoided({ purchaseToken: ta, orderId: `GPA.3000-0000-0000-${a.slice(-5)}`, voidedTimeMs: Date.now() - 5 * 60_000, subscription: true });
    google.addVoided({ purchaseToken: tb, orderId: `GPA.4000-0000-0000-${b.slice(-5)}..0`, voidedTimeMs: Date.now() - 5 * 60_000, subscription: true });
    google.addVoided({ purchaseToken: `sweep-never-stored-${a}`, orderId: 'GPA.9999', voidedTimeMs: Date.now() - 5 * 60_000, subscription: false });
    await redis.del(keys.jobLease('iap-voided'), keys.playVoidedMark());
    // Google is down first: the run fails, the window does not move.
    google.failNext('voidedpurchases.list', 503, { times: 3 });
    await expect(play.voided(context)).rejects.toThrow();
    expect(await redis.get(keys.playVoidedMark())).toBeNull();
    await redis.del(keys.jobLease('iap-voided'));
    const started = Date.now();
    const out = await play.voided(context);
    expect(out).toMatchObject({ leased: true, entries: 3, revoked: 1, failed: 0, complete: true });
    expect(await plan(a)).toBeNull();
    expect((await purchase(ta))!.state).toBe(8);
    expect(await plan(b)).toBe('plus');
    const list = google.calls.filter((c) => c.route === 'voidedpurchases.list').at(-1)!;
    expect(list.query?.['type']).toBe('1');
    expect(Number(list.query?.['startTime'])).toBeGreaterThanOrEqual(started - 30 * DAY);
    const mark = Number(await redis.get(keys.playVoidedMark()));
    expect(mark).toBeGreaterThan(started - 2 * 60_000);
    // A second trigger inside the lease does nothing; the next day's window starts two hours before the mark.
    expect(await play.voided(context)).toEqual({ leased: false });
    await redis.del(keys.jobLease('iap-voided'));
    google.reset();
    await play.voided(context);
    expect(Number(google.calls.find((c) => c.route === 'voidedpurchases.list')!.query?.['startTime'])).toBe(mark - 2 * HOUR);
  });

  it('the acknowledgement is retried on a fake clock until Google answers, before 60 h', async () => {
    const user = await newUser();
    const token = `ack-retry-${user}`;
    google.putSubscription(token, { productId: 'sub.plus', expiryTimeMs: Date.now() + 30 * DAY, accountRef: ref(user) });
    await rtdn(subEvent(token, 4));
    const row = (await purchase(token))!;
    const ack = (await queue.getJob(`ack.${row.id}`))!.data as { deadlineMs: number };
    const startMs = ack.deadlineMs - ACK_DEADLINE_MS;
    // Google answers 503 to every acknowledgement for the first 58 hours.
    let now = startMs;
    const job = fakeJob('ack', ack);
    const runner = iapQueue({ now: () => now });
    let runs = 0;
    for (;;) {
      runs += 1;
      if (now < startMs + 58 * HOUR) google.failNext('subscriptions.acknowledge', 503, { times: 3 });
      try {
        expect(await runner.process(job, context)).toMatchObject({ outcome: 'done' });
        break;
      } catch (error) {
        expect(error).toBeInstanceOf(DelayedError);
        expect(job.delayedUntil).toBeGreaterThan(now);
        now = job.delayedUntil!;
        google.reset();
      }
      if (runs > 1_000) throw new Error('never acknowledged');
    }
    expect(now).toBeLessThan(startMs + ACK_DEADLINE_MS);
    expect(runs).toBeGreaterThan(100);
    expect(google.subscriptions.get(token)?.['acknowledgementState']).toBe('ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED');
    expect((await purchase(token))!.acked).toBe(true);
  });

  it('the acknowledgement is given up at the deadline when Google never answers', async () => {
    const user = await newUser();
    const token = `ack-never-${user}`;
    google.putSubscription(token, { productId: 'sub.plus', expiryTimeMs: Date.now() + 30 * DAY, accountRef: ref(user) });
    await rtdn(subEvent(token, 4));
    const row = (await purchase(token))!;
    const ack = (await queue.getJob(`ack.${row.id}`))!.data as { deadlineMs: number };
    let now = ack.deadlineMs - 20 * 60_000;
    const job = fakeJob('ack', ack);
    const runner = iapQueue({ now: () => now });
    let outcome: unknown;
    for (let i = 0; i < 20 && outcome === undefined; i += 1) {
      google.failNext('subscriptions.acknowledge', 503, { times: 3 });
      try {
        outcome = (await runner.process(job, context)).outcome;
      } catch (error) {
        expect(error).toBeInstanceOf(DelayedError);
        expect(job.delayedUntil).toBeLessThanOrEqual(ack.deadlineMs);
        now = job.delayedUntil!;
      }
    }
    expect(outcome).toBe('gave_up');
    expect((await purchase(token))!.acked).toBe(false);
  });

  it('consume: Google\'s "already consumed" counts as done and is recorded', async () => {
    const user = await newUser();
    const token = `consume-already-${user}`;
    google.putProduct(token, { productId: 'cons.boost.1', accountRef: ref(user) });
    await rtdn(oneTime(token, 'cons.boost.1'));
    const row = (await purchase(token))!;
    const line = (google.products.get(token)!['productLineItem'] as { productOfferDetails: Record<string, unknown> }[])[0]!;
    line.productOfferDetails['consumptionState'] = 'CONSUMPTION_STATE_CONSUMED';
    expect(await iapQueue().process(fakeJob('consume', { purchaseId: row.id, store: 'play' }), context)).toMatchObject({ outcome: 'already' });
    expect(await purchase(token)).toMatchObject({ state: 10, consumed: true });
    expect(await wallet(user, 2)).toBe(1);
  });

  it('revoke refunds in full at Google: subscriptionsv2.revoke, and orders.refund with revoke=true for a one-time product', async () => {
    const sub = `revoke-sub-${messages}`;
    google.putSubscription(sub, { productId: 'sub.plus', expiryTimeMs: Date.now() + 30 * DAY, accountRef: 'zzzzzzzzzzzzzzzzzzzz' });
    expect(await iapQueue().process(fakeJob('revoke', { store: 'play', kind: 'subscription', productId: 'sub.plus', token: sub, tokenHash: tokenHash(sub) }), context)).toMatchObject({ outcome: 'done' });
    expect(google.subscriptions.get(sub)?.['subscriptionState']).toBe('SUBSCRIPTION_STATE_EXPIRED');
    expect(google.calls.find((c) => c.route === 'subscriptionsv2.revoke')?.body).toEqual({ revocationContext: { fullRefund: {} } });
    const one = `revoke-one-${messages}`;
    google.putProduct(one, { productId: 'cons.boost.1', orderId: 'GPA.5000-0000-0000-00001' });
    expect(await iapQueue().process(fakeJob('revoke', { store: 'play', kind: 'consumable', productId: 'cons.boost.1', token: one, tokenHash: tokenHash(one) }), context)).toMatchObject({ outcome: 'done' });
    expect(google.calls.find((c) => c.route === 'orders.refund')).toMatchObject({ subject: 'GPA.5000-0000-0000-00001', query: { revoke: 'true' } });
  });
});
