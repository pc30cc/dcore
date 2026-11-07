import type { Redis } from 'ioredis';
import { likeWeek, likeWeeks, type KeyBuilder } from '../kv/keys.js';
import { luaScript, runScript } from '../kv/scripts.js';

/**
 * Likes received, kept in Valkey (kv-core) so that mutual-like detection and
 * "who liked me" cost no statement:
 *
 * - `lkin:<uid>:<w>`: the people who liked `uid` in week `w` and are still
 *   unanswered (a set of raw ids), five weekly buckets (`w-4 … w`), each
 *   capped at `likes.bucket_cap`; at the cap `lkin:<uid>:<w>:full` is set and
 *   nothing more is added, so a popular person's mutual likes are looked up in
 *   PostgreSQL instead (`check`).
 * - `lkin:<uid>:<w>:s`: the super likers among them (not capped).
 * - `lk:ready`: present while the buckets are complete. After a loss it is
 *   absent until the worker rebuilt them from `likes`; meanwhile every like is
 *   a `check`.
 *
 * The like itself goes to the write-behind stream `wb:like` (one multi-row
 * INSERT per batch in the worker). A match goes to `wb:match` inside the same
 * script, with the ids the caller minted, before the caller's INSERT.
 */

/** A bucket lives this long after its first like (five weekly buckets, plus a margin). */
export const LIKE_BUCKET_TTL_SECONDS = 36 * 86_400;

/**
 * How long `lkm:<lo>:<hi>` says that a pair matched. Matched people leave
 * each other's buckets, so without it a like sent again after the match (an
 * app resending a like whose answer it lost, or a card it showed before the
 * match) would count as a new pending like and tell the other person about
 * it. A week outlives every resend and every card a client keeps.
 */
export const MATCHED_PAIR_TTL_SECONDS = 7 * 86_400;

export type LikeScriptOutcome = 'match' | 'duplicate' | 'check' | 'liked';

export interface LikeScriptInput {
  actorId: string;
  targetId: string;
  likeId: string;
  /** 1 like, 2 super like. */
  kind: 1 | 2;
  /** 0 the profile, 1 a photo, 2 a prompt. */
  itemKind: 0 | 1 | 2;
  itemRef?: string | undefined;
  comment?: string | undefined;
  /** Minted before the call: used only when the script answers `match`. */
  matchId: string;
  noteIds: readonly [string, string];
  /** The like row is already in PostgreSQL (a super like paid from the wallet). */
  prepaid: boolean;
  /** `likes.bucket_cap`. */
  bucketCap: number;
  now?: number | undefined;
}

const likeScript = luaScript(new URL('./like.lua', import.meta.url), 'like', 26);

/** The 26 keys of the like script, in its order. */
export function likeScriptKeys(keys: KeyBuilder, actorId: string, targetId: string, now: number): string[] {
  const weeks = likeWeeks(now);
  const current = likeWeek(now);
  return [
    ...weeks.map((w) => keys.likesIn(actorId, w)),
    ...weeks.map((w) => keys.likesIn(targetId, w)),
    keys.stream('like'),
    keys.stream('match'),
    keys.likesInFull(targetId, current),
    ...weeks.map((w) => keys.likesInFull(actorId, w)),
    ...weeks.map((w) => keys.likesInSuper(actorId, w)),
    keys.likesInSuper(targetId, current),
    keys.likesReady(),
    keys.likesMatched(actorId, targetId),
  ];
}

/** Runs the like script (one round trip). */
export async function runLikeScript(redis: Redis, keys: KeyBuilder, input: LikeScriptInput): Promise<LikeScriptOutcome> {
  if (input.actorId === input.targetId) throw new RangeError('a like needs two people');
  if (!Number.isInteger(input.bucketCap) || input.bucketCap < 1) throw new RangeError('bucketCap must be a positive integer');
  const now = input.now ?? Date.now();
  const reply = await runScript(redis, likeScript, likeScriptKeys(keys, input.actorId, input.targetId, now), [
    input.targetId,
    input.actorId,
    input.likeId,
    input.kind,
    input.itemKind,
    input.itemRef ?? '',
    input.comment ?? '',
    LIKE_BUCKET_TTL_SECONDS,
    input.bucketCap,
    input.matchId,
    input.noteIds[0],
    input.noteIds[1],
    input.prepaid ? '1' : '0',
    MATCHED_PAIR_TTL_SECONDS,
  ]);
  const outcome = String(reply);
  if (outcome !== 'match' && outcome !== 'duplicate' && outcome !== 'check' && outcome !== 'liked') {
    throw new TypeError(`like script answered ${outcome.slice(0, 20)}`);
  }
  return outcome;
}

