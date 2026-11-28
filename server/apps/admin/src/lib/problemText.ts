import {
  ADMIN_PASSWORD_MAX,
  ADMIN_PASSWORD_MIN,
  AUDIT_EXPORT_MAX_ROWS,
  isPermission,
  ORIGINS_BOOTSTRAP_MAX,
  ORIGINS_PER_ROLE_MAX,
  ORIGINS_URL_MAX,
  PENALTY_MAX_DAYS,
  type AdminConflictReason,
  type AdminFieldCode,
  type AdminForbiddenReason,
  type ErrorCode,
  type Locale,
} from '@app/shared';
import type { MessageKey } from '@/i18n/messages';
import type { Translate } from '@/i18n/translate';
import type { ApiError } from './http';

/**
 * A failed admin call in the panel's words. The API names each refusal with
 * a machine word (shared `adminProblems.ts`: a 409's and a 403's `reason`,
 * a field issue's `code`), which these tables word; the API's English
 * `detail` is never the sentence, only a secondary line (a new line after
 * it, which <Worded> draws smaller) where the panel's words are generic.
 */

/** Every reason a 409 of the admin API names. */
export const CONFLICT_TEXT: Readonly<Record<AdminConflictReason, MessageKey>> = {
  already_decided: 'queue.alreadyDecided',
  already_closed: 'report.alreadyClosed',
  already_filed: 'report.alreadyFiled',
  taken: 'report.taken',
  processing: 'photos.processing',
  stale: 'texts.stale',
  lifted: 'appeals.lifted',
  self_change: 'admins.error.self',
  last_owner: 'admins.error.lastOwner',
  email_taken: 'admins.error.emailTaken',
  enroll_first: 'login.error.enrollFirst',
  appearance_changed: 'appearance.conflict',
  hosts_changed: 'hosts.conflict',
  term_exists: 'terms.error.exists',
  rank_taken: 'plan.error.rankTaken',
  key_taken: 'plan.error.keyTaken',
  plan_archived: 'plan.active.archived',
  free_plan_archive: 'plan.error.freeArchive',
  product_exists: 'product.error.conflict',
  plan_not_sold: 'product.error.archivedPlan',
  product_locked: 'product.error.lockedConflict',

  // dashboard

  // content

  // revenue
  purchase_changed: 'purchase.error.changed',
  purchase_busy: 'purchase.error.busy',
  action_not_available: 'purchase.error.notAvailable',
  store_refused: 'purchase.error.storeRefused',
  foreign_account: 'purchase.error.foreignAccount',
  grant_ended: 'grant.error.ended',
  duplicate_request: 'revenue.error.duplicate',

  // growth

  // app
  settings_changed: 'settings.conflict',
  brand_mismatch: 'brand.mismatch',

  // support

  // system
};

/** Every reason a 403 of the admin API names (`beyond_grants` lists the permissions too). */
export const FORBIDDEN_TEXT: Readonly<Record<AdminForbiddenReason, MessageKey>> = {
  role: 'access.denied.body',
  beyond_grants: 'admins.error.beyondGrants',
  beyond_target: 'admins.error.beyondTarget',
  automatic_ban: 'deviceBans.error.automatic',
  origin: 'login.error.origin',
  shadow_hidden: 'users.error.shadowHidden',

  // dashboard

  // content

  // revenue

  // growth

  // app
  mfa_required: 'access.mfaRequired',
  read_only: 'settings.readOnly',

  // support

  // system
};

