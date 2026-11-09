import { chatEligibility, historyPage, isTransientDatabaseError, messageSender, setConversationFlags } from '@app/db';
import {
  idFloor,
  idTime,
  isStorableText,
  messageKind,
  realtimeEnvelope,
  userChannel,
  type Conversation,
  type Message,
  type MessagesPage,
  type MessagesQuery,
  type SendMessage,
} from '@app/shared';
import {
  bumpVersion,
  cacheChatState,
  chatJobIds,
  chatKeys,
  FLAG,
  jobId,
  KIND,
  largestIdAt,
  listEffectOf,
  messageOf,
  messagePushDue,
  moveReceipts,
  noteSeen,
  parseCardSource,
  parseMessageEntry,
  peerSummaryOf,
  randomToken,
  readMessageDurability,
  readOpenChatState,
  receiptAllowed,
  sendMessage,
  sidesVisible,
  typingAllowed,
  writeChangedMatchState,
  type ChatState,
  type SendRecord,
  type StoredMessage,
} from '@app/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nextId } from '../auth/sessions.js';
import { HttpProblem } from '../lib/problem.js';
import type { AccountView } from './account.js';
import type { ConfigSnapshot } from './cfg.js';
import { ConversationService, laterId } from './conversations.js';
import { bestPlan, planFeature, sessionPlan } from './plans.js';
import type { AppSession } from './session.js';

/**
 * A conversation's messages: send, history, receipts, typing and the
 * conversation's own settings.
 *
 * Sending costs PostgreSQL nothing (docs: chat send, step by step): the
 * conversation's eligibility comes from its cached state (`mt:<m>`, with
 * each side's visibility; a miss costs one primary-key read, kept an hour),
 * banned terms are checked in memory, and one Valkey script does the rest
 * atomically: the client id's record (a retry within 15 minutes gets the
 * same message), the append to `wb:msg` with the pre-minted id, and the list
 * state (newest message, order, the recipient's unread count, versions).
 * Then, when a replica is configured, `WAIT` until the entry is on it; then
 * the message is published to both people's channels (the event id is the
 * message id) and, for news the recipient is not looking at, one push per
 * conversation and recipient per 10 minutes is queued. The worker writes the
 * stream to PostgreSQL in batches.
 *
 * A sender the other person may not see (a shadowban) is answered as usual
 * and sees their message; the other person is never told and never counts
 * it. A conversation whose other person the sender may not see is not
 * found, as in the lists.
 */

function budget(request: FastifyRequest, statements: number): void {
  if (request.pgTally?.budget !== undefined) request.pgTally.budget += statements;
}

/** The write-behind margin of the flush watermark (ids minted a moment before their append). */
const WATERMARK_MARGIN_MS = 5_000;
/** The unsend check looks this far around the target's time in the stream. */
const STREAM_SEARCH_MS = 10_000;
const STREAM_SEARCH_COUNT = 5_000;
const CONFIRM_TTL_SECONDS = 600;

function unavailable(cause: unknown): HttpProblem {
  return new HttpProblem('service_unavailable', { detail: 'Send the request again in a moment.', headers: { 'retry-after': '2' }, cause });
}

function codePoints(text: string): number {
  return [...text].length;
}

/** Links, e-mail addresses, phone numbers and money: flagged for review, never refused for it. */
const RISKY = [
  /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]{2,}\.(com|net|org|ir|me|io|app|link|ly|to|gg)\b/i,
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/i,
  /(?:[+۰-۹0-9][\s.-]?){9,}/,
  /\b(usdt|bitcoin|btc|crypto|wallet|iban|paypal|western union|gift ?card)\b/i,
];

export function riskyPattern(text: string): boolean {
  return RISKY.some((pattern) => pattern.test(text));
}

export interface SentResult {
  message: Message;
  replayed: boolean;
}

export class ChatService {
  private readonly c;

  constructor(
    private readonly app: FastifyInstance,
    private readonly request: FastifyRequest,
  ) {
    this.c = chatKeys(app.keys);
  }

  private get log() {
    return this.request.log;
  }

  private publicUid(userId: string): string {
    return this.app.publicIds.user.encode(userId);
  }

