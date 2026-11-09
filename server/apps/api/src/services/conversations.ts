import { conversationList, conversationTails, matchesByIds, profileCards, unmatch, visiblePeers, type MatchRecordRow } from '@app/db';
import { decodeCursor, encodeCursor, idTime, realtimeEnvelope, userChannel, type Conversation, type Message, type PeerSummary } from '@app/shared';
import {
  ACTIVE_RECENTLY_SECONDS,
  cacheMatchState,
  conversationOf,
  encodeCard,
  decodeCard,
  endConversations,
  jobId,
  lastSeenOf,
  messageOf,
  onlineOf,
  parseCardSource,
  peerSummaryOf,
  readConversationList,
  readConversationTails,
  readMatchStates,
  readVersion,
  seedConversationTails,
  seedUnread,
  storeConversationList,
  type CardSource,
  type ConversationTailState,
  type LastMessageState,
  type MatchState,
} from '@app/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { nextId } from '../auth/sessions.js';
import { HttpProblem } from '../lib/problem.js';
import { endCallsOf } from './calls.js';
import type { ConfigSnapshot } from './cfg.js';
import { planFeature, sessionPlan } from './plans.js';
import { sessionOf } from './session.js';

/**
 * The conversation list (`GET /v1/conversations`) and the unmatch, from
 * Valkey on the warm path:
 *
 * - `cl:<uid>` gives the page (newest activity first), `mt:<id>` each
 *   match's state, `ps:<peer>:<mev>` each peer's name, photo, badge and
 *   "show online" (under the peer's own-account version, so an edit of
 *   their profile shows at once), and the chat state each conversation's
 *   newest message (`lm:`), the viewer's unread count (`unr:`) and both
 *   read and delivered pointers (`rp:`, `dl:`). No statement.
 * - The visibility rule (context 2: a snoozed peer stays) is applied with
 *   one `visible_subset` read for the peers whose last check is older than a
 *   minute or who were hidden since (`vis:out`: bans, deletions,
 *   shadowbans). Each peer's verdict is kept with its time in `cl:ok:<uid>`
 *   (a kv-cache hash that lives a minute from its first check), so a peer
 *   found hidden stays hidden on the next pages and reads; a change of a
 *   peer's visibility deletes the hash of each of their peers.
 * - What the viewer may see of the peer: `online` and `activeRecently` only
 *   while the peer shows online (presence from Centrifugo, 30 s); the peer's
 *   read pointer only with the viewer's read receipts; the peer's delivered
 *   pointer only while the peer shows online.
 * - A conversation whose chat state expired (a quiet week) is read back in
 *   one statement for all of them and kept again. After a cache loss the
 *   list is rebuilt from `matches` in one statement (visibility, peer cards
 *   and the chat state, unread counts included); missing match states and
 *   peer summaries are read in one statement each.
 */

/** How long a visibility check of a list stands. */
export const LIST_CHECK_MS = 60_000;
/** Clock slack between processes when comparing a hide time with a check time. */
const CHECK_SLACK_MS = 5_000;

/** A kept verdict: `<ms>:<1|0>`. */
function parseCheck(value: string | null): { at: number; visible: boolean } | null {
  if (value === null) return null;
  const m = /^([0-9]{1,15}):([01])$/.exec(value);
  return m ? { at: Number(m[1]), visible: m[2] === '1' } : null;
}
export const PEER_SUMMARY_TTL_SECONDS = 24 * 3_600;

const cursorSchema = z.object({ s: z.number().int().nonnegative(), i: z.string().regex(/^[1-9][0-9]{0,18}$/) });

function budget(request: FastifyRequest, statements: number): void {
  if (request.pgTally?.budget !== undefined) request.pgTally.budget += statements;
}

export interface ConversationPage {
  items: Conversation[];
  nextCursor: string | null;
}

/** A peer as a list shows them, and whether they show online. */
export interface ListedPeer {
  summary: PeerSummary;
  showOnline: boolean;
}

