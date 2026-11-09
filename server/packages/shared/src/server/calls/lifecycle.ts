import type { Redis } from 'ioredis';
import type { KeyBuilder } from '../kv/keys.js';
import { callKeys } from './keys.js';
import { moveCall, readCall } from './liveStore.js';
import type { CallEndReason, CallEnder, CallSide, LiveCall } from './model.js';

/**
 * The moves of a call, each one compare-and-set (liveStore.ts): the first
 * answer of the callee's phones wins and the others are told so, a decline
 * racing an answer loses cleanly, and two workers never miss a call twice.
 * A move that did not take place answers null; the caller reads the call
 * as it now is and answers with it (a repeat is idempotent).
 *
 * A terminal move writes the end (when, how, by whom, why) and mints the id
 * of the call's line in the chat, so every retry of the finalize job writes
 * the same rows.
 */

export interface LifecycleContext {
  redis: Redis;
  keys: KeyBuilder;
  /** Mints an application id (the call line's). */
  mintId: () => string;
}

function endFields(ctx: LifecycleContext, now: number, outcome: string, endedBy: CallEnder, reason: CallEndReason): Record<string, string | number> {
  return { en: now, oc: outcome, eb: endedBy, er: reason, ln: ctx.mintId() };
}

/** The callee answers on `deviceId`: ringing → connecting, while the ring is on and nobody else answered. */
export function acceptCall(ctx: LifecycleContext, call: LiveCall, deviceId: string | undefined, now: number): Promise<LiveCall | null> {
  return moveCall(
    ctx.redis,
    ctx.keys,
    call,
    { from: ['ringing'], to: 'connecting', ring: 'on', realOnly: true, fields: { an: now, ad: deviceId ?? '', rx: '1' } },
    now,
  );
}

/** The callee declines: ringing → ended (declined). */
export function declineCall(ctx: LifecycleContext, call: LiveCall, now: number): Promise<LiveCall | null> {
  return moveCall(
    ctx.redis,
    ctx.keys,
    call,
    { from: ['ringing'], to: 'ended', realOnly: true, fields: endFields(ctx, now, 'declined', 'callee', 'declined') },
    now,
  );
}

/** The caller hangs up before an answer: ringing → cancelled. */
export function cancelCall(ctx: LifecycleContext, call: LiveCall, now: number): Promise<LiveCall | null> {
  return moveCall(ctx.redis, ctx.keys, call, { from: ['ringing'], to: 'cancelled', fields: endFields(ctx, now, 'cancelled', 'caller', 'cancelled') }, now);
}

/**
 * The ring ran out: ringing → missed, only once it really has. A call that
 * rang nobody because the callee was busy keeps that reason (internal: both
 * people are told it rang out).
 */
export function missCall(ctx: LifecycleContext, call: LiveCall, now: number): Promise<LiveCall | null> {
  const reason: CallEndReason = call.fake === 'busy' ? 'callee_busy' : 'ring_timeout';
  return moveCall(ctx.redis, ctx.keys, call, { from: ['ringing'], to: 'missed', ring: 'over', fields: endFields(ctx, now, 'missed', 'system', reason) }, now);
}

/**
 * The room could not be made for an answer: the call fails for both before
 * anyone joined, but only while it still rings. Another phone of the callee
 * may have answered meanwhile (its room was made, its answer won): that call
 * stands, and this phone was answered elsewhere.
 */
export function failCall(ctx: LifecycleContext, call: LiveCall, reason: CallEndReason, now: number): Promise<LiveCall | null> {
  return moveCall(ctx.redis, ctx.keys, call, { from: ['ringing'], to: 'ended', ring: 'on', realOnly: true, fields: endFields(ctx, now, 'failed', 'system', reason) }, now);
}

