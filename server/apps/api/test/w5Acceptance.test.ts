import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool, instrumentPool, statementCounter, useWalletItem, type Pool } from '@app/db';
import { deletionPreflightSchema, entitlementsSchema, purchaseResultSchema, restoreResultSchema, storeProductsSchema, userChannel, type Entitlements } from '@app/shared';
import {
  BazaarVerifier,
  FakeGooglePlay,
  FakePardakht,
  FakeRealtimePublisher,
  IdGenerator,
  PardakhtClient,
  PlayStoreVerifier,
  PubSubOidcVerifier,
  RedisBazaarCallMeter,
  bazaarCheckSpread,
  createKeys,
  iapJobIds,
  signBazaarPurchase,
  subscriptionNotificationType,
  tokenHash,
  BAZAAR_RECHECK_DELAY_MS,
  BAZAAR_RENEWAL_GRACE_MS,
} from '@app/shared/server';
import { PlayJobs, billingSettingsOf, iapQueue, loadConfig as loadWorkerConfig, type JobContext } from '@app/worker';
import { Queue, type Job } from 'bullmq';
import type { LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryJobProducer, type RecordedJob } from '../src/services/jobs.js';
import { call, migratedDatabase, row, rows, seedUser, setAppConfig, startHarness, statements, type Harness, type SeededUser, type TestDatabase } from './accountSupport.js';
import { TEST_REDIS_URL, hasInfrastructure } from './support.js';

/**
 * W5 across the tracks: the API and the worker's `iap` queue in one process,
 * on one database and one Valkey prefix, with the real store integrations
 * (the Play Developer API client and the Pub/Sub OIDC check; the pardakht v2
 * client, its call meter and the SHA1withRSA check) against local fakes of
 * Google and Cafe Bazaar. What one track hands another is exercised here:
 * the jobs the API queues are run by the worker's processor (their data
 * passed through JSON, as BullMQ stores it), the worker's writes reach the
 * API's cached entitlements through the version counters, the follow-up
 * jobs the worker queues land in BullMQ with the shared retention, and the
 * brand's subscription links reach restricted sessions.
 *
 * Acceptance criteria (docs: W5): 1 and 2 end to end across both processes,
 * 3 (the statement budgets on these paths), 4 (cross-store off and on,
 * grants in both builds, subscribed in both stores) and 5 (suspended and
 * banned accounts restore, read their entitlements and the manage link).
 */

const PACKAGE = 'com.example.app';
const AUDIENCE = 'https://api.example.test/v1/webhooks/play/rtdn';
const PUSH_EMAIL = 'rtdn-push@example-project.iam.gserviceaccount.com';
const PISHKHAN = 'pishkhan-api-secret-for-w5-0001';
const BAZAAR_SUBSCRIPTIONS = 'https://subscriptions.example.test/bazaar';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type WorkerJob = Job & { delayedUntil?: number };

