import { z } from 'zod';
import { jobId } from './queues.js';

/**
 * The `account` queue's deletion jobs, as the API queues them and the
 * worker runs them:
 *
 * - `deletion-fanout` (`deletion-fanout.<uid>.<deletedAtMs>`, at once): the
 *   Valkey side of a deletion (the person's conversations leave their
 *   peers' lists, `conversation_end` to each peer, the card and deck queue
 *   go, `vis:out`) and the Centrifugo disconnect.
 * - `purge` (`purge.<uid>.<deletedAtMs>`, delayed to the purge time): the
 *   tombstone (`account_purge()`), then the photo blobs and rows.
 * - `deletion-sweep` (scheduled): queues again a purge whose job was lost,
 *   and a fan-out that could not be queued.
 *
 * The deletion time is part of both ids, so a deletion after a restore gets
 * jobs of its own while the earlier ones are still kept.
 */

export const ACCOUNT_QUEUE = 'account' as const;

export const accountJobNames = {
  fanout: 'deletion-fanout',
  purge: 'purge',
  sweep: 'deletion-sweep',
} as const;

const id = z.string().regex(/^[1-9][0-9]{0,18}$/);
const epochMs = z.number().int().nonnegative();

export const deletionFanoutDataSchema = z.object({
  userId: id,
  deletedAtMs: epochMs,
  /** Ids of the `conversation_end` events by conversation, minted once so a retried publish is delivered once. */
  eventIds: z.record(id, id).optional(),
});
export type DeletionFanoutData = z.infer<typeof deletionFanoutDataSchema>;

export const purgeDataSchema = z.object({
  userId: id,
  deletedAtMs: epochMs,
  /** When it was due when queued; the purge itself checks the current rule. */
  purgeAtMs: epochMs,
});
export type PurgeData = z.infer<typeof purgeDataSchema>;

export const accountJobIds = {
  fanout: (userId: string, deletedAtMs: number) => jobId(accountJobNames.fanout, userId, deletedAtMs),
  purge: (userId: string, deletedAtMs: number) => jobId(accountJobNames.purge, userId, deletedAtMs),
};

/** Attempts of the deletion jobs: a fan-out retries for about an hour, a purge for about a day; an export for about two hours. */
export const accountJobAttempts = {
  fanout: { attempts: 8, backoffMs: 15_000 },
  purge: { attempts: 12, backoffMs: 60_000 },
  export: { attempts: 8, backoffMs: 30_000 },
} as const;

/**
 * `export` (`export.<exportId>`, at once): the account's data as a ZIP in the
 * private bucket (`exports/<exportId>.zip`), announced to the person with a
 * link valid {@link EXPORT_LINK_TTL_SECONDS}; the same job deletes the archive
 * when the link has run out. One export a person per {@link EXPORT_EVERY_SECONDS}
 * (`exp:<uid>`, set by the API).
 */
export const EXPORT_JOB = 'export' as const;
export const EXPORT_LINK_TTL_SECONDS = 24 * 3_600;
export const EXPORT_EVERY_SECONDS = 7 * 86_400;

export const exportDataSchema = z.object({
  userId: id,
  exportId: id,
  /** Kept by the job: the archive's key once stored, the event's id, and when the link runs out. */
  stored: z.object({ key: z.string().regex(/^exports\/[1-9][0-9]{0,18}\.zip$/), eventId: id, expiresAtMs: epochMs }).optional(),
  published: z.boolean().optional(),
});
export type ExportData = z.infer<typeof exportDataSchema>;

export const exportJobId = (exportId: string): string => jobId(EXPORT_JOB, exportId);

/** The archive's key in the private bucket: the export's id, never a person's. */
export const exportObjectKey = (exportId: string): string => {
  if (!/^[1-9][0-9]{0,18}$/.test(exportId)) throw new TypeError('not an export id');
  return `exports/${exportId}.zip`;
};
