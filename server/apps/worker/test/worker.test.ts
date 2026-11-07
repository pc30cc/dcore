import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queuePrefix, queueRetention, type QueueName } from '@app/shared/server';
import { Queue } from 'bullmq';
import { defaultQueues, heartbeatKey, loadConfig, publishToStream, startWorker, systemQueue, type QueueDefinition } from '../src/index.js';
import { TEST_REDIS_URL, baseEnv, connect, eventually, hasRedis } from './support.js';

describe('config', () => {
  it('derives the queue prefix and a worker id', () => {
    const config = loadConfig({ ...baseEnv(), REDIS_URL: 'redis://localhost:6379', REDIS_KEY_PREFIX: 'stage:' });
    expect(config.queuePrefix).toBe('stage:bull');
    expect(config.workerId).toMatch(/^[A-Za-z0-9._-]+-\d+$/);
    expect(loadConfig({ ...baseEnv(), REDIS_URL: 'redis://localhost:6379', WORKER_ID: 'w-1' }).workerId).toBe('w-1');
  });
});

describe.skipIf(!hasRedis)('worker runtime (redis-server)', () => {
  let admin: Redis;
  const prefix = `t${randomBytes(4).toString('hex')}:`;

  beforeAll(() => {
    admin = connect();
  });
  afterAll(async () => {
    const keys = await admin.keys(`${prefix}*`);
    if (keys.length > 0) await admin.del(...keys);
    await admin.quit();
  });

  it('runs scheduled jobs and stream consumers, then stops cleanly', async () => {
    const config = loadConfig({ ...baseEnv(), REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix, WORKER_ID: 'test-worker' });
    const ticks: string[] = [];
    const probe: QueueDefinition = {
      name: 'probe',
      schedules: [{ id: 'tick', name: 'tick', repeat: { every: 150 } }],
      async process(job) {
        ticks.push(job.name);
        return null;
      },
    };
    const received: string[] = [];
    const stream = `${prefix}events`;
    const runtime = await startWorker(config, {
      logger: pino({ level: 'silent' }),
      queues: [probe, systemQueue],
      consumers: [
        {
          stream,
          group: 'workers',
          blockMs: 100,
          handler: async (entry) => {
            received.push(entry.fields['kind'] ?? '');
          },
        },
      ],
    });
    try {
      await eventually(() => ticks.length >= 2);
      await eventually(async () => (await admin.exists(stream)) === 1);
      await publishToStream(admin, stream, { kind: 'hello' });
      await eventually(() => received.includes('hello'));
      await eventually(async () => (await admin.get(heartbeatKey(prefix))) !== null, 10_000);
      const beat = JSON.parse((await admin.get(heartbeatKey(prefix))) ?? '{}') as { workerId?: string };
      expect(beat.workerId).toBe('test-worker');
    } finally {
      await runtime.stop();
    }
  });
});

describe.skipIf(!hasRedis)('queue retention (redis-server)', () => {
  it('sets the retention of the shared table on every queue and on every schedule', async () => {
    const prefix = `t${randomBytes(4).toString('hex')}:`;
    const admin = connect();
    const config = loadConfig({ ...baseEnv(), REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix, WORKER_ID: 'retention-test' });
    const definitions = defaultQueues(config);
    expect(definitions.map((d) => d.name)).toEqual(expect.arrayContaining(['system', 'photo', 'maint']));
    const runtime = await startWorker(config, { logger: pino({ level: 'silent' }), queues: definitions });
    let stopped = false;
    try {
      // The process holds an id lease while it runs and frees it when it stops.
      await eventually(async () => (await admin.keys(`${prefix}idgen:*`)).length === 1);
      for (const worker of runtime.workers) {
        const expected = queueRetention(worker.name as QueueName);
        expect(worker.opts.removeOnComplete, worker.name).toEqual(expected.removeOnComplete);
        expect(worker.opts.removeOnFail, worker.name).toEqual(expected.removeOnFail);
        // Nothing is kept forever: a bound on age (and on count except push).
        expect(expected.removeOnComplete.age).toBeLessThanOrEqual(3_600);
        expect(expected.removeOnFail.count).toBeLessThanOrEqual(50_000);
      }
      expect(queueRetention('push').removeOnComplete).toEqual({ age: 600 });
      for (const definition of definitions) {
        if (!definition.schedules) continue;
        const queue = new Queue(definition.name, { connection: admin, prefix: queuePrefix(prefix) });
        try {
          for (const schedule of definition.schedules) {
            const stored = await queue.getJobScheduler(schedule.id);
            const retention = queueRetention(definition.name as QueueName);
            expect(stored?.template?.opts?.removeOnComplete, schedule.id).toEqual(retention.removeOnComplete);
            expect(stored?.template?.opts?.removeOnFail, schedule.id).toEqual(retention.removeOnFail);
            if (schedule.opts?.attempts) expect(stored?.template?.opts?.attempts).toBe(schedule.opts.attempts);
          }
        } finally {
          await queue.close();
        }
      }
      await runtime.stop();
      stopped = true;
      expect(await admin.keys(`${prefix}idgen:*`)).toEqual([]);
    } finally {
      if (!stopped) await runtime.stop();
      const keys = await admin.keys(`${prefix}*`);
      if (keys.length > 0) await admin.del(...keys);
      await admin.quit();
    }
  });
});