function stateOf(row: MatchRecordRow): MatchState {
  return { ...row, createdMs: idTime(row.id).getTime() };
}

/** The larger of two decimal ids (null when neither is set). */
export function laterId(a: string | null | undefined, b: string | null | undefined): string | null {
  const x = a && a !== '0' ? a : null;
  const y = b && b !== '0' ? b : null;
  if (!x) return y;
  if (!y) return x;
  return BigInt(x) >= BigInt(y) ? x : y;
}

const BODY_KINDS = new Set([1, 4, 5, 6, 7]);

/** `lm:<m>` as the wire's `lastMessage` (null: no message yet). */
export function lastMessageOf(app: FastifyInstance, matchId: string, last: LastMessageState | null): Message | null {
  if (!last || last.id === '0' || !last.senderId) return null;
  try {
    return messageOf(
      { publicIds: app.publicIds },
      { id: last.id, matchId, senderId: last.senderId, refId: last.refId, kind: last.kind, flags: last.flags, body: BODY_KINDS.has(last.kind) ? last.preview : null },
    );
  } catch {
    return null;
  }
}

/** What a conversation shows besides its match: the chat state and the peer's presence, as the viewer may see them. */
export interface ConversationExtras {
  readReceipts: boolean;
  online: boolean;
  activeRecently: boolean;
}

