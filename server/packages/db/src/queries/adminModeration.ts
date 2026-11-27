import { z } from 'zod';
import { many, maybeOne, one, sql, type SqlFragment } from '../query.js';
import {
  adminActionRowSchema,
  adminReportRowSql,
  adminTextRowSchema,
  adminUserRefRowSchema,
  parseAdminReportRow,
  type AdminActionRow,
  type AdminReportRow,
  type AdminTextRow,
} from './adminUsers.js';
import { defineQuery } from './define.js';
import { adminEpochMs, adminIdText, adminRefRow, adminRefSql, msOf } from './adminShared.js';
import { appealDecisionSchema, type AppealDecision } from './safety.js';

/**
 * The admin panel's moderation: the photo and text queues, reports (lists,
 * a report's page, its chat evidence, assignment, closing, filing with an
 * authority), legal holds and appeals. People are raw ids here (the API
 * turns them into public ids); codes stay codes, times are epoch ms.
 *
 * Every list is keyset-paged from an index (`LIMIT n + 1`, nothing
 * counted): the photo queue by id from photos_review_queue_idx, the text
 * queue by account from the two review indexes of 0027, the report queue by
 * (priority, id) from reports_queue_idx or reports_assignee_idx, closed
 * reports by (resolved_at, id) from reports_resolved_idx, holds and appeals
 * by id. Each write is one statement that locks what it changes and answers
 * the state after it; the API writes the audit row in the same transaction.
 */

const id = adminIdText;
const epochMs = adminEpochMs;
const adminRef = adminRefRow;
const ms = msOf;
const adminRefOf = adminRefSql;
/** A report's resolved_at to the microsecond, as the closed list's cursor carries it. */
const exactTime = (column: SqlFragment) => sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// ─── The photo queue ──────────────────────────────────────────────────────

const queuePhotoRow = z.object({
  id,
  position: z.number().int(),
  modFlags: z.number().int(),
  hasFace: z.boolean().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  blobVer: z.number().int().positive(),
  uploadedAtMs: epochMs,
  user: adminUserRefRowSchema.extend({
    age: z.number().int().nullable(),
    gender: z.number().int().nullable(),
    country: z.string().nullable(),
    verified: z.boolean(),
  }),
  others: z.array(z.object({ id, status: z.number().int().min(1).max(4), blobVer: z.number().int().positive() })),
});
export type AdminQueuePhotoRow = z.infer<typeof queuePhotoRow>;

/** The photo queue's statement (exported for the plan checks of the tests). */
export function adminPhotoQueueStatement(options: { afterId?: string | null | undefined; limit: number }): SqlFragment {
  const after = options.afterId ? sql` AND ph.id > ${options.afterId}::bigint` : sql``;
  return sql`SELECT jsonb_build_object(
                'id', ph.id::text, 'position', ph.position, 'modFlags', ph.mod_flags, 'hasFace', ph.has_face,
                'width', ph.width, 'height', ph.height, 'blobVer', ph.blob_ver, 'uploadedAtMs', ${ms(sql`id_time(ph.id)`)},
                'user', admin_user_ref(u) || jsonb_build_object(
                          'age', CASE WHEN u.birth_date IS NULL THEN NULL ELSE extract(year FROM age(u.birth_date))::integer END,
                          'gender', u.gender, 'country', u.country, 'verified', u.is_verified),
                'others', coalesce((SELECT jsonb_agg(jsonb_build_object('id', o.id::text, 'status', o.status, 'blobVer', o.blob_ver) ORDER BY o.position)
                                      FROM photos o WHERE o.user_id = ph.user_id AND o.id <> ph.id), '[]'::jsonb)) AS item
               FROM photos ph JOIN users u ON u.id = ph.user_id
              WHERE ph.status = 2 AND u.status NOT IN (7, 8)${after}
              ORDER BY ph.id
              LIMIT ${options.limit}`;
}

/** Photos waiting for a human, oldest first (photos_review_queue_idx); deleted accounts left out. */
export const adminPhotoQueue = defineQuery(
  { name: 'adminModeration.photoQueue', statements: 1 },
  async (db, options: { afterId?: string | null | undefined; limit: number }): Promise<AdminQueuePhotoRow[]> => {
    const rows = await many<{ item: unknown }>(db, adminPhotoQueueStatement(options));
    return rows.map((r) => queuePhotoRow.parse(r.item));
  },
);

const photoDecisionSchema = z.union([
  z.object({ outcome: z.enum(['missing', 'processing']) }),
  // Already as asked (a repeated decision), or found decided otherwise than the admin saw.
  z.object({
    outcome: z.enum(['unchanged', 'decided_elsewhere']),
    photoId: id,
    userId: id,
    status: z.number().int(),
    rejectReason: z.number().int().optional(),
    locale: z.string(),
  }),
  z.object({
    outcome: z.literal('decided'),
    photoId: id,
    userId: id,
    position: z.number().int(),
    blobVer: z.number().int().positive(),
    locale: z.string(),
    before: z.object({ status: z.number().int(), rejectReason: z.number().int().optional() }),
    after: z.object({ status: z.number().int(), rejectReason: z.number().int().optional() }),
    actionId: id.nullable(),
  }),
]);
export type PhotoDecisionOutcome = z.infer<typeof photoDecisionSchema>;

export interface PhotoDecisionInput {
  photoId: string;
  adminId: number | null;
  approve: boolean;
  reasonCode: number | null;
  /** The kind-6 record's id (a rejection). */
  actionId: string | null;
  reasonText: string | null;
  /** The photo's status the admin saw (photos.status); null: decide whatever it is. */
  expect: number | null;
}

