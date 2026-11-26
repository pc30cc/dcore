import { z } from 'zod';
import { many, maybeOne, one, sql, type SqlFragment } from '../query.js';
import { defineQuery } from './define.js';
import { adminEpochMs, adminIdText, adminRefRow, adminRefSql, msOf } from './adminShared.js';
import { moderationEffectSchema, revokeOutcomeSchema, type ModerationInput } from './safety.js';

/**
 * The admin panel's reads and writes of one person (`/v1/admin/users*`).
 * People are raw ids here; the API turns them into public ids. Codes stay
 * codes and times are epoch ms (ids as text); the shapes come from the SQL
 * views of 0026 (`admin_user_summary`, `admin_user_view`,
 * `admin_action_json`, `admin_text_view`).
 *
 * Every list is keyset-paged by id from an index (newest first) with
 * `LIMIT n + 1`; nothing is counted. A tab answers `found: false` for an
 * account that does not exist or is purged (status 8, a tombstone): the
 * API answers 404, as for the user page.
 */

const id = adminIdText;
const epochMs = adminEpochMs;
const adminRef = adminRefRow;
const ms = msOf;
const adminRefOf = adminRefSql;

export const adminUserRefRowSchema = z.object({
  id,
  status: z.number().int().min(1).max(8),
  name: z.string().nullable(),
  /** The first approved photo. */
  photo: z.object({ id, blobVer: z.number().int().positive() }).nullable(),
});
export type AdminUserRefRow = z.infer<typeof adminUserRefRowSchema>;

export const adminUserSummaryRowSchema = adminUserRefRowSchema.extend({
  shadowbanned: z.boolean(),
  test: z.boolean(),
  verified: z.boolean(),
  country: z.string().nullable(),
  createdAtMs: epochMs,
  lastActiveOn: z.string().nullable(),
});
export type AdminUserSummaryRow = z.infer<typeof adminUserSummaryRowSchema>;

export const adminActionRowSchema = z.object({
  id,
  kind: z.number().int().min(1).max(10),
  reasonCode: z.number().int(),
  reasonText: z.string(),
  note: z.string().nullable(),
  startsAtMs: epochMs,
  endsAtMs: epochMs.nullable(),
  revokedAtMs: epochMs.nullable(),
  admin: adminRef.nullable(),
  revokedBy: adminRef.nullable(),
  reportId: id.nullable(),
  standing: z.boolean(),
  appeal: z
    .object({
      id,
      status: z.number().int().min(1).max(3),
      body: z.string(),
      decisionText: z.string().nullable(),
      decidedAtMs: epochMs.nullable(),
      decidedBy: adminRef.nullable(),
    })
    .nullable(),
});
export type AdminActionRow = z.infer<typeof adminActionRowSchema>;

const promptRow = z.object({
  position: z.number().int().min(0).max(2),
  promptId: z.number().int(),
  answer: z.string().nullable(),
  status: z.number().int().min(1).max(3),
  rejectReason: z.number().int().nullable(),
});
export type AdminPromptRow = z.infer<typeof promptRow>;

export const adminUserDetailRowSchema = adminUserSummaryRowSchema.extend({
  locale: z.string(),
  gender: z.number().int().nullable(),
  birthDate: z.string().nullable(),
  deletedAtMs: epochMs.nullable(),
  /** When a deleted account is purged (the end of its restore grace). */
  purgeAtMs: epochMs.nullable(),
  deletedVia: z.number().int().nullable(),
  restoreStatus: z.number().int().nullable(),
  onboardingStep: z.number().int(),
  phoneOnFile: z.boolean(),
  googleOnFile: z.boolean(),
  heldNow: z.boolean(),
  profile: z
    .object({
      name: z.string(),
      about: z.string().nullable(),
      job: z.string().nullable(),
      textState: z.number().int().min(1).max(3),
      textRejectReason: z.number().int().nullable(),
      intention: z.number().int().nullable(),
      completeness: z.number().int(),
      version: z.number().int().positive(),
      prompts: z.array(promptRow),
    })
    .nullable(),
  standing: z.array(adminActionRowSchema),
  /** Open reports against the person, counted up to 21. */
  openReports: z.number().int().min(0).max(21),
});
export type AdminUserDetailRow = z.infer<typeof adminUserDetailRowSchema>;

export const adminTextRowSchema = z.object({
  user: adminUserRefRowSchema,
  version: z.number().int().positive(),
  about: z.string().nullable(),
  job: z.string().nullable(),
  textState: z.number().int().min(1).max(3),
  textRejectReason: z.number().int().nullable(),
  prompts: z.array(promptRow),
});
export type AdminTextRow = z.infer<typeof adminTextRowSchema>;

const viewOrNull = adminUserDetailRowSchema.nullable();

/** Whether the account exists and is not purged (a tab's 404). */
const exists = (userId: string) => sql`EXISTS (SELECT 1 FROM users u WHERE u.id = ${userId}::bigint AND u.status <> 8)`;

// ─── The list and search ──────────────────────────────────────────────────

export type AdminUserListFilter = 'pending_review' | 'suspended' | 'banned' | 'shadowbanned' | 'test';

