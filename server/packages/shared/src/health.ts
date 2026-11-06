import { z } from 'zod';

export const livenessSchema = z.object({ status: z.literal('ok') });
export type Liveness = z.infer<typeof livenessSchema>;

/**
 * One dependency's readiness. Error details stay in the server log: a public
 * probe must not reveal internal host names or addresses.
 */
export const dependencyCheckSchema = z.object({
  status: z.enum(['up', 'down']),
  latencyMs: z.number().int().nonnegative(),
  reason: z.enum(['timeout', 'error']).optional(),
});
export type DependencyCheck = z.infer<typeof dependencyCheckSchema>;

export const readinessSchema = z.object({
  status: z.enum(['ready', 'not_ready', 'shutting_down']),
  checks: z.record(z.string(), dependencyCheckSchema),
});
export type Readiness = z.infer<typeof readinessSchema>;
