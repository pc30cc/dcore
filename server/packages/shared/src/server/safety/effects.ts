import type { Redis } from 'ioredis';
import { wireTime, type ModerationAction } from '../../api/common.js';
import { userChannel } from '../../api/realtime.js';
import { accountStatus, moderationKind } from '../../codes.js';
import { realtimeEnvelope } from '../../realtime.js';
import { visibilityChange, type VisibilityChange } from '../../visibility.js';
import type { DenyList } from '../auth/denyList.js';
import type { RealtimePublisher } from '../clients/centrifugo.js';
import { markHiddenFromDecks } from '../deck/queue.js';
import type { PublicIds } from '../ids/publicId.js';
import type { KeyBuilder } from '../kv/keys.js';
import { bumpVersion } from '../kv/versions.js';
import { clearPairLikes } from '../social/likes.js';
import { MATCH_ENDED_TTL_SECONDS } from '../social/matches.js';

/**
 * The Valkey and realtime side of the visibility rule, applied when the
 * state changes (docs: "lists served from Valkey are kept consistent by the
 * same rule applied when the state changes"), so the next request of
 * everyone concerned already sees the change and no list re-reads
 * PostgreSQL to find it:
 *
 * - a block: the pair leaves each other's like buckets and deck queues, and
 *   their conversation (ended by the block) leaves both lists, exactly as an
 *   unmatch does;
 * - a moderation write (a ban, a suspension, a shadowban, a lift, a period
 *   that ended): `vis:out` when the person left the discovery or the
 *   relationship lists (deck queues built before skip them), the
 *   conversations a ban ended leave both lists, the peers of the remaining
 *   ones re-check visibility on their next read and their list versions
 *   move (no 304 over a changed list), the person's own view version moves,
 *   their access tokens stop at once when their scope shrinks, they hear
 *   `account`, and their connections close.
 *
 * Every step is idempotent: a retried job or request repeats it harmlessly.
 * Realtime event ids are planned once ({@link plannedEventIds}) so a retry
 * publishes under the same ids (Centrifugo's idempotency key, the client's
 * dedupe).
 */

export interface SafetyKv {
  /** kv-core (noeviction): likes, conversation lists and versions, `vis:out`. */
  redis: Redis;
  /** kv-cache: deck queues, list check marks. */
  cache: Redis;
  keys: KeyBuilder;
}

export interface EndedConversationRef {
  matchId: string;
  lo: string;
  hi: string;
}

function check(replies: [Error | null, unknown][] | null): void {
  const failed = replies?.find(([error]) => error !== null)?.[0];
  if (failed) throw failed;
}

/**
 * Conversations that ended (a block, a ban): their tombstones (a late
 * announcement of the match does nothing), out of both people's lists,
 * their eligibility state and chat pointers dropped, both list versions
 * bumped. The same keys the deletion fan-out clears.
 */
export async function endConversations(kv: SafetyKv, ended: readonly EndedConversationRef[]): Promise<void> {
  if (ended.length === 0) return;
  const { keys } = kv;
  const pipeline = kv.redis.pipeline();
  for (const { matchId } of ended) pipeline.set(keys.matchEnded(matchId), 1, 'EX', MATCH_ENDED_TTL_SECONDS);
  for (const { matchId, lo, hi } of ended) {
    pipeline.del(keys.matchState(matchId), keys.raw('lm', matchId), keys.raw('rp', matchId), keys.raw('dl', matchId));
    pipeline.zrem(keys.conversationList(lo), matchId);
    pipeline.zrem(keys.conversationList(hi), matchId);
    pipeline.hdel(keys.raw('unr', lo), matchId);
    pipeline.hdel(keys.raw('unr', hi), matchId);
    pipeline.srem(keys.raw('rp', 'dirty'), matchId);
  }
  check(await pipeline.exec());
  const people = new Set(ended.flatMap((e) => [e.lo, e.hi]));
  for (const uid of people) await bumpVersion(kv.redis, keys.conversationVersion(uid));
}

/**
 * Peers whose conversation lists show someone whose visibility changed:
 * their next read re-checks visibility (the minute's check mark goes) and
 * their list versions move.
 */
