import type {
  RemovedDeviceBan,
  AdminActionRow,
  AdminAppealRow,
  AdminAuditRow,
  AdminFilingRow,
  AdminHoldRow,
  AdminPromptRow,
  AdminReportRow,
  AdminTextRow,
  AdminUserDetailRow,
  AdminUserRefRow,
  AdminUserSummaryRow,
} from '@app/db';
import {
  accountStatus,
  appealStatus,
  auditTarget,
  deletedVia,
  deviceBanKind,
  filingAuthority,
  gender,
  intention,
  isLocale,
  legalHoldKind,
  moderationKind,
  moderationReason,
  photoRejectReason,
  reportContext,
  reportReason,
  reportResolution,
  reportStatus,
  store as storeCodes,
  textRejectReason,
  textState,
  wireTime,
  type AdminAction,
  type AdminAppeal,
  type AdminFiling,
  type AdminHold,
  type AdminProfilePrompt,
  type AdminRef,
  type AdminReportSummary,
  type AdminTextItem,
  type AdminUserDetail,
  type AdminUserRef,
  type AdminUserSummary,
  type AuditEntry,
  type Locale,
  type Permission,
  type ReportResolution,
} from '@app/shared';
import { photoVariantUrl } from '@app/shared/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpProblem } from '../lib/problem.js';
import type { ConfigSnapshot } from '../services/cfg.js';

/**
 * From the rows of `@app/db`'s admin queries (raw ids, codes, epoch ms) to
 * the admin wire: people as public ids, codes as names, times as RFC 3339,
 * photo links signed by the CDN (absent without one).
 */

/** The `{id}` of a person's route: their public id, decoded; anything else is 404. */
export function readUserParam(app: FastifyInstance, publicUid: string): string {
  const userId = app.publicIds.user.decodeId(publicUid);
  if (userId === null) throw new HttpProblem('not_found', { detail: 'No such user.' });
  return userId;
}

export function noSuchUser(): HttpProblem {
  return new HttpProblem('not_found', { detail: 'No such user.' });
}

/** An account's state as the audit rows keep it (before and after a write). */
export function accountStateOf(state: { status: number; shadowbanned: boolean }) {
  return { status: accountStatus.name(state.status), shadowbanned: state.shadowbanned };
}

/** The `device_ban.delete` row of a ban removed with the action it was made for (a lift, an overturn); never the hash. */
export function removedBanAuditOf(app: FastifyInstance, userId: string, actionId: string, ban: RemovedDeviceBan, cause: 'lift' | 'appeal') {
  return {
    action: 'device_ban.delete' as const,
    target: 'device_ban' as const,
    targetId: ban.id,
    detail: {
      before: {
        kind: deviceBanKind.name(ban.kind),
        store: ban.store === null ? null : (storeCodes.nameOrUndefined(ban.store) ?? null),
        expiresAt: ban.expiresAtMs === null ? null : wireTime(ban.expiresAtMs),
        reason: ban.reason,
        user: app.publicIds.user.encode(userId),
        actionId,
      },
      cause,
    },
  };
}

/** A person's language for the texts they read: the first two letters of users.locale when the product ships it, else English. */
export function personLocale(locale: string): Locale {
  const short = locale.slice(0, 2);
  return isLocale(short) ? short : 'en';
}

export function adminRefOf(row: { id: string; displayName: string } | null): AdminRef | null {
  return row ? { id: row.id, displayName: row.displayName } : null;
}

/** The 640 and 320 px links of a photo; absent without a CDN. */
export function photoUrls(app: FastifyInstance, photoId: string, blobVer: number): { url?: string; thumbUrl?: string } {
  if (!app.media?.urls) return {};
  const url = photoVariantUrl(app.media, photoId, blobVer, 640);
  const thumbUrl = photoVariantUrl(app.media, photoId, blobVer, 320);
  return { ...(url ? { url } : {}), ...(thumbUrl ? { thumbUrl } : {}) };
}

export function userRefOf(app: FastifyInstance, row: AdminUserRefRow): AdminUserRef {
  const photoUrl = row.photo && app.media ? photoVariantUrl(app.media, row.photo.id, row.photo.blobVer, 320) : undefined;
  return {
    id: app.publicIds.user.encode(row.id),
    name: row.name,
    status: accountStatus.name(row.status),
    ...(photoUrl ? { photoUrl } : {}),
  };
}

