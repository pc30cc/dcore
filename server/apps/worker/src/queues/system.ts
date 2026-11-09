import { ORIGINS_PUBLISH_EVERY_MS, runOriginsPublish } from '../origins/job.js';
import type { QueueDefinition } from './types.js';

export const SYSTEM_QUEUE = 'system';
export const HEARTBEAT_INTERVAL_MS = 30_000;

export interface Heartbeat {
  at: string;
  workerId: string;
}

/** The Redis key of the latest heartbeat (`<prefix>worker:heartbeat`). */
export function heartbeatKey(keyPrefix: string): string {
  return `${keyPrefix}worker:heartbeat`;
}

/**
 * The system queue:
 *
 * - `heartbeat`: a repeating job that writes when it last ran and on which
 *   worker. It proves the whole job pipeline works (scheduling, pick-up,
 *   processing), which a process-alive check does not; the admin dashboard
 *   reads the key. It expires after three missed beats.
 * - `origins-publish`: copies the newest signed origins document to the
 *   bootstrap targets (every ten minutes, and right after a save).
 */
export const systemQueue: QueueDefinition<Record<string, unknown>, unknown> = {
  name: SYSTEM_QUEUE,
  concurrency: 1,
  schedules: [
    { id: 'heartbeat', name: 'heartbeat', repeat: { every: HEARTBEAT_INTERVAL_MS } },
    { id: 'origins-publish', name: 'origins-publish', repeat: { every: ORIGINS_PUBLISH_EVERY_MS } },
  ],
  async process(job, context) {
    if (job.name === 'origins-publish') return runOriginsPublish(job.data, context);
    if (job.name !== 'heartbeat') throw new Error(`the system queue has no job named "${job.name}"`);
    const { config, redis } = context;
    const beat: Heartbeat = { at: new Date().toISOString(), workerId: config.workerId };
    await redis.set(heartbeatKey(config.redis.keyPrefix), JSON.stringify(beat), 'PX', HEARTBEAT_INTERVAL_MS * 3);
    return beat;
  },
};