/** photo_decide (0027): approve or reject one photo, the kind-6 record with a rejection. */
export const adminDecidePhoto = defineQuery({ name: 'adminModeration.decidePhoto', statements: 1 }, async (db, input: PhotoDecisionInput): Promise<PhotoDecisionOutcome> => {
  const row = await one<{ out: unknown }>(
    db,
    sql`SELECT photo_decide(${input.photoId}::bigint, ${input.adminId}::integer, ${input.approve}::boolean, ${input.reasonCode}::smallint,
                            ${input.actionId}::bigint, ${input.reasonText}::text, ${input.expect}::smallint) AS out`,
  );
  return photoDecisionSchema.parse(row.out);
});

// ─── The text queue ───────────────────────────────────────────────────────

/** The text queue's statement (exported for the plan checks of the tests). */
export function adminTextQueueStatement(options: { afterUserId?: string | null | undefined; limit: number }): SqlFragment {
  const afterProfile = options.afterUserId ? sql` AND p.user_id > ${options.afterUserId}::bigint` : sql``;
  const afterPrompt = options.afterUserId ? sql` AND pp.user_id > ${options.afterUserId}::bigint` : sql``;
  return sql`WITH waiting AS (
               (SELECT p.user_id FROM profiles p JOIN users u ON u.id = p.user_id AND u.status NOT IN (7, 8)
                 WHERE p.text_state = 1 AND (p.about IS NOT NULL OR p.job_title IS NOT NULL)${afterProfile}
                 ORDER BY p.user_id LIMIT ${options.limit})
               UNION
               (SELECT DISTINCT pp.user_id FROM profile_prompts pp JOIN users u ON u.id = pp.user_id AND u.status NOT IN (7, 8)
                 WHERE pp.status = 1${afterPrompt}
                 ORDER BY pp.user_id LIMIT ${options.limit})
             ), page AS (SELECT w.user_id FROM waiting w ORDER BY w.user_id LIMIT ${options.limit})
             SELECT pg.user_id::text AS user_id, admin_text_view(pg.user_id) AS texts FROM page pg ORDER BY pg.user_id`;
}

/** People with an about, job or prompt answer waiting for a human, by account (the two review indexes of 0027). */
export const adminTextQueue = defineQuery(
  { name: 'adminModeration.textQueue', statements: 1 },
  async (db, options: { afterUserId?: string | null | undefined; limit: number }): Promise<{ userId: string; texts: AdminTextRow | null }[]> => {
    const rows = await many<{ user_id: string; texts: unknown }>(db, adminTextQueueStatement(options));
    return rows.map((r) => ({ userId: r.user_id, texts: adminTextRowSchema.nullable().parse(r.texts) }));
  },
);

// ─── Reports ──────────────────────────────────────────────────────────────

export type AdminReportListView = 'queue' | 'mine' | 'unassigned' | 'resolved';

/** The cursor of the open views (priority, then id) and of the closed one (resolved_at, then id). */
export type AdminReportCursor = { p: number; id: string } | { at: string; id: string };

export interface AdminReportListOptions {
  view: AdminReportListView;
  /** The signed-in admin (the `mine` view). */
  adminId: number;
  cursor?: AdminReportCursor | null | undefined;
  limit: number;
}

export interface AdminReportListRow {
  report: AdminReportRow;
  priority: number;
  /** resolved_at to the microsecond (closed reports). */
  resolvedKey: string | null;
}

/** The report list's statement (exported for the plan checks of the tests). */
export function adminReportListStatement(options: AdminReportListOptions): SqlFragment {
  const c = options.cursor ?? null;
  let where: SqlFragment;
  let order: SqlFragment;
  if (options.view === 'resolved') {
    where = sql`r.status IN (3, 4, 5)`;
    if (c && 'at' in c) where = sql`${where} AND (r.resolved_at, r.id) < (${c.at}::timestamptz, ${c.id}::bigint)`;
    order = sql`r.resolved_at DESC, r.id DESC`;
  } else {
    where =
      options.view === 'mine'
        ? sql`r.status IN (1, 2) AND r.assigned_to = ${options.adminId}::integer`
        : options.view === 'unassigned'
          ? sql`r.status IN (1, 2) AND r.assigned_to IS NULL`
          : sql`r.status IN (1, 2)`;
    // priority <= p bounds the index scan; the rest of the key drops the rows of p already shown.
    if (c && 'p' in c) where = sql`${where} AND r.priority <= ${c.p}::smallint AND (r.priority < ${c.p}::smallint OR r.id > ${c.id}::bigint)`;
    order = sql`r.priority DESC, r.id`;
  }
  return sql`SELECT r.priority AS p, ${exactTime(sql`r.resolved_at`)} AS at, ${adminReportRowSql} AS item
               FROM reports r
               JOIN users tu ON tu.id = r.target_id
               LEFT JOIN users ru ON ru.id = r.reporter_id
              WHERE ${where}
              ORDER BY ${order}
              LIMIT ${options.limit}`;
}

/** A page of reports: the queue (most urgent first), the admin's, the unassigned ones, or the closed ones (newest first). */
export const adminReportList = defineQuery({ name: 'adminModeration.reports', statements: 1 }, async (db, options: AdminReportListOptions): Promise<AdminReportListRow[]> => {
  const rows = await many<{ p: number; at: string | null; item: unknown }>(db, adminReportListStatement(options));
  return rows.map((r) => ({ report: parseAdminReportRow(r.item), priority: r.p, resolvedKey: r.at }));
});

