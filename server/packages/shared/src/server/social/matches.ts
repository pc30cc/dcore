import type { Redis } from 'ioredis';
import type { KeyBuilder } from '../kv/keys.js';
import { bumpVersion } from '../kv/versions.js';

/**
 * Conversations (a match is the conversation) as the zero-statement paths
 * read them:
 *
 * - `mt:<matchId>` (kv-core, 1 h): {lo, hi, st, fl, src, at} for
 *   eligibility checks; deleted when the conversation ends (on the instance
 *   the account deletion fan-out clears it on). A miss costs one primary-key
 *   read.
 * - `cl:<uid>` (kv-core, 30 days): the person's conversations, match id →
 *   last activity (ms). The member `0` (score -1) marks a complete list: a
 *   writer adds a new match whether or not the list is cached, and a reader
 *   trusts the list only with the marker (else it rebuilds it from
 *   `matches`), so a list that lost its key is never taken for a short one.
 * - `cv:<uid>` (kv-core): the list's version, its ETag; bumped on every change.
 */

export const MATCH_STATE_TTL_SECONDS = 3_600;
export const CONVERSATION_LIST_TTL_SECONDS = 30 * 86_400;
/** The member that marks a complete conversation list. */
export const LIST_COMPLETE = '0';

export interface MatchState {
  id: string;
  lo: string;
  hi: string;
  /** matches.state: 1 active, 2-5 ended. */
  state: number;
  /** matches.flags: 1/2 calls allowed by lo/hi, 4/8 muted by lo/hi. */
  flags: number;
  /** matches.source. */
  source: number;
  /** Creation time (the id's), ms. */
  createdMs: number;
}

function check(replies: [Error | null, unknown][] | null): void {
  const failed = replies?.find(([error]) => error !== null)?.[0];
  if (failed) throw failed;
}

/** Caches one match's state. */
export async function cacheMatchState(core: Redis, keys: KeyBuilder, match: MatchState): Promise<void> {
  const key = keys.matchState(match.id);
  check(
    await core
      .multi()
      .hset(key, { lo: match.lo, hi: match.hi, st: match.state, fl: match.flags, src: match.source, at: match.createdMs })
      .expire(key, MATCH_STATE_TTL_SECONDS)
      .exec(),
  );
}

/** The cached state of a match, or null (not cached: read it from PostgreSQL). */
export async function readMatchStates(core: Redis, keys: KeyBuilder, matchIds: readonly string[]): Promise<(MatchState | null)[]> {
  if (matchIds.length === 0) return [];
  const pipeline = core.pipeline();
  for (const id of matchIds) pipeline.hgetall(keys.matchState(id));
  const replies = (await pipeline.exec()) ?? [];
  return matchIds.map((id, index) => {
    const [error, value] = replies[index] ?? [new Error('missing reply'), null];
    if (error) throw error;
    const h = value as Record<string, string>;
    if (!h['lo'] || !h['hi']) return null;
    return {
      id,
      lo: h['lo'],
      hi: h['hi'],
      state: Number(h['st']),
      flags: Number(h['fl']),
      source: Number(h['src']),
      createdMs: Number(h['at']),
    };
  });
}

/**
 * A new match is in PostgreSQL: cache its state, add it to both people's
 * lists and bump both list versions. Idempotent (the API's fast path and the
 * stream worker both call it).
 */
export async function announceMatch(core: Redis, keys: KeyBuilder, match: MatchState): Promise<void> {
  await cacheMatchState(core, keys, match);
  const pipeline = core.pipeline();
  for (const uid of [match.lo, match.hi]) {
    const list = keys.conversationList(uid);
    pipeline.zadd(list, match.createdMs, match.id);
    pipeline.expire(list, CONVERSATION_LIST_TTL_SECONDS);
  }
  check(await pipeline.exec());
  await Promise.all([bumpVersion(core, keys.conversationVersion(match.lo)), bumpVersion(core, keys.conversationVersion(match.hi))]);
}

/** A conversation ended (unmatch, block, ban, deletion): out of both lists, its state dropped, both versions bumped. */
export async function forgetMatch(core: Redis, keys: KeyBuilder, match: { id: string; lo: string; hi: string }): Promise<void> {
  check(
    await core
      .pipeline()
      .zrem(keys.conversationList(match.lo), match.id)
      .zrem(keys.conversationList(match.hi), match.id)
      .del(keys.matchState(match.id))
      .exec(),
  );
  await Promise.all([bumpVersion(core, keys.conversationVersion(match.lo)), bumpVersion(core, keys.conversationVersion(match.hi))]);
}

/** A person's list rebuilt from PostgreSQL: every active match and the completeness marker. */
export async function storeConversationList(core: Redis, keys: KeyBuilder, userId: string, entries: readonly { id: string; score: number }[]): Promise<void> {
  const list = keys.conversationList(userId);
  const args: (string | number)[] = [-1, LIST_COMPLETE];
  for (const entry of entries) args.push(entry.score, entry.id);
  check(await core.multi().zadd(list, ...args).expire(list, CONVERSATION_LIST_TTL_SECONDS).exec());
}

export interface ConversationListPage {
  /** False when the list is not cached (or lost its marker): rebuild it. */
  complete: boolean;
  /** Newest activity first. */
  items: { id: string; score: number }[];
}

/**
 * A page of the cached list, newest first, strictly older than `before`
 * (a `score:id` cursor) when given.
 */
export async function readConversationList(
  core: Redis,
  keys: KeyBuilder,
  userId: string,
  limit: number,
  before?: { score: number; id: string },
): Promise<ConversationListPage> {
  const list = keys.conversationList(userId);
  const [marker, raw] = await Promise.all([
    core.zscore(list, LIST_COMPLETE),
    // Members with the cursor's score are filtered below; ask for a few more.
    before
      ? core.zrevrangebyscore(list, before.score, 0, 'WITHSCORES', 'LIMIT', 0, limit + 64)
      : core.zrevrangebyscore(list, '+inf', 0, 'WITHSCORES', 'LIMIT', 0, limit + 1),
  ]);
  if (marker === null) return { complete: false, items: [] };
  const items: { id: string; score: number }[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const id = raw[i]!;
    const score = Number(raw[i + 1]);
    if (id === LIST_COMPLETE) continue;
    if (before && (score > before.score || (score === before.score && BigInt(id) >= BigInt(before.id)))) continue;
    items.push({ id, score });
  }
  // Same score: newer id first, as the cursor expects.
  items.sort((a, b) => b.score - a.score || (BigInt(b.id) > BigInt(a.id) ? 1 : BigInt(b.id) < BigInt(a.id) ? -1 : 0));
  return { complete: true, items: items.slice(0, limit + 1) };
}