  // ─── Eligibility ────────────────────────────────────────────────────────

  /**
   * The conversation's cached state with each side's visibility; read
   * from PostgreSQL (one statement) when it is not cached or its
   * visibility is not known. Null for a conversation that ended: its
   * tombstone (`mte:`, read with the state) wins over any copy of the state,
   * and a state read from PostgreSQL just before the end is not cached
   * (the guarded write refuses it) and not used.
   */
  async state(matchId: string, refresh = false): Promise<ChatState | null> {
    const { app } = this;
    if (!refresh) {
      const cached = await readOpenChatState(app.redis, app.keys, matchId).catch((error: unknown) => {
        throw unavailable(error);
      });
      if (cached.ended) return null;
      if (cached.state && cached.state.vis !== null) return cached.state;
    }
    budget(this.request, 1);
    const row = await chatEligibility(app.pg, matchId);
    if (!row) return null;
    const state: ChatState = { ...row, createdMs: idTime(row.id).getTime(), vis: row.vis };
    if (row.state === 1) {
      const kept = await cacheChatState(app.redis, app.keys, state).catch((error: unknown) => {
        this.log.warn({ err: error }, 'chat: state not cached');
        return 'cached' as const;
      });
      if (kept === 'ended') return null;
    }
    return state;
  }

  /** The conversation if the person is in it, it is active and they may see the other person; else 404. */
  private async member(userId: string, matchId: string): Promise<{ state: ChatState; side: 'lo' | 'hi'; peerId: string; seenByPeer: boolean }> {
    const state = await this.state(matchId);
    if (state?.state !== 1 || (state.lo !== userId && state.hi !== userId)) throw new HttpProblem('not_found');
    const side = state.lo === userId ? 'lo' : 'hi';
    const sides = sidesVisible(state, side);
    if (!sides.peer) throw new HttpProblem('not_found');
    return { state, side, peerId: side === 'lo' ? state.hi : state.lo, seenByPeer: sides.mine };
  }

  /** The caller's own account view (cached; one statement on a miss, which the budget is given only then). */
  private async ownView(userId: string): Promise<AccountView | null> {
    budget(this.request, 1);
    const loaded = await this.app.account.load(userId);
    if (loaded.cached) budget(this.request, -1);
    return loaded.result.kind === 'account' ? loaded.result.view : null;
  }

  // ─── Send ───────────────────────────────────────────────────────────────

  async send(session: AppSession, matchId: string, body: SendMessage): Promise<SentResult> {
    const { app } = this;
    const cfg = app.cfg.get();
    const userId = session.userId;
    if (body.kind === 'image' || body.kind === 'voice') {
      throw new HttpProblem('field_invalid', { detail: 'Photo and voice messages are not available yet.' });
    }
    // A retry of a message already made gets it back, whatever changed since (a confirm used up, a term added).
    const prior = await app.redis.get(this.c.sendOnce(userId, body.clientId)).catch((error: unknown) => {
      throw unavailable(error);
    });
    if (prior) return this.replay(session, matchId, body.clientId, JSON.parse(prior) as SendRecord);

    const kind = messageKind.code(body.kind);
    let flags = 0;
    let text: string | null = body.body ?? null;
    if (kind === KIND.text) {
      text = body.body ?? '';
      if (codePoints(text) > cfg.app['chat.max_body_chars'] || !isStorableText(text, cfg.app['chat.max_body_chars'])) {
        throw new HttpProblem('field_invalid', { detail: `At most ${cfg.app['chat.max_body_chars']} characters.` });
      }
      flags |= await this.screen(userId, body.clientId, text, body.confirm, cfg);
    } else if (kind === KIND.reaction) {
      text = body.body ?? '';
    } else if (kind === KIND.unsend) {
      text = null;
    }
    const member = await this.member(userId, matchId);
    if (kind === KIND.unsend) await this.checkOwnMessage(matchId, body.refId!, userId);

    const message: StoredMessage = { id: nextId(app), matchId, senderId: userId, refId: body.refId ?? null, kind, flags, body: text };
    // The script checks the send against the state just checked here when no copy is cached (one read while a
    // change's fence stands, or a copy that expired since): nothing is read again between the id and its append.
    const outcome = await this.append(member.state, message, body.clientId, member.seenByPeer);
    if (outcome.outcome === 'replay') return this.replay(session, matchId, body.clientId, outcome.record);
    if (outcome.outcome !== 'sent') throw new HttpProblem('not_found');

    await this.waitForReplica();
    const wire = messageOf({ publicIds: app.publicIds }, message, { clientId: body.clientId });
    await this.publishMessage(userId, member.peerId, member.seenByPeer, wire);
    if (member.seenByPeer && listEffectOf(kind) === 'news') await this.queuePush(member.state, member.peerId, message, userId);
    if (kind === KIND.unsend) await this.queueUnsendClear(matchId, body.refId!, userId, cfg);
    await noteSeen(app.cache, app.keys, userId).catch(() => undefined);
    return { message: wire, replayed: false };
  }

