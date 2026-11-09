import type { Redis } from 'ioredis';
import type { KeyBuilder } from '../kv/keys.js';
import { luaScript, runScript } from '../kv/scripts.js';
import { dropMatchState, MATCH_STATE_TTL_SECONDS, readMatchStateOrEnd, writeMatchState, type MatchState, type MatchStateWrite } from '../social/matches.js';
import { composeId, ID_MAX_GENERATOR, ID_MAX_SEQUENCE, idTime } from '../../ids.js';
import {
  chatKeys,
  DELIVERED_TTL_SECONDS,
  LAST_MESSAGE_TTL_SECONDS,
  MESSAGE_PUSH_COLLAPSE_SECONDS,
  READ_POINTERS_TTL_SECONDS,
  SEND_RECORD_TTL_SECONDS,
  TYPING_INTERVAL_MS,
  UNREAD_TTL_SECONDS,
  VIEWING_TTL_SECONDS,
} from './keys.js';
import { listEffectOf, previewOf, type StoredMessage } from './messages.js';

/**
 * The chat state in Valkey that the zero-statement paths read and write:
 * the send itself (one script: eligibility, idempotency, the stream append
 * and the list state), receipts, the list state of messages written
 * elsewhere, and the conversation's eligibility with each side's
 * visibility.
 */

const sendScript = luaScript(new URL('./send.lua', import.meta.url), 'chat-send', 11);
const noteScript = luaScript(new URL('./note.lua', import.meta.url), 'chat-note', 8);
const receiptScript = luaScript(new URL('./receipt.lua', import.meta.url), 'chat-receipt', 6);
const seedTailScript = luaScript(new URL('./seedTail.lua', import.meta.url), 'chat-seed-tail', 2);

function check(replies: [Error | null, unknown][] | null): void {
  const failed = replies?.find(([error]) => error !== null)?.[0];
  if (failed) throw failed;
}

// ─── Eligibility ──────────────────────────────────────────────────────────

/**
 * `mt:<m>` with `vis`: bit 1 = lo may be seen by hi, bit 2 = hi may be seen
 * by lo (the visibility rule, context 2). Absent until a chat path read it;
 * dropped when either person's visibility changes.
 */
export interface ChatState extends MatchState {
  /** Null when not known yet. */
  vis: number | null;
}

export const VIS_LO = 1;
export const VIS_HI = 2;

export async function readChatState(core: Redis, keys: KeyBuilder, matchId: string): Promise<ChatState | null> {
  return chatStateOf(matchId, await core.hgetall(keys.matchState(matchId)));
}

/**
 * The cached state with the conversation's end in the same round trip: an
 * ended conversation (its tombstone `mte:`) is `ended` whatever copy of its
 * state is still around.
 */
export async function readOpenChatState(core: Redis, keys: KeyBuilder, matchId: string): Promise<{ ended: boolean; state: ChatState | null }> {
  const { ended, hash } = await readMatchStateOrEnd(core, keys, matchId);
  return { ended, state: ended ? null : chatStateOf(matchId, hash) };
}

function chatStateOf(matchId: string, h: Record<string, string>): ChatState | null {
  if (!h['lo'] || !h['hi']) return null;
  const vis = h['vis'] === undefined ? null : Number(h['vis']);
  return {
    id: matchId,
    lo: h['lo'],
    hi: h['hi'],
    state: Number(h['st']),
    flags: Number(h['fl']),
    source: Number(h['src']),
    createdMs: Number(h['at']),
    vis: vis !== null && Number.isInteger(vis) && vis >= 0 && vis <= 3 ? vis : null,
  };
}

/**
 * Caches a match's state with its visibility (one hour, as every `mt:`
 * copy), unless the conversation ended since it was read (`ended`) or its
 * copy was just dropped for a change (`fenced`).
 */
