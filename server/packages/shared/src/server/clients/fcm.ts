import { importPKCS8, SignJWT, type CryptoKey } from 'jose';
import type { PushPayload } from '../../push.js';
import { bodySnippet, defaultFetch, fetchWithTimeout, isRetryableStatus, type Fetch } from './http.js';

/**
 * Firebase Cloud Messaging, HTTP v1, for Android devices of both store
 * builds. Credentials are server configuration only (a service account),
 * never in the app. The service account signs a JWT that is exchanged for a
 * short-lived OAuth token, cached until a minute before it expires, so the
 * whole Firebase SDK is not needed.
 *
 * A send never throws: push is best effort and must not fail the work that
 * caused it. The outcome says whether the token is dead (disable the device)
 * or the failure is worth a retry.
 */

export interface FcmServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  privateKeyId?: string | undefined;
}

export interface PushOutcome {
  ok: boolean;
  /** The device's token is no longer valid: clear it instead of retrying. */
  unregistered: boolean;
  /** A later retry may succeed (429, 5xx, network). */
  retryable: boolean;
  /** Seconds the provider asked to wait, when it said. */
  retryAfterSeconds?: number | undefined;
  status: number;
  /** Provider error text, cut short; never contains the token. */
  error?: string | undefined;
  /** FCM's message name on success. */
  messageId?: string | undefined;
}

export interface PushSender {
  send(deviceToken: string, payload: PushPayload): Promise<PushOutcome>;
}

/**
 * Reads `FCM_SERVICE_ACCOUNT_JSON` (the JSON itself, or its base64), with
 * `FCM_PROJECT_ID` overriding the project. Returns null when push is not
 * configured, which is a valid state (development); throws on a value that is
 * present but unusable, naming the problem, never the value.
 */
export function parseServiceAccount(json: string | undefined, projectId?: string): FcmServiceAccount | null {
  const raw = json?.trim();
  if (!raw) return null;
  let parsed: Record<string, unknown>;
  try {
    const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON is not service-account JSON');
  }
  const email = parsed['client_email'];
  const key = parsed['private_key'];
  const project = projectId?.trim() || parsed['project_id'];
  if (typeof email !== 'string' || typeof key !== 'string' || typeof project !== 'string' || !project) {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON lacks client_email, private_key or project_id');
  }
  const keyId = parsed['private_key_id'];
  return {
    projectId: project,
    clientEmail: email,
    privateKey: key.includes('\\n') ? key.replaceAll('\\n', '\n') : key,
    privateKeyId: typeof keyId === 'string' ? keyId : undefined,
  };
}

export interface FcmOptions {
  account: FcmServiceAccount;
  fetch?: Fetch | undefined;
  tokenUrl?: string | undefined;
  /** `https://fcm.googleapis.com` unless a test points it elsewhere. */
  apiBase?: string | undefined;
  timeoutMs?: number | undefined;
  now?: (() => number) | undefined;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** The FCM v1 `message` for one device. Exported for tests. */
export function fcmMessage(deviceToken: string, payload: PushPayload): Record<string, unknown> {
  const android: Record<string, unknown> = {
    priority: payload.priority === 'high' ? 'HIGH' : 'NORMAL',
    ttl: `${payload.ttlSeconds}s`,
  };
  if (payload.collapseKey !== undefined) android['collapse_key'] = payload.collapseKey;
  if (payload.kind === 'notification') {
    const notification: Record<string, unknown> = {
      title: payload.title,
      body: payload.body,
      sound: 'default',
    };
    if (payload.channel !== undefined) notification['channel_id'] = payload.channel;
    if (payload.tag !== undefined) notification['tag'] = payload.tag;
    if (payload.visibility === 'private') notification['visibility'] = 'PRIVATE';
    android['notification'] = notification;
  }
  return { message: { token: deviceToken, data: payload.data, android } };
}

export class FcmSender implements PushSender {
  private readonly account: FcmServiceAccount;
  private readonly fetch: Fetch;
  private readonly tokenUrl: string;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private signingKey: Promise<CryptoKey> | undefined;
  private accessToken: { value: string; expiresAtMs: number } | undefined;
  private pendingToken: Promise<string> | undefined;

