import { z } from 'zod';
import {
  accountStatus,
  appealStatus,
  auditTarget,
  consentKind,
  deletedVia,
  gender,
  integrity,
  intention,
  ledgerReason,
  moderationKind,
  moderationReason,
  photoRejectReason,
  photoStatus,
  platform,
  productKind,
  purchaseState,
  reportContext,
  reportReason,
  reportResolution,
  reportStatus,
  revokeReason,
  store,
  subscriptionStatus,
  textRejectReason,
  textState,
  walletItem,
} from '../codes.js';
import { localeSchema } from '../locale.js';
import { pageQuerySchema, pageSchema } from '../pagination.js';
import { adminIdSchema } from './admin.js';
import { dateSchema, httpUrl, idSchema, publicUidSchema, timeSchema } from './common.js';

/**
 * The admin panel's user routes (`/v1/admin/users*`, the text decisions of
 * `/v1/admin/moderation/texts/{id}/*`, `/v1/admin/moderation/reasons`).
 *
 * A person is always their public id here (`AdminUserRef.id`), under a
 * neutral member name (`user`, `reported`, `reporter`, `linked`); every
 * other id is a decimal string, admin ids included. Enumerations are the
 * code tables' names, internal ones (a shadowban, a purged account)
 * included: admins see them. The phone number only travels in the answer of
 * `POST /users/{id}/reveal-phone`; search text only in a request body.
 */

// ─── People ───────────────────────────────────────────────────────────────

/** An admin as other answers name them. */
export const adminRefSchema = z.object({ id: adminIdSchema, displayName: z.string() });
export type AdminRef = z.infer<typeof adminRefSchema>;

/** A person: public id, display name (none before onboarding), status and the main approved photo (320 px) when a CDN is configured. */
export const adminUserRefSchema = z.object({
  id: publicUidSchema,
  name: z.string().nullable(),
  status: accountStatus.schema,
  photoUrl: httpUrl.optional(),
});
export type AdminUserRef = z.infer<typeof adminUserRefSchema>;

export const adminUserSummarySchema = adminUserRefSchema.extend({
  shadowbanned: z.boolean(),
  test: z.boolean(),
  verified: z.boolean(),
  country: z.string().nullable(),
  createdAt: timeSchema,
  lastActiveOn: dateSchema.nullable(),
});
export type AdminUserSummary = z.infer<typeof adminUserSummarySchema>;

/** The user list's filters, each served by its own index. */
export const adminUserFilters = ['pending_review', 'suspended', 'banned', 'shadowbanned', 'test'] as const;
export const adminUserFilterSchema = z.enum(adminUserFilters);
export type AdminUserFilter = z.infer<typeof adminUserFilterSchema>;

export const adminUserListQuerySchema = pageQuerySchema.extend({ filter: adminUserFilterSchema.optional() });
export const adminUserListSchema = pageSchema(adminUserSummarySchema);

/** Search text: a public id, a phone number, a store order id, a purchase token or part of a name. */
export const adminUserSearchRequestSchema = z.strictObject({ q: z.string().trim().min(1).max(4_096) });
export const adminUserMatchSchema = z.enum(['id', 'phone', 'order', 'token', 'name']);
export const adminUserSearchResultSchema = z.object({
  items: z.array(adminUserSummarySchema.extend({ matchedBy: adminUserMatchSchema })),
});
export type AdminUserSearchResult = z.infer<typeof adminUserSearchResultSchema>;

// ─── Moderation actions ───────────────────────────────────────────────────

export const adminActionAppealSchema = z.object({
  id: idSchema,
  status: appealStatus.schema,
  body: z.string(),
  decisionText: z.string().nullable(),
  decidedAt: timeSchema.nullable(),
  decidedBy: adminRefSchema.nullable(),
});

/**
 * A moderation record, every kind (a shadowban and internal notes included).
 * `reason` is the code's name in the reason table of its kind
 * (`moderationReason`; `photoRejectReason` for a rejected photo,
 * `textRejectReason` for a rejected text), `other` for an unknown code.
 * `standing`: a warning, suspension, ban or shadowban that is not revoked,
 * has started and has not ended. `admin` null: an automatic rule. A lift's
 * and a device ban's reasonText are internal: empty for a caller without
 * moderation.read.
 */