export function cacheChatState(core: Redis, keys: KeyBuilder, s: ChatState): Promise<MatchStateWrite> {
  return writeMatchState(core, keys, s, { ttlSeconds: MATCH_STATE_TTL_SECONDS, vis: s.vis });
}

/**
 * A person's visibility changed (a ban, a suspension, a shadowban, a lift):
 * the visibility kept with each of their conversations is dropped, so the
 * next chat request reads it again. The conversations are the person's
 * list (`cl:<uid>`).
 */
export async function dropConversationVisibility(core: Redis, keys: KeyBuilder, userId: string): Promise<number> {
  const matchIds = (await core.zrange(keys.conversationList(userId), '0', '-1')).filter((id) => id !== '0');
  if (matchIds.length === 0) return 0;
  const pipeline = core.pipeline();
  // A state read before the change (with the old visibility) is not cached again for a moment.
  for (const id of matchIds) dropMatchState(pipeline, keys, id, 'vis');
  check(await pipeline.exec());
  return matchIds.length;
}

/** Whether each person may be seen by the other (true while unknown). */
export function sidesVisible(s: Pick<ChatState, 'vis'>, side: 'lo' | 'hi'): { mine: boolean; peer: boolean } {
  if (s.vis === null) return { mine: true, peer: true };
  const lo = (s.vis & VIS_LO) !== 0;
  const hi = (s.vis & VIS_HI) !== 0;
  return side === 'lo' ? { mine: lo, peer: hi } : { mine: hi, peer: lo };
}

// ─── Send ─────────────────────────────────────────────────────────────────

/**
 * What a retry with the same client id gets back: the message as it was
 * made, and its conversation (`m`): a client id names one message for its
 * whole life, so a retry to another conversation is refused, never answered
 * with this message.
 */
export interface SendRecord {
  i: string;
  m?: string | undefined;
  k: number;
  r?: string | undefined;
  f: number;
  b?: string | undefined;
}

export type SendOutcome =
  | { outcome: 'sent'; streamId: string; side: 'lo' | 'hi' }
  | { outcome: 'replay'; record: SendRecord }
  | { outcome: 'ended' | 'nostate' | 'notmember' };

export interface SendInput {
  message: StoredMessage;
  clientId: string;
  /** False when the other person may not see the sender: the message reaches the sender's side only. */
  deliver: boolean;
  now?: number | undefined;
}

export async function sendMessage(core: Redis, keys: KeyBuilder, lo: string, hi: string, input: SendInput): Promise<SendOutcome> {
  const c = chatKeys(keys);
  const m = input.message;
  const record: SendRecord = { i: m.id, m: m.matchId, k: m.kind, f: m.flags, ...(m.refId ? { r: m.refId } : {}), ...(m.body !== null ? { b: m.body } : {}) };
  const ms = idTime(m.id).getTime();
  const reply = await runScript(
    core,
    sendScript,
    [
      keys.matchEnded(m.matchId),
      keys.matchState(m.matchId),
      c.sendOnce(m.senderId, input.clientId),
      keys.stream('msg'),
      c.lastMessage(m.matchId),
      keys.conversationList(lo),
      keys.conversationList(hi),
      c.unread(lo),
      c.unread(hi),
      keys.conversationVersion(lo),
      keys.conversationVersion(hi),
    ],
    [
      m.id,
      m.matchId,
      m.senderId,
      m.kind,
      m.refId ?? '',
      m.flags,
      m.body ?? '',
      m.body !== null ? '1' : '0',
      ms,
      previewOf(m),
      listEffectOf(m.kind),
      input.deliver ? '1' : '0',
      JSON.stringify(record),
      SEND_RECORD_TTL_SECONDS,
      LAST_MESSAGE_TTL_SECONDS,
      UNREAD_TTL_SECONDS,
      input.now ?? Date.now(),
    ],
  );
  if (!Array.isArray(reply) || typeof reply[0] !== 'string') throw new TypeError('the send script returned an unexpected reply');
  const status = reply[0];
  if (status === 'sent') return { outcome: 'sent', streamId: String(reply[1]), side: reply[2] === 'hi' ? 'hi' : 'lo' };
  if (status === 'replay') return { outcome: 'replay', record: JSON.parse(String(reply[1])) as SendRecord };
  if (status === 'ended' || status === 'nostate' || status === 'notmember') return { outcome: status };
  throw new TypeError(`the send script answered ${status}`);
}

