import { sign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Fetch } from '../http.js';

/**
 * A stand-in for Bazaar's developer API in tests and simulations: the
 * documented paths, methods, headers, bodies and error answers of
 * pardakht v2, over state kept in memory. The same handler serves an
 * in-process `fetch` (no sockets; the real client runs unchanged) and a
 * local HTTP server. Every request is recorded with its time.
 */

export interface FakeInapp {
  productId: string;
  developerPayload: string | null;
  purchaseTimeMs: number;
  consumed: boolean;
  refunded: boolean;
  /** The Bazaar account that bought it (active-subscriptions lists per account). */
  account: string;
}

export interface FakeSubscription {
  sku: string;
  startedAtMs: number;
  validUntilMs: number;
  autoRenewing: boolean;
  /** linkedSubscriptionToken: one value per subscription, the same across renewals. */
  chainToken: string;
  account: string;
}

export type FakePardakhtOperation = 'inapp' | 'subscription' | 'active' | 'consume' | 'refund' | 'cancel' | 'token' | 'unknown';

export interface FakePardakhtRequest {
  method: string;
  operation: FakePardakhtOperation;
  path: string;
  atMs: number;
  /** The credential the request carried (`pishkhan:<token>` or `bearer:<token>`), for header checks. */
  credential: string | null;
}

export interface FakePardakhtReply {
  status: number;
  body: unknown;
  headers?: Record<string, string> | undefined;
}

export interface FakePardakhtOptions {
  packageName: string;
  /** The Pishkhan API token the fake accepts. */
  pishkhanToken?: string | undefined;
  /** The OAuth client the fake accepts at `/auth/token/`. */
  oauth?: { clientId: string; clientSecret: string; refreshToken: string } | undefined;
  now?: (() => number) | undefined;
}

const NOT_FOUND_PURCHASE = { error: 'not_found', error_description: 'The requested purchase is not found!' };
const NOT_FOUND_SUBSCRIPTION = { error: 'not_found', error_description: 'The requested subscription is not found!' };
const BAD_PACKAGE = { error: 'invalid_value', error_description: 'Package name is invalid' };

function reply(status: number, body: unknown, headers?: Record<string, string>): FakePardakhtReply {
  return { status, body, headers };
}

export class FakePardakht {
  readonly inapp = new Map<string, FakeInapp>();
  readonly subscriptions = new Map<string, FakeSubscription>();
  readonly requests: FakePardakhtRequest[] = [];
  /** The next requests get these answers instead (an outage, a 429, the quota), in order. */
  readonly forced: FakePardakhtReply[] = [];
  /** While true, the HTTP server never answers (timeouts). */
  stall = false;
  /** When set, the subscription status endpoint answers `not_found` for tokens that are not the subscription's first (one reading of the docs). */
  statusNeedsInitialToken = false;
  now: () => number;
  private readonly accessTokens = new Set<string>();
  private issued = 0;

  constructor(private readonly options: FakePardakhtOptions) {
    this.now = options.now ?? Date.now;
  }

  putInapp(token: string, p: Partial<FakeInapp> & Pick<FakeInapp, 'productId'>): this {
    this.inapp.set(token, { developerPayload: null, purchaseTimeMs: this.now(), consumed: false, refunded: false, account: 'account-1', ...p });
    return this;
  }

  putSubscription(token: string, s: Partial<FakeSubscription> & Pick<FakeSubscription, 'sku' | 'validUntilMs'>): this {
    this.subscriptions.set(token, { startedAtMs: this.now(), autoRenewing: true, chainToken: token, account: 'account-1', ...s });
    return this;
  }

  /** Bazaar charged the next period. */
  renew(token: string, validUntilMs: number): void {
    const s = this.subscriptions.get(token);
    if (s) s.validUntilMs = validUntilMs;
  }

  /** A refund: a one-time product is marked refunded; a subscription ends at once. */
  refund(token: string): void {
    const p = this.inapp.get(token);
    if (p) p.refunded = true;
    const s = this.subscriptions.get(token);
    if (s) {
      s.validUntilMs = Math.min(s.validUntilMs, this.now());
      s.autoRenewing = false;
    }
  }

  count(operation?: FakePardakhtOperation): number {
    return operation ? this.requests.filter((r) => r.operation === operation).length : this.requests.length;
  }

  private credential(headers: Record<string, string | undefined>): string | null {
    const pishkhan = headers['cafebazaar-pishkhan-api-secret'];
    if (pishkhan) return `pishkhan:${pishkhan}`;
    const auth = headers['authorization'];
    if (auth?.startsWith('Bearer ')) return `bearer:${auth.slice(7)}`;
    return null;
  }

