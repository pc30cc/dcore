import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createPool, instrumentPool, statementCounter, type Pool } from '@app/db';
import { storeEventSource } from '@app/shared';
import {
  BAZAAR_RECHECK_DELAY_MS,
  BAZAAR_RENEWAL_GRACE_MS,
  BazaarVerifier,
  FakePardakht,
  FakePushSender,
  FakeRealtimePublisher,
  IdGenerator,
  PardakhtClient,
  RedisBazaarCallMeter,
  bazaarCheckSpread,
  createKeys,
  createPublicIds,
  signBazaarPurchase,
  tokenHash,
} from '@app/shared/server';
import { DelayedError, Queue, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { billingSettingsOf, iapQueue, loadConfig, purchaseCoreOf, type JobContext } from '../src/index.js';
import { iapServicesFrom } from '../src/iap/verifiers.js';
import { FakePhotoModerator } from '../src/photos/moderation.js';
import type { WorkerServices } from '../src/services.js';
import { closeSocialQueues } from '../src/social/jobs.js';
import { ensureGroupRoles, hasDatabase, loginRole, migratedDatabase, type TestDatabase } from './db.js';
import { TEST_REDIS_URL, baseEnv, connect, hasRedis } from './support.js';

/**
 * The `iap` jobs of Cafe Bazaar with the real integration (pardakht v2
 * client, call meter on Valkey, SHA1withRSA) against a local server that
 * answers as Bazaar documents, on a real database as the application role:
 * a purchase verified and applied queues its re-check at validUntil + 1 h
 * (plus the token's spread) and its refund check; the re-check extends a
 * renewed subscription in one transaction and queues the next one, or ends
 * it; the refund check reverses a refunded credit once and never below zero;
 * a consume Bazaar answers `already_consumed` counts as done; a check held
 * back by the pace or an outage waits without a write or an attempt spent.
 */

const PACKAGE = 'app.example.bazaar';
const SECRET = 'pishkhan-worker-test-token-0001';
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

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = rsa.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

describe('the Bazaar integration of the worker', () => {
  it('is built from BAZAAR_* (and only then), and a key that is not an RSA key stops the process naming the variable', () => {
    const env = { ...baseEnv(), REDIS_URL: 'redis://127.0.0.1:1/0' };
    const redis = { status: 'wait' } as unknown as Redis;
    const deps = { redis, keys: createKeys('t:') };
    const log = pino({ level: 'silent' });
    expect(iapServicesFrom(loadConfig(env), log, deps).verifiers.bazaar).toBeUndefined();
    const on = loadConfig({ ...env, BAZAAR_PACKAGE_NAME: PACKAGE, BAZAAR_RSA_PUBLIC_KEY: publicKey, BAZAAR_PISHKHAN_API_TOKEN: SECRET });
    expect(iapServicesFrom(on, log, deps).verifiers.bazaar).toBeInstanceOf(BazaarVerifier);
    const broken = loadConfig({ ...env, BAZAAR_PACKAGE_NAME: PACKAGE, BAZAAR_RSA_PUBLIC_KEY: Buffer.alloc(120, 7).toString('base64'), BAZAAR_PISHKHAN_API_TOKEN: SECRET });
    expect(() => iapServicesFrom(broken, log, deps)).toThrow(/^BAZAAR_RSA_PUBLIC_KEY: /);
    try {
      iapServicesFrom(broken, log, deps);
    } catch (error) {
      expect((error as Error).message).not.toContain(SECRET);
    }
  });
});

describe.skipIf(!hasDatabase || !hasRedis)('the iap queue with Cafe Bazaar (PostgreSQL, Valkey, a fake developer API)', () => {
  let db: TestDatabase;
  let pg: Pool;
  let redis: Redis;
  let ids: IdGenerator;
  let context: JobContext;
  let queue: Queue;
  let server: { url: string; close(): Promise<void> };
  let verifier: BazaarVerifier;
  let role: Awaited<ReturnType<typeof loginRole>>;
  let clock = Date.now();
  const fake = new FakePardakht({ packageName: PACKAGE, pishkhanToken: SECRET, now: () => clock });
  const realtime = new FakeRealtimePublisher();
  const prefix = `t${randomBytes(4).toString('hex')}:`;
  const keys = createKeys(prefix);
  const env = baseEnv();
  const publicIds = createPublicIds(env['ID_PUBLIC_KEY']!, env['ID_BILLING_KEY']!);

  function client(meter: RedisBazaarCallMeter): PardakhtClient {
    return new PardakhtClient({ packageName: PACKAGE, auth: { kind: 'pishkhan', token: SECRET }, baseUrl: server.url, meter, now: () => clock });
  }

  beforeAll(async () => {
    await ensureGroupRoles();
    role = await loginRole(['app_rw']);
    db = await migratedDatabase();
    pg = instrumentPool(createPool({ connectionString: db.urlFor(role.name, role.password), applicationName: 'iap-bazaar-test', max: 4 }), statementCounter);
    redis = connect();
    ids = new IdGenerator({ redis, keyPrefix: prefix });
    await ids.start();
    server = await fake.listen();
    verifier = new BazaarVerifier({ packageName: PACKAGE, rsaPublicKey: publicKey, api: client(new RedisBazaarCallMeter(redis, keys, {}, () => clock)), now: () => clock });
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
      iap: { verifiers: { bazaar: verifier } },
    };
    const config = loadConfig({ ...env, DATABASE_URL: db.url, REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix, WORKER_ID: 'iap-bazaar-test' });
    context = { config, redis, log: pino({ level: 'silent' }), services, token: 'test-token' };
    queue = new Queue('iap', { connection: redis, prefix: config.queuePrefix });
    await db.admin.query(`UPDATE store_products SET is_active = true WHERE store = 2 AND product_id IN ('sub.plus.1m', 'cons.superlike.5')`);
  }, 90_000);

  afterAll(async () => {
    await queue?.close();
    if (redis) await closeSocialQueues(redis);
    await ids?.stop();
    const left = await redis?.keys(`${prefix}*`);
    if (left?.length) await redis.del(...left);
    await redis?.quit();
    await pg?.end();
    await server?.close();
    await db?.drop();
    await role?.drop();
  });

  beforeEach(() => {
    clock = Date.now();
    fake.requests.length = 0;
    fake.forced.length = 0;
  });

  async function newUser(): Promise<string> {
    const { rows } = await db.admin.query<{ id: string }>(
      `INSERT INTO users (id, birth_date, status, gender, onboarding_step, country) VALUES (id_next(), '1994-01-01', 3, 2, 30, 'IR') RETURNING id::text`,
    );
    return rows[0]!.id;
  }

  /** What the API does with a purchase the app posted: the verifier's one call, then the purchase core. */
  async function purchase(user: string, token: string, productId: string, kind: 'subscription' | 'consumable'): Promise<string> {
    const signed = signBazaarPurchase(rsa.privateKey, { purchaseToken: token, developerPayload: publicIds.billing.encode(user), packageName: PACKAGE, purchaseTime: clock - 60_000, productId });
    const verified = await verifier.verify({ store: 'bazaar', productId, purchaseToken: token, kind, ...signed });
    const settings = await billingSettingsOf(context.services, redis, context.log).get();
    const applied = await purchaseCoreOf(context, settings).apply(verified, { store: 'bazaar', token, callerId: user, source: storeEventSource.code('app') });
    if (applied.outcome !== 'applied') throw new Error(`not applied: ${applied.outcome}`);
    return applied.purchaseId;
  }

  async function queued(id: string): Promise<Job | undefined> {
    return (await queue.getJob(id)) ?? undefined;
  }

  it('re-checks at validUntil + 1 h: a renewal is one transaction and queues the next check; no renewal ends it', async () => {
    const user = await newUser();
    const token = `bz-w-sub-${user}`;
    const validUntil = clock + 30 * DAY;
    fake.putSubscription(token, { sku: 'sub.plus.1m', validUntilMs: validUntil, account: `acct-${user}` });
    const purchaseId = await purchase(user, token, 'sub.plus.1m', 'subscription');
    expect(fake.count()).toBe(1);
    const at = validUntil + BAZAAR_RECHECK_DELAY_MS + bazaarCheckSpread(token);
    const job = await queued(`recheck.${purchaseId}.${at}`);
    expect(job?.data).toEqual({ purchaseId, store: 'bazaar', atMs: at });
    expect(job!.timestamp + job!.opts.delay!).toBeGreaterThanOrEqual(at - 5_000);
    expect(await queued(`refund-check.${purchaseId}`)).toBeDefined();

    // Bazaar charged the next month; the check runs at its time.
    clock = at;
    fake.renew(token, validUntil + 30 * DAY);
    fake.requests.length = 0;
    await billingSettingsOf(context.services, redis, context.log).get();
    const tally = await statementCounter.measure(() => iapQueue().process(fakeJob('recheck', job!.data as Record<string, unknown>), context));
    expect(tally.result).toMatchObject({ outcome: 'applied', changed: true });
    // The purchase read and the core's one statement.
    expect(tally.tally.statements).toBe(2);
    expect(fake.requests.map((r) => r.operation)).toEqual(['subscription']);
    const sub = await db.admin.query<{ ms: string }>(`SELECT (extract(epoch FROM expires_at) * 1000)::bigint::text AS ms FROM subscriptions WHERE user_id = $1 AND store = 2`, [user]);
    expect(Number(sub.rows[0]!.ms)).toBe(validUntil + 30 * DAY + BAZAAR_RENEWAL_GRACE_MS);
    const next = validUntil + 30 * DAY + BAZAAR_RECHECK_DELAY_MS + bazaarCheckSpread(token);
    expect(await queued(`recheck.${purchaseId}.${next}`)).toBeDefined();
    const renewal = await db.admin.query<{ event: number; estimated: boolean | null }>(`SELECT event, amount_estimated AS estimated FROM store_events WHERE purchase_id = $1 ORDER BY id`, [purchaseId]);
    expect(renewal.rows.map((r) => r.event)).toEqual([1, 2]);

    // The same check run again: Bazaar is asked, nothing changes, nothing is written.
    const repeat = await statementCounter.measure(() => iapQueue().process(fakeJob('recheck', job!.data as Record<string, unknown>), context));
    expect(repeat.result).toMatchObject({ outcome: 'unchanged' });

    // Not renewed at the next end: expired at once, nothing queued after it.
    clock = next;
    const ended = await iapQueue().process(fakeJob('recheck', { purchaseId, store: 'bazaar', atMs: next }), context);
    expect(ended).toMatchObject({ outcome: 'applied', changed: true });
    expect((await db.admin.query(`SELECT 1 FROM subscriptions WHERE user_id = $1 AND store = 2`, [user])).rowCount).toBe(0);
    const state = await db.admin.query<{ state: number; next: string | null }>(`SELECT state, next_check_at::text AS next FROM store_purchases WHERE id = $1`, [purchaseId]);
    expect(state.rows[0]).toEqual({ state: 7, next: null });
  });

  it('the refund check reverses a refunded one-time product once, never below zero; consume counts already_consumed as done', async () => {
    const user = await newUser();
    const token = `bz-w-cons-${user}`;
    fake.putInapp(token, { productId: 'cons.superlike.5', developerPayload: publicIds.billing.encode(user), account: `acct-${user}` });
    const purchaseId = await purchase(user, token, 'cons.superlike.5', 'consumable');
    const consume = await queued(`consume.${purchaseId}`);
    expect(consume).toBeDefined();
    expect(await queued(`refund-check.${purchaseId}`)).toBeDefined();
    // The app consumed it first: Bazaar answers already_consumed, which is done.
    fake.inapp.get(token)!.consumed = true;
    fake.requests.length = 0;
    expect(await iapQueue().process(fakeJob('consume', consume!.data as Record<string, unknown>), context)).toMatchObject({ outcome: 'already' });
    expect(fake.requests.map((r) => r.operation)).toEqual(['consume']);
    const consumed = await db.admin.query<{ state: number }>(`SELECT state FROM store_purchases WHERE id = $1`, [purchaseId]);
    expect(consumed.rows[0]!.state).toBe(10);
    // Recorded: a second run asks Bazaar nothing.
    expect(await iapQueue().process(fakeJob('consume', consume!.data as Record<string, unknown>), context)).toMatchObject({ outcome: 'already' });
    expect(fake.count()).toBe(1);

    // Three of the five were spent; then Bazaar refunded the purchase.
    await db.admin.query(`UPDATE wallet_balances SET balance = 2 WHERE user_id = $1 AND item = 1 AND store = 2`, [user]);
    fake.refund(token);
    const first = await iapQueue().process(fakeJob('refund-check', { purchaseId, store: 'bazaar' }), context);
    expect(first).toMatchObject({ outcome: 'applied', changed: true, state: 8 });
    // A revoked purchase is the server's own end: a second check asks Bazaar nothing.
    const calls = fake.count();
    const second = await iapQueue().process(fakeJob('refund-check', { purchaseId, store: 'bazaar' }), context);
    expect(second).toMatchObject({ outcome: 'final', state: 8 });
    expect(fake.count()).toBe(calls);
    const { rows } = await db.admin.query<{ balance: number; reversals: string; debited: number }>(
      `SELECT (SELECT balance FROM wallet_balances WHERE user_id = $1 AND item = 1 AND store = 2) AS balance,
              (SELECT count(*) FROM wallet_ledger WHERE ref_id = $2 AND reason = 3)::text AS reversals,
              (SELECT -delta FROM wallet_ledger WHERE ref_id = $2 AND reason = 3) AS debited`,
      [user, purchaseId],
    );
    expect(rows[0]).toEqual({ balance: 0, reversals: '1', debited: 2 });
  });

  it('a check held back by the pace or an outage waits: no write, no attempt spent', async () => {
    const user = await newUser();
    const token = `bz-w-wait-${user}`;
    fake.putSubscription(token, { sku: 'sub.plus.1m', validUntilMs: clock + 30 * DAY, account: `acct-${user}` });
    const purchaseId = await purchase(user, token, 'sub.plus.1m', 'subscription');
    const before = await db.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM store_events WHERE purchase_id = $1`, [purchaseId]);
    // A pace of zero background calls a minute: the job waits and Bazaar is not asked.
    const paced = new BazaarVerifier({ packageName: PACKAGE, rsaPublicKey: publicKey, api: client(new RedisBazaarCallMeter(redis, keys, { perMinute: 0 }, () => clock)), now: () => clock });
    const held: JobContext = { ...context, services: { ...context.services, iap: { verifiers: { bazaar: paced } } } };
    fake.requests.length = 0;
    const job = fakeJob('recheck', { purchaseId, store: 'bazaar', atMs: clock });
    await expect(iapQueue().process(job, held)).rejects.toBeInstanceOf(DelayedError);
    expect(job.delayedUntil).toBeGreaterThan(Date.now());
    expect(fake.count()).toBe(0);
    // Bazaar answering 503: one call, the job waits.
    fake.forced.push({ status: 503, body: {} });
    const down = fakeJob('recheck', { purchaseId, store: 'bazaar', atMs: clock });
    await expect(iapQueue().process(down, context)).rejects.toBeInstanceOf(DelayedError);
    expect(fake.count()).toBe(1);
    expect((down.data as { tries?: number }).tries).toBe(1);
    const after = await db.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM store_events WHERE purchase_id = $1`, [purchaseId]);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('revokes a one-time product by refunding it at Bazaar, once', async () => {
    const token = `bz-w-revoke-${randomBytes(4).toString('hex')}`;
    fake.putInapp(token, { productId: 'cons.superlike.5' });
    const data = { store: 'bazaar', kind: 'consumable', productId: 'cons.superlike.5', token, tokenHash: tokenHash(token) };
    expect(await iapQueue().process(fakeJob('revoke', data), context)).toMatchObject({ outcome: 'done' });
    expect(fake.inapp.get(token)?.refunded).toBe(true);
    expect(await iapQueue().process(fakeJob('revoke', data), context)).toMatchObject({ outcome: 'already' });
  });
});
