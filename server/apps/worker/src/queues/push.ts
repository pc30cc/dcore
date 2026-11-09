import { pushTargetsOf } from '@app/db';
import { idTime, notifyFlags, pushPayload, type PushPayload } from '@app/shared';
import { chatKeys, countPendingLikes } from '@app/shared/server';
import { DelayedError, type Job } from 'bullmq';
import { z } from 'zod';
import { deliverPush, type PushDevice } from '../push/deliver.js';
import { likeText, matchText, messageText, pushLocale, requestText } from '../push/texts.js';
import type { JobContext, QueueDefinition } from './types.js';

/**
 * Pushes (queue `push`, job `send`): one job per push, with a deterministic
 * id (`send.<kind>.<...>`), so a second add while one waits or runs is a
 * no-op (a like push waits half a minute and collapses a burst of likes into
 * one; a burst of messages is collapsed before its job is added, by the
 * sender's `push:m:` window). The job reads where the push goes (one
 * statement: the person's push switches, language and devices with a live
 * session), builds the text in each device's language and sends it through
 * FCM. Nothing is stored about the push itself.
 *
 * - A message push waits until its message is MESSAGE_PUSH_SETTLE_MS old,
 *   then looks again: no push while the person has that conversation on
 *   screen (`view:<uid>`, set by the app's read receipts), once they read
 *   past it on another device, or once the conversation ended. A push left
 *   out that way gives its `push:m:` window back, so the next message after
 *   the person looked away is pushed.
 * - Retries go only to the devices FCM did not take yet (the job records
 *   the ones it did), so a retry never alerts a phone twice. Whatever makes
 *   the last attempt fail (FCM, PostgreSQL or Valkey away), the text a push
 *   would have shown and the names in it are dropped from the job before it
 *   is kept as failed.
 * - A dead token is cleared on its device row (`deliverPush`).
 */

export const PUSH_QUEUE = 'push';

/** A message push waits this long after its message, so a reader who has the thread on screen is not pushed. */
export const MESSAGE_PUSH_SETTLE_MS = 1_500;

const ID = z.string().regex(/^[1-9][0-9]{0,18}$/);

export const pushJobSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('like'), userId: ID }),
  z.object({ type: z.literal('match'), userId: ID, conversationId: ID, peerName: z.string().max(200).optional() }),
  z.object({
    type: z.literal('message'),
    userId: ID,
    conversationId: ID,
    messageId: ID,
    senderName: z.string().max(200).optional(),
    preview: z.string().max(400).optional(),
  }),
  z.object({ type: z.literal('request'), userId: ID, requestId: ID }),
]);
export type PushJob = z.infer<typeof pushJobSchema>;

/** What a job keeps of its own progress: the devices FCM already took. */
const progressSchema = z.object({ sent: z.array(ID).max(256).optional() });

export type PushSkipReason = 'no_sender' | 'no_account' | 'switched_off' | 'no_devices' | 'nothing_pending' | 'viewing' | 'read' | 'ended';

export type PushResult =
  | { outcome: 'sent'; devices: number; failed: number; cleared: number }
  | { outcome: 'skipped'; reason: PushSkipReason };

/** What the processor needs of BullMQ's job (tests pass a stand-in). */
export type PushJobRun = Pick<Job, 'name' | 'data'> & Partial<Pick<Job, 'attemptsMade' | 'opts' | 'moveToDelayed' | 'updateData'>>;

export interface PushJobOptions {
  /** The clock of the settle wait (tests move it). */
  now?: (() => number) | undefined;
  settleMs?: number | undefined;
}

const FLAG = {
  like: notifyFlags.code('likes'),
  match: notifyFlags.code('matches'),
  message: notifyFlags.code('messages'),
  request: notifyFlags.code('messages'),
} as const;
const PREVIEWS = notifyFlags.code('previews');

export class PushRetryError extends Error {
  constructor(failed: number) {
    super(`${failed} push(es) failed and may succeed later`);
    this.name = 'PushRetryError';
  }
}

function newer(a: string, b: string): boolean {
  return a.length !== b.length ? a.length > b.length : a > b;
}

/**
 * Whether a message push is still due, from Valkey only: the conversation
 * has not ended, the person does not have it on screen and has not read
 * past the message. When it is not due, the person's `push:m:` window of
 * the conversation is given back.
 */
async function messageStillDue(context: JobContext, data: Extract<PushJob, { type: 'message' }>): Promise<'due' | 'viewing' | 'read' | 'ended'> {
  const { redis, services } = context;
  const c = chatKeys(services.keys);
  const replies = await redis
    .pipeline()
    .exists(services.keys.matchEnded(data.conversationId))
    .get(c.viewing(data.userId))
    .hmget(services.keys.matchState(data.conversationId), 'lo', 'hi')
    .hmget(c.readPointers(data.conversationId), 'lo', 'hi')
    .exec();
  const failed = replies?.find(([error]) => error !== null)?.[0];
  if (!replies || failed) throw failed ?? new Error('the push re-check got no answer');
  const ended = replies[0]![1] === 1;
  const viewing = replies[1]![1] as string | null;
  const [lo, hi] = replies[2]![1] as (string | null)[];
  const [readLo, readHi] = replies[3]![1] as (string | null)[];
  let verdict: 'due' | 'viewing' | 'read' | 'ended' = 'due';
  if (ended) verdict = 'ended';
  else if (viewing === data.conversationId) verdict = 'viewing';
  else {
    const read = data.userId === lo ? readLo : data.userId === hi ? readHi : null;
    if (read && !newer(data.messageId, read)) verdict = 'read';
  }
  if (verdict === 'viewing' || verdict === 'read') {
    await redis.del(c.messagePush(data.conversationId, data.userId)).catch((error: unknown) => context.log.warn({ err: error }, 'push: collapse window not given back'));
  }
  return verdict;
}

