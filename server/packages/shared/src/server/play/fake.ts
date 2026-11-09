import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, importPKCS8, importSPKI, jwtVerify, type CryptoKey, type JWK } from 'jose';
import { ANDROID_PUBLISHER_SCOPE, PlayDeveloperApi, type GoogleServiceAccountKey, type PlayDeveloperApiOptions } from '../clients/playDeveloper.js';

/**
 * Google Play on a local port (tests): the OAuth token endpoint (it checks
 * the service account's signed assertion), the Developer API calls the
 * server makes (subscriptionsv2, productsv2, acknowledge, consume, revoke,
 * orders.refund, voidedpurchases) over purchases held in memory, and the
 * key set and signer of Pub/Sub push tokens. Resources are built in the
 * shape of Google's reference pages; failures can be injected per call.
 * Nothing here talks to Google.
 */

export interface PlaySubscriptionInput {
  /** `subscriptionState` (default SUBSCRIPTION_STATE_ACTIVE). */
  state?: string | undefined;
  productId: string;
  basePlanId?: string | undefined;
  offerId?: string | undefined;
  startTimeMs?: number | undefined;
  expiryTimeMs?: number | undefined;
  autoRenew?: boolean | undefined;
  /** `externalAccountIdentifiers.obfuscatedExternalAccountId` (the app's billingRef). */
  accountRef?: string | undefined;
  linkedPurchaseToken?: string | undefined;
  acknowledged?: boolean | undefined;
  orderId?: string | undefined;
  regionCode?: string | undefined;
  test?: boolean | undefined;
  freeTrial?: boolean | undefined;
  autoResumeTimeMs?: number | undefined;
  /** A re-signup from the Play Store after expiry. */
  outOfApp?: { expiredPurchaseToken?: string | undefined; accountRef?: string | undefined } | undefined;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A `SubscriptionPurchaseV2` as `purchases.subscriptionsv2.get` returns it. */
export function playSubscriptionResource(input: PlaySubscriptionInput): Record<string, unknown> {
  const state = input.state ?? 'SUBSCRIPTION_STATE_ACTIVE';
  const pending = state === 'SUBSCRIPTION_STATE_PENDING' || state === 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED';
  const lineItem: Record<string, unknown> = {
    productId: input.productId,
    ...(input.expiryTimeMs !== undefined ? { expiryTime: iso(input.expiryTimeMs) } : {}),
    ...(pending ? {} : { latestSuccessfulOrderId: input.orderId ?? `GPA.${randomDigits(4)}-${randomDigits(4)}-${randomDigits(4)}-${randomDigits(5)}` }),
    autoRenewingPlan: { autoRenewEnabled: input.autoRenew ?? state === 'SUBSCRIPTION_STATE_ACTIVE', recurringPrice: { currencyCode: 'EUR', units: '4', nanos: 990_000_000 } },
    offerDetails: { basePlanId: input.basePlanId ?? 'm1', ...(input.offerId ? { offerId: input.offerId } : {}), offerTags: [] },
    ...(input.freeTrial ? { offerPhase: { freeTrial: {} } } : { offerPhase: { basePrice: {} } }),
  };
  return {
    kind: 'androidpublisher#subscriptionPurchaseV2',
    regionCode: input.regionCode ?? 'DE',
    lineItems: [lineItem],
    ...(pending ? {} : { startTime: iso(input.startTimeMs ?? Date.now()) }),
    subscriptionState: state,
    ...(input.linkedPurchaseToken ? { linkedPurchaseToken: input.linkedPurchaseToken } : {}),
    ...(state === 'SUBSCRIPTION_STATE_PAUSED' && input.autoResumeTimeMs !== undefined ? { pausedStateContext: { autoResumeTime: iso(input.autoResumeTimeMs) } } : {}),
    ...(state === 'SUBSCRIPTION_STATE_CANCELED' ? { canceledStateContext: { userInitiatedCancellation: { cancelTime: iso(Date.now()) } } } : {}),
    ...(input.test ? { testPurchase: {} } : {}),
    acknowledgementState: input.acknowledged ? 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' : 'ACKNOWLEDGEMENT_STATE_PENDING',
    ...(input.accountRef ? { externalAccountIdentifiers: { obfuscatedExternalAccountId: input.accountRef } } : {}),
    ...(input.outOfApp
      ? {
          outOfAppPurchaseContext: {
            ...(input.outOfApp.expiredPurchaseToken ? { expiredPurchaseToken: input.outOfApp.expiredPurchaseToken } : {}),
            ...(input.outOfApp.accountRef ? { expiredExternalAccountIdentifiers: { obfuscatedExternalAccountId: input.outOfApp.accountRef } } : {}),
          },
        }
      : {}),
  };
}

export interface PlayProductInput {
  productId: string;
  /** PURCHASED (default), PENDING or CANCELLED. */
  state?: 'PURCHASED' | 'PENDING' | 'CANCELLED' | undefined;
  quantity?: number | undefined;
  refundableQuantity?: number | undefined;
  consumed?: boolean | undefined;
  acknowledged?: boolean | undefined;
  accountRef?: string | undefined;
  orderId?: string | undefined;
  completedAtMs?: number | undefined;
  regionCode?: string | undefined;
  test?: boolean | undefined;
}

/** A `ProductPurchaseV2` as `purchases.productsv2.getproductpurchasev2` returns it. */
export function playProductResource(input: PlayProductInput): Record<string, unknown> {
  const state = input.state ?? 'PURCHASED';
  const quantity = input.quantity ?? 1;
  return {
    kind: 'androidpublisher#productPurchaseV2',
    productLineItem: [
      {
        productId: input.productId,
        productOfferDetails: {
          offerTags: [],
          purchaseOptionId: 'buy',
          quantity,
          refundableQuantity: input.refundableQuantity ?? quantity,
          consumptionState: input.consumed ? 'CONSUMPTION_STATE_CONSUMED' : 'CONSUMPTION_STATE_YET_TO_BE_CONSUMED',
        },
      },
    ],
    purchaseStateContext: { purchaseState: state },
    ...(input.test ? { testPurchaseContext: { fopType: 'TEST' } } : {}),
    orderId: input.orderId ?? `GPA.${randomDigits(4)}-${randomDigits(4)}-${randomDigits(4)}-${randomDigits(5)}`,
    ...(input.accountRef ? { obfuscatedExternalAccountId: input.accountRef } : {}),
    regionCode: input.regionCode ?? 'DE',
    ...(state === 'PENDING' ? {} : { purchaseCompletionTime: iso(input.completedAtMs ?? Date.now()) }),
    acknowledgementState: input.acknowledged || input.consumed ? 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' : 'ACKNOWLEDGEMENT_STATE_PENDING',
  };
}

function randomDigits(n: number): string {
  let out = '';
  for (const b of randomBytes(n)) out += String(b % 10);
  return out;
}

export type FakePlayRoute =
  | 'token'
  | 'certs'
  | 'subscriptionsv2.get'
  | 'productsv2.get'
  | 'subscriptions.acknowledge'
  | 'products.acknowledge'
  | 'products.consume'
  | 'subscriptionsv2.revoke'
  | 'orders.refund'
  | 'voidedpurchases.list';

export interface FakePlayCall {
  route: FakePlayRoute;
  /** The purchase token or order id the call named. */
  subject?: string | undefined;
  query?: Record<string, string> | undefined;
  body?: unknown;
}

interface Failure {
  route: FakePlayRoute;
  status: number;
  times: number;
  retryAfter?: number | undefined;
  /** Hang up instead of answering (a network error). */
  drop?: boolean | undefined;
}

const GOOGLE_ERROR = (code: number, status: string, reason: string, message: string) => ({ error: { code, message, status, errors: [{ message, domain: 'global', reason }] } });

export class FakeGooglePlay {
  readonly packageName: string;
  /** Resources by purchase token. */
  readonly subscriptions = new Map<string, Record<string, unknown>>();
  readonly products = new Map<string, Record<string, unknown>>();
  /** Voided purchases, as `voidedpurchases.list` returns them (times as decimal strings). */
  readonly voided: Record<string, unknown>[] = [];
  readonly calls: FakePlayCall[] = [];
  readonly account: GoogleServiceAccountKey;
  private readonly accountPublicPem: string;
  private readonly failures: Failure[] = [];
  private readonly accessTokens = new Set<string>();
  private readonly oidcKid = `kid-${randomBytes(4).toString('hex')}`;
  private oidcKey: { private: CryptoKey; jwk: JWK } | undefined;
  private server: Server | undefined;
  private base = '';

