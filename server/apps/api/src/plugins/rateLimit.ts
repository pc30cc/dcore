import rateLimit, { normalizeIP } from '@fastify/rate-limit';
import type { FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Redis } from 'ioredis';
import { HttpProblem } from '../lib/problem.js';

export interface RateLimitOptions {
  redis: Redis;
  keyPrefix: string;
  max: number;
  windowMs: number;
}

/** IPv6 clients are limited per /56, the smallest block a home connection usually gets. */
const IPV6_SUBNET = 56;

export function rateLimitKey(request: FastifyRequest): string {
  const principal = request.principal;
  if (principal) return `${principal.kind}:${principal.subject}`;
  // Behind Cloudflare `request.ip` is an edge shared by many clients; `clientIp` is the client.
  return `ip:${normalizeIP(request.clientIp ?? request.ip, IPV6_SUBNET)}`;
}

/**
 * A global request limit per signed-in subject, or per IP for anonymous
 * traffic, counted in Redis so every API instance shares it. If Redis is
 * unreachable the limit is skipped (the API stays up); endpoints that must
 * fail closed (OTP, sign-in) get their own stricter limiter when they exist.
 * Routes opt out with `config: { rateLimit: false }`.
 */
export const rateLimitPlugin = fp<RateLimitOptions>(
  async (app, { redis, keyPrefix, max, windowMs }) => {
    await app.register(rateLimit, {
      global: true,
      max,
      timeWindow: windowMs,
      redis,
      nameSpace: `${keyPrefix}rl:`,
      skipOnError: true,
      keyGenerator: rateLimitKey,
      errorResponseBuilder: (_request, context) =>
        new HttpProblem('rate_limited', {
          detail: `Too many requests; retry in ${Math.max(1, Math.ceil(context.ttl / 1_000))} s.`,
          retryAfterSeconds: Math.max(1, Math.ceil(context.ttl / 1_000)),
        }),
    });
  },
  { name: 'rate-limit', fastify: '5.x', dependencies: ['auth'] },
);
