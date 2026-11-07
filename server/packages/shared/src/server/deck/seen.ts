import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { KeyBuilder } from '../kv/keys.js';
import { luaScript, runScript } from '../kv/scripts.js';

/**
 * Seen filters: the people a person passed or liked, so the deck does not
 * offer them again for a while. Never in PostgreSQL; a scalable Bloom
 * filter per person and 15-day period `p = floor(unix_day / 15)` in
 * kv-cache (evicting: a lost filter only lets some swiped people come back).
 *
 * - Tier 0 is 2^11 bits (256 B, ~210 entries); the period's counter
 *   (`seen:<uid>:<p>:n`) moves new entries to tier 1 (`:x`, 2^14 bits,
 *   ~1,700) and then tier 2 (`:y`, 2^17 bits, ~13,600). Past tier 2 the
 *   period is full: nothing more is added and {@link SeenAddResult.full}
 *   tells the swipe route (bot-like volume).
 * - k = 7 positions per entry by double hashing one 128-bit hash of the id
 *   (~1% false positives per tier at its capacity). A false positive only
 *   hides a candidate from one deck.
 * - "Passed people come back after X days" (`deck.pass_return_days`):
 *   `ceil(X / 15) + 1` periods are checked and kept, so a swipe stays hidden
 *   for X to X + 15 days.
 * - Adding is one script call for a whole batch of swipes. Checking reads
 *   the live bitmaps whole (at most 3 periods × 18 KB, usually a few
 *   hundred bytes) in one round trip and tests the bits here, so checking
 *   600 candidates costs one MGET instead of 600 × 21 bit reads.
 */

export const SEEN_PERIOD_DAYS = 15;
export const SEEN_HASHES = 7;

export interface SeenTier {
  /** Bits in the tier's bitmap (a power of two). */
  bits: number;
  /** Entries the tier takes before the next one starts (~1% false positives at k = 7). */
  capacity: number;
}

export const SEEN_TIERS: readonly [SeenTier, SeenTier, SeenTier] = [
  { bits: 1 << 11, capacity: 210 },
  { bits: 1 << 14, capacity: 1_700 },
  { bits: 1 << 17, capacity: 13_600 },
];

/** Entries a period holds before it is full. */
export const SEEN_PERIOD_CAPACITY = SEEN_TIERS.reduce((sum, tier) => sum + tier.capacity, 0);

const DAY_MS = 86_400_000;

/** The 15-day period of a time. */
export function seenPeriod(time: Date | number): number {
  const ms = typeof time === 'number' ? time : time.getTime();
  return Math.floor(Math.floor(ms / DAY_MS) / SEEN_PERIOD_DAYS);
}

/** Periods checked and kept for a pass-return setting of `returnDays`. */
export function seenPeriodsKept(returnDays: number): number {
  if (!Number.isInteger(returnDays) || returnDays < 1) throw new RangeError('returnDays must be a positive integer');
  return Math.ceil(returnDays / SEEN_PERIOD_DAYS) + 1;
}

/** The live periods at `time`, newest first. */
export function seenPeriods(time: Date | number, returnDays: number): number[] {
  const p = seenPeriod(time);
  return Array.from({ length: seenPeriodsKept(returnDays) }, (_, i) => p - i);
}

/** Lifetime of a period's keys: long enough to be checked in every period that may still read it. */
export function seenTtlSeconds(returnDays: number): number {
  return seenPeriodsKept(returnDays) * SEEN_PERIOD_DAYS * 86_400;
}

interface SeenHash {
  a: number;
  b: number;
}

function seenHash(id: string | bigint): SeenHash {
  const digest = createHash('sha256').update(`seen:${String(id)}`).digest();
  // Odd step: with a power-of-two size the k positions are all different.
  return { a: digest.readUInt32BE(0), b: digest.readUInt32BE(4) | 1 };
}

function positionsOf({ a, b }: SeenHash, bits: number): number[] {
  const mask = bits - 1;
  const positions: number[] = [];
  for (let i = 0; i < SEEN_HASHES; i += 1) positions.push(((a + Math.imul(i, b)) >>> 0) & mask);
  return positions;
}

