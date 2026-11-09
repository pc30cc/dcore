import { randomBytes } from 'node:crypto';
import { applyStorePurchase, createPool, instrumentPool, statementCounter, type Pool, type PurchaseApply } from '@app/db';
import { userChannel, type RealtimeEnvelope } from '@app/shared';
import {
  ACK_DEADLINE_MS,
  FakePushSender,
  FakeRealtimePublisher,
  FakeStoreVerifier,
  IdGenerator,
  PurchaseCore,
  StoreError,
  createKeys,
  createPublicIds,
  parseEntitlementBase,
  tokenHash,
  type PurchaseApplyInput,
  type PurchaseCoreDeps,
} from '@app/shared/server';
import { DelayedError, Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { billingSettingsOf, iapQueue, loadConfig, purchaseCoreOf, subEndJob, type JobContext } from '../src/index.js';
import { FakePhotoModerator } from '../src/photos/moderation.js';
import type { WorkerServices } from '../src/services.js';
import { ensureGroupRoles, hasDatabase, loginRole, migratedDatabase, type TestDatabase } from './db.js';
import { TEST_REDIS_URL, baseEnv, connect, hasRedis } from './support.js';

/**
 * The `iap` queue and the purchase core after review: every failure of a
 * follow-up job is retried (the database's too) and the jobs carry BullMQ
 * attempts; the hourly sweep queues again what the database says is owed;
 * a refund check's retry window starts at its due time; a consume's
 * deadline comes from the store's time of the purchase; the server's own
 * end states are not asked again; entitlements are cached only under the
 * versions the writer moved to; the owner of a replaced token of someone
 * else, and a write that only put a subscription row back, move the
 * versions; every `entitlement` event names its store.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type FakeJob = Job & { delayedUntil?: number };

function fakeJob(name: string, data: Record<string, unknown>, options: { timestamp?: number; delay?: number } = {}): FakeJob {
  const job = {
    name,
    data,
    id: `${name}.test`,
    timestamp: options.timestamp ?? Date.now(),
    opts: options.delay === undefined ? {} : { delay: options.delay },
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

describe.skipIf(!hasDatabase || !hasRedis)('the iap queue after review (PostgreSQL, Valkey)', () => {
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
  let queue: Queue;

  beforeAll(async () => {
    await ensureGroupRoles();
    role = await loginRole(['app_rw']);
    db = await migratedDatabase();
    pg = instrumentPool(createPool({ connectionString: db.urlFor(role.name, role.password), applicationName: 'iap-review-test', max: 4 }), statementCounter);
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
    const config = loadConfig({ ...env, DATABASE_URL: db.url, REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix, WORKER_ID: 'iap-review-test' });
    context = { config, redis, log: pino({ level: 'silent' }), services, token: 'test-token' };
    queue = new Queue('iap', { connection: redis, prefix: config.queuePrefix });
    const { rows } = await db.admin.query<{ id: number; store: number; product_id: string; base_plan_id: string | null }>(`SELECT id, store, product_id, base_plan_id FROM store_products`);
    for (const r of rows) products.set(`${r.store}:${r.product_id}:${r.base_plan_id ?? ''}`, r.id);
  }, 90_000);

  afterAll(async () => {
    await queue?.close();
    await ids?.stop();
    const left = await redis?.keys(`${prefix}*`);
    if (left?.length) await redis.del(...left);
    await redis?.quit();
    await pg?.end();
    await db?.drop();
    await role?.drop();
  });

  beforeEach(() => {
    play.failures.length = 0;
    bazaar.failures.length = 0;
  });

  const product = (store: number, id: string, base = '') => products.get(`${store}:${id}:${base}`)!;

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

  /** The purchase core as the worker builds it, with some dependencies replaced. */
  async function core(over: Partial<PurchaseCoreDeps> = {}): Promise<PurchaseCore> {
    const settings = await billingSettingsOf(context.services, redis, context.log).get();
    return new PurchaseCore({
      apply: (input: PurchaseApplyInput) => applyStorePurchase(pg, input),
      redis,
      cache: redis,
      keys,
      publicIds,
      realtime,
      ids,
      jobs: { add: async () => undefined },
      settings: () => settings,
      manageUrl: () => undefined,
      log: context.log,
      ...over,
    });
  }

  const eventsOf = (user: string): RealtimeEnvelope[] => realtime.on(userChannel(publicIds.user.encode(user))).filter((e) => e.t === 'entitlement');
  const versionOf = async (user: string) => Number((await redis.get(keys.entitlementsVersion(user))) ?? 0);

  const broken = { query: () => Promise.reject(new Error('Connection terminated unexpectedly')) } as unknown as Pool;

  it('retries an acknowledgement or a consume when the database fails, instead of failing the job for good', async () => {
    const bare: JobContext = { ...context, services: { ...context.services, pg: broken } };
    const ack = fakeJob('ack', { purchaseId: '123456789', store: 'play', deadlineMs: Date.now() + ACK_DEADLINE_MS });
    await expect(iapQueue().process(ack, bare)).rejects.toBeInstanceOf(DelayedError);
    expect(ack.delayedUntil).toBeGreaterThan(Date.now());
    expect(ack.data).toMatchObject({ tries: 1 });
    const consume = fakeJob('consume', { purchaseId: '123456789', store: 'bazaar', deadlineMs: Date.now() + HOUR });
    await expect(iapQueue().process(consume, bare)).rejects.toBeInstanceOf(DelayedError);
    const recheck = fakeJob('recheck', { purchaseId: '123456789', store: 'bazaar', atMs: Date.now() });
    await expect(iapQueue().process(recheck, bare)).rejects.toBeInstanceOf(DelayedError);
  });

  it('queues every follow-up job with BullMQ attempts, the consume with its deadline and the refund check with its due time', async () => {
    const user = await newUser();
    const now = Date.now();
    const sub = `follow-sub-${user}`;
    play.put(sub, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1', needsAcknowledge: true, nextCheckAtMs: now + 31 * DAY, purchasedAtMs: now - 1_000 });
    const settings = await billingSettingsOf(context.services, redis, context.log).get();
    const verifiedSub = await play.verify({ store: 'play', productId: 'sub.plus', purchaseToken: sub, kind: 'subscription' });
    const a = await purchaseCoreOf(context, settings).apply(verifiedSub, { store: 'play', token: sub, callerId: user, source: 1 });
    if (!('purchaseId' in a)) throw new Error('not applied');
    const pack = `follow-pack-${user}`;
    const completedAt = now - 5_000;
    bazaar.put(pack, { kind: 'consumable', productId: 'cons.superlike.5', purchasedAtMs: completedAt, refundCheckAtMs: now + 7 * DAY });
    const verifiedPack = await bazaar.verify({ store: 'bazaar', productId: 'cons.superlike.5', purchaseToken: pack, kind: 'consumable' });
    const b = await purchaseCoreOf(context, settings).apply(verifiedPack, { store: 'bazaar', token: pack, callerId: user, source: 1 });
    if (!('purchaseId' in b)) throw new Error('not applied');
    const ackJob = await queue.getJob(`ack.${a.purchaseId}`);
    const recheckJob = (await queue.getJobs(['delayed'])).find((j) => j.id?.startsWith(`recheck.${a.purchaseId}.`));
    const subEnd = (await queue.getJobs(['delayed'])).find((j) => j.id?.startsWith(`sub-end.${user}.1.`));
    const consumeJob = await queue.getJob(`consume.${b.purchaseId}`);
    const refundJob = await queue.getJob(`refund-check.${b.purchaseId}`);
    for (const job of [ackJob, recheckJob, subEnd, consumeJob, refundJob]) {
      expect(job, 'queued').toBeTruthy();
      expect(job!.opts.attempts).toBe(8);
      expect(job!.opts.backoff).toMatchObject({ type: 'exponential' });
    }
    expect(consumeJob!.data).toMatchObject({ deadlineMs: completedAt + ACK_DEADLINE_MS });
    expect(refundJob!.data).toMatchObject({ atMs: now + 7 * DAY });
  });

  it('measures a refund check’s retry window from its due time, not from when it was queued a week before', async () => {
    const user = await newUser();
    const token = `refund-late-${user}`;
    const purchaseId = await stored({ token, store: 2, productRef: product(2, 'cons.boost.5'), kind: 2, state: 12, callerId: user, purchasedAtMs: Date.now() - 7 * DAY });
    bazaar.put(token, { kind: 'consumable', productId: 'cons.boost.5' });
    const dueAt = Date.now() - 60_000;
    const queuedAt = dueAt - 7 * DAY - 2 * HOUR;
    bazaar.failures.push(new StoreError('unavailable', 'held back by the call meter'));
    const job = fakeJob('refund-check', { purchaseId, store: 'bazaar', atMs: dueAt }, { timestamp: queuedAt });
    await expect(iapQueue().process(job, context)).rejects.toBeInstanceOf(DelayedError);
    expect(job.data).toMatchObject({ tries: 1, atMs: dueAt });
    // A job queued before the due time was carried: its own time plus its delay, kept for the next tries.
    bazaar.failures.push(new StoreError('unavailable', '5xx'));
    const legacy = fakeJob('refund-check', { purchaseId, store: 'bazaar' }, { timestamp: queuedAt, delay: 7 * DAY + 2 * HOUR - 60_000 });
    await expect(iapQueue().process(legacy, context)).rejects.toBeInstanceOf(DelayedError);
    expect(legacy.data).toMatchObject({ tries: 1, atMs: queuedAt + 7 * DAY + 2 * HOUR - 60_000 });
    // A day after it was due it gives up (the sweep never re-queues a refund check: it is not a next check).
    bazaar.failures.push(new StoreError('unavailable', 'down'));
    const old = fakeJob('refund-check', { purchaseId, store: 'bazaar', atMs: Date.now() - DAY - HOUR }, { timestamp: queuedAt });
    expect(await iapQueue().process(old, context)).toMatchObject({ outcome: 'gave_up' });
  });

  it('takes a consume’s deadline from the store’s time of the purchase the job carries', async () => {
    const user = await newUser();
    const token = `consume-late-${user}`;
    // First read while pending 70 hours ago (the row's time); the payment completed an hour ago.
    const purchaseId = await stored({ token, store: 1, productRef: product(1, 'cons.superlike.5'), kind: 2, state: 12, callerId: user, purchasedAtMs: Date.now() - 70 * HOUR });
    await db.admin.query(`UPDATE store_purchases SET purchased_at = now() - interval '70 hours' WHERE id = $1`, [purchaseId]);
    play.put(token, { kind: 'consumable', productId: 'cons.superlike.5' });
    play.failures.push(new StoreError('unavailable', '503'));
    const job = fakeJob('consume', { purchaseId, store: 'play', deadlineMs: Date.now() - HOUR + ACK_DEADLINE_MS });
    await expect(iapQueue().process(job, context)).rejects.toBeInstanceOf(DelayedError);
    // Tried again: consumed.
    expect(await iapQueue().process(job, context)).toMatchObject({ outcome: 'done' });
  });

  it('does not ask the store again about a purchase the server ended itself; a refused check is asked again in a day', async () => {
    const user = await newUser();
    const t1 = `replaced-${user}`;
    const old = await stored({ token: t1, store: 1, productRef: product(1, 'sub.plus', 'm1'), kind: 1, state: 2, callerId: user });
    await stored({ token: `upgrade-${user}`, store: 1, productRef: product(1, 'sub.premium', 'm1'), kind: 1, state: 2, callerId: user, linkedTokenHash: tokenHash(t1) });
    play.put(t1, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1', state: 'expired', expiresAtMs: Date.now() - 1_000, eventMs: Date.now() });
    const calls = play.count('recheck');
    expect(await iapQueue().process(fakeJob('recheck', { purchaseId: old, store: 'play', atMs: Date.now() }), context)).toMatchObject({ outcome: 'final', state: 9 });
    expect(play.count('recheck')).toBe(calls);
    const events = await db.admin.query<{ event: number }>(`SELECT event FROM store_events WHERE purchase_id = $1 ORDER BY id`, [old]);
    expect(events.rows.map((r) => r.event)).toEqual([1, 11]);

    const refusedToken = `refused-${user}`;
    const refused = await stored({ token: refusedToken, store: 2, productRef: product(2, 'sub.plus.1m'), kind: 1, state: 2, callerId: user, nextCheckAtMs: Date.now() - HOUR });
    // The fake store does not know the token: `invalid`.
    expect(await iapQueue().process(fakeJob('recheck', { purchaseId: refused, store: 'bazaar', atMs: Date.now() - HOUR }), context)).toMatchObject({ outcome: 'refused' });
    const next = await db.admin.query<{ later: boolean }>(`SELECT next_check_at > now() + interval '23 hours' AS later FROM store_purchases WHERE id = $1`, [refused]);
    expect(next.rows[0]!.later).toBe(true);
  });

  it('caches the base of a subscription’s end under the version it moved to, never under one read afterwards', async () => {
    const user = await newUser();
    const plus = (await db.admin.query<{ id: number }>(`SELECT id FROM plans WHERE key = 'plus'`)).rows[0]!.id;
    await db.admin.query(`INSERT INTO entitlement_grants (id, user_id, starts_at, ends_at, plan_id, reason) VALUES (id_next(), $1, now() - interval '1 minute', now() + interval '2 days', $2, 'test')`, [user, plus]);
    await redis.set(keys.entitlements(user, 2), '{}');
    // Another writer moves the version right after this job's own move, before anything else is read.
    let moved = false;
    const racing = new Proxy(redis, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop === 'mget' && !moved) {
          return async (...args: string[]) => {
            moved = true;
            await target.incr(keys.entitlementsVersion(user));
            return target.mget(...args);
          };
        }
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const out = await subEndJob({ data: { userId: user, store: 0, atMs: Date.now() } }, { ...context, redis: racing });
    expect(out).toMatchObject({ outcome: 'changed', published: true });
    expect(moved).toBe(true);
    const raw = await redis.get(keys.entitlements(user, 2));
    const current = await versionOf(user);
    expect(current).toBe(2);
    // Whatever was cached is not current: the other writer's move made it unusable.
    expect(parseEntitlementBase(raw, false, current, undefined)).toBeNull();
    // The event names the build it was built for.
    expect(eventsOf(user).at(-1)?.d).toMatchObject({ plan: 'plus', store: 'bazaar' });
  });

  it('caches a purchase’s base only when nobody else moved the versions since they were read, and moves them before the token record', async () => {
    const user = await newUser();
    const token = `prime-${user}`;
    bazaar.put(token, { kind: 'subscription', productId: 'sub.plus.1m', eventMs: Date.now() });
    const verified = await bazaar.verify({ store: 'bazaar', productId: 'sub.plus.1m', purchaseToken: token, kind: 'subscription' });
    // Another writer moves the version while this statement runs.
    const racing = await core({
      apply: async (input) => {
        await redis.incr(keys.entitlementsVersion(user));
        return applyStorePurchase(pg, input);
      },
    });
    const first = await racing.apply(verified, { store: 'bazaar', token, callerId: user, source: 1 });
    expect(first).toMatchObject({ outcome: 'applied', changed: true });
    expect(parseEntitlementBase(await redis.get(keys.entitlements(user, 2)), false, await versionOf(user), undefined)).toBeNull();

    // Nobody else: cached under the versions this write moved to, which are current. The version moves before the record.
    const order: string[] = [];
    const recording = new Proxy(redis, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop === 'multi') {
          return (...a: unknown[]) => {
            order.push('versions');
            return (value as (...x: unknown[]) => unknown).apply(target, a);
          };
        }
        if (prop === 'set') {
          return (...a: unknown[]) => {
            if (String(a[0]).includes(':iap:t:')) order.push('record');
            return (value as (...x: unknown[]) => unknown).apply(target, a);
          };
        }
        return typeof value === 'function' ? (value as (...x: unknown[]) => unknown).bind(target) : value;
      },
    });
    bazaar.put(token, { kind: 'subscription', productId: 'sub.plus.1m', eventMs: Date.now() + 1, expiresAtMs: Date.now() + 60 * DAY });
    const renewal = await bazaar.verify({ store: 'bazaar', productId: 'sub.plus.1m', purchaseToken: token, kind: 'subscription' });
    const quiet = await core({ redis: recording, cache: recording });
    expect(await quiet.apply(renewal, { store: 'bazaar', token, callerId: user, source: 1 })).toMatchObject({ outcome: 'applied', changed: true });
    expect(order).toEqual(['versions', 'record']);
    const cached = parseEntitlementBase(await redis.get(keys.entitlements(user, 2)), false, await versionOf(user), Number(await redis.get(keys.entitlementsWalletVersion(user))));
    expect(cached?.plans.length).toBe(1);
  });

  it('moves the entitlements of the owner of a replaced token of someone else, and tells them', async () => {
    const a = await newUser();
    const b = await newUser();
    const t1 = `a-token-${a}`;
    await stored({ token: t1, store: 1, productRef: product(1, 'sub.plus', 'm1'), kind: 1, state: 2, callerId: a });
    await redis.set(keys.entitlements(a, 1), '{"cached":"before"}');
    const before = await versionOf(a);
    const t2 = `b-token-${b}`;
    play.put(t2, { kind: 'subscription', productId: 'sub.premium', basePlanId: 'm1', linkedPurchaseToken: t1, accountRef: publicIds.billing.encode(b), eventMs: Date.now() });
    const verified = await play.verify({ store: 'play', productId: 'sub.premium', purchaseToken: t2, kind: 'subscription' });
    const out = await (await core()).apply(verified, { store: 'play', token: t2, callerId: null, source: 2 });
    expect(out).toMatchObject({ outcome: 'applied', userId: b });
    expect(await versionOf(a)).toBe(before + 1);
    expect(await redis.get(keys.entitlements(a, 1))).toBeNull();
    expect(eventsOf(a).at(-1)?.d).toMatchObject({ plan: 'free', store: 'play' });
    expect(eventsOf(b).at(-1)?.d).toMatchObject({ plan: 'premium', store: 'play' });
  });

  it('moves the versions when the purchase row did not change but its subscription row was put back', async () => {
    const user = await newUser();
    const token = `put-back-${user}`;
    bazaar.put(token, { kind: 'subscription', productId: 'sub.plus.1m', expiresAtMs: Date.now() + 30 * DAY, eventMs: Date.now() });
    const verified = await bazaar.verify({ store: 'bazaar', productId: 'sub.plus.1m', purchaseToken: token, kind: 'subscription' });
    const c = await core();
    await c.apply(verified, { store: 'bazaar', token, callerId: user, source: 1 });
    // The subscription's end ran from a stale read and took the row away.
    await db.admin.query(`DELETE FROM subscriptions WHERE user_id = $1`, [user]);
    const before = await versionOf(user);
    const told = eventsOf(user).length;
    // Whatever the statement calls its outcome (the purchase row itself is unchanged), the put-back row counts.
    const unchanged = await core({ apply: async (input) => ({ ...(await applyStorePurchase(pg, input)), outcome: 'unchanged' }) as Awaited<ReturnType<PurchaseCoreDeps['apply']>> });
    const again = await unchanged.apply({ ...verified, eventMs: verified.eventMs + 1 }, { store: 'bazaar', token, callerId: null, source: 3 });
    expect(again).toMatchObject({ changed: true });
    expect(await versionOf(user)).toBe(before + 1);
    expect(eventsOf(user).length).toBe(told + 1);
    expect(eventsOf(user).at(-1)?.d).toMatchObject({ plan: 'plus', store: 'bazaar' });
  });

  describe('the hourly sweep', () => {
    let sweep: JobContext;
    let sweepQueue: Queue;
    const sweepPrefix = `t${randomBytes(4).toString('hex')}:`;

    beforeAll(() => {
      const config = loadConfig({ ...env, DATABASE_URL: db.url, REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: sweepPrefix, WORKER_ID: 'iap-sweep-test' });
      sweep = { ...context, config, services: { ...context.services, keys: createKeys(sweepPrefix) } };
      sweepQueue = new Queue('iap', { connection: redis, prefix: config.queuePrefix });
    });

    afterAll(async () => {
      await sweepQueue?.close();
      const left = await redis?.keys(`${sweepPrefix}*`);
      if (left?.length) await redis.del(...left);
    });

    const run = async () => {
      await redis.del(sweep.services.keys.jobLease('iap-checks'));
      return iapQueue().process(fakeJob('checks', {}), sweep);
    };

    it('queues again a re-check overdue in the database, leaves one that waits, replaces one that finished', async () => {
      // Only this test's rows are due.
      await db.admin.query(`UPDATE store_purchases SET next_check_at = NULL, acknowledged_at = coalesce(acknowledged_at, now()), consumed_at = coalesce(consumed_at, now())`);
      const user = await newUser();
      const now = Date.now();
      const atMs = now - 26 * HOUR;
      const lost = await stored({ token: `lost-${user}`, store: 2, productRef: product(2, 'sub.plus.1m'), kind: 1, state: 2, callerId: user, nextCheckAtMs: atMs });
      const first = await run();
      expect(first).toMatchObject({ outcome: 'swept', rechecks: 1, queued: 1 });
      const job = await sweepQueue.getJob(`recheck.${lost}.${atMs}`);
      expect(job?.data).toMatchObject({ purchaseId: lost, store: 'bazaar', atMs });
      expect(Number((job!.data as Record<string, unknown>)['untilMs'])).toBeGreaterThan(now + 40 * 60_000);
      expect(job!.opts.attempts).toBe(8);
      // Still waiting: left alone.
      expect(await run()).toMatchObject({ rechecks: 1, queued: 0, pending: 1 });
      // It ran and gave up (kept by retention, so a plain add would do nothing): queued again.
      const worker = new Worker('iap', null, { connection: connect(), prefix: sweep.config.queuePrefix, autorun: false });
      try {
        const taken = await worker.getNextJob('sweep-test');
        expect(taken?.id).toBe(`recheck.${lost}.${atMs}`);
        await taken?.moveToCompleted({ outcome: 'gave_up' }, 'sweep-test', false);
      } finally {
        await worker.close();
      }
      expect(await (await sweepQueue.getJob(`recheck.${lost}.${atMs}`))?.getState()).toBe('completed');
      expect(await run()).toMatchObject({ rechecks: 1, queued: 1 });
      expect(await (await sweepQueue.getJob(`recheck.${lost}.${atMs}`))?.getState()).toBe('waiting');
    });

    it('queues a live subscription whose expiry passed without a check, and acknowledgements and consumes still owed', async () => {
      await db.admin.query(`UPDATE store_purchases SET next_check_at = NULL, acknowledged_at = coalesce(acknowledged_at, now()), consumed_at = coalesce(consumed_at, now())`);
      await db.admin.query(`UPDATE store_purchases SET state = 7 WHERE kind = 1 AND state IN (2, 3, 4) AND expires_at < now()`);
      const user = await newUser();
      const now = Date.now();
      const bare = await stored({ token: `bare-${user}`, store: 2, productRef: product(2, 'sub.premium.1m'), kind: 1, state: 2, callerId: user, expiresAtMs: now - HOUR });
      const purchasedAtMs = now - 3 * HOUR;
      const unacked = await stored({ token: `unacked-${user}`, store: 1, productRef: product(1, 'sub.plus', 'm1'), kind: 1, state: 2, callerId: user, purchasedAtMs });
      const unconsumed = await stored({ token: `unconsumed-${user}`, store: 2, productRef: product(2, 'cons.boost.1'), kind: 2, state: 12, callerId: user, purchasedAtMs });
      const out = await run();
      expect(out).toMatchObject({ outcome: 'swept', rechecks: 1, actions: 2 });
      const expiry = Number((await db.admin.query<{ ms: string }>(`SELECT (extract(epoch FROM expires_at) * 1000)::bigint::text AS ms FROM store_purchases WHERE id = $1`, [bare])).rows[0]!.ms);
      expect(await sweepQueue.getJob(`recheck.${bare}.${expiry}`)).toBeTruthy();
      expect((await sweepQueue.getJob(`ack.${unacked}`))?.data).toMatchObject({ store: 'play', deadlineMs: purchasedAtMs + ACK_DEADLINE_MS });
      expect((await sweepQueue.getJob(`consume.${unconsumed}`))?.data).toMatchObject({ store: 'bazaar', deadlineMs: purchasedAtMs + ACK_DEADLINE_MS });
      // A store without an integration in this process is left for later.
      const bareContext: JobContext = { ...sweep, services: { ...sweep.services, iap: { verifiers: {} } } };
      await redis.del(sweep.services.keys.jobLease('iap-checks'));
      expect(await iapQueue().process(fakeJob('checks', {}), bareContext)).toMatchObject({ rechecks: 0, actions: 0, noIntegration: 3 });
      // One run an hour: a second trigger inside it does nothing.
      expect(await iapQueue().process(fakeJob('checks', {}), sweep)).toMatchObject({ outcome: 'leased_elsewhere' });
    });
  });
});
