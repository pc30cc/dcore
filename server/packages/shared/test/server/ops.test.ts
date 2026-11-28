import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminDeadLetterSchema } from '../../src/index.js';
import {
  createKeys,
  errorKindOf,
  isManualRunId,
  isRetryable,
  isRunnable,
  jobNameOfId,
  manualRunId,
  queueJobs,
  PROCESS_PRUNE_MS,
  readProcesses,
  retryableJobs,
  runnableTasks,
  runRecordSchema,
  summarizeResult,
} from '../../src/server/index.js';
import { dropPrefix, hasRedis, testPrefix, testRedis } from './support.js';

describe('the jobs page policy', () => {
  it('reads the job name from a job id', () => {
    expect(jobNameOfId('repeat:partitions:1730000000000')).toBe('partitions');
    expect(jobNameOfId('repeat:origins-publish:1730000000000')).toBe('origins-publish');
    expect(jobNameOfId('process.123')).toBe('process');
    expect(jobNameOfId('send.message.9')).toBe('send');
    expect(jobNameOfId('partitions.run.28833333')).toBe('partitions');
    expect(jobNameOfId('42')).toBe('other');
    expect(jobNameOfId('Upper.1')).toBe('other');
    expect(jobNameOfId('')).toBe('other');
    expect(jobNameOfId('repeat:x:y:z')).toBe('other');
  });

  it('retries only jobs whose late run is harmless, and names only jobs of the table', () => {
    for (const [queue, rule] of Object.entries(retryableJobs)) {
      if (rule === '*') continue;
      for (const name of rule) expect((queueJobs as Record<string, readonly string[]>)[queue], `${queue}/${name}`).toContain(name);
    }
    for (const [queue, name] of [['photo', 'process'], ['photo', 'delete'], ['maint', 'partitions'], ['iap', 'recheck'], ['account', 'purge'], ['deck', 'refill'], ['calls', 'finalize'], ['stats', 'rollup'], ['system', 'origins-publish'], ['chat', 'like-notes']] as const) {
      expect(isRetryable(queue, name), `${queue}/${name}`).toBe(true);
    }
    for (const [queue, name] of [['push', 'send'], ['calls', 'ring'], ['calls', 'ring-push'], ['calls', 'ring-stop'], ['calls', 'room'], ['system', 'heartbeat'], ['chat', 'read-flush'], ['stats', 'live'], ['photo', 'other'], ['photo', 'nope'], ['nope', 'process']] as const) {
      expect(isRetryable(queue, name), `${queue}/${name}`).toBe(false);
    }
  });

  it('runs by hand the maintenance tasks and the daily figures only, once a minute', () => {
    expect(runnableTasks.map((t) => `${t.queue}/${t.name}`)).toEqual(['maint/partitions', 'maint/lk-rebuild', 'system/origins-publish', 'stats/rollup']);
    for (const task of runnableTasks) expect(queueJobs[task.queue] as readonly string[]).toContain(task.name);
    expect(isRunnable('maint', 'partitions')).toBe(true);
    expect(isRunnable('maint', 'sessions-cleanup')).toBe(false);
    expect(isRunnable('stats', 'live')).toBe(false);
    const at = Date.UTC(2026, 10, 28, 9, 30, 10);
    expect(manualRunId('partitions', at)).toBe(manualRunId('partitions', at + 40_000));
    expect(manualRunId('partitions', at)).not.toBe(manualRunId('partitions', at + 60_000));
    expect(isManualRunId(manualRunId('rollup', at))).toBe(true);
    expect(isManualRunId('repeat:partitions:1730000000000')).toBe(false);
    expect(isManualRunId('process.123')).toBe(false);
    expect(isManualRunId(undefined)).toBe(false);
  });
});

describe('the run records', () => {
  it('keep the numbers and booleans of a result, never its text', () => {
    expect(summarizeResult({ leased: true, ensured: 3, dropped: 0, parents: { likes: [] }, day: '2026-11-27', ratio: Number.NaN, 'bad key': 1 })).toEqual({ leased: true, ensured: 3, dropped: 0 });
    expect(summarizeResult(null)).toEqual({});
    expect(summarizeResult([1, 2])).toEqual({});
    expect(summarizeResult('done')).toEqual({});
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`n${i}`, i]));
    expect(Object.keys(summarizeResult(many))).toHaveLength(8);
  });

  it('keep an error as its class and SQLSTATE, never its message', () => {
    const pgError = Object.assign(new Error('relation "users" for +15551234567 failed'), { name: 'DatabaseError', code: '57014' });
    expect(errorKindOf(pgError)).toBe('DatabaseError:57014');
    expect(errorKindOf(new TypeError('secret token abc'))).toBe('TypeError');
    expect(errorKindOf(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe('Error');
    expect(errorKindOf(Object.assign(new Error('x'), { name: 'name with spaces' }))).toBeNull();
    expect(errorKindOf('boom')).toBeNull();
    expect(runRecordSchema.safeParse({ atMs: 1, ok: false, ms: 5, attempt: 1, attempts: 3, willRetry: true, error: 'a message, not a kind', manual: false, summary: {} }).success).toBe(false);
  });
});

