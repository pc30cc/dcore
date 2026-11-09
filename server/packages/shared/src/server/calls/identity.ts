import { createHmac } from 'node:crypto';
import type { CallSide } from './model.js';

/**
 * A person's identity in a call room. Everyone in a LiveKit room sees every
 * other participant's identity, name and metadata, and so do webhooks and
 * logs, so nobody ever joins under their user id: a participant is
 * `u:<16 hex>`, the first 16 hex digits of HMAC-SHA256 under
 * LIVEKIT_IDENTITY_SECRET over `call-ref:<callId>:<userId>`. The name is
 * empty and there is no participant metadata.
 *
 * One person keeps one identity for one call (a second device or a rejoin
 * replaces the older connection: LiveKit's DUPLICATE_IDENTITY), another call
 * gives them another, and the server finds the person again by computing
 * the two identities of the call's two people.
 */

export const PARTICIPANT_IDENTITY = /^u:[0-9a-f]{16}$/;

export function participantRef(secret: string, callId: string, userId: string): string {
  return createHmac('sha256', secret).update(`call-ref:${callId}:${userId}`).digest('hex').slice(0, 16);
}

export function participantIdentity(secret: string, callId: string, userId: string): string {
  return `u:${participantRef(secret, callId, userId)}`;
}

/** The two identities of a call. */
export function callIdentities(secret: string, call: { id: string; callerId: string; calleeId: string }): { caller: string; callee: string } {
  return { caller: participantIdentity(secret, call.id, call.callerId), callee: participantIdentity(secret, call.id, call.calleeId) };
}

/** Which side of the call an identity is, or null for anybody else. */
export function sideOfIdentity(secret: string, call: { id: string; callerId: string; calleeId: string }, identity: string): CallSide | null {
  if (!PARTICIPANT_IDENTITY.test(identity)) return null;
  const ids = callIdentities(secret, call);
  if (identity === ids.caller) return 'caller';
  if (identity === ids.callee) return 'callee';
  return null;
}
