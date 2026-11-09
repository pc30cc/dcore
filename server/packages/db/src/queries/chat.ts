import { z } from 'zod';
import { execute, many, maybeOne, one, sql } from '../query.js';
import { defineQuery } from './define.js';

/**
 * Chat. Sending, receipts and typing cost no statement on the request path
 * (Valkey and the write-behind stream `wb:msg`); PostgreSQL is read for a
 * conversation's eligibility when its cache expired, for history pages, and
 * for the list state after it expired, and written by the stream writer in
 * batches, by the read-pointer flush once a minute, and by the rare
 * settings and clean-up statements here.
 */

const id = z.string().regex(/^[1-9][0-9]{0,18}$/);

/** A `messages` row, ids as decimal strings. */
export interface MessageRow {
  id: string;
  matchId: string;
  senderId: string;
  refId: string | null;
  kind: number;
  flags: number;
  body: string | null;
}

const messageTuple = z.tuple([id, id, id.nullable(), z.number().int(), z.number().int(), z.string().nullable()]);

function rowsOf(matchId: string, raw: unknown): MessageRow[] {
  return z
    .array(messageTuple)
    .parse(raw ?? [])
    .map(([mid, sender, ref, kind, flags, body]) => ({ id: mid, matchId, senderId: sender, refId: ref, kind, flags, body }));
}

// ─── Eligibility ──────────────────────────────────────────────────────────

export interface ChatEligibilityRow {
  id: string;
  lo: string;
  hi: string;
  state: number;
  flags: number;
  source: number;
  /** The visibility rule (context 2) each way: 1 = lo may be seen by hi, 2 = hi may be seen by lo. */
  vis: number;
}

/** A conversation's state and each side's visibility, when its cached copy expired (one primary-key read). */
export const chatEligibility = defineQuery({ name: 'chat.eligibility', statements: 1 }, async (db, matchId: string): Promise<ChatEligibilityRow | null> => {
  const row = await maybeOne<{ id: string; lo: string; hi: string; state: number; flags: number; source: number; vis: number }>(
    db,
    sql`SELECT m.id::text AS id, m.user_lo::text AS lo, m.user_hi::text AS hi, m.state, m.flags, m.source,
               (CASE WHEN can_see(m.user_hi, m.user_lo, 2) THEN 1 ELSE 0 END
                | CASE WHEN can_see(m.user_lo, m.user_hi, 2) THEN 2 ELSE 0 END) AS vis
          FROM matches m WHERE m.id = ${matchId}::bigint`,
  );
  if (!row) return null;
  return { id: row.id, lo: row.lo, hi: row.hi, state: Number(row.state), flags: Number(row.flags), source: Number(row.source), vis: Number(row.vis) };
});

// ─── History ──────────────────────────────────────────────────────────────

export interface HistoryPageInput {
  matchId: string;
  viewerId: string;
  before?: string | undefined;
  after?: string | undefined;
  limit: number;
}

export type HistoryPage =
  | { found: false }
  | {
      found: true;
      lo: string;
      hi: string;
      state: number;
      loReadId: string;
      hiReadId: string;
      /** The peer may be listed (visibility rule, context 2). */
      visible: boolean;
      /** The peer's own "show online" switch. */
      peerShowsOnline: boolean;
      /** Ascending; empty unless the conversation is active and visible. */
      items: MessageRow[];
      hasMore: boolean;
    };

/**
 * One page of a conversation for one of its two people, in one statement:
 * the membership, state and visibility of the conversation, both read
 * pointers, the peer's "show online", and the messages (a keyset range on
 * the primary key, `limit + 1` rows to tell whether more exist): before an
 * id (newest first, returned ascending), after an id, or the newest page.
 * A message its sender took back comes without its body, whether or not the
 * unsend is on the same page (one probe of `messages_unsent_ref_idx` each).
 */
