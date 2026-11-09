import type { Redis } from 'ioredis';
import type { KeyBuilder } from '../kv/keys.js';
import { luaScript, runScript } from '../kv/scripts.js';
import { writeMatchState, type MatchStateWrite } from '../social/matches.js';
import { callKeys } from './keys.js';
import { CALL_LIVE_TTL_SECONDS, CALL_RING_MS, CALL_TOMBSTONE_SECONDS, parseLiveCall, type CallState, type LiveCall } from './model.js';

/**
 * The live call in Valkey: one hash per call, moved by Lua scripts that run
 * alone, so every move is a compare-and-set and nothing about a live call is
 * ever written to PostgreSQL. Each script gets every key it touches in
 * `KEYS[]` (full names, deployment prefix included); `busy:<uid>` holds the
 * full name of the call hash, never a bare id, so the busy rule holds under
 * any prefix.
 */

const placeScript = luaScript(new URL('./place.lua', import.meta.url), 'call-place', 5);
const moveScript = luaScript(new URL('./move.lua', import.meta.url), 'call-move', 5);
const rangScript = luaScript(new URL('./rang.lua', import.meta.url), 'call-rang', 1);
const joinedScript = luaScript(new URL('./joined.lua', import.meta.url), 'call-joined', 2);
const ringPushScript = luaScript(new URL('./ringPush.lua', import.meta.url), 'call-ring-push', 1);
const fieldsScript = luaScript(new URL('./fields.lua', import.meta.url), 'call-fields', 1);
const quotaScript = luaScript(new URL('../social/quota.lua', import.meta.url), 'call-rings', 1);
const turnUserScript = luaScript(new URL('./turnUser.lua', import.meta.url), 'call-turn-user', 1);

export interface CallParties {
  id: string;
  callerId: string;
  calleeId: string;
}

function keysOf(keys: KeyBuilder, call: CallParties) {
  const k = callKeys(keys);
  return { call: k.call(call.id), busyCaller: k.busy(call.callerId), busyCallee: k.busy(call.calleeId), live: k.live(), presence: k.presence(call.id) };
}

function flatten(fields: Readonly<Record<string, string | number>>): string[] {
  const out: string[] = [];
  for (const [field, value] of Object.entries(fields)) out.push(field, String(value));
  return out;
}

function asCall(reply: unknown): LiveCall | null {
  if (!Array.isArray(reply)) return null;
  return parseLiveCall(reply.map(String));
}

export async function readCall(redis: Redis, keys: KeyBuilder, callId: string): Promise<LiveCall | null> {
  return parseLiveCall(await redis.hgetall(callKeys(keys).call(callId)));
}

export type PlaceVerdict = 'placed' | 'callee_busy' | 'shadow' | 'ended' | 'caller_busy' | 'limit_reached' | 'exists';

export interface PlaceInput extends CallParties {
  matchId: string;
  kind: 'audio' | 'video';
  now: number;
  /** The live cap; null: none. */
  maxLive: number | null;
  /** A caller nobody may see: the call rings nobody. */
  shadow: boolean;
  /** How long the call rings, whether or not it rings anybody. */
  ringMs?: number | undefined;
  /** The caller's first name (the callee's missed-call notification). */
  callerName?: string | undefined;
}

/** The conversation still on, the busy rule, the live cap and the new call, in one step. */
export async function placeCall(redis: Redis, keys: KeyBuilder, input: PlaceInput): Promise<PlaceVerdict> {
  const k = keysOf(keys, input);
  const reply = await runScript(
    redis,
    placeScript,
    [k.busyCaller, k.busyCallee, k.call, k.live, keys.matchEnded(input.matchId)],
    [
      input.id,
      input.now,
      input.maxLive ?? -1,
      CALL_LIVE_TTL_SECONDS,
      input.ringMs ?? CALL_RING_MS,
      input.shadow ? 'shadow' : '',
      ...flatten({ m: input.matchId, cr: input.callerId, ce: input.calleeId, k: input.kind, ...(input.callerName ? { nm: input.callerName } : {}) }),
    ],
  );
  const verdict = String(reply);
  if (!['placed', 'callee_busy', 'shadow', 'ended', 'caller_busy', 'limit_reached', 'exists'].includes(verdict)) {
    throw new TypeError(`the placement script answered ${verdict}`);
  }
  return verdict as PlaceVerdict;
}

