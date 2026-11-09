import { importPKCS8, SignJWT, type CryptoKey } from 'jose';
import { z } from 'zod';
import { defaultFetch, fetchWithTimeout, isRetryableStatus, type Fetch } from './http.js';

/**
 * The Google Play Developer API (androidpublisher v3) for store purchases:
 *
 * - `purchases.subscriptionsv2.get` (the subscription's state; v1 `subscriptions.get` is deprecated)
 * - `purchases.productsv2.getproductpurchasev2` (a one-time product's state)
 * - `purchases.subscriptions.acknowledge` (still the v1 path), `purchases.products.acknowledge`, `.consume`
 * - `purchases.subscriptionsv2.revoke` (`revocationContext.fullRefund` / `proratedRefund`)
 * - `orders.refund` (`revoke=true`), for one-time products
 * - `purchases.voidedpurchases.list` (refunds and chargebacks, 30 days back, 1000 a page)
 *
 * Auth: a service account signs an RS256 JWT (scope `androidpublisher`)
 * exchanged at Google's token endpoint for an access token, cached until a
 * minute before it expires; one exchange runs at a time.
 *
 * Every call has a deadline. Reads, acknowledge and consume are retried on
 * a network error, 408, 429 or 5xx (they change nothing a second time);
 * revoke and refund are never retried here (a lost answer may have taken
 * effect: the caller reads the purchase again instead). A 401 drops the
 * cached access token and is tried once more (the call did not run).
 *
 * Errors are `PlayApiError`s carrying the HTTP status and Google's reason;
 * the token never appears in a message (it is part of the URL, so no URL
 * is put into one either).
 */

export const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
export const PLAY_API_BASE = 'https://androidpublisher.googleapis.com';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleServiceAccountKey {
  clientEmail: string;
  /** PKCS#8 PEM. */
  privateKey: string;
  privateKeyId?: string | undefined;
  /** The token endpoint (`token_uri`); Google's by default. */
  tokenUri?: string | undefined;
}

export class PlayApiError extends Error {
  /** HTTP status; 0 for a network failure, a timeout or a token exchange that failed. */
  readonly status: number;
  /** Google's `error.errors[0].reason`, else `error.status` (e.g. `INVALID_ARGUMENT`). */
  readonly reason: string | undefined;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, options: { status: number; reason?: string | undefined; retryable: boolean; retryAfterSeconds?: number | undefined; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PlayApiError';
    this.status = options.status;
    this.reason = options.reason;
    this.retryable = options.retryable;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** Service-account access tokens for one scope (JWT bearer grant, RFC 7523), cached and single-flight. */
export class GoogleServiceAccountTokens {
  private readonly account: GoogleServiceAccountKey;
  private readonly scope: string;
  private readonly fetch: Fetch;
  private readonly tokenUrl: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private signingKey: Promise<CryptoKey> | undefined;
  private cached: { value: string; expiresAtMs: number } | undefined;
  private pending: Promise<string> | undefined;
  /** Exchanges made (tests: the cache works). */
  exchanges = 0;

  constructor(options: { account: GoogleServiceAccountKey; scope: string; fetch?: Fetch | undefined; tokenUrl?: string | undefined; timeoutMs?: number | undefined; now?: (() => number) | undefined }) {
    this.account = options.account;
    this.scope = options.scope;
    this.fetch = options.fetch ?? defaultFetch;
    this.tokenUrl = options.tokenUrl ?? options.account.tokenUri ?? GOOGLE_TOKEN_URL;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  async token(): Promise<string> {
    const cached = this.cached;
    if (cached && cached.expiresAtMs - 60_000 > this.now()) return cached.value;
    this.pending ??= this.exchange().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  /** The cached token was refused (401): the next call exchanges a new one. */
  invalidate(value?: string): void {
    if (value === undefined || this.cached?.value === value) this.cached = undefined;
  }

  private async exchange(): Promise<string> {
    this.exchanges += 1;
    this.signingKey ??= importPKCS8(this.account.privateKey, 'RS256');
    let key: CryptoKey;
    try {
      key = await this.signingKey;
    } catch (error) {
      this.signingKey = undefined;
      throw new PlayApiError('the service account key cannot be read', { status: 0, retryable: false, cause: error });
    }
    const nowSeconds = Math.floor(this.now() / 1_000);
    const assertion = await new SignJWT({ scope: this.scope })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', ...(this.account.privateKeyId ? { kid: this.account.privateKeyId } : {}) })
      .setIssuer(this.account.clientEmail)
      .setSubject(this.account.clientEmail)
      .setAudience(this.tokenUrl)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 3_600)
      .sign(key);
    let response: Response;
    try {
      response = await fetchWithTimeout(
        this.fetch,
        this.tokenUrl,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
        },
        this.timeoutMs,
      );
    } catch (error) {
      throw new PlayApiError('token exchange failed (network)', { status: 0, retryable: true, cause: error });
    }
    // The error body may echo the assertion: only the status goes into the message.
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PlayApiError(`token exchange answered ${response.status}`, { status: 0, retryable: isRetryableStatus(response.status) });
    }
    const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
      throw new PlayApiError('token exchange gave no access token', { status: 0, retryable: true });
    }
    const lifetime = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3_600;
    this.cached = { value: body.access_token, expiresAtMs: this.now() + lifetime * 1_000 };
    return body.access_token;
  }
}

