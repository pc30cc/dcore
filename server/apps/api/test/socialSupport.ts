import { createPool, instrumentPool, statementCounter, type Pool } from '@app/db';
import { userChannel, type RealtimeEnvelope } from '@app/shared';
import { FakePushSender, type FakeRealtimePublisher } from '@app/shared/server';
import {
  closeSocialQueues,
  likeBatchHandler,
  loadConfig,
  matchEntryHandler,
  startBatchConsumer,
  startStreamConsumer,
  type JobContext,
  type LikeBatchStats,
  type MatchStats,
} from '@app/worker';
import { Redis } from 'ioredis';
import pino from 'pino';
import type { Harness } from './accountSupport.js';

/**
 * The worker's half of the swipe path, run in the test process against the
 * harness's database and Valkey prefix: the `wb:like` writer (batch mode) and
 * the `wb:match` consumer, with the same id keys as the API (events name
 * people by public id) and a fake Centrifugo shared with the API.
 */

export interface Pipeline {
  likes: LikeBatchStats;
  matches: MatchStats;
  context: JobContext;
  pool: Pool;
  push: FakePushSender;
  stop(): Promise<void>;
}

export async function startPipeline(h: Harness, realtime: FakeRealtimePublisher, options: { redisUrl?: string; graceMs?: number } = {}): Promise<Pipeline> {
  const redisUrl = options.redisUrl ?? h.app.config.redis.url;
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: h.db.url,
    REDIS_URL: redisUrl,
    REDIS_KEY_PREFIX: h.prefix,
    ID_PUBLIC_KEY: h.app.config.ids.publicKey,
    ID_BILLING_KEY: h.app.config.ids.billingKey,
    WORKER_ID: 'api-test-worker',
  });
  const pool = instrumentPool(createPool({ connectionString: h.db.url, applicationName: 'api-test-worker', max: 4 }), statementCounter);
  const shared = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const push = new FakePushSender();
  const context: JobContext = {
    config,
    redis: shared,
    log: pino({ level: 'silent' }),
    services: {
      pg: pool,
      cache: shared,
      ids: h.app.ids,
      keys: h.app.keys,
      publicIds: h.app.publicIds,
      realtime,
      media: null,
      photoModerator: { moderate: async () => ({ decision: 'review' }) } as never,
      push,
    },
  };
  const likes: LikeBatchStats = { batches: 0, rows: 0, inserted: 0, checked: 0, matched: 0 };
  const matches: MatchStats = { entries: 0, announced: 0, skipped: 0 };
  const connections = [new Redis(redisUrl, { maxRetriesPerRequest: null }), new Redis(redisUrl, { maxRetriesPerRequest: null })];
  const likeConsumer = startBatchConsumer({
    redis: connections[0]!,
    stream: h.app.keys.stream('like'),
    group: 'pg',
    consumer: 'api-test',
    blockMs: 100,
    claimIdleMs: 1_000,
    watermarkKey: h.app.keys.streamWatermark('like'),
    handler: likeBatchHandler(context, likes),
  });
  const matchConsumer = startStreamConsumer({
    redis: connections[1]!,
    stream: h.app.keys.stream('match'),
    group: 'pg',
    consumer: 'api-test',
    startId: '0',
    blockMs: 100,
    claimIdleMs: 1_000,
    concurrency: 8,
    handler: matchEntryHandler(context, { graceMs: options.graceMs ?? 200, stats: matches }),
  });
  return {
    likes,
    matches,
    context,
    pool,
    push,
    async stop() {
      await Promise.allSettled([likeConsumer.stop(), matchConsumer.stop()]);
      await closeSocialQueues(shared);
      await Promise.allSettled([...connections, shared].map((c) => c.quit()));
      await pool.end();
    },
  };
}

/** The events a person's channel received, of one type. */
export function eventsOf(realtime: FakeRealtimePublisher, publicUid: string, type: RealtimeEnvelope['t']): RealtimeEnvelope[] {
  return realtime.on(userChannel(publicUid)).filter((e) => e.t === type);
}
