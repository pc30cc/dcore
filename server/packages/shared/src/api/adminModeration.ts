import { z } from 'zod';
import {
  appealStatus,
  filingAuthority,
  gender,
  legalHoldKind,
  messageKind,
  photoRejectReason,
  photoStatus,
  reportContext,
  reportReason,
  reportResolution,
  requestStatus,
  textState,
} from '../codes.js';
import { pageQuerySchema, pageSchema } from '../pagination.js';
import { adminIdSchema } from './admin.js';
import {
  adminActionSchema,
  adminRefSchema,
  adminReportSummarySchema,
  adminTextItemSchema,
  adminUserRefSchema,
  promptQuestionSchema,
  sideEffectsSchema,
} from './adminUsers.js';
import { httpUrl, idSchema, publicUidSchema, timeSchema } from './common.js';

/**
 * The admin panel's moderation routes: the photo and text queues, reports
 * (the queue, a report's page, its chat evidence, assignment, closing,
 * filing with an authority), legal holds and appeals
 * (`/v1/admin/moderation/*`, `/v1/admin/reports*`, `/v1/admin/holds*`,
 * `/v1/admin/appeals*`).
 *
 * People are public ids under neutral names (`user`, `reported`,
 * `reporter`), every other id a decimal string. A chat message body travels
 * only in the answer of `POST /reports/{id}/evidence` (audited), and its
 * sender only as a role (`reporter`, `reported`, `other`).
 */

// ─── The photo queue ──────────────────────────────────────────────────────

const queueLimit = (fallback: number) => z.coerce.number().int().min(1).max(50).default(fallback);

export const adminPhotoQueueQuerySchema = pageQuerySchema.extend({ limit: queueLimit(24) });

/** A person as a queue shows them: the reference and what a decision on a photo weighs. */
export const adminQueuePersonSchema = adminUserRefSchema.extend({
  age: z.number().int().nullable(),
  gender: gender.schema.nullable(),
  country: z.string().nullable(),
  verified: z.boolean(),
});

/** A photo waiting for a human, oldest first, with the person's other photos. */
export const adminQueuePhotoSchema = z.object({
  id: idSchema,
  position: z.number().int().min(0).max(8),
  /** Automatic labels (`photoModFlags` names). */
  modFlags: z.array(z.string()),
  hasFace: z.boolean().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  uploadedAt: timeSchema,
  /** 640 px; absent without a CDN. */
  url: httpUrl.optional(),
  /** 320 px. */
  thumbUrl: httpUrl.optional(),
  user: adminQueuePersonSchema,
  others: z.array(z.object({ id: idSchema, status: photoStatus.schema, thumbUrl: httpUrl.optional() })),
});
export type AdminQueuePhoto = z.infer<typeof adminQueuePhotoSchema>;
export const adminPhotoQueueSchema = pageSchema(adminQueuePhotoSchema);

/** `unreadable` is the worker's own code (a file that is not a photo): an admin rejects with another (422 `wrong_reason`). */
/** `from`: the photo's status as the admin saw it; a photo decided otherwise meanwhile is a 409 (`Already decided.`). */
export const adminPhotoApproveRequestSchema = z.strictObject({ from: photoStatus.schema.optional() });
export const adminPhotoRejectRequestSchema = z.strictObject({ reason: photoRejectReason.schema, from: photoStatus.schema.optional() });

export const adminPhotoDecisionSchema = z.object({
  photo: z.object({ id: idSchema, status: photoStatus.schema, rejectReason: photoRejectReason.schema.optional() }),
  sideEffects: sideEffectsSchema,
});
export type AdminPhotoDecision = z.infer<typeof adminPhotoDecisionSchema>;

// ─── The text queue ───────────────────────────────────────────────────────

export const adminTextQueueQuerySchema = pageQuerySchema.extend({ limit: queueLimit(20) });
/** People with texts waiting, by account: the shape the text decisions answer. */
export const adminTextQueueSchema = pageSchema(adminTextItemSchema);

// ─── Reports ──────────────────────────────────────────────────────────────

export const adminReportViews = ['queue', 'mine', 'unassigned', 'resolved'] as const;
export const adminReportViewSchema = z.enum(adminReportViews);
export type AdminReportView = z.infer<typeof adminReportViewSchema>;
export const adminReportListQuerySchema = pageQuerySchema.extend({ view: adminReportViewSchema.default('queue') });