/**
 * The predicate of each filter, with constants the planner proves the
 * partial indexes of 0026 from: no filter walks the primary key.
 */
function filterOf(filter: AdminUserListFilter | undefined): SqlFragment {
  switch (filter) {
    case 'pending_review':
      return sql`u.status = 2`;
    case 'suspended':
      return sql`u.status = 5`;
    case 'banned':
      return sql`u.status = 6`;
    case 'shadowbanned':
      return sql`u.is_shadowbanned AND u.status <> 8`;
    case 'test':
      return sql`(u.flags & 1) <> 0 AND u.status <> 8`;
    case undefined:
      return sql`u.status <> 8`;
  }
}

export interface AdminUserListOptions {
  filter?: AdminUserListFilter | undefined;
  beforeId?: string | null | undefined;
  limit: number;
}

/** The list's statement (exported for the plan checks of the tests). */
export function adminUserListStatement(options: AdminUserListOptions): SqlFragment {
  const after = options.beforeId ? sql` AND u.id < ${options.beforeId}::bigint` : sql``;
  return sql`SELECT admin_user_summary(u) AS s FROM users u WHERE ${filterOf(options.filter)}${after} ORDER BY u.id DESC LIMIT ${options.limit}`;
}

/** Newest first, `limit` rows after `beforeId` (pass the page size + 1). */
export const adminUserList = defineQuery({ name: 'adminUsers.list', statements: 1 }, async (db, options: AdminUserListOptions): Promise<AdminUserSummaryRow[]> => {
  const rows = await many<{ s: unknown }>(db, adminUserListStatement(options));
  return rows.map((r) => adminUserSummaryRowSchema.parse(r.s));
});

export type AdminUserMatch = 'id' | 'phone' | 'order' | 'token' | 'name';
export interface AdminUserHit {
  summary: AdminUserSummaryRow;
  matchedBy: AdminUserMatch;
}

/** Accounts signing in with this phone number (its keyed hash under each pepper; auth_identities_subject_key). */
export const adminUserSearchByPhone = defineQuery(
  { name: 'adminUsers.searchByPhone', statements: 1 },
  async (db, hashes: readonly Buffer[]): Promise<AdminUserHit[]> => {
    const rows = await many<{ s: unknown }>(
      db,
      sql`SELECT admin_user_summary(u) AS s
            FROM auth_identities ai JOIN users u ON u.id = ai.user_id
           WHERE ai.provider = 1 AND ai.subject_hash = ANY(${[...hashes]}::bytea[]) AND u.status <> 8
           ORDER BY u.id DESC
           LIMIT 50`,
    );
    return rows.map((r) => ({ summary: adminUserSummaryRowSchema.parse(r.s), matchedBy: 'phone' }));
  },
);

/**
 * An account id (the primary key; a public id typed in the search), a store
 * order id (store_purchases_order_idx), a purchase token's hash
 * (store_purchases_token_key) and names by word similarity (at least 0.3,
 * nearest 50: admin_name_search of 0026, from its GIN index), in one statement: the id
 * first, then exact store hits, then names nearest first. A 13-letter word
 * that happens to decode as a public id still finds names.
 */
export const adminUserSearchByText = defineQuery(
  { name: 'adminUsers.searchByText', statements: 1 },
  async (db, options: { q: string; userId: string | null; tokenHash: Buffer | null; names: boolean }): Promise<AdminUserHit[]> => {
    const branches: SqlFragment[] = [
      sql`SELECT sp.user_id, 1 AS rank, 0::real AS d, 'order'::text AS by
            FROM store_purchases sp WHERE sp.store IN (1, 2) AND sp.order_id = ${options.q}::text AND sp.user_id IS NOT NULL`,
    ];
    if (options.userId) branches.push(sql`SELECT ${options.userId}::bigint, 0, 0::real, 'id'::text`);
    if (options.tokenHash) {
      branches.push(sql`SELECT sp.user_id, 1, 0::real, 'token'::text
                          FROM store_purchases sp WHERE sp.store IN (1, 2) AND sp.token_hash = ${options.tokenHash}::bytea AND sp.user_id IS NOT NULL`);
    }
    if (options.names) {
      branches.push(sql`SELECT n.user_id, 2, n.d, 'name'::text FROM admin_name_search(${options.q}::text, 50) n`);
    }
    let union = branches[0]!;
    for (const branch of branches.slice(1)) union = sql`${union} UNION ALL ${branch}`;
    const rows = await many<{ s: unknown; by: AdminUserMatch }>(
      db,
      sql`WITH m AS (${union}),
          best AS (SELECT DISTINCT ON (m.user_id) m.user_id, m.rank, m.d, m.by FROM m ORDER BY m.user_id, m.rank, m.d)
          SELECT admin_user_summary(u) AS s, b.by
            FROM best b JOIN users u ON u.id = b.user_id
           WHERE u.status <> 8
           ORDER BY b.rank, b.d, u.id DESC
           LIMIT 50`,
    );
    return rows.map((r) => ({ summary: adminUserSummaryRowSchema.parse(r.s), matchedBy: r.by }));
  },
);

