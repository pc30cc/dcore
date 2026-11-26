import { z } from 'zod';
import { auditTarget, bannedTermMatch, bannedTermScope, bannedTermSeverity, deviceBanKind, store } from '../codes.js';
import { localeSchema } from '../locale.js';
import { pageQuerySchema, pageSchema } from '../pagination.js';
import { adminIdSchema } from './admin.js';
import { adminRefSchema, adminUserRefSchema, sideEffectsSchema } from './adminUsers.js';
import { dateSchema, idSchema, publicUidSchema, timeSchema } from './common.js';

/**
 * The admin panel's rules and records: banned terms
 * (`/v1/admin/banned-terms*`), device, phone and Google-account bans
 * (`/v1/admin/device-bans*`) and the audit log (`/v1/admin/audit*`).
 *
 * A ban never carries its hash; a phone number only travels in a request
 * body (a lookup or a ban by number), never in an answer or a URL. A person
 * is their public id; every other id is a decimal string.
 */

// ─── Banned terms ─────────────────────────────────────────────────────────

/** The languages a term may be limited to; null: every language. */
export const bannedTermLocaleSchema = localeSchema.nullable();

export const adminBannedTermSchema = z.object({
  id: idSchema,
  term: z.string(),
  match: bannedTermMatch.schema,
  severity: bannedTermSeverity.schema,
  scope: z.array(bannedTermScope.schema).min(1),
  locale: bannedTermLocaleSchema,
  active: z.boolean(),
  createdAt: timeSchema,
  createdBy: adminRefSchema.nullable(),
});
export type AdminBannedTerm = z.infer<typeof adminBannedTermSchema>;

/** `q`: part of the term (a term is a rule, not personal data, so it may travel in the URL). */
export const adminBannedTermListQuerySchema = pageQuerySchema.extend({ q: z.string().trim().min(1).max(200).optional() });
export const adminBannedTermPageSchema = pageSchema(adminBannedTermSchema);

const termScopes = z
  .array(bannedTermScope.schema)
  .min(1)
  .max(bannedTermScope.names.length)
  .refine((list) => new Set(list).size === list.length, 'each scope once');

const termFields = {
  term: z.string().min(1).max(200).refine((value) => value.trim().length > 0, 'not blank'),
  match: bannedTermMatch.schema,
  severity: bannedTermSeverity.schema,
  scope: termScopes,
  locale: bannedTermLocaleSchema.optional(),
  active: z.boolean().optional(),
};

export const adminBannedTermCreateSchema = z.strictObject(termFields);
export type AdminBannedTermCreate = z.infer<typeof adminBannedTermCreateSchema>;

export const adminBannedTermUpdateSchema = z
  .strictObject({
    term: termFields.term.optional(),
    match: termFields.match.optional(),
    severity: termFields.severity.optional(),
    scope: termScopes.optional(),
    locale: bannedTermLocaleSchema.optional(),
    active: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), 'nothing to change');
export type AdminBannedTermUpdate = z.infer<typeof adminBannedTermUpdateSchema>;

export const adminBannedTermResultSchema = z.object({ term: adminBannedTermSchema, sideEffects: sideEffectsSchema });

// ─── Device bans ──────────────────────────────────────────────────────────

/** A ban of a device key, a phone number or a Google account; `expiresAt` null: permanent. `user`: the person whose record made it. */
export const adminDeviceBanSchema = z.object({
  id: idSchema,
  kind: deviceBanKind.schema,
  store: store.schema.nullable(),
  reason: z.string(),
  createdAt: timeSchema,
  createdBy: adminRefSchema.nullable(),
  expiresAt: timeSchema.nullable(),
  active: z.boolean(),
  user: adminUserRefSchema.nullable(),
  actionId: idSchema.nullable(),
});
export type AdminDeviceBan = z.infer<typeof adminDeviceBanSchema>;

export const adminDeviceBanListQuerySchema = pageQuerySchema.extend({ kind: deviceBanKind.schema.optional() });
export const adminDeviceBanPageSchema = pageSchema(adminDeviceBanSchema);

/** The bans of one phone number (any pepper the number was hashed under). */
export const adminDeviceBanSearchSchema = z.strictObject({ phone: z.string().trim().min(1).max(40) });
export const adminDeviceBanListSchema = z.object({ items: z.array(adminDeviceBanSchema) });

const banReason = z.string().trim().min(1).max(500);

