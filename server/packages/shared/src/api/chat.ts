import { z } from 'zod';
import { requestStatus } from '../codes.js';
import { cursorSchema } from '../pagination.js';
import { conversationSchema, idSchema, messageSchema, peerSummarySchema, publicUidSchema, timeSchema } from './common.js';
import { CONTROL_CHARACTERS } from './social.js';

/**
 * Messages of a conversation (`/v1/conversations/:id/...`) and message
 * requests (`/v1/message-requests`).
 */

/** The longest body `messages.body` holds; `chat.max_body_chars` (app_config) is the limit a send meets. */
export const MESSAGE_BODY_MAX = 4_000;
/** A message request's body, as `message_requests.body` allows. */
export const REQUEST_BODY_MAX = 2_000;
/** A reaction is an emoji (or a short sequence of them). */
export const REACTION_MAX = 16;
/** A GIF is its provider's id. */
export const GIF_ID_MAX = 200;
export const MESSAGES_PAGE_DEFAULT = 50;
export const MESSAGES_PAGE_MAX = 200;

/** The sender's id for one message for its whole life: a resend with the same one never makes a second message. */
export const clientIdSchema = z.uuid();

const storable = (text: string) => !CONTROL_CHARACTERS.test(text);

export const messagesQuerySchema = z
  .object({
    /** An older page: the messages before this id. */
    before: idSchema.optional(),
    /** A catch-up: the messages after this id (the stored `syncCursor`). */
    after: idSchema.optional(),
    limit: z.coerce.number().int().min(1).max(MESSAGES_PAGE_MAX).default(MESSAGES_PAGE_DEFAULT),
  })
  .refine((q) => q.before === undefined || q.after === undefined, { message: 'before and after do not go together', path: ['after'] });
export type MessagesQuery = z.infer<typeof messagesQuerySchema>;

/**
 * A page of a conversation, oldest first. `syncCursor` is the position
 * below which every message is durable: min(the newest id returned, the
 * write-behind watermark - 1). A client stores it (never the newest id it
 * saw) and asks `after=<syncCursor>` next time, so messages that reach the
 * database late are still fetched; repeats are dropped by id.
 */
export const messagesPageSchema = z.object({
  items: z.array(messageSchema),
  hasMore: z.boolean(),
  syncCursor: idSchema,
  readCursors: z.object({
    /** Absent while the reader has read nothing. */
    me: idSchema.optional(),
    /** Only when the reader has read receipts. */
    peer: idSchema.optional(),
  }),
  /** How far the peer's devices received this person's messages; only while the peer shows online. */
  peerDeliveredId: idSchema.optional(),
});
export type MessagesPage = z.infer<typeof messagesPageSchema>;

/** Kinds a client may send; `image` and `voice` are refused until media messages exist. */
export const sendableKindSchema = z.enum(['text', 'gif', 'reaction', 'unsend', 'image', 'voice']);
export type SendableKind = z.infer<typeof sendableKindSchema>;

export const sendMessageSchema = z
  .object({
    clientId: clientIdSchema,
    kind: sendableKindSchema,
    body: z.string().max(MESSAGE_BODY_MAX).refine(storable, { message: 'a message holds no control characters' }).optional(),
    /** The replied message (text), the message reacted to (reaction) or taken back (unsend). */
    refId: idSchema.optional(),
    mediaId: idSchema.optional(),
    /** The token of a `confirm_required` answer: send anyway. */
    confirm: z.string().min(1).max(200).optional(),
  })
  .superRefine((m, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    switch (m.kind) {
      case 'text':
        if (m.body === undefined || m.body.trim().length === 0) issue('body', 'a text message has a body');
        break;
      case 'gif':
        if (m.body === undefined || !/^[A-Za-z0-9._:/-]{1,200}$/.test(m.body)) issue('body', 'a GIF names its provider id');
        break;
      case 'reaction':
        if (m.refId === undefined) issue('refId', 'a reaction names the message');
        if (m.body !== undefined && [...m.body].length > REACTION_MAX) issue('body', 'a reaction is an emoji');
        break;
      case 'unsend':
        if (m.refId === undefined) issue('refId', 'an unsend names the message');
        if (m.body !== undefined) issue('body', 'an unsend has no body');
        break;
      case 'image':
      case 'voice':
        if (m.mediaId === undefined) issue('mediaId', 'a media message names its upload');
        break;
    }
  });
export type SendMessage = z.infer<typeof sendMessageSchema>;

/** 201 for a new message, 200 with the same message for a retry with the same client id. */
export const sentMessageSchema = z.object({ message: messageSchema });
export type SentMessage = z.infer<typeof sentMessageSchema>;

export const receiptsSchema = z
  .object({ readUpTo: idSchema.optional(), deliveredUpTo: idSchema.optional() })
  .refine((r) => r.readUpTo !== undefined || r.deliveredUpTo !== undefined, { message: 'a receipt moves at least one pointer', path: ['readUpTo'] });
export type Receipts = z.infer<typeof receiptsSchema>;

export const conversationPatchSchema = z
  .object({ allowCalls: z.boolean().optional(), muted: z.boolean().optional() })
  .refine((p) => p.allowCalls !== undefined || p.muted !== undefined, { message: 'nothing to change', path: ['allowCalls'] });
export type ConversationPatch = z.infer<typeof conversationPatchSchema>;

export const conversationBodySchema = z.object({ conversation: conversationSchema });
export type ConversationBody = z.infer<typeof conversationBodySchema>;

// ─── Message requests ─────────────────────────────────────────────────────

export const requestStatusSchema = requestStatus.schema;

export const messageRequestCreateSchema = z.object({
  to: publicUidSchema,
  body: z
    .string()
    .trim()
    .min(1)
    .max(REQUEST_BODY_MAX)
    .refine(storable, { message: 'a message holds no control characters' }),
  clientId: clientIdSchema,
});
export type MessageRequestCreate = z.infer<typeof messageRequestCreateSchema>;

/** A request as its sender sees it right after sending. */
export const sentRequestSchema = z.object({
  id: idSchema,
  to: peerSummarySchema,
  body: z.string(),
  status: requestStatusSchema,
  at: timeSchema,
});
export type SentRequest = z.infer<typeof sentRequestSchema>;

export const sentRequestBodySchema = z.object({ request: sentRequestSchema });

/**
 * A request in a box: `peer` is the other side (the sender in the inbox, the
 * recipient in sent). A decline is never shown to the sender: it reads as
 * pending, and as expired once a pending request would have expired.
 */
export const messageRequestItemSchema = z.object({
  id: idSchema,
  peer: peerSummarySchema,
  body: z.string(),
  status: requestStatusSchema,
  at: timeSchema,
});
export type MessageRequestItem = z.infer<typeof messageRequestItemSchema>;

export const messageRequestsQuerySchema = z.object({
  box: z.enum(['inbox', 'sent']).default('inbox'),
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const messageRequestsPageSchema = z.object({
  items: z.array(messageRequestItemSchema),
  nextCursor: cursorSchema.nullable(),
});
export type MessageRequestsPage = z.infer<typeof messageRequestsPageSchema>;

export const messageRequestParamsSchema = z.object({ id: idSchema });
