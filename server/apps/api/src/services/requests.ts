import { acceptMessageRequest, declineMessageRequest, requestBox, sendMessageRequest, withdrawMessageRequest } from '@app/db';
import {
  decodeCursor,
  encodeCursor,
  idTime,
  requestStatus,
  userChannel,
  realtimeEnvelope,
  wireTime,
  type Conversation,
  type MessageRequestCreate,
  type MessageRequestsPage,
  type SentRequest,
} from '@app/shared';
import {
  announceMatch,
  chatKeys,
  holdDirectWrites,
  isoWeek,
  jobId,
  KIND,
  largestIdAt,
  messageOf,
  moveReceipts,
  noteMessage,
  parseCardSource,
  peerSummaryOf,
  releaseDirectWrites,
  SEND_RECORD_TTL_SECONDS,
  useCounter,
  utcDay,
} from '@app/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { nextId } from '../auth/sessions.js';
import { HttpProblem } from '../lib/problem.js';
import type { ActiveAccount } from './active.js';
import { ConversationService, type ListedPeer } from './conversations.js';
import { planLimit, sessionPlan } from './plans.js';

/**
 * Message requests (`/v1/message-requests`): a first message to someone not
 * matched yet.
 *
 * Sending: the day's free requests (plan `daily_dm`, -1 unlimited), then
 * the week's gift (`weekly_dm_gift`), then the wallet's direct messages,
 * in Valkey counters; never more than 20 a day whatever is paid. One
 * statement (`message_request_send()`) checks and writes, the wallet's use
 * included; a refusal gives the counted quota back. A request sent again
 * with the same client id within 15 minutes gets the same answer. The
 * recipient hears `request` and gets a push, unless they may not see the
 * sender (it then waits unseen, as in the inbox).
 *
 * A decline is never revealed: the sender's box shows it as pending, then
 * as expired; a new request to the same person is answered as for a
 * pending one until `requests.resend_after_days` passed.
 *
 * Accepting makes the conversation (one statement: the match under the
 * pair's lock, the request, its body as the first message), announces it
 * like a match, and sends both people their own view of it.
 */

export const REQUESTS_DAILY_CAP = 20;
const DAY_MS = 86_400_000;

const cursorSchema = z.object({ i: z.string().regex(/^[1-9][0-9]{0,18}$/) });

function nextUtcMidnight(now: number): number {
  return (Math.floor(now / DAY_MS) + 1) * DAY_MS;
}