// ─── Resources (only the fields the server reads; Google adds fields over time) ──────────────

const timestamp = z.string().min(1).max(64);
const money = z.object({ currencyCode: z.string().length(3), units: z.union([z.string(), z.number()]).optional(), nanos: z.number().int().optional() }).loose();

/** `ExternalAccountIdentifiers` of a subscription. */
const externalAccountIdentifiers = z
  .object({ externalAccountId: z.string().optional(), obfuscatedExternalAccountId: z.string().optional(), obfuscatedExternalProfileId: z.string().optional() })
  .loose();

export const subscriptionLineItemSchema = z
  .object({
    productId: z.string().min(1).max(200),
    expiryTime: timestamp.optional(),
    latestSuccessfulOrderId: z.string().max(200).optional(),
    autoRenewingPlan: z.object({ autoRenewEnabled: z.boolean().optional(), recurringPrice: money.optional() }).loose().optional(),
    prepaidPlan: z.object({ allowExtendAfterTime: timestamp.optional() }).loose().optional(),
    offerDetails: z.object({ basePlanId: z.string().max(200).optional(), offerId: z.string().max(200).optional(), offerTags: z.array(z.string()).optional() }).loose().optional(),
    offerPhase: z
      .object({ basePrice: z.object({}).loose().optional(), freeTrial: z.object({}).loose().optional(), introductoryPrice: z.object({}).loose().optional(), prorationPeriod: z.object({}).loose().optional() })
      .loose()
      .optional(),
  })
  .loose();

/** `SubscriptionPurchaseV2` (purchases.subscriptionsv2). */
export const subscriptionPurchaseV2Schema = z
  .object({
    kind: z.string().optional(),
    regionCode: z.string().max(8).optional(),
    lineItems: z.array(subscriptionLineItemSchema).max(50).default([]),
    startTime: timestamp.optional(),
    subscriptionState: z.string().max(80).default('SUBSCRIPTION_STATE_UNSPECIFIED'),
    linkedPurchaseToken: z.string().min(1).max(4096).optional(),
    pausedStateContext: z.object({ autoResumeTime: timestamp.optional() }).loose().optional(),
    canceledStateContext: z.object({}).loose().optional(),
    testPurchase: z.object({}).loose().optional(),
    acknowledgementState: z.string().max(80).default('ACKNOWLEDGEMENT_STATE_UNSPECIFIED'),
    externalAccountIdentifiers: externalAccountIdentifiers.optional(),
    outOfAppPurchaseContext: z
      .object({ expiredExternalAccountIdentifiers: externalAccountIdentifiers.optional(), expiredPurchaseToken: z.string().min(1).max(4096).optional() })
      .loose()
      .optional(),
  })
  .loose();
