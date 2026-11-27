import { z } from 'zod';
import { one, sql, type SqlFragment } from '../query.js';
import { defineQuery } from './define.js';
import { adminEpochMs, adminIdText, adminUserKept, msOf } from './adminShared.js';
import { adminUserRefRowSchema, type Found } from './adminUsers.js';

/**
 * A person's conversations in the admin panel (`/v1/admin/users/{id}/chats*`):
 * every match the person is in, in any state, newest first, and a page of
 * one conversation's stored messages. Both are pure reads, one statement
 * each; the API adds the messages still in the write-behind stream.
 *
 * - The list reads the person's matches from `matches_pair_key` (user_lo)
 *   and `matches_hi_idx` (user_hi), keyset-paged by the match id; per row
 *   of the page only: the newest message id, a count of messages bounded at
 *   101, the stored ids at or above `since` (the oldest message the API
 *   read from the stream: which of those are stored already), the holds,
 *   the visibility rule each way and the other person.
 * - The page is a keyset range on the messages primary key (`limit + 1`
 *   rows, newest first, returned ascending), each message with the id of
 *   the unsend that took it back (`messages_unsent_ref_idx`), and the
 *   shadowban records of both people (`moderation_actions_user_idx`); the
 *   conversation's summary on the newest page only.
 *
 * People are raw ids here; the API names them by public id.
 */

const id = adminIdText;
const epochMs = adminEpochMs;

export const adminChatRowSchema = z.object({
  id,
  other: adminUserRefRowSchema,
  /** The person's side of the match: 1 user_lo, 2 user_hi. */
  side: z.union([z.literal(1), z.literal(2)]),
  state: z.number().int().min(1).max(5),
  source: z.number().int().min(1).max(4),
  endedAtMs: epochMs.nullable(),
  /** matches.ended_by: 1 user_lo, 2 user_hi, 3 system. */
  endedBy: z.number().int().min(1).max(3).nullable(),
  /** The newest stored message of any kind. */
  lastId: id.nullable(),
  /** Stored messages other than reactions and unsends, counted up to 101. */
  count: z.number().int().min(0).max(101),
  /** The stored ones (of those counted) at or above `since`, newest first, up to 101; empty without `since`. */
  storedSince: z.array(id).max(101),
  /** An active hold on the match or on either person. */
  held: z.boolean(),
  subjectSeesOther: z.boolean(),
  otherSeesSubject: z.boolean(),
});
export type AdminChatRow = z.infer<typeof adminChatRowSchema>;

/** Messages counted per conversation before the count stops. */
export const ADMIN_CHAT_COUNT_CAP = 100;

/**
 * One conversation as the chats list shows it (p: the match with other_id;
 * o: the other person's users row). `since`: the oldest id of the messages
 * the API read from the write-behind stream, or null when it read none.
 */
const chatSummarySql = (subject: string, since: string | null) => sql`jsonb_build_object(
  'id', p.id::text,
  'other', admin_user_ref(o),
  'side', CASE WHEN p.user_lo = ${subject}::bigint THEN 1 ELSE 2 END,
  'state', p.state,
  'source', p.source,
  'endedAtMs', ${msOf(sql`p.ended_at`)},
  'endedBy', p.ended_by,
  'lastId', (SELECT y.id::text FROM messages y WHERE y.match_id = p.id ORDER BY y.id DESC LIMIT 1),
  'count', cardinality(ARRAY(SELECT 1 FROM messages y WHERE y.match_id = p.id AND y.kind NOT IN (7, 8) LIMIT ${ADMIN_CHAT_COUNT_CAP + 1}::integer)),
  'storedSince', ${
    since === null
      ? sql`'[]'::jsonb`
      : sql`to_jsonb(ARRAY(SELECT y.id::text FROM messages y
                            WHERE y.match_id = p.id AND y.id >= ${since}::bigint AND y.kind NOT IN (7, 8)
                            ORDER BY y.id DESC LIMIT ${ADMIN_CHAT_COUNT_CAP + 1}::integer))`
  },
  'held', legal_hold_active(p.user_lo, p.id) OR legal_hold_active(p.user_hi, NULL),
  'subjectSeesOther', can_see(${subject}::bigint, o.id, 2),
  'otherSeesSubject', can_see(o.id, ${subject}::bigint, 2))`;

const matchColumns = sql`m.id, m.user_lo, m.user_hi, m.state, m.source, m.ended_at, m.ended_by`;

export interface AdminUserChatsOptions {
  beforeId: string | null;
  /** The page size + 1. */
  limit: number;
  /** The oldest message id read from the write-behind stream (null: none). */
  since?: string | null;
}

/** The list's statement (exported for the plan checks of the tests). */
export function adminUserChatsStatement(userId: string, options: AdminUserChatsOptions): SqlFragment {
  const before = options.beforeId ? sql` AND m.id < ${options.beforeId}::bigint` : sql``;
  return sql`SELECT ${adminUserKept(userId)} AS found,
                    coalesce((SELECT jsonb_agg(${chatSummarySql(userId, options.since ?? null)} ORDER BY p.id DESC)
                                FROM (SELECT ${matchColumns}, m.user_hi AS other_id
                                        FROM matches m WHERE m.user_lo = ${userId}::bigint${before}
                                      UNION ALL
                                      SELECT ${matchColumns}, m.user_lo
                                        FROM matches m WHERE m.user_hi = ${userId}::bigint${before}
                                       ORDER BY id DESC
                                       LIMIT ${options.limit}::integer) p
                                JOIN users o ON o.id = p.other_id), '[]'::jsonb) AS items`;
}

