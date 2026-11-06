import { z } from 'zod';

/**
 * Error responses follow RFC 9457 (Problem Details for HTTP APIs) and are sent
 * as `application/problem+json`. Clients branch on `code`, never on `title` or
 * `detail`, which are human-readable and may change. Some codes carry
 * extension members (`attemptsLeft` on `otp_invalid`, the reason on
 * `account_suspended`, ...): {@link problemExtensions} lists them per code.
 */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

/** Every code with its HTTP status and its title. Clients must treat an unknown code like its HTTP status. */
const catalogue = {
  // Generic
  bad_request: [400, 'Bad request'],
  validation_failed: [400, 'Validation failed'],
  unauthorized: [401, 'Authentication required'],
  token_expired: [401, 'Access token expired'],
  forbidden: [403, 'Forbidden'],
  not_found: [404, 'Not found'],
  method_not_allowed: [405, 'Method not allowed'],
  conflict: [409, 'Conflict'],
  payload_too_large: [413, 'Payload too large'],
  unsupported_media_type: [415, 'Unsupported media type'],
  rate_limited: [429, 'Too many requests'],
  internal: [500, 'Internal server error'],
  service_unavailable: [503, 'Service unavailable'],

  // 400
  phone_invalid: [400, 'Phone number not valid'],
  otp_invalid: [400, 'Wrong code'],
  google_token_invalid: [400, 'Google sign-in not valid'],
  // 401
  refresh_invalid: [401, 'Session not valid'],
  refresh_reused: [401, 'Session revoked'],
  // 403
  account_banned: [403, 'Account banned'],
  account_suspended: [403, 'Account suspended'],
  account_deleted: [403, 'Account deleted'],
  phone_banned: [403, 'Phone number refused'],
  phone_not_allowed: [403, 'Phone number not supported'],
  device_banned: [403, 'Device refused'],
  onboarding_incomplete: [403, 'Profile not complete'],
  consent_required: [403, 'Consent required'],
  snoozed: [403, 'Account paused'],
  location_required: [403, 'Location required'],
  entitlement_required: [403, 'Subscription required'],
  calls_not_allowed: [403, 'Calls not allowed'],
  store_not_supported: [403, 'Not available in this store'],
  // 409
  already_set: [409, 'Already set'],
  position_taken: [409, 'Position taken'],
  already_requested: [409, 'Already requested'],
  already_matched: [409, 'Already matched'],
  confirm_required: [409, 'Confirmation required'],
  caller_busy: [409, 'Already in a call'],
  not_ringing: [409, 'Call not ringing'],
  answered_elsewhere: [409, 'Answered on another device'],
  call_not_live: [409, 'Call not live'],
  appeal_open: [409, 'Appeal already open'],
  purchase_other_account: [409, 'Purchase belongs to another account'],
  // 410
  otp_expired: [410, 'Code expired'],
  conversation_ended: [410, 'Conversation ended'],
  // 422
  under_age: [422, 'Under age'],
  field_invalid: [422, 'Field not valid'],
  text_refused: [422, 'Text refused'],
  message_refused: [422, 'Message refused'],
  photo_limit: [422, 'Photo limit reached'],
  photo_min: [422, 'Too few photos'],
  upload_missing: [422, 'Upload missing'],
  purchase_invalid: [422, 'Purchase not valid'],
  limit_reached: [422, 'Limit reached'],
  not_appealable: [422, 'Not appealable'],
  // 426
  upgrade_required: [426, 'Update required'],
  // 429
  quota_exceeded: [429, 'Quota exceeded'],
  otp_locked: [429, 'Too many wrong codes'],
  // 503
  maintenance: [503, 'Under maintenance'],
  sms_unavailable: [503, 'SMS unavailable'],
  store_unavailable: [503, 'Store unavailable'],
} as const satisfies Record<string, readonly [number, string]>;

export type ErrorCode = keyof typeof catalogue;

/** Codes the server sends. */
export const errorCodes = Object.keys(catalogue) as ErrorCode[];

export const errorCodeStatus = Object.fromEntries(errorCodes.map((code) => [code, catalogue[code][0]])) as Readonly<
  Record<ErrorCode, number>
>;

export const errorCodeTitle = Object.fromEntries(errorCodes.map((code) => [code, catalogue[code][1]])) as Readonly<
  Record<ErrorCode, string>
>;

export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(catalogue, value);
}

/** A stable, brand-neutral problem type URI for a code (RFC 9457 section 3.1.1). */
export function problemType(code: string): string {
  return `urn:problem-type:${code.replaceAll('_', '-')}`;
}

/** Where a validation issue was found in the request. */
export const issueLocations = ['body', 'query', 'params', 'headers'] as const;
export type IssueLocation = (typeof issueLocations)[number];

export const fieldIssueSchema = z.object({
  /** The request part the issue is in. */
  in: z.enum(issueLocations),
  /** JSON Pointer (RFC 6901) into that part, e.g. `/photos/0/id`; `""` is the part itself. */
  pointer: z.string(),
  /** A machine-readable issue code, e.g. `too_small`, `invalid_type`. */
  code: z.string(),
  message: z.string(),
});

export type FieldIssue = z.infer<typeof fieldIssueSchema>;

