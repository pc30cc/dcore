import { livenessSchema, readinessSchema } from '@app/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { ReadinessProbe } from '../lib/readiness.js';

export interface HealthRoutesOptions {
  readiness: ReadinessProbe;
}

/**
 * Probes. /healthz answers from memory (is the process alive?); /readyz asks
 * PostgreSQL and Redis with short timeouts (should traffic come here?).
 * Neither is rate limited, and both log only problems.
 */
export const healthRoutes: FastifyPluginAsyncZod<HealthRoutesOptions> = async (app, { readiness }) => {
  app.get(
    '/healthz',
    {
      logLevel: 'warn',
      config: { rateLimit: false, pgBudget: 0 },
      schema: { tags: ['health'], summary: 'Liveness: the process is up', response: { 200: livenessSchema } },
    },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/readyz',
    {
      logLevel: 'warn',
      // One `SELECT 1`, shared by every probe inside READINESS_CACHE_MS.
      config: { rateLimit: false, pgBudget: 1 },
      schema: {
        tags: ['health'],
        summary: 'Readiness: PostgreSQL and Redis answer',
        response: { 200: readinessSchema, 503: readinessSchema },
      },
    },
    async (_request, reply) => {
      const result = await readiness.check();
      reply.header('cache-control', 'no-store');
      return reply.code(result.status === 'ready' ? 200 : 503).send(result);
    },
  );
};