// ─── Messages written elsewhere ───────────────────────────────────────────

export interface NoteInput {
  message: StoredMessage;
  lo: string;
  hi: string;
  /** Whose unread count grows (the other person's, unless they already read it). */
  unreadFor: 'lo' | 'hi' | null;
  now?: number | undefined;
}

/**
 * The list state of a message that is durable and was not sent through the
 * send script (a call line, a like note, an accepted request's first
 * message): its preview when it is the newest, both lists' order, an unread
 * count, both versions. Nothing once the conversation ended. True when it
 * became the preview.
 */
export async function noteMessage(core: Redis, keys: KeyBuilder, input: NoteInput): Promise<boolean> {
  const c = chatKeys(keys);
  const m = input.message;
  const ms = idTime(m.id).getTime();
  const reply = await runScript(
    core,
    noteScript,
    [
      keys.matchEnded(m.matchId),
      c.lastMessage(m.matchId),
      keys.conversationList(input.lo),
      keys.conversationList(input.hi),
      c.unread(input.lo),
      c.unread(input.hi),
      keys.conversationVersion(input.lo),
      keys.conversationVersion(input.hi),
    ],
    [m.id, m.matchId, m.senderId, m.kind, m.refId ?? '', m.flags, previewOf(m), ms, input.unreadFor ?? '', LAST_MESSAGE_TTL_SECONDS, UNREAD_TTL_SECONDS, input.now ?? Date.now()],
  );
  return Number(reply) === 1;
}

// ─── Receipts ─────────────────────────────────────────────────────────────

export interface ReceiptInput {
  matchId: string;
  readerId: string;
  side: 'lo' | 'hi';
  readUpTo?: string | undefined;
  deliveredUpTo?: string | undefined;
  /** The largest id a pointer may name (an id minted now). */
  maxId: string;
}

export interface ReceiptOutcome {
  /** The new read pointer when it moved. */
  readMoved: string | null;
  /** The new delivered pointer when the request moved it. */
  deliveredMoved: string | null;
  read: string | null;
  delivered: string | null;
}

export async function moveReceipts(core: Redis, keys: KeyBuilder, r: ReceiptInput): Promise<ReceiptOutcome> {
  const c = chatKeys(keys);
  const reply = await runScript(
    core,
    receiptScript,
    [c.readPointers(r.matchId), c.readDirty(), c.delivered(r.matchId), c.unread(r.readerId), c.lastMessage(r.matchId), c.viewing(r.readerId)],
    [r.side, r.readUpTo ?? '', r.deliveredUpTo ?? '', r.matchId, READ_POINTERS_TTL_SECONDS, DELIVERED_TTL_SECONDS, r.maxId, VIEWING_TTL_SECONDS, UNREAD_TTL_SECONDS],
  );
  if (!Array.isArray(reply) || reply.length !== 4) throw new TypeError('the receipt script returned an unexpected reply');
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  return { readMoved: text(reply[0]), deliveredMoved: text(reply[1]), read: text(reply[2]), delivered: text(reply[3]) };
}

const readFlushTakeScript = luaScript(new URL('./readFlushTake.lua', import.meta.url), 'chat-read-flush-take', 2);

/**
 * The next chunk of conversations whose read pointers wait for the flush:
 * those a run that died left in `rp:flushing` first, else up to `count`
 * moved there from `rp:dirty`. They stay in `rp:flushing` until
 * {@link readFlushDone}.
 */