const filingRow = z.object({ authority: z.number().int(), externalRef: z.string().nullable(), filedAtMs: epochMs, filedBy: adminRef.nullable() });
export type AdminFilingRow = z.infer<typeof filingRow>;

/** A report's filing with an authority (f: report_filings). */
const filingJson = sql`jsonb_build_object('authority', f.authority, 'externalRef', f.external_ref, 'filedAtMs', ${ms(sql`f.filed_at`)}, 'filedBy', ${adminRefOf(sql`f.filed_by`)})`;

const holdRow = z.object({
  id,
  kind: z.number().int(),
  user: adminUserRefRowSchema.nullable(),
  conversationId: id.nullable(),
  reportId: id.nullable(),
  createdAtMs: epochMs,
  createdBy: adminRef.nullable(),
  authorityRef: z.string().nullable(),
  evidenceCopiedAtMs: epochMs.nullable(),
  releasedAtMs: epochMs.nullable(),
  releasedBy: adminRef.nullable(),
  releasedReason: z.string().nullable(),
  filing: filingRow.nullable(),
});
export type AdminHoldRow = z.infer<typeof holdRow>;

/** A legal hold as the panel shows it (h: legal_holds, hu: the held account's users row). */
const holdJson = sql`jsonb_build_object(
  'id', h.id::text, 'kind', h.kind,
  'user', CASE WHEN hu.id IS NULL THEN NULL ELSE admin_user_ref(hu) END,
  'conversationId', h.match_id::text, 'reportId', h.report_id::text,
  'createdAtMs', ${ms(sql`id_time(h.id)`)}, 'createdBy', ${adminRefOf(sql`h.created_by`)},
  'authorityRef', h.authority_ref, 'evidenceCopiedAtMs', ${ms(sql`h.evidence_copied_at`)},
  'releasedAtMs', ${ms(sql`h.released_at`)}, 'releasedBy', ${adminRefOf(sql`h.released_by`)}, 'releasedReason', h.released_reason,
  'filing', (SELECT ${filingJson} FROM report_filings f WHERE f.report_id = h.report_id))`;

const evidenceItem = z
  .object({
    reportId: id,
    atMs: epochMs,
    context: z.number().int(),
    reason: z.number().int(),
    details: z.string().optional(),
    conversationId: id.optional(),
    messageIds: z.array(id).optional(),
    photo: z.object({ id, blobVer: z.number().int().optional(), position: z.number().int().optional(), status: z.number().int().optional() }).optional(),
    callId: id.optional(),
    profile: z
      .object({
        name: z.string().optional(),
        about: z.string().optional(),
        job: z.string().optional(),
        textState: z.number().int().optional(),
        prompts: z.array(z.object({ promptId: z.number().int(), answer: z.string().nullable().optional(), status: z.number().int().optional() })).optional(),
        photos: z.array(id).optional(),
      })
      .optional(),
  })
  .loose();
export type AdminEvidenceItem = z.infer<typeof evidenceItem>;

export interface AdminReportDetailRow {
  report: AdminReportRow;
  details: string | null;
  conversationId: string | null;
  evidenceAtMs: number | null;
  items: AdminEvidenceItem[];
  holds: AdminHoldRow[];
  filing: AdminFilingRow | null;
  actions: AdminActionRow[];
  otherOpen: AdminReportRow[];
  history: AdminReportHistoryRow[];
}

/** A row of a report's history: who did what when (never the address or the detail: those are the audit log's, audit.read). */
const reportHistoryRow = z.object({ id, atMs: epochMs, admin: adminRef.nullable(), action: z.string() });
export type AdminReportHistoryRow = z.infer<typeof reportHistoryRow>;

/**
 * A report's page in one statement: the report, its filings (the evidence
 * items, without the chat), the active holds naming it
 * (legal_holds_report_idx), its filing, the reported person's actions on it
 * (moderation_actions_user_idx; `withShadowbans` false: shadowbans are left
 * out inside the limit), their other open reports (up to 10,
 * reports_target_idx) and its audit rows (up to 20, audit_log_target_idx).
 */
