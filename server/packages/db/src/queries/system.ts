import { z } from 'zod';
import { many, maybeOne, one, sql } from '../query.js';
import { defineQuery } from './define.js';

/**
 * The admin panel's system area (0039): the partitions overview, read from
 * the catalog in one statement, and the role editor's writes on the small
 * role tables (`admin_roles`, `admin_role_permissions`, `admin_user_roles`,
 * `admin_sessions` of the role's holders). The role rules live in the
 * database too (`admin_role_rules()`), which refuses with check_violation and
 * the rule's name in the hint.
 */

// ─── Partitions ────────────────────────────────────────────────────────────

/** A bigint column cast to text and back: every value here stays below 2^53. */
const bigintText = z.string().regex(/^-?[0-9]{1,19}$/).transform(Number);
const nullableBigint = bigintText.nullable();

const partitionRow = z.object({
  parent: z.string(),
  period: z.enum(['week', 'month']),
  premake: z.number().int(),
  retention_months: z.number().int().nullable(),
  retention_days: z.number().int().nullable(),
  partition_name: z.string(),
  from_ms: nullableBigint,
  to_ms: nullableBigint,
  drop_after_ms: nullableBigint,
  rows_estimate: nullableBigint,
  bytes_estimate: bigintText,
  xid_age: z.number().int(),
});

export interface PartitionOverviewRow {
  parent: string;
  period: 'week' | 'month';
  premake: number;
  /** The parent's retention as months and days (null: every partition is kept). */
  retention: { months: number; days: number } | null;
  name: string;
  fromMs: number | null;
  toMs: number | null;
  /** When `partition_drop_expired()` may drop it (null: kept). */
  dropAfterMs: number | null;
  /** The planner's estimate; null before the first ANALYZE. */
  rowsEstimate: number | null;
  bytesEstimate: number;
  xidAge: number;
}

/** Every partition of every registered parent, by parent and name (oldest first). */
export const partitionsOverview = defineQuery({ name: 'system.partitions', statements: 1 }, async (db): Promise<PartitionOverviewRow[]> => {
  const rows = await many(
    db,
    sql`SELECT parent, period, premake::integer AS premake, retention_months, retention_days, partition_name,
               from_ms::text AS from_ms, to_ms::text AS to_ms, drop_after_ms::text AS drop_after_ms,
               rows_estimate::text AS rows_estimate, bytes_estimate::text AS bytes_estimate, xid_age
          FROM partitions_overview()`,
  );
  return rows.map((raw) => {
    const row = partitionRow.parse(raw);
    return {
      parent: row.parent,
      period: row.period,
      premake: row.premake,
      retention: row.retention_months === null && row.retention_days === null ? null : { months: row.retention_months ?? 0, days: row.retention_days ?? 0 },
      name: row.partition_name,
      fromMs: row.from_ms,
      toMs: row.to_ms,
      dropAfterMs: row.drop_after_ms,
      rowsEstimate: row.rows_estimate,
      bytesEstimate: row.bytes_estimate,
      xidAge: row.xid_age,
    };
  });
});

// ─── The role editor ───────────────────────────────────────────────────────

export interface AdminRoleLocked {
  id: number;
  key: string;
  names: Record<string, string>;
  /** Every stored grant, sorted (also those this build does not know). */
  grants: string[];
  /** The role keys of every admin holding the role (disabled ones too), each sorted. */
  holders: string[][];
}

const lockedRow = z.object({
  id: z.number().int(),
  key: z.string(),
  names: z.record(z.string(), z.unknown()),
  grants: z.array(z.string()),
  holders: z.array(z.array(z.string())),
});

/*
 * The row lock in a statement of its own, then the grants and holders in the
 * next one. Read in the locking statement itself they would be stale after a
 * wait for the lock: READ COMMITTED fetches the locked row again, but its
 * subqueries keep the snapshot taken before the wait, so a second save would
 * check (and audit) the grants as they were before the first one committed.
 */

