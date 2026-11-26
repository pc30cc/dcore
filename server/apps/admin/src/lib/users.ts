import {
  isLocale,
  moderationReason,
  type AccountStatus,
  type AdminAction,
  type AdminPenaltyKind,
  type AdminReasons,
  type AdminUserFilter,
  type Locale,
  type ModerationReason,
  type SideEffects,
} from '@app/shared';
import type { MessageKey } from '@/i18n/messages';
import { formatDate } from './format';
import { showToast } from './toast';

/**
 * The user pages' rules, apart from the components: the list's filters, a
 * status's tone, the language a person reads their message in, the message
 * pre-filled from the reason, the end of a period, and the exact bodies of
 * the action routes.
 */

export const userFilters: readonly AdminUserFilter[] = ['pending_review', 'suspended', 'banned', 'shadowbanned', 'test'];

export function isUserFilter(value: string | null): value is AdminUserFilter {
  return value !== null && (userFilters as readonly string[]).includes(value);
}

export const statusTone: Readonly<Record<AccountStatus, 'green' | 'amber' | 'red' | 'gray' | 'blue'>> = {
  onboarding: 'blue',
  pending_review: 'amber',
  active: 'green',
  snoozed: 'gray',
  suspended: 'amber',
  banned: 'red',
  deleted: 'gray',
  purged: 'gray',
};

/** The language a person reads: the first two letters of their locale when the product ships it, else English (as the API decides). */
export function personLocale(locale: string): Locale {
  const short = locale.slice(0, 2);
  return isLocale(short) ? short : 'en';
}

export const moderationReasons: readonly ModerationReason[] = moderationReason.names;

/** The default message for a reason, in the person's language. */
export function prefilledMessage(reasons: AdminReasons | undefined, reason: string, locale: Locale): string {
  return reasons?.moderation.find((entry) => entry.reason === reason)?.texts[locale] ?? '';
}

export type UntilChoice = '' | 'permanent' | '1d' | '3d' | '7d' | '30d' | 'date';
export const untilPresets = ['1d', '3d', '7d', '30d'] as const;
const PRESET_DAYS: Readonly<Record<(typeof untilPresets)[number], number>> = {
  '1d': 1,
  '3d': 3,
  '7d': 7,
  '30d': 30,
};
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/**
 * The end of a period: a preset counts from now, a date ends at the end of
 * that day in the admin's time zone; permanent is none. `error`: no choice
 * yet, or a date that is not ahead.
 */
export function endOf(choice: UntilChoice, date: string, now: number): { endsAt?: string; error?: MessageKey } {
  if (choice === '') return { error: 'action.error.until' };
  if (choice === 'permanent') return {};
  if (choice === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'action.error.date' };
    const at = new Date(`${date}T23:59:00`).getTime();
    if (Number.isNaN(at) || at < now + MINUTE_MS) return { error: 'action.error.untilPast' };
    return { endsAt: new Date(at).toISOString() };
  }
  return { endsAt: new Date(now + PRESET_DAYS[choice] * DAY_MS).toISOString() };
}

export interface PenaltyForm {
  reason: ModerationReason | '';
  message: string;
  until: UntilChoice;
  date: string;
  note: string;
}

export type PenaltyProblems = Partial<Record<'reason' | 'message' | 'until' | 'date', MessageKey>>;

/** The field an end's problem belongs to: the date input once "a date" is chosen, else the choice. */
export function endField(form: Pick<PenaltyForm, 'until'>): 'until' | 'date' {
  return form.until === 'date' ? 'date' : 'until';
}

/** What is wrong with the form for this kind, field by field. */
export function penaltyProblems(kind: AdminPenaltyKind, form: PenaltyForm, now: number): PenaltyProblems {
  const problems: PenaltyProblems = {};
  if (form.reason === '') problems.reason = 'form.required';
  if (kind !== 'shadowban' && form.message.trim() === '') problems.message = 'form.required';
  if (kind !== 'warn') {
    const end = endOf(form.until, form.date, now);
    if (end.error) problems[endField(form)] = end.error;
  }
  return problems;
}

/** The body the route takes for this kind: a warning has no end, a shadowban no message. */
export function penaltyBody(kind: AdminPenaltyKind, form: PenaltyForm, now: number, reportId?: string): Record<string, unknown> {
  const body: Record<string, unknown> = { reason: form.reason };
  if (kind !== 'shadowban') body.reasonText = form.message.trim();
  const note = form.note.trim();
  if (note) body.note = note;
  if (kind !== 'warn') {
    const { endsAt } = endOf(form.until, form.date, now);
    if (endsAt) body.endsAt = endsAt;
  }
  if (reportId) body.reportId = reportId;
  return body;
}

/** The label of an action's reason, by the table of its kind. */
export function reasonLabel(action: Pick<AdminAction, 'kind' | 'reason'>): MessageKey {
  if (action.kind === 'photo_rejected') return `reason.photo.${action.reason}` as MessageKey;
  if (action.kind === 'text_rejected') return `reason.text.${action.reason}` as MessageKey;
  return `reason.moderation.${action.reason}` as MessageKey;
}

/** The kinds whose reason is always "other" (99): the row shows no reason. */
export const reasonlessKinds: ReadonlySet<AdminAction['kind']> = new Set(['device_ban', 'sessions_revoked']);

/** What `moderation_revoke()` stores on a lift record written without a text: no note to show. */
export const LIFT_DEFAULT_TEXT = 'Lifted.';

/**
 * The parts a text rejection names, in words. The record's note lists them
 * as `profile_text_decide()` and the rename write it: `about/job`,
 * `prompt N` (1-based) and `name`; anything else is shown as written.
 */
export function textPartsOf(note: string, t: (key: MessageKey, values?: Record<string, string | number>) => string): string[] {
  return note
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (part === 'about/job') return t('texts.part.profile');
      if (part === 'name') return t('action.rename.name');
      const prompt = /^prompt (\d+)$/.exec(part);
      return prompt ? t('texts.part.prompt', { n: Number(prompt[1]) }) : part;
    });
}

/** When a standing action runs: a warning by its date, a restriction until its end or for good. */
export function standingPeriod(action: Pick<AdminAction, 'kind' | 'startsAt' | 'endsAt'>, t: (key: MessageKey, values?: Record<string, string>) => string, locale: Locale): string {
  if (action.kind === 'warning') return formatDate(action.startsAt, locale);
  return action.endsAt ? t('moderation.until', { date: formatDate(action.endsAt, locale) }) : t('common.permanent');
}

export const actionTone: Partial<Record<AdminAction['kind'], 'default' | 'secondary' | 'warning' | 'destructive' | 'muted' | 'outline'>> = {
  warning: 'warning',
  suspension: 'warning',
  ban: 'destructive',
  shadowban: 'warning',
  lift: 'secondary',
};

/** A `/users/{id}` tab, in the URL as `?tab=`. */
export const userTabs = ['profile', 'moderation', 'reports', 'purchases', 'wallet', 'devices', 'sessions', 'consents', 'audit'] as const;
export type UserTab = (typeof userTabs)[number];

/** The toast after a write: its word, or, when the app side failed, that some updates will reach the app late. */
export function savedToast(t: (key: MessageKey) => string, sideEffects: SideEffects, done: MessageKey = 'common.saved'): void {
  if (sideEffects === 'failed') showToast(t('common.sideEffectsLate'), 'info', 6_000);
  else showToast(t(done));
}
