import { z } from 'zod';
import { likeKind, messageKind } from '../codes.js';
import { pageQuerySchema, pageSchema } from '../pagination.js';
import { PERMISSION_GRANT } from '../permissions.js';
import { adminRoleKeySchema, adminRoleSchema } from './admin.js';
import { sideEffectsSchema } from './adminUsers.js';
import { timeSchema } from './common.js';

/**
 * The admin panel's system area: `/v1/admin/system/*` (the jobs and health
 * page, `system.read`; its actions `system.write` and, while the deployment
 * requires one, a session opened with the second factor) and the role
 * editor (`/v1/admin/roles/*`: `admins.read`, edits `admins.manage` and the
 * second factor).
 *
 * Nothing on this wire names a person: no job id, job data or failure
 * message (job ids and data carry raw user ids and tokens); a failed stream
 * entry shows its stream, why it failed, its deliveries, when it was sent and
 * its kind, never who sent it, to whom, or in which conversation.
 */

const int = z.number().int().nonnegative();

/** Queue and job names. */
export const opsNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const streamNameSchema = z.enum(['like', 'match', 'msg']);
export type StreamName = z.infer<typeof streamNameSchema>;
/** A Valkey stream entry id (`<ms>-<seq>`). */
export const streamIdSchema = z.string().regex(/^[0-9]{1,15}-[0-9]{1,10}$/);

/** System writes one admin may make in an hour. */
export const SYSTEM_WRITES_PER_HOUR = 60;
/** Failed job ids read per queue for the overview (newest first). */
export const SYSTEM_FAILED_SCAN = 200;
/** Failed job ids a retry or a remove reads (newest first). */
export const SYSTEM_FAILED_ACTION_SCAN = 1_000;
/** Jobs one retry or remove acts on. */
export const SYSTEM_JOB_ACTION_MAX = 500;
export const SYSTEM_DEAD_LETTER_DELETE_MAX = 500;
export const SYSTEM_DEAD_LETTER_PAGE_MAX = 100;
/** A process not heard from for this long is not listed. */
export const PROCESS_STALE_MS = 90_000;
/** A partition's transaction age worth a look (autovacuum). */
export const PARTITION_XID_AGE_WARN = 150_000_000;
/** kv-core memory use that warrants attention, and danger. */
export const VALKEY_MEMORY_WARN = 0.7;
export const VALKEY_MEMORY_DANGER = 0.9;

// ─── Health ─────────────────────────────────────────────────────────────────

/** `latencyMs` in whole milliseconds (`latencyMsOf`): 0 means under 1 ms. */
const up = z.object({ status: z.enum(['up', 'down']), latencyMs: int });

export const adminSystemHealthSchema = z.object({
  at: timeSchema,
  database: up,
  valkey: z.array(
    up.extend({
      name: z.enum(['core', 'cache']),
      /** cache: no separate instance (REDIS_CACHE_URL unset), the core one serves it. */
      sharedWithCore: z.boolean(),
      usedBytes: int.nullable(),
      /** null: no limit. */
      maxBytes: int.nullable(),
      policy: z.string().nullable(),
    }),
  ),
  /** The job pipeline's beat (`system/heartbeat`, every 30 s): the worker that ran it. */
  heartbeat: z.object({ at: timeSchema, worker: z.string() }).nullable(),
  workers: z.array(
    z.object({
      name: z.string(),
      at: timeSchema,
      startedAt: timeSchema,
      cfgVersion: int.nullable(),
      queues: z.array(opsNameSchema),
      streams: z.array(streamNameSchema),
      maint: z.boolean(),
    }),
  ),
  apis: z.array(
    z.object({
      name: z.string(),
      at: timeSchema,
      startedAt: timeSchema,
      cfgVersion: int.nullable(),
      rolesVersion: int.nullable(),
      rolesFailing: z.boolean(),
      /** The process that answered. */
      self: z.boolean(),
    }),
  ),
  /** `version`: `cfg:v` now; `loaded`: what the answering process has loaded. */
  config: z.object({ version: int.nullable(), loaded: int.nullable() }),
});
export type AdminSystemHealth = z.infer<typeof adminSystemHealthSchema>;

// ─── Queues and scheduled tasks ─────────────────────────────────────────────

