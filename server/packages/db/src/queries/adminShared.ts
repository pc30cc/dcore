import { z } from 'zod';
import { sql, type SqlFragment } from '../query.js';

/**
 * The pieces the admin query modules share (adminUsers, adminModeration,
 * adminRules, adminChats): ids as text, times as epoch ms, admins as
 * { id, displayName }.
 */

/** A bigint id as decimal text. */
export const adminIdText = z.string().regex(/^[1-9][0-9]{0,18}$/);
export const adminEpochMs = z.number().int().nonnegative();
export const adminRefRow = z.object({ id: z.string(), displayName: z.string() });

/** A timestamp column as epoch milliseconds (null stays null). */
export const msOf = (column: SqlFragment) => sql`floor(extract(epoch FROM ${column}) * 1000)::bigint`;

/** The admin an id column names, as { id, displayName } (null for none). */
export const adminRefSql = (column: SqlFragment) =>
  sql`(SELECT jsonb_build_object('id', a.id::text, 'displayName', a.display_name) FROM admin_users a WHERE a.id = ${column})`;

/** Whether the account exists and is not purged (status 8, a tombstone): a user page tab's 404. */
export const adminUserKept = (userId: string) => sql`EXISTS (SELECT 1 FROM users u WHERE u.id = ${userId}::bigint AND u.status <> 8)`;
