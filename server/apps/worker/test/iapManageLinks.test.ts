import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyStorePurchase, createPool, type Pool } from '@app/db';
import { brandSchema, userChannel, type Brand, type Entitlements } from '@app/shared';
import { FakePushSender, FakeRealtimePublisher, FakeStoreVerifier, IdGenerator, PLAY_SUBSCRIPTIONS_URL, createKeys, createPublicIds, tokenHash } from '@app/shared/server';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brandOf, iapQueue, loadConfig, subEndJob, type JobContext } from '../src/index.js';
import { FakePhotoModerator } from '../src/photos/moderation.js';
import type { WorkerServices } from '../src/services.js';
import { ensureGroupRoles, hasDatabase, loginRole, migratedDatabase, type TestDatabase } from './db.js';
import { TEST_REDIS_URL, baseEnv, connect, hasRedis } from './support.js';

/**
 * The subscription links of the worker's `entitlement` events follow the
 * brand, by the same rule as the API's `GET /v1/me/entitlements`: a Cafe
 * Bazaar subscription links the brand's Bazaar page, a Google Play one the
 * Play centre with the product and the brand's Play application id (not
 * PLAY_PACKAGE_NAME). The worker reads BRAND / BRANDS_DIR as the API does.
 */

const DAY = 86_400_000;
const TEMPLATE = new URL('../../../../brands/_template/brand.json', import.meta.url);
const BAZAAR_PAGE = 'https://subscriptions.example.test/bazaar';
const PLAY_APP_ID = 'com.example.brandplay';

function brandWithLinks(): Brand {
  const raw = JSON.parse(readFileSync(TEMPLATE, 'utf8')) as Record<string, unknown> & {
    android: { applicationId: Record<string, string> };
    stores: { bazaar: Record<string, unknown> };
  };
  raw.android.applicationId['play'] = PLAY_APP_ID;
  raw.stores.bazaar['subscriptionsUrl'] = BAZAAR_PAGE;
  return brandSchema.parse(raw);
}

type FakeJob = Job & { delayedUntil?: number };

function fakeJob(name: string, data: Record<string, unknown>): FakeJob {
  return { name, data, id: `${name}.test`, timestamp: Date.now(), opts: {}, attemptsMade: 0 } as unknown as FakeJob;
}

/** A configuration that is never connected anywhere. */
const unitEnv = (): Record<string, string> => ({ ...baseEnv(), REDIS_URL: 'redis://127.0.0.1:1/0' });