export const historyPage = defineQuery({ name: 'chat.historyPage', statements: 1 }, async (db, q: HistoryPageInput): Promise<HistoryPage> => {
  const n = q.limit + 1;
  const range =
    q.after !== undefined
      ? sql`SELECT y.id, y.sender_id, y.ref_id, y.kind, y.flags, y.body FROM messages y
             WHERE y.match_id = ${q.matchId}::bigint AND y.id > ${q.after}::bigint ORDER BY y.id ASC LIMIT ${n}::integer`
      : q.before !== undefined
        ? sql`SELECT y.id, y.sender_id, y.ref_id, y.kind, y.flags, y.body FROM messages y
               WHERE y.match_id = ${q.matchId}::bigint AND y.id < ${q.before}::bigint ORDER BY y.id DESC LIMIT ${n}::integer`
        : sql`SELECT y.id, y.sender_id, y.ref_id, y.kind, y.flags, y.body FROM messages y
               WHERE y.match_id = ${q.matchId}::bigint ORDER BY y.id DESC LIMIT ${n}::integer`;
  const row = await maybeOne<{
    lo: string;
    hi: string;
    state: number;
    lo_read: string;
    hi_read: string;
    visible: boolean;
    peer_online: boolean;
    rows: unknown;
  }>(
    db,
    sql`WITH m AS (
          SELECT x.id, x.user_lo, x.user_hi, x.state, x.lo_read_id, x.hi_read_id,
                 CASE WHEN x.user_lo = ${q.viewerId}::bigint THEN x.user_hi ELSE x.user_lo END AS peer
            FROM matches x
           WHERE x.id = ${q.matchId}::bigint AND (x.user_lo = ${q.viewerId}::bigint OR x.user_hi = ${q.viewerId}::bigint)
        ), g AS (
          SELECT m.*, can_see(${q.viewerId}::bigint, m.peer, 2) AS visible,
                 coalesce((SELECT p.show_online FROM profiles p WHERE p.user_id = m.peer), false) AS peer_online
            FROM m
        )
        SELECT g.user_lo::text AS lo, g.user_hi::text AS hi, g.state, g.lo_read_id::text AS lo_read, g.hi_read_id::text AS hi_read,
               g.visible, g.peer_online,
               CASE WHEN g.state = 1 AND g.visible THEN
                 (SELECT coalesce(jsonb_agg(jsonb_build_array(r.id::text, r.sender_id::text, r.ref_id::text, r.kind, r.flags,
                           -- A body its sender took back reads as gone on every page, before the clear job removes it.
                           CASE WHEN r.body IS NOT NULL AND r.kind IN (1, 4, 6, 7)
                                     AND EXISTS (SELECT 1 FROM messages u
                                                  WHERE u.match_id = ${q.matchId}::bigint AND u.kind = 8 AND u.ref_id = r.id
                                                    AND u.sender_id = r.sender_id
                                                    -- Minted after its target (a minute of clock slack): older partitions are skipped.
                                                    AND u.id > r.id - (60000::bigint << 22))
                                THEN NULL ELSE r.body END) ORDER BY r.id), '[]'::jsonb)
                    FROM (${range}) r)
               END AS rows
          FROM g`,
  );
  if (!row) return { found: false };
  let items = rowsOf(q.matchId, row.rows);
  const hasMore = items.length > q.limit;
  if (hasMore) items = q.after !== undefined ? items.slice(0, q.limit) : items.slice(items.length - q.limit);
  return {
    found: true,
    lo: row.lo,
    hi: row.hi,
    state: Number(row.state),
    loReadId: row.lo_read,
    hiReadId: row.hi_read,
    visible: row.visible === true,
    peerShowsOnline: row.peer_online === true,
    items,
    hasMore,
  };
});