/** The members every problem may carry; extension members come on top. */
export const problemSchema = z.looseObject({
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  /** One of {@link errorCodes}, or a newer code this client does not know yet. */
  code: z.string(),
  /** The id the server logged this request under; quote it to support. */
  requestId: z.string().optional(),
  /** Present when `code` is `validation_failed`. */
  errors: z.array(fieldIssueSchema).optional(),
  /** Present when `code` is `rate_limited`: seconds until a retry may succeed. */
  retryAfterSeconds: z.number().int().nonnegative().optional(),
});

export type Problem = z.infer<typeof problemSchema>;

/** Members no extension may use. */
const STANDARD_MEMBERS: ReadonlySet<string> = new Set([
  'type',
  'title',
  'status',
  'detail',
  'instance',
  'code',
  'requestId',
  'errors',
  'retryAfterSeconds',
]);

const time = z.iso.datetime({ offset: false, precision: 3 });
const decimalId = z.string().regex(/^[1-9][0-9]{0,18}$/);

/** The token pair a restricted session gets with an `account_*` answer to a refresh. */
const restrictedPair = {
  accessToken: z.string().min(1).optional(),
  accessExpiresAt: time.optional(),
  refreshToken: z.string().min(1).optional(),
  refreshExpiresAt: time.optional(),
};

const accountAction = z.strictObject({
  /** The reason in the person's language, as the moderation action records it. */
  reasonText: z.string().min(1),
  /** The moderation action: the appeal names it. */
  actionId: decimalId,
  /** When a suspension ends; absent for a ban. */
  until: time.optional(),
  appealable: z.boolean(),
  ...restrictedPair,
});

/** Extension members per code. A code not listed carries none. */
export const problemExtensions = {
  otp_invalid: z.strictObject({ attemptsLeft: z.number().int().nonnegative() }),
  account_banned: accountAction,
  account_suspended: accountAction,
  account_deleted: z.strictObject({ restorableUntil: time, ...restrictedPair }),
  consent_required: z.strictObject({ kinds: z.array(z.enum(['terms', 'privacy', 'guidelines'])).min(1) }),
  entitlement_required: z.strictObject({ feature: z.string().min(1) }),
  calls_not_allowed: z.strictObject({ reason: z.enum(['consent', 'disabled', 'plan']) }),
  confirm_required: z.strictObject({ confirmToken: z.string().min(1), category: z.string().min(1) }),
  upgrade_required: z.strictObject({ minVersionCode: z.number().int().positive() }),
  quota_exceeded: z.strictObject({ feature: z.string().min(1), resetsAt: time, canBuy: z.boolean() }),
  maintenance: z.strictObject({ message: z.string().optional() }),
} as const satisfies Partial<Record<ErrorCode, z.ZodObject>>;

type ExtensionCode = keyof typeof problemExtensions;
export type ProblemExtensions<C extends ErrorCode> = C extends ExtensionCode
  ? z.input<(typeof problemExtensions)[C]>
  : Record<never, never>;

/** The schema of a problem with `code`, extension members included (strict: an unknown member fails). */
export function problemSchemaFor(code: ErrorCode) {
  const base = problemSchema.extend({ code: z.literal(code), status: z.literal(errorCodeStatus[code]) });
  const extension = (problemExtensions as Partial<Record<ErrorCode, z.ZodObject>>)[code];
  return (extension ? base.extend(extension.shape) : base).strict();
}

export interface ProblemInit {
  detail?: string | undefined;
  instance?: string | undefined;
  requestId?: string | undefined;
  errors?: FieldIssue[] | undefined;
  retryAfterSeconds?: number | undefined;
  /** Overrides the code's default status, e.g. 422 for a semantic validation error. */
  status?: number | undefined;
  /** Extension members of the code (see {@link problemExtensions}), written at the top level. */
  extensions?: Readonly<Record<string, unknown>> | undefined;
}

/** Builds a problem document for a known code. */
export function problem<C extends ErrorCode>(
  code: C,
  init: ProblemInit & { extensions?: ProblemExtensions<C> | undefined } = {},
): Problem {
  const out: Problem = {
    type: problemType(code),
    title: errorCodeTitle[code],
    status: init.status ?? errorCodeStatus[code],
    code,
  };
  if (init.detail !== undefined) out.detail = init.detail;
  if (init.instance !== undefined) out.instance = init.instance;
  if (init.requestId !== undefined) out.requestId = init.requestId;
  if (init.errors !== undefined) out.errors = init.errors;
  if (init.retryAfterSeconds !== undefined) out.retryAfterSeconds = init.retryAfterSeconds;
  if (init.extensions !== undefined) {
    for (const [name, value] of Object.entries(init.extensions)) {
      if (STANDARD_MEMBERS.has(name)) throw new TypeError(`"${name}" is a standard problem member, not an extension`);
      if (value !== undefined) out[name] = value;
    }
  }
  return out;
}

/** Converts a path such as `['photos', 0, 'id']` to the JSON Pointer `/photos/0/id`. */
export function toJsonPointer(path: readonly PropertyKey[]): string {
  return path
    .map((segment) => `/${String(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`)
    .join('');
}