describe('the worker reads the brand as the API does', () => {
  it('takes BRAND and BRANDS_DIR, defaults to the template, and refuses the template in production', () => {
    const env = unitEnv();
    expect(loadConfig(env).brand).toEqual({ id: '_template', dir: undefined });
    expect(loadConfig({ ...env, BRAND: 'acme', BRANDS_DIR: '/srv/brands' }).brand).toEqual({ id: 'acme', dir: '/srv/brands' });
    expect(() => loadConfig({ ...env, BRAND: '../etc' })).toThrow(/BRAND/);
    const production = { ...env, NODE_ENV: 'production', CENTRIFUGO_API_URL: 'http://centrifugo:9000', CENTRIFUGO_API_KEY: 'x'.repeat(32) };
    expect(() => loadConfig(production)).toThrow(/BRAND: the template brand is not served in production/);
  });

  it('loads the brand of BRANDS_DIR once when the services carry none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-brands-'));
    try {
      mkdirSync(join(dir, '_template'));
      writeFileSync(join(dir, '_template', 'brand.json'), JSON.stringify(brandWithLinks()));
      const config = loadConfig({ ...unitEnv(), BRANDS_DIR: dir });
      const services = {} as WorkerServices;
      const first = brandOf({ services, config });
      expect(first.stores?.bazaar?.subscriptionsUrl).toBe(BAZAAR_PAGE);
      rmSync(join(dir, '_template'), { recursive: true });
      // Read once: the file is gone, the brand stays.
      expect(brandOf({ services, config })).toBe(first);
      const loaded = brandWithLinks();
      expect(brandOf({ services: { brand: loaded } as WorkerServices, config })).toBe(loaded);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasDatabase || !hasRedis)('the manage link of the worker’s entitlement events (PostgreSQL, Valkey)', () => {
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
    pg = createPool({ connectionString: db.urlFor(role.name, role.password), applicationName: 'iap-manage-links-test', max: 3 });
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
      brand: brandWithLinks(),
    };
    // No PLAY_PACKAGE_NAME: the Play link's package comes from the brand.
    const config = loadConfig({ ...env, DATABASE_URL: db.url, REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix, WORKER_ID: 'iap-manage-links-test' });
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

  /** A granting subscription the server holds, as a purchase left it. */
  async function subscription(user: string, store: 1 | 2, token: string, productId: string, basePlanId: string | null): Promise<string> {
    const now = Date.now();
    const out = await applyStorePurchase(pg, {
      id: ids.nextId(),
      eventId: ids.nextId(),
      linkedEventId: ids.nextId(),
      ledgerId: ids.nextId(),
      store,
      tokenHash: tokenHash(token),
      token,
      linkedTokenHash: null,
      callerId: user,
      accountUserId: null,
      productRef: products.get(`${store}:${productId}:${basePlanId ?? ''}`)!,
      kind: 1,
      state: 2,
      purchasedAtMs: now - DAY,
      expiresAtMs: now + 2 * DAY,
      autoRenew: true,
      quantity: 1,
      isTest: true,
      region: null,
      orderId: null,
      acknowledged: true,
      consumed: false,
      eventMs: now - DAY,
      nextCheckAtMs: null,
      source: 1,
      amountMicros: null,
      currency: null,
    });
    if (out.outcome !== 'applied') throw new Error(`not applied: ${out.outcome}`);
    return out.purchaseId;
  }

  const lastEvent = (user: string): (Entitlements & { store?: string }) | undefined =>
    realtime.on(userChannel(publicIds.user.encode(user))).filter((e) => e.t === 'entitlement').at(-1)?.d as (Entitlements & { store?: string }) | undefined;

  it('a Bazaar renewal the worker finds is announced with the brand’s Bazaar link', async () => {
    const user = await newUser();
    const token = `bazaar-renewal-${user}`;
    const purchaseId = await subscription(user, 2, token, 'sub.plus.1m', null);
    bazaar.put(token, { kind: 'subscription', productId: 'sub.plus.1m', expiresAtMs: Date.now() + 32 * DAY, eventMs: Date.now() });
    expect(await iapQueue().process(fakeJob('recheck', { purchaseId, store: 'bazaar', atMs: Date.now() }), context)).toMatchObject({ outcome: 'applied', changed: true });
    const event = lastEvent(user);
    expect(event).toMatchObject({ store: 'bazaar', plan: 'plus', source: 'bazaar', manageUrl: BAZAAR_PAGE, productId: 'sub.plus.1m' });
    expect(event).not.toHaveProperty('basePlanId');
  });

  it('a Play renewal the worker finds is announced with Play’s centre for the product and the brand’s Play build', async () => {
    const user = await newUser();
    const token = `play-renewal-${user}`;
    const purchaseId = await subscription(user, 1, token, 'sub.plus', 'm1');
    play.put(token, { kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1', expiresAtMs: Date.now() + 32 * DAY, eventMs: Date.now(), acknowledged: true });
    expect(await iapQueue().process(fakeJob('recheck', { purchaseId, store: 'play', atMs: Date.now() }), context)).toMatchObject({ outcome: 'applied', changed: true });
    const event = lastEvent(user);
    expect(event).toMatchObject({ store: 'play', plan: 'plus', source: 'play', productId: 'sub.plus', basePlanId: 'm1' });
    expect(event?.manageUrl).toBe(`${PLAY_SUBSCRIPTIONS_URL}?sku=sub.plus&package=${PLAY_APP_ID}`);
  });

  it('a subscription end job announces what still counts with its store’s link too', async () => {
    const user = await newUser();
    await subscription(user, 2, `bazaar-end-${user}`, 'sub.premium.1m', null);
    // The computed row taken away by hand: the job's recompute writes it again from the purchase, a change it announces.
    await db.admin.query(`DELETE FROM subscriptions WHERE user_id = $1`, [user]);
    const out = await subEndJob(fakeJob('sub-end', { userId: user, store: 2, atMs: Date.now() }), context);
    expect(out).toMatchObject({ outcome: 'changed', published: true, store: 'bazaar' });
    expect(lastEvent(user)).toMatchObject({ store: 'bazaar', plan: 'premium', manageUrl: BAZAAR_PAGE, productId: 'sub.premium.1m' });
  });
});
