import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CARD_TTL_SECONDS,
  DECK_TTL_SECONDS,
  DeckFlag,
  SEEN_PERIOD_CAPACITY,
  SEEN_TIERS,
  SeenFilter,
  addSeen,
  createKeys,
  decodeCard,
  decodeDeckMeta,
  HIDDEN_WINDOW_MS,
  dropFromDeck,
  encodeCard,
  encodeDeckMeta,
  likeWeek,
  likeWeeks,
  loadCards,
  markHiddenFromDecks,
  readDeck,
  readDeckHead,
  releaseDeckLock,
  seenPeriod,
  seenPeriods,
  seenPeriodsKept,
  seenPositions,
  seenTtlSeconds,
  takeDeckLock,
  updateDeckEntries,
  writeDeck,
  type CardSource,
  type DeckEntry,
} from '../../src/server/index.js';
import { dropPrefix, hasRedis, testPrefix, testRedis } from './support.js';

const DAY = 86_400_000;

function card(v: number, name = 'Ana'): CardSource {
  return { v, name, gender: 1, verified: false, photos: [{ id: '1287390234923420001', w: 10, h: 12, bh: 'L00000', bv: 1 }], prompts: [], fields: [] };
}

describe('seen filter arithmetic', () => {
  it('uses 15-day periods and keeps ceil(X / 15) + 1 of them, so a swipe stays hidden X to X + 15 days', () => {
    expect(seenPeriod(Date.UTC(1970, 0, 16))).toBe(1);
    expect(seenPeriod(Date.UTC(1970, 0, 16) - 1)).toBe(0);
    expect(seenPeriodsKept(30)).toBe(3);
    expect(seenPeriodsKept(31)).toBe(4);
    expect(seenTtlSeconds(30)).toBe(45 * 86_400);
    const now = Date.UTC(2026, 10, 7);
    const periods = seenPeriods(now, 30);
    expect(periods).toEqual([seenPeriod(now), seenPeriod(now) - 1, seenPeriod(now) - 2]);
  });

  it('gives k different positions inside each tier, the same ones every time', () => {
    for (const tier of SEEN_TIERS) {
      const a = seenPositions('1287390234923420001', tier.bits);
      expect(a).toHaveLength(7);
      expect(new Set(a).size).toBe(7);
      expect(a.every((p) => p >= 0 && p < tier.bits)).toBe(true);
      expect(seenPositions('1287390234923420001', tier.bits)).toEqual(a);
    }
    expect(seenPositions('1', 2048)).not.toEqual(seenPositions('2', 2048));
  });

  it('numbers like weeks consecutively from Monday', () => {
    const monday = Date.UTC(2026, 10, 2);
    expect(likeWeek(monday)).toBe(likeWeek(monday + 7 * DAY - 1));
    expect(likeWeek(monday + 7 * DAY)).toBe(likeWeek(monday) + 1);
    expect(likeWeek(monday - 1)).toBe(likeWeek(monday) - 1);
    expect(likeWeeks(monday)).toEqual([0, 1, 2, 3, 4].map((i) => likeWeek(monday) - 4 + i));
  });
});

describe('deck metadata and card encoding', () => {
  it('round-trips an entry and refuses damaged ones', () => {
    const entry: Omit<DeckEntry, 'userId'> = { version: 7, km: 1.44, flags: DeckFlag.likesYou | DeckFlag.superliked };
    expect(encodeDeckMeta(entry)).toBe('7:1.4:3');
    expect(decodeDeckMeta('42', '7:1.4:3')).toEqual({ userId: '42', version: 7, km: 1.4, flags: 3 });
    expect(decodeDeckMeta('42', encodeDeckMeta({ version: 3, km: null, flags: 0 }))).toEqual({ userId: '42', version: 3, km: null, flags: 0 });
    for (const bad of ['', '7', '7:x:1', '0:1:1', '7:1:1:1']) expect(decodeDeckMeta('42', bad), bad).toBeNull();
    expect(decodeDeckMeta('0', '7:1:0')).toBeNull();
  });

  it('round-trips a card and refuses what is not one', () => {
    const value = card(3);
    expect(decodeCard(encodeCard(value))).toEqual(value);
    expect(decodeCard(Buffer.from('nope'))).toBeNull();
  });
});

