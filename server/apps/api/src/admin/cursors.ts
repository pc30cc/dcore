import { decodeCursor, encodeCursor } from '@app/shared';
import type { z } from 'zod';
import { HttpProblem } from '../lib/problem.js';

/**
 * The keys of the admin lists' cursors: a small object encoded by
 * `encodeCursor`, read back against its schema; a cursor that does not
 * decode, or is another list's, is a 400 at `/cursor`.
 */

export function readCursorKey<S extends z.ZodType>(schema: S, cursor: string | undefined): z.output<S> | null {
  if (cursor === undefined) return null;
  const key = decodeCursor(schema, cursor);
  if (key === null) throw badCursor();
  return key;
}

export function badCursor(): HttpProblem {
  return new HttpProblem('validation_failed', {
    detail: 'The cursor is not valid.',
    errors: [{ in: 'query', pointer: '/cursor', code: 'invalid', message: 'not a cursor of this list' }],
  });
}

/** A page of `rows` read with `limit + 1`, the next cursor from the last row shown. */
export function pageOf<R, T>(rows: readonly R[], limit: number, map: (row: R) => T, keyOf: (row: R) => unknown): { items: T[]; nextCursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { items: page.map(map), nextCursor: rows.length > limit && last !== undefined ? encodeCursor(keyOf(last)) : null };
}

/** A 422 for one field of the body. */
export function fieldInvalid(pointer: string, code: string, message: string): HttpProblem {
  return new HttpProblem('field_invalid', { detail: message, errors: [{ in: 'body', pointer, code, message }] });
}
