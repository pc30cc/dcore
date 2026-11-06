import { z } from 'zod';

/**
 * Error responses follow RFC 9457 (Problem Details for HTTP APIs) and are sent
 * as `application/problem+json`. Clients branch on `code`, never on `title` or
 * `detail`, which are human-readable and may change.
 */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

/** Codes the server sends today. Clients must treat an unknown code like its HTTP status. */
export const errorCodes = [
  'bad_request',
  'validation_failed',
  'unauthorized',
  'token_expired',
  'forbidden',
  'not_found',
  'method_not_allowed',
  'conflict',
  'payload_too_large',
  'unsupported_media_type',
  'rate_limited',
  'internal',
  'service_unavailable',
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export const errorCodeStatus: Readonly<Record<ErrorCode, number>> = {
  bad_request: 400,
  validation_failed: 400,
  unauthorized: 401,
  token_expired: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  internal: 500,
  service_unavailable: 503,
};

export const errorCodeTitle: Readonly<Record<ErrorCode, string>> = {
  bad_request: 'Bad request',
  validation_failed: 'Validation failed',
  unauthorized: 'Authentication required',
  token_expired: 'Access token expired',
  forbidden: 'Forbidden',
  not_found: 'Not found',
  method_not_allowed: 'Method not allowed',
  conflict: 'Conflict',
  payload_too_large: 'Payload too large',
  unsupported_media_type: 'Unsupported media type',
  rate_limited: 'Too many requests',
  internal: 'Internal server error',
  service_unavailable: 'Service unavailable',
};

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

export const problemSchema = z.object({
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

export interface ProblemInit {
  detail?: string | undefined;
  instance?: string | undefined;
  requestId?: string | undefined;
  errors?: FieldIssue[] | undefined;
  retryAfterSeconds?: number | undefined;
  /** Overrides the code's default status, e.g. 422 for a semantic validation error. */
  status?: number | undefined;
}

/** Builds a problem document for a known code. */
export function problem(code: ErrorCode, init: ProblemInit = {}): Problem {
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
  return out;
}

/** Converts a path such as `['photos', 0, 'id']` to the JSON Pointer `/photos/0/id`. */
export function toJsonPointer(path: readonly PropertyKey[]): string {
  return path
    .map((segment) => `/${String(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`)
    .join('');
}