export const adminReportDetail = defineQuery({ name: 'adminModeration.report', statements: 1 }, async (db, reportId: string, options: { withShadowbans: boolean }): Promise<AdminReportDetailRow | null> => {
  const row = await maybeOne<Record<string, unknown>>(
    db,
    sql`SELECT (SELECT ${adminReportRowSql} FROM reports r JOIN users tu ON tu.id = r.target_id LEFT JOIN users ru ON ru.id = r.reporter_id WHERE r.id = rep.id) AS summary,
               rep.details, rep.match_id::text AS conversation_id, ${ms(sql`rep.evidence_at`)} AS evidence_at_ms,
               coalesce(rep.evidence -> 'items', '[]'::jsonb) AS items,
               coalesce((SELECT jsonb_agg(${holdJson} ORDER BY h.id DESC)
                           FROM legal_holds h LEFT JOIN users hu ON hu.id = h.user_id
                          WHERE h.report_id = rep.id AND h.released_at IS NULL), '[]'::jsonb) AS holds,
               (SELECT ${filingJson} FROM report_filings f WHERE f.report_id = rep.id) AS filing,
               coalesce((SELECT jsonb_agg(x.item ORDER BY x.id DESC)
                           FROM (SELECT m.id, admin_action_json(m) AS item FROM moderation_actions m
                                  WHERE m.user_id = rep.target_id AND m.report_id = rep.id
                                    AND (${options.withShadowbans}::boolean OR m.kind <> 4)
                                  ORDER BY m.id DESC LIMIT 50) x), '[]'::jsonb) AS actions,
               coalesce((SELECT jsonb_agg(x.item ORDER BY x.id DESC)
                           FROM (SELECT r.id, ${adminReportRowSql} AS item
                                   FROM reports r JOIN users tu ON tu.id = r.target_id LEFT JOIN users ru ON ru.id = r.reporter_id
                                  WHERE r.target_id = rep.target_id AND r.status IN (1, 2) AND r.id <> rep.id
                                  ORDER BY r.id DESC LIMIT 10) x), '[]'::jsonb) AS other_open,
               coalesce((SELECT jsonb_agg(x.item ORDER BY x.id DESC)
                           FROM (SELECT l.id, jsonb_build_object('id', l.id::text, 'atMs', ${ms(sql`id_time(l.id)`)}, 'admin', ${adminRefOf(sql`l.admin_id`)},
                                                                 'action', l.action) AS item
                                   FROM audit_log l
                                  WHERE l.target_type = 3 AND l.target_id = rep.id
                                  ORDER BY l.id DESC LIMIT 20) x), '[]'::jsonb) AS history
          FROM reports rep
         WHERE rep.id = ${reportId}::bigint`,
  );
  if (!row) return null;
  const items: AdminEvidenceItem[] = [];
  for (const item of z.array(z.unknown()).parse(row['items'])) {
    const parsed = evidenceItem.safeParse(item);
    if (parsed.success) items.push(parsed.data);
  }
  return {
    report: parseAdminReportRow(row['summary']),
    details: (row['details'] as string | null) ?? null,
    conversationId: (row['conversation_id'] as string | null) ?? null,
    evidenceAtMs: row['evidence_at_ms'] === null ? null : Number(row['evidence_at_ms']),
    items,
    holds: z.array(holdRow).parse(row['holds']),
    filing: filingRow.nullable().parse(row['filing']),
    actions: z.array(adminActionRowSchema).parse(row['actions']),
    otherOpen: z.array(z.unknown()).parse(row['other_open']).map(parseAdminReportRow),
    history: z.array(reportHistoryRow).parse(row['history']),
  };
});

export interface EvidencePhotoRow {
  id: string;
  status: number;
  blobVer: number;
}

/** The photos a report's evidence names, as they are now (their state and variant version, for links). */
export const adminEvidencePhotos = defineQuery({ name: 'adminModeration.evidencePhotos', statements: 1 }, async (db, ids: readonly string[]): Promise<EvidencePhotoRow[]> => {
  const rows = await many<{ id: string; status: number; blob_ver: number }>(
    db,
    sql`SELECT ph.id::text AS id, ph.status, ph.blob_ver FROM photos ph WHERE ph.id = ANY(${[...ids]}::bigint[])`,
  );
  return rows.map((r) => ({ id: r.id, status: r.status, blobVer: r.blob_ver }));
});

const chatMessage = z
  .object({
    id,
    senderId: id,
    kind: z.number().int(),
    flags: z.number().int().optional(),
    body: z.string().optional(),
    atMs: epochMs,
    fromStream: z.boolean().optional(),
  })
  .loose();
const chatRequest = z.object({ requestId: id, senderId: id, status: z.number().int(), body: z.string().nullable().optional(), atMs: epochMs }).loose();
const chatSnapshot = z
  .object({
    filingId: id,
    conversationId: id.optional(),
    takenAtMs: epochMs,
    messages: z.array(chatMessage).nullable().optional(),
    requests: z.array(chatRequest).nullable().optional(),
  })
  .loose();
export type ChatSnapshot = z.infer<typeof chatSnapshot>;

export interface AdminChatEvidence {
  evidenceAtMs: number | null;
  reporterId: string | null;
  targetId: string;
  chat: ChatSnapshot[];
  /** The message ids the filings named. */
  named: string[];
}

/** The chat snapshots of a report's evidence (the audited evidence view); null for no such report. */
export const adminReportChat = defineQuery({ name: 'adminModeration.reportChat', statements: 1 }, async (db, reportId: string): Promise<AdminChatEvidence | null> => {
  const row = await maybeOne<{ chat: unknown; named: unknown; evidence_at_ms: string | null; reporter_id: string | null; target_id: string }>(
    db,
    sql`SELECT coalesce(r.evidence -> 'chat', '[]'::jsonb) AS chat, ${ms(sql`r.evidence_at`)} AS evidence_at_ms,
               coalesce((SELECT jsonb_agg(DISTINCT n.id)
                           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.evidence -> 'items') = 'array' THEN r.evidence -> 'items' ELSE '[]'::jsonb END) i,
                                jsonb_array_elements_text(CASE WHEN jsonb_typeof(i -> 'messageIds') = 'array' THEN i -> 'messageIds' ELSE '[]'::jsonb END) n(id)), '[]'::jsonb) AS named,
               r.reporter_id::text AS reporter_id, r.target_id::text AS target_id
          FROM reports r WHERE r.id = ${reportId}::bigint`,
  );
  if (!row) return null;
  const chat: ChatSnapshot[] = [];
  for (const snapshot of z.array(z.unknown()).parse(row.chat)) {
    const parsed = chatSnapshot.safeParse(snapshot);
    if (parsed.success) chat.push(parsed.data);
  }
  const named = z.array(z.string()).catch([]).parse(row.named);
  return { evidenceAtMs: row.evidence_at_ms === null ? null : Number(row.evidence_at_ms), reporterId: row.reporter_id, targetId: row.target_id, chat, named };
});

