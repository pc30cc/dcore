import { z } from 'zod';
import {
  callSchema,
  conversationSchema,
  entitlementsSchema,
  idSchema,
  likeKindSchema,
  messageSchema,
  moderationActionSchema,
  peerSummarySchema,
  photoStatusSchema,
  publicUidSchema,
  textStateSchema,
  timeSchema,
} from './api/common.js';
import { accountStatusSchema } from './api/common.js';

/**
 * Realtime events on a user's personal channel (`u:#<publicUid>`).
 *
 *     { "t": "message", "v": 1, "id": "1287390234923417600", "at": "2026-11-06T09:14:03.120Z", "d": { … } }
 *
 * `id` is the event's own id (the message id for `message`): the Centrifugo
 * idempotency key and the client's dedupe key. An event is published after
 * the change is durable. Events both people of a pair receive are broadcast
 * with identical data, so they carry only what the peer may see: never
 * moderation flags, scores, report state, devices, locations, raw ids,
 * e-mails or phone numbers.
 */

export const ENVELOPE_VERSION = 1;

const verificationStateSchema = z.enum(['none', 'pending', 'approved', 'rejected']);

/** The payload (`d`) of each event type. */
export const realtimePayloads = {
  /** To both members. The receiver writes it locally; no re-read. */
  message: messageSchema,
  /** `readUpTo` reaches the peer only with read receipts; `deliveredUpTo` only when the reader shows online. */
  receipt: z.object({
    conversationId: idSchema,
    by: publicUidSchema,
    readUpTo: idSchema.optional(),
    deliveredUpTo: idSchema.optional(),
  }),
  /** To the peer, not kept in history; shown for 5 s. */
  typing: z.object({ conversationId: idSchema, by: publicUidSchema }),
  conversation: z.object({ conversation: conversationSchema, reason: z.enum(['matched', 'accepted', 'updated']) }),
  /** Unmatch, block, ban and deletion look the same. */
  conversation_end: z.object({ conversationId: idSchema }),
  /** `from` only with see_likes, or for a super like. */
  like: z.object({ total: z.number().int().nonnegative(), kind: likeKindSchema, from: peerSummarySchema.optional() }),
  request: z.object({
    request: z.object({ id: idSchema, from: peerSummarySchema, body: z.string(), at: timeSchema }),
  }),
  /** Every state move of a call, to both. */
  call: callSchema,
  entitlement: entitlementsSchema,
  /** Moderation results of the person's own profile. */
  profile: z.object({
    photo: z.object({ id: idSchema, status: photoStatusSchema, rejectReason: z.string().optional() }).optional(),
    textState: textStateSchema.optional(),
    prompts: z.array(z.object({ position: z.number().int().min(0).max(2), status: textStateSchema })).optional(),
    verification: verificationStateSchema.optional(),
  }),
  /**
   * The account's state moved: the client refreshes `GET /v1/me`. `moderation`
   * is the action behind the move.
   */
  account: z.object({
    status: accountStatusSchema,
    moderation: moderationActionSchema.optional(),
    export: z.object({ url: z.url({ protocol: /^https?$/ }), expiresAt: timeSchema }).optional(),
  }),
  support: z.object({ ticketId: idSchema, at: timeSchema }),
  /** Broadcast by the worker after a config change. */
  config: z.object({ v: z.number().int().nonnegative() }),
} as const;

export type RealtimeEventType = keyof typeof realtimePayloads;
export const realtimeEventTypes = Object.keys(realtimePayloads) as RealtimeEventType[];
export type RealtimePayload<T extends RealtimeEventType> = z.infer<(typeof realtimePayloads)[T]>;

/** Events that are not kept in the channel history (Centrifugo `skip_history`). */
export const ephemeralEventTypes: ReadonlySet<RealtimeEventType> = new Set(['typing']);

export interface RealtimeEnvelope<T extends RealtimeEventType = RealtimeEventType> {
  t: T;
  v: typeof ENVELOPE_VERSION;
  id: string;
  at: string;
  d: RealtimePayload<T>;
}

const envelopeBase = z.object({
  v: z.literal(ENVELOPE_VERSION),
  id: idSchema,
  at: timeSchema,
});

/** One schema per event type, discriminated on `t`. */
export const realtimeEnvelopeSchema = z.discriminatedUnion(
  't',
  realtimeEventTypes.map((t) => envelopeBase.extend({ t: z.literal(t), d: realtimePayloads[t] })) as unknown as [
    z.ZodObject,
    ...z.ZodObject[],
  ],
);

/**
 * Builds an envelope, validating the payload against its schema, so a
 * publisher cannot send a field the contract does not have (zod strips
 * unknown keys; a missing or wrong field throws).
 */
export function realtimeEnvelope<T extends RealtimeEventType>(
  t: T,
  id: string,
  at: Date | number,
  d: z.input<(typeof realtimePayloads)[T]>,
): RealtimeEnvelope<T> {
  const payload = realtimePayloads[t].parse(d) as RealtimePayload<T>;
  return { t, v: ENVELOPE_VERSION, id: idSchema.parse(id), at: new Date(at).toISOString(), d: payload };
}
