import { createPool, instrumentPool, statementCounter, type Pool } from '@app/db';
import { exportStartedSchema, exportStatusSchema, idFloor, userChannel, type ExportStatus } from '@app/shared';
import {
  EXPORT_EVERY_SECONDS,
  EXPORT_LINK_MIN_SECONDS,
  EXPORT_PENDING_MAX_SECONDS,
  FakeObjectStorage,
  FakeRealtimePublisher,
  createMediaStore,
  exportReadyValue,
  type ExportData,
  type MediaStore,
} from '@app/shared/server';
import { exportJob, loadConfig as loadWorkerConfig, type JobContext } from '@app/worker';
import { DelayedError, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { LightMyRequestResponse } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportStateOf } from '../src/routes/dataExport.js';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, json, migratedDatabase, seedUser, startHarness, statements, type Harness, type TestDatabase } from './accountSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * The data export: `POST /v1/me/export` (no statement, one export a week,
 * the same answer to the same request sent again, nothing used up when the
 * job cannot be queued, no export without object storage) and
 * `GET /v1/me/export` (no statement: where the week's export is, from the
 * request key and the record the worker's job writes once the archive is
 * stored, with the link only while it is valid).
 */

describe('the state an export reads as', () => {
  const now = Date.parse('2026-11-09T12:00:00.000Z');
  const asked = idFloor(now - 10 * 60_000).toString();

  it('is none without a request, pending until the archive is stored, then ready while its link lasts', () => {
    expect(exportStateOf(null, null, now)).toEqual({ status: 'none' });
    expect(exportStateOf('not-an-id', null, now)).toEqual({ status: 'none' });
    expect(exportStateOf(asked, null, now)).toEqual({ status: 'pending' });
    const ready = exportReadyValue(asked, now + 3_600_000);
    expect(exportStateOf(asked, ready, now)).toEqual({ status: 'ready', exportId: asked, expiresAtMs: now + 3_600_000 });
    // A link about to run out is not handed out; one that ran out reads none (the week stays used).
    expect(exportStateOf(asked, exportReadyValue(asked, now + EXPORT_LINK_MIN_SECONDS * 1_000), now).status).toBe('ready');
    expect(exportStateOf(asked, exportReadyValue(asked, now + EXPORT_LINK_MIN_SECONDS * 1_000 - 1), now)).toEqual({ status: 'none' });
    expect(exportStateOf(asked, exportReadyValue(asked, now - 1), now)).toEqual({ status: 'none' });
  });

  it('counts only the record of the week’s own export, and gives up on one never stored', () => {
    const older = idFloor(now - 8 * 86_400_000).toString();
    expect(exportStateOf(asked, exportReadyValue(older, now + 3_600_000), now)).toEqual({ status: 'pending' });
    expect(exportStateOf(asked, '{"id":"1","exp":"soon"}', now)).toEqual({ status: 'pending' });
    expect(exportStateOf(asked, 'not json', now)).toEqual({ status: 'pending' });
    const failed = idFloor(now - EXPORT_PENDING_MAX_SECONDS * 1_000).toString();
    expect(exportStateOf(failed, null, now)).toEqual({ status: 'none' });
    expect(exportStateOf(idFloor(now - EXPORT_PENDING_MAX_SECONDS * 1_000 + 1_000).toString(), null, now)).toEqual({ status: 'pending' });
  });
});

