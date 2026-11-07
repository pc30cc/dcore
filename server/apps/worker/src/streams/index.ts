import { createKeys } from '@app/shared/server';
import type { WorkerConfig } from '../config.js';
import type { ConsumerDefinition } from '../worker.js';
import { likeBatchHandler } from './likes.js';
import { matchEntryHandler } from './matches.js';

/** The consumer group of the write-behind streams. */
export const WRITE_BEHIND_GROUP = 'pg';

/**
 * The stream consumers every worker runs (unless STREAMS_ENABLED is off):
 * `wb:like` in batch mode (one INSERT per batch of up to 500, 250 ms
 * linger, its watermark kept) and `wb:match` one entry at a time (a few
 * handlers at once: matches are rare, and each waits out a short grace).
 */
export function defaultConsumers(config: WorkerConfig): ConsumerDefinition[] {
  if (!config.streams.enabled) return [];
  const keys = createKeys(config.redis.keyPrefix);
  return [
    {
      kind: 'batch',
      stream: keys.stream('like'),
      group: WRITE_BEHIND_GROUP,
      deadLetterStream: keys.streamDead('like'),
      watermarkKey: keys.streamWatermark('like'),
      handler: (entries, context) => likeBatchHandler(context)(entries),
    },
    {
      stream: keys.stream('match'),
      group: WRITE_BEHIND_GROUP,
      deadLetterStream: keys.streamDead('match'),
      startId: '0',
      concurrency: 8,
      blockMs: 2_000,
      handler: (entry, context) => matchEntryHandler(context)(entry),
    },
  ];
}

export * from './batch.js';
export * from './likes.js';
export * from './matches.js';
