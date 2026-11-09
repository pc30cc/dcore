import { callSchema, wireTime, type Call } from '../../api/common.js';
import { callEndReason, callKind, callOutcome, type CallKind, type CallOutcome } from '../../codes.js';

/**
 * A call between the two people of an active conversation, while it lives:
 * a Valkey hash (`call:<id>`, see liveStore.ts) that Lua scripts move
 * through its states. PostgreSQL only receives the finished call, in one
 * transaction (the `calls` row and its line in the chat).
 *
 *     ringing ──accept──▶ connecting ──both in the room──▶ active ──▶ ended (completed)
 *        │                    └──── hang-up, a member leaving, the room closing ───┘
 *        ├─ decline (callee) ─▶ ended (declined)
 *        ├─ cancel (caller) ──▶ cancelled
 *        └─ ring runs out ────▶ missed
 *
 * A call answered whose two people were never in the room together ends as
 * `failed`: nothing was said, so there is no talk time to show.
 *
 * Two kinds of call never ring anybody (`fake`): a callee already in another
 * call (`busy`), and a caller nobody else may see (`shadow`, a shadowban).
 * The caller sees an ordinary call that rings as long as any other and ends
 * as missed, exactly like one nobody answered (its times included), and
 * finds its line in the chat; a busy callee then finds a missed call, a
 * shadow call leaves no trace for anyone else.
 */

/** How long a call rings before it is missed (a call that rings nobody too). */
export const CALL_RING_MS = 45_000;
/** A live call holds nobody longer than this (the guard of last resort). */
export const CALL_LIVE_TTL_SECONDS = 12 * 3_600;
/** A finished call's hash stays this long, so late moves answer with the final state. */
export const CALL_TOMBSTONE_SECONDS = 600;
/** The first room check after the answer, and the period of the next ones. */
export const ROOM_CHECK_FIRST_MS = 90_000;
export const ROOM_CHECK_EVERY_MS = 60_000;
/** An answered call nobody saw both people of in the room ends this long after the answer. */
export const CONNECT_MAX_MS = 5 * 60_000;
/** Room checks end a call this close to the hash's own expiry. */
export const LIVE_GUARD_MS = CALL_LIVE_TTL_SECONDS * 1_000 - 5 * 60_000;
/** LiveKit join tokens; the apps ask again when they rejoin. */
export const PARTICIPANT_TOKEN_TTL_SECONDS = 600;

export const callStates = ['ringing', 'connecting', 'active', 'ended', 'missed', 'cancelled'] as const;
export type CallState = (typeof callStates)[number];
export const LIVE_CALL_STATES: readonly CallState[] = ['ringing', 'connecting', 'active'];
export const TERMINAL_CALL_STATES: readonly CallState[] = ['ended', 'missed', 'cancelled'];

export type CallSide = 'caller' | 'callee';
export type CallEnder = CallSide | 'system';
export type CallEndReason = (typeof callEndReason.names)[number];
/** Why rung phones are told to stop ringing. */
export type RingStopReason = 'answered_elsewhere' | 'declined' | 'cancelled' | 'missed' | 'ended';

export function isLiveState(state: string): state is 'ringing' | 'connecting' | 'active' {
  return state === 'ringing' || state === 'connecting' || state === 'active';
}

export function isTerminalState(state: string): state is 'ended' | 'missed' | 'cancelled' {
  return state === 'ended' || state === 'missed' || state === 'cancelled';
}

