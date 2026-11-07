import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DataSealer,
  FailClosedLimits,
  KeyedHasher,
  LimitUnavailableError,
  OtpStore,
  REVIEW_WRONG_DAILY,
  RefreshGrace,
  bumpVersion,
  bumpVersionFrom,
  createKeys,
  otpCode,
  readVersion,
  reviewCodeHash,
} from '../../src/server/index.js';
import { dropPrefix, hasRedis, testPrefix, testRedis } from './support.js';

const ring = () => new Map([[1, randomBytes(32)]]);

describe('otp codes', () => {
  it('have the asked length and are spread over the whole range', () => {
    const codes = Array.from({ length: 2_000 }, () => otpCode(6));
    expect(codes.every((c) => /^[0-9]{6}$/.test(c))).toBe(true);
    expect(new Set(codes.map((c) => c[0])).size).toBe(10);
    expect(() => otpCode(3)).toThrow();
  });
});

describe.skipIf(!hasRedis)('sign-in state in Valkey (Lua, prefixed keys)', () => {
  let redis: Redis;
  const prefix = testPrefix();
  const keys = createKeys(prefix);
  const hasher = new KeyedHasher(ring(), 1);
  const sealer = new DataSealer(ring(), 1);

  beforeAll(() => {
    redis = testRedis();
  });
  afterAll(async () => {
    await dropPrefix(redis, prefix);
    await redis.quit();
  });

  describe('fail-closed limits', () => {
    it('counts all or nothing and names the limit that refused', async () => {
      const limits = new FailClosedLimits(redis);
      const a = { key: keys.raw('t', 'a'), cap: 2, windowMs: 60_000, name: 'a' };
      const b = { key: keys.raw('t', 'b'), cap: 3, windowMs: 60_000, name: 'b' };
      expect(await limits.take([a, b])).toEqual({ ok: true });
      expect(await limits.take([a, b])).toEqual({ ok: true });
      const refused = await limits.take([a, b]);
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.limit.name).toBe('a');
        expect(refused.retryAfterMs).toBeGreaterThan(50_000);
      }
      // A refused request counted nowhere.
      expect(await redis.get(b.key)).toBe('2');
      await limits.refund([a.key, b.key]);
      expect(await redis.get(a.key)).toBe('1');
      expect(await limits.check([a])).toEqual({ ok: true });
      expect(await redis.get(a.key)).toBe('1');
      expect(await redis.pttl(a.key)).toBeGreaterThan(0);
    });

    it('throws when Valkey cannot be asked', async () => {
      const { Redis: Client } = await import('ioredis');
      const down = new Client('redis://127.0.0.1:1', { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0 });
      await expect(new FailClosedLimits(down).take([{ key: keys.raw('t', 'x'), cap: 1, windowMs: 1_000, name: 'x' }])).rejects.toBeInstanceOf(
        LimitUnavailableError,
      );
      down.disconnect();
    });
  });

  describe('OTP challenges', () => {
    const store = () => new OtpStore({ redis, keys, hasher, sealer });
    const ipKey = () => keys.otpVerifyIpLimit(`198.51.100.${Math.floor(Math.random() * 200)}`);
    const verify = (s: OtpStore, challengeId: string, phoneHash: string, code: string, extra: Partial<{ purpose: 'signin' | `phone:${string}`; ipKey: string; ipCap: number }> = {}) =>
      s.verify({ challengeId, phoneHash, purpose: extra.purpose ?? 'signin', code, maxAttempts: 5, ipKey: extra.ipKey ?? ipKey(), ipCap: extra.ipCap ?? 100, ipWindowMs: 60_000 });

    it('never stores the code or the number in clear, and a code works once', async () => {
      const s = store();
      const phone = '+989121234567';
      const { challengeId, code } = await s.issue({ e164: phone, purpose: 'signin', length: 6, ttlSeconds: 300 });
      expect(code).toMatch(/^[0-9]{6}$/);
      const ph = s.phoneKeyHash(phone);
      expect(await s.phoneHashOf(challengeId)).toBe(ph);
      const stored = await redis.hgetall(keys.otp(ph));
      const dump = JSON.stringify(stored);
      expect(dump).not.toContain(code ?? '');
      expect(dump).not.toContain('9121234567');
      expect(stored['h']).toMatch(/^[0-9a-f]{64}$/);
      expect(await redis.pttl(keys.otp(ph))).toBeGreaterThan(290_000);
      expect(await verify(s, challengeId, ph, code ?? '')).toEqual({ outcome: 'ok', phone, review: false });
      expect(await verify(s, challengeId, ph, code ?? '')).toEqual({ outcome: 'missing' });
      expect(await redis.exists(keys.otp(ph), keys.otpChallenge(challengeId))).toBe(0);
    });

    it('kills the challenge at the fifth wrong code', async () => {
      const s = store();
      const phone = '+989121234568';
      const { challengeId, code } = await s.issue({ e164: phone, purpose: 'signin', length: 6, ttlSeconds: 300 });
      const ph = s.phoneKeyHash(phone);
      const wrong = code === '000000' ? '111111' : '000000';
      const outcomes = [];
      for (let i = 0; i < 5; i += 1) outcomes.push(await verify(s, challengeId, ph, wrong));
      expect(outcomes).toEqual([
        { outcome: 'wrong', attemptsLeft: 4 },
        { outcome: 'wrong', attemptsLeft: 3 },
        { outcome: 'wrong', attemptsLeft: 2 },
        { outcome: 'wrong', attemptsLeft: 1 },
        { outcome: 'locked' },
      ]);
      // The right code no longer works either.
      expect(await verify(s, challengeId, ph, code ?? '')).toEqual({ outcome: 'missing' });
    });

    it('binds a code to its challenge and its purpose; a new challenge replaces the old', async () => {
      const s = store();
      const phone = '+989121234569';
      const first = await s.issue({ e164: phone, purpose: 'phone:42', length: 6, ttlSeconds: 300 });
      const ph = s.phoneKeyHash(phone);
      expect(await verify(s, first.challengeId, ph, first.code ?? '', { purpose: 'signin' })).toEqual({ outcome: 'missing' });
      const second = await s.issue({ e164: phone, purpose: 'phone:42', length: 6, ttlSeconds: 300 });
      expect(await verify(s, first.challengeId, ph, first.code ?? '', { purpose: 'phone:42' })).toEqual({ outcome: 'missing' });
      expect(await verify(s, second.challengeId, ph, second.code ?? '', { purpose: 'phone:42' })).toMatchObject({ outcome: 'ok' });
    });

    it('checks review accounts against their fixed code hash, with nothing to send', async () => {
      const s = store();
      const phone = '+14155550199';
      const { challengeId, code } = await s.issue({ e164: phone, purpose: 'signin', length: 6, ttlSeconds: 300, reviewHash: reviewCodeHash(hasher, '246810') });
      expect(code).toBeNull();
      const ph = s.phoneKeyHash(phone);
      expect(await verify(s, challengeId, ph, '111111')).toEqual({ outcome: 'wrong', attemptsLeft: 4 });
      expect(await verify(s, challengeId, ph, '246810')).toEqual({ outcome: 'ok', phone, review: true });
    });

    it('locks a review number for the day at its daily cap of wrong codes, across challenges, the right code included', async () => {
      const s = store();
      const phone = '+14155550198';
      const ph = s.phoneKeyHash(phone);
      const review = reviewCodeHash(hasher, '864200');
      const outcomes: string[] = [];
      // A fresh challenge every 4 wrong codes (as an attacker would start them): the per-challenge 5 never ends it.
      let current = await s.issue({ e164: phone, purpose: 'signin', length: 6, ttlSeconds: 300, reviewHash: review });
      for (let i = 0; i < REVIEW_WRONG_DAILY; i += 1) {
        if (i > 0 && i % 4 === 0) current = await s.issue({ e164: phone, purpose: 'signin', length: 6, ttlSeconds: 300, reviewHash: review });
        outcomes.push((await verify(s, current.challengeId, ph, String(100_000 + i))).outcome);
      }
      expect(outcomes.slice(0, -1).every((o) => o === 'wrong')).toBe(true);
      expect(outcomes.at(-1)).toBe('locked');
      expect(await redis.pttl(keys.otpReviewWrong(ph))).toBeGreaterThan(86_000_000);
      const next = await s.issue({ e164: phone, purpose: 'signin', length: 6, ttlSeconds: 300, reviewHash: review });
      expect(await verify(s, next.challengeId, ph, '864200')).toEqual({ outcome: 'locked' });
      // An ordinary number is never counted there.
      const plain = '+14155550197';
      const p = await s.issue({ e164: plain, purpose: 'signin', length: 6, ttlSeconds: 300 });
      await verify(s, p.challengeId, s.phoneKeyHash(plain), p.code === '000000' ? '111111' : '000000');
      expect(await redis.exists(keys.otpReviewWrong(s.phoneKeyHash(plain)))).toBe(0);
    });

    it('counts verify attempts per IP, even past a dead challenge', async () => {
      const s = store();
      const ip = keys.otpVerifyIpLimit('203.0.113.9');
      for (let i = 0; i < 2; i += 1) expect(await verify(s, 'nochallenge1', 'f'.repeat(64), '123456', { ipKey: ip, ipCap: 2 })).toEqual({ outcome: 'missing' });
      expect(await verify(s, 'nochallenge1', 'f'.repeat(64), '123456', { ipKey: ip, ipCap: 2 })).toMatchObject({ outcome: 'ip_limited' });
    });
  });

  describe('version counters', () => {
    it('bumps from a seen value and says whether nothing else was announced since', async () => {
      const key = keys.meVersion('4242');
      const seen = await readVersion(redis, key, 1_000);
      expect(seen).toBe(1_000);
      expect(await bumpVersionFrom(redis, key, seen, 1_000)).toEqual({ version: 1_001, unchanged: true });
      // Another change between the read and this bump: still a new version, but not the same counter.
      const before = await readVersion(redis, key, 1_000);
      await bumpVersion(redis, key, 1_000);
      expect(await bumpVersionFrom(redis, key, before, 1_000)).toEqual({ version: 1_003, unchanged: false });
      // A lost counter restarts at the clock and never matches what was seen before.
      await redis.del(key);
      expect(await bumpVersionFrom(redis, key, 1_003, 5_000)).toEqual({ version: 5_000, unchanged: false });
    });
  });

  describe('refresh grace', () => {
    it('lets one refresh in per token, hands its answer to the others, and forgets on logout', async () => {
      const grace = new RefreshGrace({ redis, keys, graceMs: 30_000 });
      const limit = { count: true, cap: 30, windowMs: 3_600_000 };
      const sid = '1287390234923401000';
      const h = 'a'.repeat(64);
      expect(await grace.claim(sid, h, limit)).toEqual({ state: 'claimed' });
      expect(await grace.claim(sid, h, limit)).toEqual({ state: 'pending' });
      await grace.complete(sid, h, 'sealed-answer');
      expect(await grace.claim(sid, h, limit)).toEqual({ state: 'done', answer: 'sealed-answer' });
      // Another token of the same session is its own entry.
      expect(await grace.claim(sid, 'b'.repeat(64), limit)).toEqual({ state: 'claimed' });
      await grace.release(sid, 'b'.repeat(64));
      expect(await grace.claim(sid, 'b'.repeat(64), limit)).toEqual({ state: 'claimed' });
      // release never drops a finished answer
      await grace.release(sid, h);
      expect(await grace.claim(sid, h, limit)).toMatchObject({ state: 'done' });
      await grace.forget([sid]);
      expect(await grace.claim(sid, h, limit)).toEqual({ state: 'claimed' });
    });

    it('expires answers and stale claims by their own deadline, and limits refreshes per session', async () => {
      const grace = new RefreshGrace({ redis, keys, graceMs: 200, inFlightMs: 200 });
      const sid = '1287390234923401001';
      const free = { count: false, cap: 1, windowMs: 1_000 };
      expect(await grace.claim(sid, 'c'.repeat(64), free)).toEqual({ state: 'claimed' });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(await grace.claim(sid, 'c'.repeat(64), free)).toEqual({ state: 'claimed' });
      await grace.complete(sid, 'c'.repeat(64), 'x');
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(await grace.claim(sid, 'c'.repeat(64), free)).toEqual({ state: 'claimed' });

      const counted = { count: true, cap: 2, windowMs: 60_000 };
      const other = '1287390234923401002';
      expect((await grace.claim(other, 'd'.repeat(64), counted)).state).toBe('claimed');
      expect((await grace.claim(other, 'e'.repeat(64), counted)).state).toBe('claimed');
      expect((await grace.claim(other, 'f'.repeat(64), counted)).state).toBe('limited');
    });
  });
});
