import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Google Play's real-time developer notifications as Pub/Sub pushes them:
 * `{ message: { data: <base64 DeveloperNotification>, messageId, publishTime, attributes }, subscription }`
 * (Pub/Sub also sends the snake_case `message_id` and `publish_time`).
 *
 * A notification only says that a purchase changed; the state is always read
 * from the Developer API. `eventTimeMillis` is a decimal string in Google's
 * examples and a number in its field table: both are read.
 */

export const pubsubPushSchema = z
  .object({
    message: z
      .object({
        data: z.string().max(65_536).default(''),
        messageId: z.string().max(200).optional(),
        message_id: z.string().max(200).optional(),
        publishTime: z.string().max(64).optional(),
        publish_time: z.string().max(64).optional(),
        attributes: z.record(z.string(), z.string()).optional(),
      })
      .loose(),
    subscription: z.string().max(500).optional(),
  })
  .loose();
export type PubSubPush = z.infer<typeof pubsubPushSchema>;

const MESSAGE_ID = /^[0-9A-Za-z_-]{1,100}$/;

/** The push's message id, or (never seen from Pub/Sub) a hash of its data, in the shape job ids allow. */
export function pushMessageId(push: PubSubPush): string {
  const id = push.message.messageId ?? push.message.message_id;
  if (id !== undefined && MESSAGE_ID.test(id)) return id;
  return `h${createHash('sha256').update(push.message.data).digest('hex').slice(0, 40)}`;
}

const token = z.string().min(8).max(4096);
const millis = z.union([z.number().int().nonnegative(), z.string().regex(/^[0-9]{1,16}$/).transform(Number)]);

export const developerNotificationSchema = z
  .object({
    version: z.string().max(20).optional(),
    packageName: z.string().min(1).max(255),
    eventTimeMillis: millis.optional(),
    subscriptionNotification: z.object({ version: z.string().max(20).optional(), notificationType: z.number().int(), purchaseToken: token }).loose().optional(),
    oneTimeProductNotification: z
      .object({ version: z.string().max(20).optional(), notificationType: z.number().int(), purchaseToken: token, sku: z.string().max(200).optional() })
      .loose()
      .optional(),
    voidedPurchaseNotification: z
      .object({ purchaseToken: token, orderId: z.string().max(200).optional(), productType: z.number().int().optional(), refundType: z.number().int().optional() })
      .loose()
      .optional(),
    pendingRefundReviewNotification: z.object({ orderId: z.string().max(200).optional() }).loose().optional(),
    testNotification: z.object({ version: z.string().max(20).optional() }).loose().optional(),
  })
  .loose();
export type DeveloperNotification = z.infer<typeof developerNotificationSchema>;

/** SubscriptionNotification.notificationType values. */
export const subscriptionNotificationType = {
  RECOVERED: 1,
  RENEWED: 2,
  CANCELED: 3,
  PURCHASED: 4,
  ON_HOLD: 5,
  IN_GRACE_PERIOD: 6,
  RESTARTED: 7,
  PRICE_CHANGE_CONFIRMED: 8,
  DEFERRED: 9,
  PAUSED: 10,
  PAUSE_SCHEDULE_CHANGED: 11,
  REVOKED: 12,
  EXPIRED: 13,
  ITEMS_CHANGED: 17,
  CANCELLATION_SCHEDULED: 18,
  PRICE_CHANGE_UPDATED: 19,
  PENDING_PURCHASE_CANCELED: 20,
  PRICE_STEP_UP_CONSENT_UPDATED: 22,
} as const;

/** OneTimeProductNotification.notificationType values. */
export const oneTimeNotificationType = { PURCHASED: 1, CANCELED: 2 } as const;

/** VoidedPurchaseNotification.productType and refundType values. */
export const voidedProductType = { SUBSCRIPTION: 1, ONE_TIME: 2 } as const;
export const voidedRefundType = { FULL: 1, QUANTITY_BASED_PARTIAL: 2 } as const;

export type RtdnEvent =
  | { kind: 'subscription'; token: string; notificationType: number; eventTimeMs: number | null }
  | { kind: 'one_time'; token: string; notificationType: number; productId: string | null; eventTimeMs: number | null }
  | { kind: 'voided'; token: string; orderId: string | null; productType: number | null; refundType: number | null; eventTimeMs: number | null }
  | { kind: 'refund_review'; eventTimeMs: number | null }
  | { kind: 'test'; eventTimeMs: number | null }
  | { kind: 'other'; eventTimeMs: number | null };

export interface DecodedRtdn {
  packageName: string;
  event: RtdnEvent;
}

/** The base64 `data` of a push as a notification; null when it is not one. */
export function decodeRtdn(data: string): DecodedRtdn | null {
  if (data.length === 0 || data.length > 65_536) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = developerNotificationSchema.safeParse(json);
  if (!parsed.success) return null;
  const n = parsed.data;
  const eventTimeMs = n.eventTimeMillis ?? null;
  let event: RtdnEvent;
  if (n.subscriptionNotification) {
    event = { kind: 'subscription', token: n.subscriptionNotification.purchaseToken, notificationType: n.subscriptionNotification.notificationType, eventTimeMs };
  } else if (n.oneTimeProductNotification) {
    const o = n.oneTimeProductNotification;
    event = { kind: 'one_time', token: o.purchaseToken, notificationType: o.notificationType, productId: o.sku ?? null, eventTimeMs };
  } else if (n.voidedPurchaseNotification) {
    const v = n.voidedPurchaseNotification;
    event = { kind: 'voided', token: v.purchaseToken, orderId: v.orderId ?? null, productType: v.productType ?? null, refundType: v.refundType ?? null, eventTimeMs };
  } else if (n.pendingRefundReviewNotification) {
    event = { kind: 'refund_review', eventTimeMs };
  } else if (n.testNotification) {
    event = { kind: 'test', eventTimeMs };
  } else {
    event = { kind: 'other', eventTimeMs };
  }
  return { packageName: n.packageName, event };
}
