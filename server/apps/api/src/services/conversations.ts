import { conversationsOf, matchesByIds, profileCards, unmatch, visiblePeers, type MatchRecordRow } from '@app/db';
import { decodeCursor, encodeCursor, idTime, realtimeEnvelope, userChannel, type Conversation, type PeerSummary } from '@app/shared';
import {
  cacheMatchState,
  conversationOf,
  encodeCard,
  decodeCard,
  forgetMatch,
  jobId,
  parseCardSource,
  peerSummaryOf,
  readConversationList,
  readMatchStates,
  readVersion,
  storeConversationList,
  type CardSource,
  type MatchState,
} from '@app/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { nextId } from '../auth/sessions.js';
import { HttpProblem } from '../lib/problem.js';
import type { ConfigSnapshot } from './cfg.js';

/**
 * The conversation list (`GET /v1/conversations`) and the unmatch, from
 * Valkey on the warm path:
 *
 * - `cl:<uid>` gives the page (newest activity first), `mt:<id>` each
 *   match's state, `ps:<peer>:<mev>` each peer's name, photo and badge
 *   (under the peer's own-account version, so an edit of their profile shows
 *   at once). No statement.
 * - The visibility rule (context 2: a snoozed peer stays) is applied with
 *   one `visible_subset` read when the last check is older than a minute, or
 *   when a peer was hidden since (`vis:out`: bans, deletions, shadowbans).
 * - After a cache loss the list is rebuilt from `matches` in one statement
 *   (visibility and peer cards included); missing match states and peer
 *   summaries are read in one statement each.
 *
 * `lastMessage` is null and `unread` 0 until chat exists (W4).
 */

/** How long a visibility check of a list stands. */
export const LIST_CHECK_MS = 60_000;
export const PEER_SUMMARY_TTL_SECONDS = 24 * 3_600;

const cursorSchema = z.object({ s: z.number().int().nonnegative(), i: z.string().regex(/^[1-9][0-9]{0,18}$/) });

function budget(request: FastifyRequest, statements: number): void {
  if (request.pgTally?.budget !== undefined) request.pgTally.budget += statements;
}

export interface ConversationPage {
  items: Conversation[];
  nextCursor: string | null;
}

function stateOf(row: MatchRecordRow): MatchState {
  return { ...row, createdMs: idTime(row.id).getTime() };
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
        byId.set(row.id, state);
        await cacheMatchState(app.redis, app.keys, state).catch((error: unknown) => this.log.warn({ err: error }, 'conversations: state not cached'));
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
    const items = shown
      .map((m) => {
        const peer = peers.get(peerOf(m));
        return peer ? conversationOf({ match: m, viewerId: userId, peer }) : null;
      })
      .filter((c): c is Conversation => c !== null);
    const last = page.at(-1);
    return { items, nextCursor: more && last ? encodeCursor({ s: last.score, i: last.id }) : null };
  }

  /** The list rebuilt from PostgreSQL in one statement, stored, and paged. */
  private async rebuild(userId: string, limit: number, before: { score: number; id: string } | undefined): Promise<ConversationPage> {
    const { app } = this;
    budget(this.request, 1);
    const rows = await conversationsOf(app.pg, userId);
    const entries = rows.map((r) => ({ id: r.id, score: idTime(r.id).getTime() }));
    try {
      await storeConversationList(app.redis, app.keys, userId, entries);
      for (const row of rows) await cacheMatchState(app.redis, app.keys, stateOf(row));
      await app.cache.set(app.keys.conversationListChecked(userId), String(Date.now()), 'PX', LIST_CHECK_MS);
    } catch (error) {
      this.log.warn({ err: error }, 'conversations: list not cached');
    }
    const ordered = rows
      .map((r) => ({ row: r, score: idTime(r.id).getTime() }))
      .filter(({ row, score }) => !before || score < before.score || (score === before.score && BigInt(row.id) < BigInt(before.id)))
      .sort((a, b) => b.score - a.score || (BigInt(b.row.id) > BigInt(a.row.id) ? 1 : -1));
    const page = ordered.slice(0, limit);
    const items: Conversation[] = [];
    for (const { row } of page) {
      if (!row.visible) continue;
      const card = parseCardSource(row.peerCard);
      if (!card) continue;
      await this.storePeer(row.peerId, card);
      const viewerRead = row.lo === userId ? row.loReadId : row.hiReadId;
      items.push(conversationOf({ match: stateOf(row), viewerId: userId, peer: peerSummaryOf(this.renderCtx(), row.peerId, card), myReadId: viewerRead }));
    }
    const last = page.at(-1);
    return { items, nextCursor: ordered.length > limit && last ? encodeCursor({ s: last.score, i: last.row.id }) : null };
  }

  /**
   * The peers the viewer may list (context 2). Checked at most once a minute,
   * and again as soon as one of the peers was hidden after the last check.
   */
  private async visibleSet(userId: string, peerIds: readonly string[]): Promise<Set<string>> {
    const { app } = this;
    if (peerIds.length === 0) return new Set();
    const [checkedAt, hidden] = await Promise.all([
      app.cache.get(app.keys.conversationListChecked(userId)),
      app.redis.zmscore(app.keys.accountsHidden(), ...peerIds),
    ]);
    const since = checkedAt === null ? null : Number(checkedAt);
    const hiddenSince = hidden.some((score) => score !== null && since !== null && Number(score) >= since);
    if (since !== null && !hiddenSince) return new Set(peerIds);
    budget(this.request, 1);
    const now = Date.now();
    const visible = await visiblePeers(app.pg, userId, peerIds, 2);
    await app.cache.set(app.keys.conversationListChecked(userId), String(now), 'PX', LIST_CHECK_MS).catch(() => undefined);
    return visible;
  }

  /** Peer summaries from `ps:<uid>:<mev>`; the misses built in one statement and stored. */
  async peerSummaries(userIds: readonly string[]): Promise<Map<string, PeerSummary>> {
    const { app } = this;
    const out = new Map<string, PeerSummary>();
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
      if (card) out.set(k.id, peerSummaryOf(this.renderCtx(), k.id, card));
    });
    const misses = unique.filter((id) => !out.has(id));
    if (misses.length > 0) {
      budget(this.request, 1);
      const cards = await profileCards(app.pg, misses);
      for (const id of misses) {
        const card = parseCardSource(cards.get(id));
        if (!card) continue;
        out.set(id, peerSummaryOf(this.renderCtx(), id, card));
        await this.storePeer(id, card);
      }
    }
    return out;
  }

  /** Keeps what a list shows of a person (the card's name, first photo and badge) under their current version. */
  private async storePeer(userId: string, card: CardSource): Promise<void> {
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
   * An unmatch: the match ends (one statement), both lists drop it, both
   * people get `conversation_end` (as for a block, a ban or a deletion),
   * and the messages are purged `retention.unmatched_messages_days` later
   * (the match row stays: it keeps the two out of each other's deck).
   */
  async unmatch(userId: string, matchId: string, cfg: ConfigSnapshot): Promise<void> {
    const { app } = this;
    const eventId = nextId(app);
    budget(this.request, 1);
    const pair = await unmatch(app.pg, matchId, userId);
    if (!pair) throw new HttpProblem('not_found');
    try {
      await forgetMatch(app.redis, app.keys, { id: matchId, lo: pair.lo, hi: pair.hi });
    } catch (error) {
      this.log.error({ err: error }, 'unmatch: lists not updated; they correct themselves on the next read');
    }
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