/** Who sent a message (the unsend check, when the message is durable already); null when there is no such message. */
export const messageSender = defineQuery({ name: 'chat.messageSender', statements: 1 }, async (db, matchId: string, messageId: string): Promise<string | null> => {
  const row = await maybeOne<{ sender: string }>(
    db,
    sql`SELECT y.sender_id::text AS sender FROM messages y WHERE y.match_id = ${matchId}::bigint AND y.id = ${messageId}::bigint`,
  );
  return row?.sender ?? null;
});

// ─── The write-behind writer ──────────────────────────────────────────────

/**
 * A batch of the stream in one statement: seven arrays, a multi-row INSERT
 * that skips rows already there (a replayed batch, a message written
 * directly), each row routed to its month's partition by id. Returns how
 * many rows it inserted.
 */
export const insertMessages = defineQuery({ name: 'chat.insertMessages', statements: 1 }, async (db, rows: readonly MessageRow[]): Promise<number> => {
  if (rows.length === 0) return 0;
  return execute(
    db,
    sql`INSERT INTO messages (match_id, id, sender_id, ref_id, kind, flags, body)
        SELECT * FROM unnest(${rows.map((r) => r.matchId)}::bigint[], ${rows.map((r) => r.id)}::bigint[], ${rows.map((r) => r.senderId)}::bigint[],
                             ${rows.map((r) => r.refId)}::bigint[], ${rows.map((r) => r.kind)}::smallint[], ${rows.map((r) => r.flags)}::smallint[],
                             ${rows.map((r) => r.body)}::text[])
        ON CONFLICT (match_id, id) DO NOTHING`,
  );
});

// ─── Read pointers ────────────────────────────────────────────────────────

/**
 * The read pointers that moved, for every conversation of a flush, in one
 * statement (`matches_flush_read()`: only forward, only rows that move).
 * "0" for a side that did not move. Returns the rows written.
 */
export const flushReadPointers = defineQuery(
  { name: 'chat.flushReadPointers', statements: 1 },
  async (db, pointers: readonly { matchId: string; lo: string; hi: string }[]): Promise<number> => {
    if (pointers.length === 0) return 0;
    const row = await one<{ n: number }>(
      db,
      sql`SELECT matches_flush_read(${pointers.map((p) => p.matchId)}::bigint[], ${pointers.map((p) => p.lo)}::bigint[],
                                    ${pointers.map((p) => p.hi)}::bigint[]) AS n`,
    );
    return Number(row.n);
  },
);

// ─── The list state ───────────────────────────────────────────────────────

export interface ConversationTailRow {
  matchId: string;
  lo: string;
  hi: string;
  loReadId: string;
  hiReadId: string;
  /** The newest message (null: none yet). */
  last: MessageRow | null;
  /** For the viewer asked about: the peer's messages after the viewer's read pointer, counted up to 100. */
  unread: number;
}

/** Messages counted as unread at most (a badge shows 99+). */
export const UNREAD_COUNT_CAP = 100;

/**
 * The newest message and both read pointers of each conversation, in one
 * statement (a primary-key probe per conversation): the list state when
 * Valkey's copy expired or was lost. With a viewer, also how many of the
 * peer's messages that viewer has not read (bounded; reactions and
 * unsends are not counted).
 */
