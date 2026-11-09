import { clearDeadPushToken } from '@app/db';
import type { PushPayload } from '@app/shared';
import type { PushSender } from '@app/shared/server';
import type { JobContext } from '../queues/types.js';

/**
 * Sending one push to a person's devices, and what FCM's answers mean for
 * each device: accepted, worth a retry later (429, 5xx, the network), dead
 * (the token is cleared on its row, so nothing is sent to it again), or
 * refused for another reason (logged by status only; a push token never
 * reaches a log).
 */

export interface PushDevice {
  id: string;
  token: string;
  locale?: string | null | undefined;
}

export interface Delivery {
  /** Devices FCM accepted the push for. */
  sent: string[];
  /** Devices whose push may still succeed (a later attempt sends to these only). */
  retry: string[];
  /** Devices whose token was dead and is now cleared. */
  cleared: number;
  /** Devices FCM refused for good for another reason. */
  refused: number;
}

/**
 * A token FCM no longer knows: cleared on its device row (only while the row
 * still holds that token), and the device's cached registration fingerprint
 * dropped, so the app's next report writes again instead of being taken
 * for "unchanged". Never throws: a token left behind is found dead again by
 * the next push.
 */
export async function releaseDeadToken(context: Pick<JobContext, 'services' | 'redis' | 'log'>, deviceId: string, token: string): Promise<boolean> {
  const { services, redis, log } = context;
  let cleared: boolean;
  try {
    cleared = await clearDeadPushToken(services.pg, deviceId, token);
  } catch (error) {
    log.warn({ err: error, deviceId }, 'push: a dead token could not be cleared');
    return false;
  }
  await redis.del(services.keys.device(deviceId)).catch((error: unknown) => log.warn({ err: error, deviceId }, 'push: device fingerprint not dropped'));
  return cleared;
}

/**
 * Sends `payloadOf(device)` to every device not in `skip`, all at once (a
 * person has a handful). Never throws for an FCM answer.
 */
export async function deliverPush(
  context: Pick<JobContext, 'services' | 'redis' | 'log'>,
  sender: PushSender,
  devices: readonly PushDevice[],
  payloadOf: (device: PushDevice) => PushPayload,
  skip: ReadonlySet<string> = new Set(),
): Promise<Delivery> {
  const delivery: Delivery = { sent: [], retry: [], cleared: 0, refused: 0 };
  await Promise.all(
    devices
      .filter((device) => !skip.has(device.id))
      .map(async (device) => {
        const payload = payloadOf(device);
        const outcome = await sender.send(device.token, payload);
        if (outcome.ok) {
          delivery.sent.push(device.id);
        } else if (outcome.unregistered) {
          if (await releaseDeadToken(context, device.id, device.token)) delivery.cleared += 1;
        } else if (outcome.retryable) {
          delivery.retry.push(device.id);
        } else {
          delivery.refused += 1;
          context.log.warn({ status: outcome.status, error: outcome.error, type: payload.type }, 'push refused');
        }
      }),
  );
  return delivery;
}