/** Every conversation of the person, newest first, `limit` rows before `beforeId`; `found` false for no account or a purged one. */
export const adminUserChats = defineQuery(
  { name: 'adminChats.list', statements: 1 },
  async (db, userId: string, options: AdminUserChatsOptions): Promise<Found<AdminChatRow[]>> => {
    const row = await one<{ found: boolean; items: unknown }>(db, adminUserChatsStatement(userId, options));
    return { found: row.found, value: z.array(adminChatRowSchema).parse(row.items) };
  },
);

/** A stored message as the page reads it, with the id of the unsend that took it back. */
export interface AdminChatStoredRow {
  id: string;
  senderId: string;
  refId: string | null;
  kind: number;
  flags: number;
  body: string | null;
  unsendId: string | null;
}

/** A shadowban record of either person: from when, until when (null: still standing). */
export interface AdminChatShadowRow {
  userId: string;
  startsAtMs: number;
  endsAtMs: number | null;
}

const storedTuple = z.tuple([id, id, id.nullable(), z.number().int().min(1).max(8), z.number().int(), z.string().nullable(), id.nullable()]);
const shadowTuple = z.tuple([id, epochMs, epochMs.nullable()]);

export interface AdminUserChatPageInput {
  userId: string;
  conversationId: string;
  beforeId: string | null;
  /** The page size + 1. */
  limit: number;
  /** The oldest of the conversation's messages read from the write-behind stream (null: none). */
  since?: string | null;
}

export interface AdminUserChatPage {
  found: boolean;
  /** The person is in the match. */
  matched: boolean;
  /** The newest page's (no `beforeId`) only; null on an older page and for a match the person is not in. */
  conversation: AdminChatRow | null;
  /** Newest first is how they were read; returned oldest first. */
  rows: AdminChatStoredRow[];
  shadows: AdminChatShadowRow[];
}

/** The page's statement (exported for the plan checks of the tests). */
export function adminUserChatPageStatement(q: AdminUserChatPageInput): SqlFragment {
  const before = q.beforeId ? sql` AND y.id < ${q.beforeId}::bigint` : sql``;
  return sql`WITH p AS (
               SELECT ${matchColumns},
                      CASE WHEN m.user_lo = ${q.userId}::bigint THEN m.user_hi ELSE m.user_lo END AS other_id
                 FROM matches m
                WHERE m.id = ${q.conversationId}::bigint AND (m.user_lo = ${q.userId}::bigint OR m.user_hi = ${q.userId}::bigint)
             )
             SELECT ${adminUserKept(q.userId)} AS found,
                    EXISTS (SELECT 1 FROM p) AS matched,
                    ${q.beforeId ? sql`NULL::jsonb` : sql`(SELECT ${chatSummarySql(q.userId, q.since ?? null)} FROM p JOIN users o ON o.id = p.other_id)`} AS conversation,
                    CASE WHEN EXISTS (SELECT 1 FROM p) THEN
                      (SELECT coalesce(jsonb_agg(jsonb_build_array(
                                r.id::text, r.sender_id::text, r.ref_id::text, r.kind, r.flags, r.body,
                                CASE WHEN r.kind <> 8 THEN
                                  (SELECT u.id::text FROM messages u
                                    WHERE u.match_id = ${q.conversationId}::bigint AND u.kind = 8 AND u.ref_id = r.id AND u.sender_id = r.sender_id
                                      -- Minted after its target (a minute of clock slack): older partitions are skipped.
                                      AND u.id > r.id - (60000::bigint << 22)
                                    ORDER BY u.id LIMIT 1)
                                END) ORDER BY r.id), '[]'::jsonb)
                         FROM (SELECT y.id, y.sender_id, y.ref_id, y.kind, y.flags, y.body
                                 FROM messages y
                                WHERE y.match_id = ${q.conversationId}::bigint${before}
                                ORDER BY y.id DESC
                                LIMIT ${q.limit}::integer) r)
                    END AS rows,
                    (SELECT coalesce(jsonb_agg(jsonb_build_array(a.user_id::text, ${msOf(sql`a.starts_at`)}, ${msOf(sql`least(a.revoked_at, a.ends_at)`)}) ORDER BY a.id), '[]'::jsonb)
                       FROM p, moderation_actions a
                      WHERE a.user_id IN (p.user_lo, p.user_hi) AND a.kind = 4) AS shadows`;
}

/** One page of a conversation of the person, for the admin; nothing is written. */
export const adminUserChatPage = defineQuery({ name: 'adminChats.page', statements: 1 }, async (db, q: AdminUserChatPageInput): Promise<AdminUserChatPage> => {
  const row = await one<{ found: boolean; matched: boolean; conversation: unknown; rows: unknown; shadows: unknown }>(db, adminUserChatPageStatement(q));
  const conversation = row.conversation === null ? null : adminChatRowSchema.parse(row.conversation);
  const rows = z
    .array(storedTuple)
    .parse(row.rows ?? [])
    .map(([mid, senderId, refId, kind, flags, body, unsendId]) => ({ id: mid, senderId, refId, kind, flags, body, unsendId }));
  const shadows = z
    .array(shadowTuple)
    .parse(row.shadows ?? [])
    .map(([userId, startsAtMs, endsAtMs]) => ({ userId, startsAtMs, endsAtMs }));
  return { found: row.found, matched: row.matched, conversation, rows, shadows };
});