/** The job data's words a push would have shown: never kept with a job that failed for good. */
export const PUSH_TEXT_FIELDS = ['preview', 'senderName', 'peerName', 'peerPhotoUrl'] as const;

/**
 * Runs a push job's attempt; when it fails and no attempt is left (and it was
 * not merely put off), the words it carries are dropped from the job first,
 * so the failed set keeps no message text, name or photo link.
 */
export async function dropTextOnLastFailure<T>(
  job: Partial<Pick<Job, 'attemptsMade' | 'opts' | 'updateData'>> & Pick<Job, 'data'>,
  log: JobContext['log'],
  attempt: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    const last = (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1);
    const data = job.data as Record<string, unknown> | null;
    if (last && !(error instanceof DelayedError) && job.updateData && data && PUSH_TEXT_FIELDS.some((field) => field in data)) {
      const next: Record<string, unknown> = { ...data };
      for (const field of PUSH_TEXT_FIELDS) delete next[field];
      await job.updateData(next).catch((e: unknown) => log.warn({ err: e }, 'push: its text was not dropped from the failed job'));
    }
    throw error;
  }
}

export function sendPushJob(job: PushJobRun, context: JobContext, options: PushJobOptions = {}): Promise<PushResult> {
  return dropTextOnLastFailure(job, context.log, () => sendPushOnce(job, context, options));
}

async function sendPushOnce(job: PushJobRun, context: JobContext, options: PushJobOptions): Promise<PushResult> {
  const { services, log } = context;
  const data = pushJobSchema.parse(job.data);
  const progress = progressSchema.safeParse(job.data);
  const sentBefore = new Set(progress.success ? (progress.data.sent ?? []) : []);
  const sender = services.push;
  if (!sender) return { outcome: 'skipped', reason: 'no_sender' };

  let total = 0;
  if (data.type === 'like') {
    // Read now, not when the like was made: the push says how many are waiting.
    total = (await countPendingLikes(context.redis, services.keys, data.userId)).total;
    if (total === 0) return { outcome: 'skipped', reason: 'nothing_pending' };
  }
  if (data.type === 'message') {
    const settleMs = options.settleMs ?? MESSAGE_PUSH_SETTLE_MS;
    const now = (options.now ?? Date.now)();
    const wait = Math.min(idTime(data.messageId).getTime() + settleMs - now, settleMs);
    if (wait > 0 && job.moveToDelayed && context.token) {
      await job.moveToDelayed(Date.now() + wait, context.token);
      throw new DelayedError();
    }
    const verdict = await messageStillDue(context, data);
    if (verdict !== 'due') return { outcome: 'skipped', reason: verdict };
  }

  const target = await pushTargetsOf(services.pg, data.userId);
  if (!target) return { outcome: 'skipped', reason: 'no_account' };
  if ((target.notifyFlags & FLAG[data.type]) === 0) return { outcome: 'skipped', reason: 'switched_off' };
  if (target.devices.length === 0) return { outcome: 'skipped', reason: 'no_devices' };
  const previews = (target.notifyFlags & PREVIEWS) !== 0;

  const payloadOf = (device: PushDevice): PushPayload => {
    const locale = pushLocale(device.locale ?? target.locale);
    switch (data.type) {
      case 'like':
        return pushPayload('like', { total: String(Math.min(total, 9_999_999_999)) }, { text: likeText(locale, total) });
      case 'match':
        return pushPayload('match', { conversationId: data.conversationId }, { text: matchText(locale, previews, data.peerName) });
      case 'message':
        return pushPayload(
          'message',
          { conversationId: data.conversationId, messageId: data.messageId },
          { text: messageText(locale, previews, data.senderName, data.preview) },
        );
      case 'request':
        return pushPayload('request', { requestId: data.requestId }, { text: requestText(locale) });
    }
  };

  const considered = target.devices.filter((device) => !sentBefore.has(device.id)).length;
  const delivery = await deliverPush(context, sender, target.devices, payloadOf, sentBefore);
  if (delivery.retry.length > 0) {
    const sent = [...sentBefore, ...delivery.sent];
    const next: Record<string, unknown> = { ...(job.data as Record<string, unknown>), sent };
    // On the last attempt the words go too, as the failure is thrown (dropTextOnLastFailure).
    if (job.updateData) await job.updateData(next).catch((error: unknown) => log.warn({ err: error }, 'push: progress not recorded'));
    throw new PushRetryError(delivery.retry.length);
  }
  return { outcome: 'sent', devices: target.devices.length, failed: considered - delivery.sent.length, cleared: delivery.cleared };
}

export const pushQueue: QueueDefinition<unknown, PushResult> = {
  name: PUSH_QUEUE,
  async process(job, context) {
    switch (job.name) {
      case 'send':
        return sendPushJob(job, context);
      default:
        throw new Error(`the push queue has no job named "${job.name}"`);
    }
  },
};