export type AdminAssignOutcome =
  | { outcome: 'missing' }
  | { outcome: 'closed' }
  | { outcome: 'unknown_admin' }
  | { outcome: 'taken'; assignee: number | null }
  | { outcome: 'unchanged' | 'assigned'; before: { status: number; assignee: number | null }; report: AdminReportRow };

/**
 * Assigns a report (`to`) or gives it back (`to` null), in one statement:
 * the row locked; only an open report, only an enabled admin, and only when
 * the report is still assigned as the admin saw it (`from`; another
 * assignee is someone else's take). Assigned is in review (2), unassigned
 * open (1).
 */
export const adminAssignReport = defineQuery(
  { name: 'adminModeration.assign', statements: 1 },
  async (db, input: { reportId: string; to: number | null; from: number | null }): Promise<AdminAssignOutcome> => {
    const row = await one<{ status: number | null; assignee: number | null; admin_ok: boolean; changed: boolean; item: unknown }>(
      db,
      sql`WITH cur AS (SELECT x.* FROM reports x WHERE x.id = ${input.reportId}::bigint FOR UPDATE),
               ok AS (SELECT EXISTS (SELECT 1 FROM admin_users a WHERE a.id = ${input.to}::integer AND a.disabled_at IS NULL) AS v),
               upd AS (
                 UPDATE reports x
                    SET assigned_to = ${input.to}::integer,
                        status = CASE WHEN ${input.to}::integer IS NULL THEN 1 ELSE 2 END
                   FROM cur
                  WHERE x.id = cur.id AND cur.status IN (1, 2)
                    AND cur.assigned_to IS NOT DISTINCT FROM ${input.from}::integer
                    AND cur.assigned_to IS DISTINCT FROM ${input.to}::integer
                    AND (${input.to}::integer IS NULL OR (SELECT ok.v FROM ok))
                 RETURNING x.*),
               fin AS (SELECT * FROM upd UNION ALL SELECT * FROM cur WHERE NOT EXISTS (SELECT 1 FROM upd))
          SELECT (SELECT cur.status FROM cur) AS status, (SELECT cur.assigned_to FROM cur) AS assignee,
                 (SELECT ok.v FROM ok) AS admin_ok, EXISTS (SELECT 1 FROM upd) AS changed,
                 (SELECT ${adminReportRowSql} FROM fin r JOIN users tu ON tu.id = r.target_id LEFT JOIN users ru ON ru.id = r.reporter_id) AS item`,
    );
    if (row.status === null) return { outcome: 'missing' };
    const before = { status: row.status, assignee: row.assignee };
    if (row.changed) return { outcome: 'assigned', before, report: parseAdminReportRow(row.item) };
    if (row.status !== 1 && row.status !== 2) return { outcome: 'closed' };
    if (input.to !== null && !row.admin_ok) return { outcome: 'unknown_admin' };
    if (row.assignee !== input.from) return { outcome: 'taken', assignee: row.assignee };
    return { outcome: 'unchanged', before, report: parseAdminReportRow(row.item) };
  },
);

export interface CloseReportsInput {
  reportId: string;
  /** 3 actioned, 4 dismissed, 5 duplicate. */
  status: 3 | 4 | 5;
  resolution: number;
  adminId: number;
  /**
   * Also the target's other open reports of the same reason and no higher
   * priority (up to 50); never threat (6) or child-safety (8) reports, which
   * are each reviewed on their own.
   */
  sameTarget: boolean;
  /** retention.report_evidence_days: the evidence is emptied that long after the close. */
  retentionDays: number;
  /**
   * A resolution naming a penalty (1 warning, 2 suspension, 3 ban, 4 shadowban): the reported person must carry
   * a record of that kind taken on this report or since it was filed, else nothing closes ('no_action').
   */
  penaltyKind?: number | null | undefined;
}

export type CloseReportsOutcome = { outcome: 'missing' } | { outcome: 'closed_already' } | { outcome: 'no_action' } | { outcome: 'closed'; reports: AdminReportRow[] };

/**
 * Closes a report (and, with `sameTarget`, its target's other open ones of
 * the same reason, see {@link CloseReportsInput}) in one statement. Every row it may change is locked in one pass in id
 * order (two closes on the same person wait for each other instead of
 * deadlocking), and the asked report's status is judged on the locked row;
 * the UPDATE then changes exactly those rows by key (never a scan of the
 * open queue). It sets status, resolution, who and when, and when the
 * evidence is emptied (a held report keeps it while the hold lasts: the
 * sweep skips it).
 */