export const adminRunSchema = z.object({
  at: timeSchema,
  ok: z.boolean(),
  durationMs: int.nullable(),
  attempt: int,
  attempts: int,
  willRetry: z.boolean(),
  /** The error's class (and SQLSTATE), never its message. */
  error: z.string().nullable(),
  /** Started from the jobs page. */
  manual: z.boolean(),
  /** The job's own numeric result (`leased: false`: another run held the lease, so this one did nothing). */
  summary: z.record(z.string(), z.union([z.number(), z.boolean()])),
});
export type AdminRun = z.infer<typeof adminRunSchema>;

export const adminFailedGroupSchema = z.object({
  /** The job name (`other`: an id that names none). */
  name: opsNameSchema,
  count: int,
  newestAt: timeSchema,
  oldestAt: timeSchema,
  retryable: z.boolean(),
});

export const adminQueueSchema = z.object({
  name: opsNameSchema,
  paused: z.boolean(),
  /** waiting = wait + prioritized + waiting-children (a paused queue keeps its jobs in wait). */
  counts: z.object({ waiting: int, active: int, delayed: int, failed: int, completed: int }),
  failed: z.object({
    /** Failed ids read (the newest). */
    scanned: int,
    /** More failed jobs exist than were read. */
    more: z.boolean(),
    groups: z.array(adminFailedGroupSchema),
  }),
});
export type AdminQueue = z.infer<typeof adminQueueSchema>;

export const adminTaskSchema = z.object({
  queue: opsNameSchema,
  name: opsNameSchema,
  /** Every this many milliseconds, or the cron `pattern` (in `tz`). */
  every: int.nullable(),
  pattern: z.string().nullable(),
  tz: z.string().nullable(),
  nextAt: timeSchema.nullable(),
  last: adminRunSchema.nullable(),
  lastOkAt: timeSchema.nullable(),
  runnable: z.boolean(),
});
export type AdminTask = z.infer<typeof adminTaskSchema>;

export const adminSystemQueuesSchema = z.object({
  at: timeSchema,
  queues: z.array(adminQueueSchema),
  tasks: z.array(adminTaskSchema),
});
export type AdminSystemQueues = z.infer<typeof adminSystemQueuesSchema>;

// ─── Write-behind streams ───────────────────────────────────────────────────

export const adminStreamHealthSchema = z.object({
  name: streamNameSchema,
  /** Entries the stream keeps (XLEN), written ones included until a trim removes them. */
  length: int,
  /** Entries still to be written: `pending` + `undelivered`; null when the group is missing or the undelivered count is unknown. */
  waiting: int.nullable(),
  /** Delivered to the writers and not acknowledged. */
  pending: int,
  dead: int,
  lagMs: int.nullable(),
  group: z.boolean(),
  consumers: int,
  undelivered: int.nullable(),
  oldestPendingAt: timeSchema.nullable(),
  lastDeliveredAt: timeSchema.nullable(),
  watermarkLagMs: int.nullable(),
});
export const adminSystemStreamsSchema = z.object({ at: timeSchema, streams: z.array(adminStreamHealthSchema) });
export type AdminSystemStreams = z.infer<typeof adminSystemStreamsSchema>;

export const deadLetterReasons = ['rejected', 'malformed', 'deliveries', 'other'] as const;
/** What a failed entry was: a message's kind, or a like's. */
export const deadLetterKinds = [...messageKind.names, ...likeKind.names] as const;

/** A failed entry of a write-behind stream: its own id (to delete it), never a person, a conversation or a public id. */
export const adminDeadLetterSchema = z.strictObject({
  /** The failed entry's id in `wb:<stream>:dead`. */
  id: streamIdSchema,
  stream: streamNameSchema,
  /** When it failed (its id's time). */
  at: timeSchema,
  /** When it was sent (the original entry's time). */
  entryAt: timeSchema.nullable(),
  reason: z.enum(deadLetterReasons),
  deliveries: int,
  kind: z.enum(deadLetterKinds).nullable(),
});
export type AdminDeadLetter = z.infer<typeof adminDeadLetterSchema>;
export const adminDeadLetterPageSchema = pageSchema(adminDeadLetterSchema);
export const adminDeadLetterParamsSchema = z.object({ stream: streamNameSchema });
export const adminDeadLetterQuerySchema = pageQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(SYSTEM_DEAD_LETTER_PAGE_MAX).default(50),
});