  private async append(state: ChatState, message: StoredMessage, clientId: string, deliver: boolean) {
    try {
      return await sendMessage(this.app.redis, this.app.keys, state.lo, state.hi, { message, clientId, deliver, checked: state });
    } catch (error) {
      throw unavailable(error);
    }
  }

  private async replay(session: AppSession, matchId: string, clientId: string, record: SendRecord): Promise<SentResult> {
    // A client id is one message for its whole life: reused for another conversation, it names nothing there.
    if (record.m !== undefined && record.m !== matchId) {
      throw new HttpProblem('conflict', { detail: 'This clientId belongs to a message of another conversation; use a new one.' });
    }
    const message: StoredMessage = {
      id: record.i,
      matchId,
      senderId: session.userId,
      refId: record.r ?? null,
      kind: record.k,
      flags: record.f,
      body: record.b ?? null,
    };
    return { message: messageOf({ publicIds: this.app.publicIds }, message, { clientId }), replayed: true };
  }

  /**
   * Banned terms (in memory): severity 3 refuses, 2 lets it through
   * flagged for review, 1 asks "are you sure?" once (a token bound to this
   * person and client id, kept 10 minutes); a link, an e-mail, a phone
   * number or money talk only flags it.
   */
  private async screen(userId: string, clientId: string, text: string, confirm: string | undefined, cfg: ConfigSnapshot): Promise<number> {
    const severity = cfg.bannedTerms.severity(text, 'messages');
    if (severity >= 3) throw new HttpProblem('message_refused');
    let flags = riskyPattern(text) || severity === 2 ? FLAG.risky : 0;
    if (severity === 1) {
      const key = this.app.keys.raw('cnf', userId, clientId);
      const issued = await this.app.redis.get(key).catch(() => null);
      if (confirm === undefined || issued === null || confirm !== issued) {
        const token = issued ?? randomToken(16);
        await this.app.redis.set(key, token, 'EX', CONFIRM_TTL_SECONDS).catch((error: unknown) => {
          throw unavailable(error);
        });
        throw new HttpProblem('confirm_required', { extensions: { confirmToken: token, category: 'banned_term' } });
      }
      flags |= FLAG.warned | FLAG.risky;
    }
    return flags;
  }

  /**
   * An unsend names a message of its sender. A message a few seconds old
   * may still be in the stream (looked up there first, around its time);
   * an older one is read by its primary key (one statement).
   */
  private async checkOwnMessage(matchId: string, targetId: string, userId: string): Promise<void> {
    const { app } = this;
    const at = idTime(targetId).getTime();
    let sender: string | null = null;
    try {
      const entries = (await app.redis.xrange(app.keys.stream('msg'), String(Math.max(0, at - STREAM_SEARCH_MS)), String(at + STREAM_SEARCH_MS), 'COUNT', STREAM_SEARCH_COUNT)) as [
        string,
        string[],
      ][];
      for (const [, flat] of entries) {
        const fields: Record<string, string> = {};
        for (let i = 0; i + 1 < flat.length; i += 2) fields[flat[i]!] = flat[i + 1]!;
        if (fields['id'] === targetId && fields['m'] === matchId) {
          sender = parseMessageEntry(fields).senderId;
          break;
        }
      }
    } catch (error) {
      this.log.warn({ err: error }, 'unsend: stream not searched');
    }
    if (sender === null) {
      budget(this.request, 1);
      sender = await messageSender(app.pg, matchId, targetId);
    }
    if (sender !== userId) throw new HttpProblem('not_found');
  }

