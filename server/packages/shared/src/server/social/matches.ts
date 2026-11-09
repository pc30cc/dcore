import type { ChainableCommander, Redis } from 'ioredis';
import type { KeyBuilder } from '../kv/keys.js';
import { luaScript, runScript } from '../kv/scripts.js';
import { bumpVersion } from '../kv/versions.js';
import { MATCHED_PAIR_TTL_SECONDS } from './likes.js';

/**
 * Conversations (a match is the conversation) as the zero-statement paths
 * read them:
 *
 * - `mt:<matchId>` (kv-core, 1 h): {lo, hi, st, fl, src, at} for
 *   eligibility checks; deleted when the conversation ends (on the instance
 *   the account deletion fan-out clears it on), and never written back while
 *   `mte:` stands ({@link writeMatchState}). A miss costs one primary-key
 *   read.
 * - `cl:<uid>` (kv-core, 30 days): the person's conversations, match id →
 *   last activity (ms). The member `0` (score -1) marks a complete list: a
 *   writer adds a new match whether or not the list is cached, and a reader
 *   trusts the list only with the marker (else it rebuilds it from
 *   `matches`), so a list that lost its key is never taken for a short one.
 * - `cv:<uid>` (kv-core): the list's version, its ETag; bumped on every change.
 * - `mte:<matchId>` (kv-core, 1 h): the conversation ended. Every end path
 *   leaves it before it clears the state, and an announcement does nothing
 *   while it exists, so an announcement that read the match as active just
 *   before an unmatch or a block cannot put it back into the lists.
 */

export const MATCH_STATE_TTL_SECONDS = 3_600;
/** How long an ended conversation's tombstone stops late announcements (well past any announcement's read). */
export const MATCH_ENDED_TTL_SECONDS = 3_600;

const announceScript = luaScript(new URL('./matchAnnounce.lua', import.meta.url), 'match-announce', 5);
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

const stateScript = luaScript(new URL('./matchState.lua', import.meta.url), 'match-state', 3);

/** How long a dropped `mt:` copy refuses states read before the change that dropped it. */
export const MATCH_STATE_FENCE_SECONDS = 10;

/** `mtf:<id>` (kv-core, {@link MATCH_STATE_FENCE_SECONDS}): the conversation's cached state was dropped for a change. */
export function matchStateFence(keys: KeyBuilder, matchId: string): string {
  return keys.raw('mtf', matchId);
}

/** What {@link writeMatchState} did: `ended` (the tombstone) and `fenced` (a change a moment ago) wrote nothing. */
export type MatchStateWrite = 'cached' | 'ended' | 'fenced';

/**
 * Writes `mt:<id>` from a state read elsewhere (PostgreSQL), unless the
 * conversation ended meanwhile (its tombstone `mte:<id>`: a read that raced
 * an end never brings the conversation back) or its copy was dropped a
 * moment ago for a change ({@link dropMatchState}: a read that raced the
 * change never brings the old flags or visibility back). `vis` is written
 * when given, else the one stored stays.
 */
export async function writeMatchState(
  core: Redis,
  keys: KeyBuilder,
  match: MatchState,
  options: { ttlSeconds?: number | undefined; vis?: number | null | undefined } = {},
): Promise<MatchStateWrite> {
  const reply = await runScript(
    core,
    stateScript,
    [keys.matchState(match.id), keys.matchEnded(match.id), matchStateFence(keys, match.id)],
    [
      match.lo,
      match.hi,
      match.state,
      match.flags,
      match.source,
      match.createdMs,
      options.ttlSeconds ?? MATCH_STATE_TTL_SECONDS,
      options.vis ?? '',
    ],
  );
  const n = Number(reply);
  return n === 1 ? 'cached' : n === 0 ? 'ended' : 'fenced';
}

/** Caches one match's state (an hour), unless it may be stale ({@link writeMatchState}). */
export function cacheMatchState(core: Redis, keys: KeyBuilder, match: MatchState): Promise<MatchStateWrite> {
  return writeMatchState(core, keys, match);
}

/**
 * A writer changed what a conversation's cached state holds (call consent,
 * a person's visibility): the copy goes (whole, or only `field`), and for a
 * few seconds no state read before the change is cached again. Queued on
 * the caller's pipeline or transaction.
 */
export function dropMatchState(pipeline: ChainableCommander, keys: KeyBuilder, matchId: string, field?: 'vis'): void {
  pipeline.set(matchStateFence(keys, matchId), 1, 'EX', MATCH_STATE_FENCE_SECONDS);
  if (field) pipeline.hdel(keys.matchState(matchId), field);
  else pipeline.del(keys.matchState(matchId));
}

/**
 * The cached state of one conversation and whether it ended (its
 * tombstone), in one round trip: an ended conversation is never taken from
 * a copy of its state.
 */
export async function readMatchStateOrEnd(core: Redis, keys: KeyBuilder, matchId: string): Promise<{ ended: boolean; hash: Record<string, string> }> {
  const replies = await core.pipeline().exists(keys.matchEnded(matchId)).hgetall(keys.matchState(matchId)).exec();
  check(replies);
  return { ended: Number(replies?.[0]?.[1] ?? 0) === 1, hash: (replies?.[1]?.[1] ?? {}) as Record<string, string> };
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
    return matchStateOf(id, value as Record<string, string>);
  });
}

/** A match state from its `mt:` hash, or null when the hash holds none. */
export function matchStateOf(id: string, h: Record<string, string>): MatchState | null {
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
}

/**
 * A new match is in PostgreSQL: cache its state, add it to both people's
 * lists, mark the pair as matched for the like script (a match made from a
 * `check` or by the stream writer did not pass through its match branch) and
 * bump both list versions, in one script, unless the conversation has ended
 * since (its tombstone). Idempotent (the API's fast path and the stream
 * worker both call it). Returns false when nothing was announced: the
 * caller then tells nobody about the match.
 */
export async function announceMatch(core: Redis, keys: KeyBuilder, match: MatchState): Promise<boolean> {
  const reply = await runScript(
    core,
    announceScript,
    [keys.matchState(match.id), keys.matchEnded(match.id), keys.likesMatched(match.lo, match.hi), keys.conversationList(match.lo), keys.conversationList(match.hi)],
    [
      match.lo,
      match.hi,
      match.state,
      match.flags,
      match.source,
      match.createdMs,
      match.id,
      MATCH_STATE_TTL_SECONDS,
      MATCHED_PAIR_TTL_SECONDS,
      CONVERSATION_LIST_TTL_SECONDS,
    ],
  );
  if (Number(reply) !== 1) return false;
  await Promise.all([bumpVersion(core, keys.conversationVersion(match.lo)), bumpVersion(core, keys.conversationVersion(match.hi))]);
  return true;
}

/**
 * A conversation ended (unmatch, block, ban, deletion): its tombstone first,
 * then out of both lists and its state dropped (one transaction), both
 * versions bumped.
 */
export async function forgetMatch(core: Redis, keys: KeyBuilder, match: { id: string; lo: string; hi: string }): Promise<void> {
  check(
    await core
      .multi()
      .set(keys.matchEnded(match.id), 1, 'EX', MATCH_ENDED_TTL_SECONDS)
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
