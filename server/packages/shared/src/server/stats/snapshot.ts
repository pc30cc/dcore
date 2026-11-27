import { z } from 'zod';

/**
 * The stats/live snapshot in Valkey (`stats:live`, JSON, 10 minutes), written
 * once a minute by the worker and read by `GET /v1/admin/stats/live`, which
 * parses it with `safeParse` (a value of another shape reads as none).
 */

const int = z.number().int().nonnegative();

export const statsLiveSnapshotSchema = z.object({
  at: z.string(),
  /** The UTC day of the counts (`YYYY-MM-DD`). */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Centrifugo's connected users (all nodes); null: unknown. */
  online: int.nullable(),
  /** Test accounts in today's `la:` set (the API subtracts them from its count). */
  testActive: int,
  db: z.object({
    signups: int,
    matches: int,
    calls: int,
    callsAnswered: int,
    reports: int,
    photos: int,
    texts: int,
    reportsOpen: int,
    reportsUrgent: int,
    appeals: int,
    tickets: int,
    revenue: z.array(z.object({ currency: z.string().regex(/^[A-Z]{3}$/), micros: z.string().regex(/^-?[0-9]{1,19}$/), estimated: z.boolean() })),
  }),
  streams: z.array(z.object({ name: z.enum(['like', 'match', 'msg']), length: int, pending: int, dead: int, lagMs: int.nullable() })),
  jobs: z.array(z.object({ queue: z.string(), waiting: int, active: int, delayed: int, failed: int })),
});
export type StatsLiveSnapshot = z.infer<typeof statsLiveSnapshotSchema>;

/** How long the snapshot is kept: without a new one for 10 minutes the dashboard shows none. */
export const STATS_LIVE_TTL_SECONDS = 600;

/** How long the test-account set `stats:testids` is kept (stats/live rewrites it when the set changes or a third of this is left). */
export const STATS_TEST_IDS_TTL_SECONDS = 900;
