import { z } from 'zod';
import { execute, many, maybeOne, sql, type Queryable } from '../query.js';
import { defineQuery } from './define.js';

/**
 * Likes, matches and conversations. The request paths touch PostgreSQL only
 * where correctness needs it: the match INSERT (with the pre-minted id), the
 * mutual-like look-up of a `check`, a super like paid from the wallet, the
 * likes list's visibility, the conversation list after a cache loss, and the
 * unmatch. The write-behind worker inserts likes in batches, and creates and
 * finishes matches from `wb:match`.
 *
 * Every list goes through the visibility rule of 0006 (`can_see`,
 * `visible_subset`); a pair that is blocked, or where either side is hidden,
 * never gets a match.
 */

const id = z.string().regex(/^[1-9][0-9]{0,18}$/);

export interface MatchRow {
  id: string;
  lo: string;
  hi: string;
  state: number;
  flags: number;
  source: number;
  /** The match was created by this statement. */
  created: boolean;
  /** `profile_card()` of each side (null when that person has no card: gone, hidden, not active). */
  loCard: unknown;
  hiCard: unknown;
}

interface MatchRecord {
  id: string;
  lo: string;
  hi: string;
  state: number;
  flags: number;
  source: number;
  created: boolean;
  lo_card: unknown;
  hi_card: unknown;
}

function matchRow(r: MatchRecord): MatchRow {
  return {
    id: id.parse(r.id),
    lo: id.parse(r.lo),
    hi: id.parse(r.hi),
    state: Number(r.state),
    flags: Number(r.flags),
    source: Number(r.source),
    created: r.created === true,
    loCard: r.lo_card ?? null,
    hiCard: r.hi_card ?? null,
  };
}

export interface CreateMatch {
  matchId: string;
  /** Who liked second. */
  actorId: string;
  /** Who liked first. */
  targetId: string;
  /** matches.source: 1 mutual like, 2 super like, 4 like on an item. */
  source: 1 | 2 | 4;
}

/**
 * The match of a mutual like, in one statement: INSERT with the pre-minted
 * id unless the pair already has a match (`ON CONFLICT (user_lo, user_hi) DO
 * NOTHING`), only while each may see the other in discovery (no block,
 * both active, neither shadowbanned, the same test-account side). It returns
 * the row it created, or the pair's existing row (`created` false; its id is
 * the pre-minted one when the other writer was first), with both people's
 * cards. No row: the pair may not match (or a concurrent writer of the same
 * pair has not committed yet; {@link matchOfPair} reads it again).
 * New matches take the call bits from both profiles' accept_calls.
 */
export const createMatch = defineQuery({ name: 'social.createMatch', statements: 1 }, async (db, m: CreateMatch): Promise<MatchRow | null> => {
  const row = await maybeOne<MatchRecord>(
    db,
    sql`WITH pair AS (
          SELECT least(${m.actorId}::bigint, ${m.targetId}::bigint) AS lo, greatest(${m.actorId}::bigint, ${m.targetId}::bigint) AS hi
        ), ins AS (
          INSERT INTO matches (id, user_lo, user_hi, source, flags)
          SELECT ${m.matchId}::bigint, p.lo, p.hi, ${m.source}::smallint,
                 ((CASE WHEN coalesce((SELECT pl.accept_calls FROM profiles pl WHERE pl.user_id = p.lo), true) THEN 1 ELSE 0 END)
                  | (CASE WHEN coalesce((SELECT ph.accept_calls FROM profiles ph WHERE ph.user_id = p.hi), true) THEN 2 ELSE 0 END))::smallint
            FROM pair p
           WHERE can_see(${m.actorId}::bigint, ${m.targetId}::bigint, 1) AND can_see(${m.targetId}::bigint, ${m.actorId}::bigint, 1)
          ON CONFLICT (user_lo, user_hi) DO NOTHING
          RETURNING id, user_lo, user_hi, state, flags, source
        ), found AS (
          SELECT i.id, i.user_lo, i.user_hi, i.state, i.flags, i.source, true AS created FROM ins i
          UNION ALL
          SELECT x.id, x.user_lo, x.user_hi, x.state, x.flags, x.source, false
            FROM matches x, pair p
           WHERE x.user_lo = p.lo AND x.user_hi = p.hi AND NOT EXISTS (SELECT 1 FROM ins)
        )
        SELECT f.id::text AS id, f.user_lo::text AS lo, f.user_hi::text AS hi, f.state, f.flags, f.source, f.created,
               profile_card(f.user_lo) AS lo_card, profile_card(f.user_hi) AS hi_card
          FROM found f`,
  );
  return row ? matchRow(row) : null;
});

