import { one, sql } from '../query.js';
import { defineQuery } from './define.js';

/**
 * The session's device row: push token, app build, language and whether the
 * person lets it show notifications (`disabled_at` set while they do not).
 * Written only when something changed, and never as a heartbeat.
 */
export interface DeviceWrite {
  /** The FCM token, or null for a phone without push (or one that turned it off). */
  pushToken: string | null;
  /** SHA-256 of the token (devices.push_token_hash). */
  pushTokenHash: Buffer | null;
  notificationsEnabled: boolean;
  /** The build's version code (`X-Client`). */
  versionCode: number;
  locale: string;
}

/**
 * A token seen on another device row (a shared phone that changed account)
 * moves here: it is cleared there first, in the same transaction, so the
 * unique token index never refuses the update. Returns the ids of the rows
 * it was taken from (their cached fingerprints are stale from now on).
 */
export const releasePushToken = defineQuery({ name: 'devices.releaseToken', statements: 1 }, async (db, deviceId: string, hash: Buffer) => {
  const row = await one<{ ids: string[] }>(
    db,
    sql`
WITH cleared AS (
  UPDATE devices SET push_token = NULL, push_token_hash = NULL, updated_at = now()
   WHERE push_token_hash = ${hash} AND id <> ${deviceId}::bigint
  RETURNING id
)
SELECT coalesce(array_agg(id::text), '{}') AS ids FROM cleared`,
  );
  return row.ids;
});

/** Updates the device of a session; `found` is false when the row is not this user's. */
export const writeDevice = defineQuery(
  { name: 'devices.write', statements: 1 },
  async (db, userId: string, deviceId: string, w: DeviceWrite): Promise<{ found: boolean; written: boolean }> => {
    return one<{ found: boolean; written: boolean }>(
      db,
      sql`
WITH target AS (
  SELECT id FROM devices WHERE id = ${deviceId}::bigint AND user_id = ${userId}::bigint
), up AS (
  UPDATE devices d
     SET push_token = ${w.pushToken}::text, push_token_hash = ${w.pushTokenHash}::bytea,
         app_version = ${w.versionCode}::integer, locale = ${w.locale}::text,
         disabled_at = CASE WHEN ${w.notificationsEnabled}::boolean THEN NULL ELSE coalesce(d.disabled_at, now()) END,
         updated_at = now()
    FROM target t
   WHERE d.id = t.id
     AND (d.push_token, d.app_version, d.locale, d.disabled_at IS NULL)
         IS DISTINCT FROM (${w.pushToken}::text, ${w.versionCode}::integer, ${w.locale}::text, ${w.notificationsEnabled}::boolean)
  RETURNING d.id
)
SELECT EXISTS (SELECT 1 FROM target) AS found, EXISTS (SELECT 1 FROM up) AS written`,
    );
  },
);
