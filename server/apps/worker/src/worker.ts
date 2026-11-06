import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { WorkerConfig } from './config.js';
import { queues as defaultQueues, type JobContext, type QueueDefinition } from './queues/index.js';
import { createWorkerRedis } from './redis.js';
import { startStreamConsumer, type StreamConsumer, type StreamConsumerOptions, type StreamDelivery } from './streams/consumer.js';

/** A Redis Streams consumer this process runs (chat fan-out, presence and the like). */
export interface StreamConsumerDefinition
  extends Omit<StreamConsumerOptions, 'redis' | 'consumer' | 'handler' | 'log'> {
  handler(entry: StreamDelivery, context: JobContext): Promise<void>;
}

export interface WorkerRuntimeOptions {
  logger: Logger;
  queues?: readonly QueueDefinition[] | undefined;
  consumers?: readonly StreamConsumerDefinition[] | undefined;
}

export interface WorkerRuntime {
  /** Stops taking work, waits for what is running, closes connections. */
  stop(): Promise<void>;
}

export async function startWorker(config: WorkerConfig, options: WorkerRuntimeOptions): Promise<WorkerRuntime> {
  const { logger } = options;
  const definitions = options.queues ?? defaultQueues;
  const consumerDefinitions = options.consumers ?? [];

  // One shared connection for processors and producers; BullMQ adds a
  // blocking connection per worker by duplicating it.
  const shared = createWorkerRedis(config.redis.url, `worker:${config.workerId}`);
  shared.on('error', (error: Error) => logger.warn({ err: error }, 'redis connection error'));
  const context: JobContext = { config, redis: shared, log: logger };

  const workers: Worker[] = [];
  const schedulerQueues: Queue[] = [];
  const consumers: StreamConsumer[] = [];
  const consumerConnections: Redis[] = [];

  for (const definition of definitions) {
    const worker = new Worker(definition.name, async (job) => definition.process(job, { ...context, log: logger.child({ queue: definition.name, jobId: job.id, job: job.name }) }), {
      connection: shared,
      prefix: config.queuePrefix,
      concurrency: definition.concurrency ?? config.concurrency,
      name: config.workerId,
      // Finished jobs are evidence for a short while, then they make room.
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 3_600, count: 10_000 },
    });
    worker.on('failed', (job, error) =>
      logger.error({ err: error, queue: definition.name, jobId: job?.id, job: job?.name, attempts: job?.attemptsMade }, 'job failed'),
    );
    worker.on('error', (error) => logger.error({ err: error, queue: definition.name }, 'queue worker error'));
    workers.push(worker);

    if (definition.schedules && definition.schedules.length > 0) {
      const queue = new Queue(definition.name, { connection: shared, prefix: config.queuePrefix });
      for (const schedule of definition.schedules) {
        await queue.upsertJobScheduler(schedule.id, schedule.repeat, {
          name: schedule.name,
          data: schedule.data ?? {},
          opts: { removeOnComplete: true, removeOnFail: 100 },
        });
      }
      schedulerQueues.push(queue);
    }
  }

  for (const definition of consumerDefinitions) {
    // The blocking read needs a connection of its own.
    const connection = shared.duplicate({ connectionName: `stream:${definition.stream}:${config.workerId}` });
    consumerConnections.push(connection);
    const log = logger.child({ stream: definition.stream, group: definition.group });
    consumers.push(
      startStreamConsumer({
        ...definition,
        redis: connection,
        consumer: config.workerId,
        log,
        handler: (entry) => definition.handler(entry, { ...context, log }),
      }),
    );
  }

  logger.info(
    { queues: definitions.map((q) => q.name), streams: consumerDefinitions.map((c) => c.stream) },
    'worker started',
  );

  let stopping: Promise<void> | undefined;
  return {
    stop() {
      stopping ??= (async () => {
        // Workers finish their active jobs before close() resolves.
        await Promise.allSettled([...workers.map((w) => w.close()), ...consumers.map((c) => c.stop())]);
        await Promise.allSettled(schedulerQueues.map((q) => q.close()));
        await Promise.allSettled([...consumerConnections, shared].map((c) => c.quit()));
        logger.info('worker stopped');
      })();
      return stopping;
    },
  };
}
