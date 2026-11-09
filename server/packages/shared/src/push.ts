import { z } from 'zod';
import { callKindSchema, idSchema } from './api/common.js';

/**
 * Push messages (FCM HTTP v1, both store builds). The server decides the
 * text, in the person's language, and keeps it generic unless the person
 * turned previews on. Data values are strings (FCM's rule) and carry ids and
 * display strings only: no e-mail, phone number or user id, ever; peer names
 * are first names.
 */

/** Android notification channels the app creates. */
export const pushChannels = ['messages', 'matches', 'likes', 'calls', 'calls.ongoing', 'account', 'offers'] as const;
export type PushChannel = (typeof pushChannels)[number];

const DAY = 86_400;
const httpsUrl = z.url({ protocol: /^https?$/ });
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,9})$/);

export interface PushTypeSpec {
  /** `data`: data-only (the app draws, rings or stops); `notification`: drawn by the system from the server's text. */
  kind: 'data' | 'notification';
  priority: 'high' | 'normal';
  channel?: PushChannel | undefined;
  /** Seconds after which FCM drops the message instead of delivering it late; `null`: set per send (campaigns). */
  ttlSeconds: number | null;
  /** The keys besides `type`, as FCM string values. */
  data: z.ZodObject;
  /** Notification tag (replaces the earlier one on the phone) or collapse key, from the data. */
  tag?: ((data: Record<string, string>) => string) | undefined;
  collapseKey?: ((data: Record<string, string>) => string) | undefined;
  /** `PRIVATE`: the lock screen shows the public version only. */
  visibility?: 'private' | undefined;
}

export const pushTypes = {
  call_incoming: {
    kind: 'data',
    priority: 'high',
    channel: 'calls',
    ttlSeconds: 45,
    data: z.strictObject({
      callId: idSchema,
      conversationId: idSchema,
      kind: callKindSchema,
      peerName: z.string().min(1).max(40),
      peerPhotoUrl: httpsUrl.optional(),
      expiresAt: z.iso.datetime({ offset: false, precision: 3 }),
    }),
    collapseKey: (d) => `call:${d['callId']}`,
  },
  call_cancel: {
    kind: 'data',
    priority: 'high',
    ttlSeconds: 45,
    data: z.strictObject({
      callId: idSchema,
      reason: z.enum(['answered_elsewhere', 'declined', 'cancelled', 'missed', 'ended']),
    }),
    collapseKey: (d) => `call:${d['callId']}`,
  },
  message: {
    kind: 'notification',
    priority: 'high',
    channel: 'messages',
    ttlSeconds: DAY,
    data: z.strictObject({ conversationId: idSchema, messageId: idSchema }),
    tag: (d) => `c:${d['conversationId']}`,
    visibility: 'private',
  },
  match: {
    kind: 'notification',
    priority: 'normal',
    channel: 'matches',
    ttlSeconds: DAY,
    data: z.strictObject({ conversationId: idSchema }),
    tag: (d) => `m:${d['conversationId']}`,
    // With previews on it names the other person: never on the lock screen.
    visibility: 'private',
  },
  like: {
    kind: 'notification',
    priority: 'normal',
    channel: 'likes',
    ttlSeconds: DAY,
    data: z.strictObject({ total: decimal }),
    tag: () => 'likes',
  },
  request: {
    kind: 'notification',
    priority: 'normal',
    channel: 'messages',
    ttlSeconds: DAY,
    data: z.strictObject({ requestId: idSchema }),
    tag: (d) => `r:${d['requestId']}`,
    visibility: 'private',
  },
  call_missed: {
    kind: 'notification',
    priority: 'normal',
    channel: 'messages',
    ttlSeconds: DAY,
    data: z.strictObject({ callId: idSchema, conversationId: idSchema }),
    tag: (d) => `call:${d['callId']}`,
    visibility: 'private',
  },
  account: {
    kind: 'notification',
    priority: 'normal',
    channel: 'account',
    ttlSeconds: 3 * DAY,
    data: z.strictObject({}),
  },
  support: {
    kind: 'notification',
    priority: 'normal',
    channel: 'account',
    ttlSeconds: 3 * DAY,
    data: z.strictObject({ ticketId: idSchema }),
  },
  offer: {
    kind: 'notification',
    priority: 'normal',
    channel: 'offers',
    ttlSeconds: null,
    data: z.strictObject({
      campaignId: decimal,
      deeplink: z.string().regex(/^\/[A-Za-z0-9/_?=&.-]{0,200}$/, 'must be an in-app path'),
    }),
  },
} as const satisfies Record<string, PushTypeSpec>;

export type PushType = keyof typeof pushTypes;
export const pushTypeNames = Object.keys(pushTypes) as PushType[];
export type PushData<T extends PushType> = z.infer<(typeof pushTypes)[T]['data']>;

/** What a sender hands to FCM, built from a type and its data. */
export interface PushPayload {
  type: PushType;
  kind: 'data' | 'notification';
  priority: 'high' | 'normal';
  channel?: PushChannel | undefined;
  ttlSeconds: number;
  /** `type` plus the type's keys, all strings. */
  data: Record<string, string>;
  tag?: string | undefined;
  collapseKey?: string | undefined;
  visibility?: 'private' | undefined;
  /** Only for `notification` messages: the text, already in the person's language. */
  title?: string | undefined;
  body?: string | undefined;
}

export interface PushText {
  title: string;
  body: string;
}

/**
 * Builds a push payload, validating the data against its type: a key the
 * contract does not list throws, so nothing extra can leak into a push.
 */
export function pushPayload<T extends PushType>(
  type: T,
  data: PushData<T>,
  options: { text?: PushText | undefined; ttlSeconds?: number | undefined } = {},
): PushPayload {
  const spec: PushTypeSpec = pushTypes[type];
  const parsed = spec.data.parse(data) as Record<string, string | undefined>;
  const values: Record<string, string> = { type };
  for (const [key, value] of Object.entries(parsed)) if (value !== undefined) values[key] = value;
  const ttlSeconds = options.ttlSeconds ?? spec.ttlSeconds;
  if (ttlSeconds === null || !Number.isInteger(ttlSeconds) || ttlSeconds < 0 || ttlSeconds > 28 * DAY) {
    throw new RangeError(`${type}: a push needs a TTL between 0 and 28 days`);
  }
  if (spec.kind === 'notification' && !options.text) throw new TypeError(`${type}: a notification push needs its text`);
  if (spec.kind === 'data' && options.text) throw new TypeError(`${type}: a data push carries no text`);
  return {
    type,
    kind: spec.kind,
    priority: spec.priority,
    channel: spec.channel,
    ttlSeconds,
    data: values,
    tag: spec.tag?.(values),
    collapseKey: spec.collapseKey?.(values),
    visibility: spec.visibility,
    title: options.text?.title,
    body: options.text?.body,
  };
}

/** Reads a push's data as a client receives it (the type first, then its keys). */
export const pushDataSchema = z.discriminatedUnion(
  'type',
  pushTypeNames.map((type) => pushTypes[type].data.extend({ type: z.literal(type) })) as unknown as [
    z.ZodObject,
    ...z.ZodObject[],
  ],
);
