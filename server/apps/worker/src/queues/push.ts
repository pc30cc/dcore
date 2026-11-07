import { clearDeadPushToken, pushTargetsOf } from '@app/db';
import { notifyFlags, pushPayload, type PushPayload } from '@app/shared';
import { countPendingLikes } from '@app/shared/server';
import type { Job } from 'bullmq';
import { z } from 'zod';
import { likeText, matchText, pushLocale } from '../push/texts.js';
import type { JobContext, QueueDefinition } from './types.js';

/**
 * Pushes (queue `push`, job `send`): one job per push, with a deterministic
 * id (`send.<kind>.<...>`), so a second add while one waits is a no-op (a
 * like push waits half a minute and collapses a burst of likes into one).
 * The job reads where the push goes (one statement: the person's push
 * switches, language and devices with a live session), builds the text in
 * that language, sends it through FCM to each device and clears a token FCM
 * no longer knows. Nothing is stored about the push itself. A retryable
 * FCM failure fails the job, which BullMQ retries.
 */

export const PUSH_QUEUE = 'push';

const ID = z.string().regex(/^[1-9][0-9]{0,18}$/);

export const pushJobSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('like'), userId: ID }),
  z.object({ type: z.literal('match'), userId: ID, conversationId: ID, peerName: z.string().max(200).optional() }),
]);
export type PushJob = z.infer<typeof pushJobSchema>;

export type PushResult =
  | { outcome: 'sent'; devices: number; failed: number; cleared: number }
  | { outcome: 'skipped'; reason: 'no_sender' | 'no_account' | 'switched_off' | 'no_devices' | 'nothing_pending' };

const FLAG = { like: notifyFlags.code('likes'), match: notifyFlags.code('matches') } as const;
const PREVIEWS = notifyFlags.code('previews');

export class PushRetryError extends Error {
  constructor(failed: number) {
    super(`${failed} push(es) failed and may succeed later`);
    this.name = 'PushRetryError';
  }
}

export async function sendPushJob(job: Job, context: JobContext): Promise<PushResult> {
  const { services, log } = context;
  const data = pushJobSchema.parse(job.data);
  const sender = services.push;
  if (!sender) return { outcome: 'skipped', reason: 'no_sender' };
  let total = 0;
  if (data.type === 'like') {
    // Read now, not when the like was made: the push says how many are waiting.
    total = (await countPendingLikes(context.redis, services.keys, data.userId)).total;
    if (total === 0) return { outcome: 'skipped', reason: 'nothing_pending' };
  }
  const target = await pushTargetsOf(services.pg, data.userId);
  if (!target) return { outcome: 'skipped', reason: 'no_account' };
  if ((target.notifyFlags & FLAG[data.type]) === 0) return { outcome: 'skipped', reason: 'switched_off' };
  if (target.devices.length === 0) return { outcome: 'skipped', reason: 'no_devices' };
  const previews = (target.notifyFlags & PREVIEWS) !== 0;

  let failed = 0;
  let retry = 0;
  let cleared = 0;
  for (const device of target.devices) {
    const locale = pushLocale(device.locale ?? target.locale);
    const payload: PushPayload =
      data.type === 'like'
        ? pushPayload('like', { total: String(Math.min(total, 9_999_999_999)) }, { text: likeText(locale, total) })
        : pushPayload('match', { conversationId: data.conversationId }, { text: matchText(locale, previews, data.peerName) });
    const outcome = await sender.send(device.token, payload);
    if (outcome.ok) continue;
    failed += 1;
    if (outcome.unregistered) {
      if (await clearDeadPushToken(services.pg, device.id, device.token)) cleared += 1;
    } else if (outcome.retryable) {
      retry += 1;
    } else {
      log.warn({ status: outcome.status, error: outcome.error, type: data.type }, 'push refused');
    }
  }
  if (retry > 0) throw new PushRetryError(retry);
  return { outcome: 'sent', devices: target.devices.length, failed, cleared };
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