export type SubscriptionPurchaseV2 = z.infer<typeof subscriptionPurchaseV2Schema>;

/** `ProductPurchaseV2` (purchases.productsv2). */
export const productPurchaseV2Schema = z
  .object({
    kind: z.string().optional(),
    productLineItem: z
      .array(
        z
          .object({
            productId: z.string().min(1).max(200),
            productOfferDetails: z
              .object({
                quantity: z.number().int().nonnegative().optional(),
                refundableQuantity: z.number().int().nonnegative().optional(),
                consumptionState: z.string().max(80).optional(),
                purchaseOptionId: z.string().optional(),
                offerId: z.string().optional(),
                offerTags: z.array(z.string()).optional(),
              })
              .loose()
              .optional(),
          })
          .loose(),
      )
      .max(50)
      .default([]),
    purchaseStateContext: z.object({ purchaseState: z.string().max(80).optional() }).loose().optional(),
    testPurchaseContext: z.object({ fopType: z.string().optional() }).loose().optional(),
    orderId: z.string().max(200).optional(),
    obfuscatedExternalAccountId: z.string().optional(),
    obfuscatedExternalProfileId: z.string().optional(),
    regionCode: z.string().max(8).optional(),
    purchaseCompletionTime: timestamp.optional(),
    acknowledgementState: z.string().max(80).default('ACKNOWLEDGEMENT_STATE_UNSPECIFIED'),
  })
  .loose();
export type ProductPurchaseV2 = z.infer<typeof productPurchaseV2Schema>;

/** One entry of `purchases.voidedpurchases.list` (times are decimal strings of epoch ms). */
export const voidedPurchaseSchema = z
  .object({
    purchaseToken: z.string().min(1).max(4096),
    orderId: z.string().max(200).optional(),
    purchaseTimeMillis: z.union([z.string(), z.number()]).optional(),
    voidedTimeMillis: z.union([z.string(), z.number()]).optional(),
    voidedSource: z.number().int().optional(),
    voidedReason: z.number().int().optional(),
    voidedQuantity: z.number().int().optional(),
  })
  .loose();
export type VoidedPurchase = z.infer<typeof voidedPurchaseSchema>;

const voidedListSchema = z
  .object({
    voidedPurchases: z.array(voidedPurchaseSchema).default([]),
    tokenPagination: z.object({ nextPageToken: z.string().optional() }).loose().optional(),
  })
  .loose();

export interface VoidedPage {
  purchases: VoidedPurchase[];
  nextPageToken: string | null;
}

export interface PlayDeveloperApiOptions {
  packageName: string;
  account: GoogleServiceAccountKey;
  fetch?: Fetch | undefined;
  /** `https://androidpublisher.googleapis.com` unless a test points it elsewhere. */
  apiBase?: string | undefined;
  /** Overrides the service account's `token_uri` (tests). */
  tokenUrl?: string | undefined;
  /** One attempt's deadline. */
  timeoutMs?: number | undefined;
  /** The whole call's deadline, retries included. */
  totalTimeoutMs?: number | undefined;
  /** Further attempts of a retryable call. */
  retries?: number | undefined;
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

interface CallOptions {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string> | undefined;
  body?: unknown;
  /** Safe to send again after a failure that may have reached Google. */
  idempotent: boolean;
  /** What the call is, for messages (never the URL: it holds the token). */
  what: string;
}

const segment = (value: string) => encodeURIComponent(value);

export class PlayDeveloperApi {
  readonly packageName: string;
  private readonly tokens: GoogleServiceAccountTokens;
  private readonly fetch: Fetch;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly retries: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Requests sent to the API (tests count store calls). */
  requests = 0;

