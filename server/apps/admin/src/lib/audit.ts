import { PUBLIC_UID_PATTERN, auditActions, type AuditAction, type AuditTarget } from '@app/shared';
import type { MessageKey } from '@/i18n/messages';

/**
 * The audit page's filters. They live in the page's address
 * (`?admin=&targetType=&target=&action=&from=&to=`: nothing personal, a
 * person is a public id) as days; the API reads a day's bounds as instants,
 * so a day here is the admin's own day (local midnight to midnight).
 */

export interface AuditFilterState {
  admin: string;
  targetType: AuditTarget | '';
  target: string;
  action: AuditAction | '';
  from: string;
  to: string;
}

export const emptyAuditFilters: AuditFilterState = { admin: '', targetType: '', target: '', action: '', from: '', to: '' };

/** The kinds of row the API audits, in the order the filter lists them. */
export const auditTargetChoices: readonly AuditTarget[] = ['user', 'report', 'appeal', 'legal_hold', 'banned_term', 'device_ban', 'admin', 'plan', 'product', 'config', 'none'];

/** The actions, grouped by their area (`user.ban` is in `user`). */
export const auditActionGroups: readonly { area: string; label: MessageKey; actions: AuditAction[] }[] = (() => {
  const labels: Record<string, MessageKey> = {
    admin: 'audit.area.admin',
    plan: 'audit.area.plan',
    product: 'audit.area.product',
    config: 'audit.area.config',
    user: 'audit.area.user',
    text: 'audit.area.text',
    photo: 'audit.area.photo',
    report: 'audit.area.report',
    hold: 'audit.area.hold',
    appeal: 'audit.area.appeal',
    banned_term: 'audit.area.banned_term',
    device_ban: 'audit.area.device_ban',
    audit: 'audit.area.audit',
  };
  const groups: { area: string; label: MessageKey; actions: AuditAction[] }[] = [];
  for (const action of auditActions) {
    const area = action.slice(0, action.indexOf('.'));
    let group = groups.find((g) => g.area === area);
    if (!group) {
      group = { area, label: labels[area] ?? 'audit.area.audit', actions: [] };
      groups.push(group);
    }
    group.actions.push(action);
  }
  return groups;
})();

const isAction = (value: string): value is AuditAction => (auditActions as readonly string[]).includes(value);
const isTarget = (value: string): value is AuditTarget => (auditTargetChoices as readonly string[]).includes(value);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ROW_ID = /^[1-9][0-9]{0,18}$/;

/**
 * Whether `target` can name a row of `type`: a person's public id, else a
 * decimal id. Checked before the filter is applied, so what does not fit
 * (a phone number typed by mistake) never reaches the address or a request.
 */
export function auditTargetValid(type: AuditTarget | '', target: string): boolean {
  if (!type) return false;
  return type === 'user' ? PUBLIC_UID_PATTERN.test(target) : ROW_ID.test(target);
}

/** Whether any filter is set (an empty page then means nothing matched, not an empty log). */
export function auditFiltered(filters: AuditFilterState): boolean {
  return Object.values(filters).some((value) => value !== '');
}

export function auditFiltersOf(params: URLSearchParams): AuditFilterState {
  const get = (key: string) => params.get(key)?.trim() ?? '';
  const targetType = get('targetType');
  const action = get('action');
  const type = isTarget(targetType) ? targetType : '';
  return {
    admin: /^[1-9][0-9]{0,9}$/.test(get('admin')) ? get('admin') : '',
    targetType: type,
    target: auditTargetValid(type, get('target')) ? get('target') : '',
    action: isAction(action) ? action : '',
    from: DAY.test(get('from')) ? get('from') : '',
    to: DAY.test(get('to')) ? get('to') : '',
  };
}

/** The filters set, for the page's address. */
export function auditParamsOf(filters: AuditFilterState): Record<string, string> {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== ''));
}

const startOfDay = (day: string) => new Date(`${day}T00:00:00`);

/** The filters as the API takes them (a body for the export, a query for the list): a day becomes the instants of the admin's day. */
export function auditRequestOf(filters: AuditFilterState): Record<string, string> {
  const out: Record<string, string> = {};
  if (filters.admin) out.admin = filters.admin;
  if (filters.targetType) out.targetType = filters.targetType;
  if (filters.targetType && filters.target) out.target = filters.target;
  if (filters.action) out.action = filters.action;
  if (filters.from) out.from = startOfDay(filters.from).toISOString();
  if (filters.to) {
    const end = startOfDay(filters.to);
    end.setDate(end.getDate() + 1);
    out.to = end.toISOString();
  }
  return out;
}

export function auditQueryOf(filters: AuditFilterState): string {
  return new URLSearchParams(auditRequestOf(filters)).toString();
}

/** The file name of an export: its days, when it has them. */
export function exportName(filters: AuditFilterState): string {
  return `${['audit', filters.from, filters.to].filter(Boolean).join('-')}.csv`;
}

/** An audit action's label in the panel's language (the code itself for one this build has no words for). */
export function auditActionLabel(action: string, t: (key: MessageKey) => string): string {
  const key = `auditAction.${action}` as MessageKey;
  const label = t(key);
  return label === key ? action : label;
}
