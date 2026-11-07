import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import fp from 'fastify-plugin';

export interface SecurityOptions {
  /** Exact origins of the admin panel. The app needs no CORS (it is not a browser). */
  adminOrigins: readonly string[];
}

/**
 * Security headers for a JSON API, and CORS for the admin panel's origins
 * only. Every other origin gets no CORS headers, so browsers refuse to share
 * responses with it. A route may name its own CORS (`config: { cors }`):
 * the public account-deletion routes allow the website's origin that way.
 */
export const securityPlugin = fp<SecurityOptions>(
  async (app, { adminOrigins }) => {
    await app.register(helmet, {
      global: true,
      // Responses are JSON, never documents: nothing may load or frame them.
      contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
    });

    // Registered even without admin origins (then no origin is allowed), so a route's own `cors` works.
    await app.register(cors, {
      origin: adminOrigins.length > 0 ? [...adminOrigins] : false,
      credentials: true,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-request-id'],
      exposedHeaders: ['x-request-id', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'],
      maxAge: 600,
      strictPreflight: true,
    });
  },
  { name: 'security', fastify: '5.x' },
);