  constructor(options: FcmOptions) {
    this.account = options.account;
    this.fetch = options.fetch ?? defaultFetch;
    this.tokenUrl = options.tokenUrl ?? TOKEN_URL;
    this.apiBase = (options.apiBase ?? 'https://fcm.googleapis.com').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  private async token(): Promise<string> {
    const cached = this.accessToken;
    if (cached && cached.expiresAtMs - 60_000 > this.now()) return cached.value;
    this.pendingToken ??= this.exchange().finally(() => {
      this.pendingToken = undefined;
    });
    return this.pendingToken;
  }

  private async exchange(): Promise<string> {
    this.signingKey ??= importPKCS8(this.account.privateKey, 'RS256');
    const key = await this.signingKey;
    const nowSeconds = Math.floor(this.now() / 1_000);
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', ...(this.account.privateKeyId ? { kid: this.account.privateKeyId } : {}) })
      .setIssuer(this.account.clientEmail)
      .setSubject(this.account.clientEmail)
      .setAudience(this.tokenUrl)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 3_600)
      .sign(key);
    const response = await fetchWithTimeout(
      this.fetch,
      this.tokenUrl,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      },
      this.timeoutMs,
    );
    // The error body may echo the assertion: only the status goes into the message.
    if (!response.ok) throw new Error(`token exchange answered ${response.status}`);
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') throw new Error('token exchange gave no access token');
    const lifetime = typeof body.expires_in === 'number' ? body.expires_in : 3_600;
    this.accessToken = { value: body.access_token, expiresAtMs: this.now() + lifetime * 1_000 };
    return body.access_token;
  }

  async send(deviceToken: string, payload: PushPayload): Promise<PushOutcome> {
    let access: string;
    try {
      access = await this.token();
    } catch (error) {
      return { ok: false, unregistered: false, retryable: true, status: 0, error: errorText(error) };
    }
    let response: Response;
    try {
      response = await fetchWithTimeout(
        this.fetch,
        `${this.apiBase}/v1/projects/${encodeURIComponent(this.account.projectId)}/messages:send`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
          body: JSON.stringify(fcmMessage(deviceToken, payload)),
        },
        this.timeoutMs,
      );
    } catch (error) {
      return { ok: false, unregistered: false, retryable: true, status: 0, error: errorText(error) };
    }
    if (response.ok) {
      const body = (await response.json().catch(() => ({}))) as { name?: unknown };
      return { ok: true, unregistered: false, retryable: false, status: response.status, messageId: typeof body.name === 'string' ? body.name : undefined };
    }
    if (response.status === 401) this.accessToken = undefined;
    const text = await bodySnippet(response, 2_000);
    const retryAfter = Number(response.headers.get('retry-after'));
    return {
      ok: false,
      unregistered: isDeadToken(response.status, text),
      retryable: isRetryableStatus(response.status) || response.status === 401,
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      status: response.status,
      error: text.replaceAll(deviceToken, '<token>').slice(0, 300),
    };
  }
}

/**
 * The token is of no use any more: 404 / UNREGISTERED (the app was removed or
 * the token rotated), SENDER_ID_MISMATCH (the token belongs to another
 * Firebase project, so this sender can never reach it), or a 400 that names
 * the registration token itself.
 */
function isDeadToken(status: number, body: string): boolean {
  const code = fcmErrorCode(body);
  if (status === 404 || code === 'UNREGISTERED' || code === 'SENDER_ID_MISMATCH') return true;
  return status === 400 && body.includes('INVALID_ARGUMENT') && /registration token/i.test(body);
}

/** FCM's own error code (`error.details[].errorCode`), when the body says it. */
function fcmErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { details?: { errorCode?: unknown }[] } };
    const code = parsed.error?.details?.find((d) => typeof d?.errorCode === 'string')?.errorCode;
    if (typeof code === 'string') return code;
  } catch {
    // Not JSON (a proxy's page): only the status decides.
  }
  return body.includes('UNREGISTERED') ? 'UNREGISTERED' : undefined;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/** Records pushes instead of sending them. Tokens in `deadTokens` answer as unregistered. */