/**
 * What a caller's roles let them read on a person beyond `users.read`
 * (support and finance hold that alone): shadowbans (`users.shadowban` or
 * `moderation.read`: the flag, the records, the list filter), internal notes
 * (a record's note, a lift's text, a device ban's reason) and the accounts
 * linked by device (`moderation.read`), legal holds (`reports.hold`). Those
 * are the things most likely to reach their subject through someone who
 * answers them.
 */
export interface UserReadScope {
  shadow: boolean;
  notes: boolean;
  holds: boolean;
  linked: boolean;
}

export const FULL_USER_SCOPE: UserReadScope = { shadow: true, notes: true, holds: true, linked: true };

export function userReadScope(app: FastifyInstance, request: FastifyRequest): UserReadScope {
  const moderation = callerMay(app, request, 'moderation.read');
  return {
    shadow: moderation || callerMay(app, request, 'users.shadowban'),
    notes: moderation,
    holds: callerMay(app, request, 'reports.hold'),
    linked: moderation,
  };
}

const SHADOWBAN_KIND = 4;
/** Records whose reasonText is written by an admin for the team, not for the person: internal notes. */
const INTERNAL_TEXT_KINDS: ReadonlySet<number> = new Set([moderationKind.code('lift'), moderationKind.code('device_ban')]);

export function userSummaryOf(app: FastifyInstance, row: AdminUserSummaryRow, scope: UserReadScope = FULL_USER_SCOPE): AdminUserSummary {
  return {
    ...userRefOf(app, row),
    // Without the right to see shadowbans, nobody reads as shadowbanned.
    shadowbanned: scope.shadow && row.shadowbanned,
    test: row.test,
    verified: row.verified,
    country: row.country,
    createdAt: wireTime(row.createdAtMs),
    lastActiveOn: row.lastActiveOn,
  };
}

/** The name of a reason code in the table of its record's kind; `other` for a code the table does not know. */
export function reasonNameOf(kind: number, code: number): string {
  const table = kind === moderationKind.code('photo_rejected') ? photoRejectReason : kind === moderationKind.code('text_rejected') ? textRejectReason : moderationReason;
  return table.nameOrUndefined(code) ?? 'other';
}

/** Whether a record is shown to a caller of `scope` (a shadowban only to those who may see shadowbans). */
export function actionVisible(row: { kind: number }, scope: UserReadScope = FULL_USER_SCOPE): boolean {
  return scope.shadow || row.kind !== SHADOWBAN_KIND;
}

export function actionOf(row: AdminActionRow, scope: UserReadScope = FULL_USER_SCOPE): AdminAction {
  return {
    id: row.id,
    kind: moderationKind.name(row.kind),
    reason: reasonNameOf(row.kind, row.reasonCode),
    reasonText: scope.notes || !INTERNAL_TEXT_KINDS.has(row.kind) ? row.reasonText : '',
    note: scope.notes ? row.note : null,
    startsAt: wireTime(row.startsAtMs),
    endsAt: row.endsAtMs === null ? null : wireTime(row.endsAtMs),
    revokedAt: row.revokedAtMs === null ? null : wireTime(row.revokedAtMs),
    admin: adminRefOf(row.admin),
    revokedBy: adminRefOf(row.revokedBy),
    reportId: row.reportId,
    standing: row.standing,
    appeal: row.appeal
      ? {
          id: row.appeal.id,
          status: appealStatus.name(row.appeal.status),
          body: row.appeal.body,
          decisionText: row.appeal.decisionText,
          decidedAt: row.appeal.decidedAtMs === null ? null : wireTime(row.appeal.decidedAtMs),
          decidedBy: adminRefOf(row.appeal.decidedBy),
        }
      : null,
  };
}

/** A prompt's question in each language the catalogue has (from memory; empty for a prompt no longer listed). */
export function promptQuestion(cfg: ConfigSnapshot, promptId: number): Partial<Record<Locale, string>> {
  const def = cfg.promptsById.get(promptId);
  const out: Partial<Record<Locale, string>> = {};
  if (!def) return out;
  for (const [key, value] of Object.entries(def.i18n)) if (isLocale(key) && typeof value === 'string') out[key] = value;
  return out;
}

