import {
  adminDeadLetterPageSchema,
  adminJobGroupResultSchema,
  adminSystemHealthSchema,
  adminSystemPartitionsSchema,
  adminSystemQueuesSchema,
  adminSystemStreamsSchema,
  adminTaskRunResultSchema,
  composeId,
  problemSchemaFor,
  PUBLIC_UID_PATTERN,
} from '@app/shared';
import { manualRunId, queuePrefix } from '@app/shared/server';
import { Job, Queue } from 'bullmq';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migratedDatabase, seedUser, statements, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, lastAudit, startAdminHarness, type AdminHarness, type AdminSession } from './adminSupport.js';
import { hasInfrastructure } from './support.js';
import { deadLetter, failJobs, failedKey, waitUntil } from './systemSupport.js';

/**
 * The jobs and health page (`/v1/admin/system/*`): its reads cost Valkey and
 * at most one statement and name no person; its writes take the hourly
 * count, write their audit row, act after the commit, and write nothing when
 * they find nothing to do. Failed stream entries show no person, no
 * conversation and no public id (finding 8).
 */

describe.skipIf(!hasInfrastructure)('admin: jobs and health', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  let owner: AdminSession;
  const queues: Queue[] = [];

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startAdminHarness(db);
    owner = await adminAs(h, 'superadmin');
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled(queues.map((q) => q.close()));
    await h?.close();
    await db?.drop();
  });

  const get = (url: string, session: { accessToken: string } = owner) => admin(h, url, undefined, { token: session.accessToken });
  const post = (url: string, body: unknown, session: { accessToken: string } = owner) => admin(h, url, body, { token: session.accessToken });
  const queue = (name: string) => {
    const q = new Queue(name, { connection: h.redis, prefix: queuePrefix(h.prefix) });
    queues.push(q);
    return q;
  };
  const appId = (agoMs: number) => composeId({ ms: Date.now() - agoMs, generator: 7, sequence: 1 }).toString();
  const fieldError = (res: LightMyRequestResponse) => res.json<{ errors?: { pointer: string; code: string }[] }>().errors?.[0];

  it('reports the database, Valkey, the job pipeline beat and the live processes', async () => {
    const now = Date.now();
    await h.redis.set(h.app.keys.workerHeartbeat(), JSON.stringify({ at: new Date(now - 10_000).toISOString(), workerId: 'w-1' }));
    const report = (atMs: number, proc: Record<string, unknown>) => JSON.stringify({ atMs, hash: 'h', kinds: {}, proc });
    await h.redis.hset(h.app.keys.providersApplied(), {
      'worker:w-1': report(now - 5_000, { kind: 'worker', startedAtMs: now - 600_000, cfgVersion: 3, queues: ['photo', 'maint'], streams: ['like', 'match', 'msg'], maint: true }),
      'worker:w-gone': report(now - 120_000, { kind: 'worker', startedAtMs: now - 900_000, cfgVersion: 1, queues: [], streams: [], maint: false }),
      'api:other-host': report(now - 3_000, { kind: 'api', startedAtMs: now - 60_000, cfgVersion: 2, rolesVersion: 2, rolesFailing: true }),
    });
    await waitUntil(async () => (await h.redis.hexists(h.app.keys.providersApplied(), h.app.providers.processName)) === 1);
    const res = await get('/v1/admin/system/health');
    expect(res.statusCode, res.body).toBe(200);
    expect(statements(res)).toBeLessThanOrEqual(1);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = adminSystemHealthSchema.parse(res.json());
    expect(body.database.status).toBe('up');
    expect(body.valkey[0]).toMatchObject({ name: 'core', status: 'up', sharedWithCore: false });
    expect(body.valkey[0]!.usedBytes).toBeGreaterThan(0);
    expect(body.valkey[1]).toMatchObject({ name: 'cache', status: 'up', sharedWithCore: true });
    expect(body.heartbeat).toEqual({ at: new Date(now - 10_000).toISOString(), worker: 'w-1' });
    expect(body.workers.map((w) => w.name)).toEqual(['w-1']);
    expect(body.workers[0]).toMatchObject({ cfgVersion: 3, queues: ['photo', 'maint'], maint: true });
    const self = body.apis.find((a) => a.self)!;
    expect(self.name).toBe(h.app.providers.processName.slice('api:'.length));
    expect(self.cfgVersion).toBe(h.app.cfg.peek()?.version);
    expect(body.apis.find((a) => a.name === 'other-host')).toMatchObject({ self: false, rolesFailing: true, cfgVersion: 2 });
    expect(body.config.loaded).toBe(h.app.cfg.peek()?.version);
  });

  it('counts the queues, groups failed jobs by name and lists the scheduled tasks with their last runs', async () => {
    await failJobs(h, 'photo', 'process', ['process.101', 'process.102']);
    await failJobs(h, 'push', 'send', ['send.message.103']);
    await queue('maint').upsertJobScheduler('partitions', { pattern: '17 3 * * *', tz: 'UTC' }, { name: 'partitions', data: {} });
    const lastRun = { atMs: Date.now() - 3_600_000, ok: false, ms: 120, attempt: 2, attempts: 8, willRetry: true, error: 'PartitionsDeferredError', manual: false, summary: { leased: true } };
    await h.redis.hset(h.app.keys.opsRuns(), 'maint/partitions', JSON.stringify(lastRun));
    await h.redis.hset(h.app.keys.opsRunsOk(), 'maint/partitions', String(Date.now() - 86_400_000));
    const res = await get('/v1/admin/system/queues');
    expect(res.statusCode, res.body).toBe(200);
    expect(statements(res)).toBe(0);
    const body = adminSystemQueuesSchema.parse(res.json());
    const photo = body.queues.find((q) => q.name === 'photo')!;
    expect(photo.counts.failed).toBe(2);
    expect(photo.failed.groups).toEqual([expect.objectContaining({ name: 'process', count: 2, retryable: true })]);
    expect(body.queues.find((q) => q.name === 'push')!.failed.groups).toEqual([expect.objectContaining({ name: 'send', count: 1, retryable: false })]);
    expect(body.queues.map((q) => q.name)).toContain('stats');
    const partitions = body.tasks.find((t) => t.queue === 'maint' && t.name === 'partitions')!;
    expect(partitions).toMatchObject({ pattern: '17 3 * * *', tz: 'UTC', runnable: true, last: { ok: false, willRetry: true, error: 'PartitionsDeferredError', attempt: 2, attempts: 8, durationMs: 120 } });
    expect(partitions.nextAt).not.toBeNull();
    expect(partitions.lastOkAt).not.toBeNull();
    // A task started by hand is listed even without its scheduler here.
    expect(body.tasks.find((t) => t.queue === 'stats' && t.name === 'rollup')).toMatchObject({ runnable: true, last: null, every: null });
    // No job id or failure message on the wire.
    expect(res.body).not.toMatch(/process\.10|send\.message|the test fails it/);
  });

  it('reads the write-behind streams: pending, lag, missing group, watermark', async () => {
    const like = `${h.prefix}wb:like`;
    await h.redis.xgroup('CREATE', like, 'pg', '0', 'MKSTREAM');
    await h.redis.xadd(like, '*', 'k', '1');
    await h.redis.xadd(like, '*', 'k', '1');
    await h.redis.xreadgroup('GROUP', 'pg', 'c1', 'COUNT', 1, 'STREAMS', like, '>');
    await h.redis.set(`${h.prefix}wb:like:wm`, appId(60_000));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const res = await get('/v1/admin/system/streams');
    expect(res.statusCode, res.body).toBe(200);
    expect(statements(res)).toBe(0);
    const streams = adminSystemStreamsSchema.parse(res.json()).streams;
    const likes = streams.find((s) => s.name === 'like')!;
    expect(likes).toMatchObject({ length: 2, pending: 1, group: true, consumers: 1, undelivered: 1 });
    expect(likes.lagMs).toBeGreaterThan(0);
    expect(likes.watermarkLagMs).toBeGreaterThan(50_000);
    expect(streams.find((s) => s.name === 'match')).toMatchObject({ group: false, lagMs: null, watermarkLagMs: null });
  });

  it('pages failed entries without any person, conversation or public id', async () => {
    const sender = await seedUser(h, { name: 'Dead Sender' });
    const other = await seedUser(h, { name: 'Dead Other' });
    const match = appId(30_000);
    for (let i = 0; i < 3; i += 1) {
      await deadLetter(h, 'msg', { id: `${Date.now() - 1_000}-${i}`, reason: i === 0 ? 'malformed' : 'rejected', fields: { id: appId(1_000 + i), m: match, s: sender.id, k: '1', b: '[redacted]' } });
    }
    await deadLetter(h, 'like', { id: `${Date.now() - 2_000}-0`, fields: { id: appId(2_000), a: sender.id, t: other.id, k: '2', c: '[redacted]' } });
    const first = await get('/v1/admin/system/streams/msg/dead-letters?limit=2');
    expect(first.statusCode, first.body).toBe(200);
    expect(statements(first)).toBe(0);
    const page = adminDeadLetterPageSchema.parse(first.json());
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    for (const item of page.items) expect(Object.keys(item).sort()).toEqual(['at', 'deliveries', 'entryAt', 'id', 'kind', 'reason', 'stream']);
    expect(page.items[0]).toMatchObject({ stream: 'msg', reason: 'rejected', deliveries: 1, kind: 'text' });
    const rest = adminDeadLetterPageSchema.parse((await get(`/v1/admin/system/streams/msg/dead-letters?limit=2&cursor=${page.nextCursor}`)).json());
    expect(rest.items).toHaveLength(1);
    expect(rest.items[0]).toMatchObject({ reason: 'malformed' });
    expect(rest.nextCursor).toBeNull();
    const likes = adminDeadLetterPageSchema.parse((await get('/v1/admin/system/streams/like/dead-letters')).json());
    expect(likes.items.find((i) => i.kind === 'superlike')).toBeDefined();
    for (const body of [first.body, likes.items.map((i) => JSON.stringify(i)).join()]) {
      for (const secret of [sender.id, other.id, sender.publicUid, other.publicUid, match, '[redacted]']) expect(body).not.toContain(secret);
      expect(body).not.toMatch(new RegExp(PUBLIC_UID_PATTERN.source.slice(1, -1)));
    }
    expect((await get('/v1/admin/system/streams/nope/dead-letters')).statusCode).toBe(400);
  });

  it('lists the partitions of the three parents from the catalog in one statement', async () => {
    const res = await get('/v1/admin/system/partitions');
    expect(res.statusCode, res.body).toBe(200);
    expect(statements(res)).toBe(1);
    const parents = adminSystemPartitionsSchema.parse(res.json()).parents;
    expect(parents.map((p) => p.parent)).toEqual(['audit_log', 'likes', 'messages']);
    for (const parent of parents) {
      expect(parent.current, parent.parent).toBe(true);
      expect(parent.ahead, parent.parent).toBe(parent.premake);
      expect(parent.nextDropAfter).not.toBeNull();
      expect(parent.partitions[0]!.from < parent.partitions.at(-1)!.from).toBe(true);
    }
    expect(parents.find((p) => p.parent === 'likes')).toMatchObject({ period: 'week', retention: { months: 0, days: 37 } });
  });

  it('deletes failed entries by id and up to an id, writing nothing when nothing matches', async () => {
    const dead = `${h.prefix}wb:match:dead`;
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push(await deadLetter(h, 'match', { id: `${Date.now()}-${i}`, fields: { m: appId(1), s: '1' } }));
    const byIds = await post('/v1/admin/system/dead-letters/delete', { stream: 'match', ids: [ids[0], ids[1], '1-1'] });
    expect(byIds.statusCode, byIds.body).toBe(200);
    expect(statements(byIds)).toBe(1);
    expect(byIds.json()).toEqual({ deleted: 2, sideEffects: 'done' });
    expect((await lastAudit(db, { action: 'system.dead_letters_delete' }))).toMatchObject({ target_type: 0, target_id: null, detail: { stream: 'match', ids: [ids[0], ids[1]] } });
    const audits = async () => (await db.sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'system.dead_letters_delete'`)).rows[0]!.n;
    const before = await audits();
    expect((await post('/v1/admin/system/dead-letters/delete', { stream: 'match', ids: ['1-1'] })).json()).toEqual({ deleted: 0, sideEffects: 'done' });
    expect(await audits()).toBe(before);
    const upTo = await post('/v1/admin/system/dead-letters/delete', { stream: 'match', upTo: ids[2] });
    expect(upTo.json()).toEqual({ deleted: 1, sideEffects: 'done' });
    expect((await h.redis.xrange(dead, '-', '+')).map(([id]) => id)).toEqual([ids[3]]);
    expect((await lastAudit(db, { action: 'system.dead_letters_delete' }))!.detail).toMatchObject({ stream: 'match', upTo: ids[2], lengthBefore: 2 });
    expect((await post('/v1/admin/system/dead-letters/delete', { stream: 'match', ids: [] })).statusCode).toBe(400);
  });

  it('counts what "up to" deleted even while new entries keep failing', async () => {
    const dead = `${h.prefix}wb:like:dead`;
    await h.redis.del(dead);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await deadLetter(h, 'like', { id: `${Date.now()}-${i}`, fields: { k: '1' } }));
    // Three more fail between the read before the transaction and the trim after it.
    const real = h.app.redis.xtrim.bind(h.app.redis);
    const spy = vi.spyOn(h.app.redis, 'xtrim').mockImplementation(async (...args: Parameters<typeof real>) => {
      for (let i = 0; i < 3; i += 1) await deadLetter(h, 'like', { id: `${Date.now()}-${10 + i}`, fields: { k: '1' } });
      return real(...args);
    });
    try {
      const res = await post('/v1/admin/system/dead-letters/delete', { stream: 'like', upTo: ids[3] });
      expect(res.json()).toEqual({ deleted: 4, sideEffects: 'done' });
    } finally {
      spy.mockRestore();
    }
    expect(await h.redis.xlen(dead)).toBe(4);
    await h.redis.del(dead);
  });

  it('retries failed jobs whose late run is harmless, with their attempts reset, and removes others', async () => {
    const retried = await post('/v1/admin/system/jobs/retry', { queue: 'photo', name: 'process' });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(statements(retried)).toBe(1);
    expect(adminJobGroupResultSchema.parse(retried.json())).toMatchObject({ matched: 2, done: 2, more: false, sideEffects: 'done' });
    expect(await h.redis.zcard(failedKey(h, 'photo'))).toBe(0);
    const job = await Job.fromId(queue('photo'), 'process.101');
    expect(await job!.getState()).toBe('waiting');
    expect(job!.attemptsMade).toBe(0);
    expect((await lastAudit(db, { action: 'system.jobs_retry' }))).toMatchObject({ target_type: 0, detail: { queue: 'photo', name: 'process', count: 2, more: false } });

    const push = await post('/v1/admin/system/jobs/retry', { queue: 'push', name: 'send' });
    expect(push.statusCode).toBe(422);
    expect(fieldError(push)).toMatchObject({ pointer: '/name', code: 'not_retryable' });
    const removed = await post('/v1/admin/system/jobs/remove', { queue: 'push', name: 'send' });
    expect(adminJobGroupResultSchema.parse(removed.json())).toMatchObject({ matched: 1, done: 1 });
    expect(await h.redis.zcard(failedKey(h, 'push'))).toBe(0);
    const unknown = await post('/v1/admin/system/jobs/remove', { queue: 'nope', name: 'send' });
    expect(unknown.statusCode).toBe(422);
    expect(fieldError(unknown)).toMatchObject({ pointer: '/queue', code: 'unknown_job' });
    // Nothing failed of the name: nothing written.
    const none = await post('/v1/admin/system/jobs/remove', { queue: 'push', name: 'send' });
    expect(none.json()).toMatchObject({ matched: 0, done: 0 });
  });

  it('acts on no more failed jobs than it was asked for (the count the page showed)', async () => {
    const ids = Array.from({ length: 230 }, (_, i) => `refill.${1000 + i}`);
    await failJobs(h, 'deck', 'refill', ids);
    const overview = adminSystemQueuesSchema.parse((await get('/v1/admin/system/queues')).json());
    const deck = overview.queues.find((q) => q.name === 'deck')!;
    // The page counts among the newest 200 only.
    expect(deck.failed).toMatchObject({ scanned: 200, more: true });
    expect(deck.failed.groups).toEqual([expect.objectContaining({ name: 'refill', count: 200 })]);
    const bounded = await post('/v1/admin/system/jobs/remove', { queue: 'deck', name: 'refill', max: 200 });
    expect(bounded.statusCode, bounded.body).toBe(200);
    expect(adminJobGroupResultSchema.parse(bounded.json())).toMatchObject({ matched: 200, done: 200, more: true });
    expect((await lastAudit(db, { action: 'system.jobs_remove' }))!.detail).toMatchObject({ queue: 'deck', name: 'refill', count: 200, more: true });
    expect(await h.redis.zcard(failedKey(h, 'deck'))).toBe(30);
    expect((await post('/v1/admin/system/jobs/remove', { queue: 'deck', name: 'refill', max: 501 })).statusCode).toBe(400);
    const rest = await post('/v1/admin/system/jobs/retry', { queue: 'deck', name: 'refill' });
    expect(adminJobGroupResultSchema.parse(rest.json())).toMatchObject({ matched: 30, done: 30, more: false });
  });

  it('answers sideEffects failed when retrying or removing breaks after the audit row, and reads again afterwards', async () => {
    await failJobs(h, 'iap', 'recheck', ['recheck.201', 'recheck.202']);
    const fromId = vi.spyOn(Job, 'fromId').mockRejectedValue(new Error('Connection is closed.'));
    try {
      const res = await post('/v1/admin/system/jobs/retry', { queue: 'iap', name: 'recheck' });
      expect(res.statusCode, res.body).toBe(200);
      expect(adminJobGroupResultSchema.parse(res.json())).toMatchObject({ matched: 2, done: 0, sideEffects: 'failed' });
    } finally {
      fromId.mockRestore();
    }
    const remove = vi.spyOn(Queue.prototype, 'remove').mockRejectedValue(new Error('Connection is closed.'));
    try {
      const res = await post('/v1/admin/system/jobs/remove', { queue: 'iap', name: 'recheck' });
      expect(adminJobGroupResultSchema.parse(res.json())).toMatchObject({ matched: 2, done: 0, sideEffects: 'failed' });
    } finally {
      remove.mockRestore();
    }
    // The queues were made again: the page reads, and the action works.
    expect((await get('/v1/admin/system/queues')).statusCode).toBe(200);
    expect(adminJobGroupResultSchema.parse((await post('/v1/admin/system/jobs/remove', { queue: 'iap', name: 'recheck' })).json())).toMatchObject({ matched: 2, done: 2, sideEffects: 'done' });
  });

  it('starts a maintenance task once a minute, and refuses the others', async () => {
    // Not in the last seconds of a minute: both clicks fall in the same one.
    const intoMinute = Date.now() % 60_000;
    if (intoMinute > 55_000) await new Promise((resolve) => setTimeout(resolve, 60_100 - intoMinute));
    const res = await post('/v1/admin/system/tasks/run', { queue: 'maint', name: 'partitions' });
    expect(res.statusCode, res.body).toBe(200);
    expect(statements(res)).toBe(1);
    const body = adminTaskRunResultSchema.parse(res.json());
    expect(body).toMatchObject({ queued: true, already: false, sideEffects: 'done' });
    expect(body.jobId).toMatch(/^partitions\.run\.[0-9]+$/);
    const audits = async () => (await db.sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'system.task_run'`)).rows[0]!.n;
    const before = await audits();
    // A second click within the minute: the run is there already, nothing is written.
    const again = await post('/v1/admin/system/tasks/run', { queue: 'maint', name: 'partitions' });
    expect(statements(again)).toBe(0);
    expect(adminTaskRunResultSchema.parse(again.json())).toEqual({ queued: false, already: true, jobId: body.jobId, sideEffects: 'done' });
    expect(await audits()).toBe(before);
    const maint = queue('maint');
    const job = await Job.fromId(maint, body.jobId);
    expect(job?.name).toBe('partitions');
    expect(body.jobId === manualRunId('partitions', Date.now()) || body.jobId === manualRunId('partitions', Date.now() - 60_000)).toBe(true);
    expect((await lastAudit(db, { action: 'system.task_run' }))).toMatchObject({ target_type: 0, detail: { queue: 'maint', name: 'partitions', jobId: body.jobId } });
    const refused = await post('/v1/admin/system/tasks/run', { queue: 'maint', name: 'sessions-cleanup' });
    expect(refused.statusCode).toBe(422);
    expect(fieldError(refused)).toMatchObject({ pointer: '/name', code: 'not_runnable' });
    expect((await post('/v1/admin/system/tasks/run', { queue: 'stats', name: 'rollup' })).statusCode).toBe(200);
  });

  it('keeps the page to system.read and its actions to system.write', async () => {
    const support = await adminAs(h, 'support');
    for (const url of ['/v1/admin/system/health', '/v1/admin/system/queues', '/v1/admin/system/streams', '/v1/admin/system/partitions', '/v1/admin/system/streams/like/dead-letters']) {
      const res = await get(url, support);
      expect(res.statusCode, url).toBe(403);
      problemSchemaFor('forbidden').parse(res.json());
    }
    await db.sql.query(`INSERT INTO admin_roles (id, key, names) VALUES (61, 'watcher', '{"en": "Watcher"}')`);
    await db.sql.query(`INSERT INTO admin_role_permissions (role_id, permission) VALUES (61, 'system.read')`);
    await h.app.adminAuth.roles.reload();
    const watcher = await adminAs(h, 'watcher');
    expect((await get('/v1/admin/system/queues', watcher)).statusCode).toBe(200);
    for (const [url, body] of [
      ['/v1/admin/system/tasks/run', { queue: 'maint', name: 'partitions' }],
      ['/v1/admin/system/jobs/remove', { queue: 'push', name: 'send' }],
      ['/v1/admin/system/dead-letters/delete', { stream: 'like', upTo: '1-0' }],
    ] as const) {
      expect((await post(url, body, watcher)).statusCode, url).toBe(403);
    }
  });
});