export const adminDeviceBanCreateSchema = z.discriminatedUnion('from', [
  z.strictObject({
    from: z.literal('user'),
    user: publicUidSchema,
    kinds: z
      .array(deviceBanKind.schema)
      .min(1)
      .max(3)
      .refine((list) => new Set(list).size === list.length, 'each kind once'),
    expiresAt: timeSchema.optional(),
    reason: banReason,
    /** The person's standing suspension or ban these bans go with: lifting it (or overturning its appeal) removes them. */
    forAction: idSchema.optional(),
  }),
  z.strictObject({ from: z.literal('phone'), phone: z.string().trim().min(1).max(40), expiresAt: timeSchema.optional(), reason: banReason }),
]);
export type AdminDeviceBanCreate = z.infer<typeof adminDeviceBanCreateSchema>;
/** Why a ban is removed (kept in its audit row). */
export const adminDeviceBanDeleteSchema = z.strictObject({ reason: banReason });

// ─── The audit log ────────────────────────────────────────────────────────

/** Every action the API writes to the audit log (`area.verb`). */
export const auditActions = [
  // Admin accounts, sign-in and sessions (W7a)
  'admin.bootstrap',
  'admin.force_reset',
  'admin.login',
  'admin.logout',
  'admin.logout_all',
  'admin.totp_issue',
  'admin.totp_enroll',
  'admin.session_revoke',
  'admin.password_change',
  'admin.create',
  'admin.update',
  'admin.disable',
  'admin.enable',
  'admin.totp_reset',
  'admin.password_reset',
  // Plans, store products and settings
  'plan.create',
  'plan.update',
  'plan.archive',
  'plan.unarchive',
  'plan.reorder',
  'product.create',
  'product.update',
  'product.activate',
  'product.deactivate',
  'config.update',
  // People
  'user.view_phone',
  'user.search',
  'user.test_account',
  'user.warn',
  'user.suspend',
  'user.ban',
  'user.shadowban',
  'user.lift',
  'user.revoke_sessions',
  'user.delete',
  'user.rename',
  // Moderation
  'text.approve',
  'text.reject',
  'photo.approve',
  'photo.reject',
  'report.view_chat',
  'report.assign',
  'report.resolve',
  'report.dismiss',
  'report.file',
  'hold.create',
  'hold.release',
  'appeal.uphold',
  'appeal.overturn',
  // Rules and records
  'banned_term.create',
  'banned_term.update',
  'banned_term.delete',
  'device_ban.create',
  'device_ban.delete',
  'audit.export',
] as const;
export type AuditAction = (typeof auditActions)[number];
export const auditActionSchema = z.enum(auditActions);

/** A day (whole UTC day) or an instant; `from` is inclusive, `to` exclusive for an instant and inclusive for a day. */
export const auditBoundSchema = z.union([dateSchema, timeSchema]);

/** The audit search's filters: each alone or combined. `target` (a public id for a user, else a decimal id) needs `targetType`. */
export const auditFilterFields = {
  admin: adminIdSchema.optional(),
  targetType: auditTarget.schema.optional(),
  target: z.string().trim().min(1).max(20).optional(),
  action: auditActionSchema.optional(),
  from: auditBoundSchema.optional(),
  to: auditBoundSchema.optional(),
};

const targetNeedsType = <T extends { target?: string | undefined; targetType?: string | undefined }>(filters: T) => filters.target === undefined || filters.targetType !== undefined;

export const adminAuditQuerySchema = pageQuerySchema.extend(auditFilterFields).refine(targetNeedsType, { message: 'a target needs its type', path: ['target'] });
export type AdminAuditQuery = z.infer<typeof adminAuditQuerySchema>;

export const adminAuditExportSchema = z.strictObject(auditFilterFields).refine(targetNeedsType, { message: 'a target needs its type', path: ['target'] });
export type AdminAuditExport = z.infer<typeof adminAuditExportSchema>;
export type AuditFilters = Omit<AdminAuditQuery, 'cursor' | 'limit'>;

/** The most rows one export carries. */
export const AUDIT_EXPORT_MAX_ROWS = 10_000;

/** The admins the audit page can filter by (`admins.read` is a superadmin permission, so the page has its own list). */
export const adminAuditAdminsSchema = z.object({
  items: z.array(z.object({ id: adminIdSchema, displayName: z.string(), disabled: z.boolean() })),
});
export type AdminAuditAdmin = z.infer<typeof adminAuditAdminsSchema>['items'][number];