export const adminActionSchema = z.object({
  id: idSchema,
  kind: moderationKind.schema,
  reason: z.string(),
  reasonText: z.string(),
  note: z.string().nullable(),
  startsAt: timeSchema,
  endsAt: timeSchema.nullable(),
  revokedAt: timeSchema.nullable(),
  admin: adminRefSchema.nullable(),
  revokedBy: adminRefSchema.nullable(),
  reportId: idSchema.nullable(),
  standing: z.boolean(),
  appeal: adminActionAppealSchema.nullable(),
});
export type AdminAction = z.infer<typeof adminActionSchema>;

export const sideEffectsSchema = z.enum(['done', 'failed']);
export type SideEffects = z.infer<typeof sideEffectsSchema>;

// ─── The user page ────────────────────────────────────────────────────────

/** A prompt's question in each language the catalogue has it in. */
export const promptQuestionSchema = z.partialRecord(localeSchema, z.string());

export const adminProfilePromptSchema = z.object({
  position: z.number().int().min(0).max(2),
  promptId: z.number().int(),
  question: promptQuestionSchema,
  /** Null for a voice answer. */
  answer: z.string().nullable(),
  status: textState.schema,
  rejectReason: textRejectReason.schema.optional(),
});
export type AdminProfilePrompt = z.infer<typeof adminProfilePromptSchema>;

export const adminUserProfileSchema = z.object({
  name: z.string(),
  about: z.string().nullable(),
  job: z.string().nullable(),
  textState: textState.schema,
  textRejectReason: textRejectReason.schema.optional(),
  intention: intention.schema.optional(),
  completeness: z.number().int().min(0).max(100),
  /** profiles.version: the text decisions and the rename send it back. */
  version: z.number().int().positive(),
  prompts: z.array(adminProfilePromptSchema),
});

export const adminUserDetailSchema = adminUserSummarySchema.extend({
  locale: z.string(),
  gender: gender.schema.nullable(),
  birthDate: dateSchema.nullable(),
  deletedAt: timeSchema.nullable(),
  /** A deleted account is restorable until then (the purge). */
  purgeAt: timeSchema.nullable(),
  deletedVia: deletedVia.schema.nullable(),
  /** The status a deleted account returns to on a restore. */
  restoreStatus: accountStatus.schema.nullable(),
  onboardingStep: z.number().int(),
  phoneOnFile: z.boolean(),
  googleOnFile: z.boolean(),
  /** An active legal hold names the account. */
  heldNow: z.boolean(),
  profile: adminUserProfileSchema.nullable(),
  /** Warnings, suspensions, bans and shadowbans in effect. */
  standing: z.array(adminActionSchema),
  /** Open reports against the person: at most 20 counted, `more` beyond. */
  openReports: z.object({ count: z.number().int().min(0).max(20), more: z.boolean() }),
});
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>;

export const adminUserPhotoSchema = z.object({
  id: idSchema,
  position: z.number().int().min(0).max(8),
  status: photoStatus.schema,
  rejectReason: photoRejectReason.schema.optional(),
  /** Automatic labels (`photoModFlags` names). */
  modFlags: z.array(z.string()),
  hasFace: z.boolean().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  uploadedAt: timeSchema,
  decidedAt: timeSchema.nullable(),
  decidedBy: adminRefSchema.nullable(),
  /** 640 px; absent while processing or without a CDN. */
  url: httpUrl.optional(),
  /** 320 px. */
  thumbUrl: httpUrl.optional(),
});
export const adminUserPhotosSchema = z.object({ items: z.array(adminUserPhotoSchema) });
export type AdminUserPhoto = z.infer<typeof adminUserPhotoSchema>;

/** A report as the lists show it; `reporter` null: raised by an automatic detector. */
export const adminReportSummarySchema = z.object({
  id: idSchema,
  priority: z.number().int().min(0).max(100),
  reason: reportReason.schema,
  context: reportContext.schema,
  status: reportStatus.schema,
  filedAt: timeSchema,
  reported: adminUserRefSchema,
  reporter: adminUserRefSchema.nullable(),
  assignee: adminRefSchema.nullable(),
  /** `collecting` while the chat evidence waits for the message stream. */
  evidence: z.enum(['complete', 'collecting']),
  /** How a closed report was closed. */
  resolution: reportResolution.schema.optional(),
  resolvedAt: timeSchema.optional(),
  /** Filed with an outside authority (a report_filings row). */
  filed: z.boolean(),
});
export type AdminReportSummary = z.infer<typeof adminReportSummarySchema>;

export const adminUserReportsQuerySchema = pageQuerySchema.extend({ side: z.enum(['received', 'filed']).default('received') });
export const adminReportPageSchema = pageSchema(adminReportSummarySchema);

