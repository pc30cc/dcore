import { callsQueue } from '../calls/queue.js';
import type { WorkerConfig } from '../config.js';
import { accountQueue } from './account.js';
import { chatQueue } from './chat.js';
import { deckQueue } from './deck.js';
import { iapQueue } from './iap.js';
import { maintQueue } from './maint.js';
import { photoQueue } from './photo.js';
import { pushQueue } from './push.js';
import { safetyQueue } from './safety.js';
import { systemQueue } from './system.js';
import type { QueueDefinition } from './types.js';

/**
 * Every queue this worker runs (the queues of the shared `queueJobs` table).
 * Moderation, store reconciliation, campaigns and stats are added here as
 * they are built.
 */
export function defaultQueues(config: WorkerConfig): QueueDefinition[] {
  return [
    systemQueue,
    photoQueue(config.photos.concurrency),
    accountQueue(),
    deckQueue(),
    pushQueue,
    callsQueue(),
    chatQueue,
    safetyQueue,
    iapQueue(),
    ...(config.maint.enabled ? [maintQueue] : []),
  ];
}

export * from '../calls/queue.js';
export * from '../export/job.js';
export * from '../export/zip.js';
export * from './account.js';
export * from './chat.js';
export * from './deck.js';
export * from './evidence.js';
export * from './iap.js';
export * from '../iap/core.js';
export { PlayJobs } from '../iap/play.js';
export * from '../iap/verifiers.js';
export * from './maint.js';
export * from './photo.js';
export * from './push.js';
export * from './safety.js';
export * from './system.js';
export * from './types.js';
