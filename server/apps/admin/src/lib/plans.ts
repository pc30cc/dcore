import {
  FREE_PLAN_KEY,
  NEW_PLAN_KEY,
  PLAN_DESCRIPTION_MAX,
  PLAN_NAME_MAX,
  PLAN_QUOTA_MAX,
  adminPlanCreateSchema,
  adminPlanUpdateSchema,
  planFlagDefaults,
  planFlagKeys,
  planQuotaKeys,
  type AdminPlan,
  type AdminPlanCreate,
  type AdminPlanUpdate,
  type FieldIssue,
  type PlanFlag,
  type PlanQuota,
} from '@app/shared';
import type { MessageKey } from '@/i18n/messages';

/**
 * The plan editor's form: what the fields hold (text as typed), the checks
 * the API makes (run here first, so a mistake shows next to its field before
 * anything is sent), and the request bodies. An edit sends only what
 * changed; names and descriptions go as whole maps (the API replaces them),
 * switches and quotas key by key (the API merges them).
 */

export const planLocales = ['fa', 'en', 'tr'] as const;
export type PlanLocale = (typeof planLocales)[number];
export type PlanBadge = NonNullable<AdminPlan['badge']>;
export const planBadges: readonly PlanBadge[] = ['popular', 'best_value', 'new'];

export const RANK_MIN = 1;
export const RANK_MAX = 9_999;
export const SORT_MIN = -32_768;
export const SORT_MAX = 32_767;

export interface QuotaField {
  unlimited: boolean;
  /** As typed; ignored while unlimited. */
  value: string;
}

export interface PlanForm {
  key: string;
  names: Record<PlanLocale, string>;
  descriptions: Record<PlanLocale, string>;
  /** As typed; empty on a new plan: above every plan. */
  rank: string;
  sort: string;
  active: boolean;
  badge: PlanBadge | '';
  features: Record<PlanFlag, boolean>;
  quotas: Record<PlanQuota, QuotaField>;
  /** A new plan: whose switches and quotas it started from ('' none). */
  copyFrom: string;
}

/** Field paths: `key`, `names`, `names.fa`, `descriptions.en`, `rank`, `sort`, `quotas.daily_likes`, ... */
export type PlanErrors = Partial<Record<string, MessageKey>>;

function texts(source: AdminPlan['names'] | undefined): Record<PlanLocale, string> {
  return { fa: source?.fa ?? '', en: source?.en ?? '', tr: source?.tr ?? '' };
}

function quotaField(value: number): QuotaField {
  return value === -1 ? { unlimited: true, value: '' } : { unlimited: false, value: String(value) };
}

/** The switches and quotas of `plan`, or the code's defaults. */
export function featuresOf(plan: Pick<AdminPlan, 'features' | 'quotas'> | null): Pick<PlanForm, 'features' | 'quotas'> {
  const features = Object.fromEntries(planFlagKeys.map((key) => [key, plan ? plan.features[key] : planFlagDefaults[key]])) as Record<PlanFlag, boolean>;
  const quotas = Object.fromEntries(planQuotaKeys.map((key) => [key, quotaField(plan ? plan.quotas[key] : 0)])) as Record<PlanQuota, QuotaField>;
  return { features, quotas };
}

export function newPlanForm(): PlanForm {
  return {
    key: '',
    names: texts(undefined),
    descriptions: texts(undefined),
    rank: '',
    sort: '',
    active: true,
    badge: '',
    copyFrom: '',
    ...featuresOf(null),
  };
}

export function planFormOf(plan: AdminPlan): PlanForm {
  return {
    key: plan.key,
    names: texts(plan.names),
    descriptions: texts(plan.descriptions),
    rank: String(plan.rank),
    sort: String(plan.sort),
    active: plan.active,
    badge: plan.badge ?? '',
    copyFrom: '',
    ...featuresOf(plan),
  };
}

const CONTROL = /\p{Cc}/u;
const INTEGER = /^-?\d+$/;