  private async waitForReplica(): Promise<void> {
    const replicas = this.app.config.writeBehind.waitReplicas;
    if (replicas <= 0) return;
    try {
      const acked = await this.app.redis.wait(replicas, this.app.config.writeBehind.waitTimeoutMs);
      // Logged, not failed: the entry is on the primary (AOF every second).
      if (acked < replicas) this.log.warn({ acked, replicas }, 'chat: the stream entry is not on a replica yet');
    } catch (error) {
      this.log.warn({ err: error }, 'chat: WAIT failed');
    }
  }

  private async publishMessage(senderId: string, peerId: string, deliver: boolean, message: Message): Promise<void> {
    const { app } = this;
    if (!app.realtime) return;
    const channels = (deliver ? [senderId, peerId] : [senderId]).map((id) => userChannel(this.publicUid(id)));
    await app.realtime
      .broadcast(channels, realtimeEnvelope('message', message.id, idTime(message.id), message))
      .catch((error: unknown) => this.log.warn({ err: error }, 'chat: message not published; the history read brings it'));
  }

  /**
   * One push per conversation and recipient per 10 minutes, none while the
   * recipient looks at the conversation or muted it. The sender's first
   * name and a preview travel with the job; the push says them only to a
   * recipient who turned previews on.
   */
  private async queuePush(state: ChatState, recipientId: string, message: StoredMessage, senderId: string): Promise<void> {
    const { app } = this;
    const mutedBit = state.lo === recipientId ? 4 : 8;
    if ((state.flags & mutedBit) !== 0) return;
    try {
      if (!(await messagePushDue(app.redis, app.keys, message.matchId, recipientId))) return;
      const view = await this.ownView(senderId).catch(() => null);
      const first = view?.profile?.name.trim().split(/\s+/)[0];
      const preview = message.kind === KIND.text && message.body ? [...message.body].slice(0, 100).join('') : undefined;
      await app.jobs.add(
        'push',
        'send',
        jobId('send', 'message', message.id),
        {
          type: 'message',
          userId: recipientId,
          conversationId: message.matchId,
          messageId: message.id,
          ...(first ? { senderName: first } : {}),
          ...(preview ? { preview } : {}),
        },
        { attempts: 3, backoffMs: 5_000 },
      );
    } catch (error) {
      this.log.warn({ err: error }, 'chat: message push not queued');
    }
  }

  private async queueUnsendClear(matchId: string, targetId: string, senderId: string, cfg: ConfigSnapshot): Promise<void> {
    const hours = cfg.app['retention.unsent_body_hours'];
    await this.app.jobs
      .add('chat', 'unsend-clear', chatJobIds.unsendClear(matchId, targetId), { matchId, targetId, senderId }, {
        delayMs: hours * 3_600_000,
        attempts: 10,
        backoffMs: 60_000,
      })
      .catch((error: unknown) => this.log.error({ err: error, matchId }, 'unsend: body clear not queued'));
  }

  // ─── History ────────────────────────────────────────────────────────────