/** Whether `actorId` is among the pending likers of `targetId` (a read: no change). */
export async function isLikePending(redis: Redis, keys: KeyBuilder, actorId: string, targetId: string, now: number = Date.now()): Promise<boolean> {
  const pipeline = redis.pipeline();
  for (const w of likeWeeks(now)) pipeline.sismember(keys.likesIn(targetId, w), actorId);
  const replies = (await pipeline.exec()) ?? [];
  return replies.some(([error, value]) => {
    if (error) throw error;
    return Number(value) === 1;
  });
}

/**
 * Whether a like of `targetId` by `actorId` would change nothing: it is still
 * pending, or the two have matched (the like script answers `duplicate`).
 * Read before anything is charged for a like. One round trip.
 */
export async function isLikeAnswered(redis: Redis, keys: KeyBuilder, actorId: string, targetId: string, now: number = Date.now()): Promise<boolean> {
  const [matched, pending] = await Promise.all([redis.exists(keys.likesMatched(actorId, targetId)), isLikePending(redis, keys, actorId, targetId, now)]);
  return matched === 1 || pending;
}

/**
 * Removes `likerIds` from the pending likers of `userId` (a pass on someone
 * who liked them, a block, a match made another way). One round trip.
 */
export async function dropPendingLikers(redis: Redis, keys: KeyBuilder, userId: string, likerIds: readonly string[], now: number = Date.now()): Promise<void> {
  if (likerIds.length === 0) return;
  const pipeline = redis.pipeline();
  for (const w of likeWeeks(now)) {
    pipeline.srem(keys.likesIn(userId, w), ...likerIds);
    pipeline.srem(keys.likesInSuper(userId, w), ...likerIds);
  }
  const replies = (await pipeline.exec()) ?? [];
  const failed = replies.find(([error]) => error !== null)?.[0];
  if (failed) throw failed;
}

/** A matched pair is nobody's pending liker any more: both directions. */
export async function clearPairLikes(redis: Redis, keys: KeyBuilder, a: string, b: string, now: number = Date.now()): Promise<void> {
  const pipeline = redis.pipeline();
  for (const w of likeWeeks(now)) {
    pipeline.srem(keys.likesIn(a, w), b);
    pipeline.srem(keys.likesInSuper(a, w), b);
    pipeline.srem(keys.likesIn(b, w), a);
    pipeline.srem(keys.likesInSuper(b, w), a);
  }
  const replies = (await pipeline.exec()) ?? [];
  const failed = replies.find(([error]) => error !== null)?.[0];
  if (failed) throw failed;
}

export interface LikeBucket {
  week: number;
  likers: string[];
  superLikers: string[];
  full: boolean;
}

export interface PendingLikes {
  /** Newest week first. */
  buckets: LikeBucket[];
  /** Likers across the buckets (each person once). */
  total: number;
  /** A bucket reached its cap: the total is a lower bound ("N+"). */
  capped: boolean;
  /** `lk:ready` was present: the buckets are complete. */
  ready: boolean;
}

/** Every pending liker of `userId`, in one round trip. */
export async function readPendingLikes(redis: Redis, keys: KeyBuilder, userId: string, now: number = Date.now()): Promise<PendingLikes> {
  const weeks = likeWeeks(now).reverse();
  const pipeline = redis.pipeline();
  for (const w of weeks) {
    pipeline.smembers(keys.likesIn(userId, w));
    pipeline.smembers(keys.likesInSuper(userId, w));
    pipeline.exists(keys.likesInFull(userId, w));
  }
  pipeline.exists(keys.likesReady());
  const replies = (await pipeline.exec()) ?? [];
  const value = (index: number): unknown => {
    const entry = replies[index];
    if (!entry) throw new Error('pending likes: missing reply');
    if (entry[0]) throw entry[0];
    return entry[1];
  };
  const seen = new Set<string>();
  const buckets: LikeBucket[] = weeks.map((week, i) => {
    const supers = (value(i * 3 + 1) as string[]).filter((id) => !seen.has(id));
    const likers = [...new Set([...(value(i * 3) as string[]), ...supers])].filter((id) => !seen.has(id));
    for (const id of likers) seen.add(id);
    return { week, likers, superLikers: supers, full: Number(value(i * 3 + 2)) === 1 };
  });
  return {
    buckets,
    total: seen.size,
    capped: buckets.some((b) => b.full),
    ready: Number(value(weeks.length * 3)) === 1,
  };
}

/** How many people liked `userId` and wait for an answer (for the `like` event and push). */
export async function countPendingLikes(redis: Redis, keys: KeyBuilder, userId: string, now: number = Date.now()): Promise<{ total: number; capped: boolean }> {
  const pending = await readPendingLikes(redis, keys, userId, now);
  return { total: pending.total, capped: pending.capped };
}