// ─── The user page ────────────────────────────────────────────────────────

/** The user page's header and profile; null for no account or a purged one. */
export const adminUserView = defineQuery({ name: 'adminUsers.view', statements: 1 }, async (db, userId: string): Promise<AdminUserDetailRow | null> => {
  const row = await one<{ v: unknown }>(db, sql`SELECT admin_user_view(${userId}::bigint) AS v`);
  return viewOrNull.parse(row.v);
});

const photoRow = z.object({
  id,
  position: z.number().int(),
  status: z.number().int().min(1).max(4),
  rejectReason: z.number().int().nullable(),
  modFlags: z.number().int(),
  hasFace: z.boolean().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  blobVer: z.number().int().positive(),
  uploadedAtMs: epochMs,
  decidedAtMs: epochMs.nullable(),
  decidedBy: adminRef.nullable(),
});
export type AdminPhotoRow = z.infer<typeof photoRow>;

export interface Found<T> {
  found: boolean;
  value: T;
}

/** Every photo of the person, by position (photos_user_position_key; at most 9). */
export const adminUserPhotos = defineQuery({ name: 'adminUsers.photos', statements: 1 }, async (db, userId: string): Promise<Found<AdminPhotoRow[]>> => {
  const row = await one<{ found: boolean; items: unknown }>(
    db,
    sql`SELECT ${exists(userId)} AS found,
               coalesce((SELECT jsonb_agg(jsonb_build_object(
                                  'id', ph.id::text, 'position', ph.position, 'status', ph.status, 'rejectReason', ph.reject_reason,
                                  'modFlags', ph.mod_flags, 'hasFace', ph.has_face, 'width', ph.width, 'height', ph.height,
                                  'blobVer', ph.blob_ver, 'uploadedAtMs', ${ms(sql`id_time(ph.id)`)},
                                  'decidedAtMs', ${ms(sql`ph.decided_at`)}, 'decidedBy', ${adminRefOf(sql`ph.decided_by`)})
                                ORDER BY ph.position)
                           FROM photos ph WHERE ph.user_id = ${userId}::bigint), '[]'::jsonb) AS items`,
  );
  return { found: row.found, value: z.array(photoRow).parse(row.items) };
});

const reportRow = z.object({
  id,
  priority: z.number().int(),
  reason: z.number().int(),
  context: z.number().int(),
  status: z.number().int(),
  filedAtMs: epochMs,
  reported: adminUserRefRowSchema,
  reporter: adminUserRefRowSchema.nullable(),
  assignee: adminRef.nullable(),
  collecting: z.boolean(),
  resolution: z.number().int().nullable(),
  resolvedAtMs: epochMs.nullable(),
  filed: z.boolean(),
});
export type AdminReportRow = z.infer<typeof reportRow>;

/** A report as the lists show it (r: reports, tu: the target's users row, ru: the reporter's). */
export const adminReportRowSql = sql`jsonb_build_object(
  'id', r.id::text, 'priority', r.priority, 'reason', r.reason, 'context', r.context, 'status', r.status,
  'filedAtMs', ${ms(sql`id_time(r.id)`)},
  'reported', admin_user_ref(tu),
  'reporter', CASE WHEN ru.id IS NULL THEN NULL ELSE admin_user_ref(ru) END,
  'assignee', ${adminRefOf(sql`r.assigned_to`)},
  'collecting', r.evidence_at IS NULL,
  'resolution', r.resolution,
  'resolvedAtMs', ${ms(sql`r.resolved_at`)},
  'filed', EXISTS (SELECT 1 FROM report_filings f WHERE f.report_id = r.id))`;

export function parseAdminReportRow(value: unknown): AdminReportRow {
  return reportRow.parse(value);
}

/** Reports against the person (reports_target_idx) or filed by them (reports_reporter_idx), newest first. */
export const adminUserReports = defineQuery(
  { name: 'adminUsers.reports', statements: 1 },
  async (db, userId: string, options: { side: 'received' | 'filed'; beforeId?: string | null | undefined; limit: number }): Promise<Found<AdminReportRow[]>> => {
    const column = options.side === 'received' ? sql`r.target_id` : sql`r.reporter_id`;
    const after = options.beforeId ? sql` AND r.id < ${options.beforeId}::bigint` : sql``;
    const row = await one<{ found: boolean; items: unknown }>(
      db,
      sql`SELECT ${exists(userId)} AS found,
                 coalesce((SELECT jsonb_agg(x.item ORDER BY x.id DESC)
                             FROM (SELECT r.id, ${adminReportRowSql} AS item
                                     FROM reports r
                                     JOIN users tu ON tu.id = r.target_id
                                     LEFT JOIN users ru ON ru.id = r.reporter_id
                                    WHERE ${column} = ${userId}::bigint${after}
                                    ORDER BY r.id DESC
                                    LIMIT ${options.limit}) x), '[]'::jsonb) AS items`,
    );
    return { found: row.found, value: z.array(reportRow).parse(row.items) };
  },
);