  constructor(options: PlayDeveloperApiOptions) {
    this.packageName = options.packageName;
    this.fetch = options.fetch ?? defaultFetch;
    this.apiBase = (options.apiBase ?? PLAY_API_BASE).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.totalTimeoutMs = options.totalTimeoutMs ?? 12_000;
    this.retries = options.retries ?? 2;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.tokens = new GoogleServiceAccountTokens({
      account: options.account,
      scope: ANDROID_PUBLISHER_SCOPE,
      fetch: this.fetch,
      tokenUrl: options.tokenUrl,
      timeoutMs: this.timeoutMs,
      now: this.now,
    });
  }

  /** Token exchanges so far (tests). */
  get tokenExchanges(): number {
    return this.tokens.exchanges;
  }

  private app(path: string): string {
    return `/androidpublisher/v3/applications/${segment(this.packageName)}${path}`;
  }

  /** `GET purchases/subscriptionsv2/tokens/{token}` */
  async getSubscription(token: string): Promise<SubscriptionPurchaseV2> {
    const body = await this.call({ method: 'GET', path: this.app(`/purchases/subscriptionsv2/tokens/${segment(token)}`), idempotent: true, what: 'subscriptionsv2.get' });
    return parse(subscriptionPurchaseV2Schema, body, 'subscriptionsv2.get');
  }

  /** `GET purchases/productsv2/tokens/{token}` */
  async getProduct(token: string): Promise<ProductPurchaseV2> {
    const body = await this.call({ method: 'GET', path: this.app(`/purchases/productsv2/tokens/${segment(token)}`), idempotent: true, what: 'productsv2.get' });
    return parse(productPurchaseV2Schema, body, 'productsv2.get');
  }

  /** `POST purchases/subscriptions/{subscriptionId}/tokens/{token}:acknowledge` (empty body: no `externalAccountIds`). */
  async acknowledgeSubscription(subscriptionId: string, token: string): Promise<void> {
    await this.call({
      method: 'POST',
      path: this.app(`/purchases/subscriptions/${segment(subscriptionId)}/tokens/${segment(token)}:acknowledge`),
      body: {},
      idempotent: true,
      what: 'subscriptions.acknowledge',
    });
  }

  /** `POST purchases/products/{productId}/tokens/{token}:acknowledge` */
  async acknowledgeProduct(productId: string, token: string): Promise<void> {
    await this.call({ method: 'POST', path: this.app(`/purchases/products/${segment(productId)}/tokens/${segment(token)}:acknowledge`), body: {}, idempotent: true, what: 'products.acknowledge' });
  }

  /** `POST purchases/products/{productId}/tokens/{token}:consume` (consuming also acknowledges). */
  async consumeProduct(productId: string, token: string): Promise<void> {
    await this.call({ method: 'POST', path: this.app(`/purchases/products/${segment(productId)}/tokens/${segment(token)}:consume`), idempotent: true, what: 'products.consume' });
  }

  /** `POST purchases/subscriptionsv2/tokens/{token}:revoke`: access ends now, refunded in full (or prorated). */
  async revokeSubscription(token: string, refund: 'full' | 'prorated' = 'full'): Promise<void> {
    await this.call({
      method: 'POST',
      path: this.app(`/purchases/subscriptionsv2/tokens/${segment(token)}:revoke`),
      body: { revocationContext: refund === 'full' ? { fullRefund: {} } : { proratedRefund: {} } },
      idempotent: false,
      what: 'subscriptionsv2.revoke',
    });
  }

  /** `POST orders/{orderId}:refund?revoke=true`: refunds the order and takes the item back. */
  async refundOrder(orderId: string, options: { revoke: boolean } = { revoke: true }): Promise<void> {
    await this.call({ method: 'POST', path: this.app(`/orders/${segment(orderId)}:refund`), query: { revoke: String(options.revoke) }, idempotent: false, what: 'orders.refund' });
  }

