import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { KeyBuilder } from '../kv/keys.js';
import { luaScript, runScript } from '../kv/scripts.js';

/**
 * The prepared deck of a person, in kv-cache:
 *
 * - `deck:<uid>`: a list of user ids, best first (≤ `deck.refill.queue_size`).
 *   `GET /v1/deck` reads its head without taking anything; a swipe removes
 *   its target with one `LREM deck:<uid> 0 <target>`.
 * - `deckm:<uid>`: a hash id → `"<ver>:<km>:<flags>"` (the card version, the
 *   rounded distance between cell centres with one decimal, empty when the
 *   viewer searches the whole country, and {@link DeckFlag} bits), plus
 *   three fields of the queue itself: `@at` (when the queue was last built,
 *   ms: people in `vis:out` since then are skipped), `@x` (when a refill
 *   last found nobody new, ms) and `@c` (the candidate cursor the next
 *   refill continues from).
 * - `deck:lock:<uid>`: the refill guard (NX, 30 s).
 *
 * Both keys live 3 hours from the last refill; a change of preferences
 * deletes them, so the next request asks for a fresh queue.
 */

export const DECK_TTL_SECONDS = 3 * 3_600;
export const DECK_LOCK_MS = 30_000;

/** Bits of a deck entry. */
export const DeckFlag = {
  /** Show "likes you" (the viewer may see who liked them, or it was a super like). */
  likesYou: 1,
  /** A super like. */
  superliked: 2,
  /** Active in the last day (shown only when the card's owner shows activity). */
  activeRecently: 4,
  /** Boosted when the queue was built. */
  boosted: 8,
} as const;

export interface DeckEntry {
  userId: string;
  /** The card version the entry was built with. */
  version: number;
  /** Distance between cell centres in km (one decimal), null when not shown (whole country). */
  km: number | null;
  flags: number;
}

const META = /^([1-9][0-9]{0,9}):([0-9]{1,5}(?:\.[0-9])?)?:([0-9]{1,3})$/;
const UID = /^[1-9][0-9]{0,18}$/;

export function encodeDeckMeta(entry: Omit<DeckEntry, 'userId'>): string {
  const km = entry.km === null ? '' : String(Math.round(entry.km * 10) / 10);
  return `${entry.version}:${km}:${entry.flags}`;
}

export function decodeDeckMeta(userId: string, meta: string): DeckEntry | null {
  const m = META.exec(meta);
  if (!m || !UID.test(userId)) return null;
  return { userId, version: Number(m[1]), km: m[2] === undefined ? null : Number(m[2]), flags: Number(m[3]) };
}

export interface DeckHead {
  /** Ids in the queue. */
  length: number;
  /** When the queue was last built (ms), null when there is none. */
  builtAt: number | null;
  /** When a refill last found nobody new (ms), null when none did. */
  exhaustedAt: number | null;
  /** The candidate cursor for the next refill. */
  cursor: string | null;
  /** The head, best first; ids whose metadata is missing or damaged are left out. */
  entries: DeckEntry[];
  /** Head ids without usable metadata (dropped from the queue by the reader). */
  broken: string[];
}

const headScript = luaScript(new URL('./deckHead.lua', import.meta.url), 'deck-head', 2);
const unlockScript = luaScript(new URL('./deckUnlock.lua', import.meta.url), 'deck-unlock', 1);