/** Both people are in the room: connecting → active. */
export function activateCall(ctx: LifecycleContext, call: LiveCall, now: number): Promise<LiveCall | null> {
  return moveCall(ctx.redis, ctx.keys, call, { from: ['connecting'], to: 'active', fields: { ac: now } }, now);
}

/** Tries of an end that keeps losing to a live move (connecting → active). */
const COMPLETE_ATTEMPTS = 3;

/**
 * An answered call is over: connecting|active → ended. Completed when both
 * people were in the room together at some point, failed when they never
 * were. Lost to connecting → active, the end tries again from the call as
 * it now is: it still stands.
 */
export async function completeCall(ctx: LifecycleContext, call: LiveCall, endedBy: CallEnder, reason: CallEndReason, now: number): Promise<LiveCall | null> {
  let current: LiveCall | null = call;
  for (let attempt = 0; attempt < COMPLETE_ATTEMPTS && current; attempt += 1) {
    if (current.state !== 'connecting' && current.state !== 'active') return null;
    const outcome = current.state === 'active' || current.activeMs !== undefined ? 'completed' : 'failed';
    const moved = await moveCall(ctx.redis, ctx.keys, current, { from: [current.state], to: 'ended', fields: endFields(ctx, now, outcome, endedBy, reason) }, now);
    if (moved) return moved;
    current = await readCall(ctx.redis, ctx.keys, current.id);
  }
  return null;
}

/** Either person hangs up: before the answer the caller's cancel or the callee's decline, after it the end. */
export async function hangUpCall(ctx: LifecycleContext, call: LiveCall, side: CallSide, now: number): Promise<LiveCall | null> {
  if (call.state === 'ringing') return side === 'caller' ? cancelCall(ctx, call, now) : declineCall(ctx, call, now);
  return completeCall(ctx, call, side, 'hangup', now);
}

/** Whether a call's conversation ended (unmatch, block, ban, deletion): its tombstone `mte:` is there. */
export async function conversationEnded(redis: Redis, keys: KeyBuilder, matchId: string): Promise<boolean> {
  return (await redis.exists(keys.matchEnded(matchId))) === 1;
}

/**
 * The conversation ended while its call lived (an unmatch, a block, a ban, a
 * deletion): the call ends for both at once, whatever was said about
 * continuity, since one of the two may no longer reach the other. Before
 * the answer it is cancelled, after it ended.
 */
export async function endForEndedConversation(ctx: LifecycleContext, call: LiveCall, now: number): Promise<LiveCall | null> {
  if (call.state === 'ringing') {
    const moved = await moveCall(ctx.redis, ctx.keys, call, { from: ['ringing'], to: 'cancelled', fields: endFields(ctx, now, 'cancelled', 'system', 'cancelled') }, now);
    if (moved) return moved;
    const current = await readCall(ctx.redis, ctx.keys, call.id);
    if (!current || (current.state !== 'connecting' && current.state !== 'active')) return null;
    return completeCall(ctx, current, 'system', 'hangup', now);
  }
  return completeCall(ctx, call, 'system', 'hangup', now);
}

/**
 * Ends the live call of a pair whose conversation just ended, if they are in
 * one together (either person's `busy:` names it). For the paths that end
 * conversations, so the call does not wait for its next request or room
 * check to find out. The ended call, or null.
 */
export async function endPairCall(
  ctx: LifecycleContext,
  match: { id: string; lo: string; hi: string },
  now: number,
): Promise<LiveCall | null> {
  for (const userId of [match.lo, match.hi]) {
    const name = await ctx.redis.get(callKeys(ctx.keys).busy(userId));
    const callId = name ? /call:([1-9][0-9]{0,18})$/.exec(name)?.[1] : undefined;
    if (!callId) continue;
    const call = await readCall(ctx.redis, ctx.keys, callId);
    if (call?.matchId === match.id && (call.state === 'ringing' || call.state === 'connecting' || call.state === 'active')) {
      return endForEndedConversation(ctx, call, now);
    }
  }
  return null;
}