export async function recheckConversationLists(kv: SafetyKv, peers: readonly string[]): Promise<void> {
  const unique = [...new Set(peers)];
  if (unique.length === 0) return;
  await kv.cache.del(...unique.map((uid) => kv.keys.conversationListChecked(uid)));
  for (const uid of unique) await bumpVersion(kv.redis, kv.keys.conversationVersion(uid));
}

export interface BlockKvResult {
  /** A deck refill of either person was running: its write may put the other back, so the drop is repeated later. */
  refilling: boolean;
}

/** Drops each of the two from the other's deck queue; says whether a refill of either was running. */
export async function dropPairFromDecks(kv: SafetyKv, a: string, b: string): Promise<BlockKvResult> {
  const { keys } = kv;
  const replies = await kv.cache
    .pipeline()
    .lrem(keys.deckQueue(a), 0, b)
    .hdel(keys.deckMeta(a), b)
    .lrem(keys.deckQueue(b), 0, a)
    .hdel(keys.deckMeta(b), a)
    .exists(keys.deckLock(a), keys.deckLock(b))
    .exec();
  check(replies);
  return { refilling: Number(replies?.[4]?.[1] ?? 0) > 0 };
}

/**
 * The Valkey side of a block: the pair's block marker (a like between them
 * from now on enters no bucket), likes both ways, both deck queues, the
 * conversation it ended.
 */
export async function applyBlockKv(kv: SafetyKv, actorId: string, targetId: string, ended: EndedConversationRef | null): Promise<BlockKvResult> {
  await kv.redis.set(kv.keys.likesBlocked(actorId, targetId), 1);
  await clearPairLikes(kv.redis, kv.keys, actorId, targetId);
  const decks = await dropPairFromDecks(kv, actorId, targetId);
  if (ended) await endConversations(kv, [ended]);
  return decks;
}

/** What a moderation write did to an account (the database's answer). */
export interface ModerationEffectInput {
  userId: string;
  before: { status: number; shadowbanned: boolean };
  after: { status: number; shadowbanned: boolean };
  /** Conversations that ended (a ban). */
  ended: readonly (EndedConversationRef & { peerId: string })[];
  /** Peers in the account's remaining active conversations. */
  peers: readonly string[];
  /** The action as its subject reads it; absent or null for a shadowban. */
  action?: ActionViewLike | null | undefined;
}

/** `moderation_action_view()`: what the person reads of an action, times in ms. */
export interface ActionViewLike {
  id: string;
  kind: number;
  reasonText: string;
  startsAtMs: number;
  endsAtMs?: number | undefined;
  appeal?: { id: string; status: number; decisionText?: string | undefined } | undefined;
}

const APPEAL_STATUS = { 1: 'open', 2: 'upheld', 3: 'overturned' } as const;

/** The wire form of an action (`ModerationAction`), or null for a kind its subject never sees. */
export function moderationActionWire(view: ActionViewLike): ModerationAction | null {
  const kind = moderationKind.nameOrUndefined(view.kind);
  if (kind !== 'warning' && kind !== 'suspension' && kind !== 'ban') return null;
  const appealStatus = view.appeal ? APPEAL_STATUS[view.appeal.status as 1 | 2 | 3] : undefined;
  return {
    id: view.id,
    kind,
    reasonText: view.reasonText,
    startsAt: wireTime(view.startsAtMs),
    ...(view.endsAtMs !== undefined ? { endsAt: wireTime(view.endsAtMs) } : {}),
    ...(view.appeal && appealStatus
      ? { appeal: { id: view.appeal.id, status: appealStatus, ...(view.appeal.decisionText ? { decisionText: view.appeal.decisionText } : {}) } }
      : {}),
  };
}

const RESTRICTED = new Set([accountStatus.code('suspended'), accountStatus.code('banned')]);
const ACCOUNT_EVENT = 'account';

/** Whether the person hears about this write: their status moved, or an action they can read was written. */
function tellsSubject(effect: ModerationEffectInput): boolean {
  if (effect.before.status !== effect.after.status) return true;
  return effect.action !== null && effect.action !== undefined && moderationActionWire(effect.action) !== null;
}