  private authorised(credential: string | null): boolean {
    if (credential === null) return false;
    if (credential.startsWith('pishkhan:')) return this.options.pishkhanToken !== undefined && credential === `pishkhan:${this.options.pishkhanToken}`;
    return this.accessTokens.has(credential.slice('bearer:'.length));
  }

  /** One request: `path` is the URL's path, `/devapi/v2/...`. */
  handle(method: string, path: string, headers: Record<string, string | undefined>, body: string): FakePardakhtReply {
    const parts = path.replace(/^\/devapi\/v2\//, '').replace(/\/+$/, '').split('/').map((p) => decodeURIComponent(p));
    const credential = this.credential(headers);
    const operation = this.operationOf(method, parts);
    this.requests.push({ method, operation, path, atMs: this.now(), credential });
    const forced = this.forced.shift();
    if (forced) return forced;
    if (operation === 'token') return this.token(body);
    if (!this.authorised(credential)) return reply(401, { error: 'invalid_credentials', error_description: 'Invalid credentials' });
    const pkg = parts[1] === 'validate' || parts[1] === 'consume' || parts[1] === 'refund' || parts[1] === 'applications' ? parts[2] : undefined;
    if (operation !== 'unknown' && pkg !== this.options.packageName) return reply(404, BAD_PACKAGE);
    const now = this.now();
    switch (operation) {
      case 'inapp': {
        const [, , , , product, , token] = parts;
        const p = this.inapp.get(token!);
        if (!p) return reply(404, NOT_FOUND_PURCHASE);
        if (p.productId !== product) return reply(404, { error: 'invalid_value', error_description: 'Product is not found' });
        return reply(200, {
          consumptionState: p.consumed ? 0 : 1,
          purchaseState: p.refunded ? 1 : 0,
          kind: 'androidpublisher#inappPurchase',
          developerPayload: p.developerPayload ?? '',
          purchaseTime: p.purchaseTimeMs,
        });
      }
      case 'subscription': {
        const [, , , , sku, , token] = parts;
        const s = this.subscriptions.get(token!);
        if (!s || s.sku !== sku || (this.statusNeedsInitialToken && s.chainToken !== token)) return reply(404, NOT_FOUND_SUBSCRIPTION);
        return reply(200, this.subscriptionBody(s));
      }
      case 'cancel': {
        const [, , , , sku, , token] = parts;
        const s = this.subscriptions.get(token!);
        if (!s || s.sku !== sku) return reply(404, NOT_FOUND_SUBSCRIPTION);
        if (s.validUntilMs <= now) return reply(400, { error: 'invalud_value', error_description: 'Subscription has been expired' });
        if (!s.autoRenewing) return reply(400, { error: 'invalid_value', error_description: 'Subscription has been cancelled before' });
        s.autoRenewing = false;
        return reply(200, {});
      }
      case 'active': {
        const token = parts[4]!;
        const own = this.subscriptions.get(token) ?? this.inapp.get(token);
        if (!own) return reply(404, { error: 'not_found', error_description: 'token not found!' });
        const live = [...this.subscriptions.values()].filter((s) => s.account === own.account && s.validUntilMs > now);
        if (live.length === 0) return reply(404, { error: 'not_found', error_description: 'no subscription found!' });
        return reply(200, { subscriptions: live.map((s) => ({ ...this.subscriptionBody(s), sku: s.sku })) });
      }
      case 'consume': {
        let token: unknown;
        try {
          token = (JSON.parse(body) as { token?: unknown }).token;
        } catch {
          token = undefined;
        }
        if (typeof token !== 'string' || token.length === 0) return reply(404, { error: 'invalid_value', error_description: 'Invalid token!' });
        if (this.subscriptions.has(token)) return reply(400, { error: 'is_subscription', error_description: 'Can not consume subscription.' });
        const p = this.inapp.get(token);
        if (!p) return reply(404, NOT_FOUND_PURCHASE);
        if (p.refunded) return reply(400, { error: 'is_refunded', error_description: 'The purchase has been refunded.' });
        if (p.consumed) return reply(400, { error: 'already_consumed', error_description: 'The purchase has already been consumed.' });
        p.consumed = true;
        return reply(200, {});
      }
      case 'refund': {
        const token = parts[4]!;
        const p = this.inapp.get(token);
        if (!p) return reply(404, NOT_FOUND_PURCHASE);
        if (p.refunded) return reply(400, { error: 'bad_request', error_description: 'Previously Refunded' });
        p.refunded = true;
        return reply(200, { consumptionState: p.consumed ? 0 : 1, purchaseState: 1, kind: 'androidpublisher#inappPurchase', developerPayload: p.developerPayload ?? '', purchaseTime: p.purchaseTimeMs });
      }
      default:
        return reply(404, { error: 'not_found', error_description: 'Not found' });
    }
  }

  private subscriptionBody(s: FakeSubscription): Record<string, unknown> {
    return {
      kind: 'androidpublisher#subscriptionPurchase',
      initiationTimestampMsec: s.startedAtMs,
      validUntilTimestampMsec: s.validUntilMs,
      autoRenewing: s.autoRenewing,
      linkedSubscriptionToken: s.chainToken,
    };
  }

  private operationOf(method: string, parts: string[]): FakePardakhtOperation {
    if (method === 'POST' && parts[0] === 'auth' && parts[1] === 'token') return 'token';
    if (parts[0] !== 'api') return 'unknown';
    if (method === 'GET' && parts[1] === 'validate' && parts[3] === 'inapp' && parts[5] === 'purchases' && parts.length === 7) return 'inapp';
    if (method === 'GET' && parts[1] === 'applications' && parts[3] === 'subscriptions' && parts[5] === 'purchases' && parts.length === 7) return 'subscription';
    if (method === 'GET' && parts[1] === 'applications' && parts[3] === 'subscriptions' && parts[5] === 'purchases' && parts[7] === 'cancel' && parts.length === 8) return 'cancel';
    if (method === 'GET' && parts[1] === 'applications' && parts[3] === 'active-subscriptions' && parts.length === 5) return 'active';
    if (method === 'POST' && parts[1] === 'consume' && parts[3] === 'purchases' && parts.length === 4) return 'consume';
    if (method === 'POST' && parts[1] === 'refund' && parts[3] === 'purchases' && parts.length === 5) return 'refund';
    return 'unknown';
  }

  private token(body: string): FakePardakhtReply {
    const form = new URLSearchParams(body);
    const o = this.options.oauth;
    if (!o || form.get('grant_type') !== 'refresh_token' || form.get('client_id') !== o.clientId || form.get('client_secret') !== o.clientSecret || form.get('refresh_token') !== o.refreshToken) {
      return reply(401, { error: 'invalid_credentials', error_description: 'Invalid credentials' });
    }
    this.issued += 1;
    const access = `access-${this.issued}-${Math.random().toString(36).slice(2, 10)}`;
    this.accessTokens.add(access);
    return reply(200, { access_token: access, token_type: 'Bearer', expires_in: 3600, scope: 'androidpublisher' });
  }

  /** Forgets the access tokens issued so far (an expiry on Bazaar's side). */
  expireAccessTokens(): void {
    this.accessTokens.clear();
  }

  /** A `fetch` that answers from this fake in process; the base URL to give the client is `http://pardakht.fake/devapi/v2`. */
  readonly fetch: Fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const r = this.handle(init?.method ?? 'GET', url.pathname, headers, typeof init?.body === 'string' ? init.body : '');
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', ...r.headers } });
  };

