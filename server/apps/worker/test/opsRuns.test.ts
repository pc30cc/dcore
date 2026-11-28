import { randomBytes } from 'node:crypto';
import { createKeys, manualRunId, runRecordSchema } from '@app/shared/server';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachRunRecorder, isRecorded, runRecordOf } from '../src/ops/runs.js';
import { connect, eventually, hasRedis } from './support.js';

/**
 * The run recorder: a scheduler's occurrence and a hand-started run write
 * their outcome (and their success time when they worked); a failure with
 * attempts left says it will be retried; a per-person job writes nothing;
 * no record carries a message, an id or text of the job's result.
 */

describe('run records', () => {
  it('keeps the numbers of a result, the class of an error and the attempt', () => {
    const job = { id: 'repeat:partitions:1730000000000', name: 'partitions', queueName: 'maint', repeatJobKey: 'partitions', attemptsMade: 1, opts: { attempts: 8 }, processedOn: 1_000, finishedOn: 1_250 };
    expect(isRecorded(job)).toBe(true);
    expect(isRecorded({ id: 'process.123' })).toBe(false);
    expect(isRecorded({ id: manualRunId('partitions', Date.now()) })).toBe(true);
    const ok = runRecordOf(job, { ok: true, result: { leased: true, ensured: 13, parents: { likes: [] }, note: 'text' } });
    expect(ok).toEqual({ atMs: 1_250, ok: true, ms: 250, attempt: 1, attempts: 8, willRetry: false, error: null, manual: false, summary: { leased: true, ensured: 13 } });
    const failed = runRecordOf(job, { ok: false, error: Object.assign(new Error('could not lock "part"."likes_p20261123" for +15550001111'), { name: 'PartitionsDeferredError' }) });
    expect(failed).toMatchObject({ ok: false, willRetry: true, error: 'PartitionsDeferredError', summary: {} });
    expect(JSON.stringify(failed)).not.toContain('likes_p');
    expect(runRecordOf({ ...job, attemptsMade: 8 }, { ok: false, error: new Error('x') }).willRetry).toBe(false);
    expect(runRecordSchema.parse(ok)).toEqual(ok);
  });
});

describe.skipIf(!hasRedis)('the run recorder on a real queue', () => {
  let redis: Redis;
  const prefix = `t${randomBytes(4).toString('hex')}:`;
  const keys = createKeys(prefix);
  const bull = `${prefix}bull`;
  const queues: Queue[] = [];
  const workers: Worker[] = [];
  const log = pino({ level: 'silent' });

  beforeAll(() => {
    redis = connect();
  });

  afterAll(async () => {
    await Promise.allSettled(workers.map((w) => w.close()));
    await Promise.allSettled(queues.map((q) => q.close()));
    const stale = await redis.keys(`${prefix}*`);
    if (stale.length > 0) await redis.del(...stale);
    redis.disconnect();
  });

  function start(name: string, processor: (job: { name: string; data: { fail?: boolean } }) => Promise<unknown>): Queue {
    const queue = new Queue(name, { connection: redis, prefix: bull });
    queues.push(queue);
    const worker = new Worker(name, async (job) => processor(job), { connection: redis.duplicate({ maxRetriesPerRequest: null }), prefix: bull });
    worker.on('error', () => undefined);
    attachRunRecorder(worker, { redis, keys, log });
    workers.push(worker);
    return queue;
  }

  const runs = async () => Object.fromEntries(Object.entries(await redis.hgetall(keys.opsRuns())).map(([field, value]) => [field, runRecordSchema.parse(JSON.parse(value))]));

  it('records a scheduled job and a hand-started one, and nothing for other jobs', async () => {
    const queue = start('maint', async (job) => (job.name === 'partitions' ? { leased: true, ensured: 13, dropped: 0 } : { done: 1 }));
    await queue.upsertJobScheduler('partitions', { every: 3_600_000 }, { name: 'partitions', data: {} });
    await eventually(async () => (await redis.hexists(keys.opsRuns(), 'maint/partitions')) === 1);
    const first = (await runs())['maint/partitions']!;
    expect(first).toMatchObject({ ok: true, attempt: 1, attempts: 1, willRetry: false, manual: false, summary: { leased: true, ensured: 13, dropped: 0 } });
    expect(Number(await redis.hget(keys.opsRunsOk(), 'maint/partitions'))).toBe(first.atMs);

    await queue.add('lk-rebuild', {}, { jobId: manualRunId('lk-rebuild', Date.now()) });
    await eventually(async () => (await redis.hexists(keys.opsRuns(), 'maint/lk-rebuild')) === 1);
    expect((await runs())['maint/lk-rebuild']).toMatchObject({ ok: true, manual: true, summary: { done: 1 } });

    const unscheduled = await queue.add('sessions-cleanup', {}, { jobId: 'sessions-cleanup.1' });
    await eventually(async () => (await unscheduled.getState()) === 'completed');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await redis.hexists(keys.opsRuns(), 'maint/sessions-cleanup')).toBe(0);
  });

  it('records a failure that will be retried, and keeps the last success time', async () => {
    let calls = 0;
    const queue = start('stats', async () => {
      calls += 1;
      throw Object.assign(new Error(`statement timeout for user 1234567890 (${calls})`), { name: 'DatabaseError', code: '57014' });
    });
    await redis.hset(keys.opsRunsOk(), 'stats/rollup', '1000');
    await queue.add('rollup', {}, { jobId: manualRunId('rollup', Date.now()), attempts: 2, backoff: { type: 'fixed', delay: 60_000 } });
    await eventually(async () => (await redis.hexists(keys.opsRuns(), 'stats/rollup')) === 1);
    const record = (await runs())['stats/rollup']!;
    expect(record).toMatchObject({ ok: false, attempt: 1, attempts: 2, willRetry: true, error: 'DatabaseError:57014', manual: true, summary: {} });
    expect(await redis.hget(keys.opsRunsOk(), 'stats/rollup')).toBe('1000');
    expect(await redis.hget(keys.opsRuns(), 'stats/rollup')).not.toMatch(/1234567890|timeout/);
  });
});