/** Every field code the admin API writes, in general words (a form may say more at its field). */
export const FIELD_TEXT: Readonly<Record<AdminFieldCode, MessageKey>> = {
  invalid: 'field.issue.invalid',
  not_a_public_id: 'audit.error.user',
  not_an_id: 'audit.error.target',
  ends_before_start: 'audit.error.range',
  too_many_rows: 'audit.export.tooMany',
  unknown_role: 'admins.error.unknownRole',
  wrong: 'security.password.wrong',
  too_short: 'admins.error.passwordShort',
  too_long: 'admins.error.passwordLong',
  is_email: 'admins.error.passwordEmail',
  default_not_offered: 'appearance.error.defaultNotOffered',
  empty: 'hosts.issue.empty',
  url_too_long: 'hosts.issue.url_too_long',
  not_url: 'hosts.issue.not_url',
  not_https: 'hosts.issue.not_https',
  credentials: 'hosts.issue.credentials',
  fragment: 'hosts.issue.fragment',
  not_origin: 'hosts.issue.not_origin',
  query: 'hosts.issue.query',
  not_file: 'hosts.issue.not_file',
  ip_not_allowed: 'hosts.issue.ip_not_allowed',
  ip_private: 'hosts.issue.ip_private',
  host_name: 'hosts.issue.host_name',
  host_reserved: 'hosts.issue.host_reserved',
  too_many: 'hosts.issue.too_many',
  duplicate: 'hosts.issue.duplicate',
  api_required: 'hosts.issue.api_required',
  unknown_plan: 'plan.error.unknownPlan',
  free_plan: 'plan.error.freePlan',
  not_every_plan: 'plan.error.order',
  other_kind: 'product.error.otherKind',
  other_plan: 'product.error.otherPlan',
  bazaar_base_plan: 'product.error.bazaarBasePlan',
  bazaar_period: 'product.error.bazaarWeekly',
  base_plan_required: 'product.error.basePlanRequired',
  not_a_consumable: 'product.error.notConsumable',
  not_a_subscription: 'product.error.notSubscription',
  catalog_rule: 'catalog.error.rule',
  ends_in_past: 'action.error.untilPast',
  ends_too_far: 'action.error.untilFar',
  phone_invalid: 'deviceBans.error.phone',
  unknown_action: 'deviceBans.error.unknownAction',
  nothing_to_ban: 'deviceBans.error.nothing',
  wrong_reason: 'photos.error.autoReason',
  not_a_part: 'texts.error.notAPart',
  name_refused: 'action.error.nameRefused',
  unknown_report: 'holds.error.reportId',
  not_this_user: 'action.error.report',
  unknown_admin: 'report.error.unknownAdmin',
  unknown_user: 'holds.error.user',
  unknown_conversation: 'holds.error.conversationId',
  no_target: 'holds.error.noTarget',
  resolution_not_action: 'report.error.needsNoAction',
  resolution_is_action: 'report.error.needsAction',
  resolution_not_allowed: 'report.error.resolutionRole',
  action_not_taken: 'report.error.actionNotTaken',
  term_empty: 'terms.error.empty',
  regex_invalid: 'terms.error.regexInvalid',
  regex_backreference: 'terms.error.regexBackreference',
  regex_quote: 'terms.error.regexQuote',
  regex_class_ligature: 'terms.error.regexClassLigature',
  regex_group: 'terms.error.regexGroup',
  regex_word_boundary: 'terms.error.regexWordBoundary',
  regex_too_large: 'terms.error.regexTooLarge',
  regex_too_broad: 'terms.error.regexTooBroad',

  // dashboard

  // content

  // revenue
  archived_plan: 'grant.error.archivedPlan',
  starts_in_past: 'grant.error.startsInPast',
  starts_too_far: 'grant.error.startsTooFar',
  insufficient_balance: 'walletAdjust.insufficient',

  // growth

  // app
  out_of_range: 'appConfig.error.invalid',
  below_required: 'appConfig.error.belowRequired',
  version_lowered: 'appConfig.error.lowered',
  fake_provider: 'providers.error.fake',
  secret_required: 'providers.error.secretRequired',
  credentials_invalid: 'providers.error.credentials',
  host_not_allowed: 'brand.error.host',
  rtdn_required: 'providers.error.rtdnRequired',

  // support

  // system
};

/** The problem codes worded here; any other the panel treats by its HTTP status. */
export const WORDED_CODES: readonly ErrorCode[] = [
  'bad_request',
  'validation_failed',
  'unauthorized',
  'token_expired',
  'refresh_invalid',
  'refresh_reused',
  'forbidden',
  'not_found',
  'method_not_allowed',
  'conflict',
  'payload_too_large',
  'unsupported_media_type',
  'rate_limited',
  'internal',
  'service_unavailable',
  'already_set',
  'otp_invalid',
  'otp_locked',
  'appeal_open',
  'not_appealable',
  'field_invalid',
  'store_unavailable',
];

function isFieldCode(code: string): code is AdminFieldCode {
  return Object.hasOwn(FIELD_TEXT, code);
}

/**
 * The words for a field code (with the numbers its sentence names); null for
 * one the API does not write (a schema keyword). `pointer` is the field's
 * (`/bootstrap`, `/hosts/api`, …) where the number depends on the list.
 */
export function fieldText(code: string, t: Translate, pointer = ''): string | null {
  if (!isFieldCode(code)) return null;
  switch (code) {
    case 'too_short':
      return t('admins.error.passwordShort', { min: ADMIN_PASSWORD_MIN });
    case 'too_long':
      return t('admins.error.passwordLong', { max: ADMIN_PASSWORD_MAX });
    case 'url_too_long':
      return t('hosts.issue.url_too_long', { max: ORIGINS_URL_MAX });
    case 'too_many':
      return t('hosts.issue.too_many', { max: pointer.startsWith('/bootstrap') ? ORIGINS_BOOTSTRAP_MAX : ORIGINS_PER_ROLE_MAX });
    case 'ends_too_far':
      return t('action.error.untilFar', { years: Math.floor(PENALTY_MAX_DAYS / 365) });
    case 'too_many_rows':
      return t('audit.export.tooMany', { max: AUDIT_EXPORT_MAX_ROWS });
    default:
      return t(FIELD_TEXT[code]);
  }
}

