import { randomBytes } from 'node:crypto';
import { createPool, type Pool } from '@app/db';
import { createKeys } from '@app/shared/server';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BILLING_SETTINGS_CHECK_MS, BillingSettingsSource } from '../src/iap/core.js';
import { SETTINGS_CHECK_MS } from '../src/deck/settings.js';
import { hasDatabase, migratedDatabase, type TestDatabase } from './db.js';
import { connect, hasRedis } from './support.js';

/**
 * The worker follows a plan or product the admin panel made: once `cfg:v`
 * moved, the next look (at most every few seconds) loads the plans and the
 * catalogue again from the database, once; without a move it keeps what it
 * has and sends no statement.
 */

describe.skipIf(!hasDatabase || !hasRedis)('worker: the catalogue follows the panel', () => {
  let db: TestDatabase;
  let pool: Pool;
  let redis: Redis;
  const prefix = `t${randomBytes(4).toString('hex')}:`;
  const keys = createKeys(prefix);
  const log = pino({ level: 'silent' });

  beforeAll(async () => {
    db = await migratedDatabase();
    pool = createPool({ connectionString: db.url, applicationName: 'worker-catalog-test', max: 2 });
    redis = connect();
  }, 60_000);

  afterAll(async () => {
    const stale = await redis?.keys(`${prefix}*`);
    if (stale?.length) await redis.del(...stale);
    redis?.disconnect();
    await pool?.end();
    await db?.drop();
  });

  it('looks at cfg:v within seconds', () => {
    expect(BILLING_SETTINGS_CHECK_MS).toBeLessThanOrEqual(5_000);
    expect(SETTINGS_CHECK_MS).toBeLessThanOrEqual(5_000);
  });

  it('loads a new plan and its product once cfg:v moved, and only then', async () => {
    const source = new BillingSettingsSource({ pg: pool, redis, keys, log, checkMs: 0 });
    const first = await source.get();
    expect(first.plans.map((p) => p.key)).toEqual(['free', 'plus', 'premium']);
    expect(first.catalog.find(1, 'sub.gold', 'm1')).toBeUndefined();

    await db.admin.query(
      `WITH p AS (INSERT INTO plans (rank, sort, key, names) VALUES (3, 3, 'gold', '{"en": "Gold"}') RETURNING id)
       INSERT INTO plan_features (plan_id, feature, value) SELECT p.id, 'daily_likes', '500' FROM p`,
    );
    await db.admin.query(
      `INSERT INTO store_products (store, kind, plan_id, period, product_id, base_plan_id, is_active)
       SELECT 1, 1, id, 'P1M', 'sub.gold', 'm1', true FROM plans WHERE key = 'gold'`,
    );
    // cfg:v has not moved: the settings stay as they were.
    expect((await source.get()).plans.some((p) => p.key === 'gold')).toBe(false);

    await redis.incr(keys.configVersion());
    const next = await source.get();
    const gold = next.plans.find((p) => p.key === 'gold');
    expect(gold).toMatchObject({ rank: 3, features: { daily_likes: 500 } });
    const row = next.catalog.find(1, 'sub.gold', 'm1');
    expect(row?.planId).toBe(gold?.id);
    expect(next.catalog.listing('play', 'en').plans.map((p) => p.key)).toEqual(['gold']);
    expect(next.catalog.version).not.toBe(first.catalog.version);
    // The same version again: the same settings object, nothing loaded.
    expect(await source.get()).toBe(next);
  });
});
