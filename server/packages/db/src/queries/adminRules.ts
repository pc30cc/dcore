import { z } from 'zod';
import { joinSql, many, maybeOne, one, sql, type SqlFragment } from '../query.js';
import { adminAuditRowSql, adminUserRefRowSchema, parseAdminAuditRow, type AdminAuditRow } from './adminUsers.js';
import { defineQuery } from './define.js';
import { adminEpochMs, adminIdText, adminRefRow, adminRefSql, msOf } from './adminShared.js';

/**
 * The admin panel's rules and records: banned terms, device / phone /
 * Google-account bans, and the audit log's search and export. People are
 * raw ids here (the API turns them into public ids); codes stay codes and
 * times are epoch ms (ids as text).
 *
 * Lists are keyset-paged by id, newest first, with `LIMIT n + 1`: terms and
 * bans from their primary keys (bans of one kind from device_bans_kind_idx),
 * the audit log from the index its filter names (audit_log_admin_idx,
 * audit_log_target_idx, audit_log_action_idx, audit_log_target_type_idx) or
 * its primary key's id range (a time range is an id range). Nothing is
 * counted. Ban hashes never leave this module.
 */

const id = adminIdText;
const epochMs = adminEpochMs;
const adminRef = adminRefRow;
const ms = msOf;
const adminRefOf = adminRefSql;

// ─── Banned terms ─────────────────────────────────────────────────────────

const termRow = z.object({
  id,
  term: z.string(),
  matchKind: z.number().int().min(1).max(3),
  severity: z.number().int().min(1).max(3),
  scope: z.number().int().min(1).max(31),
  locale: z.string().nullable(),
  active: z.boolean(),
  createdAtMs: epochMs,
  createdBy: adminRef.nullable(),
});
export type AdminBannedTermRow = z.infer<typeof termRow>;

/** A banned term as the panel shows it (alias `t`). */
const termRowSql = sql`jsonb_build_object(
  'id', t.id::text, 'term', t.term, 'matchKind', t.match_kind, 'severity', t.severity, 'scope', t.scope,
  'locale', t.locale, 'active', t.is_active, 'createdAtMs', ${ms(sql`t.created_at`)}, 'createdBy', ${adminRefOf(sql`t.created_by`)})`;

/** `%`, `_` and `\` of a search text taken literally by ILIKE … ESCAPE '\'. */
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Terms, newest first; `q`: a part of the term (a residual filter over the primary key: the table holds hundreds of rows). */
export const adminBannedTermList = defineQuery(
  { name: 'adminRules.termList', statements: 1 },
  async (db, options: { q?: string | undefined; beforeId?: string | null | undefined; limit: number }): Promise<AdminBannedTermRow[]> => {
    const conditions: SqlFragment[] = [sql`TRUE`];
    if (options.q) conditions.push(sql`t.term ILIKE '%' || ${likeLiteral(options.q)} || '%' ESCAPE '\\'`);
    if (options.beforeId) conditions.push(sql`t.id < ${options.beforeId}::bigint`);
    const rows = await many<{ item: unknown }>(
      db,
      sql`SELECT ${termRowSql} AS item FROM banned_terms t WHERE ${joinSql(conditions, sql` AND `)} ORDER BY t.id DESC LIMIT ${options.limit}`,
    );
    return rows.map((r) => termRow.parse(r.item));
  },
);

export interface BannedTermInput {
  term: string;
  matchKind: number;
  severity: number;
  scope: number;
  locale: string | null;
  active: boolean;
}

/** A new term; null when the same term, match and language exists (banned_terms_key). */
export const adminCreateBannedTerm = defineQuery(
  { name: 'adminRules.termCreate', statements: 1 },
  async (tx, input: BannedTermInput & { adminId: number | null }): Promise<AdminBannedTermRow | null> => {
    const row = await maybeOne<{ item: unknown }>(
      tx,
      sql`INSERT INTO banned_terms AS t (created_by, match_kind, severity, scope, is_active, locale, term)
          VALUES (${input.adminId}::integer, ${input.matchKind}::smallint, ${input.severity}::smallint, ${input.scope}::smallint,
                  ${input.active}, ${input.locale}::text, ${input.term})
          ON CONFLICT ON CONSTRAINT banned_terms_key DO NOTHING
          RETURNING ${termRowSql} AS item`,
    );
    return row ? termRow.parse(row.item) : null;
  },
);

