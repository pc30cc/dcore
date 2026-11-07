import type { WorkerConfig } from '../config.js';
import { accountQueue } from './account.js';
import { chatQueue } from './chat.js';
import { deckQueue } from './deck.js';
import { maintQueue } from './maint.js';
import { photoQueue } from './photo.js';
import { pushQueue } from './push.js';
import { safetyQueue } from './safety.js';
import { systemQueue } from './system.js';
import type { QueueDefinition } from './types.js';

/**
 * Every queue this worker runs (the queues of the shared `queueJobs` table).
 * Moderation, calls, store reconciliation and the others are added here as
 * they are built.
 */
export function defaultQueues(config: WorkerConfig): QueueDefinition[] {
  return [
    systemQueue,
    photoQueue(config.photos.concurrency),
    accountQueue(),
    deckQueue(),
    pushQueue,
    chatQueue,
    safetyQueue,
    ...(config.maint.enabled ? [maintQueue] : []),
  ];
}

export * from './account.js';
export * from './chat.js';
export * from './deck.js';
export * from './maint.js';
export * from './photo.js';
export * from './push.js';
export * from './safety.js';
export * from './system.js';
export * from './types.js';
