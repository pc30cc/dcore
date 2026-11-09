import { createPool, instrumentPool, statementCounter, type Pool } from '@app/db';
import { idTime, userChannel, type RealtimeEnvelope } from '@app/shared';
import { announceMatch, FakePushSender, type FakeRealtimePublisher } from '@app/shared/server';
import {
  WRITE_BEHIND_ALERT_DELIVERIES,
  classifyWriteBehindError,
  closeSocialQueues,
  loadConfig,
  messageBatchHandler,
  probeDatabase,
  startBatchConsumer,
  type BatchConsumer,
  type JobContext,
  type MessageBatchStats,
} from '@app/worker';
import type { Job } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import type { Harness } from './accountSupport.js';

/**
 * The worker's half of the chat, run in the test process against the
 * harness's database and Valkey prefix: the `wb:msg` writer at test timings
 * (its failure handling as the worker's), and a job context for the chat
 * and safety jobs a test runs by hand.
 */

export interface ChatPipeline {
  stats: MessageBatchStats;
  context: JobContext;
  pool: Pool;
  /** Starts the writer (again, after `pause`). */
  resume(): void;
  /** Stops the writer; what is appended meanwhile stays in the stream. */
  pause(): Promise<void>;
  stop(): Promise<void>;
}

export async function startChatPipeline(
  h: Harness,
  realtime: FakeRealtimePublisher,
  options: { databaseUrl?: string; start?: boolean; claimIdleMs?: number } = {},
): Promise<ChatPipeline> {
  const redisUrl = h.app.config.redis.url;
  const databaseUrl = options.databaseUrl ?? h.db.url;
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    REDIS_KEY_PREFIX: h.prefix,
    ID_PUBLIC_KEY: h.app.config.ids.publicKey,
    ID_BILLING_KEY: h.app.config.ids.billingKey,
    WORKER_ID: 'chat-test-worker',
  });
  const pool = instrumentPool(createPool({ connectionString: databaseUrl, applicationName: 'chat-test-worker', max: 4, connectTimeoutMs: 1_000 }), statementCounter);
  const shared = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const context: JobContext = {
    config,
    redis: shared,
    log: pino({ level: 'silent' }),
    token: 'test-token',
    services: {
      pg: pool,
      cache: shared,
      ids: h.app.ids,
      keys: h.app.keys,
      publicIds: h.app.publicIds,
      realtime,
      media: null,
      photoModerator: { moderate: async () => ({ decision: 'review' }) } as never,
      push: new FakePushSender(),
    },
  };
  const stats: MessageBatchStats = { batches: 0, rows: 0, inserted: 0, statements: 0 };
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  let consumer: BatchConsumer | null = null;
  const resume = () => {
    if (consumer) return;
    consumer = startBatchConsumer({
      redis: connection,
      stream: h.app.keys.stream('msg'),
      group: 'pg',
      consumer: 'chat-test',
      blockMs: 100,
      claimIdleMs: options.claimIdleMs ?? 1_000,
      watermarkKey: h.app.keys.streamWatermark('msg'),
      classify: classifyWriteBehindError,
      probe: () => probeDatabase(context),
      maxDeliveries: 0,
      alertDeliveries: WRITE_BEHIND_ALERT_DELIVERIES,
      redactFields: ['b'],
      handler: messageBatchHandler(context, stats),
    });
  };
  if (options.start !== false) resume();
  return {
    stats,
    context,
    pool,
    resume,
    async pause() {
      const current = consumer;
      consumer = null;
      await current?.stop();
    },
    async stop() {
      const current = consumer;
      consumer = null;
      await current?.stop();
      await closeSocialQueues(shared);
      await Promise.allSettled([connection.quit(), shared.quit()]);
      await pool.end();
    },
  };
}

/** A match between two seeded people, as the swipe path leaves it: the row and its Valkey state. */
export async function matchOf(h: Harness, a: string, b: string, options: { flags?: number } = {}): Promise<{ id: string; lo: string; hi: string }> {
  const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  const id = h.app.ids.nextId();
  const flags = options.flags ?? 3;
  await h.db.sql.query(`INSERT INTO matches (id, user_lo, user_hi, source, flags) VALUES ($1, $2, $3, 1, $4)`, [id, lo, hi, flags]);
  await announceMatch(h.app.redis, h.app.keys, { id, lo, hi, state: 1, flags, source: 1, createdMs: idTime(id).getTime() });
  return { id, lo, hi };
}

/** The events a person's channel received, of one type. */
export function eventsOf(realtime: FakeRealtimePublisher, publicUid: string, type: RealtimeEnvelope['t']): RealtimeEnvelope[] {
  return realtime.on(userChannel(publicUid)).filter((e) => e.t === type);
}

type FakeJob<T> = Job<T> & { delayedUntil?: number };

/** A job object for running a processor by hand. */
export function fakeJob<T>(name: string, data: T): FakeJob<T> {
  const job = {
    name,
    data,
    id: `${name}.test`,
    async moveToDelayed(timestamp: number) {
      job.delayedUntil = timestamp;
    },
  } as unknown as FakeJob<T>;
  return job;
}

export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
