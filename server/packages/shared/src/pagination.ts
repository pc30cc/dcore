import { z } from 'zod';

/**
 * Keyset (cursor) pagination. Lists never use OFFSET: every page is an index
 * range scan that costs the same on page 1 and page 1000, which keeps the
 * database load flat. The cursor is opaque to clients; the server encodes the
 * sort key of the last row it returned and validates it on the way back in.
 */
export const PAGE_LIMIT_DEFAULT = 20;
export const PAGE_LIMIT_MAX = 100;
const CURSOR_MAX_LENGTH = 512;

export const cursorSchema = z
  .string()
  .min(1)
  .max(CURSOR_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, 'must be base64url');

export const pageQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

export interface Page<T> {
  items: T[];
  /** Pass back as `cursor` for the next page; `null` when this is the last page. */
  nextCursor: string | null;
}

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: cursorSchema.nullable(),
  });
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encodes a sort key (any JSON value) as an opaque cursor. */
export function encodeCursor(key: unknown): string {
  const cursor = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(key)));
  if (cursor.length > CURSOR_MAX_LENGTH) {
    throw new RangeError(`cursor is ${cursor.length} characters, more than ${CURSOR_MAX_LENGTH}`);
  }
  return cursor;
}

/**
 * Decodes a cursor and validates it against the sort key's schema. Returns
 * `null` for anything malformed, which the API answers with 400: a cursor is
 * client input like any other.
 */
export function decodeCursor<S extends z.ZodType>(schema: S, cursor: string): z.output<S> | null {
  if (!cursorSchema.safeParse(cursor).success) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64UrlToBytes(cursor)));
  } catch {
    return null;
  }
  const parsed = schema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

/**
 * Builds a page from rows fetched with `LIMIT limit + 1`: the extra row only
 * tells whether another page exists and is not returned.
 */
export function toPage<T>(rows: readonly T[], limit: number, cursorOf: (last: T) => unknown): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows.slice();
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last !== undefined ? encodeCursor(cursorOf(last)) : null,
  };
}