/** The pair's match (any state) with both cards, or null; for the rare race where a concurrent INSERT of the same pair hid it. */
export const matchOfPair = defineQuery({ name: 'social.matchOfPair', statements: 1 }, async (db, a: string, b: string): Promise<MatchRow | null> => {
  const row = await maybeOne<MatchRecord>(
    db,
    sql`SELECT m.id::text AS id, m.user_lo::text AS lo, m.user_hi::text AS hi, m.state, m.flags, m.source, false AS created,
               profile_card(m.user_lo) AS lo_card, profile_card(m.user_hi) AS hi_card
          FROM matches m
         WHERE m.user_lo = least(${a}::bigint, ${b}::bigint) AND m.user_hi = greatest(${a}::bigint, ${b}::bigint)`,
  );
  return row ? matchRow(row) : null;
});

export interface MatchRecordRow {
  id: string;
  lo: string;
  hi: string;
  state: number;
  flags: number;
  source: number;
}

/** One match by id (the cache miss of `mt:<id>`). */
export const matchById = defineQuery({ name: 'social.matchById', statements: 1 }, async (db, matchId: string): Promise<MatchRecordRow | null> => {
  const row = await maybeOne<{ id: string; lo: string; hi: string; state: number; flags: number; source: number }>(
    db,
    sql`SELECT m.id::text AS id, m.user_lo::text AS lo, m.user_hi::text AS hi, m.state, m.flags, m.source
          FROM matches m WHERE m.id = ${matchId}::bigint`,
  );
  return row ? { id: row.id, lo: row.lo, hi: row.hi, state: Number(row.state), flags: Number(row.flags), source: Number(row.source) } : null;
});

/** Several matches by id, in one statement (the cache misses of a conversation page). */
export const matchesByIds = defineQuery({ name: 'social.matchesByIds', statements: 1 }, async (db, matchIds: readonly string[]): Promise<MatchRecordRow[]> => {
  if (matchIds.length === 0) return [];
  const rows = await many<{ id: string; lo: string; hi: string; state: number; flags: number; source: number }>(
    db,
    sql`SELECT m.id::text AS id, m.user_lo::text AS lo, m.user_hi::text AS hi, m.state, m.flags, m.source
          FROM matches m WHERE m.id = ANY (${matchIds}::bigint[])`,
  );
  return rows.map((r) => ({ id: r.id, lo: r.lo, hi: r.hi, state: Number(r.state), flags: Number(r.flags), source: Number(r.source) }));
});

/**
 * An unmatch by one of its two people: state 2, only while it is active.
 * Returns the pair, or null (not a member, already ended, unknown).
 */
export const unmatch = defineQuery(
  { name: 'social.unmatch', statements: 1 },
  async (db, matchId: string, userId: string): Promise<{ lo: string; hi: string } | null> =>
    maybeOne<{ lo: string; hi: string }>(
      db,
      sql`UPDATE matches m
             SET state = 2, ended_at = now(), ended_by = CASE WHEN m.user_lo = ${userId}::bigint THEN 1 ELSE 2 END
           WHERE m.id = ${matchId}::bigint AND m.state = 1
             AND (m.user_lo = ${userId}::bigint OR m.user_hi = ${userId}::bigint)
         RETURNING m.user_lo::text AS lo, m.user_hi::text AS hi`,
    ),
);

/**
 * The fallback of mutual-like detection while the buckets are incomplete:
 * did `targetId` like `actorId` within the window (a primary-key point
 * look-up over the window's partitions), and may the two still match (no
 * block, no match yet)?
 */
export const mutualLikeExists = defineQuery(
  { name: 'social.mutualLikeExists', statements: 1 },
  async (db, actorId: string, targetId: string, windowDays: number): Promise<boolean> => {
    const row = await maybeOne<{ found: boolean }>(
      db,
      sql`SELECT EXISTS (SELECT 1 FROM likes l
                          WHERE l.target_id = ${actorId}::bigint AND l.actor_id = ${targetId}::bigint
                            AND l.id >= id_floor(now() - make_interval(days => ${windowDays}::integer)))
             AND NOT EXISTS (SELECT 1 FROM blocks b
                              WHERE b.user_lo = least(${actorId}::bigint, ${targetId}::bigint)
                                AND b.user_hi = greatest(${actorId}::bigint, ${targetId}::bigint))
             AND NOT EXISTS (SELECT 1 FROM matches m
                              WHERE m.user_lo = least(${actorId}::bigint, ${targetId}::bigint)
                                AND m.user_hi = greatest(${actorId}::bigint, ${targetId}::bigint)) AS found`,
    );
    return row?.found === true;
  },
);

