import { z } from 'zod';

export const livenessSchema = z.object({ status: z.literal('ok') });
export type Liveness = z.infer<typeof livenessSchema>;

/**
 * One dependency's readiness. Error details stay in the server log: a public
 * probe must not reveal internal host names or addresses.
 */
export const dependencyCheckSchema = z.object({
  status: z.enum(['up', 'down']),
  /** Whole milliseconds (`latencyMsOf`): 0 means under 1 ms. */
  latencyMs: z.number().int().nonnegative(),
  reason: z.enum(['timeout', 'error']).optional(),
});
export type DependencyCheck = z.infer<typeof dependencyCheckSchema>;

/**
 * A measured latency in whole milliseconds: anything under 1 ms is 0 (so 0
 * reads "under 1 ms" exactly, never a rounded 0.5-0.99), the rest rounded.
 */
export function latencyMsOf(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 1) return 0;
  return Math.round(elapsedMs);
}

export const readinessSchema = z.object({
  status: z.enum(['ready', 'not_ready', 'shutting_down']),
  checks: z.record(z.string(), dependencyCheckSchema),
});
export type Readiness = z.infer<typeof readinessSchema>;
