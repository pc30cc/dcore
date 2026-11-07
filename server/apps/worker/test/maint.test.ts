import { randomBytes } from 'node:crypto';
import { createPool, instrumentPool, statementCounter, type Pool } from '@app/db';
import { FakeRealtimePublisher, IdGenerator, createKeys, createPublicIds, utcDay } from '@app/shared/server';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type JobContext } from '../src/index.js';
import { FakePhotoModerator } from '../src/photos/moderation.js';
import { ACTIVE_BATCH, activeDrainJob, PartitionsDeferredError, partitionsJob, previousDay, sessionsCleanupJob } from '../src/queues/maint.js';
import type { WorkerServices } from '../src/services.js';
import { ensureGroupRoles, hasDatabase, loginRole, migratedDatabase, type TestDatabase } from './db.js';
import { TEST_REDIS_URL, baseEnv, connect, hasRedis } from './support.js';

/**
 * The maintenance jobs on the real migrations, connected as a login role in
 * app_rw and app_maint (the worker's grants), next to one in app_rw only
 * (the API's), which must not be able to run partition maintenance.
 */
describe.skipIf(!hasDatabase || !hasRedis)('maintenance jobs (PostgreSQL, Valkey)', () => {
  let db: TestDatabase;
  let worker: Awaited<ReturnType<typeof loginRole>>;
  let api: Awaited<ReturnType<typeof loginRole>>;
  let pool: Pool;
  let redis: Redis;
  let ids: IdGenerator;
  let context: JobContext;
  const prefix = `t${randomBytes(4).toString('hex')}:`;
  const keys = createKeys(prefix);

  beforeAll(async () => {
    await ensureGroupRoles();
    worker = await loginRole(['app_rw', 'app_maint']);
    api = await loginRole(['app_rw']);
    // The grants of 0009 go to the group roles that exist when it runs.
    db = await migratedDatabase();
    pool = instrumentPool(createPool({ connectionString: db.urlFor(worker.name, worker.password), applicationName: 'maint-test', max: 3 }), statementCounter);
    redis = connect();
    ids = new IdGenerator({ redis, keyPrefix: prefix });
    await ids.start();
    const env = baseEnv();
    const services: WorkerServices = {
      pg: pool,
      cache: redis,
      ids,
      keys,
      publicIds: createPublicIds(env['ID_PUBLIC_KEY']!, env['ID_BILLING_KEY']!),
      realtime: new FakeRealtimePublisher(),
      media: null,
      photoModerator: new FakePhotoModerator({ autoApprove: false }),
    };
    const config = loadConfig({ ...env, DATABASE_URL: db.url, REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix, WORKER_ID: 'maint-test' });
    context = { config, redis, log: pino({ level: 'silent' }), services };
  }, 90_000);

  afterAll(async () => {
    await ids?.stop();
    await pool?.end();
    const left = await redis.keys(`${prefix}*`);
    if (left.length > 0) await redis.del(...left);
    await redis?.quit();
    await db?.drop();
    await worker?.drop();
    await api?.drop();
  });

  async function partitionsOf(parent: string): Promise<string[]> {
    const { rows } = await db.admin.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = $1::regclass ORDER BY 1`,
      [`public.${parent}`],
    );
    return rows.map((r) => r.name);
  }

  it('makes the partitions ahead, drops expired ones one per call, as the worker role only', async () => {
    // An expired weekly partition of likes (60 days old), made the way the maintenance makes them.
    const { rows } = await db.admin.query<{ name: string }>(`SELECT partition_create('likes', now() - interval '60 days') AS name`);
    const expired = rows[0]!.name;
    expect(await partitionsOf('likes')).toContain(expired);

    const { result, tally } = await statementCounter.measure(() => partitionsJob(context));
    expect(result.leased).toBe(true);
    expect(Object.keys(result.parents).sort()).toEqual(['audit_log', 'likes', 'messages']);
    expect(result.parents['likes']!.filter((a) => a.action === 'dropped').map((a) => a.partition)).toEqual([expired]);
    expect(result.parents['messages']!.every((a) => a.action === 'ensure')).toBe(true);
    expect(await partitionsOf('likes')).not.toContain(expired);
    // 1 (registry) + per parent 1 maintain + drops until nothing is due: likes 2, the others 1.
    expect(tally.statements).toBe(1 + 3 + 2 + 1 + 1);

    // Under its lease, a second trigger does nothing.
    expect((await partitionsJob(context)).leased).toBe(false);

    // The API's role cannot start maintenance.
    const apiPool = createPool({ connectionString: db.urlFor(api.name, api.password), applicationName: 'maint-test-api', max: 1 });
    try {
      await expect(apiPool.query(`SELECT * FROM partitions_maintain('likes')`)).rejects.toMatchObject({ code: '42501' });
      await expect(apiPool.query(`SELECT * FROM partition_drop_expired('likes')`)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await apiPool.end();
    }
  });

  it('fails the run for a retry when a reader keeps a drop waiting', async () => {
    await redis.del(keys.jobLease('maint-partitions'));
    const { rows } = await db.admin.query<{ name: string }>(`SELECT partition_create('likes', now() - interval '90 days') AS name`);
    const readers = createPool({ connectionString: db.url, applicationName: 'maint-test-reader', max: 1 });
    const reader = await readers.connect();
    try {
      await reader.query('BEGIN');
      await reader.query('SELECT 1 FROM likes LIMIT 1');
      await expect(partitionsJob(context)).rejects.toBeInstanceOf(PartitionsDeferredError);
      expect(await partitionsOf('likes')).toContain(rows[0]!.name);
    } finally {
      await reader.query('ROLLBACK');
      reader.release();
      await readers.end();
    }
    await redis.del(keys.jobLease('maint-partitions'));
    await partitionsJob(context);
    expect(await partitionsOf('likes')).not.toContain(rows[0]!.name);
  });

  it('drains yesterday\'s active set in batches of 5,000 without emptying it', async () => {
    const people: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = ids.nextId();
      await db.admin.query(`INSERT INTO users (id, status, birth_date, gender, country, onboarding_step) VALUES ($1, 3, DATE '1990-01-01', 1, 'IR', 30)`, [id]);
      people.push(id);
    }
    // One of them was already marked for a later day: it never moves back.
    await db.admin.query(`UPDATE users SET last_active_on = DATE '2099-01-01' WHERE id = $1`, [people[2]]);
    const now = Date.UTC(2026, 10, 7, 0, 30);
    const day = previousDay(now);
    expect(day).toBe('20261106');
    const key = keys.activeDay(day);
    const strangers = Array.from({ length: 2 * ACTIVE_BATCH + 10 }, (_, i) => String(900_000_000_000 + i));
    for (let i = 0; i < strangers.length; i += 1_000) await redis.sadd(key, ...strangers.slice(i, i + 1_000));
    await redis.sadd(key, ...people, 'not-an-id', '0');

    const { result, tally } = await statementCounter.measure(() => activeDrainJob(context, undefined, now));
    expect(result).toMatchObject({ leased: true, day, ids: strangers.length + people.length, written: 2, batches: 3 });
    expect(tally.statements).toBe(3);
    const { rows } = await db.admin.query<{ id: string; day: string }>(
      `SELECT id::text, to_char(last_active_on, 'YYYY-MM-DD') AS day FROM users WHERE id = ANY ($1::bigint[]) ORDER BY id`,
      [people],
    );
    expect(rows.map((r) => r.day)).toEqual(['2026-11-06', '2026-11-06', '2099-01-01']);
    // The set stays for the statistics roll-up.
    expect(await redis.scard(key)).toBe(strangers.length + people.length + 2);
    // The day's lease: a second run does nothing.
    expect((await activeDrainJob(context, day, now)).leased).toBe(false);
    expect(utcDay(now)).toBe('20261107');
  });

  it('deletes sessions revoked or expired more than 30 days ago, in primary-key chunks', async () => {
    const user = ids.nextId();
    await db.admin.query(`INSERT INTO users (id, status, birth_date, gender, country, onboarding_step) VALUES ($1, 3, DATE '1990-01-01', 1, 'IR', 30)`, [user]);
    const session = async (revokedDaysAgo: number | null, expiresInDays: number): Promise<string> => {
      const id = ids.nextId();
      await db.admin.query(
        `INSERT INTO sessions (id, user_id, expires_at, revoked_at, revoke_reason, store, refresh_hash)
         VALUES ($1, $2, now() + make_interval(days => $3), CASE WHEN $4::integer IS NULL THEN NULL ELSE now() - make_interval(days => $4::integer) END,
                 CASE WHEN $4::integer IS NULL THEN NULL ELSE 1 END, 1, $5)`,
        [id, user, expiresInDays, revokedDaysAgo, randomBytes(32)],
      );
      return id;
    };
    const oldRevoked = await session(40, 50);
    const oldExpired = await session(null, -31);
    const recentRevoked = await session(10, 50);
    const recentExpired = await session(null, -5);
    const live = await session(null, 60);

    const { result, tally } = await statementCounter.measure(() => sessionsCleanupJob(context));
    expect(result).toMatchObject({ leased: true, deleted: 2 });
    expect(tally.statements).toBe(result.chunks);
    const { rows } = await db.admin.query<{ id: string }>(`SELECT id::text FROM sessions WHERE user_id = $1 ORDER BY id`, [user]);
    expect(rows.map((r) => r.id).sort()).toEqual([recentRevoked, recentExpired, live].sort());
    expect(rows.map((r) => r.id)).not.toContain(oldRevoked);
    expect(rows.map((r) => r.id)).not.toContain(oldExpired);
    expect((await sessionsCleanupJob(context)).leased).toBe(false);
  });
});
