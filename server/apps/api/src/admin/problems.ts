import type { AdminConflictReason, AdminFieldCode, AdminForbiddenReason, Permission } from '@app/shared';
import { HttpProblem, type HttpProblemInit } from '../lib/problem.js';

/**
 * The admin routes' refusals, each with its machine word (shared
 * `adminProblems.ts`), which the panel words in its own language; the
 * English detail is for logs and support.
 */

/** A 422 for one field of the body. */
export function fieldInvalid(pointer: string, code: AdminFieldCode, message: string): HttpProblem {
  return new HttpProblem('field_invalid', { detail: message, errors: [{ in: 'body', pointer, code, message }] });
}

/** A 409 with its reason. */
export function adminConflict(reason: AdminConflictReason, detail: string): HttpProblem {
  return new HttpProblem('conflict', { detail, extensions: { reason } });
}

/** A 403 with its reason (and the permissions a refused role change would give). */
export function adminForbidden(
  reason: AdminForbiddenReason,
  detail: string,
  options: { permissions?: readonly Permission[]; headers?: HttpProblemInit['headers'] } = {},
): HttpProblem {
  return new HttpProblem('forbidden', {
    detail,
    extensions: { reason, ...(options.permissions ? { permissions: [...options.permissions] } : {}) },
    ...(options.headers ? { headers: options.headers } : {}),
  });
}