export async function takeReadFlushChunk(core: Redis, keys: KeyBuilder, count: number): Promise<{ left: boolean; ids: string[] }> {
  const c = chatKeys(keys);
  const reply = (await runScript(core, readFlushTakeScript, [c.readDirty(), c.readFlushing()], [count])) as unknown[];
  const [source, ...ids] = reply.map(String);
  return { left: source === 'left', ids };
}

/** The chunk's pointers are written. */
export async function readFlushDone(core: Redis, keys: KeyBuilder, ids: readonly string[]): Promise<void> {
  const key = chatKeys(keys).readFlushing();
  for (let i = 0; i < ids.length; i += 500) await core.srem(key, ...ids.slice(i, i + 500));
}

// ─── Gates ────────────────────────────────────────────────────────────────

/** One typing signal per person per 3 s: true when this one may go out. */
export async function typingAllowed(core: Redis, keys: KeyBuilder, userId: string): Promise<boolean> {
  return (await core.set(chatKeys(keys).typing(userId), '1', 'PX', TYPING_INTERVAL_MS, 'NX')) === 'OK';
}

/** One receipt per pointer, person and conversation per 2 s: true when this one may go through. */
export async function receiptAllowed(core: Redis, keys: KeyBuilder, userId: string, matchId: string, pointer: 'r' | 'd', windowMs = 2_000): Promise<boolean> {
  return (await core.set(chatKeys(keys).receiptLimit(userId, matchId, pointer), '1', 'PX', windowMs, 'NX')) === 'OK';
}

/**
 * Whether a message push to `recipientId` is due: not while they look at
 * the conversation (`view:<uid>`), and one per conversation and recipient
 * per 10 minutes (`push:m:`). Taking it marks the window.
 */
export async function messagePushDue(core: Redis, keys: KeyBuilder, matchId: string, recipientId: string): Promise<boolean> {
  const c = chatKeys(keys);
  if ((await core.get(c.viewing(recipientId))) === matchId) return false;
  return (await core.set(c.messagePush(matchId, recipientId), '1', 'EX', MESSAGE_PUSH_COLLAPSE_SECONDS, 'NX')) === 'OK';
}

// ─── Reading the list state ───────────────────────────────────────────────

/** `lm:<m>` as stored; `id` "0" is "no message yet". */
export interface LastMessageState {
  id: string;
  senderId: string;
  kind: number;
  refId: string | null;
  flags: number;
  preview: string;
}

export interface ConversationTailState {
  /** Null when not cached (read it from PostgreSQL); `id` "0" when there is no message. */
  last: LastMessageState | null;
  unread: number;
  /** Whether Valkey held a count (absent: none unread, or the count was lost with the list). */
  unreadKept?: boolean | undefined;
  /** Each side's read pointer (null: nothing in Valkey). */
  read: { lo: string | null; hi: string | null };
  delivered: { lo: string | null; hi: string | null };
}

const ID = /^(0|[1-9][0-9]{0,18})$/;

function lastOf(h: Record<string, string>): LastMessageState | null {
  const id = h['id'];
  if (id === undefined || !ID.test(id)) return null;
  return {
    id,
    senderId: h['s'] ?? '',
    kind: Number(h['k'] ?? 0),
    refId: h['r'] ? h['r'] : null,
    flags: Number(h['f'] ?? 0),
    preview: h['p'] ?? '',
  };
}

function pointer(value: string | undefined): string | null {
  return value !== undefined && ID.test(value) && value !== '0' ? value : null;
}