/** Of the given likes (actor liked target), those whose target liked the actor back within the window, and whose pair has no match and no block. */
export const mutualLikesAmong = defineQuery(
  { name: 'social.mutualLikesAmong', statements: 1 },
  async (db, likes: readonly { actorId: string; targetId: string }[], windowDays: number): Promise<{ actorId: string; targetId: string }[]> => {
    if (likes.length === 0) return [];
    const rows = await many<{ actor: string; target: string }>(
      db,
      sql`SELECT DISTINCT p.a::text AS actor, p.t::text AS target
            FROM unnest(${likes.map((l) => l.actorId)}::bigint[], ${likes.map((l) => l.targetId)}::bigint[]) AS p(a, t)
           WHERE EXISTS (SELECT 1 FROM likes l
                          WHERE l.target_id = p.a AND l.actor_id = p.t
                            AND l.id >= id_floor(now() - make_interval(days => ${windowDays}::integer)))
             AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.user_lo = least(p.a, p.t) AND b.user_hi = greatest(p.a, p.t))
             AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.user_lo = least(p.a, p.t) AND m.user_hi = greatest(p.a, p.t))`,
    );
    return rows.map((r) => ({ actorId: r.actor, targetId: r.target }));
  },
);

export interface LikeRow {
  id: string;
  targetId: string;
  actorId: string;
  kind: 1 | 2;
  itemKind: 0 | 1 | 2;
  itemRef: string | null;
  comment: string | null;
}

/**
 * A batch of likes from `wb:like` in one statement, whatever its size (seven
 * array parameters, a stable plan): `ON CONFLICT DO NOTHING` on the primary
 * key, so a replayed batch, or a like the wallet transaction already wrote,
 * is a no-op. Returns the rows inserted.
 */
export const insertLikes = defineQuery({ name: 'social.insertLikes', statements: 1 }, async (db, likes: readonly LikeRow[]): Promise<number> => {
  if (likes.length === 0) return 0;
  return execute(
    db,
    sql`INSERT INTO likes (target_id, actor_id, id, item_ref, kind, item_kind, comment)
        SELECT * FROM unnest(${likes.map((l) => l.targetId)}::bigint[], ${likes.map((l) => l.actorId)}::bigint[],
                             ${likes.map((l) => l.id)}::bigint[], ${likes.map((l) => l.itemRef)}::bigint[],
                             ${likes.map((l) => l.kind)}::smallint[], ${likes.map((l) => l.itemKind)}::smallint[],
                             ${likes.map((l) => l.comment)}::text[])
        ON CONFLICT (target_id, actor_id, id) DO NOTHING`,
  );
});

export interface WalletSuperLike {
  userId: string;
  /** The session's store (its balance is spent first, then store 0). */
  store: number;
  /** billing.cross_store_entitlements: any store's balance may be spent. */
  crossStore: boolean;
  ledgerId: string;
  like: LikeRow;
}

/**
 * A super like beyond the weekly quota, paid from the wallet: inside the
 * caller's transaction, the debit (`balance >= 1`, the session store's
 * balance first, then gifts), its ledger row, and the like row itself with
 * the pre-minted id, so a paid like is never only in Valkey. Returns the
 * balance left, or null when there was none to spend (the caller rolls
 * back; only the first statement ran).
 */
