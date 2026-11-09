import { z } from 'zod';
import { defaultFetch, fetchWithTimeout, type Fetch } from '../http.js';
import type { BazaarCallMeter, BazaarPriority } from './meter.js';

/**
 * Cafe Bazaar's developer API ("pardakht" v2), the server side of in-app
 * billing: purchase and subscription status, a user's active subscriptions,
 * consume, refund and cancel. It reads and manages purchases; it cannot make
 * them.
 *
 * Base `https://pardakht.cafebazaar.ir/devapi/v2`; every call is
 * `<base>/api/...`, path segments URL-encoded, `Accept: application/json`.
 *
 * Authentication: the per-app Pishkhan API token in the header
 * `CAFEBAZAAR-PISHKHAN-API-SECRET`; or the older OAuth client, whose refresh
 * token is exchanged at `<base>/auth/token/` (form `grant_type=refresh_token`,
 * `client_id`, `client_secret`, `refresh_token`; answer `access_token`,
 * `expires_in` 3600) for an access token sent as `Authorization: Bearer`.
 *
 * Errors are HTTP 40X with `{ "error": ..., "error_description": ... }`
 * (one page spells it `error_desciption`, another `invalud_value`; both are
 * read). The quota is 50,000 requests a day per developer; past it the API
 * answers 403 `quota_exceeded`; bad credentials are 401/403
 * `invalid_credentials`.
 *
 * Nothing secret leaves this module in a message: no token (the purchase
 * token is part of the URL, so no URL either), no credential, no response
 * body; only the status, Bazaar's error code and its short description.
 */

export const BAZAAR_API_BASE_URL = 'https://pardakht.cafebazaar.ir/devapi/v2';
export const BAZAAR_DAILY_QUOTA = 50_000;
const DEFAULT_TIMEOUT_MS = 8_000;

export type BazaarAuthOption =
  | { kind: 'pishkhan'; token: string }
  | { kind: 'oauth'; clientId: string; clientSecret: string; refreshToken: string };

/**
 * What went wrong, as the callers need it:
 * - `not_found`: Bazaar does not know the purchase or the token (the only proof it never existed);
 * - `invalid`: the request names something that is not ours (an unknown product, a malformed token, a subscription where a one-time product is expected);
 * - `refunded`: the purchase was refunded (consume);
 * - `config`: Bazaar does not know our package name;
 * - `auth`: the credentials are refused;
 * - `quota`: the day's quota is spent;
 * - `unavailable`: no answer, a 5xx, a 429, a timeout, or an answer that is not what Bazaar documents.
 */
export type BazaarErrorKind = 'not_found' | 'invalid' | 'refunded' | 'config' | 'auth' | 'quota' | 'unavailable';

export class BazaarApiError extends Error {
  readonly kind: BazaarErrorKind;
  readonly status: number;
  /** Bazaar's `error` code (lowercase letters and `_` only). */
  readonly code: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(kind: BazaarErrorKind, message: string, options: { status?: number; code?: string | undefined; retryAfterSeconds?: number | undefined } = {}) {
    super(`bazaar: ${message}`);
    this.name = 'BazaarApiError';
    this.kind = kind;
    this.status = options.status ?? 0;
    this.code = options.code;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function isBazaarApiError(error: unknown, kind?: BazaarErrorKind): error is BazaarApiError {
  return error instanceof BazaarApiError && (kind === undefined || error.kind === kind);
}

const millis = z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,16}$/).transform(Number)]);
const small = z.union([z.number().int(), z.string().regex(/^-?\d{1,3}$/).transform(Number)]);

/** `GET /api/validate/<package>/inapp/<product>/purchases/<token>/`. */
const inappSchema = z.object({
  consumptionState: small,
  purchaseState: small,
  kind: z.string().max(100).optional(),
  developerPayload: z.string().max(2048).nullish(),
  purchaseTime: millis.optional(),
});

/** One-time product purchase: `consumed` is `consumptionState` 0; `refunded` is `purchaseState` 1. */
export interface BazaarInappPurchase {
  consumed: boolean;
  refunded: boolean;
  developerPayload: string | null;
  purchaseTimeMs: number | null;
}

