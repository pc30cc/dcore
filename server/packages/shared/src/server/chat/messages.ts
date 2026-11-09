import { messageSchema, wireTime, type Message } from '../../api/common.js';
import { MESSAGE_BODY_MAX } from '../../api/chat.js';
import { isStorableText } from '../../api/social.js';
import { messageFlags, messageKind } from '../../codes.js';
import { callLineOf, decodeCallLineBody } from '../calls/callLine.js';
import { idTime } from '../../ids.js';
import type { PublicIds } from '../ids/publicId.js';
import { StreamEntryError } from '../social/streams.js';

/**
 * Messages as they are stored (the `messages` row, a `wb:msg` entry) and as
 * they are sent (the wire `Message`), and the `wb:msg` entry codec.
 *
 * A `wb:msg` entry carries `id`, `m` (match), `s` (sender), `k` (kind code),
 * `r` (ref id or empty), `f` (flags) and, only when the message has one,
 * `b` (the body; an empty body is a removed reaction). Ids are raw decimal
 * ids. The main stream is never trimmed by length: the writer trims it by
 * MINID once its rows are durable.
 */

const ID = /^[1-9][0-9]{0,18}$/;

export const KIND = {
  text: messageKind.code('text'),
  image: messageKind.code('image'),
  voice: messageKind.code('voice'),
  gif: messageKind.code('gif'),
  call: messageKind.code('call'),
  likeNote: messageKind.code('like_note'),
  reaction: messageKind.code('reaction'),
  unsend: messageKind.code('unsend'),
} as const;

export const FLAG = {
  risky: messageFlags.code('risky'),
  hidden: messageFlags.code('hidden'),
  warned: messageFlags.code('warned'),
  bodyRemoved: messageFlags.code('body_removed'),
} as const;

/** One message as the database row holds it (ids as decimal strings). */
export interface StoredMessage {
  id: string;
  matchId: string;
  senderId: string;
  refId: string | null;
  kind: number;
  flags: number;
  body: string | null;
}

/** What a stored message changes in the conversation list: its preview, order and unread count, or nothing. */
export type ListEffect = 'news' | 'reaction' | 'unsend';

export function listEffectOf(kind: number): ListEffect {
  if (kind === KIND.reaction) return 'reaction';
  if (kind === KIND.unsend) return 'unsend';
  return 'news';
}

// ─── wb:msg entries ───────────────────────────────────────────────────────

export function messageEntryFields(m: StoredMessage): string[] {
  const fields = ['id', m.id, 'm', m.matchId, 's', m.senderId, 'k', String(m.kind), 'r', m.refId ?? '', 'f', String(m.flags)];
  if (m.body !== null) fields.push('b', m.body);
  return fields;
}

function idField(fields: Record<string, string>, name: string): string {
  const value = fields[name];
  if (value === undefined || !ID.test(value)) throw new StreamEntryError('wb:msg', name);
  return value;
}

/**
 * A `wb:msg` entry; a malformed one throws {@link StreamEntryError} (the
 * writer dead-letters it). Entries come only from the send script, whose
 * inputs the API validated, so a malformed entry is a bug, never user data
 * that could be fixed by dropping a field.
 */
export function parseMessageEntry(fields: Record<string, string>): StoredMessage {
  const kind = Number(fields['k']);
  if (!Number.isInteger(kind) || kind < 1 || kind > 8) throw new StreamEntryError('wb:msg', 'k');
  const flags = Number(fields['f'] ?? '0');
  if (!Number.isInteger(flags) || flags < 0 || flags > 255) throw new StreamEntryError('wb:msg', 'f');
  const ref = fields['r'];
  if (ref !== undefined && ref !== '' && !ID.test(ref)) throw new StreamEntryError('wb:msg', 'r');
  const body = fields['b'] ?? null;
  if (body !== null && !isStorableText(body, MESSAGE_BODY_MAX)) throw new StreamEntryError('wb:msg', 'b');
  const m: StoredMessage = {
    id: idField(fields, 'id'),
    matchId: idField(fields, 'm'),
    senderId: idField(fields, 's'),
    refId: ref ? ref : null,
    kind,
    flags,
    body,
  };
  // The table's own checks, so one entry never fails a whole batch.
  const needsRef: readonly number[] = [KIND.image, KIND.voice, KIND.call, KIND.reaction, KIND.unsend];
  const needsBody: readonly number[] = [KIND.text, KIND.gif, KIND.likeNote, KIND.reaction];
  if (needsRef.includes(kind) && m.refId === null) {
    throw new StreamEntryError('wb:msg', 'r');
  }
  if (needsBody.includes(kind) && body === null && (flags & FLAG.bodyRemoved) === 0) {
    throw new StreamEntryError('wb:msg', 'b');
  }
  return m;
}

// ─── The wire ─────────────────────────────────────────────────────────────

export interface MessageRenderContext {
  publicIds: Pick<PublicIds, 'user'>;
}

/**
 * A stored message as either member reads it. A message hidden by
 * moderation, or whose body was removed after an unsend, keeps no text; a
 * call line becomes its `call` part.
 */
export function messageOf(ctx: MessageRenderContext, m: StoredMessage, extra: { clientId?: string | undefined } = {}): Message {
  const kind = messageKind.name(m.kind);
  const at = wireTime(idTime(m.id));
  const message: Message = {
    id: m.id,
    conversationId: m.matchId,
    senderId: ctx.publicIds.user.encode(m.senderId),
    kind,
    at,
  };
  if (extra.clientId) message.clientId = extra.clientId;
  if (m.refId) message.refId = m.refId;
  const hidden = (m.flags & (FLAG.hidden | FLAG.bodyRemoved)) !== 0;
  if (m.kind === KIND.call) {
    // The call line's summary (the calls module writes it); a body that is not one shows as a plain call line.
    const line = decodeCallLineBody(m.body);
    if (line && m.refId) message.call = callLineOf(m.refId, line, message.senderId);
  } else if (!hidden && m.body !== null) {
    message.body = m.body;
  }
  return messageSchema.parse(message);
}

/** The list preview of a body: its first 64 code points. */
export const PREVIEW_CHARS = 64;

export function previewOf(m: Pick<StoredMessage, 'kind' | 'body'>): string {
  if (m.body === null) return '';
  // A call line's summary is short and the list renders it whole.
  if (m.kind === KIND.call) return m.body;
  const chars = [...m.body];
  return chars.length <= PREVIEW_CHARS ? m.body : chars.slice(0, PREVIEW_CHARS).join('');
}
