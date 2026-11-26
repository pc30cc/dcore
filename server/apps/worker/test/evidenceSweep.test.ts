import { randomBytes } from 'node:crypto';
import { createPool, instrumentPool, statementCounter, type Pool } from '@app/db';
import { FakeRealtimePublisher, IdGenerator, createKeys, createPublicIds, safetyJobNames } from '@app/shared/server';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type JobContext } from '../src/index.js';
import { FakePhotoModerator } from '../src/photos/moderation.js';
import { EVIDENCE_SWEEP_BATCH, evidenceSweepJob, safetyQueue } from '../src/queues/safety.js';
import type { WorkerServices } from '../src/services.js';
import { ensureGroupRoles, hasDatabase, loginRole, migratedDatabase, type TestDatabase } from './db.js';
import { TEST_REDIS_URL, baseEnv, connect, hasRedis } from './support.js';

/**
 * The daily `evidence-sweep` (queue `safety`) as the application's role
 * runs it: closed reports whose evidence retention is over lose their
 * evidence and the reporter's words, a report a legal hold names keeps them
 * until the hold is released, the report's own record (reason, context,
 * status, resolution) stays, batches go on until the backlog is done, and a
 * second runner holding no lease does nothing.
 */

describe.skipIf(!hasDatabase || !hasRedis)('evidence sweep (PostgreSQL as app_rw, Valkey)', () => {
  let db: TestDatabase;
  let pg: Pool;
  let redis: Redis;
  let ids: IdGenerator;
  let context: JobContext;
  let other: JobContext;
  let role: Awaited<ReturnType<typeof loginRole>>;
  const prefix = `t${randomBytes(4).toString('hex')}:`;
  const keys = createKeys(prefix);
  const env = baseEnv();
  const publicIds = createPublicIds(env['ID_PUBLIC_KEY']!, env['ID_BILLING_KEY']!);

  beforeAll(async () => {
    await ensureGroupRoles();
    role = await loginRole(['app_rw']);
    db = await migratedDatabase();
    pg = instrumentPool(createPool({ connectionString: db.urlFor(role.name, role.password), applicationName: 'evidence-sweep-test', max: 2 }), statementCounter);
    redis = connect();
    ids = new IdGenerator({ redis, keyPrefix: prefix });
    await ids.start();
    const services: WorkerServices = { pg, cache: redis, ids, keys, publicIds, realtime: new FakeRealtimePublisher(), media: null, photoModerator: new FakePhotoModerator({ autoApprove: false }) };
    const config = loadConfig({ ...env, DATABASE_URL: db.url, REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix, WORKER_ID: 'sweep-a' });
    context = { config, redis, log: pino({ level: 'silent' }), services, token: 'test-token' };
    other = { ...context, config: { ...config, workerId: 'sweep-b' } };
  }, 90_000);

  afterAll(async () => {
    await ids?.stop();
    await pg?.end();
    const left = await redis.keys(`${prefix}*`);
    if (left.length > 0) await redis.del(...left);
    await redis?.quit();
    await db?.drop();
    await role?.drop();
  });

  async function person(): Promise<string> {
    const id = ids.nextId();
    await db.admin.query(`INSERT INTO users (id, status, birth_date, gender) VALUES ($1, 3, '1992-03-04', 1)`, [id]);
    return id;
  }

  /** A closed report with evidence whose purge is `dueInDays` from now (negative: past). */
  async function closedReport(target: string, dueInDays: number): Promise<string> {
    const id = ids.nextId();
    await db.admin.query(
      `INSERT INTO reports (id, target_id, context, reason, status, resolution, resolved_at, evidence_at, evidence_purge_at, details, evidence)
       VALUES ($1, $2, 2, 6, 3, 3, now() - interval '400 days', now(), now() + make_interval(days => $3), 'Words of the reporter',
               '{"v": 1, "items": [{"reportId": "1", "atMs": 1, "context": 2, "reason": 6}], "chat": [{"filingId": "1", "takenAtMs": 1, "messages": []}]}')`,
      [id, target, dueInDays],
    );
    return id;
  }

  const report = async (id: string) =>
    (await db.admin.query(`SELECT evidence, details, evidence_purge_at IS NULL AS cleared, status, resolution, reason, context FROM reports WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;

  const freeLease = () => redis.del(keys.jobLease(safetyJobNames.evidenceSweep));

  it('empties due evidence, skips a held report until its hold is released, and keeps the report’s record', async () => {
    const target = await person();
    const due = await closedReport(target, -1);
    const held = await closedReport(target, -2);
    const later = await closedReport(target, 10);
    const hold = ids.nextId();
    // A hold naming the report, kept on another account (the report's own people are not held here).
    await db.admin.query(`INSERT INTO legal_holds (id, user_id, report_id, kind) VALUES ($1, $2, $3, 1)`, [hold, await person(), held]);
    // A held account keeps the evidence of every report on it, whatever report its hold names (here none).
    const heldTarget = await person();
    const onHeldAccount = await closedReport(heldTarget, -3);
    const accountHold = ids.nextId();
    await db.admin.query(`INSERT INTO legal_holds (id, user_id, kind) VALUES ($1, $2, 3)`, [accountHold, heldTarget]);

    expect(await evidenceSweepJob(context)).toEqual({ leased: true, purged: 1 });
    expect(await report(onHeldAccount)).toMatchObject({ details: 'Words of the reporter', cleared: false });
    expect(await report(due)).toEqual({ evidence: {}, details: null, cleared: true, status: 3, resolution: 3, reason: 6, context: 2 });
    expect(await report(held)).toMatchObject({ details: 'Words of the reporter', cleared: false });
    expect(await report(later)).toMatchObject({ details: 'Words of the reporter', cleared: false });

    // Another worker while the lease is held: nothing.
    expect(await evidenceSweepJob(other)).toEqual({ leased: false, purged: 0 });

    // Once the hold is released, the next run empties the held report too.
    await db.admin.query(`UPDATE legal_holds SET released_at = now() WHERE id = $1`, [hold]);
    await freeLease();
    expect(await evidenceSweepJob(context)).toEqual({ leased: true, purged: 1 });
    expect(await report(held)).toMatchObject({ evidence: {}, details: null, cleared: true });
    expect(await report(later)).toMatchObject({ cleared: false });
    expect(await report(onHeldAccount)).toMatchObject({ cleared: false });
    await db.admin.query(`UPDATE legal_holds SET released_at = now() WHERE id = $1`, [accountHold]);
    await freeLease();
    expect(await evidenceSweepJob(context)).toEqual({ leased: true, purged: 1 });
    expect(await report(onHeldAccount)).toMatchObject({ cleared: true });
  });

  it('goes on in batches until the backlog is done, one statement each', async () => {
    const target = await person();
    const values: string[] = [];
    const params: unknown[] = [target];
    for (let i = 0; i < EVIDENCE_SWEEP_BATCH + 3; i += 1) {
      params.push(ids.nextId());
      values.push(`($${params.length}, $1, 1, 2, 4, 11, now() - interval '400 days', now(), now() - interval '1 day', '{"v": 1}')`);
    }
    await db.admin.query(`INSERT INTO reports (id, target_id, context, reason, status, resolution, resolved_at, evidence_at, evidence_purge_at, evidence) VALUES ${values.join(', ')}`, params);
    await freeLease();
    const { result, tally } = await statementCounter.measure(() => evidenceSweepJob(context));
    expect(result).toEqual({ leased: true, purged: EVIDENCE_SWEEP_BATCH + 3 });
    expect(tally.statements).toBe(2);
  });

  it('is scheduled daily in the safety queue and runs by name', async () => {
    const schedule = safetyQueue.schedules?.find((s) => s.name === 'evidence-sweep');
    expect(schedule).toMatchObject({ id: 'evidence-sweep', repeat: { pattern: '23 3 * * *', tz: 'UTC' }, opts: { attempts: 3, backoff: { type: 'exponential', delay: 600_000 } } });
    await freeLease();
    const job = { name: 'evidence-sweep', data: {} } as unknown as Parameters<typeof safetyQueue.process>[0];
    expect(await safetyQueue.process(job, context)).toEqual({ leased: true, purged: 0 });
  });
});
