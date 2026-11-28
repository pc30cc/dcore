import type { Redis } from 'ioredis';
import { z } from 'zod';
import { PROCESS_STALE_MS } from '../../api/adminSystem.js';
import type { KeyBuilder } from '../kv/keys.js';
import { OPS_NAME } from './policy.js';
import { writeBehindStreams } from './streams.js';

/**
 * The live processes, as the jobs page lists them, read from the report each
 * process already writes to `prov:applied` (one field per process: `api:<name>`
 * or `worker:<id>`): next to the providers it applied, the report carries
 * `proc`, the process's own state (when it started, the settings version it
 * has loaded and, for an API process, the roles version; for a worker, the
 * queues and streams it runs). Every process writes its report on a timer
 * and after each load, never per request; a stopped process removes its
 * field, and a report older than {@link PROCESS_STALE_MS} is not listed.
 */

/** How often each process writes its report. */
export const PROCESS_REPORT_EVERY_MS = 30_000;

const int = z.number().int().nonnegative();

export const apiProcessSchema = z.object({
  kind: z.literal('api'),
  startedAtMs: int,
  /** The `cfg:v` of the configuration this process has loaded. */
  cfgVersion: int.nullable(),
  /** The configuration version the roles in memory were loaded for. */
  rolesVersion: int.nullable(),
  /** The last load of the roles failed (it is retried). */
  rolesFailing: z.boolean(),
});

export const workerProcessSchema = z.object({
  kind: z.literal('worker'),
  startedAtMs: int,
  /** The `cfg:v` this worker last read its provider entries for. */
  cfgVersion: int.nullable(),
  queues: z.array(z.string().regex(OPS_NAME)).max(64),
  streams: z.array(z.enum(writeBehindStreams)).max(8),
  /** The maintenance queue runs here (MAINT_ENABLED). */
  maint: z.boolean(),
});

export const processInfoSchema = z.discriminatedUnion('kind', [apiProcessSchema, workerProcessSchema]);
export type ProcessInfo = z.infer<typeof processInfoSchema>;

const reportSchema = z.object({ atMs: int, proc: processInfoSchema });

export interface ProcessEntry {
  /** The report's field (`api:<name>`, `worker:<id>`). */
  field: string;
  name: string;
  atMs: number;
  info: ProcessInfo;
}

function parseReport(value: string): z.infer<typeof reportSchema> | null {
  try {
    const result = reportSchema.safeParse(JSON.parse(value));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** A report older than this belongs to a process that stopped without removing it (killed, host restarted): it is removed. */
export const PROCESS_PRUNE_MS = 3_600_000;

/** When a report was written (null: not a report at all). */
function reportTime(value: string): number | null {
  try {
    const atMs = (JSON.parse(value) as { atMs?: unknown } | null)?.atMs;
    return typeof atMs === 'number' && Number.isSafeInteger(atMs) ? atMs : null;
  } catch {
    return null;
  }
}

/**
 * The processes whose report is fresh, API processes first, each by name;
 * throws when Valkey cannot be read. Reports older than {@link PROCESS_PRUNE_MS}
 * (or unreadable) are removed in one best-effort HDEL, so the hash keeps one
 * field per live process however processes end.
 */
export async function readProcesses(redis: Redis, keys: KeyBuilder, now: number = Date.now()): Promise<ProcessEntry[]> {
  const raw = await redis.hgetall(keys.providersApplied());
  const entries: ProcessEntry[] = [];
  const stale: string[] = [];
  for (const [field, value] of Object.entries(raw)) {
    const atMs = reportTime(value);
    if (atMs === null || now - atMs > PROCESS_PRUNE_MS) {
      stale.push(field);
      continue;
    }
    const at = field.indexOf(':');
    const kind = field.slice(0, at);
    if (at < 1 || (kind !== 'api' && kind !== 'worker')) continue;
    const parsed = parseReport(value);
    if (parsed?.proc.kind !== kind || now - parsed.atMs > PROCESS_STALE_MS) continue;
    entries.push({ field, name: field.slice(at + 1), atMs: parsed.atMs, info: parsed.proc });
  }
  if (stale.length > 0) await redis.hdel(keys.providersApplied(), ...stale).catch(() => undefined);
  return entries.sort((a, b) => a.info.kind.localeCompare(b.info.kind) || a.name.localeCompare(b.name));
}
