import { joinSql, query, sql } from '../query.js';
import { defineQuery } from './define.js';

/**
 * audit_log rows (0008): append-only, monthly partitions by id. Every admin
 * write and every sensitive view writes its row in the transaction of the
 * change itself, so a rollback leaves neither. `detail` holds the
 * before/after of what changed and never a secret.
 */

export interface AuditRow {
  /** An application id; null mints one in the database (`id_next()`, for tools without an id lease). */
  id: string | null;
  /** The acting admin; null is the system. */
  adminId: number | null;
  /** The acting admin's session (admin_sessions.id). */
  sessionId: string | null;
  ip: string | null;
  /** audit_log.target_type (`auditTarget` in @app/shared). */
  targetType: number;
  /** The row the action is about, as a decimal id. */
  targetId: string | null;
  /** `area.verb`, e.g. `admin.disable`. */
  action: string;
  detail: Record<string, unknown> | null;
}

export class AuditWriteError extends Error {
  constructor(expected: number, written: number) {
    super(`audit: ${written} of ${expected} rows written`);
    this.name = 'AuditWriteError';
  }
}

/** Writes audit rows in one statement; throws when any row is missing (the caller's transaction then rolls back). */
export const insertAuditRows = defineQuery({ name: 'audit.insert', statements: 1 }, async (tx, rows: readonly AuditRow[]): Promise<void> => {
  if (rows.length === 0) throw new RangeError('audit: no rows to write');
  const values = rows.map(
    (row) =>
      sql`(coalesce(${row.id}::bigint, id_next()), ${row.targetId}::bigint, ${row.sessionId}::bigint, ${row.adminId}::integer,
           ${row.targetType}::smallint, ${row.ip}::inet, ${row.action}::text, ${row.detail === null ? null : JSON.stringify(row.detail)}::jsonb)`,
  );
  const result = await query(
    tx,
    sql`INSERT INTO audit_log (id, target_id, session_id, admin_id, target_type, ip, action, detail) VALUES ${joinSql(values)}`,
  );
  if (result.rowCount !== rows.length) throw new AuditWriteError(rows.length, result.rowCount ?? 0);
});