export const conversationTails = defineQuery(
  { name: 'chat.conversationTails', statements: 1 },
  async (db, matchIds: readonly string[], viewerId: string | null): Promise<ConversationTailRow[]> => {
    if (matchIds.length === 0) return [];
    const rows = await many<{ id: string; lo: string; hi: string; lo_read: string; hi_read: string; last: unknown; unread: number }>(
      db,
      sql`SELECT m.id::text AS id, m.user_lo::text AS lo, m.user_hi::text AS hi, m.lo_read_id::text AS lo_read, m.hi_read_id::text AS hi_read,
                 (SELECT jsonb_build_array(y.id::text, y.sender_id::text, y.ref_id::text, y.kind, y.flags, y.body)
                    FROM messages y WHERE y.match_id = m.id ORDER BY y.id DESC LIMIT 1) AS last,
                 CASE WHEN ${viewerId}::bigint IS NULL THEN 0 ELSE
                   cardinality(ARRAY(
                     SELECT 1 FROM messages u
                      WHERE u.match_id = m.id
                        AND u.id > CASE WHEN m.user_lo = ${viewerId}::bigint THEN m.lo_read_id ELSE m.hi_read_id END
                        AND u.sender_id <> ${viewerId}::bigint AND u.kind NOT IN (7, 8)
                      LIMIT ${UNREAD_COUNT_CAP}::integer))
                 END AS unread
            FROM matches m
           WHERE m.id = ANY (${matchIds}::bigint[])`,
    );
    return rows.map((r) => {
      const last = r.last === null ? [] : rowsOf(r.id, [r.last]);
      return {
        matchId: r.id,
        lo: r.lo,
        hi: r.hi,
        loReadId: r.lo_read,
        hiReadId: r.hi_read,
        last: last[0] ?? null,
        unread: Number(r.unread),
      };
    });
  },
);

// ─── Conversation settings ────────────────────────────────────────────────

export interface ConversationFlagsWrite {
  matchId: string;
  userId: string;
  allowCalls?: boolean | undefined;
  muted?: boolean | undefined;
}

export interface ConversationFlagsRow {
  id: string;
  lo: string;
  hi: string;
  state: number;
  flags: number;
  source: number;
  /** The flags before the change. */
  before: number;
  loReadId: string;
  hiReadId: string;
  /** The other person's card (null: hidden, gone). */
  peerCard: unknown;
}

/**
 * The person's own call consent and mute of one active conversation
 * (`matches.flags`: 1/2 calls allowed by lo/hi, 4/8 muted by lo/hi), in one
 * statement; written only when a bit changes. Null when the person is not
 * in an active conversation of that id.
 */
export const setConversationFlags = defineQuery(
  { name: 'chat.setConversationFlags', statements: 1 },
  async (db, w: ConversationFlagsWrite): Promise<ConversationFlagsRow | null> => {
    const calls = w.allowCalls ?? null;
    const muted = w.muted ?? null;
    const row = await maybeOne<{
      id: string;
      lo: string;
      hi: string;
      state: number;
      flags: number;
      source: number;
      before: number;
      lo_read: string;
      hi_read: string;
      card: unknown;
    }>(
      db,
      sql`WITH cur AS (
            SELECT x.id, x.user_lo, x.user_hi, x.flags AS before,
                   CASE WHEN x.user_lo = ${w.userId}::bigint THEN 1 ELSE 2 END AS call_bit,
                   CASE WHEN x.user_lo = ${w.userId}::bigint THEN 4 ELSE 8 END AS mute_bit,
                   CASE WHEN x.user_lo = ${w.userId}::bigint THEN x.user_hi ELSE x.user_lo END AS peer
              FROM matches x
             WHERE x.id = ${w.matchId}::bigint AND x.state = 1
               AND (x.user_lo = ${w.userId}::bigint OR x.user_hi = ${w.userId}::bigint)
          ), next AS (
            SELECT c.*,
                   (CASE WHEN ${calls}::boolean IS NULL THEN c.before & c.call_bit WHEN ${calls}::boolean THEN c.call_bit ELSE 0 END
                    | CASE WHEN ${muted}::boolean IS NULL THEN c.before & c.mute_bit WHEN ${muted}::boolean THEN c.mute_bit ELSE 0 END
                    | (c.before & ~(c.call_bit | c.mute_bit)))::smallint AS flags
              FROM cur c
          ), up AS (
            UPDATE matches m SET flags = n.flags FROM next n WHERE m.id = n.id AND m.flags <> n.flags
            RETURNING m.id
          )
          SELECT n.id::text AS id, n.user_lo::text AS lo, n.user_hi::text AS hi, x.state, n.flags, x.source, n.before,
                 x.lo_read_id::text AS lo_read, x.hi_read_id::text AS hi_read,
                 CASE WHEN can_see(${w.userId}::bigint, n.peer, 2) THEN profile_card(n.peer) END AS card
            FROM next n JOIN matches x ON x.id = n.id`,
    );
    if (!row) return null;
    return {
      id: row.id,
      lo: row.lo,
      hi: row.hi,
      state: Number(row.state),
      flags: Number(row.flags),
      source: Number(row.source),
      before: Number(row.before),
      loReadId: row.lo_read,
      hiReadId: row.hi_read,
      peerCard: row.card ?? null,
    };
  },
);