describe.skipIf(!hasRedis)('deck state in Valkey (prefixed keys)', () => {
  let redis: Redis;
  const prefix = testPrefix();
  const keys = createKeys(prefix);

  beforeAll(() => {
    redis = testRedis();
  });
  afterAll(async () => {
    await dropPrefix(redis, prefix);
    await redis.quit();
  });

  it('adds swipes once, finds them again, and nobody else (false positives about 1%)', async () => {
    const now = Date.UTC(2026, 10, 7, 12);
    const swiped = Array.from({ length: 150 }, (_, i) => String(1_000_000 + i));
    const first = await addSeen(redis, keys, '9001', swiped.slice(0, 100), { returnDays: 30, now });
    expect(first).toEqual({ added: 100, count: 100, full: false });
    const again = await addSeen(redis, keys, '9001', [...swiped.slice(90, 150), '1000000'], { returnDays: 30, now });
    // 50 are new; a Bloom filter may take a new one for a known one now and then (it then reads as seen anyway).
    expect(again.added).toBeGreaterThanOrEqual(47);
    expect(again.added).toBeLessThanOrEqual(50);
    expect(again).toEqual({ added: again.added, count: 100 + again.added, full: false });
    const ttl = await redis.ttl(keys.seen('9001', seenPeriod(now), 0));
    expect(ttl).toBeGreaterThan(44 * 86_400);
    expect(ttl).toBeLessThanOrEqual(45 * 86_400);

    const filter = await SeenFilter.load(redis, keys, '9001', { returnDays: 30, now });
    expect(filter.size).toBe(1);
    expect(swiped.every((id) => filter.has(id))).toBe(true);
    const strangers = Array.from({ length: 2_000 }, (_, i) => String(5_000_000 + i));
    const falsePositives = strangers.filter((id) => filter.has(id)).length;
    expect(falsePositives).toBeLessThan(60);
    // Another person's filter is their own.
    expect((await SeenFilter.load(redis, keys, '9002', { returnDays: 30, now })).has(swiped[0]!)).toBe(false);
  });

  it('moves to the larger tiers as the period fills, and stops at the period capacity', async () => {
    const now = Date.UTC(2026, 10, 7, 12);
    const ids = Array.from({ length: SEEN_TIERS[0].capacity + 40 }, (_, i) => String(2_000_000 + i));
    const result = await addSeen(redis, keys, '9100', ids, { returnDays: 30, now });
    expect(result.added).toBe(ids.length);
    const p = seenPeriod(now);
    expect(await redis.exists(keys.seen('9100', p, 0), keys.seen('9100', p, 1))).toBe(2);
    expect(await redis.exists(keys.seen('9100', p, 2))).toBe(0);
    const filter = await SeenFilter.load(redis, keys, '9100', { returnDays: 30, now });
    expect(filter.size).toBe(2);
    expect(ids.every((id) => filter.has(id))).toBe(true);
    // A full period takes nothing more.
    await redis.set(keys.seenCount('9101', p), SEEN_PERIOD_CAPACITY);
    expect(await addSeen(redis, keys, '9101', ['77'], { returnDays: 30, now })).toEqual({ added: 0, count: SEEN_PERIOD_CAPACITY, full: true });
  });

  it('forgets a swipe once its periods are past the return window', async () => {
    const then = Date.UTC(2026, 9, 1);
    await addSeen(redis, keys, '9200', ['31337'], { returnDays: 30, now: then });
    expect((await SeenFilter.load(redis, keys, '9200', { returnDays: 30, now: then + 20 * DAY })).has('31337')).toBe(true);
    expect((await SeenFilter.load(redis, keys, '9200', { returnDays: 30, now: then + 46 * DAY })).has('31337')).toBe(false);
  });

  it('writes a refill, reads its head in one round trip, and drops what leaves', async () => {
    const e = (userId: string, version: number, km: number | null, flags = 0): DeckEntry => ({ userId, version, km, flags });
    await writeDeck(redis, keys, '77', {
      kept: [],
      front: [e('30', 1, 3.2, DeckFlag.superliked)],
      back: [e('10', 2, 12, 0), e('20', 5, null, DeckFlag.activeRecently)],
      builtAt: 1_000,
      cursor: 'abcdefghijkl|2026-11-07|-5',
      exhaustedAt: null,
    });
    let head = await readDeckHead(redis, keys, '77', 10);
    expect(head).toMatchObject({ length: 3, builtAt: 1_000, exhaustedAt: null, cursor: 'abcdefghijkl|2026-11-07|-5', broken: [] });
    expect(head.entries.map((x) => x.userId)).toEqual(['30', '10', '20']);
    expect(head.entries[2]).toEqual(e('20', 5, null, DeckFlag.activeRecently));
    expect(await redis.ttl(keys.deckQueue('77'))).toBeGreaterThan(DECK_TTL_SECONDS - 5);

    // A swipe removes its target; the next refill keeps the rest, drops one and appends.
    await redis.lrem(keys.deckQueue('77'), 0, '30');
    const before = await readDeck(redis, keys, '77');
    expect(before.ids).toEqual(['10', '20']);
    await writeDeck(redis, keys, '77', {
      kept: [e('20', 6, null, 0)],
      front: [],
      back: [e('40', 1, 1, 0)],
      drop: ['10'],
      builtAt: 2_000,
      cursor: null,
      exhaustedAt: 2_000,
    });
    head = await readDeckHead(redis, keys, '77', 10);
    expect(head.entries.map((x) => [x.userId, x.version])).toEqual([
      ['20', 6],
      ['40', 1],
    ]);
    expect(head).toMatchObject({ builtAt: 2_000, exhaustedAt: 2_000, cursor: null });
    expect(Object.keys(await redis.hgetall(keys.deckMeta('77'))).sort()).toEqual(['20', '40', '@at', '@x']);

    // An id without metadata is reported, and dropFromDeck takes it out.
    await redis.rpush(keys.deckQueue('77'), '99');
    head = await readDeckHead(redis, keys, '77', 10);
    expect(head.broken).toEqual(['99']);
    await dropFromDeck(redis, keys, '77', ['99', '20']);
    expect(await redis.lrange(keys.deckQueue('77'), 0, -1)).toEqual(['40']);
    expect(await redis.hexists(keys.deckMeta('77'), '20')).toBe(0);
  });

  it('remembers hides for the life of a queue only, trimmed in the same write', async () => {
    const now = Date.now();
    await redis.zadd(keys.accountsHidden(), now - HIDDEN_WINDOW_MS - 1_000, 'old');
    await markHiddenFromDecks(redis, keys, ['11', '12'], now);
    expect(await redis.zrange(keys.accountsHidden(), 0, -1, 'WITHSCORES')).toEqual(['11', String(now), '12', String(now)]);
    await markHiddenFromDecks(redis, keys, [], now);
  });

  it('moves queued entries to newer card versions', async () => {
    await writeDeck(redis, keys, '66', { kept: [], front: [], back: [{ userId: '5', version: 1, km: 2, flags: 4 }], builtAt: 1, cursor: null, exhaustedAt: null });
    await updateDeckEntries(redis, keys, '66', [{ userId: '5', version: 3, km: 2, flags: 4 }]);
    expect((await readDeckHead(redis, keys, '66', 5)).entries).toEqual([{ userId: '5', version: 3, km: 2, flags: 4 }]);
  });

  it('lets one refill run at a time', async () => {
    const token = await takeDeckLock(redis, keys, '88');
    expect(token).toBeTruthy();
    expect(await takeDeckLock(redis, keys, '88')).toBeNull();
    await releaseDeckLock(redis, keys, '88', 'not-mine');
    expect(await takeDeckLock(redis, keys, '88')).toBeNull();
    await releaseDeckLock(redis, keys, '88', token!);
    expect(await takeDeckLock(redis, keys, '88')).toBeTruthy();
  });

  it('serves cached cards with one MGET and builds the misses in one call, under their own versions', async () => {
    const built: string[][] = [];
    const build = async (ids: readonly string[]) => {
      built.push([...ids]);
      return new Map<string, unknown>(ids.filter((id) => id !== '3').map((id) => [id, card(id === '2' ? 9 : 4, `P${id}`)]));
    };
    const first = await loadCards(redis, keys, [{ userId: '1', version: 4 }, { userId: '2', version: 8 }, { userId: '3', version: 1 }], '0', build);
    expect(built).toEqual([['1', '2', '3']]);
    expect(first.built).toBe(3);
    expect(first.missing).toEqual(['3']);
    expect(first.cards.get('2')?.v).toBe(9);
    // The newer version is stored under its own key: asking for 9 is a hit, 8 is a miss again.
    expect(await redis.exists(keys.card('2', 9, '0'), keys.card('1', 4, '0'))).toBe(2);
    expect(await redis.ttl(keys.card('1', 4, '0'))).toBeGreaterThan(CARD_TTL_SECONDS - 5);
    const second = await loadCards(redis, keys, [{ userId: '1', version: 4 }, { userId: '2', version: 9 }], '0', build);
    expect(second.built).toBe(0);
    expect(built).toHaveLength(1);
    // Another catalogue version is another card.
    const third = await loadCards(redis, keys, [{ userId: '1', version: 4 }], '1', build);
    expect(third.built).toBe(1);
  });
});
