import type { Job } from 'bullmq';
import { z } from 'zod';
import { refillDeck, type RefillResult } from '../deck/refill.js';
import type { QueueDefinition } from './types.js';

/**
 * The deck queue: `refill` builds or tops up a person's prepared deck
 * (`deck:<uid>` + `deckm:<uid>`, kv-cache). Queued by `GET /v1/deck` when
 * the queue runs low or is gone, with a job id per person and 30-second
 * slot, so a burst of requests queues one refill. See `deck/refill.ts`.
 */

export const DECK_QUEUE = 'deck';

export const refillDataSchema = z.object({
  userId: z.string().regex(/^[1-9][0-9]{0,18}$/),
  store: z.number().int().min(0).max(3).optional(),
});

export function deckQueue(concurrency?: number): QueueDefinition<unknown, RefillResult> {
  return {
    name: DECK_QUEUE,
    ...(concurrency !== undefined ? { concurrency } : {}),
    async process(job: Job<unknown, RefillResult>, context) {
      switch (job.name) {
        case 'refill':
          return refillDeck(context, refillDataSchema.parse(job.data));
        default:
          throw new Error(`the deck queue has no job named "${job.name}"`);
      }
    },
  };
}