export const spendSuperLike = defineQuery(
  { name: 'social.spendSuperLike', statements: 3 },
  async (tx, w: WalletSuperLike): Promise<{ store: number; balance: number } | null> => {
    const debit = await maybeOne<{ store: number; balance: number }>(
      tx,
      sql`UPDATE wallet_balances b
             SET balance = b.balance - 1, updated_at = now()
            FROM (SELECT s.store FROM wallet_balances s
                   WHERE s.user_id = ${w.userId}::bigint AND s.item = 1 AND s.balance >= 1
                     AND (${w.crossStore}::boolean OR s.store = 0 OR s.store = ${w.store}::smallint)
                   ORDER BY (s.store = ${w.store}::smallint) DESC, s.store DESC
                   LIMIT 1
                   FOR UPDATE) pick
           WHERE b.user_id = ${w.userId}::bigint AND b.item = 1 AND b.store = pick.store AND b.balance >= 1
         RETURNING b.store, b.balance`,
    );
    if (!debit) return null;
    await execute(
      tx,
      sql`INSERT INTO wallet_ledger (id, user_id, ref_id, delta, balance_after, item, store, reason)
          VALUES (${w.ledgerId}::bigint, ${w.userId}::bigint, ${w.like.id}::bigint, -1, ${debit.balance}::integer, 1, ${debit.store}::smallint, 2)`,
    );
    const l = w.like;
    await execute(
      tx,
      sql`INSERT INTO likes (target_id, actor_id, id, item_ref, kind, item_kind, comment)
          VALUES (${l.targetId}::bigint, ${l.actorId}::bigint, ${l.id}::bigint, ${l.itemRef}::bigint, ${l.kind}::smallint,
                  ${l.itemKind}::smallint, ${l.comment}::text)
          ON CONFLICT (target_id, actor_id, id) DO NOTHING`,
    );
    return { store: Number(debit.store), balance: Number(debit.balance) };
  },
);

export interface VisibleLiker {
  id: string;
  /** `profile_card()` (null when the person has no card). */
  card: unknown;
}

/**
 * Of the given pending likers, those the viewer may see in a discovery list
 * (`visible_subset`, context 1) and has not matched, with their cards: the
 * one statement of a likes page.
 */
export const visibleLikers = defineQuery(
  { name: 'social.visibleLikers', statements: 1 },
  async (db, viewerId: string, likerIds: readonly string[]): Promise<VisibleLiker[]> => {
    if (likerIds.length === 0) return [];
    const rows = await many<{ id: string; card: unknown }>(
      db,
      sql`SELECT v.id::text AS id, profile_card(v.id) AS card
            FROM visible_subset(${viewerId}::bigint, ${likerIds}::bigint[], 1) AS v(id)
           WHERE NOT EXISTS (SELECT 1 FROM matches m
                              WHERE m.user_lo = least(${viewerId}::bigint, v.id) AND m.user_hi = greatest(${viewerId}::bigint, v.id))`,
    );
    return rows.map((r) => ({ id: r.id, card: r.card ?? null }));
  },
);

export interface LikeDetail {
  actorId: string;
  kind: 1 | 2;
  itemKind: 0 | 1 | 2;
  itemRef: string | null;
  comment: string | null;
}

/**
 * The newest like of each of the given people for `targetId` within the
 * window: the liked item and the comment (see-likes). A primary-key prefix
 * scan (`target_id`, then `actor_id`).
 */
export const likeDetails = defineQuery(
  { name: 'social.likeDetails', statements: 1 },
  async (db, targetId: string, actorIds: readonly string[], windowDays: number): Promise<LikeDetail[]> => {
    if (actorIds.length === 0) return [];
    const rows = await many<{ actor: string; kind: number; item_kind: number; item_ref: string | null; comment: string | null }>(
      db,
      sql`SELECT DISTINCT ON (l.actor_id) l.actor_id::text AS actor, l.kind, l.item_kind, l.item_ref::text AS item_ref, l.comment
            FROM likes l
           WHERE l.target_id = ${targetId}::bigint AND l.actor_id = ANY (${actorIds}::bigint[])
             AND l.id >= id_floor(now() - make_interval(days => ${windowDays}::integer))
           ORDER BY l.actor_id, l.id DESC`,
    );
    return rows.map((r) => ({
      actorId: r.actor,
      kind: Number(r.kind) as 1 | 2,
      itemKind: Number(r.item_kind) as 0 | 1 | 2,
      itemRef: r.item_ref,
      comment: r.comment,
    }));
  },
);

export interface ProfileView {
  /** May the viewer open this profile (context 2 while they share an active conversation, else 1)? */
  visible: boolean;
  card: unknown;
}

