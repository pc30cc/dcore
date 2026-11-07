import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { KeyBuilder } from '../kv/keys.js';

/**
 * Profile cards in kv-cache: `card:<uid>:<ver>:<catv>` holds the result of
 * `profile_card(uid)` (deflated JSON), named by the profile's version and
 * the field catalogue's (`cfg:catv`), so an edit or a catalogue change
 * never needs a purge: the old key is simply not read again and expires.
 *
 * The stored card is the database's form (codes, internal `hd`/`so`); the
 * API turns it into a viewer's `ProfileCard` (public id, distance, signed
 * photo links, city names) and never sends `hd` or `so`.
 *
 * Builds are batched: the deck worker builds every missing card of a refill
 * in one statement, and a request that meets a missing card builds the
 * page's misses in one statement too ({@link loadCards}).
 */

export const CARD_TTL_SECONDS = 24 * 3_600;

const id = z.string().regex(/^[1-9][0-9]{0,18}$/);

/** `profile_card()`'s JSON (migration 0013): ids as text, codes as numbers. */
export const cardSourceSchema = z.object({
  v: z.number().int().positive(),
  name: z.string(),
  age: z.number().int().optional(),
  gender: z.number().int(),
  verified: z.boolean(),
  intention: z.number().int().optional(),
  job: z.string().optional(),
  about: z.string().optional(),
  city: z.number().int().optional(),
  traveling: z.literal(true).optional(),
  /** Hide distance: no distance on this card. */
  hd: z.boolean().optional(),
  /** Show online: presence and "active recently" only when true. */
  so: z.boolean().optional(),
  photos: z.array(z.object({ id, w: z.number().int().optional(), h: z.number().int().optional(), bh: z.string().optional(), bv: z.number().int() })),
  prompts: z.array(z.object({ p: z.number().int(), a: z.string().optional(), ms: z.number().int().optional() })),
  fields: z.array(
    z.object({
      f: z.number().int(),
      o: z.number().int().optional(),
      os: z.array(z.number().int()).optional(),
      n: z.number().int().optional(),
      t: z.string().optional(),
    }),
  ),
});
export type CardSource = z.infer<typeof cardSourceSchema>;

export function encodeCard(card: CardSource): Buffer {
  return deflateRawSync(Buffer.from(JSON.stringify(card), 'utf8'));
}

/** The stored card, or null when the value is not one (an older layout, a damaged value). */
export function decodeCard(value: Buffer): CardSource | null {
  try {
    const parsed = cardSourceSchema.safeParse(JSON.parse(inflateRawSync(value).toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A card wanted at a known version. */
export interface CardRef {
  userId: string;
  version: number;
}

/**
 * Builds cards from the database: one statement for the whole batch
 * (`SELECT id, profile_card(id) FROM unnest($ids)`). People without a card
 * (gone, not active or snoozed) are absent from the result.
 */
export type CardBuilder = (userIds: readonly string[]) => Promise<ReadonlyMap<string, unknown>>;

export interface LoadedCards {
  /** The cards found or built, by user id. A built card may be newer than the version asked for. */
  cards: Map<string, CardSource>;
  /** Cards that had to be built (0 when every card was cached: no statement). */
  built: number;
  /** People asked for that have no card (they left the pool). */
  missing: string[];
}

/** Reads cards at their versions in one MGET; null where a card is not cached. */
export async function readCards(cache: Redis, keys: KeyBuilder, refs: readonly CardRef[], catalogue: string): Promise<(CardSource | null)[]> {
  if (refs.length === 0) return [];
  const values = await cache.mgetBuffer(...refs.map((ref) => keys.card(ref.userId, ref.version, catalogue)));
  return values.map((value) => (value ? decodeCard(value) : null));
}

/** Stores cards under their own versions (24 h). */
export async function storeCards(cache: Redis, keys: KeyBuilder, cards: ReadonlyMap<string, CardSource>, catalogue: string): Promise<void> {
  if (cards.size === 0) return;
  const pipeline = cache.pipeline();
  for (const [userId, card] of cards) pipeline.set(keys.card(userId, card.v, catalogue), encodeCard(card), 'EX', CARD_TTL_SECONDS);
  const replies = await pipeline.exec();
  const failed = replies?.find(([error]) => error !== null)?.[0];
  if (failed) throw failed;
}

/**
 * The cards of `refs`: cached ones from one MGET, the rest built in one
 * statement and stored. A store failure is not fatal (the cards are still
 * returned; the next read builds them again).
 */
export async function loadCards(
  cache: Redis,
  keys: KeyBuilder,
  refs: readonly CardRef[],
  catalogue: string,
  build: CardBuilder,
  onStoreError?: (error: unknown) => void,
): Promise<LoadedCards> {
  const cards = new Map<string, CardSource>();
  const cached = await readCards(cache, keys, refs, catalogue);
  const misses: string[] = [];
  refs.forEach((ref, index) => {
    const card = cached[index];
    if (card) cards.set(ref.userId, card);
    else misses.push(ref.userId);
  });
  const missing: string[] = [];
  if (misses.length > 0) {
    const unique = [...new Set(misses)];
    const rows = await build(unique);
    const fresh = new Map<string, CardSource>();
    for (const userId of unique) {
      const parsed = cardSourceSchema.safeParse(rows.get(userId));
      if (parsed.success) fresh.set(userId, parsed.data);
      else missing.push(userId);
    }
    for (const [userId, card] of fresh) cards.set(userId, card);
    await storeCards(cache, keys, fresh, catalogue).catch((error: unknown) => onStoreError?.(error));
    return { cards, built: unique.length, missing };
  }
  return { cards, built: 0, missing };
}
