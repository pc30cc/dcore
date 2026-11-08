import { isDataError, isTransientDatabaseError } from '@app/db';
import { createKeys, StreamEntryError } from '@app/shared/server';
import type { WorkerConfig } from '../config.js';
import type { JobContext } from '../queues/types.js';
import type { ConsumerDefinition } from '../worker.js';
import type { ErrorKind } from './consumer.js';
import { likeBatchHandler } from './likes.js';
import { matchEntryHandler } from './matches.js';

/** The consumer group of the write-behind streams. */
export const WRITE_BEHIND_GROUP = 'pg';

/** A write-behind entry delivered more often than this is logged as an error on every further delivery. */
export const WRITE_BEHIND_ALERT_DELIVERIES = 10;

/**
 * What a write-behind handler's failure means: PostgreSQL unreachable or
 * refusing connections is an outage (wait, give nothing up); a malformed
 * entry, or a row the database refuses for its data (class 22 or 23), can
 * never be written (dead-letter it); anything else is retried.
 */
export function classifyWriteBehindError(error: unknown): ErrorKind {
  if (isTransientDatabaseError(error)) return 'unavailable';
  if (error instanceof StreamEntryError || isDataError(error)) return 'rejected';
  return 'failed';
}

/** One statement that succeeds once PostgreSQL takes work again. */
export async function probeDatabase(context: JobContext): Promise<void> {
  await context.services.pg.query('SELECT 1');
}

/**
 * The stream consumers every worker runs (unless STREAMS_ENABLED is off):
 * `wb:like` in batch mode (one INSERT per batch of up to 500, 250 ms
 * linger, its watermark kept) and `wb:match` one entry at a time (a few
 * handlers at once: matches are rare, and each waits out a short grace).
 *
 * Neither ever dead-letters an entry for its delivery count alone (a like
 * or a match is user data; one that keeps failing is logged as an error on
 * each delivery past {@link WRITE_BEHIND_ALERT_DELIVERIES}), and a database
 * outage only pauses them. Dead letters keep no like comment.
 */
export function defaultConsumers(config: WorkerConfig): ConsumerDefinition[] {
  if (!config.streams.enabled) return [];
  const keys = createKeys(config.redis.keyPrefix);
  const failures = {
    classify: classifyWriteBehindError,
    probe: probeDatabase,
    maxDeliveries: 0,
    alertDeliveries: WRITE_BEHIND_ALERT_DELIVERIES,
    redactFields: ['c'],
  } as const;
  return [
    {
      kind: 'batch',
      stream: keys.stream('like'),
      group: WRITE_BEHIND_GROUP,
      deadLetterStream: keys.streamDead('like'),
      watermarkKey: keys.streamWatermark('like'),
      ...failures,
      handler: (entries, context) => likeBatchHandler(context)(entries),
    },
    {
      stream: keys.stream('match'),
      group: WRITE_BEHIND_GROUP,
      deadLetterStream: keys.streamDead('match'),
      startId: '0',
      concurrency: 8,
      blockMs: 2_000,
      ...failures,
      handler: (entry, context) => matchEntryHandler(context)(entry),
    },
  ];
}

export * from './batch.js';
export * from './likes.js';
export * from './matches.js';