/** Every moderation record of the person, newest first (moderation_actions_user_idx). */
export const adminUserActions = defineQuery(
  { name: 'adminUsers.actions', statements: 1 },
  async (db, userId: string, options: { beforeId?: string | null | undefined; limit: number; withShadowbans?: boolean | undefined }): Promise<Found<AdminActionRow[]>> => {
    const after = options.beforeId ? sql` AND m.id < ${options.beforeId}::bigint` : sql``;
    // A caller who may not see shadowbans pages over the other records (a residual filter on the same index scan).
    const kinds = options.withShadowbans === false ? sql` AND m.kind <> 4` : sql``;
    const row = await one<{ found: boolean; items: unknown }>(
      db,
      sql`SELECT ${exists(userId)} AS found,
                 coalesce((SELECT jsonb_agg(x.item ORDER BY x.id DESC)
                             FROM (SELECT m.id, admin_action_json(m) AS item
                                     FROM moderation_actions m
                                    WHERE m.user_id = ${userId}::bigint${after}${kinds}
                                    ORDER BY m.id DESC
                                    LIMIT ${options.limit}) x), '[]'::jsonb) AS items`,
    );
    return { found: row.found, value: z.array(adminActionRowSchema).parse(row.items) };
  },
);

const purchasesRow = z.object({
  subscriptions: z.array(
    z.object({
      store: z.number().int(),
      plan: z.string(),
      status: z.number().int(),
      startedAtMs: epochMs,
      expiresAtMs: epochMs,
      autoRenew: z.boolean(),
    }),
  ),
  items: z.array(
    z.object({
      id,
      store: z.number().int(),
      productId: z.string(),
      kind: z.number().int(),
      state: z.number().int(),
      quantity: z.number().int(),
      purchasedAtMs: epochMs,
      expiresAtMs: epochMs.nullable(),
      orderId: z.string().nullable(),
      autoRenew: z.boolean().nullable(),
      isTest: z.boolean(),
      region: z.string().nullable(),
    }),
  ),
});
export type AdminPurchasesRow = z.infer<typeof purchasesRow>;

/** The person's subscriptions (one per source) and newest 50 purchases (store_purchases_user_idx); never a token. */
export const adminUserPurchases = defineQuery({ name: 'adminUsers.purchases', statements: 1 }, async (db, userId: string): Promise<Found<AdminPurchasesRow>> => {
  const row = await one<{ found: boolean; subscriptions: unknown; items: unknown }>(
    db,
    sql`SELECT ${exists(userId)} AS found,
               coalesce((SELECT jsonb_agg(jsonb_build_object(
                                  'store', s.store, 'plan', pl.key, 'status', s.status,
                                  'startedAtMs', ${ms(sql`s.started_at`)}, 'expiresAtMs', ${ms(sql`s.expires_at`)}, 'autoRenew', s.auto_renew)
                                ORDER BY s.store)
                           FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
                          WHERE s.user_id = ${userId}::bigint), '[]'::jsonb) AS subscriptions,
               coalesce((SELECT jsonb_agg(x.item ORDER BY x.id DESC)
                           FROM (SELECT sp.id, jsonb_build_object(
                                          'id', sp.id::text, 'store', sp.store, 'productId', pr.product_id, 'kind', sp.kind,
                                          'state', sp.state, 'quantity', sp.quantity, 'purchasedAtMs', ${ms(sql`sp.purchased_at`)},
                                          'expiresAtMs', ${ms(sql`sp.expires_at`)}, 'orderId', sp.order_id, 'autoRenew', sp.auto_renew,
                                          'isTest', sp.is_test, 'region', sp.region) AS item
                                   FROM store_purchases sp JOIN store_products pr ON pr.id = sp.product_ref
                                  WHERE sp.user_id = ${userId}::bigint
                                  ORDER BY sp.id DESC
                                  LIMIT 50) x), '[]'::jsonb) AS items`,
  );
  return { found: row.found, value: purchasesRow.parse({ subscriptions: row.subscriptions, items: row.items }) };
});

const walletRow = z.object({
  balances: z.array(z.object({ item: z.number().int(), store: z.number().int(), balance: z.number().int() })),
  ledger: z.array(
    z.object({
      id,
      atMs: epochMs,
      item: z.number().int(),
      store: z.number().int(),
      delta: z.number().int(),
      balanceAfter: z.number().int(),
      reason: z.number().int(),
      admin: adminRef.nullable(),
    }),
  ),
});
export type AdminWalletRow = z.infer<typeof walletRow>;

