import type { WorkerConfig } from '../config.js';
import { accountQueue } from './account.js';
import { maintQueue } from './maint.js';
import { photoQueue } from './photo.js';
import { systemQueue } from './system.js';
import type { QueueDefinition } from './types.js';

/**
 * Every queue this worker runs. Moderation, push, store reconciliation and
 * the card-deck builder are added here as they are built.
 */
export function defaultQueues(config: WorkerConfig): QueueDefinition[] {
  return [
    systemQueue,
    photoQueue(config.photos.concurrency),
    accountQueue(),
    ...(config.maint.enabled ? [maintQueue] : []),
  ];
}

export * from './account.js';
export * from './maint.js';
export * from './photo.js';
export * from './system.js';
export * from './types.js';
