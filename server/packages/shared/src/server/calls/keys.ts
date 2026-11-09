import type { KeyBuilder } from '../kv/keys.js';

/**
 * Valkey names of live calls (kv-core unless noted), under the deployment
 * prefix. `<uid>` is a raw user id; none of these names leaves the server.
 *
 * - `call:<id>` hash: the live call (model.ts lists its fields; besides
 *   them `tcr`/`tce`, the relay username handed to the caller/callee, see
 *   `issueTurnUsername`), 12 h while it lives, 10 min as a tombstone once it
 *   is over.
 * - `call:<id>:in` set: the LiveKit identities in the call's room, as the
 *   webhook saw them join and leave; lives as long as the call.
 * - `busy:<uid>` string: the full (prefixed) name of the call hash the person
 *   is in; deleted by the call's terminal move while it still names that call.
 * - `calls:live` zset: call id → expiry (ms) of every call that holds a
 *   room or a ring; trimmed by score inside the placement script.
 * - `lkwh:<eventId>` string: a LiveKit webhook event being applied
 *   (`processing`, 5 min) or applied (`done`, 1 day).
 * - `rl:callc:<uid>:<minute>`, `rl:callr:<uid>:<minute>`: rings placed by a
 *   caller and rings a callee got, per minute.
 * - `callok:<matchId>` (kv-cache): the pair's visibility verdict for calls,
 *   `<ms>:<lo sees hi><hi sees lo>`, one minute.
 */
export function callKeys(keys: KeyBuilder) {
  return {
    call: (callId: string) => keys.raw('call', callId),
    presence: (callId: string) => keys.raw('call', callId, 'in'),
    busy: (userId: string) => keys.raw('busy', userId),
    live: () => keys.raw('calls', 'live'),
    webhookEvent: (eventId: string) => keys.raw('lkwh', eventId),
    callerRings: (userId: string, minute: number) => keys.raw('rl', 'callc', userId, minute),
    calleeRings: (userId: string, minute: number) => keys.raw('rl', 'callr', userId, minute),
    eligibility: (matchId: string) => keys.raw('callok', matchId),
  };
}

export type CallKeys = ReturnType<typeof callKeys>;