/** ASCII digits for Persian and Arabic-Indic ones, so a number typed on a Persian keyboard counts. */
export function asciiDigits(value: string): string {
  return value.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

function integer(value: string): number | null {
  const text = asciiDigits(value.trim());
  return INTEGER.test(text) ? Number(text) : null;
}

export interface PlanContext {
  mode: 'create' | 'edit';
  /** The plan being edited (edit mode). */
  plan?: AdminPlan | undefined;
  /** Every plan, archived ones too: keys are never reused, ranks are unique. */
  plans: readonly AdminPlan[];
}

/** The problems of the form, by field; empty when it can be sent. */
export function validatePlanForm(form: PlanForm, context: PlanContext): PlanErrors {
  const errors: PlanErrors = {};
  const isFree = context.plan?.key === FREE_PLAN_KEY;

  if (context.mode === 'create') {
    const key = form.key.trim();
    if (key === '') errors.key = 'form.required';
    else if (!NEW_PLAN_KEY.test(key)) errors.key = 'plan.error.key';
    else if (context.plans.some((plan) => plan.key === key)) errors.key = 'plan.error.keyTaken';
  }

  for (const locale of planLocales) {
    const name = form.names[locale].trim();
    if (name.length > PLAN_NAME_MAX) errors[`names.${locale}`] = 'plan.error.nameLong';
    else if (CONTROL.test(name)) errors[`names.${locale}`] = 'form.controlChars';
    const description = form.descriptions[locale].trim();
    if (description.length > PLAN_DESCRIPTION_MAX) errors[`descriptions.${locale}`] = 'plan.error.descriptionLong';
    else if (CONTROL.test(description)) errors[`descriptions.${locale}`] = 'form.controlChars';
  }
  if (form.names.fa.trim() === '' && form.names.en.trim() === '') errors.names = 'plan.error.nameRequired';

  if (!isFree) {
    const rankText = form.rank.trim();
    if (rankText !== '' || context.mode === 'edit') {
      const rank = integer(rankText);
      if (rank === null || rank < RANK_MIN || rank > RANK_MAX) errors.rank = 'plan.error.rank';
      else if (context.plans.some((plan) => plan.rank === rank && plan.key !== context.plan?.key)) errors.rank = 'plan.error.rankTaken';
    }
  }
  if (form.sort.trim() !== '' || context.mode === 'edit') {
    const sort = integer(form.sort);
    if (sort === null || sort < SORT_MIN || sort > SORT_MAX) errors.sort = 'plan.error.sort';
  }

  for (const key of planQuotaKeys) {
    const quota = form.quotas[key];
    if (quota.unlimited) continue;
    const value = integer(quota.value);
    if (value === null || value < 0 || value > PLAN_QUOTA_MAX) errors[`quotas.${key}`] = 'plan.error.quota';
  }
  return errors;
}

export function hasErrors(errors: object): boolean {
  return Object.keys(errors).length > 0;
}

function trimmedTexts(source: Record<PlanLocale, string>): Partial<Record<PlanLocale, string>> {
  const out: Partial<Record<PlanLocale, string>> = {};
  for (const locale of planLocales) {
    const value = source[locale].trim();
    if (value !== '') out[locale] = value;
  }
  return out;
}

function quotaValue(quota: QuotaField): number {
  return quota.unlimited ? -1 : (integer(quota.value) ?? 0);
}

function quotaValues(form: PlanForm): Record<PlanQuota, number> {
  return Object.fromEntries(planQuotaKeys.map((key) => [key, quotaValue(form.quotas[key])])) as Record<PlanQuota, number>;
}

/** `POST /v1/admin/plans` for a valid form. */
export function planCreateBody(form: PlanForm): AdminPlanCreate {
  const descriptions = trimmedTexts(form.descriptions);
  const rank = integer(form.rank);
  const sort = integer(form.sort);
  const body: AdminPlanCreate = {
    key: form.key.trim(),
    names: trimmedTexts(form.names),
    active: form.active,
    badge: form.badge === '' ? null : form.badge,
    features: { ...form.features },
    quotas: quotaValues(form),
  };
  if (Object.keys(descriptions).length > 0) body.descriptions = descriptions;
  if (rank !== null) body.rank = rank;
  if (sort !== null) body.sort = sort;
  if (form.copyFrom !== '') body.copyFrom = form.copyFrom;
  return adminPlanCreateSchema.parse(body);
}

const sameTexts = (a: Partial<Record<PlanLocale, string | undefined>>, b: Partial<Record<PlanLocale, string | undefined>>): boolean =>
  planLocales.every((locale) => (a[locale] ?? '') === (b[locale] ?? ''));

/** `PATCH /v1/admin/plans/:key` for a valid form: only what differs from `plan`; null when nothing does. */
export function planPatchBody(form: PlanForm, plan: AdminPlan): AdminPlanUpdate | null {
  const body: AdminPlanUpdate = {};
  const names = trimmedTexts(form.names);
  if (!sameTexts(names, plan.names)) body.names = names;
  const descriptions = trimmedTexts(form.descriptions);
  if (!sameTexts(descriptions, plan.descriptions)) body.descriptions = descriptions;
  const isFree = plan.key === FREE_PLAN_KEY;
  const rank = integer(form.rank);
  if (!isFree && rank !== null && rank !== plan.rank) body.rank = rank;
  const sort = integer(form.sort);
  if (sort !== null && sort !== plan.sort) body.sort = sort;
  if (!isFree && plan.archivedAt === null && form.active !== plan.active) body.active = form.active;
  const badge = form.badge === '' ? null : form.badge;
  if (badge !== plan.badge) body.badge = badge;
  const features: Partial<Record<PlanFlag, boolean>> = {};
  for (const key of planFlagKeys) if (form.features[key] !== plan.features[key]) features[key] = form.features[key];
  if (Object.keys(features).length > 0) body.features = features;
  const quotas: Partial<Record<PlanQuota, number>> = {};
  for (const key of planQuotaKeys) {
    const value = quotaValue(form.quotas[key]);
    if (value !== plan.quotas[key]) quotas[key] = value;
  }
  if (Object.keys(quotas).length > 0) body.quotas = quotas;
  return Object.keys(body).length === 0 ? null : adminPlanUpdateSchema.parse(body);
}

const SERVER_CODES: Readonly<Record<string, MessageKey>> = {
  free_plan: 'plan.error.freePlan',
  unknown_plan: 'plan.error.unknownPlan',
  not_every_plan: 'plan.error.order',
};
const PLAN_FIELDS = new Set(['key', 'names', 'descriptions', 'rank', 'sort', 'active', 'badge', 'quotas', 'features', 'copyFrom', 'order']);

/**
 * The API's field problems (`/names`, `/quotas/daily_likes`, ...) as form
 * paths with the panel's words for the codes it knows; the rest is left for
 * the page's notice (the API's own text).
 */
export function serverPlanErrors(issues: readonly FieldIssue[]): { errors: PlanErrors; rest: FieldIssue[] } {
  const errors: PlanErrors = {};
  const rest: FieldIssue[] = [];
  for (const issue of issues) {
    const path = issue.pointer.split('/').filter(Boolean).join('.');
    const known = SERVER_CODES[issue.code];
    if (PLAN_FIELDS.has(path.split('.')[0] ?? '') && known) errors[path] = known;
    else rest.push(issue);
  }
  return { errors, rest };
}

/** The upgrade order: every plan but free, best last (`PUT /v1/admin/plan-ranks`). */
export function rankOrder(plans: readonly AdminPlan[]): AdminPlan[] {
  return plans.filter((plan) => plan.key !== FREE_PLAN_KEY).sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
}

export function moveInOrder(order: readonly string[], index: number, by: -1 | 1): string[] {
  const target = index + by;
  if (index < 0 || index >= order.length || target < 0 || target >= order.length) return [...order];
  const next = [...order];
  const moved = next[index]!;
  next[index] = next[target]!;
  next[target] = moved;
  return next;
}

/** Where a plan stands, for the list. */
export type PlanStatus = 'free' | 'onSale' | 'paused' | 'archived';
export function planStatus(plan: AdminPlan): PlanStatus {
  if (plan.key === FREE_PLAN_KEY) return 'free';
  if (plan.archivedAt !== null) return 'archived';
  return plan.onSale ? 'onSale' : 'paused';
}