export function promptOf(cfg: ConfigSnapshot, row: AdminPromptRow): AdminProfilePrompt {
  const rejectReason = row.status === textState.code('rejected') && row.rejectReason !== null ? textRejectReason.nameOrUndefined(row.rejectReason) : undefined;
  return {
    position: row.position,
    promptId: row.promptId,
    question: promptQuestion(cfg, row.promptId),
    answer: row.answer,
    status: textState.name(row.status),
    ...(rejectReason ? { rejectReason } : {}),
  };
}

export function userDetailOf(app: FastifyInstance, cfg: ConfigSnapshot, row: AdminUserDetailRow, scope: UserReadScope = FULL_USER_SCOPE): AdminUserDetail {
  const p = row.profile;
  const textReject = p?.textState === textState.code('rejected') && p.textRejectReason !== null ? textRejectReason.nameOrUndefined(p.textRejectReason) : undefined;
  const intent = p?.intention === null || p?.intention === undefined ? undefined : intention.nameOrUndefined(p.intention);
  return {
    ...userSummaryOf(app, row, scope),
    locale: row.locale,
    gender: row.gender === null ? null : (gender.nameOrUndefined(row.gender) ?? null),
    birthDate: row.birthDate,
    deletedAt: row.deletedAtMs === null ? null : wireTime(row.deletedAtMs),
    purgeAt: row.purgeAtMs === null ? null : wireTime(row.purgeAtMs),
    deletedVia: row.deletedVia === null ? null : (deletedVia.nameOrUndefined(row.deletedVia) ?? null),
    restoreStatus: row.restoreStatus === null ? null : (accountStatus.nameOrUndefined(row.restoreStatus) ?? null),
    onboardingStep: row.onboardingStep,
    phoneOnFile: row.phoneOnFile,
    googleOnFile: row.googleOnFile,
    heldNow: scope.holds && row.heldNow,
    profile: p
      ? {
          name: p.name,
          about: p.about,
          job: p.job,
          textState: textState.name(p.textState),
          ...(textReject ? { textRejectReason: textReject } : {}),
          ...(intent ? { intention: intent } : {}),
          completeness: p.completeness,
          version: p.version,
          prompts: p.prompts.map((pp) => promptOf(cfg, pp)),
        }
      : null,
    standing: row.standing.filter((a) => actionVisible(a, scope)).map((a) => actionOf(a, scope)),
    openReports: { count: Math.min(row.openReports, 20), more: row.openReports > 20 },
  };
}

export function textItemOf(app: FastifyInstance, cfg: ConfigSnapshot, row: AdminTextRow): AdminTextItem {
  const state = textState.name(row.textState);
  const textReject = row.textState === textState.code('rejected') && row.textRejectReason !== null ? textRejectReason.nameOrUndefined(row.textRejectReason) : undefined;
  return {
    user: userRefOf(app, row.user),
    version: row.version,
    about: row.about === null ? null : { text: row.about, state },
    job: row.job === null ? null : { text: row.job, state },
    ...(textReject ? { textRejectReason: textReject } : {}),
    prompts: row.prompts.map((pp) => promptOf(cfg, pp)),
  };
}

/** A resolution as a caller of `scope` reads it: "shadowban" is "other action" to one who may not see shadowbans. */
export function resolutionVisible(resolution: ReportResolution, scope: UserReadScope = FULL_USER_SCOPE): ReportResolution {
  return resolution === 'shadowban' && !scope.shadow ? 'other_action' : resolution;
}