export class RequestService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly request: FastifyRequest,
  ) {}

  private get log() {
    return this.request.log;
  }

  private render() {
    return { publicIds: this.app.publicIds, media: this.app.media };
  }

  async send(account: ActiveAccount, body: MessageRequestCreate): Promise<{ request: SentRequest; replayed: boolean }> {
    const { app } = this;
    const cfg = app.cfg.get();
    const userId = account.session.userId;
    const targetId = app.publicIds.user.decodeId(body.to);
    if (targetId === null || targetId === userId) throw new HttpProblem('not_found');
    const onceKey = chatKeys(app.keys).requestOnce(userId, body.clientId);
    const prior = await app.redis.get(onceKey);
    if (prior) {
      const request = JSON.parse(prior) as SentRequest;
      // A client id is one request for its whole life: reused for someone else, it is refused.
      if (request.to.id !== body.to) throw new HttpProblem('conflict', { detail: 'This clientId belongs to a request to someone else; use a new one.' });
      return { request, replayed: true };
    }
    if (body.body.length > cfg.app['chat.max_body_chars'] && [...body.body].length > cfg.app['chat.max_body_chars']) {
      throw new HttpProblem('field_invalid', { detail: `At most ${cfg.app['chat.max_body_chars']} characters.` });
    }
    if (cfg.bannedTerms.severity(body.body, 'messages') >= 3) throw new HttpProblem('message_refused');

    const now = Date.now();
    const day = utcDay(now);
    const keys = {
      cap: app.keys.quota('dmcap', userId, day),
      daily: app.keys.quota('dm', userId, day),
      gift: app.keys.quota('dmg', userId, isoWeek(now)),
    };
    // The hard cap counts every request that goes through, paid or not.
    const cap = await useCounter(app.redis, keys.cap, REQUESTS_DAILY_CAP, 2 * 86_400);
    if (!cap.allowed) {
      const retry = Math.ceil((nextUtcMidnight(now) - now) / 1_000);
      throw new HttpProblem('rate_limited', { retryAfterSeconds: retry, headers: { 'retry-after': String(retry) } });
    }
    const counted: string[] = [keys.cap];
    let pay = false;
    if (!account.test) {
      const plan = await sessionPlan({ cache: app.cache, keys: app.keys, db: app.pg, log: this.log }, this.request, cfg, userId, account.session.storeCode);
      const daily = await useCounter(app.redis, keys.daily, planLimit(plan.plan, 'daily_dm'), 2 * 86_400);
      if (daily.allowed) counted.push(keys.daily);
      else {
        const gift = await useCounter(app.redis, keys.gift, planLimit(plan.plan, 'weekly_dm_gift'), 8 * 86_400);
        if (gift.allowed) counted.push(keys.gift);
        else pay = true;
      }
    }
    const giveBack = async () => {
      await Promise.all(counted.map((key) => useCounter(app.redis, key, -1, 1, -1).catch(() => undefined)));
    };

    const requestId = nextId(app);
    const ledgerId = nextId(app);
    let outcome;
    try {
      outcome = await sendMessageRequest(app.pg, {
        requestId,
        fromId: userId,
        toId: targetId,
        body: body.body,
        resendAfterDays: cfg.app['requests.resend_after_days'],
        pay,
        ledgerId,
        store: account.session.storeCode ?? 0,
        crossStore: cfg.app['billing.cross_store_entitlements'],
      });
    } catch (error) {
      await giveBack();
      throw error;
    }
    if (outcome.outcome !== 'sent') {
      await giveBack();
      if (outcome.outcome === 'already_matched') throw new HttpProblem('already_matched');
      if (outcome.outcome === 'already_requested') throw new HttpProblem('already_requested');
      if (outcome.outcome === 'no_balance') {
        throw new HttpProblem('quota_exceeded', { extensions: { feature: 'dm', resetsAt: wireTime(nextUtcMidnight(now)), canBuy: true } });
      }
      throw new HttpProblem('not_found');
    }
    const toCard = parseCardSource(outcome.toCard);
    if (!toCard) throw new HttpProblem('not_found');
    const sent: SentRequest = {
      id: requestId,
      to: peerSummaryOf(this.render(), targetId, toCard),
      body: body.body,
      status: 'pending',
      at: wireTime(idTime(requestId)),
    };
    await app.redis.set(onceKey, JSON.stringify(sent), 'EX', SEND_RECORD_TTL_SECONDS).catch((error: unknown) => this.log.warn({ err: error }, 'request: record not kept'));
    if (outcome.told) await this.tell(userId, targetId, sent);
    return { request: sent, replayed: false };
  }

  /** The recipient hears `request` and gets a push. */
  private async tell(userId: string, targetId: string, sent: SentRequest): Promise<void> {
    const { app } = this;
    try {
      const me = (await new ConversationService(app, this.request).peerSummaries([userId])).get(userId);
      if (me && app.realtime) {
        await app.realtime.publish(
          userChannel(app.publicIds.user.encode(targetId)),
          realtimeEnvelope('request', sent.id, Date.now(), { request: { id: sent.id, from: me.summary, body: sent.body, at: sent.at } }),
        );
      }
    } catch (error) {
      this.log.warn({ err: error }, 'request: not published');
    }
    await app.jobs
      .add('push', 'send', jobId('send', 'request', sent.id), { type: 'request', userId: targetId, requestId: sent.id }, { attempts: 3, backoffMs: 5_000 })
      .catch((error: unknown) => this.log.warn({ err: error }, 'request: push not queued'));
  }

  async box(userId: string, box: 'inbox' | 'sent', limit: number, cursor: string | undefined): Promise<MessageRequestsPage> {
    const { app } = this;
    let before: string | null = null;
    if (cursor !== undefined) {
      const decoded = decodeCursor(cursorSchema, cursor);
      if (!decoded) throw new HttpProblem('bad_request', { detail: 'The cursor is not valid.' });
      before = decoded.i;
    }
    const rows = await requestBox(app.pg, userId, box, limit, before);
    const page = rows.slice(0, limit);
    const items: MessageRequestsPage['items'] = [];
    for (const row of page) {
      const card = parseCardSource(row.peerCard);
      if (!card) continue;
      items.push({
        id: row.id,
        peer: peerSummaryOf(this.render(), row.peerId, card),
        body: row.body,
        status: requestStatus.name(row.status),
        at: wireTime(idTime(row.id)),
      });
    }
    const last = page.at(-1);
    return { items, nextCursor: rows.length > limit && last ? encodeCursor({ i: last.id }) : null };
  }

  async accept(account: ActiveAccount, requestId: string): Promise<Conversation> {
    const { app } = this;
    const userId = account.session.userId;
    const matchId = nextId(app);
    const messageId = nextId(app);
    // The first message is written directly, not through the stream: no sync cursor passes it before it is durable.
    await holdDirectWrites(app.redis, app.keys, [messageId]).catch((error: unknown) => this.log.warn({ err: error }, 'request accept: first message not held'));
    let outcome;
    try {
      outcome = await acceptMessageRequest(app.pg, requestId, userId, matchId, messageId);
    } finally {
      await releaseDirectWrites(app.redis, app.keys, [messageId]).catch((error: unknown) => this.log.warn({ err: error }, 'request accept: hold not released (it runs out)'));
    }
    if (outcome.outcome !== 'accepted') throw new HttpProblem('not_found');
    const m = outcome.match;
    const state = { id: m.id, lo: m.lo, hi: m.hi, state: m.state, flags: m.flags, source: m.source, createdMs: idTime(m.id).getTime() };
    const fromId = outcome.fromId;
    const first = { id: outcome.messageId, matchId: m.id, senderId: fromId, refId: null, kind: KIND.text, flags: 0, body: outcome.body };
    let announced = true;
    try {
      announced = await announceMatch(app.redis, app.keys, state);
      if (announced) {
        await noteMessage(app.redis, app.keys, { message: first, lo: m.lo, hi: m.hi, unreadFor: null });
        // The person who accepted has read it.
        await moveReceipts(app.redis, app.keys, {
          matchId: m.id,
          readerId: userId,
          side: m.lo === userId ? 'lo' : 'hi',
          readUpTo: first.id,
          maxId: largestIdAt(Date.now() + 5_000),
        });
      }
    } catch (error) {
      this.log.warn({ err: error }, 'request accept: lists not updated; they correct themselves on the next read');
    }
    if (!announced) throw new HttpProblem('not_found');

    const cards = { [m.lo]: parseCardSource(outcome.loCard), [m.hi]: parseCardSource(outcome.hiCard) };
    const lists = new ConversationService(app, this.request);
    const viewOf = async (viewer: string): Promise<Conversation | null> => {
      const peerId = viewer === m.lo ? m.hi : m.lo;
      const card = cards[peerId];
      if (!card) return null;
      await lists.storePeer(peerId, card);
      const peer: ListedPeer = { summary: peerSummaryOf(this.render(), peerId, card), showOnline: card.so === true };
      const tails = await lists.tails(viewer, [m.id]);
      return lists.render(state, viewer, peer, tails.get(m.id), { readReceipts: false, online: false, activeRecently: false });
    };
    const mine = await viewOf(userId);
    if (!mine) throw new HttpProblem('not_found');
    const theirs = await viewOf(fromId);
    if (app.realtime) {
      const message = messageOf({ publicIds: app.publicIds }, first);
      try {
        await app.realtime.publish(userChannel(app.publicIds.user.encode(userId)), realtimeEnvelope('conversation', m.id, Date.now(), { conversation: mine, reason: 'accepted' }));
        if (theirs) {
          await app.realtime.publish(userChannel(app.publicIds.user.encode(fromId)), realtimeEnvelope('conversation', m.id, Date.now(), { conversation: theirs, reason: 'accepted' }));
        }
        await app.realtime.broadcast(
          [userId, fromId].map((uid) => userChannel(app.publicIds.user.encode(uid))),
          realtimeEnvelope('message', first.id, idTime(first.id), message),
        );
      } catch (error) {
        this.log.warn({ err: error }, 'request accept: not published');
      }
    }
    // The requester hears of the new conversation like of a match.
    const name = cards[userId]?.name.trim().split(/\s+/)[0];
    await app.jobs
      .add('push', 'send', jobId('send', 'match', m.id, fromId), { type: 'match', userId: fromId, conversationId: m.id, ...(name ? { peerName: name } : {}) }, { attempts: 3, backoffMs: 5_000 })
      .catch((error: unknown) => this.log.warn({ err: error }, 'request accept: push not queued'));
    return mine;
  }

  async decline(userId: string, requestId: string): Promise<void> {
    await declineMessageRequest(this.app.pg, requestId, userId);
  }

  async withdraw(userId: string, requestId: string): Promise<void> {
    await withdrawMessageRequest(this.app.pg, requestId, userId);
  }
}