export type BannedTermUpdate =
  | { outcome: 'missing' }
  | { outcome: 'conflict' }
  | { outcome: 'unchanged'; term: AdminBannedTermRow }
  | { outcome: 'updated'; before: AdminBannedTermRow; after: AdminBannedTermRow };

/**
 * Changes a term in one statement: the row is locked, the change applied
 * only when it changes something and leaves the key unique, and the rows
 * before and after are answered. `locale` undefined keeps it, null makes
 * the term apply in every language.
 */
export const adminUpdateBannedTerm = defineQuery(
  { name: 'adminRules.termUpdate', statements: 1 },
  async (tx, termId: string, patch: Partial<BannedTermInput>): Promise<BannedTermUpdate> => {
    const row = await maybeOne<{ before: unknown; after: unknown; conflict: boolean }>(
      tx,
      sql`WITH c AS (SELECT * FROM banned_terms WHERE id = ${termId}::bigint FOR UPDATE),
               n AS (SELECT c.id,
                            ${patch.term === undefined ? sql`c.term` : sql`${patch.term}::text`} AS term,
                            ${patch.matchKind === undefined ? sql`c.match_kind` : sql`${patch.matchKind}::smallint`} AS match_kind,
                            ${patch.severity === undefined ? sql`c.severity` : sql`${patch.severity}::smallint`} AS severity,
                            ${patch.scope === undefined ? sql`c.scope` : sql`${patch.scope}::smallint`} AS scope,
                            ${patch.locale === undefined ? sql`c.locale` : sql`${patch.locale}::text`} AS locale,
                            ${patch.active === undefined ? sql`c.is_active` : sql`${patch.active}::boolean`} AS is_active
                       FROM c),
               dup AS (SELECT EXISTS (SELECT 1 FROM banned_terms o, n
                                       WHERE o.id <> n.id AND o.term = n.term AND o.match_kind = n.match_kind
                                         AND o.locale IS NOT DISTINCT FROM n.locale) AS v),
               u AS (UPDATE banned_terms t
                        SET term = n.term, match_kind = n.match_kind, severity = n.severity, scope = n.scope, locale = n.locale, is_active = n.is_active
                       FROM n, dup
                      WHERE t.id = n.id AND NOT dup.v
                        AND (t.term, t.match_kind, t.severity, t.scope, t.locale, t.is_active)
                            IS DISTINCT FROM (n.term, n.match_kind, n.severity, n.scope, n.locale, n.is_active)
                  RETURNING ${termRowSql} AS item)
          SELECT (SELECT ${termRowSql} FROM c t) AS before, (SELECT item FROM u) AS after, (SELECT v FROM dup) AS conflict
           WHERE EXISTS (SELECT 1 FROM c)`,
    );
    if (!row) return { outcome: 'missing' };
    const before = termRow.parse(row.before);
    if (row.after !== null) return { outcome: 'updated', before, after: termRow.parse(row.after) };
    if (row.conflict) return { outcome: 'conflict' };
    return { outcome: 'unchanged', term: before };
  },
);

/** Removes a term; null when there is none. */
export const adminDeleteBannedTerm = defineQuery({ name: 'adminRules.termDelete', statements: 1 }, async (tx, termId: string): Promise<AdminBannedTermRow | null> => {
  const row = await maybeOne<{ item: unknown }>(tx, sql`DELETE FROM banned_terms t WHERE t.id = ${termId}::bigint RETURNING ${termRowSql} AS item`);
  return row ? termRow.parse(row.item) : null;
});

// ─── Device bans ──────────────────────────────────────────────────────────

const banRow = z.object({
  id,
  kind: z.number().int().min(1).max(3),
  store: z.number().int().nullable(),
  reason: z.string(),
  createdAtMs: epochMs,
  createdBy: adminRef.nullable(),
  expiresAtMs: epochMs.nullable(),
  active: z.boolean(),
  user: adminUserRefRowSchema.nullable(),
  actionId: id.nullable(),
});
export type AdminDeviceBanRow = z.infer<typeof banRow>;

/** A ban as the panel shows it (alias `b`): the person through the record that made it, never the hash. */
const banRowSql = sql`jsonb_build_object(
  'id', b.id::text, 'kind', b.kind, 'store', b.store, 'reason', b.reason, 'createdAtMs', ${ms(sql`b.created_at`)},
  'createdBy', ${adminRefOf(sql`b.created_by`)}, 'expiresAtMs', ${ms(sql`b.expires_at`)},
  'active', (b.expires_at IS NULL OR b.expires_at > now()),
  'user', (SELECT admin_user_ref(u) FROM moderation_actions m JOIN users u ON u.id = m.user_id WHERE m.id = b.action_id),
  'actionId', b.action_id::text)`;