describe.skipIf(!hasInfrastructure)('W5 across the tracks: the API and the worker, both stores against their fakes', () => {
  let db: TestDatabase;
  let h: Harness;
  let pg: Pool;
  let redis: Redis;
  let ids: IdGenerator;
  let context: JobContext;
  let followUps: Queue;
  let pardakhtServer: { url: string; close(): Promise<void> };
  const prefix = `t${randomBytes(4).toString('hex')}:`;
  const keys = createKeys(prefix);
  const google = new FakeGooglePlay({ packageName: PACKAGE });
  const pardakht = new FakePardakht({ packageName: PACKAGE, pishkhanToken: PISHKHAN });
  const jobs = new MemoryJobProducer();
  const realtime = new FakeRealtimePublisher();
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const otherRsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsaPublicKey = rsa.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const brandsDir = mkdtempSync(join(tmpdir(), 'w5-brands-'));
  const iap = iapQueue();
  // The log lines of the worker and of both Bazaar clients, kept for the privacy check at the end (the API's own are the harness's).
  const workerLogs: string[] = [];
  const workerLog = pino({ level: 'debug' }, { write: (line: string) => void workerLogs.push(line) });
  const storeEnv = {
    PLAY_PACKAGE_NAME: PACKAGE,
    PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: google.account.clientEmail, private_key: google.account.privateKey, private_key_id: google.account.privateKeyId }),
    PLAY_RTDN_AUDIENCE: AUDIENCE,
    PLAY_RTDN_PUSH_SA_EMAIL: PUSH_EMAIL,
    BAZAAR_PACKAGE_NAME: PACKAGE,
    BAZAAR_RSA_PUBLIC_KEY: rsaPublicKey,
    BAZAAR_PISHKHAN_API_TOKEN: PISHKHAN,
  };

  const bazaarVerifier = (meterRedis: Redis, timeoutMs: number) =>
    new BazaarVerifier({
      packageName: PACKAGE,
      rsaPublicKey,
      api: new PardakhtClient({ packageName: PACKAGE, auth: { kind: 'pishkhan', token: PISHKHAN }, baseUrl: pardakhtServer.url, meter: new RedisBazaarCallMeter(meterRedis, keys), timeoutMs }),
      log: workerLog,
    });

  beforeAll(async () => {
    await google.start();
    pardakhtServer = await pardakht.listen();
    // The template brand with a subscription centre for Cafe Bazaar (none is documented by Bazaar; the brand may name one).
    const brand = JSON.parse(readFileSync(new URL('../../../../brands/_template/brand.json', import.meta.url), 'utf8')) as {
      stores: { bazaar: Record<string, unknown> };
    };
    brand.stores.bazaar['subscriptionsUrl'] = BAZAAR_SUBSCRIPTIONS;
    mkdirSync(join(brandsDir, '_template'));
    writeFileSync(join(brandsDir, '_template', 'brand.json'), JSON.stringify(brand));

    db = await migratedDatabase();
    await db.sql.query(
      `UPDATE store_products SET is_active = true
        WHERE (store = 1 AND product_id IN ('sub.plus', 'sub.premium', 'cons.superlike.5'))
           OR (store = 2 AND product_id IN ('sub.plus.1m', 'sub.premium.1m', 'cons.superlike.5'))`,
    );
    await db.sql.query(`UPDATE store_products SET list_price_minor = 150000000, list_currency = 'IRR' WHERE store = 2 AND product_id = 'sub.plus.1m'`);
    redis = new Redis(TEST_REDIS_URL ?? '', { maxRetriesPerRequest: null });
    h = await startHarness(
      db,
      { REDIS_KEY_PREFIX: prefix, BRANDS_DIR: brandsDir, ...storeEnv },
      {
        jobs,
        realtime,
        store: { verifiers: { play: new PlayStoreVerifier({ api: google.api() }), bazaar: bazaarVerifier(redis, 8_000) } },
        playRtdn: { authenticator: new PubSubOidcVerifier({ audience: AUDIENCE, serviceAccountEmail: PUSH_EMAIL, jwksUrl: google.jwksUrl }) },
      },
    );

    // The worker's half: its own pool and id lease, the same database and prefix, and the store integrations its
    // factories build in production, here pointed at the fakes.
    const config = loadWorkerConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: db.url,
      REDIS_URL: TEST_REDIS_URL ?? '',
      REDIS_KEY_PREFIX: prefix,
      WORKER_ID: 'w5-acceptance',
      // The API's brand: the worker's events link the same subscription centres.
      BRANDS_DIR: brandsDir,
      ID_PUBLIC_KEY: randomBytes(32).toString('base64url'),
      ID_BILLING_KEY: randomBytes(32).toString('base64url'),
      ...storeEnv,
    });
    pg = instrumentPool(createPool({ connectionString: db.url, applicationName: 'w5-acceptance-worker', max: 3 }), statementCounter);
    ids = new IdGenerator({ redis, keyPrefix: prefix });
    await ids.start();
    const play = new PlayJobs(new PlayStoreVerifier({ api: google.api() }), PACKAGE).integration();
    context = {
      config,
      redis,
      log: workerLog,
      token: 'w5-acceptance',
      services: {
        pg,
        cache: redis,
        ids,
        keys,
        // The API's: both processes run with the same ID_BILLING_KEY in production.
        publicIds: h.app.publicIds,
        realtime,
        media: null,
        photoModerator: new Proxy({}, { get: () => { throw new Error('the iap jobs moderate no photo'); } }) as JobContext['services']['photoModerator'],
        iap: { verifiers: { play: play.verifier, bazaar: bazaarVerifier(redis, 15_000) }, rtdn: play.rtdn, voided: play.voided },
      },
    };
    followUps = new Queue('iap', { connection: redis, prefix: config.queuePrefix });
    await billingSettingsOf(context.services, redis, workerLog).get();
  }, 120_000);

  afterAll(async () => {
    // No purchase token, Pishkhan token or service-account key id in any log line of either process.
    const tokens = [...google.subscriptions.keys(), ...google.products.keys(), ...pardakht.subscriptions.keys(), ...pardakht.inapp.keys()];
    expect(tokens.length).toBeGreaterThan(8);
    for (const line of [...(h?.logs ?? []), ...workerLogs]) {
      expect(line.includes(PISHKHAN), 'the Pishkhan token in a log line').toBe(false);
      expect(line.includes(google.account.privateKeyId ?? 'no-key-id'), 'the service account key id in a log line').toBe(false);
      for (const t of tokens) expect(line.includes(t), 'a purchase token in a log line').toBe(false);
    }
    await followUps?.close();
    await ids?.stop();
    await pg?.end();
    await h?.close();
    await redis?.quit();
    await db?.drop();
    await pardakhtServer?.close();
    await google.stop();
    rmSync(brandsDir, { recursive: true, force: true });
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────

  const billingRef = (u: SeededUser) => h.app.publicIds.billing.encode(u.id);
  const client = (store: 1 | 2) => (store === 1 ? 'play/120' : 'bazaar/120');

  async function person(store: 1 | 2, name: string): Promise<SeededUser> {
    return seedUser(h, { store, name });
  }

  /** A session of the same person in a build (store) and scope of its own. */
  async function session(u: SeededUser, store: 1 | 2, scope: 'full' | 'restricted' = 'full'): Promise<string> {
    const { token } = await h.app.tokens.issue({ kind: 'app', subject: u.publicUid, sessionId: h.app.ids.nextId(), deviceId: u.deviceId, storeCode: store, scope });
    return token;
  }

  async function entitlementsOf(token: string, store: 1 | 2): Promise<{ response: LightMyRequestResponse; body: Entitlements }> {
    const response = await call(h, '/v1/me/entitlements', { token, client: client(store) });
    expect(response.statusCode, response.body).toBe(200);
    return { response, body: entitlementsSchema.parse(response.json()) };
  }

  const buyPlay = (token: string, productId: string, purchaseToken: string, kind: 'subscription' | 'consumable' = 'subscription') =>
    call(h, '/v1/store/play/purchases', { method: 'POST', token, client: 'play/120', body: { productId, purchaseToken, kind } });

  function bazaarBody(u: SeededUser, purchaseToken: string, productId: string, kind: 'subscription' | 'consumable', key = rsa.privateKey) {
    const signed = signBazaarPurchase(key, { purchaseToken, developerPayload: billingRef(u), packageName: PACKAGE, purchaseTime: Date.now() - 30_000, productId });
    return { productId, purchaseToken, kind, ...signed };
  }

  const buyBazaar = (token: string, body: unknown) => call(h, '/v1/store/bazaar/purchases', { method: 'POST', token, client: 'bazaar/120', body });

  /** Rows a purchase path writes: every store row, event and ledger line. */
  const written = async () =>
    Number(
      (
        await row<{ n: string }>(
          db,
          `SELECT (SELECT count(*) FROM store_purchases) + (SELECT count(*) FROM store_events) + (SELECT count(*) FROM wallet_ledger) + (SELECT count(*) FROM subscriptions) AS n`,
        )
      ).n,
    );

  /** The job the API queued (and forgets it, so a later one of the same id is seen). */
  function queued(name: string, id: string): RecordedJob {
    const index = jobs.jobs.findIndex((j) => j.queue === 'iap' && j.name === name && j.id === id);
    expect(index, `iap/${name}/${id} queued; queued: ${jobs.jobs.map((j) => j.id).join(', ')}`).toBeGreaterThanOrEqual(0);
    const [job] = jobs.jobs.splice(index, 1);
    return job!;
  }

  /** Runs one job through the worker's `iap` processor, as BullMQ hands it over (data through JSON), counting statements. */
  async function work(name: string, id: string, data: unknown): Promise<{ outcome: Record<string, unknown>; statements: number; texts: string[] }> {
    const job = {
      name,
      id,
      data: JSON.parse(JSON.stringify(data)) as Record<string, unknown>,
      opts: {},
      timestamp: Date.now(),
      attemptsMade: 0,
      async moveToDelayed(at: number) {
        job.delayedUntil = at;
      },
      async updateData(next: Record<string, unknown>) {
        job.data = next;
      },
    } as unknown as WorkerJob;
    const { result, tally } = await statementCounter.measure(() => iap.process(job, context));
    return { outcome: result, statements: tally.statements, texts: tally.texts };
  }

  const run = (job: RecordedJob) => work(job.name, job.id, job.data);

  /** A job the worker queued in BullMQ, with the shared retention. */
  async function followUp(id: string): Promise<Job> {
    const job = await followUps.getJob(id);
    expect(job, `the worker queued ${id}`).toBeTruthy();
    expect(job!.opts.removeOnComplete).toEqual({ age: 3_600, count: 10_000 });
    expect(job!.opts.removeOnFail).toEqual({ age: 604_800, count: 50_000 });
    return job!;
  }

  const pushBody = (data: string, messageId: string) => ({
    message: { data, messageId, message_id: messageId, publishTime: new Date().toISOString(), attributes: {} },
    subscription: 'projects/example/subscriptions/rtdn',
  });
  const subscriptionNotification = (token: string, type: number) =>
    FakeGooglePlay.data({ version: '1.0', packageName: PACKAGE, eventTimeMillis: String(Date.now()), subscriptionNotification: { version: '1.0', notificationType: type, purchaseToken: token } });
  async function rtdn(data: string, messageId: string): Promise<LightMyRequestResponse> {
    const authorization = `Bearer ${await google.pushToken({ audience: AUDIENCE, email: PUSH_EMAIL })}`;
    return h.app.inject({ method: 'POST', url: '/v1/webhooks/play/rtdn', headers: { 'content-type': 'application/json', authorization }, payload: JSON.stringify(pushBody(data, messageId)) });
  }

  const entitlementEvents = (u: SeededUser) => realtime.on(userChannel(u.publicUid)).filter((e) => e.t === 'entitlement');

  // ─── Criterion 1 (Play) and 3, across the API and the worker ──────────────

  it('Google Play: a purchase, its acknowledgement by the worker, a renewal notification, a restore and a refund (revoked)', async () => {
    const u = await person(1, 'Pia');
    const token = `w5-play-sub-${u.id}`;
    const firstExpiry = Date.now() + 30 * DAY;
    google.putSubscription(token, { productId: 'sub.plus', basePlanId: 'm1', expiryTimeMs: firstExpiry, accountRef: billingRef(u), orderId: 'GPA.3311-2222-3333-44444' });

    // The purchase: one Developer API call, one statement; the acknowledgement is queued for the worker.
    const bought = await buyPlay(u.token, 'sub.plus', token);
    expect(bought.statusCode, bought.body).toBe(200);
    expect(statements(bought)).toBe(1);
    expect(google.apiCalls()).toBe(1);
    const purchase = purchaseResultSchema.parse(bought.json()).purchase;
    expect(purchase).toMatchObject({ state: 'active', productId: 'sub.plus', expiresAt: new Date(firstExpiry).toISOString() });

    // The worker acknowledges it at Google, once; a second run asks Google nothing.
    const ack = queued('ack', iapJobIds.ack(purchase.id));
    expect(Number(ack.data['deadlineMs']) - Date.now()).toBeLessThanOrEqual(60 * HOUR);
    expect((await run(ack)).outcome).toMatchObject({ outcome: 'done' });
    expect(google.count('subscriptions.acknowledge')).toBe(1);
    expect((await row<{ acknowledged_at: Date | null }>(db, 'SELECT acknowledged_at FROM store_purchases WHERE id = $1', [purchase.id])).acknowledged_at).not.toBeNull();
    expect((await run(ack)).outcome).toMatchObject({ outcome: 'already' });
    expect(google.count('subscriptions.acknowledge')).toBe(1);

    // Warm entitlements: no statement.
    await entitlementsOf(u.token, 1);
    const warm = await entitlementsOf(u.token, 1);
    expect(statements(warm.response)).toBe(0);
    const etag = String(warm.response.headers['etag']);

    // Google renews: the notification is queued with no statement, a duplicate makes nothing.
    const renewedExpiry = firstExpiry + 30 * DAY;
    google.putSubscription(token, { productId: 'sub.plus', basePlanId: 'm1', expiryTimeMs: renewedExpiry, accountRef: billingRef(u), orderId: 'GPA.3311-2222-3333-44444..0', acknowledged: true });
    const messageId = `${Date.now()}1`;
    const pushed = await rtdn(subscriptionNotification(token, subscriptionNotificationType.RENEWED), messageId);
    expect(pushed.statusCode).toBe(204);
    expect(statements(pushed)).toBe(0);
    const again = await rtdn(subscriptionNotification(token, subscriptionNotificationType.RENEWED), messageId);
    expect(again.statusCode).toBe(204);
    expect(jobs.jobs.filter((j) => j.name === 'rtdn')).toHaveLength(1);
    const before = await written();
    const events = entitlementEvents(u).length;

    // The worker reads Google and writes the renewal in one statement (the purchase core's), the app hears it, and the
    // API serves the new state at once: the worker stored the view under the new version, so the read costs no
    // statement and carries a new ETag.
    const renewal = await run(queued('rtdn', iapJobIds.rtdn(messageId)));
    expect(renewal.statements).toBe(1);
    expect(renewal.texts.join('\n')).toMatch(/store_purchase_apply/);
    expect(await written()).toBe(before + 1);
    expect(entitlementEvents(u).length).toBe(events + 1);
    expect(entitlementsSchema.parse(entitlementEvents(u).at(-1)!.d)).toMatchObject({ plan: 'plus', planExpiresAt: new Date(renewedExpiry).toISOString() });
    // The worker's event links Play's centre for the product and the brand's Play build, as the API's read does.
    expect(entitlementEvents(u).at(-1)!.d).toMatchObject({
      store: 'play',
      manageUrl: `https://play.google.com/store/account/subscriptions?sku=sub.plus&package=${PACKAGE}`,
      productId: 'sub.plus',
      basePlanId: 'm1',
    });
    const fresh = await entitlementsOf(u.token, 1);
    expect(statements(fresh.response)).toBe(0);
    expect(fresh.response.headers['etag']).not.toBe(etag);
    expect(fresh.body).toMatchObject({ plan: 'plus', source: 'play', planExpiresAt: new Date(renewedExpiry).toISOString() });

    // The same state notified again (another message id): read, nothing written.
    const unchangedId = `${Date.now()}2`;
    expect((await rtdn(subscriptionNotification(token, subscriptionNotificationType.RENEWED), unchangedId)).statusCode).toBe(204);
    const unchanged = await run(queued('rtdn', iapJobIds.rtdn(unchangedId)));
    expect(await written()).toBe(before + 1);
    expect(unchanged.outcome).toMatchObject({ outcome: 'handled' });

    // A restore of the token the worker renewed: its record answers, no statement, no write, no Google call.
    await entitlementsOf(u.token, 1);
    const calls = google.apiCalls();
    const restore = await call(h, '/v1/store/restore', { method: 'POST', token: u.token, client: 'play/120', body: { purchases: [{ productId: 'sub.plus', purchaseToken: token, kind: 'subscription' }] } });
    expect(restore.statusCode).toBe(200);
    expect(statements(restore)).toBe(0);
    expect(restoreResultSchema.parse(restore.json()).results).toEqual([{ purchaseToken: token, state: 'active', fresh: false }]);
    expect(google.apiCalls()).toBe(calls);
    expect(await written()).toBe(before + 1);

    // Refunded and revoked in Play Console: Google shows EXPIRED, the REVOKED notification takes access away.
    google.putSubscription(token, { state: 'SUBSCRIPTION_STATE_EXPIRED', productId: 'sub.plus', basePlanId: 'm1', expiryTimeMs: Date.now() - 1_000, accountRef: billingRef(u), orderId: 'GPA.3311-2222-3333-44444..0', acknowledged: true, autoRenew: false });
    const revokedId = `${Date.now()}3`;
    expect((await rtdn(subscriptionNotification(token, subscriptionNotificationType.REVOKED), revokedId)).statusCode).toBe(204);
    await run(queued('rtdn', iapJobIds.rtdn(revokedId)));
    expect((await row<{ state: number }>(db, 'SELECT state FROM store_purchases WHERE id = $1', [purchase.id])).state).toBe(8);
    expect((await entitlementsOf(u.token, 1)).body).toMatchObject({ plan: 'free' });
    expect(entitlementEvents(u).at(-1)!.d).toMatchObject({ plan: 'free' });
  });

  it('Google Play: a billingRef that is not the caller\'s is refused; one of no account is revoked and refunded at Google by the worker', async () => {
    const owner = await person(1, 'Ola');
    const caller = await person(1, 'Cem');
    const theirs = `w5-play-theirs-${owner.id}`;
    google.putSubscription(theirs, { productId: 'sub.plus', basePlanId: 'm1', expiryTimeMs: Date.now() + 20 * DAY, accountRef: billingRef(owner) });
    const refused = await buyPlay(caller.token, 'sub.plus', theirs);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'purchase_other_account' });
    expect((await entitlementsOf(caller.token, 1)).body.plan).toBe('free');
    expect((await entitlementsOf(owner.token, 1)).body.plan).toBe('plus');

    const forged = `w5-play-nobody-${caller.id}`;
    google.putSubscription(forged, { productId: 'sub.plus', basePlanId: 'm1', expiryTimeMs: Date.now() + 20 * DAY, accountRef: 'zzzzzzzzzzzzzzzzzzzz' });
    const before = await written();
    const nobody = await buyPlay(caller.token, 'sub.plus', forged);
    expect(nobody.statusCode).toBe(422);
    expect(await written()).toBe(before);
    const revokes = google.count('subscriptionsv2.revoke');
    const revoke = await run(queued('revoke', iapJobIds.revoke('play', tokenHash(forged))));
    expect(revoke.outcome).toMatchObject({ outcome: 'done' });
    expect(revoke.statements).toBe(0);
    expect(google.count('subscriptionsv2.revoke')).toBe(revokes + 1);
    expect((await entitlementsOf(caller.token, 1)).body.plan).toBe('free');
  });

  // ─── Criterion 2 (Bazaar) and 3, across the API and the worker ────────────

  it('Cafe Bazaar: a subscription renewed and then ended by the worker\'s re-checks; nothing badly signed reaches Bazaar', async () => {
    const u = await person(2, 'Sara');
    const token = `w5-bz-sub-${u.id}`;
    const validUntil = Date.now() + 30 * DAY;
    pardakht.putSubscription(token, { sku: 'sub.plus.1m', validUntilMs: validUntil, account: `acct-${u.id}` });
    const calls = pardakht.count();

    // A receipt signed with another key: refused before any Bazaar call, nothing written.
    const before = await written();
    const forged = await buyBazaar(u.token, bazaarBody(u, token, 'sub.plus.1m', 'subscription', otherRsa.privateKey));
    expect(forged.statusCode).toBe(422);
    expect(statements(forged)).toBe(0);
    expect(pardakht.count()).toBe(calls);
    expect(await written()).toBe(before);

    // The purchase: exactly one Bazaar call, one statement, an estimated amount from the list price of the moment.
    const bought = await buyBazaar(u.token, bazaarBody(u, token, 'sub.plus.1m', 'subscription'));
    expect(bought.statusCode, bought.body).toBe(200);
    expect(statements(bought)).toBe(1);
    expect(pardakht.count()).toBe(calls + 1);
    const purchase = purchaseResultSchema.parse(bought.json()).purchase;
    const event = await row<{ amount_micros: string; amount_estimated: boolean; currency: string }>(
      db,
      `SELECT amount_micros::text, amount_estimated, currency FROM store_events WHERE purchase_id = $1 AND event = 1`,
      [purchase.id],
    );
    expect(event).toEqual({ amount_micros: String(150_000_000 * 10_000), amount_estimated: true, currency: 'IRR' });

    // Bazaar charges the next period; the worker's re-check at validUntil + 1 h (+ the token's spread) extends it: one
    // write (the purchase core's statement) after one read of the stored purchase, and the next check queued in BullMQ.
    const recheck = queued('recheck', iapJobIds.recheck(purchase.id, validUntil + BAZAAR_RECHECK_DELAY_MS + bazaarCheckSpread(token)));
    queued('refund-check', iapJobIds.refundCheck(purchase.id));
    const renewedUntil = validUntil + 30 * DAY;
    pardakht.renew(token, renewedUntil);
    const events = entitlementEvents(u).length;
    // Bazaar is down at the first try: the job goes back to waiting (no attempt spent), nothing is written, and the
    // worker's warning names no token.
    pardakht.forced.push({ status: 503, body: {} });
    const unchanged = await written();
    const logged = workerLogs.length;
    await expect(run(recheck)).rejects.toThrow();
    expect(await written()).toBe(unchanged);
    expect(workerLogs.slice(logged).join('\n')).toMatch(/re-check failed; trying again/);
    const renewal = await run(recheck);
    expect(renewal.outcome).toMatchObject({ changed: true });
    expect(renewal.statements).toBe(2);
    expect(renewal.texts.filter((t) => t.includes('store_purchase_apply'))).toHaveLength(1);
    // The purchase, the try Bazaar failed, the re-check: one call each.
    expect(pardakht.count()).toBe(calls + 3);
    const next = await followUp(iapJobIds.recheck(purchase.id, renewedUntil + BAZAAR_RECHECK_DELAY_MS + bazaarCheckSpread(token)));
    expect(next.delay).toBeGreaterThan(29 * DAY);
    expect(entitlementEvents(u).length).toBe(events + 1);
    // The worker's event links the brand's Bazaar page, as the API's read does.
    expect(entitlementEvents(u).at(-1)!.d).toMatchObject({ store: 'bazaar', plan: 'plus', manageUrl: BAZAAR_SUBSCRIPTIONS, productId: 'sub.plus.1m' });
    const renewed = await entitlementsOf(u.token, 2);
    expect(renewed.body).toMatchObject({ plan: 'plus', source: 'bazaar', planExpiresAt: new Date(renewedUntil + BAZAAR_RENEWAL_GRACE_MS).toISOString() });
    // The renewal's event carries the list price of that moment too, estimated.
    const recorded = async () =>
      rows<{ event: number; amount_micros: string; amount_estimated: boolean }>(
        db,
        `SELECT event, amount_micros::text, amount_estimated FROM store_events WHERE purchase_id = $1 AND event IN (1, 2) ORDER BY event`,
        [purchase.id],
      );
    const priced = [
      { event: 1, amount_micros: String(150_000_000 * 10_000), amount_estimated: true },
      { event: 2, amount_micros: String(150_000_000 * 10_000), amount_estimated: true },
    ];
    expect(await recorded()).toEqual(priced);
    // A later price edit in the panel changes nothing recorded (revenue reports never read today's catalogue).
    await db.sql.query(`UPDATE store_products SET list_price_minor = 990000000 WHERE store = 2 AND product_id = 'sub.plus.1m'`);
    await setAppConfig(h, 'billing.cross_store_entitlements', false);
    expect(await recorded()).toEqual(priced);

    // Not renewed: the period ends, the next check expires the subscription.
    const s = pardakht.subscriptions.get(token)!;
    s.autoRenewing = false;
    s.validUntilMs = Date.now() - 60_000;
    const ended = await work(next.name, next.id!, next.data);
    expect(ended.outcome).toMatchObject({ changed: true });
    expect((await entitlementsOf(u.token, 2)).body.plan).toBe('free');
    expect(Number((await row<{ n: string }>(db, 'SELECT count(*)::text AS n FROM subscriptions WHERE user_id = $1', [u.id])).n)).toBe(0);
  });

  it('Cafe Bazaar: a consumable credited once, consumed by the worker (already_consumed counts), refunded and reversed once, never below zero', async () => {
    const u = await person(2, 'Nima');
    const token = `w5-bz-cons-${u.id}`;
    pardakht.putInapp(token, { productId: 'cons.superlike.5', developerPayload: billingRef(u) });
    const bought = await buyBazaar(u.token, bazaarBody(u, token, 'cons.superlike.5', 'consumable'));
    expect(bought.statusCode, bought.body).toBe(200);
    const purchase = purchaseResultSchema.parse(bought.json()).purchase;
    expect(purchaseResultSchema.parse(bought.json()).entitlements.wallet.superlike).toBe(5);

    // The worker consumes it at Bazaar; Bazaar already consumed it the second time: done all the same.
    const consume = queued('consume', iapJobIds.consume(purchase.id));
    expect((await run(consume)).outcome).toMatchObject({ outcome: 'done' });
    expect(pardakht.count('consume')).toBe(1);
    expect((await row<{ state: number }>(db, 'SELECT state FROM store_purchases WHERE id = $1', [purchase.id])).state).toBe(10);
    await db.sql.query('UPDATE store_purchases SET consumed_at = NULL WHERE id = $1', [purchase.id]);
    expect((await run(consume)).outcome).toMatchObject({ outcome: 'already' });

    // Three of the five are spent; then Bazaar refunds the purchase (purchaseState 1): the day-7 check takes back what is
    // left (2), never below zero, once.
    for (let i = 0; i < 3; i += 1) {
      expect(await useWalletItem(db.sql, { userId: u.id, item: 1, store: 2, crossStore: false, ledgerId: h.app.ids.nextId(), refId: h.app.ids.nextId() })).not.toBeNull();
    }
    pardakht.refund(token);
    const refundCheck = queued('refund-check', iapJobIds.refundCheck(purchase.id));
    await run(refundCheck);
    expect((await row<{ state: number }>(db, 'SELECT state FROM store_purchases WHERE id = $1', [purchase.id])).state).toBe(8);
    const balance = async () => Number((await row<{ b: string }>(db, `SELECT coalesce(sum(balance), 0)::text AS b FROM wallet_balances WHERE user_id = $1 AND item = 1`, [u.id])).b);
    expect(await balance()).toBe(0);
    const reversals = async () => Number((await row<{ n: string }>(db, `SELECT count(*)::text AS n FROM wallet_ledger WHERE user_id = $1 AND delta < -1`, [u.id])).n);
    expect(await reversals()).toBe(1);
    const once = await written();
    await run(refundCheck);
    expect(await written()).toBe(once);
    expect(await balance()).toBe(0);
    expect(await reversals()).toBe(1);
    expect((await entitlementsOf(u.token, 2)).body.wallet.superlike).toBe(0);
  });

  // ─── Criterion 4: cross-store off and on, grants, both stores ─────────────

  it('cross-store off: a store\'s subscription and wallet count only in its build; on: in both; grants count in both builds either way', async () => {
    const u = await person(1, 'Ava');
    const bazaarSession = await session(u, 2);
    const token = `w5-cross-play-${u.id}`;
    google.putSubscription(token, { productId: 'sub.premium', basePlanId: 'm1', expiryTimeMs: Date.now() + 30 * DAY, accountRef: billingRef(u) });
    expect((await buyPlay(u.token, 'sub.premium', token)).statusCode).toBe(200);
    const pack = `w5-cross-pack-${u.id}`;
    google.putProduct(pack, { productId: 'cons.superlike.5', accountRef: billingRef(u) });
    expect((await buyPlay(u.token, 'cons.superlike.5', pack, 'consumable')).statusCode).toBe(200);

    // Off (as seeded): premium and five super likes in the Play build, nothing of it in the Bazaar build; the gate agrees.
    expect((await entitlementsOf(u.token, 1)).body).toMatchObject({ plan: 'premium', source: 'play', wallet: { superlike: 5 } });
    expect((await entitlementsOf(bazaarSession, 2)).body).toMatchObject({ plan: 'free', wallet: { superlike: 0 } });
    const incognito = (t: string, store: 1 | 2, on = true) => call(h, '/v1/me/settings', { method: 'PATCH', token: t, client: client(store), body: { incognito: on } });
    const refused = await incognito(bazaarSession, 2);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'entitlement_required', feature: 'incognito' });
    expect((await incognito(u.token, 1)).statusCode).toBe(200);
    expect((await incognito(u.token, 1, false)).statusCode).toBe(200);

    // On: the cached views built under the old setting are not served; both builds see the Play subscription and wallet.
    await setAppConfig(h, 'billing.cross_store_entitlements', true);
    try {
      expect((await entitlementsOf(bazaarSession, 2)).body).toMatchObject({ plan: 'premium', source: 'play', wallet: { superlike: 5 } });
      expect((await incognito(bazaarSession, 2)).statusCode).toBe(200);
    } finally {
      await setAppConfig(h, 'billing.cross_store_entitlements', false);
    }
    expect((await entitlementsOf(bazaarSession, 2)).body).toMatchObject({ plan: 'free', wallet: { superlike: 0 } });

    // Subscribed in both stores: premium in both builds, one subscriptions row per store.
    const bz = `w5-cross-bz-${u.id}`;
    pardakht.putSubscription(bz, { sku: 'sub.premium.1m', validUntilMs: Date.now() + 30 * DAY, account: `acct-${u.id}` });
    expect((await buyBazaar(bazaarSession, bazaarBody(u, bz, 'sub.premium.1m', 'subscription'))).statusCode).toBe(200);
    expect((await entitlementsOf(bazaarSession, 2)).body).toMatchObject({ plan: 'premium', source: 'bazaar' });
    expect((await entitlementsOf(u.token, 1)).body).toMatchObject({ plan: 'premium', source: 'play' });
    expect((await row<{ stores: number[] }>(db, 'SELECT array_agg(store ORDER BY store)::int[] AS stores FROM subscriptions WHERE user_id = $1', [u.id])).stores).toEqual([1, 2]);

    // A grant (store 0) from the panel, applied by the worker's sub-end job at its start: both builds, flag off. The
    // build the person used lately hears it.
    const g = await person(2, 'Gil');
    const gPlay = await session(g, 1);
    await entitlementsOf(g.token, 2);
    const plus = (await row<{ id: number }>(db, `SELECT id FROM plans WHERE key = 'plus'`)).id;
    const grantId = h.app.ids.nextId();
    await db.sql.query(
      `INSERT INTO entitlement_grants (id, user_id, starts_at, ends_at, plan_id, reason) VALUES ($1, $2, now() - interval '1 minute', now() + interval '7 days', $3, 'w5')`,
      [grantId, g.id, plus],
    );
    const start = await work('sub-end', iapJobIds.subEnd(g.id, 0, Date.now()), { userId: g.id, store: 0, atMs: Date.now() });
    expect(start.outcome).toMatchObject({ outcome: 'changed', published: true, store: 'bazaar' });
    expect((await entitlementsOf(g.token, 2)).body).toMatchObject({ plan: 'plus', source: 'grant' });
    expect((await entitlementsOf(gPlay, 1)).body).toMatchObject({ plan: 'plus', source: 'grant' });
    expect(entitlementEvents(g).at(-1)!.d).toMatchObject({ plan: 'plus', source: 'grant' });
    // At its end the same job takes it away in both builds.
    await db.sql.query(`UPDATE entitlement_grants SET starts_at = now() - interval '8 days', ends_at = now() - interval '1 second' WHERE id = $1`, [grantId]);
    const end = await work('sub-end', iapJobIds.subEnd(g.id, 0, Date.now()), { userId: g.id, store: 0, atMs: Date.now() });
    expect(end.outcome).toMatchObject({ outcome: 'changed' });
    expect((await entitlementsOf(g.token, 2)).body.plan).toBe('free');
    expect((await entitlementsOf(gPlay, 1)).body.plan).toBe('free');
  });

  // ─── Criterion 5: suspended and banned accounts ───────────────────────────

  it('a suspended Play subscriber and a banned Bazaar subscriber restore, read their entitlements and the manage link, and buy', async () => {
    // Suspended, Play: bought while active.
    const p = await person(1, 'Rua');
    const playToken = `w5-suspended-${p.id}`;
    google.putSubscription(playToken, { productId: 'sub.plus', basePlanId: 'm3', expiryTimeMs: Date.now() + 90 * DAY, accountRef: billingRef(p), acknowledged: true });
    expect((await buyPlay(p.token, 'sub.plus', playToken)).statusCode).toBe(200);
    await db.sql.query('UPDATE users SET status = 5 WHERE id = $1', [p.id]);
    const suspended = await session(p, 1, 'restricted');
    const playView = await entitlementsOf(suspended, 1);
    expect(playView.body).toMatchObject({ plan: 'plus', source: 'play' });
    expect(playView.body.manageUrl).toBe(`https://play.google.com/store/account/subscriptions?sku=sub.plus&package=${PACKAGE}`);
    const playRestore = await call(h, '/v1/store/restore', { method: 'POST', token: suspended, client: 'play/120', body: { purchases: [{ productId: 'sub.plus', purchaseToken: playToken, kind: 'subscription' }] } });
    expect(playRestore.statusCode).toBe(200);
    expect(statements(playRestore)).toBe(0);
    expect(restoreResultSchema.parse(playRestore.json()).results).toEqual([{ purchaseToken: playToken, state: 'active', fresh: false }]);
    const playPreflight = await call(h, '/v1/me/deletion/preflight', { token: suspended, client: 'play/120' });
    expect(playPreflight.statusCode).toBe(200);
    expect(deletionPreflightSchema.parse(playPreflight.json())).toEqual({ subscription: { store: 'play', active: true, manageUrl: playView.body.manageUrl } });
    expect(storeProductsSchema.parse((await call(h, '/v1/store/products', { token: suspended, client: 'play/120' })).json()).store).toBe('play');
    // A new purchase is still accepted (a paid period is never cut silently); the social routes stay closed.
    const later = `w5-suspended-pack-${p.id}`;
    google.putProduct(later, { productId: 'cons.superlike.5', accountRef: billingRef(p) });
    expect((await buyPlay(suspended, 'cons.superlike.5', later, 'consumable')).statusCode).toBe(200);
    const boost = await call(h, '/v1/boosts', { method: 'POST', token: suspended, client: 'play/120', body: { kind: 'boost' } });
    expect(boost.statusCode).toBe(403);

    // Banned, Bazaar: restores a subscription the server never saw (one Bazaar call), then reads the brand's link.
    const b = await person(2, 'Bahar');
    await db.sql.query('UPDATE users SET status = 6 WHERE id = $1', [b.id]);
    const banned = await session(b, 2, 'restricted');
    const bzToken = `w5-banned-${b.id}`;
    pardakht.putSubscription(bzToken, { sku: 'sub.plus.1m', validUntilMs: Date.now() + 20 * DAY, account: `acct-${b.id}` });
    const calls = pardakht.count();
    const restored = await call(h, '/v1/store/restore', { method: 'POST', token: banned, client: 'bazaar/120', body: { purchases: [bazaarBody(b, bzToken, 'sub.plus.1m', 'subscription')] } });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restoreResultSchema.parse(restored.json())).toMatchObject({ results: [{ purchaseToken: bzToken, state: 'active', fresh: true }], entitlements: { plan: 'plus', source: 'bazaar', manageUrl: BAZAAR_SUBSCRIPTIONS, productId: 'sub.plus.1m' } });
    expect(pardakht.count()).toBe(calls + 1);
    const bzView = await entitlementsOf(banned, 2);
    expect(bzView.body).toMatchObject({ plan: 'plus', source: 'bazaar', manageUrl: BAZAAR_SUBSCRIPTIONS });
    const again = await call(h, '/v1/store/restore', { method: 'POST', token: banned, client: 'bazaar/120', body: { purchases: [bazaarBody(b, bzToken, 'sub.plus.1m', 'subscription')] } });
    expect(statements(again)).toBe(0);
    expect(pardakht.count()).toBe(calls + 1);
    const bzPreflight = await call(h, '/v1/me/deletion/preflight', { token: banned, client: 'bazaar/120' });
    expect(deletionPreflightSchema.parse(bzPreflight.json())).toEqual({ subscription: { store: 'bazaar', active: true, manageUrl: BAZAAR_SUBSCRIPTIONS } });
    const social = await call(h, '/v1/boosts', { method: 'POST', token: banned, client: 'bazaar/120', body: { kind: 'boost' } });
    expect(social.statusCode).toBe(403);
  });
});
