import { z } from 'zod';
import { profileCardSchema } from './common.js';

/** `GET /v1/deck`: the head of the prepared deck. */

export const DECK_PAGE_MAX = 30;

export const deckQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(DECK_PAGE_MAX).default(10),
});

/** What the app can offer when nobody is left: a wider distance, a wider age range, a boost. */
export const deckSuggestionSchema = z.enum(['widen_distance', 'widen_age', 'boost']);
export type DeckSuggestion = z.infer<typeof deckSuggestionSchema>;

/**
 * The next cards, best first. The head is not taken away by reading it: a
 * swipe removes its card, so a second read returns the cards not swiped yet
 * (the app drops repeats). `remaining` counts the queued cards after these.
 * An empty page with `exhausted: false` means a refill is under way (ask
 * again shortly); `exhausted: true` that nobody new matches the
 * preferences now, with what could change that.
 */
export const deckPageSchema = z.object({
  cards: z.array(profileCardSchema),
  remaining: z.number().int().nonnegative(),
  exhausted: z.boolean(),
  suggestions: z.array(deckSuggestionSchema).optional(),
});
export type DeckPage = z.infer<typeof deckPageSchema>;