// ─── Partitions ─────────────────────────────────────────────────────────────

export const adminPartitionSchema = z.object({
  name: z.string(),
  from: timeSchema,
  to: timeSchema,
  dropAfter: timeSchema.nullable(),
  rowsEstimate: int.nullable(),
  bytesEstimate: int,
  xidAge: int,
});

export const adminPartitionParentSchema = z.object({
  parent: z.string(),
  period: z.enum(['week', 'month']),
  premake: int,
  retention: z.object({ months: int, days: int }).nullable(),
  /** Partitions that start after now. */
  ahead: int,
  /** A partition holds now. */
  current: z.boolean(),
  /** When the oldest partition may be dropped. */
  nextDropAfter: timeSchema.nullable(),
  rowsEstimate: int,
  bytesEstimate: int,
  maxXidAge: int,
  /** Oldest first. */
  partitions: z.array(adminPartitionSchema),
});

export const adminSystemPartitionsSchema = z.object({ at: timeSchema, parents: z.array(adminPartitionParentSchema) });
export type AdminSystemPartitions = z.infer<typeof adminSystemPartitionsSchema>;

// ─── System writes ──────────────────────────────────────────────────────────

export const adminDeadLetterDeleteSchema = z.union([
  z.strictObject({ stream: streamNameSchema, ids: z.array(streamIdSchema).min(1).max(SYSTEM_DEAD_LETTER_DELETE_MAX) }),
  /** Every failed entry up to and including `upTo`; newer ones stay. */
  z.strictObject({ stream: streamNameSchema, upTo: streamIdSchema }),
]);
export type AdminDeadLetterDelete = z.infer<typeof adminDeadLetterDeleteSchema>;
export const adminJobGroupSchema = z.strictObject({
  queue: opsNameSchema,
  name: opsNameSchema,
  /** At most this many (the newest), e.g. the count the panel showed; never more than SYSTEM_JOB_ACTION_MAX. */
  max: z.number().int().min(1).max(SYSTEM_JOB_ACTION_MAX).optional(),
});
export const adminTaskRunSchema = z.strictObject({ queue: opsNameSchema, name: opsNameSchema });

export const adminDeadLetterDeletedSchema = z.object({ deleted: int, sideEffects: sideEffectsSchema });
export const adminJobGroupResultSchema = z.object({
  /** Failed jobs of the name found among the newest read. */
  matched: int,
  /** Those retried (or removed); a job that changed meanwhile is skipped. */
  done: int,
  /** More may remain: run it again. */
  more: z.boolean(),
  sideEffects: sideEffectsSchema,
});
export const adminTaskRunResultSchema = z.object({
  queued: z.boolean(),
  /** This minute's run was started already (it is still kept): nothing added, nothing written. */
  already: z.boolean(),
  jobId: z.string(),
  sideEffects: sideEffectsSchema,
});

// ─── Roles ──────────────────────────────────────────────────────────────────

export const ROLE_GRANTS_MAX = 64;
export const adminRoleGrantSchema = z.string().regex(PERMISSION_GRANT);
export const adminRoleParamsSchema = z.object({ key: adminRoleKeySchema });

/** `grants`: what the role holds after the save; `base`: its grants as the panel read them (a different stored set is a 409). */
export const adminRoleUpdateSchema = z.strictObject({
  grants: z.array(adminRoleGrantSchema).max(ROLE_GRANTS_MAX),
  base: z.array(adminRoleGrantSchema).max(ROLE_GRANTS_MAX),
});
export type AdminRoleUpdate = z.infer<typeof adminRoleUpdateSchema>;

export const adminRoleUpdatedSchema = z.object({
  role: adminRoleSchema,
  /** Holders signed out because access was taken away (none when it only grew). */
  signedOut: z.object({ admins: int, sessions: int }),
  /** Every API process was told (false: they pick it up within a minute). */
  announced: z.boolean(),
  sideEffects: sideEffectsSchema,
});
export type AdminRoleUpdated = z.infer<typeof adminRoleUpdatedSchema>;

export const adminRoleHoldersSchema = z.object({ items: z.array(z.object({ key: adminRoleKeySchema, admins: int })) });
export type AdminRoleHolders = z.infer<typeof adminRoleHoldersSchema>;