  constructor(options: { packageName?: string } = {}) {
    this.packageName = options.packageName ?? 'com.example.app';
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.account = {
      clientEmail: 'play-api@example-project.iam.gserviceaccount.com',
      privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      privateKeyId: randomBytes(8).toString('hex'),
    };
    this.accountPublicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  get url(): string {
    if (!this.base) throw new Error('FakeGooglePlay is not started');
    return this.base;
  }

  get tokenUrl(): string {
    return `${this.url}/token`;
  }

  get jwksUrl(): string {
    return `${this.url}/oauth2/v3/certs`;
  }

  async start(): Promise<this> {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKey = await importPKCS8(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'RS256');
    const jwk = await exportJWK(await importSPKI(pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), 'RS256', { extractable: true }));
    this.oidcKey = { private: privateKey, jwk: { ...jwk, kid: this.oidcKid, alg: 'RS256', use: 'sig' } };
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** A Developer API client pointed at this fake (no waits between retries). */
  api(options: Partial<PlayDeveloperApiOptions> = {}): PlayDeveloperApi {
    return new PlayDeveloperApi({
      packageName: this.packageName,
      account: this.account,
      apiBase: this.url,
      tokenUrl: this.tokenUrl,
      sleep: () => Promise.resolve(),
      ...options,
    });
  }

  putSubscription(token: string, input: PlaySubscriptionInput): Record<string, unknown> {
    const resource = playSubscriptionResource(input);
    this.subscriptions.set(token, resource);
    return resource;
  }

  putProduct(token: string, input: PlayProductInput): Record<string, unknown> {
    const resource = playProductResource(input);
    this.products.set(token, resource);
    return resource;
  }

  /** Calls of one route (all calls without one); the token exchange and the key set are routes too. */
  count(route?: FakePlayRoute): number {
    return route ? this.calls.filter((c) => c.route === route).length : this.calls.length;
  }

  /** Developer API calls only (not the token exchange, not the key set). */
  apiCalls(): number {
    return this.calls.filter((c) => c.route !== 'token' && c.route !== 'certs').length;
  }

  reset(): void {
    this.calls.length = 0;
    this.failures.length = 0;
  }

  /** The next `times` calls of a route answer `status` (or hang up with `drop`). */
  failNext(route: FakePlayRoute, status: number, options: { times?: number; retryAfter?: number; drop?: boolean } = {}): void {
    this.failures.push({ route, status, times: options.times ?? 1, retryAfter: options.retryAfter, drop: options.drop });
  }

  /** Every access token issued so far is refused (401) from now on. */
  expireAccessTokens(): void {
    this.accessTokens.clear();
  }

  /** A voided purchase entry (refund, chargeback) the list returns. */
  addVoided(entry: { purchaseToken: string; orderId: string; voidedTimeMs?: number; purchaseTimeMs?: number; voidedSource?: number; voidedReason?: number; voidedQuantity?: number; subscription?: boolean }): void {
    this.voided.push({
      kind: 'androidpublisher#voidedPurchase',
      purchaseToken: entry.purchaseToken,
      purchaseTimeMillis: String(entry.purchaseTimeMs ?? Date.now() - 86_400_000),
      voidedTimeMillis: String(entry.voidedTimeMs ?? Date.now()),
      orderId: entry.orderId,
      voidedSource: entry.voidedSource ?? 0,
      voidedReason: entry.voidedReason ?? 1,
      ...(entry.voidedQuantity !== undefined ? { voidedQuantity: entry.voidedQuantity } : {}),
      // Not a field of Google's entry: which list type returns it.
      _subscription: entry.subscription ?? this.subscriptions.has(entry.purchaseToken),
    });
  }

  /** A Pub/Sub push token signed with this fake's key (Google's claims by default). */
  async pushToken(claims: { audience: string; email: string; emailVerified?: boolean | string | undefined; issuer?: string; expiresInSeconds?: number; issuedAtMs?: number; kid?: string; omitEmail?: boolean }): Promise<string> {
    if (!this.oidcKey) throw new Error('FakeGooglePlay is not started');
    const iat = Math.floor((claims.issuedAtMs ?? Date.now()) / 1_000);
    const payload: Record<string, unknown> = {
      azp: '1234567890',
      sub: '1234567890',
      email_verified: claims.emailVerified ?? true,
      ...(claims.omitEmail ? {} : { email: claims.email }),
    };
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: claims.kid ?? this.oidcKid })
      .setIssuer(claims.issuer ?? 'https://accounts.google.com')
      .setAudience(claims.audience)
      .setIssuedAt(iat)
      .setExpirationTime(iat + (claims.expiresInSeconds ?? 3_600))
      .sign(this.oidcKey.private);
  }