/** Balances (wallet_balances' key) and a page of the ledger, newest first (wallet_ledger_user_idx). */
export const adminUserWallet = defineQuery(
  { name: 'adminUsers.wallet', statements: 1 },
  async (db, userId: string, options: { beforeId?: string | null | undefined; limit: number }): Promise<Found<AdminWalletRow>> => {
    const after = options.beforeId ? sql` AND l.id < ${options.beforeId}::bigint` : sql``;
    const row = await one<{ found: boolean; balances: unknown; ledger: unknown }>(
      db,
      sql`SELECT ${exists(userId)} AS found,
                 coalesce((SELECT jsonb_agg(jsonb_build_object('item', b.item, 'store', b.store, 'balance', b.balance) ORDER BY b.item, b.store)
                             FROM wallet_balances b WHERE b.user_id = ${userId}::bigint), '[]'::jsonb) AS balances,
                 coalesce((SELECT jsonb_agg(x.item ORDER BY x.id DESC)
                             FROM (SELECT l.id, jsonb_build_object(
                                            'id', l.id::text, 'atMs', ${ms(sql`id_time(l.id)`)}, 'item', l.item, 'store', l.store,
                                            'delta', l.delta, 'balanceAfter', l.balance_after, 'reason', l.reason,
                                            'admin', ${adminRefOf(sql`l.admin_id`)}) AS item
                                     FROM wallet_ledger l
                                    WHERE l.user_id = ${userId}::bigint${after}
                                    ORDER BY l.id DESC
                                    LIMIT ${options.limit}) x), '[]'::jsonb) AS ledger`,
    );
    return { found: row.found, value: walletRow.parse({ balances: row.balances, ledger: row.ledger }) };
  },
);

const deviceRow = z.object({
  id,
  platform: z.number().int(),
  store: z.number().int(),
  appVersion: z.number().int(),
  integrity: z.number().int(),
  locale: z.string().nullable(),
  updatedAtMs: epochMs,
  disabledAtMs: epochMs.nullable(),
  push: z.boolean(),
  linked: z.array(adminUserRefRowSchema),
});
export type AdminDeviceRow = z.infer<typeof deviceRow>;

/**
 * The person's devices (devices_user_idx) and, for each, up to 10 other
 * accounts seen with the same device key (devices_fingerprint_idx); never a
 * token or a hash.
 */
export const adminUserDevices = defineQuery({ name: 'adminUsers.devices', statements: 1 }, async (db, userId: string): Promise<Found<AdminDeviceRow[]>> => {
  const row = await one<{ found: boolean; items: unknown }>(
    db,
    sql`SELECT ${exists(userId)} AS found,
               coalesce((SELECT jsonb_agg(jsonb_build_object(
                                  'id', d.id::text, 'platform', d.platform, 'store', d.store, 'appVersion', d.app_version,
                                  'integrity', d.integrity, 'locale', d.locale, 'updatedAtMs', ${ms(sql`d.updated_at`)},
                                  'disabledAtMs', ${ms(sql`d.disabled_at`)}, 'push', d.push_token_hash IS NOT NULL,
                                  'linked', coalesce((SELECT jsonb_agg(admin_user_ref(o) ORDER BY o.id DESC)
                                                        FROM (SELECT DISTINCT d2.user_id FROM devices d2
                                                               WHERE d.fingerprint_hash IS NOT NULL AND d2.fingerprint_hash = d.fingerprint_hash
                                                                 AND d2.user_id <> d.user_id
                                                               LIMIT 10) x
                                                        JOIN users o ON o.id = x.user_id AND o.status <> 8), '[]'::jsonb))
                                ORDER BY d.updated_at DESC, d.id DESC)
                           FROM devices d WHERE d.user_id = ${userId}::bigint), '[]'::jsonb) AS items`,
  );
  return { found: row.found, value: z.array(deviceRow).parse(row.items) };
});

const sessionRow = z.object({
  id,
  createdAtMs: epochMs,
  refreshedAtMs: epochMs,
  expiresAtMs: epochMs,
  revokedAtMs: epochMs.nullable(),
  revokeReason: z.number().int().nullable(),
  store: z.number().int(),
  appVersion: z.number().int().nullable(),
  deviceId: id.nullable(),
});
export type AdminUserSessionRow = z.infer<typeof sessionRow>;

/** The newest 50 sessions (sessions_user_idx). */
export const adminUserSessions = defineQuery({ name: 'adminUsers.sessions', statements: 1 }, async (db, userId: string): Promise<Found<AdminUserSessionRow[]>> => {
  const row = await one<{ found: boolean; items: unknown }>(
    db,
    sql`SELECT ${exists(userId)} AS found,
               coalesce((SELECT jsonb_agg(x.item ORDER BY x.id DESC)
                           FROM (SELECT s.id, jsonb_build_object(
                                          'id', s.id::text, 'createdAtMs', ${ms(sql`id_time(s.id)`)}, 'refreshedAtMs', ${ms(sql`s.refreshed_at`)},
                                          'expiresAtMs', ${ms(sql`s.expires_at`)}, 'revokedAtMs', ${ms(sql`s.revoked_at`)},
                                          'revokeReason', s.revoke_reason, 'store', s.store, 'appVersion', s.app_version,
                                          'deviceId', s.device_id::text) AS item
                                   FROM sessions s WHERE s.user_id = ${userId}::bigint
                                  ORDER BY s.id DESC
                                  LIMIT 50) x), '[]'::jsonb) AS items`,
  );
  return { found: row.found, value: z.array(sessionRow).parse(row.items) };
});

const consentRow = z.object({
  kind: z.number().int(),
  version: z.number().int(),
  acceptedAtMs: epochMs,
  withdrawnAtMs: epochMs.nullable(),
  store: z.number().int().nullable(),
});
export type AdminConsentRow = z.infer<typeof consentRow>;