export interface MoveSpec {
  from: readonly CallState[];
  to: CallState;
  /** `on`: only while the ring is still on; `over`: only once it ran out. */
  ring?: 'on' | 'over' | 'any' | undefined;
  /** Refuse a call that rings nobody (an answer, a decline). */
  realOnly?: boolean | undefined;
  fields?: Readonly<Record<string, string | number>> | undefined;
}

/** One compare-and-set move; the call after it, or null when it did not take place. */
export async function moveCall(redis: Redis, keys: KeyBuilder, call: CallParties, spec: MoveSpec, now: number): Promise<LiveCall | null> {
  const k = keysOf(keys, call);
  const reply = await runScript(
    redis,
    moveScript,
    [k.call, k.busyCaller, k.busyCallee, k.live, k.presence],
    [spec.from.join('|'), spec.to, spec.ring ?? 'any', now, CALL_TOMBSTONE_SECONDS, spec.realOnly ? '1' : '0', ...flatten(spec.fields ?? {})],
  );
  return asCall(reply);
}

export type RangVerdict = 'stamped' | 'already' | 'over' | 'not_ringing' | 'missing';

/** The callee's phone showed the ring; `shown`: the caller may be told. */
export async function stampRang(redis: Redis, keys: KeyBuilder, callId: string, now: number, shown: boolean): Promise<{ verdict: RangVerdict; call: LiveCall | null }> {
  const reply = (await runScript(redis, rangScript, [callKeys(keys).call(callId)], [now, shown ? '1' : '0'])) as unknown[];
  const verdict = String(reply[0]) as RangVerdict;
  return { verdict, call: asCall(reply.slice(1)) };
}

export type JoinVerdict = 'activated' | 'joined' | 'over' | 'missing';

/** A participant joined the room; the call becomes active once both identities are in. */
export async function markJoined(
  redis: Redis,
  keys: KeyBuilder,
  callId: string,
  identity: string,
  identities: { caller: string; callee: string },
  now: number,
): Promise<{ verdict: JoinVerdict; call: LiveCall | null }> {
  const k = callKeys(keys);
  const reply = (await runScript(redis, joinedScript, [k.call(callId), k.presence(callId)], [identity, identities.caller, identities.callee, now])) as unknown[];
  return { verdict: String(reply[0]) as JoinVerdict, call: asCall(reply.slice(1)) };
}

/** A participant left the room: its identity leaves the presence set. */
export async function markLeft(redis: Redis, keys: KeyBuilder, callId: string, identity: string): Promise<void> {
  await redis.srem(callKeys(keys).presence(callId), identity);
}

/** Writes fields of a call only while its hash exists; false when it is gone. */
export async function setCallFields(redis: Redis, keys: KeyBuilder, callId: string, fields: Readonly<Record<string, string | number>>): Promise<boolean> {
  return Number(await runScript(redis, fieldsScript, [callKeys(keys).call(callId)], flatten(fields))) === 1;
}

/** The call hash field of a participant's relay username. */
export const TURN_USER_FIELD: Readonly<Record<'caller' | 'callee', string>> = { caller: 'tcr', callee: 'tce' };

/**
 * The relay username a participant is handed: the one kept for them in the
 * call hash while its expiry is at least `reuseFloorSeconds`, else
 * `candidate`, kept from now on. Marks the call relayed. Null when the call
 * hash is gone.
 */
export async function issueTurnUsername(
  redis: Redis,
  keys: KeyBuilder,
  callId: string,
  side: 'caller' | 'callee',
  candidate: string,
  reuseFloorSeconds: number,
): Promise<string | null> {
  const reply = await runScript(redis, turnUserScript, [callKeys(keys).call(callId)], [TURN_USER_FIELD[side], candidate, reuseFloorSeconds]);
  return typeof reply === 'string' && reply !== '' ? reply : null;
}

export type RingPushStep =
  | { step: 'go' }
  | { step: 'skip'; reason: string }
  | { step: 'done'; state: string }
  | { step: 'none' }
  | { step: 'wait'; sinceMs: number }
  | { step: 'send'; rung: RungDevice[]; answeredDevice: string | undefined; known: boolean };

/** A device a ring went to: the devices row and its push token, so the stop reaches exactly these. */
export interface RungDevice {
  d: string;
  t: string;
  l?: string | undefined;
}