/** The k bit positions of an id in a bitmap of `bits` bits (a power of two). */
export function seenPositions(id: string | bigint, bits: number): number[] {
  return positionsOf(seenHash(id), bits);
}

const addScript = luaScript(new URL('./seenAdd.lua', import.meta.url), 'seen-add', 4);

export interface SeenAddResult {
  /** Entries newly added (an id already in the filter is not added again). */
  added: number;
  /** Entries in the current period after the call. */
  count: number;
  /** The period is at its capacity: nothing more is added until the next one. */
  full: boolean;
}

/**
 * Adds the people `userId` just passed or liked to the current period's
 * filter (raw user ids). One round trip for the batch. `cache` is kv-cache.
 */
export async function addSeen(
  cache: Redis,
  keys: KeyBuilder,
  userId: string,
  targetIds: readonly string[],
  options: { returnDays: number; now?: number | undefined },
): Promise<SeenAddResult> {
  const unique = [...new Set(targetIds)];
  const p = seenPeriod(options.now ?? Date.now());
  const tierKeys = [keys.seen(userId, p, 0), keys.seen(userId, p, 1), keys.seen(userId, p, 2)];
  const args: (string | number)[] = [
    seenTtlSeconds(options.returnDays),
    SEEN_TIERS[0].capacity,
    SEEN_TIERS[1].capacity,
    SEEN_TIERS[2].capacity,
    SEEN_HASHES,
    unique.length,
  ];
  for (const id of unique) {
    const hash = seenHash(id);
    for (const tier of SEEN_TIERS) args.push(...positionsOf(hash, tier.bits));
  }
  const reply = await runScript(cache, addScript, [...tierKeys, keys.seenCount(userId, p)], args);
  if (!Array.isArray(reply) || reply.length !== 2) throw new TypeError('seen-add returned an unexpected reply');
  const count = Number(reply[1]);
  return { added: Number(reply[0]), count, full: count >= SEEN_PERIOD_CAPACITY };
}

function bitSet(bitmap: Buffer, position: number): boolean {
  const byte = position >> 3;
  if (byte >= bitmap.length) return false;
  // Redis numbers bits from the most significant bit of the first byte.
  return ((bitmap[byte]! >> (7 - (position & 7))) & 1) === 1;
}

/** The live bitmaps of a person's seen filter, read in one round trip. */
export class SeenFilter {
  private constructor(private readonly bitmaps: readonly { bitmap: Buffer; tier: SeenTier }[]) {}

  static async load(
    cache: Redis,
    keys: KeyBuilder,
    userId: string,
    options: { returnDays: number; now?: number | undefined },
  ): Promise<SeenFilter> {
    const names: string[] = [];
    const tiers: SeenTier[] = [];
    for (const p of seenPeriods(options.now ?? Date.now(), options.returnDays)) {
      SEEN_TIERS.forEach((tier, index) => {
        names.push(keys.seen(userId, p, index as 0 | 1 | 2));
        tiers.push(tier);
      });
    }
    const values = await cache.mgetBuffer(...names);
    const bitmaps: { bitmap: Buffer; tier: SeenTier }[] = [];
    values.forEach((value, index) => {
      if (value && value.length > 0) bitmaps.push({ bitmap: value, tier: tiers[index]! });
    });
    return new SeenFilter(bitmaps);
  }

  /** An empty filter (Valkey unreadable: nothing is hidden by it). */
  static empty(): SeenFilter {
    return new SeenFilter([]);
  }

  /** Live bitmaps read (for tests and logs). */
  get size(): number {
    return this.bitmaps.length;
  }

  /** Whether `id` was (probably) swiped in a live period. */
  has(id: string | bigint): boolean {
    if (this.bitmaps.length === 0) return false;
    const hash = seenHash(id);
    for (const { bitmap, tier } of this.bitmaps) {
      if (positionsOf(hash, tier.bits).every((position) => bitSet(bitmap, position))) return true;
    }
    return false;
  }
}