export function adminCloseReportsStatement(input: CloseReportsInput): SqlFragment {
  return sql`WITH cur AS (SELECT x.id, x.target_id, x.reason, x.priority FROM reports x WHERE x.id = ${input.reportId}::bigint),
             locked AS MATERIALIZED (
               SELECT x.id, x.status FROM reports x
                WHERE x.id = ANY (ARRAY(
                        SELECT cur.id FROM cur
                        UNION ALL
                        (SELECT o.id FROM cur JOIN reports o ON o.target_id = cur.target_id
                          WHERE ${input.sameTarget}::boolean
                            AND o.status IN (1, 2) AND o.id <> cur.id
                            AND o.reason = cur.reason AND o.reason NOT IN (6, 8) AND o.priority <= cur.priority
                          ORDER BY o.id
                          LIMIT 50)))
                ORDER BY x.id
                  FOR UPDATE),
             asked AS (SELECT l.status FROM locked l WHERE l.id = ${input.reportId}::bigint),
             -- The person's records (moderation_actions_user_idx): one of the kind named, on this report or since it.
             penalty AS (SELECT ${input.penaltyKind ?? null}::smallint IS NULL
                                OR EXISTS (SELECT 1 FROM cur JOIN moderation_actions m ON m.user_id = cur.target_id
                                            WHERE m.kind = ${input.penaltyKind ?? null}::smallint AND (m.report_id = cur.id OR m.id > cur.id)) AS ok),
             upd AS (
               UPDATE reports x
                  SET status = ${input.status}::smallint, resolution = ${input.resolution}::smallint, resolved_at = now(),
                      resolved_by = ${input.adminId}::integer,
                      evidence_purge_at = now() + make_interval(days => ${input.retentionDays}::integer)
                WHERE x.id = ANY (ARRAY(SELECT l.id FROM locked l WHERE l.status IN (1, 2) AND (SELECT a.status FROM asked a) IN (1, 2)))
                  AND (SELECT p.ok FROM penalty p)
               RETURNING x.*)
        SELECT (SELECT a.status FROM asked a) AS status, (SELECT p.ok FROM penalty p) AS penalty_ok,
               coalesce((SELECT jsonb_agg(z.item ORDER BY z.id)
                           FROM (SELECT r.id, ${adminReportRowSql} AS item
                                   FROM upd r JOIN users tu ON tu.id = r.target_id LEFT JOIN users ru ON ru.id = r.reporter_id) z), '[]'::jsonb) AS items`;
}

export const adminCloseReports = defineQuery({ name: 'adminModeration.close', statements: 1 }, async (db, input: CloseReportsInput): Promise<CloseReportsOutcome> => {
  const row = await one<{ status: number | null; penalty_ok: boolean; items: unknown }>(db, adminCloseReportsStatement(input));
  if (row.status === null) return { outcome: 'missing' };
  if (row.status !== 1 && row.status !== 2) return { outcome: 'closed_already' };
  if (!row.penalty_ok) return { outcome: 'no_action' };
  const reports = z.array(z.unknown()).parse(row.items).map(parseAdminReportRow);
  // The asked report first.
  reports.sort((a, b) => (a.id === input.reportId ? -1 : b.id === input.reportId ? 1 : 0));
  return { outcome: 'closed', reports };
});

export interface HoldAndFileInput {
  reportId: string;
  adminId: number;
  authority: number;
  externalRef: string | null;
  /** Ids for the account's hold and the conversation's (minted by the caller). */
  userHoldId: string;
  matchHoldId: string;
}

export type HoldAndFileOutcome =
  | { outcome: 'missing' }
  | { outcome: 'filed_already' }
  | { outcome: 'filed'; filing: AdminFilingRow; created: AdminHoldRow[]; holds: AdminHoldRow[]; targetId: string };

/**
 * Files a report with an authority and keeps what it is about, in one
 * statement: the report locked, its filing written once, and a hold on the
 * reported account and (when the report names one) the conversation,
 * unless an active hold of this report already keeps it. The hold's kind
 * follows the report: child safety (reason 8), a threat (6), else a
 * request from an authority.
 */
export const adminHoldAndFile = defineQuery({ name: 'adminModeration.holdAndFile', statements: 1 }, async (db, input: HoldAndFileInput): Promise<HoldAndFileOutcome> => {
  const row = await one<{ found: boolean; target_id: string | null; filing: unknown; created: unknown; existing: unknown }>(
    db,
    sql`WITH cur AS (SELECT x.id, x.target_id, x.match_id, x.reason FROM reports x WHERE x.id = ${input.reportId}::bigint FOR UPDATE),
             fil AS (
               INSERT INTO report_filings (report_id, filed_by, authority, external_ref)
               SELECT cur.id, ${input.adminId}::integer, ${input.authority}::smallint, ${input.externalRef}::text FROM cur
               ON CONFLICT (report_id) DO NOTHING
               RETURNING *),
             hold_user AS (
               INSERT INTO legal_holds (id, user_id, report_id, kind, created_by, authority_ref)
               SELECT ${input.userHoldId}::bigint, cur.target_id, cur.id, CASE cur.reason WHEN 8 THEN 1 WHEN 6 THEN 2 ELSE 3 END,
                      ${input.adminId}::integer, ${input.externalRef}::text
                 FROM cur, fil
                WHERE NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.report_id = cur.id AND h.user_id = cur.target_id AND h.released_at IS NULL)
               RETURNING *),
             hold_match AS (
               INSERT INTO legal_holds (id, match_id, report_id, kind, created_by, authority_ref)
               SELECT ${input.matchHoldId}::bigint, cur.match_id, cur.id, CASE cur.reason WHEN 8 THEN 1 WHEN 6 THEN 2 ELSE 3 END,
                      ${input.adminId}::integer, ${input.externalRef}::text
                 FROM cur, fil
                WHERE cur.match_id IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.report_id = cur.id AND h.match_id = cur.match_id AND h.released_at IS NULL)
               RETURNING *),
             created AS (SELECT * FROM hold_user UNION ALL SELECT * FROM hold_match)
        SELECT EXISTS (SELECT 1 FROM cur) AS found, (SELECT cur.target_id::text FROM cur) AS target_id,
               (SELECT ${filingJson} FROM fil f) AS filing,
               coalesce((SELECT jsonb_agg(${holdJson} ORDER BY h.id DESC) FROM created h LEFT JOIN users hu ON hu.id = h.user_id), '[]'::jsonb) AS created,
               coalesce((SELECT jsonb_agg(${holdJson} ORDER BY h.id DESC)
                           FROM legal_holds h LEFT JOIN users hu ON hu.id = h.user_id
                          WHERE h.report_id = ${input.reportId}::bigint AND h.released_at IS NULL), '[]'::jsonb) AS existing`,
  );
  if (!row.found || row.target_id === null) return { outcome: 'missing' };
  if (row.filing === null) return { outcome: 'filed_already' };
  const filing = filingRow.parse(row.filing);
  // The statement's own reads do not see what it wrote: the new holds carry the new filing, and come with the ones already there.
  const created = z.array(holdRow).parse(row.created).map((h) => ({ ...h, filing }));
  const existing = z.array(holdRow).parse(row.existing).map((h) => ({ ...h, filing }));
  return { outcome: 'filed', filing, created, holds: [...created, ...existing].sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1)), targetId: row.target_id };
});

