import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CdnUrlSigner,
  jobId,
  mediaUrlExpiry,
  photoUploadKey,
  photoVariantKey,
  photoVariantKeys,
  photoVariantUrl,
  queueNames,
  queuePrefix,
  queueRetention,
} from '../../src/server/index.js';

const DAY = 86_400_000;

describe('photo storage layout', () => {
  it('names photos by id and blob version, never by person', () => {
    expect(photoUploadKey('1287390234923410099')).toBe('u/1287390234923410099');
    expect(photoVariantKey('1287390234923410099', 2, 640)).toBe('p/1287390234923410099/2/640.webp');
    expect(photoVariantKeys('12', 2)).toEqual(['p/12/1/320.webp', 'p/12/1/640.webp', 'p/12/1/1080.webp', 'p/12/2/320.webp', 'p/12/2/640.webp', 'p/12/2/1080.webp']);
    expect(() => photoUploadKey('../etc')).toThrow(TypeError);
    expect(() => photoVariantKey('12', 0, 640)).toThrow(RangeError);
    expect(() => photoVariantKey('12', 1, 500 as 640)).toThrow(RangeError);
  });
});

describe('signed CDN links', () => {
  const now = Date.UTC(2026, 10, 7, 15, 42, 11);
  const signer = (scheme: 'hmac' | 'bunny', baseUrl = 'https://cdn.example.com') =>
    new CdnUrlSigner({ baseUrl, signingKey: 'k'.repeat(32), scheme, now: () => new Date(now) });

  it('lives until the end of the next UTC day, the same link all day', () => {
    expect(mediaUrlExpiry(now)).toBe(Date.UTC(2026, 10, 9) / 1_000);
    expect(mediaUrlExpiry(Date.UTC(2026, 10, 7))).toBe(Date.UTC(2026, 10, 9) / 1_000);
    expect(mediaUrlExpiry(Date.UTC(2026, 10, 7) + DAY - 1)).toBe(Date.UTC(2026, 10, 9) / 1_000);
    const morning = new CdnUrlSigner({ baseUrl: 'https://cdn.example.com', signingKey: 'k'.repeat(32), scheme: 'hmac', now: () => new Date(Date.UTC(2026, 10, 7, 0, 0, 1)) });
    expect(morning.url('p/1/1/640.webp')).toBe(signer('hmac').url('p/1/1/640.webp'));
    expect(mediaUrlExpiry(now) * 1_000 - now).toBeGreaterThanOrEqual(DAY);
  });

  it('signs the path and the expiry (hmac), checkably, refusing a changed path or a past expiry', () => {
    const link = signer('hmac').url('p/1287/1/640.webp');
    expect(link).toMatch(/^https:\/\/cdn\.example\.com\/p\/1287\/1\/640\.webp\?exp=\d+&sig=[A-Za-z0-9_-]{43}$/);
    expect(CdnUrlSigner.verifyHmac(link, 'k'.repeat(32), now)).toBe(true);
    expect(CdnUrlSigner.verifyHmac(link.replace('640', '1080'), 'k'.repeat(32), now)).toBe(false);
    expect(CdnUrlSigner.verifyHmac(link, 'x'.repeat(32), now)).toBe(false);
    expect(CdnUrlSigner.verifyHmac(link, 'k'.repeat(32), now + 3 * DAY)).toBe(false);
    // A base path is part of what is signed.
    const prefixed = signer('hmac', 'https://media.example.com/m/').url('p/1/1/320.webp');
    expect(prefixed.startsWith('https://media.example.com/m/p/1/1/320.webp?')).toBe(true);
    expect(CdnUrlSigner.verifyHmac(prefixed, 'k'.repeat(32), now)).toBe(true);
  });

  it('writes the bunny token as base64url SHA-256 of key, path and expiry', () => {
    const link = new URL(signer('bunny').url('p/9/3/1080.webp'));
    const expires = link.searchParams.get('expires');
    const expected = createHash('sha256').update(`${'k'.repeat(32)}/p/9/3/1080.webp${expires}`).digest('base64url');
    expect(link.searchParams.get('token')).toBe(expected);
    expect(Number(expires)).toBe(mediaUrlExpiry(now));
  });

  it('refuses keys that could reach another path, and gives no link without a CDN', () => {
    for (const key of ['/p/1/1/640.webp', 'p/../x', 'p//1', 'p/1?x=1', '']) expect(() => signer('hmac').url(key)).toThrow(TypeError);
    expect(() => new CdnUrlSigner({ baseUrl: 'https://cdn.example.com?a=1', signingKey: 'k'.repeat(32), scheme: 'hmac' })).toThrow(TypeError);
    expect(() => new CdnUrlSigner({ baseUrl: 'https://cdn.example.com', signingKey: 'short', scheme: 'hmac' })).toThrow(RangeError);
    expect(photoVariantUrl({ urls: null }, '1', 1, 640)).toBeUndefined();
    expect(photoVariantUrl({ urls: signer('hmac') }, '1', 1, 640)).toContain('/p/1/1/640.webp?');
  });
});

describe('queues', () => {
  it('keeps finished jobs for a bounded time on every queue, push for ten minutes', () => {
    for (const name of queueNames) {
      const retention = queueRetention(name);
      expect(retention.removeOnFail).toEqual({ age: 604_800, count: 50_000 });
      expect(retention.removeOnComplete).toEqual(name === 'push' ? { age: 600 } : { age: 3_600, count: 10_000 });
    }
    expect(queuePrefix('app:')).toBe('app:bull');
  });

  it('builds job ids BullMQ accepts: never an integer, never a colon', () => {
    expect(jobId('process', '1287390234923410099')).toBe('process.1287390234923410099');
    expect(jobId('delete', '12', 1_700_000_000_000)).toBe('delete.12.1700000000000');
    expect(jobId('deletion-fanout', 5n)).toBe('deletion-fanout.5');
    expect(() => jobId('process', 'a:b')).toThrow(TypeError);
    expect(() => jobId('123')).toThrow(TypeError);
    expect(() => jobId('x', '')).toThrow(TypeError);
  });
});