const subscriptionSchema = z.object({
  kind: z.string().max(100).optional(),
  initiationTimestampMsec: millis,
  validUntilTimestampMsec: millis,
  autoRenewing: z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]),
  linkedSubscriptionToken: z.string().max(4096).nullish(),
});

const activeSchema = z.object({
  subscriptions: z.array(subscriptionSchema.extend({ sku: z.string().min(1).max(200) })).max(100),
});

/**
 * A subscription's status. `validUntilMs` is the next charge for a renewing
 * subscription and the end otherwise; Bazaar returns ended ones too, so it
 * is compared with the clock by the caller. `chainToken` is
 * `linkedSubscriptionToken`, a value unique to the subscription that stays
 * the same across its renewals.
 */
export interface BazaarSubscription {
  startedAtMs: number;
  validUntilMs: number;
  autoRenewing: boolean;
  chainToken: string | null;
}

/** An entry of `active-subscriptions`: the user's live subscription of one SKU. */
export interface BazaarActiveSubscription extends BazaarSubscription {
  sku: string;
}

export type BazaarActionOutcome = 'done' | 'already';

/** Every call says how urgent it is: a purchase the person waits for, or a check the worker can make later. */
export interface BazaarApi {
  /** One-time product status (`validate`). */
  inappPurchase(productId: string, token: string, priority: BazaarPriority): Promise<BazaarInappPurchase>;
  /** One subscription's status, initial or renewal token (`applications/<package>/subscriptions/<sku>/purchases/<token>/`). */
  subscription(subscriptionId: string, token: string, priority: BazaarPriority): Promise<BazaarSubscription>;
  /** The live subscriptions of the user a token belongs to; empty when they have none (`no subscription found!`). */
  activeSubscriptions(token: string, priority: BazaarPriority): Promise<BazaarActiveSubscription[]>;
  /** `already` for `already_consumed`. */
  consume(token: string, priority: BazaarPriority): Promise<BazaarActionOutcome>;
  /** `already` for "Previously Refunded". */
  refund(token: string, priority: BazaarPriority): Promise<BazaarActionOutcome>;
  /** Stops a subscription's renewal; `already` when it was cancelled or has ended. */
  cancelSubscription(subscriptionId: string, token: string, priority: BazaarPriority): Promise<BazaarActionOutcome>;
}

export interface PardakhtClientOptions {
  packageName: string;
  auth: BazaarAuthOption;
  /** Default {@link BAZAAR_API_BASE_URL}; tests point it at a local server. */
  baseUrl?: string | undefined;
  fetch?: Fetch | undefined;
  /** Per request; default 8 s. */
  timeoutMs?: number | undefined;
  /** Counts every API call and holds back background calls near the quota or in a burst. */
  meter?: BazaarCallMeter | undefined;
  now?: (() => number) | undefined;
}

interface ErrorBody {
  error: string | undefined;
  description: string;
}

const ERROR_CODE = /^[a-z_]{1,40}$/;

function errorBodyOf(value: unknown): ErrorBody {
  if (typeof value !== 'object' || value === null) return { error: undefined, description: '' };
  const record = value as Record<string, unknown>;
  const raw = record['error'];
  const text = record['error_description'] ?? record['error_desciption'];
  return {
    error: typeof raw === 'string' && ERROR_CODE.test(raw) ? raw : undefined,
    // A short, printable description only: it goes into messages and logs.
    description: typeof text === 'string' ? text.replace(/[^\x20-\x7e]/g, '').slice(0, 80) : '',
  };
}

function retryAfterOf(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(86_400, Math.ceil(seconds));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(1, Math.min(86_400, Math.ceil((at - Date.now()) / 1000))) : undefined;
}

/** Seconds until the next UTC midnight (the quota's day is not documented; UTC is assumed). */
function secondsToNextUtcDay(nowMs: number): number {
  const next = new Date(nowMs);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(60, Math.ceil((next.getTime() - nowMs) / 1000));
}

type Operation = 'inapp' | 'subscription' | 'active' | 'consume' | 'refund' | 'cancel' | 'token';

