import { conversationSchema, wireTime, type Conversation, type PeerSummary, type Photo } from '../../api/common.js';
import { matchSource, matchState } from '../../codes.js';
import { idTime } from '../../ids.js';
import { cardSourceSchema, type CardSource } from '../deck/cards.js';
import type { PublicIds } from '../ids/publicId.js';
import { photoVariantUrl, type MediaStore } from '../media/store.js';
import type { MatchState } from './matches.js';

/**
 * The parts of a conversation both the API (lists, the swipe answer) and the
 * worker (the `conversation` event) send: the peer as a list shows them and
 * the conversation as one of its two people sees it. Built from stored
 * cards (`profile_card()`), so nothing a moderator has not approved appears.
 */

export interface PeerRenderContext {
  publicIds: PublicIds;
  /** Null without media storage: the peer then has no photo link. */
  media: Pick<MediaStore, 'urls'> | null;
}

/** A stored card, validated; null when the value is not one. */
export function parseCardSource(value: unknown): CardSource | null {
  const parsed = cardSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Name, first photo (the small variant) and badge. */
export function peerSummaryOf(ctx: PeerRenderContext, userId: string, card: CardSource): PeerSummary {
  const first = card.photos[0];
  let photo: Photo | null = null;
  if (first && ctx.media && first.w !== undefined && first.h !== undefined && first.w > 0 && first.h > 0) {
    const url = photoVariantUrl(ctx.media, first.id, first.bv, 320);
    if (url) photo = { id: first.id, w: first.w, h: first.h, blurhash: first.bh ?? '', url };
  }
  return { id: ctx.publicIds.user.encode(userId), name: card.name, photo, verified: card.verified };
}

/** matches.flags bits for the viewer's side and the peer's. */
function sideBits(match: Pick<MatchState, 'lo'>, viewerId: string): { calls: number; peerCalls: number; muted: number } {
  return match.lo === viewerId ? { calls: 1, peerCalls: 2, muted: 4 } : { calls: 2, peerCalls: 1, muted: 8 };
}

export interface ConversationParts {
  match: Pick<MatchState, 'id' | 'lo' | 'hi' | 'state' | 'flags' | 'source'>;
  viewerId: string;
  peer: PeerSummary;
  /** The viewer's read pointer (0 or absent: nothing read). */
  myReadId?: string | undefined;
  unread?: number | undefined;
}

/** A conversation as `viewerId` sees it; `lastMessage` is null until chat exists (W4). */
export function conversationOf(parts: ConversationParts): Conversation {
  const { match, viewerId } = parts;
  if (viewerId !== match.lo && viewerId !== match.hi) throw new RangeError('the viewer is not in this conversation');
  const bits = sideBits(match, viewerId);
  const conversation: Conversation = {
    id: match.id,
    peer: parts.peer,
    state: match.state === matchState.code('active') ? 'active' : 'ended',
    source: matchSource.name(match.source),
    createdAt: wireTime(idTime(match.id)),
    lastMessage: null,
    unread: parts.unread ?? 0,
    callsAllowed: { me: (match.flags & bits.calls) !== 0, peer: (match.flags & bits.peerCalls) !== 0 },
    muted: (match.flags & bits.muted) !== 0,
  };
  if (parts.myReadId && parts.myReadId !== '0') conversation.myReadId = parts.myReadId;
  return conversationSchema.parse(conversation);
}
