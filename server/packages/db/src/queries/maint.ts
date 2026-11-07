import { many, one, sql } from '../query.js';
import { defineQuery } from './define.js';

/**
 * The worker's maintenance statements (queue `maint`). Each is one
 * autocommit statement, so nothing holds a lock of one table while the next
 * is touched, and each works through PgBouncer in transaction mode.
 * Partition maintenance is EXECUTE for `app_maint` only (0009): the worker's
 * login role is a member, the API's is not.
 */

/** The parents partition maintenance works on (registry `partitioned_tables`). */
export const partitionParents = defineQuery({ name: 'maint.partitionParents', statements: 1 }, async (db) => {
  const rows = await many<{ parent: string }>(db, sql`SELECT parent FROM partitioned_tables ORDER BY parent`);
  return rows.map((r) => r.parent);
});

export interface PartitionAction {
  /** `ensure`, `ensure_deferred`, `dropped`, `drop_deferred` or `drop_held`. */
  action: string;
  partition: string;
}

/** The current period and the periods ahead of one parent (`partitions_maintain`). */
export const maintainPartitions = defineQuery({ name: 'maint.partitions', statements: 1 }, async (db, parent: string) => {
  const rows = await many<{ action: string; partition_name: string }>(
    db,
    sql`SELECT action, partition_name FROM partitions_maintain(${parent}::text)`,
  );
  return rows.map((r) => ({ action: r.action, partition: r.partition_name }) satisfies PartitionAction);
});

/** Drops at most one expired partition of one parent (`partition_drop_expired`); empty when nothing is due. */
export const dropExpiredPartition = defineQuery({ name: 'maint.dropExpired', statements: 1 }, async (db, parent: string) => {
  const rows = await many<{ action: string; partition_name: string }>(
    db,
    sql`SELECT action, partition_name FROM partition_drop_expired(${parent}::text)`,
  );
  return rows.map((r) => ({ action: r.action, partition: r.partition_name }) satisfies PartitionAction);
});

/** "Active on `day`" for a batch of accounts (`users_mark_active`); the users rows written. */
export const markActive = defineQuery({ name: 'maint.markActive', statements: 1 }, async (db, userIds: readonly string[], day: string) => {
  const row = await one<{ n: number }>(db, sql`SELECT users_mark_active(${userIds}::bigint[], ${day}::date) AS n`);
  return row.n;
});

/**
 * One chunk of the weekly sessions clean-up: of the next `limit` sessions
 * after `after` in primary-key order, deletes those revoked or expired
 * before `cutoff`. Walking the primary key keeps each statement bounded
 * without an index on the timestamps. `last` is null once the table ends.
 */
export const deleteStaleSessions = defineQuery(
  { name: 'maint.staleSessions', statements: 1 },
  async (db, after: string, limit: number, cutoff: Date): Promise<{ last: string | null; deleted: number }> => {
    return one<{ last: string | null; deleted: number }>(
      db,
      sql`
WITH chunk AS (
  SELECT id FROM sessions WHERE id > ${after}::bigint ORDER BY id LIMIT ${limit}::integer
), gone AS (
  DELETE FROM sessions s
   USING chunk c
   WHERE s.id = c.id
     AND ((s.revoked_at IS NOT NULL AND s.revoked_at < ${cutoff}::timestamptz) OR s.expires_at < ${cutoff}::timestamptz)
  RETURNING s.id
)
SELECT (SELECT max(id) FROM chunk)::text AS last, (SELECT count(gone.id) FROM gone)::integer AS deleted`,
    );
  },
);
