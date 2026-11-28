import { z } from 'zod';

/**
 * The run recorder's records (`ops:runs`, `ops:runs:ok`; the worker writes
 * them when a scheduled or hand-started job ends): when, whether it worked,
 * how long it took, the attempt, and a summary of the job's own result.
 * Nothing else of a job is kept: the error is its class name and SQLSTATE
 * (never its message), the summary its top-level numbers and booleans.
 */

const int = z.number().int().nonnegative();
const ERROR_KIND = /^[A-Za-z][A-Za-z0-9]{0,39}(:[0-9A-Z]{5})?$/;
const SUMMARY_KEY = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
export const RUN_SUMMARY_MAX = 8;

export const runRecordSchema = z.object({
  atMs: int,
  ok: z.boolean(),
  /** finishedOn − processedOn; null when BullMQ did not say. */
  ms: int.nullable(),
  /** The attempt that ended (1 = the first). */
  attempt: int,
  attempts: int,
  /** A failure BullMQ tries again. */
  willRetry: z.boolean(),
  error: z.string().regex(ERROR_KIND).nullable(),
  /** Started from the jobs page. */
  manual: z.boolean(),
  summary: z.record(z.string().regex(SUMMARY_KEY), z.union([z.number(), z.boolean()])),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

/** The field of a job in `ops:runs` and `ops:runs:ok`. */
export function runField(queue: string, name: string): string {
  return `${queue}/${name}`;
}

/** The top-level finite numbers and booleans of a job's result, at most eight, by name. */
export function summarizeResult(result: unknown): Record<string, number | boolean> {
  const summary: Record<string, number | boolean> = {};
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return summary;
  for (const [key, value] of Object.entries(result)) {
    if (Object.keys(summary).length >= RUN_SUMMARY_MAX) break;
    if (!SUMMARY_KEY.test(key)) continue;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) summary[key] = value;
  }
  return summary;
}

/** An error as the records keep it: its class name, with its SQLSTATE when it has one; never its message. */
export function errorKindOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const name = (error as { name?: unknown }).name;
  if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? `${name}:${code}` : name;
}