export const adminActionPageSchema = pageSchema(adminActionSchema);

/** The source of a subscription or balance: a store, or null for admin grants, gifts and rewards. */
const sourceSchema = store.schema.nullable();

export const adminUserPurchasesSchema = z.object({
  subscriptions: z.array(
    z.object({
      store: sourceSchema,
      plan: z.string(),
      status: subscriptionStatus.schema,
      startedAt: timeSchema,
      expiresAt: timeSchema,
      autoRenew: z.boolean(),
    }),
  ),
  /** The newest 50 purchases; never the token or its hash. */
  items: z.array(
    z.object({
      id: idSchema,
      store: store.schema,
      /** The store's sku. */
      productId: z.string(),
      kind: productKind.schema,
      state: purchaseState.schema,
      quantity: z.number().int(),
      purchasedAt: timeSchema,
      expiresAt: timeSchema.nullable(),
      orderId: z.string().nullable(),
      autoRenew: z.boolean().nullable(),
      isTest: z.boolean(),
      region: z.string().nullable(),
    }),
  ),
});

export type AdminUserPurchases = z.infer<typeof adminUserPurchasesSchema>;

export const adminLedgerEntrySchema = z.object({
  id: idSchema,
  at: timeSchema,
  item: walletItem.schema,
  store: sourceSchema,
  delta: z.number().int(),
  balanceAfter: z.number().int(),
  reason: ledgerReason.schema,
  admin: adminRefSchema.nullable(),
});
export const adminUserWalletSchema = z.object({
  balances: z.array(z.object({ item: walletItem.schema, store: sourceSchema, balance: z.number().int() })),
  ledger: pageSchema(adminLedgerEntrySchema),
});
export type AdminLedgerEntry = z.infer<typeof adminLedgerEntrySchema>;
export type AdminUserWallet = z.infer<typeof adminUserWalletSchema>;

export const adminUserDevicesSchema = z.object({
  items: z.array(
    z.object({
      id: idSchema,
      platform: platform.schema,
      store: store.schema,
      appVersion: z.number().int(),
      integrity: integrity.schema,
      locale: z.string().nullable(),
      updatedAt: timeSchema,
      disabledAt: timeSchema.nullable(),
      /** A push token is on file (never the token). */
      push: z.boolean(),
      /** Other accounts seen on the same device (up to 10). */
      linked: z.array(adminUserRefSchema),
    }),
  ),
});

export type AdminUserDevice = z.infer<typeof adminUserDevicesSchema>['items'][number];

export const adminUserSessionsSchema = z.object({
  items: z.array(
    z.object({
      id: idSchema,
      createdAt: timeSchema,
      refreshedAt: timeSchema,
      expiresAt: timeSchema,
      revokedAt: timeSchema.nullable(),
      revokeReason: revokeReason.schema.nullable(),
      store: store.schema,
      appVersion: z.number().int().nullable(),
      deviceId: idSchema.nullable(),
    }),
  ),
});

export type AdminUserSession = z.infer<typeof adminUserSessionsSchema>['items'][number];

export const adminUserConsentsSchema = z.object({
  items: z.array(
    z.object({
      kind: consentKind.schema,
      version: z.number().int(),
      acceptedAt: timeSchema,
      withdrawnAt: timeSchema.nullable(),
      store: store.schema.nullable(),
    }),
  ),
});

export type AdminUserConsent = z.infer<typeof adminUserConsentsSchema>['items'][number];

/**
 * One audit row. `targetRef` is the row's id (decimal); about a person it is
 * null and `user` carries their public id (a raw user id never travels).
 */