export class PardakhtClient implements BazaarApi {
  private readonly base: string;
  private readonly packageName: string;
  private readonly auth: BazaarAuthOption;
  private readonly fetch: Fetch;
  private readonly timeoutMs: number;
  private readonly meter: BazaarCallMeter | undefined;
  private readonly now: () => number;
  private access: { token: string; untilMs: number } | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(options: PardakhtClientOptions) {
    this.base = (options.baseUrl ?? BAZAAR_API_BASE_URL).replace(/\/+$/, '');
    this.packageName = options.packageName;
    this.auth = options.auth;
    this.fetch = options.fetch ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.meter = options.meter;
    this.now = options.now ?? Date.now;
  }

  private path(...segments: string[]): string {
    return `${this.base}/api/${segments.map((s) => encodeURIComponent(s)).join('/')}/`;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    if (this.auth.kind === 'pishkhan') return { 'CAFEBAZAAR-PISHKHAN-API-SECRET': this.auth.token };
    return { authorization: `Bearer ${await this.accessToken()}` };
  }

  /** The OAuth access token, refreshed a minute before it runs out; one refresh at a time. */
  private async accessToken(): Promise<string> {
    if (this.access && this.now() < this.access.untilMs) return this.access.token;
    this.refreshing ??= this.refreshAccess().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refreshAccess(): Promise<string> {
    if (this.auth.kind !== 'oauth') throw new Error('not an OAuth client');
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.auth.clientId,
      client_secret: this.auth.clientSecret,
      refresh_token: this.auth.refreshToken,
    });
    let response: Response;
    try {
      response = await fetchWithTimeout(
        this.fetch,
        `${this.base}/auth/token/`,
        { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString() },
        this.timeoutMs,
      );
    } catch (error) {
      throw this.unreachable('token', error);
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const { error } = errorBodyOf(body);
      const kind = response.status === 400 || response.status === 401 || response.status === 403 ? 'auth' : 'unavailable';
      throw new BazaarApiError(kind, `token refresh answered ${response.status}${error ? ` ${error}` : ''}`, { status: response.status, code: error });
    }
    const parsed = z.object({ access_token: z.string().min(8).max(4096), expires_in: z.number().int().positive().max(86_400 * 30).optional() }).safeParse(body);
    if (!parsed.success) throw new BazaarApiError('unavailable', 'token refresh answered without an access token', { status: response.status });
    const lifetimeMs = (parsed.data.expires_in ?? 3_600) * 1000;
    this.access = { token: parsed.data.access_token, untilMs: this.now() + Math.max(lifetimeMs - 60_000, lifetimeMs / 2) };
    return parsed.data.access_token;
  }

  private unreachable(operation: Operation, error: unknown): BazaarApiError {
    // The reason only (a timeout, ECONNREFUSED ...): the error itself may carry the URL, and the URL carries the token.
    let reason = 'error';
    if (error instanceof Error) {
      const code = (error.cause as { code?: unknown } | undefined)?.code;
      reason = error.name === 'TimeoutError' ? 'timeout' : typeof code === 'string' ? code : error.name;
    }
    return new BazaarApiError('unavailable', `${operation} unreachable (${reason.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40)})`);
  }

  /** One API call: the meter first, then the request; the answer's JSON, or a BazaarApiError. */
  private async request(operation: Operation, priority: BazaarPriority, url: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<{ status: number; body: unknown }> {
    if (this.meter) await this.meter.take(priority);
    const headers: Record<string, string> = { accept: 'application/json', ...(await this.authHeaders()) };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await fetchWithTimeout(
        this.fetch,
        url,
        { method: init.method, headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) },
        this.timeoutMs,
      );
    } catch (error) {
      throw this.unreachable(operation, error);
    }
    const text = await response.text().catch(() => '');
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        if (response.ok) throw new BazaarApiError('unavailable', `${operation} answered ${response.status} with a body that is not JSON`, { status: response.status });
      }
    }
    if (response.ok) return { status: response.status, body };
    throw await this.failure(operation, response, body);
  }

  private async failure(operation: Operation, response: Response, body: unknown): Promise<BazaarApiError> {
    const { status } = response;
    const { error, description } = errorBodyOf(body);
    const what = `${operation} answered ${status}${error ? ` ${error}` : ''}${description ? ` (${description})` : ''}`;
    const options = { status, code: error };
    if (status === 401 || error === 'invalid_credentials') {
      // An expired or revoked OAuth token: the next call refreshes it.
      this.access = null;
      return new BazaarApiError('auth', what, options);
    }
    if (status === 403 && error === 'quota_exceeded') {
      const retryAfterSeconds = secondsToNextUtcDay(this.now());
      await this.meter?.exhausted().catch(() => undefined);
      return new BazaarApiError('quota', what, { ...options, retryAfterSeconds });
    }
    if (status === 403) return new BazaarApiError('auth', what, options);
    if (status === 429 || status === 408 || status >= 500) return new BazaarApiError('unavailable', what, { ...options, retryAfterSeconds: retryAfterOf(response) });
    if (/package name/i.test(description)) return new BazaarApiError('config', what, options);
    if (error === 'not_found') return new BazaarApiError('not_found', what, options);
    if (error === 'is_refunded') return new BazaarApiError('refunded', what, options);
    if (status === 400 || status === 404) return new BazaarApiError('invalid', what, options);
    return new BazaarApiError('unavailable', what, options);
  }

  private parse<T>(operation: Operation, schema: z.ZodType<T>, body: unknown): T {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new BazaarApiError('unavailable', `${operation} answered a body Bazaar does not document`);
    return parsed.data;
  }

  async inappPurchase(productId: string, token: string, priority: BazaarPriority): Promise<BazaarInappPurchase> {
    const { body } = await this.request('inapp', priority, this.path('validate', this.packageName, 'inapp', productId, 'purchases', token), { method: 'GET' });
    const p = this.parse('inapp', inappSchema, body);
    return {
      consumed: p.consumptionState === 0,
      refunded: p.purchaseState === 1,
      developerPayload: p.developerPayload ? p.developerPayload : null,
      purchaseTimeMs: p.purchaseTime ?? null,
    };
  }

  async subscription(subscriptionId: string, token: string, priority: BazaarPriority): Promise<BazaarSubscription> {
    const { body } = await this.request('subscription', priority, this.path('applications', this.packageName, 'subscriptions', subscriptionId, 'purchases', token), { method: 'GET' });
    return subscriptionOf(this.parse('subscription', subscriptionSchema, body));
  }

  async activeSubscriptions(token: string, priority: BazaarPriority): Promise<BazaarActiveSubscription[]> {
    try {
      const { body } = await this.request('active', priority, this.path('applications', this.packageName, 'active-subscriptions', token), { method: 'GET' });
      return this.parse('active', activeSchema, body).subscriptions.map((s) => ({ ...subscriptionOf(s), sku: s.sku }));
    } catch (error) {
      // 404 not_found is "no subscription found!" (the user has none) or "token not found!" (no such token).
      if (isBazaarApiError(error, 'not_found') && !/token/i.test(error.message)) return [];
      throw error;
    }
  }

  async consume(token: string, priority: BazaarPriority): Promise<BazaarActionOutcome> {
    try {
      await this.request('consume', priority, this.path('consume', this.packageName, 'purchases'), { method: 'POST', body: { token } });
      return 'done';
    } catch (error) {
      if (isBazaarApiError(error) && error.code === 'already_consumed') return 'already';
      throw error;
    }
  }

  async refund(token: string, priority: BazaarPriority): Promise<BazaarActionOutcome> {
    try {
      await this.request('refund', priority, this.path('refund', this.packageName, 'purchases', token), { method: 'POST' });
      return 'done';
    } catch (error) {
      if (isBazaarApiError(error) && error.status === 400 && /refunded/i.test(error.message)) return 'already';
      throw error;
    }
  }

  async cancelSubscription(subscriptionId: string, token: string, priority: BazaarPriority): Promise<BazaarActionOutcome> {
    try {
      // The page names no method; the only client found uses GET.
      await this.request('cancel', priority, `${this.path('applications', this.packageName, 'subscriptions', subscriptionId, 'purchases', token)}cancel/`, { method: 'GET' });
      return 'done';
    } catch (error) {
      if (isBazaarApiError(error) && error.status === 400 && /cancel|expire/i.test(error.message)) return 'already';
      throw error;
    }
  }
}

function subscriptionOf(s: z.infer<typeof subscriptionSchema>): BazaarSubscription {
  return {
    startedAtMs: s.initiationTimestampMsec,
    validUntilMs: s.validUntilTimestampMsec,
    autoRenewing: s.autoRenewing,
    chainToken: s.linkedSubscriptionToken ? s.linkedSubscriptionToken : null,
  };
}
