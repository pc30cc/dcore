import { z } from 'zod';
import { callKind, callOutcome, matchSource, matchState, messageKind, requestStatus } from '../codes.js';
import { cursorSchema, pageSchema } from '../pagination.js';
import { adminUserRefSchema } from './adminUsers.js';
import { idSchema, timeSchema } from './common.js';

/**
 * The admin user page's chats (`/v1/admin/users/{id}/chats*`, users.chats):
 * every conversation of a person and its messages, page by page.
 *
 * The person whose page it is is `subject`; the other member is `other`
 * (an AdminUserRef: public id, name, status, photo). A message's sender
 * travels as `subject` or `other` only. Every other id is a decimal string.
 */

export const adminChatSideSchema = z.enum(['subject', 'other']);
export type AdminChatSide = z.infer<typeof adminChatSideSchema>;

export const adminChatSummarySchema = z.object({
  /** The conversation (match) id. */
  id: idSchema,
  other: adminUserRefSchema,
  state: matchState.schema,
  source: matchSource.schema,
  /** The match's creation (the time of its id). */
  startedAt: timeSchema,
  endedAt: timeSchema.nullable(),
  endedBy: z.enum(['subject', 'other', 'system']).nullable(),
  /** The newest message of any kind (a reaction and an unsend too), stored or still in the write-behind stream. */
  lastActivityAt: timeSchema.nullable(),
  /** Messages other than reactions and unsends, stored or not yet, counted up to 100. */
  messages: z.object({ count: z.number().int().min(0).max(100), more: z.boolean() }),
  /**
   * False when the read of the messages not stored yet stopped before them
   * all (a backlog, a Valkey error): `messages.count` is then at least that
   * many, not exactly.
   */
  countComplete: z.boolean(),
  /** An active legal hold names the conversation or either person (false for a caller without reports.hold). */
  held: z.boolean(),
  /** The visibility rule (context 2) each way, now; absent for a caller who may not see shadowbans. */
  visibility: z.object({ subjectSeesOther: z.boolean(), otherSeesSubject: z.boolean() }).optional(),
  /**
   * Set for an unmatched or blocked conversation that ended longer ago than
   * the retention and keeps no message: the messages of such a conversation
   * are deleted this many days after it ends (the current setting). Whether
   * it ever had any is not recorded.
   */
  retentionDays: z.number().int().positive().nullable(),
});
export type AdminChatSummary = z.infer<typeof adminChatSummarySchema>;

export const adminChatListQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type AdminChatListQuery = z.infer<typeof adminChatListQuerySchema>;

/** Newest conversation first (by when it began). */
export const adminChatListSchema = pageSchema(adminChatSummarySchema).extend({
  /**
   * False when the messages not stored yet could not all be read (a Valkey
   * error, or more of them than one read takes): counts and last activity
   * may then leave some out.
   */
  streamComplete: z.boolean(),
});
export type AdminChatList = z.infer<typeof adminChatListSchema>;

export const adminChatPageQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AdminChatPageQuery = z.infer<typeof adminChatPageQuerySchema>;

export const adminChatCallSchema = z.object({
  kind: callKind.schema,
  outcome: callOutcome.schema,
  durationSeconds: z.number().int().nonnegative(),
});

export const adminChatMessageSchema = z.object({
  id: idSchema,
  from: adminChatSideSchema,
  kind: messageKind.schema,
  /** `messageFlags` names: risky, hidden, warned, body_removed. */
  flags: z.array(z.string()),
  /**
   * As stored: a hidden or unsent message keeps its text while it exists.
   * Null without one, after its removal, for a call line (see `call`) and
   * for a photo or voice message (media is not served here).
   */
  body: z.string().nullable(),
  /** The replied, reacted or unsent message; the call of a call line; the liked item of a like note. */
  refId: idSchema.nullable(),
  at: timeSchema,
  /** When its sender took it back. */
  unsentAt: timeSchema.nullable(),
  /** A call line's summary (absent when its body is not one). */
  call: adminChatCallSchema.optional(),
  /** Sent while its sender was shadowbanned (absent for a caller who may not see shadowbans). */
  shadowed: z.boolean().optional(),
  /** Read from the write-behind stream: not in PostgreSQL yet. */
  pending: z.boolean(),
});
export type AdminChatMessage = z.infer<typeof adminChatMessageSchema>;

/**
 * How a page read the messages not stored yet (the write-behind stream):
 * - `complete`: every one that belongs on the page;
 * - `backlog`: more wait to be stored than one read takes, so the page
 *   stops at the oldest one it read (it may hold few messages, or none) and
 *   the next page goes on from there, where that read stopped; nothing is
 *   skipped (the newest page's count says it may be short: countComplete);
 * - `partial`: not all of them could be read (a Valkey error, or a backlog
 *   too dense to page through): the page may lack some, or the taken-back
 *   mark of an unsend not stored yet.
 */
export const adminChatStreamSchema = z.enum(['complete', 'backlog', 'partial']);
export type AdminChatStream = z.infer<typeof adminChatStreamSchema>;

export const adminChatPageSchema = z.object({
  /** On the newest page (no cursor) only; null on an older page. */
  conversation: adminChatSummarySchema.nullable(),
  /** Oldest first. */
  items: z.array(adminChatMessageSchema),
  /** The next older page; null at the oldest kept message. */
  nextCursor: cursorSchema.nullable(),
  stream: adminChatStreamSchema,
});
export type AdminChatPage = z.infer<typeof adminChatPageSchema>;

/**
 * A message request of the person (`/v1/admin/users/{id}/chat-requests`,
 * users.chats): a direct message sent or received before any match, in
 * every state the store keeps (decided ones until the retention sweep), its
 * text as written. An accepted one also opened a conversation, which the
 * chats list shows; `conversationId` names it.
 */
export const adminChatRequestSchema = z.object({
  id: idSchema,
  direction: z.enum(['sent', 'received']),
  other: adminUserRefSchema,
  status: requestStatus.schema,
  sentAt: timeSchema,
  decidedAt: timeSchema.nullable(),
  body: z.string(),
  conversationId: idSchema.nullable(),
});
export type AdminChatRequest = z.infer<typeof adminChatRequestSchema>;

export const adminChatRequestListQuerySchema = adminChatListQuerySchema;
export type AdminChatRequestListQuery = z.infer<typeof adminChatRequestListQuerySchema>;

/** Newest first. */
export const adminChatRequestListSchema = pageSchema(adminChatRequestSchema);
export type AdminChatRequestList = z.infer<typeof adminChatRequestListSchema>;