  /**
   * `GET purchases/voidedpurchases`: `type` 1 includes subscriptions (whose renewals share a token, so an
   * entry is identified by its `orderId`). With a page token the times are ignored by Google. The parameter
   * names are the voided-purchases guide's (`maxResults`, `token`); the REST reference also lists
   * `pageSelection.maxResults` / `pageSelection.token` (unverified which one the service prefers).
   */
  async listVoided(query: { startTimeMs?: number | undefined; endTimeMs?: number | undefined; type?: 0 | 1; pageToken?: string | undefined; maxResults?: number | undefined }): Promise<VoidedPage> {
    const q: Record<string, string> = { type: String(query.type ?? 1), maxResults: String(Math.min(1_000, Math.max(1, query.maxResults ?? 1_000))) };
    if (query.pageToken) q['token'] = query.pageToken;
    else {
      if (query.startTimeMs !== undefined) q['startTime'] = String(Math.floor(query.startTimeMs));
      if (query.endTimeMs !== undefined) q['endTime'] = String(Math.floor(query.endTimeMs));
    }
    const body = await this.call({ method: 'GET', path: this.app('/purchases/voidedpurchases'), query: q, idempotent: true, what: 'voidedpurchases.list' });
    const page = parse(voidedListSchema, body, 'voidedpurchases.list');
    return { purchases: page.voidedPurchases, nextPageToken: page.tokenPagination?.nextPageToken || null };
  }

  private async call(options: CallOptions): Promise<unknown> {
    const deadline = this.now() + this.totalTimeoutMs;
    const url = new URL(`${this.apiBase}${options.path}`);
    for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
    let attempt = 0;
    let reauthorized = false;
    for (;;) {
      let access: string;
      try {
        access = await this.tokens.token();
      } catch (error) {
        if (error instanceof PlayApiError) throw error;
        throw new PlayApiError(`${options.what}: no access token`, { status: 0, retryable: true, cause: error });
      }
      const remaining = deadline - this.now();
      let failure: PlayApiError;
      try {
        this.requests += 1;
        const response = await fetchWithTimeout(
          this.fetch,
          url,
          {
            method: options.method,
            headers: {
              authorization: `Bearer ${access}`,
              accept: 'application/json',
              ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
            },
            ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          },
          Math.max(500, Math.min(this.timeoutMs, remaining)),
        );
        if (response.ok) {
          const text = await response.text();
          if (text.trim().length === 0) return {};
          try {
            return JSON.parse(text) as unknown;
          } catch (error) {
            throw new PlayApiError(`${options.what}: the answer is not JSON`, { status: response.status, retryable: true, cause: error });
          }
        }
        failure = await errorOf(response, options.what);
        if (response.status === 401 && !reauthorized) {
          // The access token was refused: the call did not run, so a new token may try again.
          reauthorized = true;
          this.tokens.invalidate(access);
          continue;
        }
      } catch (error) {
        if (error instanceof PlayApiError) throw error;
        failure = new PlayApiError(`${options.what}: ${timedOut(error) ? 'timed out' : 'network error'}`, { status: 0, retryable: true, cause: error });
      }
      if (!failure.retryable || !options.idempotent || attempt >= this.retries) throw failure;
      const wait = Math.min(2_000, failure.retryAfterSeconds !== undefined ? failure.retryAfterSeconds * 1_000 : 250 * 3 ** attempt);
      if (this.now() + wait + 500 > deadline) throw failure;
      attempt += 1;
      await this.sleep(wait);
    }
  }
}

function timedOut(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

async function errorOf(response: Response, what: string): Promise<PlayApiError> {
  let reason: string | undefined;
  try {
    const body = (await response.json()) as { error?: { status?: unknown; errors?: { reason?: unknown }[] } };
    const first = body.error?.errors?.[0]?.reason;
    reason = typeof first === 'string' ? first : typeof body.error?.status === 'string' ? body.error.status : undefined;
  } catch {
    reason = undefined;
  }
  const retryAfter = Number(response.headers.get('retry-after'));
  return new PlayApiError(`${what} answered ${response.status}${reason ? ` (${reason.slice(0, 80)})` : ''}`, {
    status: response.status,
    reason: reason?.slice(0, 80),
    retryable: isRetryableStatus(response.status),
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 3_600) : undefined,
  });
}

function parse<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new PlayApiError(`${what}: the answer does not have the documented shape`, { status: 200, retryable: false });
  return parsed.data;
}