/** An outside authority's record of a report. */
export const adminFilingSchema = z.object({
  authority: filingAuthority.schema,
  externalRef: z.string().nullable(),
  filedAt: timeSchema,
  filedBy: adminRefSchema.nullable(),
});
export type AdminFiling = z.infer<typeof adminFilingSchema>;

/** A legal hold: what it keeps (an account, a conversation), why and until it is released. `createdBy` null: an automatic rule. */
export const adminHoldSchema = z.object({
  id: idSchema,
  kind: legalHoldKind.schema,
  user: adminUserRefSchema.nullable(),
  conversationId: idSchema.nullable(),
  reportId: idSchema.nullable(),
  createdAt: timeSchema,
  createdBy: adminRefSchema.nullable(),
  authorityRef: z.string().nullable(),
  evidenceCopiedAt: timeSchema.nullable(),
  releasedAt: timeSchema.nullable(),
  releasedBy: adminRefSchema.nullable(),
  releasedReason: z.string().nullable(),
  filing: adminFilingSchema.nullable(),
});
export type AdminHold = z.infer<typeof adminHoldSchema>;

/** The reported profile as it was when a filing was made (its photos by id). */
export const adminProfileSnapshotSchema = z.object({
  name: z.string().nullable(),
  about: z.string().nullable(),
  job: z.string().nullable(),
  textState: textState.schema.nullable(),
  prompts: z.array(z.object({ promptId: z.number().int(), question: promptQuestionSchema, answer: z.string().nullable(), status: textState.schema.nullable() })),
  /** `status` and `thumbUrl` while the photo still exists. */
  photos: z.array(z.object({ id: idSchema, status: photoStatus.schema.optional(), thumbUrl: httpUrl.optional() })),
});

/** One filing of a report (a second report by the same person adds one). */
export const adminReportFilingSchema = z.object({
  id: idSchema,
  at: timeSchema,
  context: reportContext.schema,
  reason: reportReason.schema,
  details: z.string().nullable(),
  conversationId: idSchema.optional(),
  /** How many messages the filing named (their text is in the evidence). */
  messages: z.number().int().min(0),
  callId: idSchema.optional(),
  photo: z.object({ id: idSchema, status: photoStatus.schema.optional(), url: httpUrl.optional() }).optional(),
  profile: adminProfileSnapshotSchema.optional(),
});
export type AdminReportFiling = z.infer<typeof adminReportFilingSchema>;

/** One row of a report's history. */
export const adminReportHistoryEntrySchema = z.object({ id: idSchema, at: timeSchema, admin: adminRefSchema.nullable(), action: z.string() });
export type AdminReportHistoryEntry = z.infer<typeof adminReportHistoryEntrySchema>;

export const adminReportDetailSchema = adminReportSummarySchema.extend({
  /** The reporter's words (report content: reports.read). */
  details: z.string().nullable(),
  conversationId: idSchema.nullable(),
  /** When the chat evidence was complete; null while it is collected. */
  evidenceAt: timeSchema.nullable(),
  filings: z.array(adminReportFilingSchema),
  /** Active holds naming the report. */
  holds: z.array(adminHoldSchema),
  filing: adminFilingSchema.nullable(),
  /** The reported person's actions taken on this report. */
  actions: z.array(adminActionSchema),
  /** Other open reports on the same person (up to 10). */
  otherOpen: z.array(adminReportSummarySchema),
  /** The report's audit rows, newest first (up to 20): who did what when (the address and detail are the audit log's, audit.read). */
  history: z.array(adminReportHistoryEntrySchema),
  /** For a child-safety report, whom to contact (the app's settings), when set. */
  childSafetyContact: z.object({ name: z.string().nullable(), email: z.string().nullable() }).optional(),
});
export type AdminReportDetail = z.infer<typeof adminReportDetailSchema>;

/** Who wrote a message or request of the evidence: never the raw sender. */
export const evidenceRoleSchema = z.enum(['reporter', 'reported', 'other']);
export type EvidenceRole = z.infer<typeof evidenceRoleSchema>;

