import { originsIssueCodes } from './origins.js';

/**
 * The machine words of the admin API's refusals. The panel words each one
 * itself (its tests hold one sentence per word in every language); the
 * problem's English `detail` is for logs and support, never what an admin
 * reads first.
 *
 * - A 409 (`conflict`) names its reason in the `reason` member.
 * - A 403 (`forbidden`) names its reason in `reason`; `beyond_grants` lists
 *   the permissions in `permissions`.
 * - A 422 (`field_invalid`) names one of {@link adminFieldCodes} in each
 *   `errors[].code` (a 400 `validation_failed` carries the schema's own
 *   keywords, `too_small`, `invalid_type`, ...).
 */

export const adminConflictReasons = [
  // Moderation decisions
  'already_decided',
  'already_closed',
  'already_filed',
  'taken',
  'processing',
  'stale',
  'lifted',
  // Admin accounts
  'self_change',
  'last_owner',
  'email_taken',
  'enroll_first',
  // Settings
  'appearance_changed',
  'hosts_changed',
  'term_exists',
  // Plans and store products
  'rank_taken',
  'key_taken',
  'plan_archived',
  'free_plan_archive',
  'product_exists',
  'plan_not_sold',
  'product_locked',
] as const;
export type AdminConflictReason = (typeof adminConflictReasons)[number];

export const adminForbiddenReasons = [
  /** The admin's roles do not grant the route's permission. */
  'role',
  /** Roles to give grant access the caller does not hold (`permissions` lists it). */
  'beyond_grants',
  /** The account changed holds access the caller's roles do not grant. */
  'beyond_target',
  /** A ban the server made by itself is removed by the owner only. */
  'automatic_ban',
  /** The request came from a page that is not the admin panel. */
  'origin',
  /** Shadowbans are not shown to the caller's role. */
  'shadow_hidden',
] as const;
export type AdminForbiddenReason = (typeof adminForbiddenReasons)[number];

/** Why a banned term cannot be stored (`errors[].code` at `/term`). */
export const bannedTermProblems = [
  'term_empty',
  'regex_invalid',
  'regex_backreference',
  'regex_quote',
  'regex_class_ligature',
  'regex_group',
  'regex_word_boundary',
  'regex_too_large',
  'regex_too_broad',
] as const;
export type BannedTermProblem = (typeof bannedTermProblems)[number];

/** Why a new admin password is refused. */
export const adminPasswordProblems = ['too_short', 'too_long', 'is_email'] as const;
export type AdminPasswordProblem = (typeof adminPasswordProblems)[number];

/** Every `errors[].code` an admin route writes itself. */
export const adminFieldCodes = [
  // Lists and filters
  'invalid',
  'not_a_public_id',
  'not_an_id',
  'ends_before_start',
  'too_many_rows',
  // Admin accounts
  'unknown_role',
  'wrong',
  ...adminPasswordProblems,
  // Appearance and hosts
  'default_not_offered',
  ...originsIssueCodes,
  // Plans and store products
  'unknown_plan',
  'free_plan',
  'not_every_plan',
  'other_kind',
  'other_plan',
  'bazaar_base_plan',
  'bazaar_period',
  'base_plan_required',
  'not_a_consumable',
  'not_a_subscription',
  'catalog_rule',
  // Moderation and reports
  'ends_in_past',
  'ends_too_far',
  'phone_invalid',
  'unknown_action',
  'nothing_to_ban',
  'wrong_reason',
  'not_a_part',
  'name_refused',
  'unknown_report',
  'not_this_user',
  'unknown_admin',
  'unknown_user',
  'unknown_conversation',
  'no_target',
  'resolution_not_action',
  'resolution_is_action',
  'resolution_not_allowed',
  'action_not_taken',
  ...bannedTermProblems,
] as const;
export type AdminFieldCode = (typeof adminFieldCodes)[number];

/** The reasons the server writes on the device bans it makes by itself (no admin, no action). */
export const automaticBanReasons = ['under_age'] as const;
export type AutomaticBanReason = (typeof automaticBanReasons)[number];

export function isAutomaticBanReason(value: string): value is AutomaticBanReason {
  return (automaticBanReasons as readonly string[]).includes(value);
}
