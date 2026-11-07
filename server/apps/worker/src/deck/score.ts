import type { DeckWeights } from './settings.js';

/**
 * The soft part of the deck (docs/10, stage 2): every candidate that passed
 * the hard rules gets a score from the panel's weights, then the list is
 * re-ordered so that a few very similar people do not come one after the
 * other. Pure functions, unit-tested.
 *
 *   score = w_dist · proximity + w_active · recency + w_comp · completeness
 *         + w_recip · P(they like the viewer) + w_pref · soft match
 *         + w_new · newcomer + w_verif · verified + w_boost · boosted
 *         − w_load · inbound load + w_shuffle · u
 *
 * Each part is in [0, 1]:
 * - proximity: 1 at the viewer's cell, 0 at the radius (whole country: halves
 *   every 50 km);
 * - recency: 1 active today, 1/2 two days ago, 1/(1 + days/2);
 * - completeness: the profile's completeness / 100;
 * - P(they like the viewer): 1 for someone who already liked the viewer
 *   (likers come earlier, the "liked you" lift); otherwise phase 1's
 *   estimate, the similarity of the two (shared intentions and field
 *   answers) times 0.5. How often a person likes others is not tracked yet;
 * - soft match: the Jaccard similarity of the two people's field answers
 *   (`discovery.attrs`);
 * - newcomer: the account is less than 7 days old (ids carry their time);
 * - verified: the photo-verified badge;
 * - boosted: a boost is running;
 * - inbound load: unanswered likes waiting for the candidate,
 *   log10(1 + n) / 3 capped at 1 (1,000 pending likes → 1), so attention
 *   spreads instead of piling on a few popular people;
 * - u: uniform in [0, 1) from the viewer's seeded hash of the candidate
 *   (added by the refill), so viewers with the same search see different
 *   people first.
 */

export interface ScoreInput {
  userId: string;
  /** km between cell centres, null when unknown. */
  distanceKm: number | null;
  /** Whole days since the candidate was last active (0 = today). */
  idleDays: number;
  completeness: number;
  verified: boolean;
  newcomer: boolean;
  liker: boolean;
  boosted: boolean;
  /** Unanswered likes waiting for the candidate. */
  pendingLikes: number;
  /** The candidate's field answers (`slot * 256 + option`). */
  attrs: readonly number[];
  /** The candidate's intentions mask. */
  intents: number;
  /** Five-year age band, for the diversity pass. */
  ageBand: number;
  cityId: number | null;
}

export interface ScoreContext {
  weights: DeckWeights;
  /** The radius in km; null for the whole country. */
  radiusKm: number | null;
  /** The viewer's own field answers and intentions (similarity). */
  viewerAttrs: readonly number[];
  viewerIntents: number;
}

export function jaccard(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const set = new Set(a);
  let shared = 0;
  for (const x of new Set(b)) if (set.has(x)) shared += 1;
  return shared / (set.size + new Set(b).size - shared);
}

function bits(mask: number): number {
  let n = 0;
  for (let m = mask; m > 0; m >>= 1) n += m & 1;
  return n;
}

/** Overlap of two intention masks (0 when either is unset). */
export function intentOverlap(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return bits(a & b) / bits(a | b);
}

export function proximity(distanceKm: number | null, radiusKm: number | null): number {
  if (distanceKm === null) return 0;
  if (radiusKm === null) return 1 / (1 + distanceKm / 50);
  return Math.max(0, 1 - distanceKm / radiusKm);
}

export function recency(idleDays: number): number {
  return 1 / (1 + Math.max(0, idleDays) / 2);
}

export function inboundLoad(pendingLikes: number): number {
  return Math.min(1, Math.log10(1 + Math.max(0, pendingLikes)) / 3);
}

export function scoreOf(c: ScoreInput, ctx: ScoreContext): number {
  const w = ctx.weights;
  const pref = jaccard(ctx.viewerAttrs, c.attrs);
  const similarity = (pref + intentOverlap(ctx.viewerIntents, c.intents)) / 2;
  const recip = c.liker ? 1 : 0.5 * similarity;
  return (
    w.dist * proximity(c.distanceKm, ctx.radiusKm) +
    w.active * recency(c.idleDays) +
    w.comp * Math.min(1, Math.max(0, c.completeness / 100)) +
    w.recip * recip +
    w.pref * pref +
    w.new * (c.newcomer ? 1 : 0) +
    w.verif * (c.verified ? 1 : 0) +
    w.boost * (c.boosted ? 1 : 0) -
    w.load * inboundLoad(c.pendingLikes)
  );
}

/** How alike two candidates look on a card: age band, city, field answers (0-1). */
export function likeness(a: ScoreInput, b: ScoreInput): number {
  return (a.ageBand === b.ageBand ? 0.4 : 0) + (a.cityId !== null && a.cityId === b.cityId ? 0.3 : 0) + 0.3 * jaccard(a.attrs, b.attrs);
}

/** Candidates considered at each step of the diversity pass. */
export const DIVERSITY_WINDOW = 25;
/** Penalty for being alike the last pick, and the one before it (in score units). */
export const DIVERSITY_PENALTY: readonly [number, number] = [0.6, 0.3];

/**
 * Orders scored candidates best first, avoiding runs of very similar people:
 * at each step the best of the next {@link DIVERSITY_WINDOW} by score, minus
 * a penalty for looking like the last two picks, is taken. Ties keep the
 * input order (the database's per-viewer shuffle), so the result is stable.
 */
export function diversify<T extends ScoreInput>(scored: readonly { input: T; score: number }[]): T[] {
  const remaining = [...scored].map((s, index) => ({ ...s, index })).sort((a, b) => b.score - a.score || a.index - b.index);
  const out: T[] = [];
  while (remaining.length > 0) {
    const last = out[out.length - 1];
    const before = out[out.length - 2];
    let best = 0;
    let bestValue = -Infinity;
    const window = Math.min(DIVERSITY_WINDOW, remaining.length);
    for (let i = 0; i < window; i += 1) {
      const candidate = remaining[i]!;
      let value = candidate.score;
      if (last) value -= DIVERSITY_PENALTY[0] * likeness(candidate.input, last);
      if (before) value -= DIVERSITY_PENALTY[1] * likeness(candidate.input, before);
      if (value > bestValue) {
        bestValue = value;
        best = i;
      }
    }
    out.push(remaining.splice(best, 1)[0]!.input);
  }
  return out;
}