export class ConversationService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly request: FastifyRequest,
  ) {}

  private get log() {
    return this.request.log;
  }

  private renderCtx() {
    return { publicIds: this.app.publicIds, media: this.app.media };
  }

  /** The list's version (`cv:<uid>`), its ETag. */
  async version(userId: string): Promise<number> {
    return readVersion(this.app.redis, this.app.keys.conversationVersion(userId));
  }

  async page(userId: string, limit: number, cursor: string | undefined): Promise<ConversationPage> {
    const { app } = this;
    let before: { score: number; id: string } | undefined;
    if (cursor !== undefined) {
      const decoded = decodeCursor(cursorSchema, cursor);
      if (!decoded) throw new HttpProblem('bad_request', { detail: 'The cursor is not valid.' });
      before = { score: decoded.s, id: decoded.i };
    }
    const cached = await readConversationList(app.redis, app.keys, userId, limit, before);
    if (!cached.complete) return this.rebuild(userId, limit, before);

    const page = cached.items.slice(0, limit);
    const more = cached.items.length > limit;
    const states = await readMatchStates(app.redis, app.keys, page.map((p) => p.id));
    const missing = page.filter((_, i) => states[i] === null).map((p) => p.id);
    const byId = new Map<string, MatchState>();
    page.forEach((p, i) => {
      const state = states[i];
      if (state) byId.set(p.id, state);
    });
    if (missing.length > 0) {
      budget(this.request, 1);
      for (const row of await matchesByIds(app.pg, missing)) {
        const state = stateOf(row);
        const kept = await cacheMatchState(app.redis, app.keys, state).catch((error: unknown) => {
          this.log.warn({ err: error }, 'conversations: state not cached');
          return 'cached' as const;
        });
        // The conversation ended after the read: it leaves the list like any ended one.
        if (kept !== 'ended') byId.set(row.id, state);
      }
    }
    const active = page.map((p) => byId.get(p.id)).filter((m): m is MatchState => m?.state === 1);
    const ended = page.filter((p) => !active.some((m) => m.id === p.id)).map((p) => p.id);
    // Ended or unknown conversations leave the list (the next read is already right).
    if (ended.length > 0) await app.redis.zrem(app.keys.conversationList(userId), ...ended).catch(() => undefined);

    const peerOf = (m: MatchState) => (m.lo === userId ? m.hi : m.lo);
    const visible = await this.visibleSet(userId, active.map(peerOf));
    const shown = active.filter((m) => visible.has(peerOf(m)));
    const peers = await this.peerSummaries(shown.map(peerOf));
    const listed = shown.filter((m) => peers.has(peerOf(m)));
    const tails = await this.tails(userId, listed.map((m) => m.id));
    const extras = await this.extras(userId, listed.map(peerOf), peers);
    const items = listed.map((m) => this.render(m, userId, peers.get(peerOf(m))!, tails.get(m.id), extras(peerOf(m))));
    const last = page.at(-1);
    return { items, nextCursor: more && last ? encodeCursor({ s: last.score, i: last.id }) : null };
  }

  /** The list rebuilt from PostgreSQL in one statement (its chat state included), stored, and paged. */
  private async rebuild(userId: string, limit: number, before: { score: number; id: string } | undefined): Promise<ConversationPage> {
    const { app } = this;
    budget(this.request, 1);
    const rows = await conversationList(app.pg, userId);
    const visibleRows = rows.filter((r) => r.visible);
    const tailRows = visibleRows.map((r) => ({ matchId: r.id, lo: r.lo, hi: r.hi, loReadId: r.loReadId, hiReadId: r.hiReadId, last: r.last, unread: r.unread }));
    // Valkey may hold newer state than the database (messages still in the write-behind stream): it wins where it has any.
    const kept = visibleRows.length > 0 ? await readConversationTails(app.redis, app.keys, userId, visibleRows.map((r) => r.id)).catch(() => new Map<string, ConversationTailState>()) : new Map<string, ConversationTailState>();
    const merged = new Map<string, ConversationTailState>();
    for (const t of tailRows) {
      const v = kept.get(t.matchId);
      const last: LastMessageState = v?.last ?? (t.last
        ? { id: t.last.id, senderId: t.last.senderId, kind: t.last.kind, refId: t.last.refId, flags: t.last.flags, preview: t.last.body ?? '' }
        : { id: '0', senderId: '', kind: 0, refId: null, flags: 0, preview: '' });
      merged.set(t.matchId, {
        last,
        unread: v?.unreadKept ? v.unread : t.unread,
        unreadKept: true,
        read: { lo: laterId(v?.read.lo, t.loReadId), hi: laterId(v?.read.hi, t.hiReadId) },
        delivered: v?.delivered ?? { lo: null, hi: null },
      });
    }
    const lastAt = new Map([...merged].map(([id, t]) => [id, t.last && t.last.id !== '0' ? idTime(t.last.id).getTime() : null]));
    // The order is the newest activity: the newest message, else the match.
    const scoreOf = (r: { id: string }) => lastAt.get(r.id) ?? idTime(r.id).getTime();
    const entries = rows.map((r) => ({ id: r.id, score: scoreOf(r) }));
    // A conversation that ended after the read (its tombstone refuses the state) leaves the list and the page.
    const endedNow = new Set<string>();
    try {
      await storeConversationList(app.redis, app.keys, userId, entries);
      for (const row of rows) if ((await cacheMatchState(app.redis, app.keys, stateOf(row))) === 'ended') endedNow.add(row.id);
      if (endedNow.size > 0) await app.redis.zrem(app.keys.conversationList(userId), ...endedNow);
      await this.storeChecks(userId, rows.map((r) => r.peerId), new Set(visibleRows.map((r) => r.peerId)), Date.now());
      await seedConversationTails(
        app.redis,
        app.keys,
        tailRows.map((t) => ({ matchId: t.matchId, last: t.last, loReadId: t.loReadId, hiReadId: t.hiReadId })),
      );
      await seedUnread(app.redis, app.keys, userId, new Map(tailRows.filter((t) => !kept.get(t.matchId)?.unreadKept).map((t) => [t.matchId, t.unread])));
    } catch (error) {
      this.log.warn({ err: error }, 'conversations: list not cached');
    }
    const ordered = rows
      .filter((r) => !endedNow.has(r.id))
      .map((r) => ({ row: r, score: scoreOf(r) }))
      .filter(({ row, score }) => !before || score < before.score || (score === before.score && BigInt(row.id) < BigInt(before.id)))
      .sort((a, b) => b.score - a.score || (BigInt(b.row.id) > BigInt(a.row.id) ? 1 : -1));
    const page = ordered.slice(0, limit);
    const peers = new Map<string, ListedPeer>();
    const tails = merged;
    const listed: MatchState[] = [];
    for (const { row } of page) {
      if (!row.visible) continue;
      const card = parseCardSource(row.peerCard);
      if (!card) continue;
      await this.storePeer(row.peerId, card);
      peers.set(row.peerId, { summary: peerSummaryOf(this.renderCtx(), row.peerId, card), showOnline: card.so === true });
      listed.push(stateOf(row));
    }
    const peerOf = (m: MatchState) => (m.lo === userId ? m.hi : m.lo);
    const extras = await this.extras(userId, listed.map(peerOf), peers);
    const items = listed.map((m) => this.render(m, userId, peers.get(peerOf(m))!, tails.get(m.id), extras(peerOf(m))));
    const last = page.at(-1);
    return { items, nextCursor: ordered.length > limit && last ? encodeCursor({ s: last.score, i: last.row.id }) : null };
  }

  /**
   * The chat state of conversations from Valkey; those whose state expired
   * (`lm:` gone after a quiet week) are read in one statement and kept again.
   */
  async tails(userId: string, matchIds: readonly string[]): Promise<Map<string, ConversationTailState>> {
    const { app } = this;
    const tails = await readConversationTails(app.redis, app.keys, userId, matchIds);
    const expired = matchIds.filter((id) => tails.get(id)?.last === null);
    if (expired.length === 0) return tails;
    budget(this.request, 1);
    const rows = await conversationTails(app.pg, expired, null);
    for (const t of rows) {
      const kept = tails.get(t.matchId);
      if (!kept) continue;
      kept.last = t.last
        ? { id: t.last.id, senderId: t.last.senderId, kind: t.last.kind, refId: t.last.refId, flags: t.last.flags, preview: t.last.body ?? '' }
        : { id: '0', senderId: '', kind: 0, refId: null, flags: 0, preview: '' };
      kept.read = { lo: laterId(kept.read.lo, t.loReadId), hi: laterId(kept.read.hi, t.hiReadId) };
    }
    await seedConversationTails(
      app.redis,
      app.keys,
      rows.map((t) => ({ matchId: t.matchId, last: t.last, loReadId: t.loReadId, hiReadId: t.hiReadId })),
    ).catch((error: unknown) => this.log.warn({ err: error }, 'conversations: chat state not kept'));
    return tails;
  }

  /**
   * What the viewer may see of each peer: presence and "active recently"
   * while the peer shows online, and whether the viewer's plan has read
   * receipts (the session's plan: cached, else one statement).
   */
  async extras(userId: string, peerIds: readonly string[], peers: ReadonlyMap<string, ListedPeer>): Promise<(peerId: string) => ConversationExtras> {
    const { app } = this;
    const session = sessionOf(app, this.request);
    const cfg = app.cfg.get();
    const plan = peerIds.length > 0 ? await sessionPlan({ cache: app.cache, keys: app.keys, db: app.pg, log: this.log }, this.request, cfg, userId, session.storeCode) : null;
    const readReceipts = planFeature(plan?.plan, 'read_receipts');
    const shows = peerIds.filter((id) => peers.get(id)?.showOnline === true);
    const online = await onlineOf(
      { cache: app.cache, keys: app.keys, reader: app.presence, publicUidOf: (id) => app.publicIds.user.encode(id), log: this.log },
      shows,
    );
    const seen = shows.length > 0 ? await lastSeenOf(app.cache, app.keys, shows).catch(() => new Map<string, number | null>()) : new Map<string, number | null>();
    const now = Math.floor(Date.now() / 1_000);
    return (peerId) => {
      const isOnline = online.get(peerId) === true;
      const lastSeen = seen.get(peerId) ?? null;
      return {
        readReceipts,
        online: isOnline,
        activeRecently: !isOnline && lastSeen !== null && now - lastSeen <= ACTIVE_RECENTLY_SECONDS,
      };
    };
  }

  /** A conversation as the viewer sees it, with its chat state and what they may see of the peer. */
  render(m: Pick<MatchState, 'id' | 'lo' | 'hi' | 'state' | 'flags' | 'source'>, userId: string, peer: ListedPeer, tail: ConversationTailState | undefined, extras: ConversationExtras): Conversation {
    const side = m.lo === userId ? 'lo' : 'hi';
    const peerSide = side === 'lo' ? 'hi' : 'lo';
    const summary: Conversation['peer'] = { ...peer.summary };
    if (peer.showOnline && extras.online) summary.online = true;
    else if (peer.showOnline && extras.activeRecently) summary.activeRecently = true;
    const conversation = conversationOf({
      match: m,
      viewerId: userId,
      peer: summary,
      myReadId: tail?.read[side] ?? undefined,
      unread: tail?.unread ?? 0,
    });
    conversation.lastMessage = lastMessageOf(this.app, m.id, tail?.last ?? null);
    const peerRead = tail?.read[peerSide] ?? null;
    if (extras.readReceipts && peerRead) conversation.peerReadId = peerRead;
    const peerDelivered = laterId(tail?.delivered[peerSide], null);
    if (peer.showOnline && peerDelivered) conversation.peerDeliveredId = peerDelivered;
    return conversation;
  }

  /**
   * The peers the viewer may list (context 2). A peer is checked again
   * (one statement for all of them) when their last verdict is older than a
   * minute, or when they were hidden after it; otherwise the kept verdict
   * stands.
   */
  private async visibleSet(userId: string, peerIds: readonly string[]): Promise<Set<string>> {
    const { app } = this;
    const visible = new Set<string>();
    if (peerIds.length === 0) return visible;
    const unique = [...new Set(peerIds)];
    const key = app.keys.conversationListChecked(userId);
    const [checks, hidden] = await Promise.all([
      // Unreadable (a value of another shape, kv-cache down): every peer is checked.
      app.cache.hmget(key, ...unique).catch(async (): Promise<(string | null)[]> => {
        await app.cache.del(key).catch(() => undefined);
        return [];
      }),
      app.redis.zmscore(app.keys.accountsHidden(), ...unique),
    ]);
    const unknown: string[] = [];
    unique.forEach((id, i) => {
      const check = parseCheck(checks[i] ?? null);
      const hiddenAt = hidden[i] === null || hidden[i] === undefined ? null : Number(hidden[i]);
      if (!check || (hiddenAt !== null && hiddenAt >= check.at - CHECK_SLACK_MS)) unknown.push(id);
      else if (check.visible) visible.add(id);
    });
    if (unknown.length === 0) return visible;
    budget(this.request, 1);
    const now = Date.now();
    const seen = await visiblePeers(app.pg, userId, unknown, 2);
    for (const id of seen) visible.add(id);
    await this.storeChecks(userId, unknown, seen, now);
    return visible;
  }

  /** Keeps the verdicts of a check (`<ms>:<1|0>` per peer); the hash lives a minute from its first verdict. */
  private async storeChecks(userId: string, peerIds: readonly string[], visible: ReadonlySet<string>, at: number): Promise<void> {
    if (peerIds.length === 0) return;
    const { app } = this;
    const key = app.keys.conversationListChecked(userId);
    const fields: Record<string, string> = {};
    for (const id of peerIds) fields[id] = `${at}:${visible.has(id) ? 1 : 0}`;
    await app.cache
      .multi()
      .hset(key, fields)
      .pexpire(key, LIST_CHECK_MS, 'NX')
      .exec()
      .catch((error: unknown) => this.log.warn({ err: error }, 'conversations: visibility verdicts not kept'));
  }

  /** Peer summaries (and "show online") from `ps:<uid>:<mev>`; the misses built in one statement and stored. */
  async peerSummaries(userIds: readonly string[]): Promise<Map<string, ListedPeer>> {
    const { app } = this;
    const out = new Map<string, ListedPeer>();
    if (userIds.length === 0) return out;
    const unique = [...new Set(userIds)];
    const versions = await app.redis.mget(...unique.map((id) => app.keys.meVersion(id)));
    const withVersion: { id: string; version: number }[] = [];
    unique.forEach((id, i) => {
      const version = Number(versions[i] ?? 0);
      if (Number.isSafeInteger(version) && version > 0) withVersion.push({ id, version });
    });
    const values = withVersion.length > 0 ? await app.cache.mgetBuffer(...withVersion.map((k) => app.keys.peerSummary(k.id, k.version))) : [];
    withVersion.forEach((k, i) => {
      const value = values[i];
      const card = value ? decodeCard(value) : null;
      if (card) out.set(k.id, { summary: peerSummaryOf(this.renderCtx(), k.id, card), showOnline: card.so === true });
    });
    const misses = unique.filter((id) => !out.has(id));
    if (misses.length > 0) {
      budget(this.request, 1);
      const cards = await profileCards(app.pg, misses);
      for (const id of misses) {
        const card = parseCardSource(cards.get(id));
        if (!card) continue;
        out.set(id, { summary: peerSummaryOf(this.renderCtx(), id, card), showOnline: card.so === true });
        await this.storePeer(id, card);
      }
    }
    return out;
  }

  /** Keeps what a list shows of a person (the card's name, first photo, badge and "show online") under their current version. */
  async storePeer(userId: string, card: CardSource): Promise<void> {
    const { app } = this;
    try {
      const version = await readVersion(app.redis, app.keys.meVersion(userId));
      const slim: CardSource = { ...card, photos: card.photos.slice(0, 1), prompts: [], fields: [], about: undefined, job: undefined };
      await app.cache.set(app.keys.peerSummary(userId, version), encodeCard(slim), 'EX', PEER_SUMMARY_TTL_SECONDS);
    } catch (error) {
      this.log.warn({ err: error }, 'conversations: peer summary not cached');
    }
  }

  /**
   * An unmatch: the match ends (one statement), both lists drop it with its
   * chat state (newest message, unread counts, pointers), both people get
   * `conversation_end` (as for a block, a ban or a deletion), and the
   * messages are purged `retention.unmatched_messages_days` later (the
   * match row stays: it keeps the two out of each other's deck).
   */
  async unmatch(userId: string, matchId: string, cfg: ConfigSnapshot): Promise<void> {
    const { app } = this;
    const eventId = nextId(app);
    budget(this.request, 1);
    const pair = await unmatch(app.pg, matchId, userId);
    if (!pair) throw new HttpProblem('not_found');
    try {
      await endConversations({ redis: app.redis, cache: app.cache, keys: app.keys }, [{ matchId, lo: pair.lo, hi: pair.hi }]);
    } catch (error) {
      this.log.error({ err: error }, 'unmatch: lists not updated; they correct themselves on the next read');
    }
    // A call the two are in ends with the conversation.
    await endCallsOf(app, this.log, [{ matchId, lo: pair.lo, hi: pair.hi }]);
    if (app.realtime) {
      const channels = [pair.lo, pair.hi].map((id) => userChannel(app.publicIds.user.encode(id)));
      await app.realtime
        .broadcast(channels, realtimeEnvelope('conversation_end', eventId, Date.now(), { conversationId: matchId }))
        .catch((error: unknown) => this.log.warn({ err: error }, 'unmatch: event not published'));
    }
    const days = cfg.app['retention.unmatched_messages_days'];
    await app.jobs
      .add('account', 'unmatch-purge', jobId('unmatch-purge', matchId), { matchId }, { delayMs: days * 86_400_000, attempts: 5, backoffMs: 60_000 })
      .catch((error: unknown) => this.log.error({ err: error, matchId }, 'unmatch: purge not queued'));
  }
}