// ─── Unsend and evidence ──────────────────────────────────────────────────

/**
 * The body of a taken-back message, removed once the window in which a
 * report may still copy it is over (flag 8, body NULL); only the sender's
 * own message, only once. Never while a legal hold names the conversation
 * or either of its people (the conversation is kept as it is, as the purge
 * paths keep it): `held` then, and the caller tries again later. `cleared`
 * when it was cleared now, `nothing` when there was nothing to clear.
 */
export const clearUnsentBody = defineQuery(
  { name: 'chat.clearUnsentBody', statements: 1 },
  async (db, matchId: string, messageId: string, senderId: string): Promise<'cleared' | 'held' | 'nothing'> => {
    const row = await one<{ outcome: string }>(
      db,
      sql`WITH m AS (SELECT x.id, x.user_lo, x.user_hi FROM matches x WHERE x.id = ${matchId}::bigint),
               held AS (SELECT EXISTS (SELECT 1 FROM legal_holds h, m
                                        WHERE h.released_at IS NULL
                                          AND (h.match_id = m.id OR h.user_id = m.user_lo OR h.user_id = m.user_hi)) AS yes),
               up AS (UPDATE messages SET body = NULL, flags = flags | 8
                       WHERE match_id = ${matchId}::bigint AND id = ${messageId}::bigint AND sender_id = ${senderId}::bigint
                         AND kind IN (1, 4) AND (flags & 8) = 0 AND NOT (SELECT yes FROM held)
                      RETURNING 1)
          SELECT CASE WHEN (SELECT yes FROM held) THEN 'held' WHEN EXISTS (SELECT 1 FROM up) THEN 'cleared' ELSE 'nothing' END AS outcome`,
    );
    return row.outcome === 'held' ? 'held' : row.outcome === 'cleared' ? 'cleared' : 'nothing';
  },
);

export interface ChatEvidenceInput {
  reportId: string;
  filingId: string;
  matchId: string | null;
  messageIds: readonly string[];
  /** How many of the conversation's messages before the filing are copied as its context. */
  context: number;
  /** Messages still in the write-behind stream, as evidence rows (after a long wait). */
  pending: readonly Record<string, unknown>[];
}

/** One filing's chat evidence copied into its report (`report_chat_evidence()`); -1 when the report is gone. */
export const writeChatEvidence = defineQuery({ name: 'chat.writeEvidence', statements: 1 }, async (db, e: ChatEvidenceInput): Promise<number> => {
  const row = await one<{ n: number }>(
    db,
    sql`SELECT report_chat_evidence(${e.reportId}::bigint, ${e.filingId}::bigint, ${e.matchId}::bigint, ${[...e.messageIds]}::bigint[],
                                    ${e.context}::integer, ${JSON.stringify(e.pending)}::jsonb) AS n`,
  );
  return Number(row.n);
});

/** A whole-number app_config value (a retention in days), or null when the key is not set. */
export const configNumber = defineQuery({ name: 'chat.configNumber', statements: 1 }, async (db, key: string): Promise<number | null> => {
  const row = await maybeOne<{ n: number | null }>(
    db,
    sql`SELECT CASE WHEN jsonb_typeof(c.value) = 'number' THEN (c.value #>> '{}')::numeric::integer END AS n
          FROM public.app_config c WHERE c.key = ${key}::text`,
  );
  return row?.n ?? null;
});