/** Every consent record, with the build it was given in (user_consents' key). */
export const adminUserConsents = defineQuery({ name: 'adminUsers.consents', statements: 1 }, async (db, userId: string): Promise<Found<AdminConsentRow[]>> => {
  const row = await one<{ found: boolean; items: unknown }>(
    db,
    sql`SELECT ${exists(userId)} AS found,
               coalesce((SELECT jsonb_agg(jsonb_build_object(
                                  'kind', c.kind, 'version', c.version, 'acceptedAtMs', ${ms(sql`c.accepted_at`)},
                                  'withdrawnAtMs', ${ms(sql`c.withdrawn_at`)}, 'store', c.store)
                                ORDER BY c.kind, c.version)
                           FROM user_consents c WHERE c.user_id = ${userId}::bigint), '[]'::jsonb) AS items`,
  );
  return { found: row.found, value: z.array(consentRow).parse(row.items) };
});

const auditRow = z.object({
  id,
  atMs: epochMs,
  admin: adminRef.nullable(),
  action: z.string(),
  targetType: z.number().int(),
  targetId: id.nullable(),
  ip: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
});
export type AdminAuditRow = z.infer<typeof auditRow>;

/** An audit row as the panel shows it (alias `l`). */
export const adminAuditRowSql = sql`jsonb_build_object(
  'id', l.id::text, 'atMs', ${ms(sql`id_time(l.id)`)}, 'admin', ${adminRefOf(sql`l.admin_id`)}, 'action', l.action,
  'targetType', l.target_type, 'targetId', l.target_id::text, 'ip', host(l.ip), 'detail', l.detail)`;

export function parseAdminAuditRow(value: unknown): AdminAuditRow {
  return auditRow.parse(value);
}

/** The audit rows about the person (target user; audit_log_target_idx), newest first. */
export const adminUserAudit = defineQuery(
  { name: 'adminUsers.audit', statements: 1 },
  async (db, userId: string, options: { beforeId?: string | null | undefined; limit: number }): Promise<Found<AdminAuditRow[]>> => {
    const after = options.beforeId ? sql` AND l.id < ${options.beforeId}::bigint` : sql``;
    const row = await one<{ found: boolean; items: unknown }>(
      db,
      sql`SELECT ${exists(userId)} AS found,
                 coalesce((SELECT jsonb_agg(x.item ORDER BY x.id DESC)
                             FROM (SELECT l.id, ${adminAuditRowSql} AS item
                                     FROM audit_log l
                                    WHERE l.target_type = 1 AND l.target_id = ${userId}::bigint${after}
                                    ORDER BY l.id DESC
                                    LIMIT ${options.limit}) x), '[]'::jsonb) AS items`,
    );
    return { found: row.found, value: z.array(auditRow).parse(row.items) };
  },
);

// ─── Sensitive views and writes ───────────────────────────────────────────

/** The sealed phone number of the person's phone identity; null when there is none (or the account is purged). */
export const adminSealedPhone = defineQuery({ name: 'adminUsers.sealedPhone', statements: 1 }, async (db, userId: string): Promise<Buffer | null> => {
  const row = await maybeOne<{ enc: Buffer | null }>(
    db,
    sql`SELECT ai.subject_enc AS enc
          FROM auth_identities ai JOIN users u ON u.id = ai.user_id
         WHERE ai.user_id = ${userId}::bigint AND ai.provider = 1 AND u.status <> 8 AND ai.subject_enc IS NOT NULL
         ORDER BY ai.id
         LIMIT 1`,
  );
  return row?.enc ?? null;
});

export interface TestAccountOutcome {
  found: boolean;
  /** The flag before the write. */
  before: boolean;
  changed: boolean;
  /** Peers in active conversations (their lists re-check the person). */
  peers: string[];
  /** The page's view as of the statement's start (the flag is the caller's to set). */
  view: AdminUserDetailRow | null;
}

/** Sets or clears the test-account flag (users.flags 1) under the row lock; discovery re-syncs by trigger. */
export const adminSetTestAccount = defineQuery(
  { name: 'adminUsers.setTestAccount', statements: 1 },
  async (db, userId: string, test: boolean): Promise<TestAccountOutcome> => {
    const row = await one<{ found: boolean; before: boolean | null; changed: boolean; peers: unknown; view: unknown }>(
      db,
      sql`WITH u AS (SELECT x.id, x.flags FROM users x WHERE x.id = ${userId}::bigint AND x.status <> 8 FOR UPDATE),
               upd AS (
                 UPDATE users x
                    SET flags = (CASE WHEN ${test}::boolean THEN x.flags | 1 ELSE x.flags & ~1 END)::smallint
                   FROM u
                  WHERE x.id = u.id AND ((u.flags & 1) <> 0) IS DISTINCT FROM ${test}::boolean
                 RETURNING x.id)
          SELECT EXISTS (SELECT 1 FROM u) AS found,
                 (SELECT (u.flags & 1) <> 0 FROM u) AS before,
                 EXISTS (SELECT 1 FROM upd) AS changed,
                 moderation_peers(${userId}::bigint) AS peers,
                 admin_user_view(${userId}::bigint) AS view`,
    );
    return {
      found: row.found,
      before: row.before ?? false,
      changed: row.changed,
      peers: z.array(id).parse(row.peers),
      view: viewOrNull.parse(row.view),
    };
  },
);