  /**
   * One page, with the cursor below which everything is durable. The
   * watermark is read before the page, so every id below it was in
   * PostgreSQL when the page was read.
   */
  async history(session: AppSession, matchId: string, q: MessagesQuery): Promise<{ page: MessagesPage; lagMs: number | null }> {
    const { app } = this;
    const userId = session.userId;
    const durable = await this.durableBelow();
    let page;
    try {
      page = await historyPage(app.pg, { matchId, viewerId: userId, before: q.before, after: q.after, limit: q.limit });
    } catch (error) {
      if (isTransientDatabaseError(error)) throw unavailable(error);
      throw error;
    }
    if (!page.found) throw new HttpProblem('not_found');
    if (page.state !== 1) throw new HttpProblem('conversation_ended');
    if (!page.visible) throw new HttpProblem('not_found');
    const side = page.lo === userId ? 'lo' : 'hi';
    const peerSide = side === 'lo' ? 'hi' : 'lo';

    const [pointers, delivered] = await Promise.all([
      app.redis.hgetall(this.c.readPointers(matchId)).catch((): Record<string, string> => ({})),
      app.redis.hgetall(this.c.delivered(matchId)).catch((): Record<string, string> => ({})),
    ]);
    const pg = { lo: page.loReadId, hi: page.hiReadId };
    const me = laterId(pg[side], pointers[side]);
    const peer = laterId(pg[peerSide], pointers[peerSide]);
    const plan = await sessionPlan({ cache: app.cache, keys: app.keys, db: app.pg, log: this.log }, this.request, app.cfg.get(), userId, session.storeCode);
    const readReceipts = planFeature(plan.plan, 'read_receipts');
    const peerDelivered = laterId(delivered[peerSide], null);

    // A body its sender took back comes without it from the query itself (on any page), until the clear job removes it.
    const items = page.items.map((m) => messageOf({ publicIds: app.publicIds }, m));
    const result: MessagesPage = {
      items,
      hasMore: page.hasMore,
      syncCursor: this.syncCursor(page.items, page.hasMore, q, durable.below),
      readCursors: { ...(me ? { me } : {}), ...(readReceipts && peer ? { peer } : {}) },
      ...(page.peerShowsOnline && peerDelivered ? { peerDeliveredId: peerDelivered } : {}),
    };
    return { page: result, lagMs: durable.lagMs };
  }

  /**
   * The position below which every message is durable: min(the newest id
   * of a full page, the watermark - 1); after a page that is not full,
   * the watermark - 1 itself. Never before the client's own `after`.
   */
  private syncCursor(rows: readonly StoredMessage[], hasMore: boolean, q: MessagesQuery, below: bigint): string {
    const newest = rows.length > 0 ? BigInt(rows.at(-1)!.id) : null;
    let cursor = below - 1n;
    if (newest !== null && (hasMore || q.after === undefined) && newest < cursor) cursor = newest;
    if (q.after !== undefined && BigInt(q.after) > cursor) cursor = BigInt(q.after);
    if (cursor < 1n) cursor = newest ?? 1n;
    return cursor.toString();
  }

  /**
   * The watermark (every id below it is durable) and the write-behind lag
   * it shows. Without one yet (no writer has run since Valkey was emptied)
   * it is the oldest entry still in the stream, or now. Either way it is
   * lowered to the smallest id a direct writer (a like note, a call line)
   * minted and has not made durable yet: the stream's watermark knows
   * nothing of those.
   */
  private async durableBelow(): Promise<{ below: bigint; lagMs: number | null }> {
    const { app } = this;
    const now = Date.now();
    const lowered = (below: bigint, held: bigint | null) => (held !== null && held < below ? held : below);
    try {
      const { watermark: wm, held } = await readMessageDurability(app.redis, app.keys, now);
      if (wm !== null) {
        const at = idTime(wm).getTime() + WATERMARK_MARGIN_MS;
        return { below: lowered(wm, held), lagMs: Math.max(0, now - at) };
      }
      const first = (await app.redis.xrange(app.keys.stream('msg'), '-', '+', 'COUNT', 1)) as [string, string[]][];
      const oldest = first[0] ? Number(first[0][0].split('-')[0]) : now;
      return { below: lowered(idFloor(Math.max(0, oldest - WATERMARK_MARGIN_MS)), held), lagMs: Math.max(0, now - oldest) };
    } catch (error) {
      this.log.warn({ err: error }, 'chat: watermark unreadable');
      return { below: idFloor(now - 10 * 60_000), lagMs: null };
    }
  }

  // ─── Receipts and typing ────────────────────────────────────────────────

