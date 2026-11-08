import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LIST_COMPLETE,
  announceMatch,
  appendMatch,
  clearPairLikes,
  createKeys,
  dropPendingLikers,
  forgetMatch,
  isLikeAnswered,
  isLikePending,
  isoWeek,
  likeScriptKeys,
  likeWeek,
  likeWeeks,
  parseLikeEntry,
  parseMatchEntry,
  countPendingLikes,
  MATCH_ENDED_TTL_SECONDS,
  quotaPeriod,
  readConversationList,
  readMatchStates,
  readPendingLikes,
  runLikeScript,
  storeConversationList,
  useHourlySwipes,
  useQuota,
  type LikeScriptInput,
} from '../../src/server/index.js';
import { isStorableText, swipeSchema } from '../../src/api/social.js';
import { dropPrefix, hasRedis, testPrefix, testRedis } from './support.js';

describe('quota periods', () => {
  it('names ISO weeks like the calendar does, the year included', () => {
    expect(isoWeek(Date.UTC(2026, 10, 6))).toBe('202645');
    expect(isoWeek(Date.UTC(2026, 0, 1))).toBe('202601'); // a Thursday
    expect(isoWeek(Date.UTC(2027, 0, 1))).toBe('202653'); // a Friday: the last week of 2026
    expect(isoWeek(Date.UTC(2024, 11, 30))).toBe('202501'); // a Monday in the first week of 2025
    expect(isoWeek(Date.UTC(2021, 0, 3))).toBe('202053'); // a Sunday
  });

  it('resets daily quotas at midnight UTC and weekly ones on Monday', () => {
    const friday = Date.UTC(2026, 10, 6, 15, 30);
    expect(new Date(quotaPeriod('likes', friday).resetsAtMs).toISOString()).toBe('2026-11-07T00:00:00.000Z');
    expect(new Date(quotaPeriod('superlikes', friday).resetsAtMs).toISOString()).toBe('2026-11-09T00:00:00.000Z');
    const monday = Date.UTC(2026, 10, 9, 0, 0, 1);
    expect(new Date(quotaPeriod('superlikes', monday).resetsAtMs).toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(quotaPeriod('likes', friday).period).toBe('20261106');
  });
});

describe('stream entries', () => {
  it('read what the like script writes and refuse a malformed one', () => {
    const like = parseLikeEntry({ id: '12', t: '3', a: '4', k: '2', ik: '1', ir: '99', c: 'hi', x: '1', w: '0' });
    expect(like).toEqual({
      id: '12',
      targetId: '3',
      actorId: '4',
      kind: 2,
      itemKind: 1,
      itemRef: '99',
      comment: 'hi',
      check: true,
      prepaid: false,
      matched: false,
      commentDropped: false,
    });
    expect(parseLikeEntry({ id: '12', t: '3', a: '4', k: '1', ik: '0', ir: '', c: '', x: '0', w: '0', m: '1' }).matched).toBe(true);
    expect(parseLikeEntry({ id: '12', t: '3', a: '4', k: '1', ik: '0', ir: '', c: '', x: '0', w: '1' })).toMatchObject({ itemRef: null, comment: null, prepaid: true });
    expect(() => parseLikeEntry({ id: 'x', t: '3', a: '4', k: '1', ik: '0' })).toThrow(/id/);
    expect(() => parseLikeEntry({ id: '1', t: '3', a: '4', k: '3', ik: '0' })).toThrow(/k/);
    expect(() => parseLikeEntry({ id: '1', t: '3', a: '4', k: '1', ik: '1', ir: '' })).toThrow(/ir/);
    expect(() => parseMatchEntry({ m: '1', a: '2', t: '3', s: '1', n1: '4', l: '6', ik: '0' })).toThrow(/n2/);
  });

  it('drops a comment PostgreSQL would refuse (NUL, control characters, over 300 code points) and keeps the like and the match', () => {
    const base = { id: '12', t: '3', a: '4', k: '1', ik: '0', ir: '', x: '0', w: '0' };
    for (const bad of ['hi\u0000there', 'bell\u0007', 'x'.repeat(301), '\u{1F600}'.repeat(301)]) {
      expect(parseLikeEntry({ ...base, c: bad })).toMatchObject({ id: '12', comment: null, commentDropped: true });
      const match = parseMatchEntry({ m: '1', a: '2', t: '3', s: '1', n1: '4', n2: '5', l: '6', ik: '0', ir: '', c: bad });
      expect(match).toMatchObject({ matchId: '1', comment: null });
    }
    // 300 code points that are 600 UTF-16 units, tabs and line breaks are fine.
    for (const good of ['\u{1F600}'.repeat(300), 'a\tb\nc\r\nd']) {
      expect(parseLikeEntry({ ...base, c: good })).toMatchObject({ comment: good, commentDropped: false });
    }
  });
});

describe('like comments', () => {
  it('are refused with a control character before anything happens', () => {
    const swipe = (comment: string) => swipeSchema.safeParse({ target: 'aaaaaaaaaaaaa', action: 'like', comment });
    expect(swipe('hi\u0000there').success).toBe(false);
    expect(swipe('esc\u001b[2J').success).toBe(false);
    expect(swipe('del\u007f').success).toBe(false);
    expect(swipe('two\nlines\tand a tab').success).toBe(true);
    expect(isStorableText('a\u0000', 300)).toBe(false);
    expect(isStorableText('\u{1F600}'.repeat(300), 300)).toBe(true);
    expect(isStorableText('\u{1F600}'.repeat(301), 300)).toBe(false);
  });
});

describe.skipIf(!hasRedis)('likes, matches and quotas in Valkey (Lua, prefixed keys)', () => {
  let redis: Redis;
  const prefix = testPrefix();
  const keys = createKeys(prefix);
  let next = 1_000_000n;
  const id = () => String((next += 1n));
  const now = Date.UTC(2026, 10, 6, 12);

  beforeAll(async () => {
    redis = testRedis();
    await redis.set(keys.likesReady(), '1');
  });
  afterAll(async () => {
    await dropPrefix(redis, prefix);
    await redis.quit();
  });

  function like(actorId: string, targetId: string, extra: Partial<LikeScriptInput> = {}): LikeScriptInput {
    return {
      actorId,
      targetId,
      likeId: id(),
      kind: 1,
      itemKind: 0,
      matchId: id(),
      noteIds: [id(), id()],
      prepaid: false,
      bucketCap: 3_000,
      now,
      ...extra,
    };
  }

  async function streamFields(name: 'like' | 'match'): Promise<Record<string, string>[]> {
    const raw = await redis.xrange(keys.stream(name), '-', '+');
    return raw.map(([, flat]) => Object.fromEntries(flat.flatMap((v, i, a) => (i % 2 === 0 ? [[v, a[i + 1] ?? '']] : []))));
  }

  it('gives every key to the script under the deployment prefix', () => {
    const list = likeScriptKeys(keys, '1', '2', now);
    expect(list).toHaveLength(32);
    expect(list.every((k) => k.startsWith(prefix))).toBe(true);
  });

  it('records a like, refuses a repeat, and turns the answer into a match with the pre-minted ids', async () => {
    const [a, b] = [id(), id()];
    const first = like(a, b, { comment: 'Nice photo', itemKind: 1, itemRef: '777' });
    expect(await runLikeScript(redis, keys, first)).toBe('liked');
    expect(await isLikePending(redis, keys, a, b, now)).toBe(true);
    expect(await runLikeScript(redis, keys, like(a, b))).toBe('duplicate');

    const back = like(b, a, { kind: 2, comment: 'Hello' });
    expect(await runLikeScript(redis, keys, back)).toBe('match');
    // Nobody is anyone's pending liker any more.
    expect(await isLikePending(redis, keys, a, b, now)).toBe(false);
    const matches = (await streamFields('match')).filter((e) => e['m'] === back.matchId);
    expect(matches).toHaveLength(1);
    expect(parseMatchEntry(matches[0]!)).toEqual({
      matchId: back.matchId,
      actorId: b,
      targetId: a,
      kind: 2,
      noteIds: back.noteIds,
      likeId: back.likeId,
      itemKind: 0,
      itemRef: null,
      comment: 'Hello',
    });
    // Both likes are in the like stream (the match's too: likes keep their rows).
    const likes = (await streamFields('like')).filter((e) => e['id'] === first.likeId || e['id'] === back.likeId);
    expect(likes.map((e) => parseLikeEntry(e).id).sort()).toEqual([first.likeId, back.likeId].sort());
  });

  it('answers duplicate to a like sent again after the match, from either side, and writes nothing', async () => {
    const [a, b] = [id(), id()];
    expect(await runLikeScript(redis, keys, like(a, b))).toBe('liked');
    expect(await runLikeScript(redis, keys, like(b, a))).toBe('match');
    expect(await redis.ttl(keys.likesMatched(b, a))).toBeGreaterThan(6 * 86_400);
    const before = await Promise.all([redis.xlen(keys.stream('like')), redis.xlen(keys.stream('match'))]);
    expect(await runLikeScript(redis, keys, like(b, a))).toBe('duplicate');
    expect(await runLikeScript(redis, keys, like(a, b, { kind: 2 }))).toBe('duplicate');
    expect(await Promise.all([redis.xlen(keys.stream('like')), redis.xlen(keys.stream('match'))])).toEqual(before);
    expect(await isLikePending(redis, keys, a, b, now)).toBe(false);
    expect(await isLikePending(redis, keys, b, a, now)).toBe(false);
    expect(await isLikeAnswered(redis, keys, a, b, now)).toBe(true);
    // A pair matched another way (a check, the stream writer) is marked by its announcement.
    const [c, d] = [id(), id()];
    expect(await isLikeAnswered(redis, keys, c, d, now)).toBe(false);
    await announceMatch(redis, keys, { id: id(), lo: c, hi: d, state: 1, flags: 3, source: 1, createdMs: now });
    expect(await runLikeScript(redis, keys, like(d, c))).toBe('duplicate');
  });

  it('answers liked to a like within a blocked pair, and writes nothing: no bucket, no stream entry', async () => {
    const [a, b] = [id(), id()];
    await redis.set(keys.likesBlocked(b, a), 1);
    const before = await Promise.all([redis.xlen(keys.stream('like')), redis.xlen(keys.stream('match'))]);
    expect(await runLikeScript(redis, keys, like(a, b, { kind: 2 }))).toBe('liked');
    expect(await runLikeScript(redis, keys, like(b, a))).toBe('liked');
    expect(await Promise.all([redis.xlen(keys.stream('like')), redis.xlen(keys.stream('match'))])).toEqual(before);
    expect(await isLikePending(redis, keys, a, b, now)).toBe(false);
    expect((await countPendingLikes(redis, keys, b, now)).total).toBe(0);
    // A pair that matched stays a duplicate, block or not (a block reads like an unmatch).
    const [c, d] = [id(), id()];
    expect(await runLikeScript(redis, keys, like(c, d))).toBe('liked');
    expect(await runLikeScript(redis, keys, like(d, c))).toBe('match');
    await redis.set(keys.likesBlocked(c, d), 1);
    expect(await runLikeScript(redis, keys, like(c, d))).toBe('duplicate');
  });

  it('answers duplicate to a super like sent again to a bucket at its cap, and to a like after it', async () => {
    const popular = id();
    const [fan, superFan] = [id(), id()];
    expect(await runLikeScript(redis, keys, like(fan, popular, { bucketCap: 1 }))).toBe('liked');
    // The bucket is full: the super like is kept only among the super likers.
    expect(await runLikeScript(redis, keys, like(superFan, popular, { kind: 2, bucketCap: 1 }))).toBe('liked');
    expect(await redis.sismember(keys.likesIn(popular, likeWeek(now)), superFan)).toBe(0);
    expect(await isLikePending(redis, keys, superFan, popular, now)).toBe(true);
    expect(await isLikeAnswered(redis, keys, superFan, popular, now)).toBe(true);
    const before = await redis.xlen(keys.stream('like'));
    expect(await runLikeScript(redis, keys, like(superFan, popular, { kind: 2, bucketCap: 1 }))).toBe('duplicate');
    expect(await runLikeScript(redis, keys, like(superFan, popular, { bucketCap: 1 }))).toBe('duplicate');
    expect(await redis.xlen(keys.stream('like'))).toBe(before);
    // The same in a later week: last week's super likers still count.
    const nextWeek = now + 7 * 86_400_000;
    expect(await runLikeScript(redis, keys, like(superFan, popular, { kind: 2, bucketCap: 1, now: nextWeek }))).toBe('duplicate');
  });

  it('marks the like that made the match, so its writer tells nobody about it', async () => {
    const [a, b] = [id(), id()];
    const first = like(a, b);
    const back = like(b, a);
    expect(await runLikeScript(redis, keys, first)).toBe('liked');
    expect(await runLikeScript(redis, keys, back)).toBe('match');
    const entries = (await streamFields('like')).filter((e) => e['id'] === first.likeId || e['id'] === back.likeId).map((e) => parseLikeEntry(e));
    expect(entries.find((e) => e.id === first.likeId)?.matched).toBe(false);
    expect(entries.find((e) => e.id === back.likeId)?.matched).toBe(true);
  });

  it('counts the pending likes of a person without reading them, as the likes page does', async () => {
    const person = id();
    const likers = [id(), id(), id(), id()];
    expect(await runLikeScript(redis, keys, like(likers[0]!, person, { bucketCap: 3 }))).toBe('liked');
    expect(await runLikeScript(redis, keys, like(likers[1]!, person, { kind: 2, bucketCap: 3 }))).toBe('liked');
    expect(await runLikeScript(redis, keys, like(likers[2]!, person, { bucketCap: 3, now: now - 7 * 86_400_000 }))).toBe('liked');
    expect(await countPendingLikes(redis, keys, person, now)).toEqual({ total: 3, capped: false });
    expect((await readPendingLikes(redis, keys, person, now)).total).toBe(3);
    // The current bucket reaches its cap (2 of 3 here) and a super like beyond it is kept apart: still counted once.
    expect(await runLikeScript(redis, keys, like(likers[3]!, person, { bucketCap: 2 }))).toBe('liked');
    const superFan = id();
    expect(await runLikeScript(redis, keys, like(superFan, person, { kind: 2, bucketCap: 2 }))).toBe('liked');
    const counted = await countPendingLikes(redis, keys, person, now);
    const read = await readPendingLikes(redis, keys, person, now);
    expect(counted).toEqual({ total: read.total, capped: true });
    expect(counted.total).toBe(4);
  });

  it('does not put back a match whose conversation ended before its announcement', async () => {
    const [lo, hi] = [id(), id()];
    const match = { id: id(), lo, hi, state: 1, flags: 3, source: 1, createdMs: now };
    await storeConversationList(redis, keys, lo, []);
    await forgetMatch(redis, keys, match);
    expect(await redis.ttl(keys.matchEnded(match.id))).toBeGreaterThan(MATCH_ENDED_TTL_SECONDS - 10);
    expect(await announceMatch(redis, keys, match)).toBe(false);
    expect(await redis.exists(keys.matchState(match.id))).toBe(0);
    expect((await readConversationList(redis, keys, lo, 10)).items.map((i) => i.id)).not.toContain(match.id);
    // Another match is announced as usual.
    const other = { ...match, id: id() };
    expect(await announceMatch(redis, keys, other)).toBe(true);
    expect((await readConversationList(redis, keys, lo, 10)).items.map((i) => i.id)).toContain(other.id);
  });

  it('keeps super likers apart and drops a passed liker', async () => {
    const [a, b, c] = [id(), id(), id()];
    expect(await runLikeScript(redis, keys, like(a, c, { kind: 2 }))).toBe('liked');
    expect(await runLikeScript(redis, keys, like(b, c))).toBe('liked');
    const pending = await readPendingLikes(redis, keys, c, now);
    expect(pending.total).toBe(2);
    expect(pending.buckets[0]!.week).toBe(likeWeek(now));
    expect(pending.buckets[0]!.superLikers).toEqual([a]);
    await dropPendingLikers(redis, keys, c, [a], now);
    const after = await readPendingLikes(redis, keys, c, now);
    expect(after.total).toBe(1);
    expect(after.buckets[0]!.superLikers).toEqual([]);
  });

  it('answers check while the buckets are incomplete, and flags the entry for the writer', async () => {
    const [a, b] = [id(), id()];
    await redis.del(keys.likesReady());
    try {
      const l = like(a, b);
      expect(await runLikeScript(redis, keys, l)).toBe('check');
      const entry = (await streamFields('like')).find((e) => e['id'] === l.likeId);
      expect(parseLikeEntry(entry!).check).toBe(true);
      // A like made after the loss is still found in the bucket: that is a match, not a check.
      expect(await runLikeScript(redis, keys, like(b, a))).toBe('match');
    } finally {
      await redis.set(keys.likesReady(), '1');
    }
  });

  it('stops a bucket at its cap, and still finds the popular person\'s mutual likes through check', async () => {
    const popular = id();
    const likers = [id(), id(), id()];
    for (const liker of likers) expect(await runLikeScript(redis, keys, like(liker, popular, { bucketCap: 2 }))).toBe('liked');
    const week = likeWeek(now);
    expect(await redis.scard(keys.likesIn(popular, week))).toBe(2);
    expect(await redis.exists(keys.likesInFull(popular, week))).toBe(1);
    const capped = await readPendingLikes(redis, keys, popular, now);
    expect(capped.capped).toBe(true);
    // The third liker is not in the bucket; the popular person's like of them is a check (their bucket is full).
    const back = like(popular, likers[2]!, { bucketCap: 2 });
    expect(await runLikeScript(redis, keys, back)).toBe('check');
    // A like back to someone in the bucket is a match as usual.
    expect(await runLikeScript(redis, keys, like(popular, likers[0]!, { bucketCap: 2 }))).toBe('match');
  });

  it('gives exactly one match for 200 simultaneous mutual likes over 100 pairs', async () => {
    const pairs = Array.from({ length: 100 }, () => [id(), id()] as const);
    const calls = pairs.flatMap(([a, b]) => [like(a, b), like(b, a)]);
    const connections = Array.from({ length: 10 }, () => redis.duplicate());
    let answers: string[];
    try {
      answers = await Promise.all(calls.map((input, i) => runLikeScript(connections[i % connections.length]!, keys, input)));
    } finally {
      await Promise.all(connections.map((c) => c.quit()));
    }
    const matched = calls.filter((_, i) => answers[i] === 'match');
    expect(matched).toHaveLength(100);
    expect(answers.filter((a) => a === 'liked')).toHaveLength(100);
    const entries = (await streamFields('match')).filter((e) => matched.some((m) => m.matchId === e['m']));
    expect(entries).toHaveLength(100);
    const pairKeys = new Set(entries.map((e) => [e['a'], e['t']].sort().join(':')));
    expect(pairKeys.size).toBe(100);
  });

  it('appends a match found elsewhere with the fields the script writes', async () => {
    const entry = { matchId: id(), actorId: id(), targetId: id(), kind: 1 as const, noteIds: [id(), id()] as [string, string], likeId: id(), itemKind: 2 as const, itemRef: '5', comment: null };
    await appendMatch(redis, keys, entry);
    const found = (await streamFields('match')).find((e) => e['m'] === entry.matchId);
    expect(parseMatchEntry(found!)).toEqual(entry);
  });

  it('counts quotas up to the limit, gives back, and counts without a limit', async () => {
    const user = id();
    expect((await useQuota(redis, keys, 'likes', user, 2, 1, now)).allowed).toBe(true);
    expect((await useQuota(redis, keys, 'likes', user, 2, 1, now)).used).toBe(2);
    const refused = await useQuota(redis, keys, 'likes', user, 2, 1, now);
    expect(refused).toMatchObject({ allowed: false, used: 2 });
    expect(new Date(refused.resetsAtMs).toISOString()).toBe('2026-11-07T00:00:00.000Z');
    expect((await useQuota(redis, keys, 'likes', user, 2, -1, now)).used).toBe(1);
    expect((await useQuota(redis, keys, 'likes', user, 2, 1, now)).allowed).toBe(true);
    // Unlimited still counts what was used.
    expect((await useQuota(redis, keys, 'superlikes', user, -1, 1, now)).used).toBe(1);
    // Giving back never goes below zero.
    expect((await useQuota(redis, keys, 'superlikes', id(), -1, -1, now)).used).toBe(0);
    const ttl = await redis.ttl(keys.quota('likes', user, '20261106'));
    expect(ttl).toBeGreaterThan(86_400);
    expect(ttl).toBeLessThanOrEqual(2 * 86_400);
  });

  it('refuses a request past the hourly swipe cap without counting it', async () => {
    const user = id();
    expect((await useHourlySwipes(redis, keys, user, 15, now, 20)).allowed).toBe(true);
    const refused = await useHourlySwipes(redis, keys, user, 10, now, 20);
    expect(refused).toMatchObject({ allowed: false, used: 15 });
    expect(refused.resetsAtMs).toBe(Date.UTC(2026, 10, 6, 13));
  });

  it('keeps conversation lists complete or says so, and their match states', async () => {
    const [lo, hi, other] = [id(), id(), id()];
    const m1 = { id: id(), lo, hi, state: 1, flags: 3, source: 1, createdMs: now - 1_000 };
    await announceMatch(redis, keys, m1);
    // Announced into a list nobody built: still not complete.
    expect((await readConversationList(redis, keys, lo, 10)).complete).toBe(false);
    const m0 = { id: id(), lo, hi: other, state: 1, flags: 0, source: 2, createdMs: now - 5_000 };
    await storeConversationList(redis, keys, lo, [
      { id: m0.id, score: m0.createdMs },
      { id: m1.id, score: m1.createdMs },
    ]);
    const page = await readConversationList(redis, keys, lo, 1);
    expect(page.complete).toBe(true);
    expect(page.items.map((i) => i.id)).toEqual([m1.id, m0.id]);
    const older = await readConversationList(redis, keys, lo, 10, { score: m1.createdMs, id: m1.id });
    expect(older.items.map((i) => i.id)).toEqual([m0.id]);
    expect(await redis.zscore(keys.conversationList(lo), LIST_COMPLETE)).toBe('-1');
    expect((await readMatchStates(redis, keys, [m1.id]))[0]).toEqual(m1);
    await forgetMatch(redis, keys, m1);
    expect((await readConversationList(redis, keys, lo, 10)).items.map((i) => i.id)).toEqual([m0.id]);
    expect((await readMatchStates(redis, keys, [m1.id]))[0]).toBeNull();
    await clearPairLikes(redis, keys, lo, hi, now);
  });

  it('reads pending likes from the five live weeks only, each liker once', async () => {
    const target = id();
    const liker = id();
    const weeks = likeWeeks(now);
    await redis.sadd(keys.likesIn(target, weeks[0]!), liker);
    await redis.sadd(keys.likesIn(target, weeks[4]!), liker);
    await redis.sadd(keys.likesIn(target, weeks[0]! - 1), id());
    const pending = await readPendingLikes(redis, keys, target, now);
    expect(pending.total).toBe(1);
    expect(pending.buckets.map((b) => b.week)).toEqual([...weeks].reverse());
  });
});