/** The person a report is about; null when there is no such report. */
export const adminReportTarget = defineQuery({ name: 'adminUsers.reportTarget', statements: 1 }, async (db, reportId: string): Promise<string | null> => {
  const row = await maybeOne<{ target: string }>(db, sql`SELECT r.target_id::text AS target FROM reports r WHERE r.id = ${reportId}::bigint`);
  return row?.target ?? null;
});

const applySchema = z.union([
  z.object({ outcome: z.literal('missing') }),
  moderationEffectSchema.extend({ outcome: z.literal('applied'), actionId: id, kind: z.number().int().min(1).max(4) }),
]);
export type AdminApplyOutcome = z.infer<typeof applySchema>;

export interface AdminModerationWrite<O> {
  outcome: O;
  /** The page's view after the write (null when the account is missing). */
  view: AdminUserDetailRow | null;
  /** The record the write made or lifted, after it. */
  action: AdminActionRow | null;
}

/**
 * A warning, suspension, ban or shadowban (moderation_apply of 0016) and,
 * in the same statement, the page's view and the new record after it.
 */
export const adminApplyModeration = defineQuery(
  { name: 'adminUsers.applyModeration', statements: 1 },
  async (db, m: ModerationInput): Promise<AdminModerationWrite<AdminApplyOutcome>> => {
    const row = await one<{ out: unknown; view: unknown; action: unknown }>(
      db,
      sql`WITH a AS MATERIALIZED (
            SELECT moderation_apply(${m.actionId}::bigint, ${m.userId}::bigint, ${m.kind}::smallint, ${m.reasonCode}::smallint,
                                    ${m.reasonText}::text, ${m.endsAt ? m.endsAt.toISOString() : null}::timestamptz,
                                    ${m.adminId ?? null}::integer, ${m.reportId ?? null}::bigint, ${m.note ?? null}::text) AS out)
          SELECT a.out, admin_user_view(${m.userId}::bigint) AS view, admin_action_view(${m.actionId}::bigint) AS action FROM a`,
    );
    return { outcome: applySchema.parse(row.out), view: viewOrNull.parse(row.view), action: adminActionRowSchema.nullable().parse(row.action) };
  },
);

const revokeSchema = revokeOutcomeSchema;
export type AdminRevokeOutcome = z.infer<typeof revokeSchema>;

/** Lifts a record (moderation_revoke of 0030) and reads the page's view and the record after it, in one statement. */
export const adminRevokeModeration = defineQuery(
  { name: 'adminUsers.revokeModeration', statements: 1 },
  async (db, actionId: string, liftId: string, options: { adminId: number | null; reasonText?: string | undefined }): Promise<AdminModerationWrite<AdminRevokeOutcome>> => {
    const row = await one<{ out: unknown; view: unknown; action: unknown }>(
      db,
      sql`WITH a AS MATERIALIZED (
            SELECT moderation_revoke(${actionId}::bigint, ${options.adminId}::integer, ${liftId}::bigint, ${options.reasonText ?? null}::text) AS out)
          SELECT a.out,
                 CASE WHEN a.out ->> 'userId' IS NULL THEN NULL ELSE admin_user_view((a.out ->> 'userId')::bigint) END AS view,
                 admin_action_view(${actionId}::bigint) AS action
            FROM a`,
    );
    return { outcome: revokeSchema.parse(row.out), view: viewOrNull.parse(row.view), action: adminActionRowSchema.nullable().parse(row.action) };
  },
);

/**
 * Signs the person out everywhere: every live session revoked (reason 4,
 * admin) and a kind-10 record, in one statement (a data-modifying CTE runs
 * to completion whether or not the main query reads it). `found` false: no such
 * account (or purged), nothing written.
 */
export const adminRevokeUserSessions = defineQuery(
  { name: 'adminUsers.revokeSessions', statements: 1 },
  async (db, input: { userId: string; actionId: string; adminId: number | null; note: string | null }): Promise<{ found: boolean; sessionIds: string[] }> => {
    const row = await one<{ found: boolean; sessions: string[] }>(
      db,
      sql`WITH u AS (SELECT x.id FROM users x WHERE x.id = ${input.userId}::bigint AND x.status <> 8),
               s AS (
                 UPDATE sessions SET revoked_at = now(), revoke_reason = 4
                  WHERE user_id = ${input.userId}::bigint AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM u)
                 RETURNING id),
               a AS (
                 INSERT INTO moderation_actions (id, user_id, admin_id, kind, reason_code, reason_text, note)
                 SELECT ${input.actionId}::bigint, u.id, ${input.adminId}::integer, 10, 99, 'Signed out by an admin.', ${input.note}::text FROM u
                 RETURNING id)
          SELECT EXISTS (SELECT 1 FROM u) AS found, ARRAY(SELECT s.id::text FROM s ORDER BY s.id) AS sessions`,
    );
    return { found: row.found, sessionIds: row.sessions };
  },
);