export function reportSummaryOf(app: FastifyInstance, row: AdminReportRow, scope: UserReadScope = FULL_USER_SCOPE): AdminReportSummary {
  const resolution = row.resolution === null ? undefined : reportResolution.nameOrUndefined(row.resolution);
  return {
    id: row.id,
    priority: row.priority,
    reason: reportReason.nameOrUndefined(row.reason) ?? 'other',
    context: reportContext.name(row.context),
    status: reportStatus.name(row.status),
    filedAt: wireTime(row.filedAtMs),
    reported: userRefOf(app, row.reported),
    reporter: row.reporter ? userRefOf(app, row.reporter) : null,
    assignee: adminRefOf(row.assignee),
    evidence: row.collecting ? 'collecting' : 'complete',
    ...(resolution ? { resolution: resolutionVisible(resolution, scope) } : {}),
    ...(row.resolvedAtMs !== null ? { resolvedAt: wireTime(row.resolvedAtMs) } : {}),
    filed: row.filed,
  };
}

/** What the admin list shows (`admins.read`) and the audit log keeps to that permission: e-mails, roles, two-factor state. */
const ADMIN_LIST_KEYS = new Set(['email', 'roles', 'totpEnabled']);

function withoutAdminListKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAdminListKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !ADMIN_LIST_KEYS.has(key)).map(([key, inner]) => [key, withoutAdminListKeys(inner)]));
}

/** Whether the caller's roles grant `permission` (false while the roles are not loaded). */
export function callerMay(app: FastifyInstance, request: FastifyRequest, permission: Permission): boolean {
  const principal = request.principal;
  return principal?.kind === 'admin' && app.adminAuth.roles.allows(principal.roles, permission) === true;
}

/**
 * An audit row on the wire. `adminDetails` false (a caller without
 * `admins.read`): the detail of a row about an admin leaves out what only
 * the admin list shows (e-mail, roles, two-factor state); the names stay.
 */
export function auditEntryOf(app: FastifyInstance, row: AdminAuditRow, options: { adminDetails: boolean }): AuditEntry {
  const targetType = auditTarget.nameOrUndefined(row.targetType) ?? 'none';
  const detail = !options.adminDetails && targetType === 'admin' && row.detail !== null ? (withoutAdminListKeys(row.detail) as Record<string, unknown>) : row.detail;
  return {
    id: row.id,
    at: wireTime(row.atMs),
    admin: adminRefOf(row.admin),
    action: row.action,
    targetType,
    // A person is named by public id only: their raw id never travels.
    targetRef: targetType === 'user' ? null : row.targetId,
    ...(targetType === 'user' && row.targetId !== null ? { user: app.publicIds.user.encode(row.targetId) } : {}),
    ip: row.ip,
    detail,
  };
}

export function filingOf(row: AdminFilingRow): AdminFiling {
  return {
    authority: filingAuthority.nameOrUndefined(row.authority) ?? 'other',
    externalRef: row.externalRef,
    filedAt: wireTime(row.filedAtMs),
    filedBy: adminRefOf(row.filedBy),
  };
}

const msOrNull = (value: number | null) => (value === null ? null : wireTime(value));

export function holdOf(app: FastifyInstance, row: AdminHoldRow): AdminHold {
  return {
    id: row.id,
    kind: legalHoldKind.nameOrUndefined(row.kind) ?? 'authority',
    user: row.user ? userRefOf(app, row.user) : null,
    conversationId: row.conversationId,
    reportId: row.reportId,
    createdAt: wireTime(row.createdAtMs),
    createdBy: adminRefOf(row.createdBy),
    authorityRef: row.authorityRef,
    evidenceCopiedAt: msOrNull(row.evidenceCopiedAtMs),
    releasedAt: msOrNull(row.releasedAtMs),
    releasedBy: adminRefOf(row.releasedBy),
    releasedReason: row.releasedReason,
    filing: row.filing ? filingOf(row.filing) : null,
  };
}

export function appealOf(app: FastifyInstance, row: AdminAppealRow, scope: UserReadScope = FULL_USER_SCOPE): AdminAppeal {
  return {
    id: row.id,
    status: appealStatus.name(row.status),
    body: row.body,
    filedAt: wireTime(row.filedAtMs),
    decisionText: row.decisionText,
    decidedAt: msOrNull(row.decidedAtMs),
    decidedBy: adminRefOf(row.decidedBy),
    action: actionOf(row.action, scope),
    user: userRefOf(app, row.user),
    history: row.history.filter((a) => actionVisible(a, scope)).map((a) => actionOf(a, scope)),
    locale: row.locale,
  };
}