/** Bans, newest first; of one kind from device_bans_kind_idx. */
export const adminDeviceBanList = defineQuery(
  { name: 'adminRules.banList', statements: 1 },
  async (db, options: { kind?: number | undefined; beforeId?: string | null | undefined; limit: number }): Promise<AdminDeviceBanRow[]> => {
    const conditions: SqlFragment[] = [sql`TRUE`];
    if (options.kind !== undefined) conditions.push(sql`b.kind = ${options.kind}::smallint`);
    if (options.beforeId) conditions.push(sql`b.id < ${options.beforeId}::bigint`);
    const rows = await many<{ item: unknown }>(
      db,
      sql`SELECT ${banRowSql} AS item FROM device_bans b WHERE ${joinSql(conditions, sql` AND `)} ORDER BY b.id DESC LIMIT ${options.limit}`,
    );
    return rows.map((r) => banRow.parse(r.item));
  },
);

/** The phone bans of a number, by its hash under each pepper (device_bans_value_idx): every cause's row. */
export const adminPhoneBans = defineQuery({ name: 'adminRules.phoneBans', statements: 1 }, async (db, hashes: readonly Buffer[]): Promise<AdminDeviceBanRow[]> => {
  const rows = await many<{ item: unknown }>(
    db,
    sql`SELECT ${banRowSql} AS item FROM device_bans b WHERE b.kind = 2 AND b.value_hash = ANY(${[...hashes]}::bytea[]) ORDER BY b.id DESC`,
  );
  return rows.map((r) => banRow.parse(r.item));
});

/**
 * A renewal (the target aliased `b`) of the same cause's row (0028: one row
 * per cause of a value): the admin's reason and author, the longer expiry
 * wins and a permanent ban stays permanent. Another cause's row of the same
 * value (the server's own, a typed number, another record) is never its
 * arbiter, so it keeps its author, its record and its removal.
 */
function renewOf(arbiter: SqlFragment): SqlFragment {
  return sql`ON CONFLICT ${arbiter} DO UPDATE
      SET expires_at = CASE WHEN b.expires_at IS NULL OR EXCLUDED.expires_at IS NULL THEN NULL
                            ELSE greatest(b.expires_at, EXCLUDED.expires_at) END,
          reason = EXCLUDED.reason, created_by = EXCLUDED.created_by`;
}

/** A record's rows (device_bans_action_key). */
const renewForRecord = renewOf(sql`(action_id, kind, value_hash) WHERE action_id IS NOT NULL`);
/** An admin's typed number (device_bans_admin_key). */
const renewTyped = renewOf(sql`(kind, value_hash) WHERE created_by IS NOT NULL AND action_id IS NULL`);

export interface CreatedBan {
  ban: AdminDeviceBanRow;
  /** An earlier ban of the same value for the same cause was renewed. */
  renewed: boolean;
}

export type BanFromUserOutcome = { outcome: 'missing' } | { outcome: 'nothing' } | { outcome: 'unknown_action' } | { outcome: 'banned'; bans: CreatedBan[] };

const createdBans = z.array(z.object({ ban: banRow, renewed: z.boolean() }));

/**
 * Bans what a person signs in with, in one statement: the device keys of
 * their devices (kind 1, per store build), their phone (kind 2) and Google
 * account (kind 3), each of the kinds asked. Every row names a record
 * (`action_id`): `forAction`, the person's standing suspension or ban the
 * bans go with (a lift or an overturn of it removes them, 0028), or else a
 * new kind-9 record. A value already banned for another cause gets a row of
 * its own beside that one; only the same record's row is renewed. A
 * `forAction` that is not such a record of this person writes nothing
 * ('unknown_action'); nothing to ban writes nothing.
 */
