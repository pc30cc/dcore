import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { heartbeatKey, loadConfig, publishToStream, startWorker, systemQueue, type QueueDefinition } from '../src/index.js';
import { TEST_REDIS_URL, connect, eventually, hasRedis } from './support.js';

describe('config', () => {
  it('derives the queue prefix and a worker id', () => {
    const config = loadConfig({ REDIS_URL: 'redis://localhost:6379', REDIS_KEY_PREFIX: 'stage:' });
    expect(config.queuePrefix).toBe('stage:bull');
    expect(config.workerId).toMatch(/^[A-Za-z0-9._-]+-\d+$/);
    expect(loadConfig({ REDIS_URL: 'redis://localhost:6379', WORKER_ID: 'w-1' }).workerId).toBe('w-1');
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
    const config = loadConfig({ REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix, WORKER_ID: 'test-worker' });
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