/** A profile opened from chat, likes or requests: the visibility rule and the card, in one statement. */
export const profileFor = defineQuery({ name: 'social.profileFor', statements: 1 }, async (db, viewerId: string, targetId: string): Promise<ProfileView> => {
  const row = await maybeOne<{ visible: boolean; card: unknown }>(
    db,
    sql`SELECT can_see(${viewerId}::bigint, ${targetId}::bigint,
                       CASE WHEN EXISTS (SELECT 1 FROM matches m
                                          WHERE m.user_lo = least(${viewerId}::bigint, ${targetId}::bigint)
                                            AND m.user_hi = greatest(${viewerId}::bigint, ${targetId}::bigint)
                                            AND m.state = 1)
                            THEN 2 ELSE 1 END) AS visible,
               profile_card(${targetId}::bigint) AS card`,
  );
  return { visible: row?.visible === true, card: row?.card ?? null };
});

export interface ConversationRow {
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
}

/**
 * Every active conversation of a person (both sides of the pair key), the
 * visibility of each peer (context 2: a snoozed peer stays) and the peer's
 * card: the rebuild of a conversation list after a cache loss, in one statement.
 */
export const conversationsOf = defineQuery({ name: 'social.conversationsOf', statements: 1 }, async (db, userId: string): Promise<ConversationRow[]> => {
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
  }>(
    db,
    sql`WITH mine AS (
          SELECT m.id, m.user_lo, m.user_hi, m.user_hi AS peer, m.state, m.flags, m.source, m.lo_read_id, m.hi_read_id
            FROM matches m WHERE m.user_lo = ${userId}::bigint AND m.state = 1
          UNION ALL
          SELECT m.id, m.user_lo, m.user_hi, m.user_lo, m.state, m.flags, m.source, m.lo_read_id, m.hi_read_id
            FROM matches m WHERE m.user_hi = ${userId}::bigint AND m.state = 1
        ), seen AS (
          SELECT v.id FROM visible_subset(${userId}::bigint, ARRAY(SELECT peer FROM mine), 2) AS v(id)
        )
        SELECT x.id::text AS id, x.user_lo::text AS lo, x.user_hi::text AS hi, x.peer::text AS peer, x.state, x.flags, x.source,
               x.lo_read_id::text AS lo_read, x.hi_read_id::text AS hi_read,
               EXISTS (SELECT 1 FROM seen s WHERE s.id = x.peer) AS visible,
               CASE WHEN EXISTS (SELECT 1 FROM seen s WHERE s.id = x.peer) THEN profile_card(x.peer) END AS card
          FROM mine x`,
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
  }));
});

/** The people of `ids` the viewer may list in context `ctx` (1 discovery, 2 relationships). */
export const visiblePeers = defineQuery(
  { name: 'social.visiblePeers', statements: 1 },
  async (db, viewerId: string, ids: readonly string[], ctx: 1 | 2): Promise<Set<string>> => {
    if (ids.length === 0) return new Set();
    const rows = await many<{ id: string }>(db, sql`SELECT v.id::text AS id FROM visible_subset(${viewerId}::bigint, ${ids}::bigint[], ${ctx}::integer) AS v(id)`);
    return new Set(rows.map((r) => r.id));
  },
);

export interface LikeNotesInput {
  matchId: string;
  /** Who liked second (their like is in the match entry). */
  actorId: string;
  /** Who liked first (their like is read from `likes`). */
  targetId: string;
  /** Pre-minted: the first like's note, then the second's. */
  noteIds: readonly [string, string];
  /** The second like's item and comment. */
  itemRef: string | null;
  comment: string | null;
  windowDays: number;
}

export interface LikeNote {
  id: string;
  senderId: string;
  refId: string | null;
  body: string;
}

/**
 * The first lines of a new conversation: each like's comment as a like note
 * (messages kind 6, ref = the liked item), with the pre-minted ids, in one
 * statement: the earlier like is read from `likes` (a primary-key point
 * look-up; the caller waits until `wb:like` is durable past the second like),
 * the second comes from the match entry. Returns the notes inserted: none on
 * a replay (the ids exist), so they are announced once.
 */