describe.skipIf(!hasInfrastructure)('the data export request (PostgreSQL, Valkey)', () => {
  let db: TestDatabase;
  let h: Harness;
  let bare: Harness;
  let signing: Harness;
  let workerPool: Pool;
  let workerRedis: Redis;
  let worker: JobContext;
  const jobs = new MemoryJobProducer();
  const storage = new FakeObjectStorage();
  const media: MediaStore = { storage, privateBucket: 'uploads', mediaBucket: 'media', urls: null };
  const realtime = new FakeRealtimePublisher();
  // Signs real S3 links (no request leaves the process): the link's own expiry can be read back.
  const presigning = createMediaStore({
    endpoint: 'https://s3.example.com',
    region: 'auto',
    accessKeyId: 'export-test-key',
    secretAccessKey: 'export-test-secret-0123456789',
    pathStyle: true,
    privateBucket: 'uploads',
    mediaBucket: 'media',
  });

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startHarness(db, {}, { jobs, media, realtime });
    bare = await startHarness(db, {}, { jobs: new MemoryJobProducer(), media: null });
    signing = await startHarness(db, {}, { jobs: new MemoryJobProducer(), media: presigning });
    // The worker's export job in this process, on the same database, Valkey prefix and object store.
    const config = loadWorkerConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: db.url,
      REDIS_URL: h.app.config.redis.url,
      REDIS_KEY_PREFIX: h.prefix,
      ID_PUBLIC_KEY: h.app.config.ids.publicKey,
      ID_BILLING_KEY: h.app.config.ids.billingKey,
      WORKER_ID: 'export-test-worker',
    });
    workerPool = instrumentPool(createPool({ connectionString: db.url, applicationName: 'export-test-worker', max: 2 }), statementCounter);
    workerRedis = new Redis(h.app.config.redis.url, { maxRetriesPerRequest: null });
    worker = {
      config,
      redis: workerRedis,
      log: pino({ level: 'silent' }),
      token: 'test-token',
      services: {
        pg: workerPool,
        cache: workerRedis,
        ids: h.app.ids,
        keys: h.app.keys,
        publicIds: h.app.publicIds,
        realtime,
        media,
        photoModerator: { moderate: async () => ({ decision: 'review' }) } as never,
      },
    };
  }, 90_000);
  afterAll(async () => {
    await workerRedis?.quit();
    await workerPool?.end();
    await signing?.close();
    await bare?.close();
    await h?.close();
    await db?.drop();
  });

  const ask = (harness: Harness, token: string) => call(harness, '/v1/me/export', { method: 'POST', token });
  const look = (harness: Harness, token: string) => call(harness, '/v1/me/export', { token });
  const stateOf = (response: LightMyRequestResponse): ExportStatus => {
    expect(response.statusCode, response.body).toBe(200);
    expect(statements(response)).toBe(0);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const parsed = exportStatusSchema.parse(response.json());
    // Strictly the schema: nothing more in the answer.
    expect(parsed).toEqual(response.json());
    return parsed;
  };

  type FakeJob = Job<ExportData> & { delayedUntil?: number };
  function jobOf(data: ExportData): FakeJob {
    const job = {
      name: 'export',
      data,
      id: `export.${data.exportId}`,
      attemptsMade: 0,
      async updateData(next: ExportData) {
        job.data = next;
      },
      async moveToDelayed(timestamp: number) {
        job.delayedUntil = timestamp;
      },
    } as unknown as FakeJob;
    return job;
  }

  it('queues one export a week, at no statement, and answers a repeat with the same export', async () => {
    const user = await seedUser(h, { name: 'Ava' });
    const first = await ask(h, user.token);
    expect(first.statusCode, first.body).toBe(202);
    expect(statements(first)).toBe(0);
    const { exportId } = exportStartedSchema.parse(first.json());
    const queued = jobs.jobs.filter((j) => j.queue === 'account' && j.name === 'export');
    expect(queued).toEqual([
      { queue: 'account', name: 'export', id: `export.${exportId}`, data: { userId: user.id, exportId }, options: { attempts: 8, backoffMs: 30_000 } },
    ]);
    // The same request again (a retry whose answer was lost, a second tap): the same export, nothing more queued.
    const again = await ask(h, user.token);
    expect(again.statusCode).toBe(202);
    expect(exportStartedSchema.parse(again.json()).exportId).toBe(exportId);
    expect(jobs.jobs.filter((j) => j.name === 'export')).toHaveLength(1);
    // Later in the week: refused with when to come back.
    await h.app.redis.set(h.app.keys.raw('exp', user.id), idFloor(Date.now() - 10 * 60_000).toString(), 'KEEPTTL');
    const later = await ask(h, user.token);
    expect(later.statusCode).toBe(429);
    expect(json(later)['code']).toBe('rate_limited');
    expect(Number(later.headers['retry-after'])).toBeGreaterThan(6 * 86_400);
    // The answer names the export only, never the person.
    for (const body of [first.body, again.body, later.body]) expect(body).not.toContain(user.id);
  });

  it('keeps the week’s export when the job could not be queued, and refuses without object storage', async () => {
    const user = await seedUser(h, { name: 'Ben' });
    jobs.failWith = new Error('valkey down');
    try {
      expect((await ask(h, user.token)).statusCode).toBe(503);
    } finally {
      jobs.failWith = null;
    }
    expect(await h.app.redis.exists(h.app.keys.raw('exp', user.id))).toBe(0);
    expect((await ask(h, user.token)).statusCode).toBe(202);

    const other = await seedUser(bare, { name: 'Cleo' });
    const refused = await ask(bare, other.token);
    expect(refused.statusCode).toBe(503);
    expect(json(refused)['code']).toBe('service_unavailable');
    const unknown = await look(bare, other.token);
    expect(unknown.statusCode).toBe(503);
    expect(json(unknown)['code']).toBe('service_unavailable');
  });

  it('needs a signed-in person', async () => {
    expect((await call(h, '/v1/me/export', { method: 'POST' })).statusCode).toBe(401);
    expect((await call(h, '/v1/me/export')).statusCode).toBe(401);
  });

  it('tells a phone where its export is at no statement: none, pending, then the link the worker stored, until it runs out', async () => {
    const user = await seedUser(h, { name: 'Dara' });
    expect(stateOf(await look(h, user.token))).toEqual({ status: 'none' });

    const { exportId } = exportStartedSchema.parse((await ask(h, user.token)).json());
    expect(stateOf(await look(h, user.token))).toEqual({ status: 'pending' });

    // The worker builds and stores the archive; the state is recorded before the announcement goes out.
    const readyKey = h.app.keys.exportReady(user.id);
    const channel = userChannel(h.app.publicIds.user.encode(user.id));
    const publish = realtime.publish.bind(realtime);
    let recordAtAnnouncement: string | null = null;
    realtime.publish = async (target, envelope) => {
      if (target === channel && envelope.t === 'account') recordAtAnnouncement = await h.redis.get(readyKey);
      return publish(target, envelope);
    };
    const queued = jobs.jobs.find((j) => j.id === `export.${exportId}`)!;
    const job = jobOf(queued.data as ExportData);
    try {
      expect(await exportJob(job, worker).catch((error: unknown) => error)).toBeInstanceOf(DelayedError);
    } finally {
      realtime.publish = publish;
    }
    const expiresAtMs = job.data.stored!.expiresAtMs;
    expect(recordAtAnnouncement).toBe(exportReadyValue(exportId, expiresAtMs));
    expect(await h.redis.ttl(readyKey)).toBeGreaterThan(EXPORT_EVERY_SECONDS - 60);
    const announced = realtime.on(channel).filter((e) => e.t === 'account').at(-1)!.d as { export: { url: string; expiresAt: string } };

    // A phone that was offline at the announcement reads the same link.
    const ready = stateOf(await look(h, user.token));
    expect(ready).toEqual({ status: 'ready', url: announced.export.url, expiresAt: new Date(expiresAtMs).toISOString() });
    expect(ready.url).toContain(`uploads/exports/${exportId}.zip`);
    expect(await storage.getObject('uploads', `exports/${exportId}.zip`)).not.toBeNull();

    // Within its last minute the link is no longer handed out, and once it ran out the export reads none.
    const record = (exp: number) => h.redis.set(readyKey, exportReadyValue(exportId, exp), 'KEEPTTL');
    await record(Date.now() + 30_000);
    expect(stateOf(await look(h, user.token))).toEqual({ status: 'none' });
    await record(Date.now() - 1);
    expect(stateOf(await look(h, user.token))).toEqual({ status: 'none' });
    // The week stays used.
    expect(await h.redis.get(h.app.keys.exportRequest(user.id))).toBe(exportId);

    for (const body of h.bodies) expect(body).not.toContain(user.id);
  });

  it('signs the link for what is left of its day, and only for the week’s own export', async () => {
    const user = await seedUser(signing, { name: 'Elham' });
    const exportId = idFloor(Date.now() - 3_600_000).toString();
    await signing.redis.set(signing.app.keys.exportRequest(user.id), exportId, 'EX', EXPORT_EVERY_SECONDS);
    expect(stateOf(await look(signing, user.token))).toEqual({ status: 'pending' });

    const expiresAtMs = Date.now() + 5 * 3_600_000;
    await signing.redis.set(signing.app.keys.exportReady(user.id), exportReadyValue(exportId, expiresAtMs), 'EX', EXPORT_EVERY_SECONDS);
    const before = Date.now();
    const ready = stateOf(await look(signing, user.token));
    expect(ready.status).toBe('ready');
    expect(ready.expiresAt).toBe(new Date(expiresAtMs).toISOString());
    const url = new URL(ready.url!);
    expect(`${url.origin}${url.pathname}`).toBe(`https://s3.example.com/uploads/exports/${exportId}.zip`);
    // The signature's own window ends with the link (to the second the signature counts in).
    const signedAt = Date.parse(url.searchParams.get('X-Amz-Date')!.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
    const signedUntil = signedAt + Number(url.searchParams.get('X-Amz-Expires')) * 1_000;
    expect(signedUntil).toBeLessThanOrEqual(expiresAtMs + 1_000);
    expect(signedUntil).toBeGreaterThan(expiresAtMs - (Date.now() - before) - 2_000);
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);

    // A record of an earlier export does not make this week's ready.
    const newer = idFloor(Date.now() - 60_000).toString();
    await signing.redis.set(signing.app.keys.exportRequest(user.id), newer, 'KEEPTTL');
    expect(stateOf(await look(signing, user.token))).toEqual({ status: 'pending' });
    // One asked for long ago and never stored (the job failed for good) reads none.
    await signing.redis.set(signing.app.keys.exportRequest(user.id), idFloor(Date.now() - EXPORT_PENDING_MAX_SECONDS * 1_000 - 60_000).toString(), 'KEEPTTL');
    expect(stateOf(await look(signing, user.token))).toEqual({ status: 'none' });
  });
});
