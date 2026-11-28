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

  // dashboard

  // content

  // revenue
  /** The purchase is in another state than the admin saw (`from`). */
  'purchase_changed',
  /** Another admin action on the purchase is running. */
  'purchase_busy',
  /** The store, the kind or the state does not allow the action. */
  'action_not_available',
  /** The store refused the action (or names a product the catalogue lacks). */
  'store_refused',
  /** A re-check found the store naming an account that is not ours: recorded, and its refund and revoke at the store queued. */
  'foreign_account',
  /** The grant had ended (or was ended early) already. */
  'grant_ended',
  /** The `requestId` of a grant or wallet write was used before: that write was done. */
  'duplicate_request',

  // growth

  // app
  /** The setting (or provider entry) was saved by someone else since it was read (`baseVersion`). */
  'settings_changed',
  /** The database's active brand row is another brand's, or brand.json's id cannot name a row. */
  'brand_mismatch',

  // support

  // system
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

  // dashboard

  // content

  // revenue

  // growth

  // app
  /** The write needs a session opened with the second factor (`amr` holds `otp`) while the deployment requires one. */
  'mfa_required',
  /** The setting is shown, never written from the panel. */
  'read_only',

  // support

  // system
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

  // dashboard

  // content

  // revenue
  'archived_plan',
  'starts_in_past',
  'starts_too_far',
  'insufficient_balance',

  // growth

  // app
  /** A number outside the panel's bounds (`ADMIN_CONFIG_BOUNDS`). */
  'out_of_range',
  /** A suggested version below the required one. */
  'below_required',
  /** A legal text version may only go up. */
  'version_lowered',
  /** The test SMS provider is never routed to in production. */
  'fake_provider',
  /** A provider needs this secret and none is stored. */
  'secret_required',
  /** A service account or key that does not load. */
  'credentials_invalid',
  /** A brand link off the brand's own domains, or a welcome picture off the deployment's media origin. */
  'host_not_allowed',
  /** The deployment's Play has notifications (RTDN): a panel Play entry must name its audience too. */
  'rtdn_required',

  // support

  // system
] as const;
export type AdminFieldCode = (typeof adminFieldCodes)[number];

/** The reasons the server writes on the device bans it makes by itself (no admin, no action). */
export const automaticBanReasons = ['under_age'] as const;
export type AutomaticBanReason = (typeof automaticBanReasons)[number];

export function isAutomaticBanReason(value: string): value is AutomaticBanReason {
  return (automaticBanReasons as readonly string[]).includes(value);
}