  /** The base64 `data` of a push for a notification object. */
  static data(notification: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(notification)).toString('base64');
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://fake');
    const text = await readBody(request);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=UTF-8', ...headers }).end(body === undefined ? '' : JSON.stringify(body));
    };
    const fail = (route: FakePlayRoute): boolean => {
      const failure = this.failures.find((f) => f.route === route && f.times > 0);
      if (!failure) return false;
      failure.times -= 1;
      if (failure.drop) {
        request.socket.destroy();
        return true;
      }
      const statusName = failure.status === 429 ? 'RESOURCE_EXHAUSTED' : failure.status >= 500 ? 'UNAVAILABLE' : failure.status === 403 ? 'PERMISSION_DENIED' : 'INVALID_ARGUMENT';
      json(failure.status, GOOGLE_ERROR(failure.status, statusName, statusName === 'INVALID_ARGUMENT' ? 'invalid' : 'backendError', 'Injected failure'), failure.retryAfter ? { 'retry-after': String(failure.retryAfter) } : {});
      return true;
    };

    if (request.method === 'POST' && url.pathname === '/token') {
      this.calls.push({ route: 'token' });
      if (fail('token')) return;
      const form = new URLSearchParams(text);
      if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') return json(400, { error: 'unsupported_grant_type' });
      try {
        const { payload } = await jwtVerify(form.get('assertion') ?? '', await importSPKI(this.accountPublicPem, 'RS256'), {
          issuer: this.account.clientEmail,
          audience: this.tokenUrl,
          algorithms: ['RS256'],
        });
        if (payload['scope'] !== ANDROID_PUBLISHER_SCOPE) return json(400, { error: 'invalid_scope' });
      } catch {
        return json(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
      }
      const token = `ya29.fake-${randomBytes(12).toString('hex')}`;
      this.accessTokens.add(token);
      return json(200, { access_token: token, expires_in: 3599, token_type: 'Bearer' });
    }

    if (request.method === 'GET' && url.pathname === '/oauth2/v3/certs') {
      this.calls.push({ route: 'certs' });
      if (fail('certs')) return;
      return json(200, { keys: [this.oidcKey!.jwk] });
    }

    const prefix = /^\/androidpublisher\/v3\/applications\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (!prefix) return json(404, GOOGLE_ERROR(404, 'NOT_FOUND', 'notFound', 'Not Found'));
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
    if (!bearer || !this.accessTokens.has(bearer)) return json(401, GOOGLE_ERROR(401, 'UNAUTHENTICATED', 'authError', 'Invalid Credentials'));
    const pkg = decodeURIComponent(prefix[1]!);
    const rest = prefix[2]!;
    const invalid = () => json(400, GOOGLE_ERROR(400, 'INVALID_ARGUMENT', 'invalid', 'Invalid Value'));
    const route = (name: FakePlayRoute, subject?: string) => {
      this.calls.push({ route: name, subject, query: Object.fromEntries(url.searchParams), body: text ? (JSON.parse(text) as unknown) : undefined });
      return !fail(name);
    };
    const own = pkg === this.packageName;
    let m: RegExpExecArray | null;

    if ((m = /^\/purchases\/subscriptionsv2\/tokens\/([^/:]+)$/.exec(rest)) && request.method === 'GET') {
      const token = decodeURIComponent(m[1]!);
      if (!route('subscriptionsv2.get', token)) return;
      const resource = own ? this.subscriptions.get(token) : undefined;
      return resource ? json(200, resource) : invalid();
    }
    if ((m = /^\/purchases\/productsv2\/tokens\/([^/:]+)$/.exec(rest)) && request.method === 'GET') {
      const token = decodeURIComponent(m[1]!);
      if (!route('productsv2.get', token)) return;
      const resource = own ? this.products.get(token) : undefined;
      return resource ? json(200, resource) : invalid();
    }
    if ((m = /^\/purchases\/subscriptions\/([^/:]+)\/tokens\/([^/:]+):acknowledge$/.exec(rest)) && request.method === 'POST') {
      const token = decodeURIComponent(m[2]!);
      if (!route('subscriptions.acknowledge', token)) return;
      const resource = own ? this.subscriptions.get(token) : undefined;
      if (!resource) return invalid();
      if (resource['acknowledgementState'] === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED') return json(400, GOOGLE_ERROR(400, 'FAILED_PRECONDITION', 'invalidPurchaseState', 'The purchase is not in a valid state to perform the desired operation.'));
      resource['acknowledgementState'] = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
      return json(200, undefined);
    }
    if ((m = /^\/purchases\/products\/([^/:]+)\/tokens\/([^/:]+):(acknowledge|consume)$/.exec(rest)) && request.method === 'POST') {
      const token = decodeURIComponent(m[2]!);
      const consume = m[3] === 'consume';
      if (!route(consume ? 'products.consume' : 'products.acknowledge', token)) return;
      const resource = own ? this.products.get(token) : undefined;
      if (!resource) return invalid();
      const line = (resource['productLineItem'] as { productOfferDetails: Record<string, unknown> }[])[0]!;
      if (consume) {
        if (line.productOfferDetails['consumptionState'] === 'CONSUMPTION_STATE_CONSUMED') return json(400, GOOGLE_ERROR(400, 'FAILED_PRECONDITION', 'invalidPurchaseState', 'The purchase is not in a valid state to perform the desired operation.'));
        line.productOfferDetails['consumptionState'] = 'CONSUMPTION_STATE_CONSUMED';
      } else if (resource['acknowledgementState'] === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED') {
        return json(400, GOOGLE_ERROR(400, 'FAILED_PRECONDITION', 'invalidPurchaseState', 'The purchase is not in a valid state to perform the desired operation.'));
      }
      resource['acknowledgementState'] = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
      return json(200, undefined);
    }
    if ((m = /^\/purchases\/subscriptionsv2\/tokens\/([^/:]+):revoke$/.exec(rest)) && request.method === 'POST') {
      const token = decodeURIComponent(m[1]!);
      if (!route('subscriptionsv2.revoke', token)) return;
      const resource = own ? this.subscriptions.get(token) : undefined;
      const context = (text ? (JSON.parse(text) as { revocationContext?: Record<string, unknown> }) : {}).revocationContext;
      if (!resource || !context || Object.keys(context).length !== 1) return invalid();
      if (resource['subscriptionState'] === 'SUBSCRIPTION_STATE_EXPIRED') return json(400, GOOGLE_ERROR(400, 'FAILED_PRECONDITION', 'invalidPurchaseState', 'The subscription is not active.'));
      resource['subscriptionState'] = 'SUBSCRIPTION_STATE_EXPIRED';
      const item = (resource['lineItems'] as Record<string, unknown>[])[0]!;
      item['expiryTime'] = iso(Date.now());
      this.addVoided({ purchaseToken: token, orderId: typeof item['latestSuccessfulOrderId'] === 'string' ? item['latestSuccessfulOrderId'] : 'none', voidedSource: 1, voidedReason: 0, subscription: true });
      return json(200, undefined);
    }
    if ((m = /^\/orders\/([^/:]+):refund$/.exec(rest)) && request.method === 'POST') {
      const orderId = decodeURIComponent(m[1]!);
      if (!route('orders.refund', orderId)) return;
      const entry = own ? [...this.products.entries()].find(([, r]) => r['orderId'] === orderId) : undefined;
      if (!entry) return invalid();
      const line = (entry[1]['productLineItem'] as { productOfferDetails: Record<string, unknown> }[])[0]!;
      if (line.productOfferDetails['refundableQuantity'] === 0) return json(400, GOOGLE_ERROR(400, 'FAILED_PRECONDITION', 'orderNotRefundable', 'The order is already refunded.'));
      line.productOfferDetails['refundableQuantity'] = 0;
      this.addVoided({ purchaseToken: entry[0], orderId, voidedSource: 1, voidedReason: 0, subscription: false });
      return json(200, undefined);
    }
    if (rest === '/purchases/voidedpurchases' && request.method === 'GET') {
      if (!route('voidedpurchases.list')) return;
      const q = url.searchParams;
      const includeSubs = q.get('type') === '1';
      // A page token carries the first page's window (Google ignores the times once a token is given).
      const page0 = q.get('token')?.split('.').map(Number);
      const offset = page0 ? page0[0]! : 0;
      const start = page0 ? page0[1]! : Number(q.get('startTime') ?? Date.now() - 30 * 86_400_000);
      const end = page0 ? page0[2]! : Number(q.get('endTime') ?? Date.now());
      const size = Math.min(1_000, Number(q.get('maxResults') ?? 1_000));
      const all = (own ? this.voided : []).filter((v) => (includeSubs || !v['_subscription']) && Number(v['voidedTimeMillis']) >= start && Number(v['voidedTimeMillis']) <= end);
      const page = all.slice(offset, offset + size).map(({ _subscription: _s, ...v }) => v);
      const next = offset + size < all.length ? `${offset + size}.${start}.${end}` : undefined;
      return json(200, {
        pageInfo: { totalResults: all.length, resultPerPage: size, startIndex: offset },
        ...(next ? { tokenPagination: { nextPageToken: next } } : {}),
        voidedPurchases: page,
      });
    }
    return json(404, GOOGLE_ERROR(404, 'NOT_FOUND', 'notFound', 'Not Found'));
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
