import type { MessageKey } from '@/i18n/messages';
import {
  ACTION_RESOLUTIONS,
  CLOSE_RESOLUTIONS,
  adminReportViews,
  filingAuthority,
  legalHoldKind,
  photoRejectReason,
  type AdminPenaltyKind,
  type AdminReportSummary,
  type AdminReportView,
  type LegalHoldKind,
  type PhotoRejectReason,
  type ReportResolution,
} from '@app/shared';

/**
 * The moderation pages' rules, apart from the components: the reports
 * views, a priority's tone, the resolutions of each way to close, what a
 * penalty taken from a report closes it with, the photo reasons an admin
 * gives, a hold kind's tone and the labels that veil a photo.
 */

export const reportViews: readonly AdminReportView[] = adminReportViews;

export function isReportView(value: string | null): value is AdminReportView {
  return value !== null && (reportViews as readonly string[]).includes(value);
}

/** 90 and up red, 60 and up amber, else gray. */
export function priorityTone(priority: number): 'red' | 'amber' | 'gray' {
  return priority >= 90 ? 'red' : priority >= 60 ? 'amber' : 'gray';
}

export const reportStatusTone: Readonly<Record<AdminReportSummary['status'], 'green' | 'amber' | 'blue' | 'gray'>> = {
  open: 'amber',
  in_review: 'blue',
  actioned: 'green',
  dismissed: 'gray',
  duplicate: 'gray',
};

export const openReport = (report: Pick<AdminReportSummary, 'status'>) => report.status === 'open' || report.status === 'in_review';

export const actionResolutions: readonly ReportResolution[] = ACTION_RESOLUTIONS;
export const closeResolutions: readonly ReportResolution[] = CLOSE_RESOLUTIONS;

/** The penalty a penalty resolution stands for (the inverse of {@link resolutionOfPenalty}). */
export function penaltyOfResolution(resolution: ReportResolution): AdminPenaltyKind | null {
  const found = (Object.entries(resolutionOfPenalty) as [AdminPenaltyKind, ReportResolution][]).find(([, r]) => r === resolution);
  return found ? found[0] : null;
}

/** The resolution a report gets when the penalty an admin took from it closes it. */
export const resolutionOfPenalty: Readonly<Record<AdminPenaltyKind, ReportResolution>> = {
  warn: 'warning',
  suspend: 'suspension',
  ban: 'ban',
  shadowban: 'shadowban',
};

/** The reasons an admin rejects a photo with (`unreadable` is the automatic checks' own). */
export const photoReasons: readonly PhotoRejectReason[] = photoRejectReason.names.filter((name) => name !== 'unreadable');

export const filingAuthorities = filingAuthority.names;
export const holdKinds = legalHoldKind.names;

/** A hold kind's badge, the same on every page: child safety red, a threat amber, an authority's request gray. */
export const holdKindTone: Readonly<Record<LegalHoldKind, 'destructive' | 'warning' | 'secondary'>> = {
  child_safety: 'destructive',
  threat: 'warning',
  authority: 'secondary',
};

/** The automatic labels whose photos are veiled until an admin chooses to look (and that mark a thumbnail). */
export const SENSITIVE_FLAGS: ReadonlySet<string> = new Set(['nudity', 'possible_minor']);
export const isSensitive = (modFlags: readonly string[]) => modFlags.some((flag) => SENSITIVE_FLAGS.has(flag));

/** "Photo 3 of 24", or "of 24+" while more can be read (numbers in the panel's digits). */
export function positionText(t: (key: MessageKey, params?: Record<string, string | number>) => string, kind: string, n: number, total: number, more: boolean): string {
  return t(more ? 'queue.positionMore' : 'queue.position', { kind, n, total });
}