// ─── Legal holds ──────────────────────────────────────────────────────────

/** Holds, newest first: the active ones (legal_holds_active_idx) or the released ones (a small table, by its key). */
export const adminHoldList = defineQuery(
  { name: 'adminModeration.holds', statements: 1 },
  async (db, options: { state: 'active' | 'released'; beforeId?: string | null | undefined; limit: number }): Promise<AdminHoldRow[]> => {
    const state = options.state === 'active' ? sql`h.released_at IS NULL` : sql`h.released_at IS NOT NULL`;
    const before = options.beforeId ? sql` AND h.id < ${options.beforeId}::bigint` : sql``;
    const rows = await many<{ item: unknown }>(
      db,
      sql`SELECT ${holdJson} AS item
            FROM legal_holds h LEFT JOIN users hu ON hu.id = h.user_id
           WHERE ${state}${before}
           ORDER BY h.id DESC
           LIMIT ${options.limit}`,
    );
    return rows.map((r) => holdRow.parse(r.item));
  },
);

export interface HoldCreateInput {
  id: string;
  userId: string | null;
  matchId: string | null;
  reportId: string | null;
  kind: number;
  adminId: number;
  authorityRef: string | null;
}

export type HoldCreateOutcome = { outcome: 'unknown_user' | 'unknown_conversation' | 'unknown_report' } | { outcome: 'created'; hold: AdminHoldRow };

/**
 * A hold an admin places, in one statement: what it names must exist (an
 * account not purged, a conversation, a report). The account row is read
 * FOR SHARE: a purge holding it (FOR UPDATE) is waited for and its outcome
 * judged on the row it leaves (status 8 is `unknown_user`), never on the
 * statement's older snapshot.
 */
export const adminCreateHold = defineQuery({ name: 'adminModeration.createHold', statements: 1 }, async (db, input: HoldCreateInput): Promise<HoldCreateOutcome> => {
  const row = await one<{ user_ok: boolean; match_ok: boolean; report_ok: boolean; item: unknown }>(
    db,
    sql`WITH u AS (SELECT x.id FROM users x WHERE x.id = ${input.userId}::bigint AND x.status <> 8 FOR SHARE),
             m AS (SELECT x.id FROM matches x WHERE x.id = ${input.matchId}::bigint),
             r AS (SELECT x.id FROM reports x WHERE x.id = ${input.reportId}::bigint),
             chk AS (SELECT (${input.userId}::bigint IS NULL OR EXISTS (SELECT 1 FROM u)) AS user_ok,
                            (${input.matchId}::bigint IS NULL OR EXISTS (SELECT 1 FROM m)) AS match_ok,
                            (${input.reportId}::bigint IS NULL OR EXISTS (SELECT 1 FROM r)) AS report_ok),
             ins AS (
               INSERT INTO legal_holds (id, user_id, match_id, report_id, kind, created_by, authority_ref)
               SELECT ${input.id}::bigint, (SELECT u.id FROM u), (SELECT m.id FROM m), (SELECT r.id FROM r), ${input.kind}::smallint,
                      ${input.adminId}::integer, ${input.authorityRef}::text
                 FROM chk WHERE chk.user_ok AND chk.match_ok AND chk.report_ok
               RETURNING *)
        SELECT chk.user_ok, chk.match_ok, chk.report_ok,
               (SELECT ${holdJson} FROM ins h LEFT JOIN users hu ON hu.id = h.user_id) AS item
          FROM chk`,
  );
  if (!row.user_ok) return { outcome: 'unknown_user' };
  if (!row.match_ok) return { outcome: 'unknown_conversation' };
  if (!row.report_ok) return { outcome: 'unknown_report' };
  return { outcome: 'created', hold: holdRow.parse(row.item) };
});

export type HoldReleaseOutcome = { outcome: 'missing' } | { outcome: 'released' | 'unchanged'; hold: AdminHoldRow };

/** Releases a hold (released, never deleted), with the reason; one already released is answered as it is. */
export const adminReleaseHold = defineQuery(
  { name: 'adminModeration.releaseHold', statements: 1 },
  async (db, input: { holdId: string; adminId: number; reason: string }): Promise<HoldReleaseOutcome> => {
    const row = await one<{ found: boolean; changed: boolean; item: unknown }>(
      db,
      sql`WITH cur AS (SELECT x.* FROM legal_holds x WHERE x.id = ${input.holdId}::bigint FOR UPDATE),
               upd AS (
                 UPDATE legal_holds x
                    SET released_at = now(), released_by = ${input.adminId}::integer, released_reason = ${input.reason}::text
                   FROM cur
                  WHERE x.id = cur.id AND cur.released_at IS NULL
                 RETURNING x.*),
               fin AS (SELECT * FROM upd UNION ALL SELECT * FROM cur WHERE NOT EXISTS (SELECT 1 FROM upd))
          SELECT EXISTS (SELECT 1 FROM cur) AS found, EXISTS (SELECT 1 FROM upd) AS changed,
                 (SELECT ${holdJson} FROM fin h LEFT JOIN users hu ON hu.id = h.user_id) AS item`,
    );
    if (!row.found) return { outcome: 'missing' };
    return { outcome: row.changed ? 'released' : 'unchanged', hold: holdRow.parse(row.item) };
  },
);