  async receipts(session: AppSession, matchId: string, readUpTo: string | undefined, deliveredUpTo: string | undefined): Promise<void> {
    const { app } = this;
    const userId = session.userId;
    const member = await this.member(userId, matchId);
    try {
      const pointers = [...(readUpTo ? (['r'] as const) : []), ...(deliveredUpTo ? (['d'] as const) : [])];
      for (const pointer of pointers) {
        if (!(await receiptAllowed(app.redis, app.keys, userId, matchId, pointer))) {
          throw new HttpProblem('rate_limited', { retryAfterSeconds: 2, headers: { 'retry-after': '2' } });
        }
      }
    } catch (error) {
      if (error instanceof HttpProblem) throw error;
      throw unavailable(error);
    }
    const maxId = largestIdAt(Date.now() + WATERMARK_MARGIN_MS);
    let moved;
    try {
      moved = await moveReceipts(app.redis, app.keys, { matchId, readerId: userId, side: member.side, readUpTo, deliveredUpTo, maxId });
    } catch (error) {
      throw unavailable(error);
    }
    await noteSeen(app.cache, app.keys, userId).catch(() => undefined);
    if (!moved.readMoved && !moved.deliveredMoved) return;
    // Read: the message-push window reopens, so the next message after the person looks away is pushed.
    if (moved.readMoved) await app.redis.del(this.c.messagePush(matchId, userId)).catch(() => undefined);
    // The reader's own devices hear every move.
    if (moved.readMoved) await bumpVersion(app.redis, app.keys.conversationVersion(userId)).catch(() => undefined);
    await this.publishReceipt(userId, matchId, { readUpTo: moved.readMoved, deliveredUpTo: moved.deliveredMoved });
    if (!member.seenByPeer || !app.realtime) return;
    // The other person: a read only when their plan has read receipts, a delivery only while the reader shows online.
    const toPeer: { readUpTo: string | null; deliveredUpTo: string | null } = { readUpTo: null, deliveredUpTo: null };
    if (moved.readMoved && (await this.hasReadReceipts(member.peerId))) toPeer.readUpTo = moved.readMoved;
    if (moved.deliveredMoved) {
      const view = await this.ownView(userId);
      if (view?.profile?.showOnline === true) toPeer.deliveredUpTo = moved.deliveredMoved;
    }
    if (toPeer.readUpTo || toPeer.deliveredUpTo) {
      // Their list shows the pointer too: its version moves, so no 304 is served over it.
      await bumpVersion(app.redis, app.keys.conversationVersion(member.peerId)).catch(() => undefined);
      await this.publishReceipt(member.peerId, matchId, toPeer, userId);
    }
  }

  private async publishReceipt(channelOf: string, matchId: string, p: { readUpTo: string | null; deliveredUpTo: string | null }, by: string = channelOf): Promise<void> {
    const { app } = this;
    if (!app.realtime) return;
    const envelope = realtimeEnvelope('receipt', nextId(app), Date.now(), {
      conversationId: matchId,
      by: this.publicUid(by),
      ...(p.readUpTo ? { readUpTo: p.readUpTo } : {}),
      ...(p.deliveredUpTo ? { deliveredUpTo: p.deliveredUpTo } : {}),
    });
    await app.realtime.publish(userChannel(this.publicUid(channelOf)), envelope).catch((error: unknown) => this.log.warn({ err: error }, 'receipt: not published'));
  }