export const auditEntrySchema = z.object({
  id: idSchema,
  at: timeSchema,
  admin: adminRefSchema.nullable(),
  action: z.string(),
  targetType: auditTarget.schema,
  targetRef: z.string().nullable(),
  user: publicUidSchema.optional(),
  ip: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export const auditPageSchema = pageSchema(auditEntrySchema);

// ─── Sensitive views and test accounts ────────────────────────────────────

export const adminRevealPhoneSchema = z.object({ phone: z.string() });

export const adminTestAccountRequestSchema = z.strictObject({ test: z.boolean() });
export const adminUserChangeSchema = z.object({ user: adminUserDetailSchema, sideEffects: sideEffectsSchema });

// ─── Penalties ────────────────────────────────────────────────────────────

const reasonText = z.string().trim().min(1).max(1_000);
const note = z.string().trim().max(2_000);

/**
 * Every member a penalty takes; each kind's body is a strict subset of it
 * ({@link adminPenaltySchemas}): a warning has no end, a suspension needs
 * one, a shadowban carries no message (the person is never told).
 */
export const adminPenaltyRequestSchema = z.strictObject({
  reason: moderationReason.schema,
  reasonText: reasonText.optional(),
  note: note.optional(),
  endsAt: timeSchema.optional(),
  reportId: idSchema.optional(),
});
export type AdminPenaltyRequest = z.infer<typeof adminPenaltyRequestSchema>;

export const adminPenaltyKinds = ['warn', 'suspend', 'ban', 'shadowban'] as const;
export type AdminPenaltyKind = (typeof adminPenaltyKinds)[number];

export const adminPenaltySchemas = {
  warn: z.strictObject({ reason: moderationReason.schema, reasonText, note: note.optional(), reportId: idSchema.optional() }),
  suspend: z.strictObject({ reason: moderationReason.schema, reasonText, note: note.optional(), endsAt: timeSchema, reportId: idSchema.optional() }),
  ban: z.strictObject({ reason: moderationReason.schema, reasonText, note: note.optional(), endsAt: timeSchema.optional(), reportId: idSchema.optional() }),
  shadowban: z.strictObject({ reason: moderationReason.schema, note: note.optional(), endsAt: timeSchema.optional(), reportId: idSchema.optional() }),
} as const satisfies Record<AdminPenaltyKind, z.ZodType>;

/** The latest end a penalty may have, from now. */
export const PENALTY_MAX_DAYS = 3_650;

/** `deviceBansRemoved` (a lift): the device, phone and Google bans made for the action, removed with it. */
export const adminActionResultSchema = z.object({
  user: adminUserDetailSchema,
  action: adminActionSchema,
  deviceBansRemoved: z.number().int().min(0).optional(),
  sideEffects: sideEffectsSchema,
});

export const adminLiftRequestSchema = z.strictObject({ actionId: idSchema, reasonText: reasonText.optional() });

export const adminRevokeSessionsRequestSchema = z.strictObject({ note: note.optional() });
export const adminRevokeSessionsResultSchema = z.object({ sessions: z.number().int().min(0), sideEffects: sideEffectsSchema });

export const adminDeleteUserRequestSchema = z.strictObject({ note: note.optional() });
export const adminDeleteUserResultSchema = z.object({ user: adminUserDetailSchema, purgeAt: timeSchema, sideEffects: sideEffectsSchema });

export const adminRenameRequestSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(40),
  reason: textRejectReason.schema,
  version: z.number().int().positive(),
});

// ─── Text decisions ───────────────────────────────────────────────────────

export const adminTextPartSchema = z.object({ text: z.string(), state: textState.schema });

/** A person's texts as a decision sees them. */
export const adminTextItemSchema = z.object({
  user: adminUserRefSchema,
  version: z.number().int().positive(),
  about: adminTextPartSchema.nullable(),
  job: adminTextPartSchema.nullable(),
  textRejectReason: textRejectReason.schema.optional(),
  prompts: z.array(adminProfilePromptSchema),
});
export type AdminTextItem = z.infer<typeof adminTextItemSchema>;

export const adminTextApproveRequestSchema = z.strictObject({ version: z.number().int().positive() });
/** Neither `profile` nor `prompts`: every part that waits is rejected. Parts not named that wait are approved. */
export const adminTextRejectRequestSchema = z.strictObject({
  version: z.number().int().positive(),
  reason: textRejectReason.schema,
  profile: z.boolean().optional(),
  prompts: z
    .array(z.number().int().min(0).max(2))
    .max(3)
    .refine((list) => new Set(list).size === list.length, 'each position once')
    .optional(),
});
export const adminTextDecisionSchema = z.object({ texts: adminTextItemSchema, sideEffects: sideEffectsSchema });

// ─── Reasons ──────────────────────────────────────────────────────────────

export const reasonTextsSchema = z.object({ en: z.string(), fa: z.string(), tr: z.string() });
const reasonEntry = z.object({ reason: z.string(), texts: reasonTextsSchema });

/** Every reason with the text a person reads in each language (the panel pre-fills the message from it). */
export const adminReasonsSchema = z.object({
  moderation: z.array(reasonEntry),
  photo: z.array(reasonEntry),
  text: z.array(reasonEntry),
});
export type AdminReasons = z.infer<typeof adminReasonsSchema>;
