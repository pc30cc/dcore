import { systemQueue } from './system.js';
import type { QueueDefinition } from './types.js';

/**
 * Every queue this worker runs. Photo processing, moderation, push, store
 * reconciliation and the card-deck builder are added here as they are built.
 */
export const queues: readonly QueueDefinition[] = [systemQueue];

export * from './system.js';
export * from './types.js';