function msOrNull(value: unknown): number | null {
  const n = Number(value);
  return typeof value === 'string' && value !== '' && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The first `count` entries of a person's deck and the queue's own fields, in one round trip. */
export async function readDeckHead(cache: Redis, keys: KeyBuilder, userId: string, count: number): Promise<DeckHead> {
  const reply = await runScript(cache, headScript, [keys.deckQueue(userId), keys.deckMeta(userId)], [Math.max(1, count)]);
  if (!Array.isArray(reply) || reply.length < 4) throw new TypeError('deck-head returned an unexpected reply');
  const entries: DeckEntry[] = [];
  const broken: string[] = [];
  for (let i = 4; i + 1 < reply.length; i += 2) {
    const id = String(reply[i]);
    const entry = decodeDeckMeta(id, String(reply[i + 1]));
    if (entry) entries.push(entry);
    else broken.push(id);
  }
  return {
    length: Number(reply[0]),
    builtAt: msOrNull(reply[1]),
    exhaustedAt: msOrNull(reply[2]),
    cursor: typeof reply[3] === 'string' && reply[3] !== '' ? reply[3] : null,
    entries,
    broken,
  };
}

/** The whole queue (the refill keeps what is still there and appends). */
export async function readDeck(cache: Redis, keys: KeyBuilder, userId: string): Promise<{ ids: string[]; meta: Map<string, DeckEntry>; cursor: string | null }> {
  const [ids, fields] = await Promise.all([cache.lrange(keys.deckQueue(userId), 0, -1), cache.hgetall(keys.deckMeta(userId))]);
  const meta = new Map<string, DeckEntry>();
  for (const [field, value] of Object.entries(fields)) {
    if (field.startsWith('@')) continue;
    const entry = decodeDeckMeta(field, value);
    if (entry) meta.set(field, entry);
  }
  const cursor = fields['@c'];
  return { ids, meta, cursor: cursor !== undefined && cursor !== '' ? cursor : null };
}

export interface DeckWrite {
  /** Entries still queued that stay (their metadata is rewritten as given). */
  kept: readonly DeckEntry[];
  /** New entries for the front (super likes), in order. */
  front: readonly DeckEntry[];
  /** New entries for the end, in order. */
  back: readonly DeckEntry[];
  /** Queued ids that no longer qualify: taken out. */
  drop?: readonly string[] | undefined;
  builtAt: number;
  /** The candidate cursor the next refill continues from (null: start over). */
  cursor: string | null;
  /** Set when this refill found nobody new. */
  exhaustedAt: number | null;
}

/**
 * Writes a refill in one transaction: the metadata hash is rebuilt (kept and
 * new entries, the queue's fields), ids that no longer qualify are taken
 * out, the new ids are pushed, and both keys live another 3 hours. Ids a swipe removed meanwhile stay removed: only new
 * ids are pushed.
 */
export async function writeDeck(cache: Redis, keys: KeyBuilder, userId: string, write: DeckWrite): Promise<void> {
  const queue = keys.deckQueue(userId);
  const metaKey = keys.deckMeta(userId);
  const fields: Record<string, string> = { '@at': String(write.builtAt) };
  if (write.cursor !== null) fields['@c'] = write.cursor;
  if (write.exhaustedAt !== null) fields['@x'] = String(write.exhaustedAt);
  for (const entry of [...write.kept, ...write.front, ...write.back]) fields[entry.userId] = encodeDeckMeta(entry);
  const tx = cache.multi().del(metaKey).hset(metaKey, fields);
  for (const id of new Set(write.drop ?? [])) tx.lrem(queue, 0, id);
  if (write.back.length > 0) tx.rpush(queue, ...write.back.map((e) => e.userId));
  // LPUSH reverses: push the last first so the first ends up on top.
  if (write.front.length > 0) tx.lpush(queue, ...[...write.front].reverse().map((e) => e.userId));
  tx.expire(queue, DECK_TTL_SECONDS).expire(metaKey, DECK_TTL_SECONDS);
  const replies = await tx.exec();
  const failed = replies?.find(([error]) => error !== null)?.[0];
  if (!replies || failed) throw failed ?? new Error('deck write aborted');
}

/** Drops ids from a queue (people who left since it was built). */
export async function dropFromDeck(cache: Redis, keys: KeyBuilder, userId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const pipeline = cache.pipeline();
  for (const id of ids) pipeline.lrem(keys.deckQueue(userId), 0, id);
  pipeline.hdel(keys.deckMeta(userId), ...ids);
  await pipeline.exec();
}

/**
 * Rewrites the metadata of entries still queued (a card met at a newer
 * version than the queue knew: the next read asks for that one).
 */
export async function updateDeckEntries(cache: Redis, keys: KeyBuilder, userId: string, entries: readonly DeckEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const fields: Record<string, string> = {};
  for (const entry of entries) fields[entry.userId] = encodeDeckMeta(entry);
  await cache.hset(keys.deckMeta(userId), fields);
}

/** How long `vis:out` remembers a hide: the life of a queue, after which every queue was built since. */
export const HIDDEN_WINDOW_MS = DECK_TTL_SECONDS * 1_000;

/**
 * Puts people in `vis:out` (kv-core) after a change that hides them from
 * every deck (a ban, a snooze, a deletion, a shadowban), so queues built
 * before skip them; the set is trimmed in the same transaction, so it holds
 * only the last 3 hours and needs no job of its own.
 */
export async function markHiddenFromDecks(redis: Redis, keys: KeyBuilder, userIds: readonly string[], now: number = Date.now()): Promise<void> {
  if (userIds.length === 0) return;
  const tx = redis.multi();
  tx.zadd(keys.accountsHidden(), ...userIds.flatMap((id) => [now, id]));
  tx.zremrangebyscore(keys.accountsHidden(), '-inf', now - HIDDEN_WINDOW_MS);
  const replies = await tx.exec();
  const failed = replies?.find(([error]) => error !== null)?.[0];
  if (!replies || failed) throw failed ?? new Error('vis:out write aborted');
}

/** Takes the refill guard; the token releases it ({@link releaseDeckLock}), else it expires after 30 s. */
export async function takeDeckLock(cache: Redis, keys: KeyBuilder, userId: string): Promise<string | null> {
  const token = randomBytes(9).toString('base64url');
  return (await cache.set(keys.deckLock(userId), token, 'PX', DECK_LOCK_MS, 'NX')) === 'OK' ? token : null;
}

export async function releaseDeckLock(cache: Redis, keys: KeyBuilder, userId: string, token: string): Promise<void> {
  await runScript(cache, unlockScript, [keys.deckLock(userId)], [token]);
}