function parseRung(raw: string): RungDevice[] {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return (value as unknown[]).filter((v): v is RungDevice => {
      const device = v as Partial<Record<'d' | 't', unknown>> | null;
      return typeof device === 'object' && device !== null && typeof device.d === 'string' && typeof device.t === 'string';
    });
  } catch {
    return [];
  }
}

/** One step of the ring push and its stop (ringPush.lua). */
export async function ringPushStep(
  redis: Redis,
  keys: KeyBuilder,
  callId: string,
  step: 'begin' | 'done' | 'stop' | 'force',
  now: number,
  rung: readonly RungDevice[] = [],
): Promise<RingPushStep> {
  const reply = ((await runScript(redis, ringPushScript, [callKeys(keys).call(callId)], [step, now, JSON.stringify(rung)])) as unknown[]).map((part) =>
    typeof part === 'string' || typeof part === 'number' ? String(part) : '',
  );
  const verdict = reply[0] ?? '';
  switch (verdict) {
    case 'go':
      return { step: 'go' };
    case 'skip':
      return { step: 'skip', reason: reply[1] ?? '' };
    case 'done':
      return { step: 'done', state: reply[1] ?? '' };
    case 'none':
      return { step: 'none' };
    case 'wait':
      return { step: 'wait', sinceMs: Number(reply[1] ?? 0) };
    case 'send': {
      const raw = reply[1] ?? '';
      const answered = reply[2] ?? '';
      return { step: 'send', rung: raw ? parseRung(raw) : [], answeredDevice: answered || undefined, known: raw !== '' };
    }
    default:
      throw new TypeError(`the ring push script answered ${verdict}`);
  }
}

/** A caller places at most this many calls a minute; a callee is rung at most this many times a minute by everyone together. */
export const CALLER_RINGS_PER_MINUTE = 10;
export const CALLEE_RINGS_PER_MINUTE = 6;

export interface RingTake {
  allowed: boolean;
  /** Seconds until the minute's count starts again. */
  retryAfterSeconds: number;
  /** The counter the ring was counted in, to give it back. */
  key: string;
}

function minuteOf(now: number): number {
  return Math.floor(now / 60_000);
}

async function take(redis: Redis, key: string, limit: number, now: number): Promise<RingTake> {
  const reply = (await runScript(redis, quotaScript, [key], [limit, 120, 1])) as unknown[];
  const retryAfterSeconds = Math.max(1, Math.ceil(((minuteOf(now) + 1) * 60_000 - now) / 1_000));
  return { allowed: Number(reply[0]) === 1, retryAfterSeconds, key };
}

/** Counts a placement against the caller's minute. */
export function takeCallerRing(redis: Redis, keys: KeyBuilder, callerId: string, now: number, limit = CALLER_RINGS_PER_MINUTE): Promise<RingTake> {
  return take(redis, callKeys(keys).callerRings(callerId, minuteOf(now)), limit, now);
}

/** Takes one of the callee's rings for this minute, to keep once the call rings, or give back. */
export function takeCalleeRing(redis: Redis, keys: KeyBuilder, calleeId: string, now: number, limit = CALLEE_RINGS_PER_MINUTE): Promise<RingTake> {
  return take(redis, callKeys(keys).calleeRings(calleeId, minuteOf(now)), limit, now);
}

/** Gives back a ring that never left (the call was not placed, or rings nobody). */
export async function giveBackRing(redis: Redis, ring: Pick<RingTake, 'key'>): Promise<void> {
  await runScript(redis, quotaScript, [ring.key], [-1, 120, -1]);
}

/** How long a conversation state read for a call stays cached (a flag change that raced the read lasts no longer). */
export const CALL_PAIR_STATE_TTL_SECONDS = 60;

/**
 * Caches a conversation's state read from PostgreSQL, unless it ended
 * meanwhile or was just dropped (`writeMatchState`). A new copy lives a
 * minute; a longer one a chat read keeps already keeps its lifetime.
 */
export function cacheOpenPairState(
  redis: Redis,
  keys: KeyBuilder,
  pair: { id: string; lo: string; hi: string; state: number; flags: number; source: number; createdMs: number },
): Promise<MatchStateWrite> {
  return writeMatchState(redis, keys, pair, { ttlSeconds: CALL_PAIR_STATE_TTL_SECONDS });
}