export type AdminRenameOutcome =
  | { outcome: 'missing' }
  | { outcome: 'stale'; version: number }
  | { outcome: 'unchanged'; view: AdminUserDetailRow }
  | { outcome: 'renamed'; before: string; version: number; actionId: string; view: AdminUserDetailRow };

/**
 * An admin's new display name for the person (a name that breaks the
 * rules): the profile row locked, its version compared, the name written
 * and a kind-7 record with the text reason's code, in one statement. The
 * view is read in the same statement (its name and version are the
 * caller's to set from the outcome).
 */
export const adminRenameUser = defineQuery(
  { name: 'adminUsers.rename', statements: 1 },
  async (
    db,
    input: { userId: string; version: number; displayName: string; reasonCode: number; reasonText: string; actionId: string; adminId: number | null },
  ): Promise<AdminRenameOutcome> => {
    const row = await one<{ found: boolean; version: number | null; before: string | null; renamed: number | null; view: unknown }>(
      db,
      sql`WITH p AS (
            SELECT x.user_id, x.version, x.display_name
              FROM profiles x JOIN users u ON u.id = x.user_id
             WHERE x.user_id = ${input.userId}::bigint AND u.status <> 8
               FOR UPDATE OF x),
          upd AS (
            UPDATE profiles x SET display_name = ${input.displayName}::text, name_reject_reason = ${input.reasonCode}::smallint
              FROM p
             WHERE x.user_id = p.user_id AND p.version = ${input.version}::integer AND p.display_name <> ${input.displayName}::text
            RETURNING x.version),
          ins AS (
            INSERT INTO moderation_actions (id, user_id, admin_id, kind, reason_code, reason_text, note)
            SELECT ${input.actionId}::bigint, ${input.userId}::bigint, ${input.adminId}::integer, 7, ${input.reasonCode}::smallint,
                   ${input.reasonText}::text, 'name'
              FROM upd
            RETURNING id)
          SELECT EXISTS (SELECT 1 FROM p) AS found, (SELECT p.version FROM p) AS version, (SELECT p.display_name FROM p) AS before,
                 (SELECT upd.version FROM upd) AS renamed,
                 admin_user_view(${input.userId}::bigint) AS view`,
    );
    const view = viewOrNull.parse(row.view);
    if (!row.found || row.version === null || view === null) return { outcome: 'missing' };
    if (row.renamed !== null) return { outcome: 'renamed', before: row.before ?? '', version: row.renamed, actionId: input.actionId, view };
    if (row.version !== input.version) return { outcome: 'stale', version: row.version };
    return { outcome: 'unchanged', view };
  },
);

const stateSnapshot = z.object({
  textState: z.number().int(),
  textRejectReason: z.number().int().optional(),
  prompts: z.array(z.object({ position: z.number().int(), status: z.number().int(), rejectReason: z.number().int().optional() })),
});
export type TextStateSnapshot = z.infer<typeof stateSnapshot>;

const decideSchema = z.union([
  z.object({ outcome: z.literal('missing') }),
  z.object({ outcome: z.literal('stale'), version: z.number().int() }),
  z.object({ outcome: z.literal('invalid_part'), part: z.enum(['profile', 'prompts']), positions: z.array(z.number().int()).optional() }),
  z.object({ outcome: z.literal('unchanged'), version: z.number().int(), locale: z.string() }),
  z.object({
    outcome: z.literal('decided'),
    userId: id,
    locale: z.string(),
    before: stateSnapshot,
    after: stateSnapshot,
    version: z.number().int(),
    /** The parts rejected (what the caller named, or every part that waited). */
    rejected: z.object({ profile: z.boolean(), prompts: z.array(z.number().int()) }),
    actionId: id.nullable(),
  }),
]);
export type TextDecideOutcome = z.infer<typeof decideSchema>;

export interface TextDecisionInput {
  userId: string;
  version: number;
  adminId: number | null;
  /** Both null: every part that waits is rejected. */
  rejectProfile: boolean | null;
  rejectPrompts: readonly number[] | null;
  reasonCode: number | null;
  actionId: string;
  reasonText: string | null;
}

/** profile_text_decide (0026) and the texts after it, in one statement. */
export const adminDecideTexts = defineQuery(
  { name: 'adminUsers.decideTexts', statements: 1 },
  async (db, input: TextDecisionInput): Promise<{ outcome: TextDecideOutcome; texts: AdminTextRow | null }> => {
    const row = await one<{ out: unknown; texts: unknown }>(
      db,
      sql`WITH d AS MATERIALIZED (
            SELECT profile_text_decide(${input.userId}::bigint, ${input.version}::integer, ${input.adminId}::integer,
                                       ${input.rejectProfile}::boolean, ${input.rejectPrompts === null ? null : [...input.rejectPrompts]}::smallint[],
                                       ${input.reasonCode}::smallint, ${input.actionId}::bigint, ${input.reasonText}::text) AS out)
          SELECT d.out, admin_text_view(${input.userId}::bigint) AS texts FROM d`,
    );
    return { outcome: decideSchema.parse(row.out), texts: adminTextRowSchema.nullable().parse(row.texts) };
  },
);