  /**
   * Whether a person's plan has read receipts, from their cached plans
   * (`ent:<uid>:<store>`, kept by their own requests). Not cached: no (their
   * next conversation read carries the pointer, under their own plan).
   */
  private async hasReadReceipts(userId: string): Promise<boolean> {
    const { app } = this;
    const cfg = app.cfg.get();
    try {
      const values = await app.cache.mget(app.keys.entitlements(userId, 0), app.keys.entitlements(userId, 1), app.keys.entitlements(userId, 2));
      return values.some((raw) => {
        if (!raw) return false;
        try {
          const parsed = JSON.parse(raw) as { v?: unknown; plans?: unknown };
          if (parsed.v !== 1 || !Array.isArray(parsed.plans)) return false;
          return planFeature(bestPlan(cfg, parsed.plans.filter((p): p is number => typeof p === 'number')), 'read_receipts');
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  }

  async typing(session: AppSession, matchId: string): Promise<void> {
    const { app } = this;
    const userId = session.userId;
    let allowed: boolean;
    try {
      allowed = await typingAllowed(app.redis, app.keys, userId);
    } catch (error) {
      throw unavailable(error);
    }
    if (!allowed) throw new HttpProblem('rate_limited', { retryAfterSeconds: 3, headers: { 'retry-after': '3' } });
    const member = await this.member(userId, matchId);
    if (!member.seenByPeer || !app.realtime) return;
    const envelope = realtimeEnvelope('typing', nextId(app), Date.now(), { conversationId: matchId, by: this.publicUid(userId) });
    await app.realtime.publish(userChannel(this.publicUid(member.peerId)), envelope).catch((error: unknown) => this.log.warn({ err: error }, 'typing: not published'));
  }

  // ─── Settings ───────────────────────────────────────────────────────────

  /**
   * The person's call consent and mute of one conversation (one
   * statement). The conversation's cached state takes the new flags behind a
   * fence (a state read before the change is not cached over it). Their
   * other devices hear `conversation` (updated); the other person hears it
   * only when the call consent changed (the mute is the person's own
   * business) and only while they may see the person (a shadowban, as on
   * every other path).
   */
  async update(session: AppSession, matchId: string, patch: { allowCalls?: boolean | undefined; muted?: boolean | undefined }): Promise<Conversation> {
    const { app } = this;
    const userId = session.userId;
    const row = await setConversationFlags(app.pg, { matchId, userId, allowCalls: patch.allowCalls, muted: patch.muted });
    if (!row) throw new HttpProblem('not_found');
    const card = parseCardSource(row.peerCard);
    if (!card) throw new HttpProblem('not_found');
    const peerId = row.lo === userId ? row.hi : row.lo;
    const state = { id: row.id, lo: row.lo, hi: row.hi, state: row.state, flags: row.flags, source: row.source, createdMs: idTime(row.id).getTime() };
    const callBit = row.lo === userId ? 1 : 2;
    const callsChanged = (row.before & callBit) !== (row.flags & callBit);
    const tellPeer = callsChanged && row.seenByPeer;
    try {
      // Call placement and the push read the flags from this copy; the visibility kept in it stays.
      await writeChangedMatchState(app.redis, app.keys, state, row.before);
      await bumpVersion(app.redis, app.keys.conversationVersion(userId));
      if (tellPeer) await bumpVersion(app.redis, app.keys.conversationVersion(peerId));
    } catch (error) {
      this.log.warn({ err: error }, 'conversation settings: Valkey not updated');
    }
    const lists = new ConversationService(app, this.request);
    const peer = { summary: peerSummaryOf({ publicIds: app.publicIds, media: app.media }, peerId, card), showOnline: card.so === true };
    await lists.storePeer(peerId, card);
    const tails = await lists.tails(userId, [matchId]);
    const extras = await lists.extras(userId, [peerId], new Map([[peerId, peer]]));
    const mine = lists.render(state, userId, peer, tails.get(matchId), extras(peerId));
    if (app.realtime) {
      await app.realtime
        .publish(userChannel(this.publicUid(userId)), realtimeEnvelope('conversation', nextId(app), Date.now(), { conversation: mine, reason: 'updated' }))
        .catch((error: unknown) => this.log.warn({ err: error }, 'conversation settings: not published'));
      if (tellPeer) await this.publishToPeer(lists, state, peerId, userId);
    }
    return mine;
  }

  /** The other person's own view of the conversation (`conversation`, updated). */
  private async publishToPeer(lists: ConversationService, state: Parameters<ConversationService['render']>[0], peerId: string, userId: string): Promise<void> {
    const { app } = this;
    try {
      const me = (await lists.peerSummaries([userId])).get(userId);
      if (!me) return;
      const tails = await lists.tails(peerId, [state.id]);
      const theirs = lists.render(state, peerId, me, tails.get(state.id), { readReceipts: await this.hasReadReceipts(peerId), online: false, activeRecently: false });
      await app.realtime!.publish(userChannel(this.publicUid(peerId)), realtimeEnvelope('conversation', nextId(app), Date.now(), { conversation: theirs, reason: 'updated' }));
    } catch (error) {
      this.log.warn({ err: error }, 'conversation settings: the other person was not told');
    }
  }
}