export const adminEvidenceSchema = z.object({
  evidenceAt: timeSchema.nullable(),
  chat: z.array(
    z.object({
      filingId: idSchema,
      conversationId: idSchema.nullable(),
      takenAt: timeSchema,
      messages: z.array(
        z.object({
          id: idSchema,
          from: evidenceRoleSchema,
          kind: messageKind.schema,
          /** `messageFlags` names. */
          flags: z.array(z.string()),
          body: z.string().nullable(),
          at: timeSchema,
          /** Copied from the message stream (the database had not stored it yet). */
          late: z.boolean(),
          /** One of the messages a filing named. */
          named: z.boolean(),
        }),
      ),
      requests: z.array(z.object({ id: idSchema, from: evidenceRoleSchema, status: requestStatus.schema, body: z.string().nullable(), at: timeSchema })),
    }),
  ),
});
export type AdminEvidence = z.infer<typeof adminEvidenceSchema>;

/** `from`: the assignee the admin saw (a different one now is a 409); `to` null unassigns. */
export const adminReportAssignRequestSchema = z.strictObject({ to: adminIdSchema.nullable(), from: adminIdSchema.nullable() });

/**
 * Closing a report: `resolve` takes a resolution with an action
 * (`ACTION_RESOLUTIONS`), `dismiss` one without (`CLOSE_RESOLUTIONS`); a
 * resolution of the other group is a 422 (`wrong_resolution`).
 */
export const adminReportCloseRequestSchema = z.strictObject({
  resolution: reportResolution.schema,
  note: z.string().trim().max(2_000).optional(),
  /** Also close the person's other open reports (up to 50). */
  sameTarget: z.boolean().optional(),
});
export const adminReportCloseSchema = z.object({ items: z.array(adminReportSummarySchema) });

export const adminHoldAndFileRequestSchema = z.strictObject({
  authority: filingAuthority.schema,
  externalRef: z.string().trim().min(1).max(200).optional(),
});
export const adminHoldAndFileSchema = z.object({ filing: adminFilingSchema, holds: z.array(adminHoldSchema) });
export type AdminHoldAndFile = z.infer<typeof adminHoldAndFileSchema>;

// ─── Legal holds ──────────────────────────────────────────────────────────

export const adminHoldListQuerySchema = pageQuerySchema.extend({ state: z.enum(['active', 'released']).default('active') });
export const adminHoldPageSchema = pageSchema(adminHoldSchema);

export const adminHoldCreateRequestSchema = z.strictObject({
  user: publicUidSchema.optional(),
  conversationId: idSchema.optional(),
  reportId: idSchema.optional(),
  kind: legalHoldKind.schema,
  authorityRef: z.string().trim().min(1).max(200).optional(),
});
export const adminHoldReleaseRequestSchema = z.strictObject({ reason: z.string().trim().min(1).max(500) });

// ─── Appeals ──────────────────────────────────────────────────────────────

/** An appeal with the record it is about, the person and their other recent records. */
export const adminAppealSchema = z.object({
  id: idSchema,
  status: appealStatus.schema,
  body: z.string(),
  filedAt: timeSchema,
  decisionText: z.string().nullable(),
  decidedAt: timeSchema.nullable(),
  decidedBy: adminRefSchema.nullable(),
  action: adminActionSchema,
  user: adminUserRefSchema,
  /** The person's ten newest other records, any kind. */
  history: z.array(adminActionSchema),
  /** The person's language (users.locale): the decision text is written for them. */
  locale: z.string(),
});
export type AdminAppeal = z.infer<typeof adminAppealSchema>;

export const adminAppealListQuerySchema = pageQuerySchema.extend({ status: z.enum(['open', 'decided']).default('open') });
export const adminAppealPageSchema = pageSchema(adminAppealSchema);

/** The decision the person reads. */
export const adminAppealDecisionRequestSchema = z.strictObject({ text: z.string().trim().min(1).max(2_000) });
/** `deviceBansRemoved`: the device, phone and Google bans an overturn removed with the action. */
export const adminAppealDecisionSchema = z.object({
  appeal: adminAppealSchema,
  deviceBansRemoved: z.number().int().min(0).optional(),
  sideEffects: sideEffectsSchema,
});
export type AdminAppealDecision = z.infer<typeof adminAppealDecisionSchema>;