export const adminBanFromUser = defineQuery(
  { name: 'adminRules.banFromUser', statements: 1 },
  async (
    tx,
    input: {
      userId: string;
      kinds: readonly number[];
      expiresAt: string | null;
      reason: string;
      adminId: number;
      actionId: string;
      forAction?: string | null | undefined;
    },
  ): Promise<BanFromUserOutcome> => {
    const forAction = input.forAction ?? null;
    const row = await one<{ found: boolean; cause_ok: boolean; bans: unknown }>(
      tx,
      sql`WITH u AS (SELECT id FROM users WHERE id = ${input.userId}::bigint AND status <> 8 FOR SHARE),
               -- Locked against a lift of it meanwhile (moderation_revoke locks it FOR UPDATE).
               cause AS (SELECT m.id FROM moderation_actions m
                          WHERE m.id = ${forAction}::bigint AND m.user_id = ${input.userId}::bigint
                            AND m.kind IN (2, 3) AND m.revoked_at IS NULL
                            FOR SHARE),
               ok AS (SELECT ${forAction}::bigint IS NULL OR EXISTS (SELECT 1 FROM cause) AS v),
               found AS (SELECT 1::smallint AS kind, d.store, d.fingerprint_hash AS value_hash
                         FROM devices d JOIN u ON d.user_id = u.id
                        WHERE d.fingerprint_hash IS NOT NULL AND 1 = ANY(${[...input.kinds]}::smallint[])
                       UNION ALL
                       SELECT (CASE ai.provider WHEN 1 THEN 2 ELSE 3 END)::smallint, NULL::smallint, ai.subject_hash
                         FROM auth_identities ai JOIN u ON ai.user_id = u.id
                        WHERE ai.provider IN (1, 2) AND (CASE ai.provider WHEN 1 THEN 2 ELSE 3 END) = ANY(${[...input.kinds]}::smallint[])),
               -- One row per key (the unique key of device_bans), whatever the devices share.
               src AS (SELECT DISTINCT ON (kind, value_hash) kind, store, value_hash FROM found ORDER BY kind, value_hash, store),
               minted AS (INSERT INTO moderation_actions (id, user_id, admin_id, kind, reason_code, reason_text)
                          SELECT ${input.actionId}::bigint, u.id, ${input.adminId}::integer, 9, 99, ${input.reason}
                            FROM u WHERE ${forAction}::bigint IS NULL AND EXISTS (SELECT 1 FROM src)
                          RETURNING id),
               act AS (SELECT id FROM cause UNION ALL SELECT id FROM minted),
               ins AS (INSERT INTO device_bans AS b (id, expires_at, created_by, action_id, kind, store, value_hash, reason)
                       SELECT id_next(), ${input.expiresAt}::timestamptz, ${input.adminId}::integer, (SELECT id FROM act), s.kind, s.store, s.value_hash, ${input.reason}
                         FROM src s
                        WHERE (SELECT v FROM ok)
                       ${renewForRecord}
                       RETURNING b.*, NOT (b.xmax = 0) AS renewed)
          SELECT EXISTS (SELECT 1 FROM u) AS found, (SELECT v FROM ok) AS cause_ok,
                 coalesce((SELECT jsonb_agg(jsonb_build_object(
                            'ban', jsonb_build_object(
                              'id', b.id::text, 'kind', b.kind, 'store', b.store, 'reason', b.reason, 'createdAtMs', ${ms(sql`b.created_at`)},
                              'createdBy', ${adminRefOf(sql`b.created_by`)}, 'expiresAtMs', ${ms(sql`b.expires_at`)},
                              'active', (b.expires_at IS NULL OR b.expires_at > now()),
                              'user', (SELECT admin_user_ref(x) FROM users x WHERE x.id = ${input.userId}::bigint),
                              'actionId', b.action_id::text),
                            'renewed', b.renewed) ORDER BY b.kind, b.id)
                             FROM ins b), '[]'::jsonb) AS bans`,
    );
    if (!row.found) return { outcome: 'missing' };
    if (!row.cause_ok) return { outcome: 'unknown_action' };
    const bans = createdBans.parse(row.bans);
    return bans.length === 0 ? { outcome: 'nothing' } : { outcome: 'banned', bans };
  },
);

/**
 * Bans one phone number by its current keyed hash (sign-in checks every
 * pepper, so it matches): the admins' typed-number row of it, beside any
 * other cause's row of the same number.
 */
export const adminBanPhone = defineQuery(
  { name: 'adminRules.banPhone', statements: 1 },
  async (tx, input: { hash: Buffer; expiresAt: string | null; reason: string; adminId: number }): Promise<CreatedBan> => {
    const row = await one<{ item: unknown; renewed: boolean }>(
      tx,
      sql`INSERT INTO device_bans AS b (id, expires_at, created_by, action_id, kind, store, value_hash, reason)
          VALUES (id_next(), ${input.expiresAt}::timestamptz, ${input.adminId}::integer, NULL, 2, NULL, ${input.hash}, ${input.reason})
          ${renewTyped}
          RETURNING ${banRowSql} AS item, NOT (b.xmax = 0) AS renewed`,
    );
    return { ban: banRow.parse(row.item), renewed: row.renewed };
  },
);