export interface ConversationListRow {
  id: string;
  lo: string;
  hi: string;
  peerId: string;
  state: number;
  flags: number;
  source: number;
  loReadId: string;
  hiReadId: string;
  /** visible_subset context 2: the peer may be listed. */
  visible: boolean;
  peerCard: unknown;
  /** The newest message (null: none yet, or the peer is not visible). */
  last: MessageRow | null;
  /** The peer's messages after the person's read pointer, counted up to {@link UNREAD_COUNT_CAP}. */
  unread: number;
}

/**
 * Every active conversation of a person with what its list shows, in one
 * statement: both sides of the pair key, the visibility of each peer
 * (context 2: a snoozed peer stays), the peer's card, the newest message
 * (a primary-key probe per conversation) and the unread count (bounded;
 * reactions and unsends are not counted). The rebuild of a conversation
 * list after a cache loss.
 */
export const conversationList = defineQuery({ name: 'chat.conversationList', statements: 1 }, async (db, userId: string): Promise<ConversationListRow[]> => {
  const rows = await many<{
    id: string;
    lo: string;
    hi: string;
    peer: string;
    state: number;
    flags: number;
    source: number;
    lo_read: string;
    hi_read: string;
    visible: boolean;
    card: unknown;
    last: unknown;
    unread: number;
  }>(
    db,
    sql`WITH mine AS (
          SELECT m.id, m.user_lo, m.user_hi, m.user_hi AS peer, m.state, m.flags, m.source, m.lo_read_id, m.hi_read_id, m.lo_read_id AS my_read
            FROM matches m WHERE m.user_lo = ${userId}::bigint AND m.state = 1
          UNION ALL
          SELECT m.id, m.user_lo, m.user_hi, m.user_lo, m.state, m.flags, m.source, m.lo_read_id, m.hi_read_id, m.hi_read_id
            FROM matches m WHERE m.user_hi = ${userId}::bigint AND m.state = 1
        ), seen AS (
          SELECT v.id FROM visible_subset(${userId}::bigint, ARRAY(SELECT peer FROM mine), 2) AS v(id)
        )
        SELECT x.id::text AS id, x.user_lo::text AS lo, x.user_hi::text AS hi, x.peer::text AS peer, x.state, x.flags, x.source,
               x.lo_read_id::text AS lo_read, x.hi_read_id::text AS hi_read, s.visible,
               CASE WHEN s.visible THEN profile_card(x.peer) END AS card,
               CASE WHEN s.visible THEN
                 (SELECT jsonb_build_array(y.id::text, y.sender_id::text, y.ref_id::text, y.kind, y.flags, y.body)
                    FROM messages y WHERE y.match_id = x.id ORDER BY y.id DESC LIMIT 1)
               END AS last,
               CASE WHEN s.visible THEN
                 cardinality(ARRAY(
                   SELECT 1 FROM messages u
                    WHERE u.match_id = x.id AND u.id > x.my_read AND u.sender_id <> ${userId}::bigint AND u.kind NOT IN (7, 8)
                    LIMIT ${UNREAD_COUNT_CAP}::integer))
               ELSE 0 END AS unread
          FROM mine x
          CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM seen z WHERE z.id = x.peer) AS visible) s`,
  );
  return rows.map((r) => ({
    id: r.id,
    lo: r.lo,
    hi: r.hi,
    peerId: r.peer,
    state: Number(r.state),
    flags: Number(r.flags),
    source: Number(r.source),
    loReadId: r.lo_read,
    hiReadId: r.hi_read,
    visible: r.visible === true,
    peerCard: r.card ?? null,
    last: r.last === null ? null : (rowsOf(r.id, [r.last])[0] ?? null),
    unread: Number(r.unread),
  }));
});