export class FakePushSender implements PushSender {
  readonly sent: { token: string; payload: PushPayload }[] = [];
  readonly deadTokens = new Set<string>();
  /** When set, every send fails this way (retryable). */
  failing = false;

  async send(deviceToken: string, payload: PushPayload): Promise<PushOutcome> {
    if (this.deadTokens.has(deviceToken)) return { ok: false, unregistered: true, retryable: false, status: 404 };
    if (this.failing) return { ok: false, unregistered: false, retryable: true, status: 503, error: 'unavailable' };
    this.sent.push({ token: deviceToken, payload });
    return { ok: true, unregistered: false, retryable: false, status: 200, messageId: `fake/${this.sent.length}` };
  }
}

/** How the FCM fake answers sends to one token. */
export type FcmFakeAnswer = 'ok' | 'unregistered' | 'sender_mismatch' | 'unavailable' | 'invalid_token';

export interface FcmFakeRequest {
  token: string;
  /** The FCM v1 request body as sent. */
  body: { message: { token: string; data?: Record<string, string>; android?: Record<string, unknown> } };
  /** Order of arrival and of completion (an answer held back finishes later). */
  arrived: number;
  answered?: number | undefined;
}

/**
 * FCM's HTTP v1 endpoint and Google's token endpoint, in process, for an
 * `FcmSender` built with its `fetch`: every send is recorded in arrival
 * order, answered per token (`answers`, once or always), and may be held
 * back (`hold`) to put a message in flight.
 */
export class FcmEndpointFake {
  readonly requests: FcmFakeRequest[] = [];
  /** Token exchanges seen. */
  tokenExchanges = 0;
  private readonly answers = new Map<string, FcmFakeAnswer[]>();
  private readonly always = new Map<string, FcmFakeAnswer>();
  private readonly held: { match: (r: FcmFakeRequest) => boolean; release: Promise<void> }[] = [];
  private tick = 0;

  /** The next sends to `token` answer these, in turn; then `ok` (or what `always` says). */
  answer(token: string, ...answers: FcmFakeAnswer[]): void {
    this.answers.set(token, [...(this.answers.get(token) ?? []), ...answers]);
  }

  /** Every send to `token` answers this. */
  answerAlways(token: string, answer: FcmFakeAnswer): void {
    this.always.set(token, answer);
  }

  /** Holds the answers of matching sends until the returned function is called. */
  hold(match: (r: FcmFakeRequest) => boolean): () => void {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    this.held.push({ match, release: promise });
    return release;
  }

  /** The sends of one push type (its `data.type`). */
  ofType(type: string): FcmFakeRequest[] {
    return this.requests.filter((r) => r.body.message.data?.['type'] === type);
  }

  readonly fetch: Fetch = async (input, init = {}) => {
    const url = String(input);
    if (!url.includes('/messages:send')) {
      this.tokenExchanges += 1;
      return Response.json({ access_token: 'fake-access-token', expires_in: 3_600 });
    }
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as FcmFakeRequest['body'];
    const request: FcmFakeRequest = { token: body.message.token, body, arrived: ++this.tick };
    this.requests.push(request);
    for (const h of this.held) if (h.match(request)) await h.release;
    request.answered = ++this.tick;
    const queued = this.answers.get(request.token);
    const answer = queued?.shift() ?? this.always.get(request.token) ?? 'ok';
    switch (answer) {
      case 'ok':
        return Response.json({ name: `projects/fake/messages/${request.arrived}` });
      case 'unregistered':
        return new Response('{"error":{"code":404,"status":"NOT_FOUND","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}', { status: 404 });
      case 'sender_mismatch':
        return new Response('{"error":{"code":403,"status":"PERMISSION_DENIED","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"SENDER_ID_MISMATCH"}]}}', { status: 403 });
      case 'invalid_token':
        return new Response(`{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"The registration token is not a valid FCM registration token"}}`, { status: 400 });
      case 'unavailable':
        return new Response('{"error":{"code":503,"status":"UNAVAILABLE"}}', { status: 503, headers: { 'retry-after': '5' } });
    }
  };
}
