import { z } from 'zod';
import { cursorSchema } from '../pagination.js';
import {
  conversationSchema,
  entitlementsSchema,
  idSchema,
  likeKindSchema,
  profileCardSchema,
  publicUidSchema,
} from './common.js';

/** Swipes, likes received, profiles opened from a list, and the conversation list. */

/** A like comment, as `likes.comment` allows. */
export const LIKE_COMMENT_MAX = 300;
export const SWIPES_PER_REQUEST = 20;

/**
 * Characters a free text that is stored never holds: NUL (PostgreSQL's
 * `text` cannot hold it, so one such text would fail a whole write-behind
 * batch) and the other C0 controls and DEL, except tab, line feed and
 * carriage return.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
export const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Whether a text may be stored as it is: no {@link CONTROL_CHARACTERS}, at most `max` code points. */
export function isStorableText(text: string, max: number): boolean {
  if (CONTROL_CHARACTERS.test(text)) return false;
  // UTF-16 units are never fewer than code points: count them only when the units are over.
  return text.length <= max || [...text].length <= max;
}

export const swipeActionSchema = z.enum(['like', 'pass', 'superlike']);
export type SwipeAction = z.infer<typeof swipeActionSchema>;

/** The photo or prompt a like points at (a photo id, or a prompt definition id). */
export const likedItemSchema = z.object({
  kind: z.enum(['photo', 'prompt']),
  ref: idSchema,
});
export type LikedItem = z.infer<typeof likedItemSchema>;

export const swipeSchema = z
  .object({
    target: publicUidSchema,
    action: swipeActionSchema,
    item: likedItemSchema.optional(),
    comment: z
      .string()
      .trim()
      .min(1)
      .max(LIKE_COMMENT_MAX)
      .refine((text) => !CONTROL_CHARACTERS.test(text), { message: 'a comment holds no control characters' })
      .optional(),
  })
  .refine((swipe) => swipe.action !== 'pass' || (swipe.item === undefined && swipe.comment === undefined), {
    message: 'a pass carries no item and no comment',
    path: ['action'],
  });
export type Swipe = z.infer<typeof swipeSchema>;

export const swipesRequestSchema = z.object({
  swipes: z.array(swipeSchema).min(1).max(SWIPES_PER_REQUEST),
});
export type SwipesRequest = z.infer<typeof swipesRequestSchema>;

/**
 * What became of one swipe: `liked`, `matched` (with the new conversation),
 * `passed`, `duplicate` (that like was already pending), `skipped` (the
 * person can no longer be swiped: gone, hidden, already matched or the
 * same person twice in one request) or `quota` (no likes or super likes
 * left; `quotas` says when they come back).
 */
export const swipeOutcomeSchema = z.enum(['liked', 'matched', 'passed', 'duplicate', 'skipped', 'quota']);
export type SwipeOutcome = z.infer<typeof swipeOutcomeSchema>;

export const swipeResultSchema = z.object({
  target: publicUidSchema,
  result: swipeOutcomeSchema,
  conversation: conversationSchema.optional(),
});
export type SwipeResult = z.infer<typeof swipeResultSchema>;

export const swipesResponseSchema = z.object({
  results: z.array(swipeResultSchema),
  quotas: entitlementsSchema.shape.quotas,
});
export type SwipesResponse = z.infer<typeof swipesResponseSchema>;

export const likesQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/**
 * Someone who liked the account. On the free plan only `blurhash` is set,
 * except for super likes and the day's one open like; with see-likes, the
 * card, the liked item and the comment.
 */
export const likeItemSchema = z.object({
  liker: profileCardSchema.optional(),
  blurhash: z.string().max(64).optional(),
  kind: likeKindSchema,
  item: likedItemSchema.optional(),
  comment: z.string().optional(),
});
export type LikeItem = z.infer<typeof likeItemSchema>;

export const likesPageSchema = z.object({
  total: z.number().int().nonnegative(),
  /** A bucket is at its cap: show `total` as "N+". */
  totalPlus: z.literal(true).optional(),
  items: z.array(likeItemSchema),
  nextCursor: cursorSchema.nullable(),
});
export type LikesPage = z.infer<typeof likesPageSchema>;

export const profileParamsSchema = z.object({ publicUid: z.string().min(1).max(40) });

export const conversationsQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const conversationsPageSchema = z.object({
  /** Newest activity first. */
  items: z.array(conversationSchema),
  nextCursor: cursorSchema.nullable(),
});
export type ConversationsPage = z.infer<typeof conversationsPageSchema>;

export const conversationParamsSchema = z.object({ id: idSchema });