/**
 * The event ids of a write's realtime side, keyed `account` and by
 * conversation id: those already planned are kept, the missing ones are
 * minted. A job stores the result before publishing, so a retry publishes
 * the same events.
 */
export function plannedEventIds(effect: ModerationEffectInput, existing: Readonly<Record<string, string>>, nextId: () => string): Record<string, string> {
  const ids: Record<string, string> = { ...existing };
  for (const { matchId } of effect.ended) ids[matchId] ??= nextId();
  if (tellsSubject(effect)) ids[ACCOUNT_EVENT] ??= nextId();
  return ids;
}

export interface ModerationEffectsDeps extends SafetyKv {
  publicIds: PublicIds;
  /** Null without Centrifugo: nothing is published (the lists are still right). */
  realtime: RealtimePublisher | null;
  /** Revokes access tokens when the scope shrinks; null where no deny list is configured. */
  denyList: DenyList | null;
  nextId: () => string;
  log?: { warn(object: object, message: string): void } | undefined;
}

export interface ModerationEffectsResult {
  change: VisibilityChange;
  /** Put in `vis:out`. */
  hidden: boolean;
  /** Access tokens revoked. */
  revoked: boolean;
  published: number;
  disconnected: boolean;
  eventIds: Record<string, string>;
}

/** Applies a moderation write's Valkey and realtime side (see the module comment). */
export async function applyModerationEffects(
  deps: ModerationEffectsDeps,
  effect: ModerationEffectInput,
  options: { eventIds?: Readonly<Record<string, string>> | undefined; at?: number | undefined } = {},
): Promise<ModerationEffectsResult> {
  const { keys } = deps;
  const at = options.at ?? Date.now();
  const change = visibilityChange(effect.before, effect.after);
  const eventIds = plannedEventIds(effect, options.eventIds ?? {}, deps.nextId);

  const hidden = change.leftDiscovery || change.leftRelationships;
  if (hidden) await markHiddenFromDecks(deps.redis, keys, [effect.userId], at);
  await endConversations(deps, effect.ended);
  if (change.leftRelationships || change.joinedRelationships) await recheckConversationLists(deps, effect.peers);

  const entersRestriction = !RESTRICTED.has(effect.before.status) && RESTRICTED.has(effect.after.status);
  let revoked = false;
  if (entersRestriction && deps.denyList) {
    // Tokens issued before now stop; the refresh gives a restricted session.
    await deps.denyList.revokeUser(effect.userId, new Date(at));
    revoked = true;
  }
  const tells = tellsSubject(effect);
  if (tells) await bumpVersion(deps.redis, keys.meVersion(effect.userId));

  let published = 0;
  let disconnected = false;
  if (deps.realtime) {
    for (const { matchId, lo, hi } of effect.ended) {
      const channels = [lo, hi].map((uid) => userChannel(deps.publicIds.user.encode(uid)));
      await deps.realtime.broadcast(channels, realtimeEnvelope('conversation_end', eventIds[matchId]!, at, { conversationId: matchId }));
      published += 1;
    }
    const status = accountStatus.nameOrUndefined(effect.after.status);
    const own = userChannel(deps.publicIds.user.encode(effect.userId));
    if (tells && status !== undefined && status !== 'purged') {
      const moderation = effect.action ? moderationActionWire(effect.action) : null;
      await deps.realtime.publish(
        own,
        realtimeEnvelope('account', eventIds[ACCOUNT_EVENT]!, at, { status, ...(moderation ? { moderation } : {}) }),
      );
      published += 1;
    }
    if (entersRestriction) {
      await deps.realtime.disconnect(deps.publicIds.user.encode(effect.userId));
      disconnected = true;
    }
  } else if (effect.ended.length > 0 || tells) {
    deps.log?.warn({ ended: effect.ended.length }, 'moderation: no Centrifugo configured; events were not sent');
  }
  return { change, hidden, revoked, published, disconnected, eventIds };
}
