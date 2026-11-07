import { z } from 'zod';
import { DECK_LOCK_MS } from './deck/queue.js';
import { jobId } from './queues.js';

/**
 * The `safety` queue's jobs, as their producers (the API, the worker) add
 * them and the worker runs them:
 *
 * - `moderation-end` (`moderation-end.<actionId>`, delayed to the action's
 *   end): a suspension, timed ban or shadowban whose period is over; the
 *   account is settled (`moderation_settle()`) and the Valkey and realtime
 *   side follows. An action lifted before its end makes it a no-op.
 * - `moderation-sweep` (scheduled, under a lease): ends that were missed
 *   (a lost job) are queued again.
 * - `block-deck` (`block-deck.<lo>.<hi>.<slot>`, a refill guard's life
 *   later): a block whose pair had a deck refill running drops the two from
 *   each other's queue once more, since that refill read its candidates
 *   before the block and may write one of them back.
 */

export const SAFETY_QUEUE = 'safety' as const;

export const safetyJobNames = {
  moderationEnd: 'moderation-end',
  moderationSweep: 'moderation-sweep',
  blockDeck: 'block-deck',
} as const;

const id = z.string().regex(/^[1-9][0-9]{0,18}$/);

export const moderationEndDataSchema = z.object({
  actionId: id,
  userId: id,
  /** Realtime event ids, planned once so a retried publish is delivered once. */
  eventIds: z.record(z.string(), id).optional(),
});
export type ModerationEndData = z.infer<typeof moderationEndDataSchema>;

export const blockDeckDataSchema = z.object({ a: id, b: id });
export type BlockDeckData = z.infer<typeof blockDeckDataSchema>;

/** A refill guard lives 30 s; the second drop comes after it, when that refill has written or given up. */
export const BLOCK_DECK_DELAY_MS = DECK_LOCK_MS + 2_000;

export const safetyJobIds = {
  moderationEnd: (actionId: string) => jobId(safetyJobNames.moderationEnd, actionId),
  /** One per pair per 30-second slot (a later block of the same pair gets its own). */
  blockDeck: (a: string, b: string, now: number = Date.now()) => {
    const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
    return jobId(safetyJobNames.blockDeck, lo, hi, Math.floor(now / 30_000));
  },
};

export const safetyJobAttempts = {
  moderationEnd: { attempts: 8, backoffMs: 15_000 },
  blockDeck: { attempts: 3, backoffMs: 5_000 },
} as const;
