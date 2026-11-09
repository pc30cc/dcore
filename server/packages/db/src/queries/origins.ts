import { execute, maybeOne, sql } from '../query.js';
import { defineQuery } from './define.js';

/**
 * The stored hosts of the origins document (app_config `origins.hosts`).
 * The value is JSON the caller validates (`originsSettingsSchema` in
 * `@app/shared`); null means the panel never saved hosts.
 */

export const ORIGINS_CONFIG_KEY = 'origins.hosts';

/** The stored value, as the admin panel reads it (never the cached copy). */
export const originsSettingsValue = defineQuery({ name: 'origins.settings', statements: 1 }, async (db): Promise<unknown> => {
  const row = await maybeOne<{ value: unknown }>(db, sql`SELECT c.value FROM app_config c WHERE c.key = ${ORIGINS_CONFIG_KEY}::text`);
  return row?.value ?? null;
});

/** The stored value, locked until the transaction ends: two saves never take the same version. */
export const originsSettingsForUpdate = defineQuery({ name: 'origins.settingsForUpdate', statements: 1 }, async (tx): Promise<unknown> => {
  const row = await maybeOne<{ value: unknown }>(tx, sql`SELECT c.value FROM app_config c WHERE c.key = ${ORIGINS_CONFIG_KEY}::text FOR UPDATE`);
  return row?.value ?? null;
});

export interface OriginsAudit {
  auditId: string;
  adminId: number | null;
  sessionId: string | null;
  ip: string | null;
  /** The version and the hosts before and after (hosts are not secrets). */
  detail: Record<string, unknown>;
}

/** Saves the hosts and their audit row (`config.update`, target config) in one statement. */
export const saveOriginsSettings = defineQuery(
  { name: 'origins.save', statements: 1 },
  async (tx, value: unknown, audit: OriginsAudit): Promise<void> => {
    const written = await execute(
      tx,
      sql`WITH saved AS (
            INSERT INTO app_config (key, value, updated_at, updated_by)
            VALUES (${ORIGINS_CONFIG_KEY}::text, ${JSON.stringify(value)}::jsonb, now(), ${audit.adminId}::integer)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by
            RETURNING key)
          INSERT INTO audit_log (id, target_id, session_id, admin_id, target_type, ip, action, detail)
          SELECT ${audit.auditId}::bigint, NULL, ${audit.sessionId}::bigint, ${audit.adminId}::integer, 6, ${audit.ip}::inet,
                 'config.update', ${JSON.stringify({ key: ORIGINS_CONFIG_KEY, ...audit.detail })}::jsonb
            FROM saved`,
    );
    if (written !== 1) throw new Error('origins: the audit row was not written');
  },
);