export type DeleteBanOutcome = { outcome: 'missing' } | { outcome: 'automatic' } | { outcome: 'deleted'; ban: AdminDeviceBanRow };

/**
 * Removes a ban. A ban the server wrote by itself (no admin, no record: the
 * year-long ban of an under-age sign-up) is removed only with `automatic`
 * ('automatic' otherwise, nothing written).
 */
export const adminDeleteDeviceBan = defineQuery(
  { name: 'adminRules.banDelete', statements: 1 },
  async (tx, banId: string, options: { automatic: boolean }): Promise<DeleteBanOutcome> => {
    const row = await one<{ auto: boolean | null; item: unknown }>(
      tx,
      sql`WITH t AS (SELECT x.id, (x.created_by IS NULL AND x.action_id IS NULL) AS auto FROM device_bans x WHERE x.id = ${banId}::bigint FOR UPDATE),
               d AS (DELETE FROM device_bans b USING t WHERE b.id = t.id AND (${options.automatic}::boolean OR NOT t.auto)
                     RETURNING ${banRowSql} AS item)
          SELECT (SELECT t.auto FROM t) AS auto, (SELECT d.item FROM d) AS item`,
    );
    if (row.auto === null) return { outcome: 'missing' };
    if (row.item === null) return { outcome: 'automatic' };
    return { outcome: 'deleted', ban: banRow.parse(row.item) };
  },
);

// ─── The audit log ────────────────────────────────────────────────────────

/** The search's filters as the database reads them: raw ids, codes, and the id range of the time range. */
export interface AuditSearch {
  adminId?: number | undefined;
  targetType?: number | undefined;
  targetId?: string | undefined;
  action?: string | undefined;
  /** First id of the range (inclusive), from `id_floor` of its start. */
  fromMs?: number | undefined;
  /** End of the range (exclusive). */
  toMs?: number | undefined;
  beforeId?: string | null | undefined;
  limit: number;
}

function auditConditions(search: AuditSearch): SqlFragment {
  const conditions: SqlFragment[] = [sql`TRUE`];
  if (search.adminId !== undefined) conditions.push(sql`l.admin_id = ${search.adminId}::integer`);
  if (search.targetType !== undefined) conditions.push(sql`l.target_type = ${search.targetType}::smallint`);
  if (search.targetId !== undefined) conditions.push(sql`l.target_id = ${search.targetId}::bigint`);
  if (search.action !== undefined) conditions.push(sql`l.action = ${search.action}::text`);
  if (search.fromMs !== undefined) conditions.push(sql`l.id >= id_floor(to_timestamp(${search.fromMs}::bigint / 1000.0))`);
  if (search.toMs !== undefined) conditions.push(sql`l.id < id_floor(to_timestamp(${search.toMs}::bigint / 1000.0))`);
  if (search.beforeId) conditions.push(sql`l.id < ${search.beforeId}::bigint`);
  return joinSql(conditions, sql` AND `);
}

/** The statement of {@link adminAuditSearch}, for the plan checks. */
export function adminAuditSearchStatement(search: AuditSearch): SqlFragment {
  return sql`SELECT ${adminAuditRowSql} AS item FROM audit_log l WHERE ${auditConditions(search)} ORDER BY l.id DESC LIMIT ${search.limit}`;
}

/** Audit rows, newest first, each filter alone or combined (the export reads the same with a bigger limit). */
export const adminAuditSearch = defineQuery({ name: 'adminRules.auditSearch', statements: 1 }, async (db, search: AuditSearch): Promise<AdminAuditRow[]> => {
  const rows = await many<{ item: unknown }>(db, adminAuditSearchStatement(search));
  return rows.map((r) => parseAdminAuditRow(r.item));
});

const auditAdmin = z.object({ id: z.number().int().positive(), displayName: z.string(), disabled: z.boolean() });
export type AuditAdminRow = z.infer<typeof auditAdmin>;

/** Every admin account, by name (the audit page's filter; a handful of rows). */
export const adminAuditAdmins = defineQuery({ name: 'adminRules.auditAdmins', statements: 1 }, async (db): Promise<AuditAdminRow[]> => {
  const rows = await many<{ item: unknown }>(
    db,
    sql`SELECT jsonb_build_object('id', a.id, 'displayName', a.display_name, 'disabled', a.disabled_at IS NOT NULL) AS item
          FROM admin_users a ORDER BY a.display_name, a.id`,
  );
  return rows.map((r) => auditAdmin.parse(r.item));
});