/** A live (or just finished) call as its hash holds it. Times are epoch milliseconds. */
export interface LiveCall {
  id: string;
  matchId: string;
  callerId: string;
  calleeId: string;
  kind: CallKind;
  state: CallState;
  placedMs: number;
  /** How long this call rings ({@link CALL_RING_MS}, a call that rings nobody too). */
  ringMs: number;
  /** A call that rings nobody: the callee was busy, or the caller is hidden from everyone. */
  fake: 'busy' | 'shadow' | null;
  /** When a phone of the callee first showed the ring. */
  rangMs: number | undefined;
  /** Whether the caller may know it rang (the callee shows when they are online). */
  rangShown: boolean;
  answeredMs: number | undefined;
  /** The callee's device (devices row) that answered. */
  answeredDevice: string | undefined;
  /** When both people were first in the room. */
  activeMs: number | undefined;
  endedMs: number | undefined;
  outcome: CallOutcome | undefined;
  endedBy: CallEnder | undefined;
  endReason: CallEndReason | undefined;
  /** The id of the call's line in the chat, minted when the call ended. */
  lineId: string | undefined;
  /** Either side was handed the in-country relay. */
  relayed: boolean;
  /** The LiveKit room was created (at the answer). */
  roomCreated: boolean;
  /** The caller's first name, for the callee's missed-call notification. */
  callerName: string | undefined;
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

const ID = /^[1-9][0-9]{0,18}$/;

/** Reads a call hash (HGETALL as a record, or its flat array); null when it is not a call. */
export function parseLiveCall(raw: Record<string, string> | readonly string[] | null | undefined): LiveCall | null {
  if (!raw) return null;
  let h: Record<string, string>;
  if (Array.isArray(raw)) {
    h = {};
    for (let i = 0; i + 1 < raw.length; i += 2) h[raw[i] as string] = raw[i + 1] as string;
  } else {
    h = raw as Record<string, string>;
  }
  const id = h['id'];
  const matchId = h['m'];
  const callerId = h['cr'];
  const calleeId = h['ce'];
  const state = h['st'];
  const placedMs = num(h['pl']);
  const ringMs = num(h['rd']);
  if (!id || !ID.test(id) || !matchId || !callerId || !calleeId || !state || placedMs === undefined || ringMs === undefined) return null;
  if (!(callStates as readonly string[]).includes(state)) return null;
  const kind = h['k'];
  if (!callKind.has(kind ?? '')) return null;
  const outcome = h['oc'];
  const endReason = h['er'];
  const endedBy = h['eb'];
  const fake = h['fk'];
  return {
    id,
    matchId,
    callerId,
    calleeId,
    kind: kind as CallKind,
    state: state as CallState,
    placedMs,
    ringMs,
    fake: fake === 'busy' || fake === 'shadow' ? fake : null,
    rangMs: num(h['rg']),
    rangShown: h['rgs'] === '1',
    answeredMs: num(h['an']),
    answeredDevice: h['ad'] || undefined,
    activeMs: num(h['ac']),
    endedMs: num(h['en']),
    outcome: outcome && callOutcome.has(outcome) ? outcome : undefined,
    endedBy: endedBy === 'caller' || endedBy === 'callee' || endedBy === 'system' ? endedBy : undefined,
    endReason: endReason && callEndReason.has(endReason) ? endReason : undefined,
    lineId: h['ln'] && ID.test(h['ln']) ? h['ln'] : undefined,
    relayed: h['rl'] === '1',
    roomCreated: h['rx'] === '1',
    callerName: h['nm'] || undefined,
  };
}

/** The hash fields of a call (the inverse of {@link parseLiveCall}), for a job that must not depend on the hash. */
export function liveCallFields(call: LiveCall): Record<string, string> {
  const out: Record<string, string> = {
    id: call.id,
    m: call.matchId,
    cr: call.callerId,
    ce: call.calleeId,
    k: call.kind,
    st: call.state,
    pl: String(call.placedMs),
    rd: String(call.ringMs),
  };
  const put = (field: string, value: string | number | undefined) => {
    if (value !== undefined) out[field] = String(value);
  };
  put('fk', call.fake ?? undefined);
  put('rg', call.rangMs);
  if (call.rangShown) out['rgs'] = '1';
  put('an', call.answeredMs);
  put('ad', call.answeredDevice);
  put('ac', call.activeMs);
  put('en', call.endedMs);
  put('oc', call.outcome);
  put('eb', call.endedBy);
  put('er', call.endReason);
  put('ln', call.lineId);
  if (call.relayed) out['rl'] = '1';
  if (call.roomCreated) out['rx'] = '1';
  put('nm', call.callerName);
  return out;
}

/** Which side of the call a person is on, or null. */
export function sideOf(call: Pick<LiveCall, 'callerId' | 'calleeId'>, userId: string): CallSide | null {
  if (userId === call.callerId) return 'caller';
  if (userId === call.calleeId) return 'callee';
  return null;
}

/** Whether the ring is still on at `now`. */
export function isRingOn(call: Pick<LiveCall, 'state' | 'placedMs' | 'ringMs'>, now: number): boolean {
  return call.state === 'ringing' && now < call.placedMs + call.ringMs;
}

/** The LiveKit room of a call. */
export function roomName(callId: string): string {
  return `c_${callId}`;
}

/** The call id of a room name, or null for a room that is not a call's. */
export function callIdOfRoom(name: string | undefined | null): string | null {
  const m = /^c_([1-9][0-9]{0,18})$/.exec(name ?? '');
  return m ? (m[1]!) : null;
}

/** A completed call had both people in the room; its talk time runs from the answer. */
export function talkSeconds(call: Pick<LiveCall, 'outcome' | 'answeredMs' | 'endedMs'>): number {
  if (call.outcome !== 'completed' || call.answeredMs === undefined || call.endedMs === undefined) return 0;
  return Math.max(0, Math.round((call.endedMs - call.answeredMs) / 1_000));
}

/**
 * The end reason a person is told. A busy callee is never revealed: that
 * call ended, for both, like any ring nobody answered.
 */
export function publicEndReason(reason: CallEndReason | undefined): string | undefined {
  if (reason === undefined) return undefined;
  return reason === 'callee_busy' ? 'ring_timeout' : reason;
}

/**
 * The call as one of its two people sees it. Every call rings for
 * {@link CALL_RING_MS} as far as anyone is told; `rangAt` reaches the
 * caller only when the callee shows when they are online.
 */
export function callView(call: LiveCall, viewerId: string): Call {
  const role = sideOf(call, viewerId);
  if (role === null) throw new RangeError('the viewer is not in this call');
  const view: Call = {
    id: call.id,
    conversationId: call.matchId,
    kind: call.kind,
    role,
    state: call.state,
    placedAt: wireTime(call.placedMs),
    ringExpiresAt: wireTime(call.placedMs + CALL_RING_MS),
  };
  if (call.rangMs !== undefined && (role === 'callee' || call.rangShown)) view.rangAt = wireTime(call.rangMs);
  if (call.answeredMs !== undefined) view.answeredAt = wireTime(call.answeredMs);
  if (isTerminalState(call.state)) {
    if (call.outcome) view.outcome = call.outcome;
    if (call.endedMs !== undefined) view.endedAt = wireTime(call.endedMs);
    view.durationSeconds = talkSeconds(call);
    const reason = publicEndReason(call.endReason);
    if (reason) view.endReason = reason;
  }
  return callSchema.parse(view);
}