// ─── Appeals ──────────────────────────────────────────────────────────────

export const adminAppealRowSchema = z.object({
  id,
  status: z.number().int().min(1).max(3),
  body: z.string(),
  filedAtMs: epochMs,
  decisionText: z.string().nullable(),
  decidedAtMs: epochMs.nullable(),
  decidedBy: adminRef.nullable(),
  action: adminActionRowSchema,
  user: adminUserRefRowSchema,
  history: z.array(adminActionRowSchema),
  /** users.locale: the language the person reads the decision in. */
  locale: z.string(),
});
export type AdminAppealRow = z.infer<typeof adminAppealRowSchema>;

/** admin_appeal_json() with the person's language (a key probe of users). */
const appealWithLocale = (appeal: SqlFragment, userId: SqlFragment) =>
  sql`(${appeal} || jsonb_build_object('locale', (SELECT lu.locale FROM users lu WHERE lu.id = ${userId})))`;

/**
 * Appeals: the open ones oldest first (appeals_queue_idx) or the decided ones
 * newest first (the key). `withShadowbans` false: the person's other records
 * leave shadowbans out inside their limit (admin_appeal_json of 0031).
 */
export const adminAppealList = defineQuery(
  { name: 'adminModeration.appeals', statements: 1 },
  async (db, options: { status: 'open' | 'decided'; cursorId?: string | null | undefined; limit: number; withShadowbans: boolean }): Promise<AdminAppealRow[]> => {
    const open = options.status === 'open';
    const where = open
      ? options.cursorId
        ? sql`ap.status = 1 AND ap.id > ${options.cursorId}::bigint`
        : sql`ap.status = 1`
      : options.cursorId
        ? sql`ap.status <> 1 AND ap.id < ${options.cursorId}::bigint`
        : sql`ap.status <> 1`;
    const rows = await many<{ item: unknown }>(
      db,
      sql`SELECT ${appealWithLocale(sql`admin_appeal_json(ap, ${options.withShadowbans}::boolean)`, sql`ap.user_id`)} AS item FROM appeals ap WHERE ${where} ORDER BY ap.id ${open ? sql`ASC` : sql`DESC`} LIMIT ${options.limit}`,
    );
    return rows.map((r) => adminAppealRowSchema.parse(r.item));
  },
);

/** appeal_decide (0016) and the appeal after it (as {@link adminAppealList} reads it), in one statement. */
export const adminDecideAppeal = defineQuery(
  { name: 'adminModeration.decideAppeal', statements: 1 },
  async (db, input: { appealId: string; overturn: boolean; adminId: number; text: string; liftId: string; withShadowbans: boolean }): Promise<{ outcome: AppealDecision; appeal: AdminAppealRow | null }> => {
    const row = await one<{ out: unknown; appeal: unknown }>(
      db,
      sql`WITH d AS MATERIALIZED (
            SELECT appeal_decide(${input.appealId}::bigint, ${input.adminId}::integer, ${input.overturn}::boolean, ${input.text}::text, ${input.liftId}::bigint) AS out)
          SELECT d.out,
                 ${appealWithLocale(sql`admin_appeal_view(${input.appealId}::bigint, ${input.withShadowbans}::boolean)`, sql`(SELECT xa.user_id FROM appeals xa WHERE xa.id = ${input.appealId}::bigint)`)} AS appeal
            FROM d`,
    );
    return { outcome: appealDecisionSchema.parse(row.out), appeal: adminAppealRowSchema.nullable().parse(row.appeal) };
  },
);

// ─── The evidence sweep ───────────────────────────────────────────────────

/**
 * Empties the evidence of closed reports whose retention is over
 * (reports_evidence_purge_idx), oldest first, `limit` at a time. A report is
 * skipped while an active hold names it, its reported account, its reporter's
 * account or its conversation (legal_hold_active(): partial-index probes),
 * and is emptied on the first run after the last such hold is released. The
 * report keeps its reason, context, status and resolution. Returns the ids
 * emptied.
 */
export const sweepReportEvidence = defineQuery({ name: 'adminModeration.sweepEvidence', statements: 1 }, async (db, limit: number): Promise<string[]> => {
  const rows = await many<{ id: string }>(db, sweepReportEvidenceStatement(limit));
  return rows.map((r) => r.id);
});

export function sweepReportEvidenceStatement(limit: number): SqlFragment {
  return sql`UPDATE reports r
           SET evidence = '{}'::jsonb, details = NULL, evidence_purge_at = NULL
          FROM (SELECT x.id FROM reports x
                 WHERE x.evidence_purge_at <= now()
                   AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.report_id = x.id AND h.released_at IS NULL)
                   AND NOT legal_hold_active(x.target_id, x.match_id)
                   AND NOT (x.reporter_id IS NOT NULL AND legal_hold_active(x.reporter_id, NULL))
                 ORDER BY x.evidence_purge_at
                 LIMIT ${limit}
                   FOR UPDATE SKIP LOCKED) d
         WHERE r.id = d.id
        RETURNING r.id::text AS id`;
}
