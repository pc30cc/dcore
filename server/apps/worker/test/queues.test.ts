import { randomBytes } from 'node:crypto';
import type { Job } from 'bullmq';
import { Queue } from 'bullmq';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { queueJobs, queuePrefix, type ActiveQueueName } from '@app/shared/server';
import { defaultConsumers, defaultQueues, loadConfig, startWorker, type JobContext, type QueueDefinition } from '../src/index.js';
import type { WorkerServices } from '../src/services.js';
import { TEST_REDIS_URL, baseEnv, connect, hasRedis } from './support.js';

/**
 * The worker runs every queue that has jobs (the shared `queueJobs` table,
 * which also types what the API may add), and each queue's processor
 * handles every job name of the table, so nothing a producer adds can land
 * in a queue nobody works on or under a name nobody runs.
 */

const queues = Object.keys(queueJobs) as ActiveQueueName[];

/** A client that fails on first use: the processor got past its name check and started working. */
function untouchable<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get(_target, property) {
      if (property === 'then') return undefined;
      throw new Error(`reached ${what}.${String(property)}`);
    },
  });
}

function fakeJob(name: string): Job {
  return { name, id: `${name}.1`, data: {}, opts: {}, attemptsMade: 0, timestamp: Date.now() } as unknown as Job;
}

async function outcome(definition: QueueDefinition, name: string, context: JobContext): Promise<string> {
  try {
    await definition.process(fakeJob(name), context);
    return 'done';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('the queues the worker runs', () => {
  const config = loadConfig({ ...baseEnv(), REDIS_URL: 'redis://127.0.0.1:1/0' });
  const context: JobContext = {
    config,
    redis: untouchable('redis'),
    log: pino({ level: 'silent' }),
    services: untouchable<WorkerServices>('services'),
    token: 'test-token',
  };

  it('are exactly the queues that have jobs (maintenance can be turned off)', () => {
    expect(defaultQueues(config).map((q) => q.name).sort()).toEqual([...queues].sort());
    const quiet = loadConfig({ ...baseEnv(), REDIS_URL: 'redis://127.0.0.1:1/0', MAINT_ENABLED: 'false' });
    expect(defaultQueues(quiet).map((q) => q.name).sort()).toEqual(queues.filter((q) => q !== 'maint').sort());
  });

  it('run every job name of the table and refuse any other', async () => {
    for (const definition of defaultQueues(config)) {
      const names = queueJobs[definition.name as ActiveQueueName];
      for (const name of names) {
        expect(await outcome(definition, name, context), `${definition.name}/${name}`).not.toMatch(/has no job named/);
      }
      expect(await outcome(definition, 'nope', context)).toMatch(new RegExp(`the ${definition.name} queue has no job named "nope"`));
    }
  });

  it('schedule only jobs of the table', () => {
    const scheduled: string[] = [];
    for (const definition of defaultQueues(config)) {
      for (const schedule of definition.schedules ?? []) {
        expect(queueJobs[definition.name as ActiveQueueName] as readonly string[], `${definition.name}/${schedule.name}`).toContain(schedule.name);
        scheduled.push(`${definition.name}/${schedule.name}`);
      }
    }
    expect(scheduled.sort()).toEqual([
      'account/deletion-sweep',
      'maint/active-drain',
      'maint/lk-rebuild',
      'maint/partitions',
      'maint/sessions-cleanup',
      'safety/moderation-sweep',
      'system/heartbeat',
    ]);
  });

  it('come with the write-behind consumers: wb:like in batch mode and wb:match, unless streams are turned off', () => {
    const consumers = defaultConsumers(config).map((c) => `${c.stream} ${c.group} ${c.kind ?? 'entry'}`);
    expect(consumers).toEqual([`${config.redis.keyPrefix}wb:like pg batch`, `${config.redis.keyPrefix}wb:match pg entry`]);
    const queuesOnly = loadConfig({ ...baseEnv(), REDIS_URL: 'redis://127.0.0.1:1/0', STREAMS_ENABLED: 'false' });
    expect(defaultConsumers(queuesOnly)).toEqual([]);
  });

  it.skipIf(!hasRedis)('start one BullMQ worker per queue and keep each schedule (redis-server)', async () => {
    const prefix = `t${randomBytes(4).toString('hex')}:`;
    const live = loadConfig({ ...baseEnv(), REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix, WORKER_ID: 'queues-test' });
    const admin = connect();
    const runtime = await startWorker(live, { logger: pino({ level: 'silent' }) });
    try {
      expect(runtime.workers.map((w) => w.name).sort()).toEqual([...queues].sort());
      for (const worker of runtime.workers) expect(worker.isRunning(), worker.name).toBe(true);
      // The write-behind consumers run too: each stream has the pg group once its consumer started.
      for (const stream of ['wb:like', 'wb:match']) {
        let groups: unknown[] = [];
        for (let i = 0; i < 100 && groups.length === 0; i += 1) {
          groups = (await admin.xinfo('GROUPS', `${prefix}${stream}`).catch(() => [])) as unknown[];
          if (groups.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(JSON.stringify(groups), stream).toContain('"pg"');
      }
      for (const definition of defaultQueues(live)) {
        if (!definition.schedules) continue;
        const queue = new Queue(definition.name, { connection: admin, prefix: queuePrefix(prefix) });
        try {
          for (const schedule of definition.schedules) expect(await queue.getJobScheduler(schedule.id), schedule.id).toBeTruthy();
        } finally {
          await queue.close();
        }
      }
    } finally {
      await runtime.stop();
      const keys = await admin.keys(`${prefix}*`);
      if (keys.length > 0) await admin.del(...keys);
      await admin.quit();
    }
  });
});