/** The role, its grants and its holders' roles, the role's row locked until the transaction ends; null when there is none. */
export const adminRoleForUpdate = defineQuery({ name: 'system.roleForUpdate', statements: 2 }, async (tx, key: string): Promise<AdminRoleLocked | null> => {
  const locked = await maybeOne<{ id: number }>(tx, sql`SELECT r.id::integer AS id FROM admin_roles r WHERE r.key = ${key}::text FOR UPDATE`);
  if (!locked) return null;
  const row = await maybeOne(
    tx,
    sql`SELECT r.id::integer AS id, r.key, r.names,
               ARRAY(SELECT p.permission FROM admin_role_permissions p WHERE p.role_id = r.id ORDER BY p.permission) AS grants,
               coalesce((SELECT jsonb_agg(h.roles)
                           FROM (SELECT array_agg(o.key ORDER BY o.key) AS roles
                                   FROM admin_user_roles ur
                                   JOIN admin_user_roles other ON other.admin_id = ur.admin_id
                                   JOIN admin_roles o ON o.id = other.role_id
                                  WHERE ur.role_id = r.id
                                  GROUP BY ur.admin_id) h), '[]'::jsonb) AS holders
          FROM admin_roles r
         WHERE r.id = ${Number(locked.id)}::smallint`,
  );
  if (!row) return null;
  const parsed = lockedRow.parse(row);
  const names = Object.fromEntries(Object.entries(parsed.names).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  return { ...parsed, names };
});

export interface RoleGrantsChange {
  added: string[];
  removed: string[];
}

/**
 * Makes the role's grants exactly `grants`: the others are deleted, the
 * missing ones inserted (rows already there are left alone, so the rule
 * trigger checks only what is new).
 */
export const adminRoleSetGrants = defineQuery(
  { name: 'system.roleSetGrants', statements: 1 },
  async (tx, roleId: number, grants: readonly string[]): Promise<RoleGrantsChange> => {
    const row = await one<{ removed: string[]; added: string[] }>(
      tx,
      sql`WITH gone AS (
            DELETE FROM admin_role_permissions
             WHERE role_id = ${roleId}::smallint AND permission <> ALL (${grants}::text[])
         RETURNING permission
          ), added AS (
            INSERT INTO admin_role_permissions (role_id, permission)
            SELECT ${roleId}::smallint, g
              FROM unnest(${grants}::text[]) g
             WHERE NOT EXISTS (SELECT 1 FROM admin_role_permissions p WHERE p.role_id = ${roleId}::smallint AND p.permission = g)
            ON CONFLICT DO NOTHING
         RETURNING permission
          )
          SELECT ARRAY(SELECT permission FROM gone ORDER BY 1) AS removed,
                 ARRAY(SELECT permission FROM added ORDER BY 1) AS added`,
    );
    return { added: row.added, removed: row.removed };
  },
);

export interface RoleHolderSignOut {
  sessionIds: string[];
  /** Distinct admins whose sessions ended. */
  admins: number;
}

/** Ends every live (unexpired, unrevoked) session of every holder of the role (but `exceptAdminId`'s). */
export const adminRevokeRoleHolderSessions = defineQuery(
  { name: 'system.roleSignOut', statements: 1 },
  async (tx, roleId: number, reason: number, exceptAdminId: number): Promise<RoleHolderSignOut> => {
    const rows = await many<{ id: string; admin_id: number }>(
      tx,
      sql`UPDATE admin_sessions s
             SET revoked_at = now(), revoke_reason = ${reason}::smallint
            FROM admin_user_roles ur
           WHERE ur.role_id = ${roleId}::smallint
             AND s.admin_id = ur.admin_id
             AND s.admin_id <> ${exceptAdminId}::integer
             AND s.revoked_at IS NULL
             AND s.expires_at > now()
       RETURNING s.id::text AS id, s.admin_id`,
    );
    return { sessionIds: rows.map((r) => r.id), admins: new Set(rows.map((r) => Number(r.admin_id))).size };
  },
);

export interface RoleHolders {
  key: string;
  /** Enabled admins holding the role. */
  admins: number;
}

/** How many enabled admins hold each role, in role id order. */
export const adminRoleHolders = defineQuery({ name: 'system.roleHolders', statements: 1 }, async (db): Promise<RoleHolders[]> => {
  const rows = await many<{ key: string; admins: number }>(
    db,
    sql`SELECT r.key, count(u.id)::integer AS admins
          FROM admin_roles r
          LEFT JOIN admin_user_roles ur ON ur.role_id = r.id
          LEFT JOIN admin_users u ON u.id = ur.admin_id AND u.disabled_at IS NULL
         GROUP BY r.id
         ORDER BY r.id`,
  );
  return rows.map((r) => ({ key: r.key, admins: Number(r.admins) }));
});