export const writeLikeNotes = defineQuery({ name: 'social.writeLikeNotes', statements: 1 }, async (db, n: LikeNotesInput): Promise<LikeNote[]> => {
  const rows = await many<{ id: string; sender: string; ref: string | null; body: string }>(
    db,
    sql`WITH earlier AS (
          SELECT l.item_ref, l.comment
            FROM likes l
           WHERE l.target_id = ${n.actorId}::bigint AND l.actor_id = ${n.targetId}::bigint
             AND l.id >= id_floor(now() - make_interval(days => ${n.windowDays}::integer))
           ORDER BY l.id DESC
           LIMIT 1
        ), notes AS (
          SELECT ${n.noteIds[0]}::bigint AS id, ${n.targetId}::bigint AS sender, e.item_ref AS ref, e.comment AS body
            FROM earlier e WHERE e.comment IS NOT NULL
          UNION ALL
          SELECT ${n.noteIds[1]}::bigint, ${n.actorId}::bigint, ${n.itemRef}::bigint, ${n.comment}::text
           WHERE ${n.comment}::text IS NOT NULL
        )
        INSERT INTO messages (match_id, id, sender_id, ref_id, kind, flags, body)
        SELECT ${n.matchId}::bigint, x.id, x.sender, x.ref, 6, 0, x.body FROM notes x
        ON CONFLICT (match_id, id) DO NOTHING
        RETURNING id::text AS id, sender_id::text AS sender, ref_id::text AS ref, body`,
  );
  return rows.map((r) => ({ id: r.id, senderId: r.sender, refId: r.ref, body: r.body }));
});

export interface PushTarget {
  notifyFlags: number;
  locale: string;
  devices: { id: string; token: string; locale: string | null }[];
}

/**
 * Where a push to a person goes: their push switches and language, and the
 * devices that may show it (a token, notifications on, a live session on
 * that device). One statement; null for an account that cannot get pushes
 * (not active or snoozed).
 */
export const pushTargetsOf = defineQuery({ name: 'social.pushTargetsOf', statements: 1 }, async (db, userId: string): Promise<PushTarget | null> => {
  const row = await maybeOne<{ notify_flags: number; locale: string; devices: { id: string; token: string; locale: string | null }[] | null }>(
    db,
    sql`SELECT u.notify_flags, u.locale,
               (SELECT jsonb_agg(jsonb_build_object('id', d.id::text, 'token', d.push_token, 'locale', d.locale) ORDER BY d.id)
                  FROM devices d
                 WHERE d.user_id = u.id AND d.push_token IS NOT NULL AND d.disabled_at IS NULL
                   AND EXISTS (SELECT 1 FROM sessions s
                                WHERE s.device_id = d.id AND s.revoked_at IS NULL AND s.expires_at > now())) AS devices
          FROM users u
         WHERE u.id = ${userId}::bigint AND u.status IN (3, 4)`,
  );
  if (!row) return null;
  return { notifyFlags: Number(row.notify_flags), locale: row.locale, devices: row.devices ?? [] };
});

/** A device whose push token FCM no longer knows: its token cleared (one statement). */
export const clearDeadPushToken = defineQuery(
  { name: 'social.clearDeadPushToken', statements: 1 },
  async (db, deviceId: string, token: string): Promise<boolean> =>
    (await execute(
      db,
      sql`UPDATE devices SET push_token = NULL, push_token_hash = NULL, updated_at = now()
           WHERE id = ${deviceId}::bigint AND push_token = ${token}::text`,
    )) === 1,
);

/**
 * The unmatch purge: a match's messages and calls (the match row stays: it
 * keeps the pair out of each other's deck), unless the conversation is
 * active again or a legal hold names it or one of its members. The deletes
 * are data-modifying CTEs, which run whether or not the result reads them.
 */
export const purgeUnmatched = defineQuery(
  { name: 'social.purgeUnmatched', statements: 1 },
  async (db, matchId: string): Promise<'purged' | 'held' | 'active' | 'missing'> => {
    const row = await maybeOne<{ outcome: string }>(
      db,
      sql`WITH m AS (SELECT x.id, x.user_lo, x.user_hi, x.state FROM matches x WHERE x.id = ${matchId}::bigint),
               held AS (SELECT EXISTS (SELECT 1 FROM legal_holds h, m
                                        WHERE h.released_at IS NULL
                                          AND (h.match_id = m.id OR h.user_id = m.user_lo OR h.user_id = m.user_hi)) AS yes),
               go AS (SELECT m.id FROM m, held WHERE m.state <> 1 AND NOT held.yes),
               msgs AS (DELETE FROM messages WHERE match_id = (SELECT id FROM go) RETURNING 1),
               gone AS (DELETE FROM calls WHERE match_id = (SELECT id FROM go) RETURNING 1)
          SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM m) THEN 'missing'
                      WHEN (SELECT state FROM m) = 1 THEN 'active'
                      WHEN (SELECT yes FROM held) THEN 'held'
                      ELSE 'purged' END AS outcome`,
    );
    return (row?.outcome ?? 'missing') as 'purged' | 'held' | 'active' | 'missing';
  },
);
