import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobId, queueJobs, queueNames, queuePrefix, queueRetention, type ActiveQueueName } from '@app/shared/server';
import { Queue } from 'bullmq';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { callJobsOf, loadConfig, queueJob, type JobContext } from '../src/index.js';
import { addJob, closeQueues } from '../src/deck/enqueue.js';
import { closeSocialQueues } from '../src/social/jobs.js';
import type { WorkerServices } from '../src/services.js';
import { TEST_REDIS_URL, baseEnv, connect, hasRedis } from './support.js';

/**
 * Every BullMQ queue keeps finished jobs for a bounded time only (kv-core
 * is noeviction: kept jobs would fill it until every write, the chat
 * stream's included, is refused). The table itself, every producer path
 * of the worker read back from Valkey, and a guard that no source file
 * makes a queue of its own without the shared retention.
 */

const SOURCES = ['../src', '../../api/src'].map((p) => fileURLToPath(new URL(p, import.meta.url)));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('queue retention', () => {
  it('bounds every queue: completed pushes 10 minutes, other completed jobs an hour and 10,000, failed jobs a week and 50,000', () => {
    for (const name of queueNames) {
      const retention = queueRetention(name);
      expect(retention.removeOnFail, name).toEqual({ age: 604_800, count: 50_000 });
      expect(retention.removeOnComplete, name).toEqual(name === 'push' ? { age: 600 } : { age: 3_600, count: 10_000 });
    }
  });

  it('is applied by every source file that makes a BullMQ queue', () => {
    const makers = SOURCES.flatMap(sourceFiles).filter((file) => readFileSync(file, 'utf8').includes('new Queue('));
    expect(makers.length).toBeGreaterThanOrEqual(4);
    for (const file of makers) expect(readFileSync(file, 'utf8'), file).toMatch(/queueRetention\(/);
  });

  it.skipIf(!hasRedis)('is stored with every job each worker producer adds, for every job name of every queue (redis-server)', async () => {
    const prefix = `t${randomBytes(4).toString('hex')}:`;
    const config = loadConfig({ ...baseEnv(), REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix, WORKER_ID: 'retention-test' });
    const redis = connect();
    const context = { config, redis, log: pino({ level: 'silent' }), services: {} as WorkerServices } satisfies JobContext;
    const added: { queue: ActiveQueueName; id: string }[] = [];
    try {
      let n = 0;
      for (const queue of Object.keys(queueJobs) as ActiveQueueName[]) {
        for (const name of queueJobs[queue]) {
          const viaLater = jobId(name, 'later', ++n);
          await queueJob(redis, config.queuePrefix, { queue, name, id: viaLater, data: {}, delayMs: 60_000, attempts: 3, backoffMs: 1_000 });
          const viaDeck = jobId(name, 'deck', ++n);
          await addJob(redis, config.queuePrefix, queue, name, viaDeck, {}, { attempts: 2 });
          added.push({ queue, id: viaLater }, { queue, id: viaDeck });
        }
      }
      for (const name of queueJobs.calls) {
        const id = jobId(name, 'calls', ++n);
        await callJobsOf(context).add(name, id, {}, { delayMs: 60_000 });
        added.push({ queue: 'calls', id });
      }
      const queues = new Map<ActiveQueueName, Queue>();
      try {
        for (const { queue, id } of added) {
          let q = queues.get(queue);
          if (!q) {
            q = new Queue(queue, { connection: redis, prefix: queuePrefix(prefix) });
            queues.set(queue, q);
          }
          const job = await q.getJob(id);
          expect(job, `${queue}/${id}`).toBeTruthy();
          const retention = queueRetention(queue);
          expect(job!.opts.removeOnComplete, `${queue}/${id}`).toEqual(retention.removeOnComplete);
          expect(job!.opts.removeOnFail, `${queue}/${id}`).toEqual(retention.removeOnFail);
        }
      } finally {
        await Promise.allSettled([...queues.values()].map((q) => q.close()));
      }
      expect(added.length).toBeGreaterThan(40);
    } finally {
      await closeSocialQueues(redis);
      await closeQueues(redis);
      const keys = await redis.keys(`${prefix}*`);
      if (keys.length > 0) await redis.del(...keys);
      await redis.quit();
    }
  });
});