/** The list state of a viewer's conversations, in one round trip. */
export async function readConversationTails(core: Redis, keys: KeyBuilder, viewerId: string, matchIds: readonly string[]): Promise<Map<string, ConversationTailState>> {
  const out = new Map<string, ConversationTailState>();
  if (matchIds.length === 0) return out;
  const c = chatKeys(keys);
  const pipeline = core.pipeline();
  for (const id of matchIds) pipeline.hgetall(c.lastMessage(id));
  for (const id of matchIds) pipeline.hgetall(c.readPointers(id));
  for (const id of matchIds) pipeline.hgetall(c.delivered(id));
  pipeline.hmget(c.unread(viewerId), ...matchIds);
  const replies = (await pipeline.exec()) ?? [];
  check(replies);
  const n = matchIds.length;
  const unread = (replies[3 * n]?.[1] ?? []) as (string | null)[];
  matchIds.forEach((id, i) => {
    const lm = (replies[i]?.[1] ?? {}) as Record<string, string>;
    const rp = (replies[n + i]?.[1] ?? {}) as Record<string, string>;
    const dl = (replies[2 * n + i]?.[1] ?? {}) as Record<string, string>;
    const count = Number(unread[i] ?? 0);
    out.set(id, {
      last: lastOf(lm),
      unread: Number.isSafeInteger(count) && count > 0 ? count : 0,
      unreadKept: unread[i] !== null && unread[i] !== undefined,
      read: { lo: pointer(rp['lo']), hi: pointer(rp['hi']) },
      delivered: { lo: pointer(dl['lo']), hi: pointer(dl['hi']) },
    });
  });
  return out;
}

export interface TailSeed {
  matchId: string;
  last: StoredMessage | null;
  loReadId: string;
  hiReadId: string;
}

/** Writes back what PostgreSQL said where Valkey holds nothing (one script per conversation, pipelined). */
export async function seedConversationTails(core: Redis, keys: KeyBuilder, seeds: readonly TailSeed[]): Promise<void> {
  if (seeds.length === 0) return;
  const c = chatKeys(keys);
  await Promise.all(
    seeds.map((s) =>
      runScript(
        core,
        seedTailScript,
        [c.lastMessage(s.matchId), c.readPointers(s.matchId)],
        [
          s.last?.id ?? '0',
          s.last?.senderId ?? '',
          s.last?.kind ?? 0,
          s.last?.refId ?? '',
          s.last?.flags ?? 0,
          s.last ? previewOf(s.last) : '',
          s.loReadId,
          s.hiReadId,
          LAST_MESSAGE_TTL_SECONDS,
          READ_POINTERS_TTL_SECONDS,
        ],
      ),
    ),
  );
}

/** Seeds unread counts the rebuild counted (only where none is kept). */
export async function seedUnread(core: Redis, keys: KeyBuilder, viewerId: string, counts: ReadonlyMap<string, number>): Promise<void> {
  const entries = [...counts].filter(([, n]) => n > 0);
  if (entries.length === 0) return;
  const key = chatKeys(keys).unread(viewerId);
  const pipeline = core.pipeline();
  for (const [matchId, n] of entries) pipeline.hsetnx(key, matchId, n);
  pipeline.expire(key, UNREAD_TTL_SECONDS);
  check(await pipeline.exec());
}

// ─── Counters ─────────────────────────────────────────────────────────────

const counterScript = luaScript(new URL('../social/quota.lua', import.meta.url), 'chat-counter', 1);

/**
 * A period counter checked and counted together (the quota script of the
 * swipe path): `amount` is counted when it fits under `limit` (-1
 * unlimited); a negative amount gives back what an answer did not use.
 */
export async function useCounter(core: Redis, key: string, limit: number, ttlSeconds: number, amount = 1): Promise<{ allowed: boolean; used: number }> {
  const reply = await runScript(core, counterScript, [key], [limit, ttlSeconds, amount]);
  if (!Array.isArray(reply) || reply.length !== 2) throw new TypeError('the counter script returned an unexpected reply');
  return { allowed: Number(reply[0]) === 1, used: Number(reply[1]) };
}

/** The largest id any generator can have minted by `ms`: a pointer past it names a message that cannot exist yet. */
export function largestIdAt(ms: number): string {
  return composeId({ ms, generator: ID_MAX_GENERATOR, sequence: ID_MAX_SEQUENCE }).toString();
}