describe.skipIf(!hasInfrastructure)('admin: jobs and health limits and outages', () => {
  let db: TestDatabase;
  let h: AdminHarness;

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startAdminHarness(db, {}, { adminSystem: { writesPerHour: 2 } });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await db?.drop();
  });

  it('limits system writes per admin and hour, and gives back a write that did nothing', async () => {
    const intoMinute = Date.now() % 60_000;
    if (intoMinute > 55_000) await new Promise((resolve) => setTimeout(resolve, 60_100 - intoMinute));
    const owner = await adminAs(h, 'superadmin');
    const run = (queue: string, name: string, token = owner.accessToken) => admin(h, '/v1/admin/system/tasks/run', { queue, name }, { token });
    const noop = () => admin(h, '/v1/admin/system/jobs/remove', { queue: 'photo', name: 'process' }, { token: owner.accessToken });
    expect((await noop()).statusCode).toBe(200);
    expect((await run('maint', 'lk-rebuild')).statusCode).toBe(200);
    // This minute's run again: nothing added, the count given back.
    expect((await run('maint', 'lk-rebuild')).json()).toMatchObject({ already: true });
    expect((await run('maint', 'partitions')).statusCode).toBe(200);
    const limited = await run('stats', 'rollup');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    const other = await adminAs(h, 'superadmin');
    expect((await run('stats', 'rollup', other.accessToken)).statusCode).toBe(200);
  });

  it('answers 503 when the queues cannot be read, and refuses the token in a full Valkey outage', async () => {
    const owner = await adminAs(h, 'superadmin');
    const spy = vi.spyOn(h.app.redis, 'zrevrange').mockRejectedValue(new Error('connection lost'));
    try {
      const res = await admin(h, '/v1/admin/system/queues', undefined, { token: owner.accessToken });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
    } finally {
      spy.mockRestore();
    }
    h.app.redis.disconnect();
    try {
      // The deny list cannot be read: admin tokens are refused before the route runs.
      const res = await admin(h, '/v1/admin/system/health', undefined, { token: owner.accessToken });
      expect(res.statusCode).not.toBe(200);
    } finally {
      await h.app.redis.connect().catch(() => undefined);
    }
  });
});