  /** Serves the same answers over HTTP on 127.0.0.1; `url` is the base URL to give the client. */
  async listen(): Promise<{ url: string; close(): Promise<void> }> {
    const server: Server = createServer((request, response) => {
      void readBody(request).then((text) => {
        if (this.stall) return;
        const headers: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(request.headers)) headers[key] = Array.isArray(value) ? value.join(',') : value;
        const r = this.handle(request.method ?? 'GET', new URL(request.url ?? '/', 'http://local').pathname, headers, text);
        response.writeHead(r.status, { 'content-type': 'application/json', ...r.headers }).end(r.body === undefined ? '' : JSON.stringify(r.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/devapi/v2`,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export interface SignedBazaarPurchase {
  originalJson: string;
  signature: string;
}

/** What Poolakey hands the app for a purchase, signed with a test key (SHA1withRSA, base64). */
export function signBazaarPurchase(
  privateKey: KeyObject,
  data: { orderId?: string; purchaseToken: string; developerPayload: string; packageName: string; purchaseState?: number; purchaseTime: number; productId: string },
): SignedBazaarPurchase {
  const originalJson = JSON.stringify({
    orderId: data.orderId ?? `order-${data.purchaseToken.slice(0, 12)}`,
    purchaseToken: data.purchaseToken,
    developerPayload: data.developerPayload,
    packageName: data.packageName,
    purchaseState: data.purchaseState ?? 0,
    purchaseTime: data.purchaseTime,
    productId: data.productId,
  });
  return { originalJson, signature: sign('sha1', Buffer.from(originalJson, 'utf8'), privateKey).toString('base64') };
}