describe('the dead-letter wire', () => {
  it('carries no person, conversation or public id', () => {
    const entry = { id: '1730000000000-0', stream: 'msg', at: '2026-11-28T09:00:00.000Z', entryAt: '2026-11-28T08:59:00.000Z', reason: 'rejected', deliveries: 1, kind: 'text' };
    expect(adminDeadLetterSchema.parse(entry)).toEqual(entry);
    expect(Object.keys(adminDeadLetterSchema.shape).sort()).toEqual(['at', 'deliveries', 'entryAt', 'id', 'kind', 'reason', 'stream']);
    for (const extra of [{ people: ['abcdefghijklm'] }, { conversationId: '123' }, { sender: '1' }, { fields: '{}' }]) {
      expect(adminDeadLetterSchema.safeParse({ ...entry, ...extra }).success, Object.keys(extra)[0]).toBe(false);
    }
  });
});

describe.skipIf(!hasRedis)('the process list (prov:applied reports)', () => {
  const redis = hasRedis ? testRedis() : null!;
  const prefix = testPrefix();
  const keys = createKeys(prefix);

  beforeAll(async () => {
    await dropPrefix(redis, prefix);
  });
  afterAll(async () => {
    await dropPrefix(redis, prefix);
    await redis.quit();
  });

  it('lists fresh reports that carry the process state, API processes first', async () => {
    const now = Date.now();
    const api = (atMs: number, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ atMs, hash: 'h', kinds: {}, proc: { kind: 'api', startedAtMs: now - 60_000, cfgVersion: 7, rolesVersion: 7, rolesFailing: false, ...extra } });
    const worker = JSON.stringify({ atMs: now - 5_000, hash: 'h', kinds: {}, moderation: { provider: 'fake', autoApprove: false }, proc: { kind: 'worker', startedAtMs: now - 90_000, cfgVersion: 6, queues: ['photo', 'maint'], streams: ['like', 'msg'], maint: true } });
    await redis.hset(keys.providersApplied(), {
      'api:b-host': api(now - 1_000),
      'api:a-host': api(now - 2_000, { rolesFailing: true }),
      'api:stale': api(now - 95_000),
      'api:no-proc': JSON.stringify({ atMs: now, hash: 'h', kinds: {} }),
      'api:broken': '{',
      'worker:w1': worker,
      'worker:wrong-kind': api(now),
      'other:x': api(now),
    });
    const list = await readProcesses(redis, keys, now);
    expect(list.map((p) => p.field)).toEqual(['api:a-host', 'api:b-host', 'worker:w1']);
    expect(list[0]).toMatchObject({ name: 'a-host', info: { kind: 'api', rolesFailing: true, cfgVersion: 7 } });
    expect(list[2]).toMatchObject({ name: 'w1', info: { kind: 'worker', queues: ['photo', 'maint'], streams: ['like', 'msg'], maint: true } });
  });

  it('removes reports older than an hour (and unreadable ones), keeping the recent ones it does not list', async () => {
    const now = Date.now();
    const report = (atMs: number) => JSON.stringify({ atMs, hash: 'h', kinds: {}, proc: { kind: 'worker', startedAtMs: atMs - 1_000, cfgVersion: 1, queues: [], streams: [], maint: false } });
    await redis.del(keys.providersApplied());
    await redis.hset(keys.providersApplied(), {
      'worker:killed': report(now - PROCESS_PRUNE_MS - 1_000),
      'api:old-deploy': report(now - 3 * PROCESS_PRUNE_MS),
      'worker:garbled': 'not json',
      'worker:quiet': report(now - 120_000),
      'worker:live': report(now - 1_000),
    });
    const list = await readProcesses(redis, keys, now);
    expect(list.map((p) => p.field)).toEqual(['worker:live']);
    expect((await redis.hkeys(keys.providersApplied())).sort()).toEqual(['worker:live', 'worker:quiet']);
  });
});
