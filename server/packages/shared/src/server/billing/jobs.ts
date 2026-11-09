import { z } from 'zod';
import { jobId } from '../queues.js';

/**
 * The `iap` queue: what the purchase core asks the worker to do later, and
 * the shape of each job's data (the API and the worker both add them).
 *
 * - `ack.<purchaseId>`: acknowledge at the store until it is done, retried
 *   with growing gaps (30 s up to 30 min) and given up past the deadline
 *   (Play: 60 h after the purchase, inside its three days).
 * - `consume.<purchaseId>`: consume a credited consumable (Bazaar's
 *   `already_consumed` counts as done), with the same deadline from the
 *   store's time of the purchase.
 * - `recheck.<purchaseId>.<atMs>`: ask the store again at that time (Play: a
 *   missed notification; Bazaar: validUntil + 1 h, how renewals and expiries
 *   are learnt) and apply what it says; a failure is tried again until
 *   `untilMs` (default: a day after `atMs`), and the hourly sweep queues it
 *   again while the row's check stays overdue.
 * - `refund-check.<purchaseId>`: one more look at a purchase when its refund
 *   window closes (Bazaar: day 7); `atMs` is when it was due.
 * - `checks`: the hourly sweep (re-checks overdue in the database, owed
 *   acknowledgements and consumes of the last 60 hours).
 * - `revoke.<store>.<tokenHash>`: refund and revoke a purchase bound to no
 *   account of ours.
 * - `sub-end.<uid>.<store>.<atMs>`: recompute a subscription row when it
 *   expires (or a grant starts), tell the person.
 * - `rtdn.<messageId>`: a Play notification (the Play track's handler).
 * - `voided`: the daily Play voided-purchases sweep (the Play track's handler).
 */

const ID = z.string().regex(/^[1-9][0-9]{0,18}$/);
const STORE = z.enum(['play', 'bazaar']);

export const ackJobSchema = z.object({ purchaseId: ID, store: STORE, deadlineMs: z.number().int().positive(), tries: z.number().int().nonnegative().default(0) });
export type AckJob = z.input<typeof ackJobSchema>;

/** `deadlineMs` absent (a job queued before it was carried): the row's purchase time + 60 h. */
export const consumeJobSchema = z.object({ purchaseId: ID, store: STORE, deadlineMs: z.number().int().positive().optional(), tries: z.number().int().nonnegative().default(0) });
export type ConsumeJob = z.input<typeof consumeJobSchema>;

export const recheckJobSchema = z.object({ purchaseId: ID, store: STORE, atMs: z.number().int().positive(), untilMs: z.number().int().positive().optional() });
export type RecheckJob = z.input<typeof recheckJobSchema>;

/** `atMs` absent (a job queued before it was carried): the job's own time plus its delay. */
export const refundCheckJobSchema = z.object({ purchaseId: ID, store: STORE, atMs: z.number().int().positive().optional() });
export type RefundCheckJob = z.input<typeof refundCheckJobSchema>;

export const revokeJobSchema = z.object({
  store: STORE,
  kind: z.enum(['subscription', 'consumable']),
  productId: z.string().min(1).max(100),
  token: z.string().min(8).max(4096),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type RevokeJob = z.input<typeof revokeJobSchema>;

export const subEndJobSchema = z.object({ userId: ID, store: z.number().int().min(0).max(3), atMs: z.number().int().positive() });
export type SubEndJob = z.input<typeof subEndJobSchema>;

/** A Play RTDN as Pub/Sub pushed it: the base64 `data` and its time; the Play track decodes it. */
export const rtdnJobSchema = z.object({
  messageId: z.string().regex(/^[0-9A-Za-z_-]{1,100}$/),
  data: z.string().max(65_536),
  publishTime: z.string().max(64).optional(),
});
export type RtdnJob = z.input<typeof rtdnJobSchema>;

export type IapJobName = 'ack' | 'consume' | 'recheck' | 'refund-check' | 'revoke' | 'sub-end' | 'rtdn' | 'voided' | 'checks';

export interface IapJobOptions {
  delayMs?: number | undefined;
  attempts?: number | undefined;
  backoffMs?: number | undefined;
}

/** Where the core adds `iap` jobs: the API's job producer, or the worker's own queue. */
export interface IapJobSink {
  add(name: IapJobName, id: string, data: Record<string, unknown>, options?: IapJobOptions): Promise<void>;
}

export const iapJobIds = {
  ack: (purchaseId: string) => jobId('ack', purchaseId),
  consume: (purchaseId: string) => jobId('consume', purchaseId),
  recheck: (purchaseId: string, atMs: number) => jobId('recheck', purchaseId, atMs),
  refundCheck: (purchaseId: string) => jobId('refund-check', purchaseId),
  revoke: (store: 'play' | 'bazaar', hash: string) => jobId('revoke', store, hash),
  subEnd: (userId: string, store: number, atMs: number) => jobId('sub-end', userId, store, atMs),
  rtdn: (messageId: string) => jobId('rtdn', messageId),
};

/** Play's window to acknowledge is three days; the server stops trying at 60 hours. */
export const ACK_DEADLINE_MS = 60 * 3_600_000;
const FIRST_RETRY_MS = 30_000;
const MAX_RETRY_MS = 30 * 60_000;

/**
 * When an acknowledgement (or consume) that failed is tried again: 30 s,
 * then twice as long each time, at most 30 minutes apart, so a purchase is
 * tried well over a hundred times before the deadline; `give_up` once the
 * next try would come after it.
 */
export function retryPlan(tries: number, nowMs: number, deadlineMs: number): { action: 'retry'; atMs: number } | { action: 'give_up' } {
  const gap = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(tries, 16));
  const atMs = nowMs + gap;
  if (nowMs >= deadlineMs) return { action: 'give_up' };
  return { action: 'retry', atMs: Math.min(atMs, deadlineMs) };
}