/** The words for a known 409; null for any other answer. */
export function conflictText(error: ApiError, t: Translate): string | null {
  if (error.code !== 'conflict' || error.reason === undefined || !Object.hasOwn(CONFLICT_TEXT, error.reason)) return null;
  return t(CONFLICT_TEXT[error.reason as AdminConflictReason]);
}

/** The panel's names of permissions, as a list in the panel's language. */
export function permissionList(permissions: readonly string[], t: Translate, locale: Locale): string {
  const names = permissions.map((permission) => (isPermission(permission) ? t(`permission.${permission}`) : permission));
  return new Intl.ListFormat(locale, { type: 'conjunction' }).format(names);
}

/** The words for a known 403; null for any other answer. */
function forbiddenText(error: ApiError, t: Translate, locale: Locale): string {
  const reason = error.reason !== undefined && Object.hasOwn(FORBIDDEN_TEXT, error.reason) ? (error.reason as AdminForbiddenReason) : 'role';
  if (reason === 'beyond_grants') return t('admins.error.beyondGrants', { permissions: permissionList(error.permissions, t, locale) });
  return t(FORBIDDEN_TEXT[reason]);
}

/** The field issues' words, each once; empty when none is a code the API writes. */
function issueTexts(error: ApiError, t: Translate): string[] {
  const texts: string[] = [];
  for (const issue of error.errors) {
    const text = fieldText(issue.code, t, issue.pointer);
    if (text !== null && !texts.includes(text)) texts.push(text);
  }
  return texts;
}

/** The sentence of a failed call, in panel words, and whether the API's text is worth a secondary line. */
function mainText(error: ApiError, t: Translate, locale: Locale): { text: string; withDetail: boolean } {
  const say = (text: string, withDetail = false) => ({ text, withDetail });
  switch (error.code) {
    case 'unreachable':
      return say(t('common.error.unreachable'));
    case 'not_configured':
      return say(t('common.error.notConfigured'));
    case 'forbidden':
      return say(forbiddenText(error, t, locale));
    case 'unauthorized':
    case 'session_expired':
    case 'token_expired':
    case 'refresh_invalid':
    case 'refresh_reused':
      return say(t('login.expired.body'));
    case 'not_found':
      // A route this API does not have: the panel and the API are not the same version.
      return error.message.startsWith('No route for ') ? say(t('common.error.badRequest'), true) : say(t('common.error.notFound'));
    case 'conflict': {
      const known = conflictText(error, t);
      return known ? say(known) : say(t('common.error.conflict'), true);
    }
    case 'appeal_open':
      return say(t('problem.appealOpen'));
    case 'not_appealable':
      return say(t('problem.notAppealable'));
    case 'already_set':
      return say(t('enroll.alreadySet'));
    case 'otp_invalid':
      return say(t('login.error.code'));
    case 'otp_locked':
      return say(t('login.error.locked'));
    case 'rate_limited':
      return say(
        error.retryAfterSeconds !== undefined && error.retryAfterSeconds > 60
          ? t('common.error.rateLimitedFor', { minutes: Math.ceil(error.retryAfterSeconds / 60) })
          : t('common.error.rateLimited'),
      );
    case 'service_unavailable':
      return say(t('common.error.unavailable'));
    case 'store_unavailable':
      return say(t('purchase.error.storeUnavailable'));
    case 'validation_failed':
    case 'field_invalid': {
      const texts = issueTexts(error, t);
      return texts.length > 0 ? say(texts.join(' ')) : say(t('common.error.invalid'), true);
    }
    case 'bad_request':
    case 'method_not_allowed':
    case 'unsupported_media_type':
      return say(t('common.error.badRequest'), true);
    case 'payload_too_large':
      return say(t('common.error.tooLarge'));
    default:
      return error.status >= 500 ? say(t('common.error.server')) : say(t('common.error.unexpected'), true);
  }
}

/** What the API said, on one line, when it says more than its HTTP status. */
function apiDetail(error: ApiError): string | null {
  const issues = error.errors.map((issue) => (issue.pointer ? `${issue.pointer}: ${issue.message}` : issue.message));
  const text = (issues.length > 0 ? issues.join('; ') : error.message).replace(/\s+/g, ' ').trim();
  if (text === '' || /^HTTP \d{3}$/.test(text)) return null;
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

/**
 * A failed admin call in the panel's words: one sentence, then, on lines of
 * their own, the API's detail where the sentence is general, and the
 * request id of a server error (support asks for it).
 */
export function problemText(error: ApiError, t: Translate, locale: Locale): string {
  const main = mainText(error, t, locale);
  const lines = [main.text];
  const detail = main.withDetail ? apiDetail(error) : null;
  if (detail) lines.push(t('common.error.detail', { detail }));
  if (error.status >= 500 && error.requestId) lines.push(t('common.error.requestId', { id: error.requestId }));
  return lines.join('\n');
}
