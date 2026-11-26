import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpProblem } from '../lib/problem.js';
import { adminIdOf } from '../routes/adminAuth.js';

/**
 * Per-admin hourly limits of the sensitive views and lookups (a phone shown,
 * a chat shown, a phone or purchase looked up, an audit export). They fail
 * closed: Valkey unreachable answers 503, a spent limit 429 with
 * `retry-after`. `refund()` gives the count back (a view that showed
 * nothing); it never throws, so a Valkey failure there cannot turn the
 * route's own answer into a 500.
 */

export interface AdminLimitTicket {
  refund(): Promise<void>;
}

const HOUR_MS = 3_600_000;

export async function takeAdminLimit(app: FastifyInstance, request: FastifyRequest, name: string, cap: number): Promise<AdminLimitTicket> {
  const key = app.keys.signInIpLimit(name, String(adminIdOf(request)));
  let verdict;
  try {
    verdict = await app.limits.take([{ name, key, cap, windowMs: HOUR_MS }]);
  } catch (error) {
    throw new HttpProblem('service_unavailable', { detail: 'Try again in a moment.', headers: { 'retry-after': '30' }, cause: error });
  }
  if (!verdict.ok) {
    const retryAfterSeconds = Math.max(1, Math.ceil(verdict.retryAfterMs / 1_000));
    throw new HttpProblem('rate_limited', { retryAfterSeconds, headers: { 'retry-after': String(retryAfterSeconds) } });
  }
  return {
    async refund() {
      await app.limits.refund([key]).catch((error: unknown) => request.log.warn({ err: error, limit: name }, 'admin limit: the count was not given back'));
    },
  };
}
