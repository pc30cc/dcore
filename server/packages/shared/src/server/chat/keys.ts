import type { KeyBuilder } from '../kv/keys.js';

/**
 * Valkey names of the chat state (kv-core unless noted), built under the
 * deployment prefix. `<uid>` is a raw user id, `<m>` a match (conversation)
 * id; none of these names leaves the server.
 *
 * - `lm:<m>` hash {id, s, k, r, f, p}: the conversation's newest message
 *   (sender, kind, ref, flags, a preview; a call line's summary), 7 days;
 *   `id` "0" says the conversation has no message yet.
 * - `unr:<uid>` hash m → count: unread messages per conversation, 30 days.
 * - `rp:<m>` hash {lo, hi}: each side's read pointer, 7 days; `rp:dirty`,
 *   the conversations whose pointers moved since the last flush, and
 *   `rp:flushing`, those a flush took and has not written yet (a flush that
 *   died leaves them there, and the next one writes them first).
 * - `dl:<m>` hash {lo, hi}: each side's delivered pointer (never stored in
 *   PostgreSQL), 30 days.
 * - `view:<uid>`: the conversation on screen (30 s), for push suppression.
 * - `ty:<uid>`: one typing signal per 3 s.
 * - `idem:msg:<uid>:<clientId>`, `idem:req:<uid>:<clientId>`: a send's
 *   record, so a retry gets the same message or request (15 min).
 * - `push:m:<m>:<uid>`: one message push per conversation and recipient per
 *   10 minutes.
 * - `pres:<uid>` (kv-cache): online as Centrifugo's presence said, 30 s.
 * - `ls:<uid>` (kv-cache): last seen, unix seconds at minute precision, 7 days.
 */
export function chatKeys(keys: KeyBuilder) {
  return {
    lastMessage: (matchId: string) => keys.raw('lm', matchId),
    unread: (uid: string) => keys.raw('unr', uid),
    readPointers: (matchId: string) => keys.raw('rp', matchId),
    readDirty: () => keys.raw('rp', 'dirty'),
    readFlushing: () => keys.raw('rp', 'flushing'),
    delivered: (matchId: string) => keys.raw('dl', matchId),
    viewing: (uid: string) => keys.raw('view', uid),
    typing: (uid: string) => keys.raw('ty', uid),
    sendOnce: (uid: string, clientId: string) => keys.raw('idem', 'msg', uid, clientId),
    requestOnce: (uid: string, clientId: string) => keys.raw('idem', 'req', uid, clientId),
    messagePush: (matchId: string, recipientId: string) => keys.raw('push', 'm', matchId, recipientId),
    receiptLimit: (uid: string, matchId: string, pointer: 'r' | 'd') => keys.raw('rl', 'rcpt', uid, matchId, pointer),
    presence: (uid: string) => keys.presence(uid),
    lastSeen: (uid: string) => keys.lastSeen(uid),
  };
}

export type ChatKeys = ReturnType<typeof chatKeys>;

export const LAST_MESSAGE_TTL_SECONDS = 7 * 86_400;
export const UNREAD_TTL_SECONDS = 30 * 86_400;
export const READ_POINTERS_TTL_SECONDS = 7 * 86_400;
export const DELIVERED_TTL_SECONDS = 30 * 86_400;
export const VIEWING_TTL_SECONDS = 30;
export const TYPING_INTERVAL_MS = 3_000;
/** The outbox resends for 10 minutes; a retry within 15 gets the same message. */
export const SEND_RECORD_TTL_SECONDS = 15 * 60;
export const MESSAGE_PUSH_COLLAPSE_SECONDS = 600;
export const PRESENCE_TTL_SECONDS = 30;
export const LAST_SEEN_TTL_SECONDS = 7 * 86_400;
/** "Active recently": seen within this long (and not online now). */
export const ACTIVE_RECENTLY_SECONDS = 24 * 3_600;
