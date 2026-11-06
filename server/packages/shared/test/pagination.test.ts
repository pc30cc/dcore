import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  decodeCursor,
  encodeCursor,
  pageQuerySchema,
  pageSchema,
  toPage,
} from '../src/index.js';

const keySchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

describe('cursor codec', () => {
  it('round-trips a sort key, non-ASCII included', () => {
    const key = { createdAt: '2026-11-06T10:00:00.000Z', id: '0b0f6d0e-7a2b-4c3d-9e8f-1a2b3c4d5e6f' };
    const cursor = encodeCursor(key);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(keySchema, cursor)).toEqual(key);
    expect(decodeCursor(z.string(), encodeCursor('شهر İstanbul'))).toBe('شهر İstanbul');
  });

  it('returns null for malformed or foreign cursors', () => {
    expect(decodeCursor(keySchema, 'not base64!')).toBeNull();
    expect(decodeCursor(keySchema, 'AAAA')).toBeNull();
    expect(decodeCursor(keySchema, encodeCursor({ id: 'x' }))).toBeNull();
    expect(decodeCursor(keySchema, '')).toBeNull();
  });

  it('refuses to build an oversized cursor', () => {
    expect(() => encodeCursor('x'.repeat(600))).toThrow(RangeError);
  });
});

describe('page query', () => {
  it('defaults and coerces the limit', () => {
    expect(pageQuerySchema.parse({})).toEqual({ limit: PAGE_LIMIT_DEFAULT });
    expect(pageQuerySchema.parse({ limit: '5' })).toEqual({ limit: 5 });
  });

  it('bounds the limit', () => {
    expect(pageQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(pageQuerySchema.safeParse({ limit: String(PAGE_LIMIT_MAX + 1) }).success).toBe(false);
    expect(pageQuerySchema.safeParse({ limit: '2.5' }).success).toBe(false);
  });
});

describe('toPage', () => {
  const rows = [1, 2, 3, 4].map((n) => ({ n }));

  it('drops the look-ahead row and returns a cursor for the last item', () => {
    const page = toPage(rows, 3, (last) => last.n);
    expect(page.items).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(z.number(), page.nextCursor ?? '')).toBe(3);
  });

  it('returns no cursor on the last page', () => {
    expect(toPage(rows, 4, (last) => last.n).nextCursor).toBeNull();
    expect(toPage([], 10, () => 0)).toEqual({ items: [], nextCursor: null });
  });

  it('matches the page schema', () => {
    const schema = pageSchema(z.object({ n: z.number() }));
    expect(schema.parse(toPage(rows, 2, (last) => last.n)).items).toHaveLength(2);
  });
});
