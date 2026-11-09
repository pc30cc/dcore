import { createHash, createHmac } from 'node:crypto';
import { bodySnippet, defaultFetch, fetchWithTimeout, isRetryableStatus, ProviderError, type Fetch } from './http.js';

/**
 * S3-compatible object storage: presigned URLs for the phone's upload (a PUT
 * to the private bucket whose content type and length are part of the
 * signature) and signed requests for the server's own reads, writes and
 * deletes. AWS Signature Version 4, written out so any S3-compatible
 * provider works without the AWS SDK.
 */

export interface PresignedRequest {
  url: string;
  method: 'PUT' | 'GET';
  /** Headers the request must carry exactly (they are signed). */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface PresignPutInput {
  bucket: string;
  key: string;
  contentType: string;
  /** The exact size: S3 refuses a body of another length. */
  contentLength: number;
  expiresInSeconds: number;
}

export interface PresignGetInput {
  bucket: string;
  key: string;
  expiresInSeconds: number;
}

export interface StoredObjectInfo {
  size: number;
  contentType: string | null;
}

export interface ObjectStorage {
  presignPut(input: PresignPutInput): Promise<PresignedRequest>;
  presignGet(input: PresignGetInput): Promise<PresignedRequest>;
  headObject(bucket: string, key: string): Promise<StoredObjectInfo | null>;
  getObject(bucket: string, key: string): Promise<Uint8Array | null>;
  putObject(bucket: string, key: string, body: Uint8Array, options: { contentType: string; cacheControl?: string | undefined }): Promise<void>;
  /** Deleting a key that does not exist succeeds. */
  deleteObject(bucket: string, key: string): Promise<void>;
}

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
}

export interface S3Options {
  /** `https://s3.<region>.amazonaws.com` or a provider's endpoint: what presigned URLs name. */
  endpoint: string;
  /**
   * The same store as this server reaches it (an internal address such as `http://minio:9000`), for its own
   * HEAD, GET, PUT and DELETE; undefined: `endpoint`. Each request is signed for the host it goes to.
   */
  internalEndpoint?: string | undefined;
  region: string;
  credentials: S3Credentials;
  /** `endpoint/bucket/key` (default) or `bucket.endpoint/key`. */
  pathStyle?: boolean | undefined;
  fetch?: Fetch | undefined;
  timeoutMs?: number | undefined;
  now?: (() => Date) | undefined;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED = 'UNSIGNED-PAYLOAD';
const MAX_PRESIGN_SECONDS = 7 * 24 * 3_600;

/** RFC 3986 encoding as SigV4 wants it (`/` kept in paths). */
function encode(value: string, keepSlash = false): string {
  return [...new TextEncoder().encode(value)]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      if (/[A-Za-z0-9\-._~]/.test(char) || (keepSlash && char === '/')) return char;
      return `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function hexSha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function amzDate(date: Date): { stamp: string; day: string } {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { stamp, day: stamp.slice(0, 8) };
}

export interface SigningInput {
  method: string;
  /** Absolute URL without the signature parameters. */
  url: URL;
  /** Lowercase names; `host` is added from the URL. */
  headers: Record<string, string>;
  payloadHash: string;
  date: Date;
  region: string;
  service: string;
  credentials: S3Credentials;
}

function signingKey(secret: string, day: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), 'aws4_request');
}

function canonical(input: SigningInput, query: URLSearchParams): { request: string; signedHeaders: string } {
  const headers: Record<string, string> = { ...input.headers, host: input.url.host };
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const lowered = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names.map((name) => `${name}:${String(lowered[name]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const pairs = [...query.entries()].map(([k, v]) => [encode(k), encode(v)] as const);
  pairs.sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const canonicalQuery = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  // The URL's path is already percent-encoded once by the caller (see objectUrl).
  const request = [input.method, input.url.pathname, canonicalQuery, canonicalHeaders, signedHeaders, input.payloadHash].join('\n');
  return { request, signedHeaders };
}

function stringToSign(input: SigningInput, canonicalRequest: string): { text: string; scope: string } {
  const { stamp, day } = amzDate(input.date);
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  return { text: [ALGORITHM, stamp, scope, hexSha256(canonicalRequest)].join('\n'), scope };
}

/** A presigned URL (query-string authentication). Exported for the test vectors. */
export function presignUrl(input: SigningInput, expiresInSeconds: number): URL {
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > MAX_PRESIGN_SECONDS) {
    throw new RangeError('a presigned URL lives between 1 second and 7 days');
  }
  const { stamp, day } = amzDate(input.date);
  const query = new URLSearchParams(input.url.search);
  query.set('X-Amz-Algorithm', ALGORITHM);
  query.set('X-Amz-Credential', `${input.credentials.accessKeyId}/${day}/${input.region}/${input.service}/aws4_request`);
  query.set('X-Amz-Date', stamp);
  query.set('X-Amz-Expires', String(expiresInSeconds));
  if (input.credentials.sessionToken) query.set('X-Amz-Security-Token', input.credentials.sessionToken);
  const names = [...Object.keys(input.headers).map((n) => n.toLowerCase()), 'host'].sort();
  query.set('X-Amz-SignedHeaders', names.join(';'));
  const { request } = canonical(input, query);
  const { text } = stringToSign(input, request);
  const signature = hmac(signingKey(input.credentials.secretAccessKey, day, input.region, input.service), text).toString('hex');
  const url = new URL(input.url.toString());
  const pairs = [...query.entries(), ['X-Amz-Signature', signature] as const];
  url.search = pairs.map(([k, v]) => `${encode(k)}=${encode(v)}`).join('&');
  return url;
}

/** The `Authorization` header of a signed request. Exported for the test vectors. */
export function authorizationHeader(input: SigningInput): string {
  const { day } = amzDate(input.date);
  const { request, signedHeaders } = canonical(input, new URLSearchParams(input.url.search));
  const { text, scope } = stringToSign(input, request);
  const signature = hmac(signingKey(input.credentials.secretAccessKey, day, input.region, input.service), text).toString('hex');
  return `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const KEY = /^[A-Za-z0-9!_.*'()/-]{1,1024}$/;

export class S3Storage implements ObjectStorage {
  private readonly endpoint: URL;
  private readonly internalEndpoint: URL;
  private readonly region: string;
  private readonly credentials: S3Credentials;
  private readonly pathStyle: boolean;
  private readonly fetch: Fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(options: S3Options) {
    this.endpoint = new URL(options.endpoint);
    this.internalEndpoint = new URL(options.internalEndpoint ?? options.endpoint);
    this.region = options.region;
    this.credentials = options.credentials;
    this.pathStyle = options.pathStyle ?? true;
    this.fetch = options.fetch ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? (() => new Date());
  }

  /** The object's URL (on the internal endpoint with `internal`); keys are limited to safe characters, so nothing in them needs escaping twice. */
  objectUrl(bucket: string, key: string, internal = false): URL {
    if (!BUCKET.test(bucket)) throw new TypeError('not a bucket name');
    // `.` and `..` segments would be resolved away by URL normalisation (and the signature would name another path).
    const dotSegment = key.split('/').some((segment) => segment === '.' || segment === '..');
    if (!KEY.test(key) || key.includes('//') || key.startsWith('/') || dotSegment) throw new TypeError('not an object key this client writes');
    const url = new URL((internal ? this.internalEndpoint : this.endpoint).toString());
    const base = url.pathname.replace(/\/+$/, '');
    if (this.pathStyle) url.pathname = `${base}/${bucket}/${encode(key, true)}`;
    else {
      url.hostname = `${bucket}.${url.hostname}`;
      url.pathname = `${base}/${encode(key, true)}`;
    }
    return url;
  }

  private signing(method: string, url: URL, headers: Record<string, string>, payloadHash: string, date: Date): SigningInput {
    return { method, url, headers, payloadHash, date, region: this.region, service: 's3', credentials: this.credentials };
  }

  async presignPut(input: PresignPutInput): Promise<PresignedRequest> {
    if (!Number.isInteger(input.contentLength) || input.contentLength < 1) throw new RangeError('contentLength must be positive');
    const date = this.now();
    const headers = { 'content-length': String(input.contentLength), 'content-type': input.contentType };
    const url = presignUrl(this.signing('PUT', this.objectUrl(input.bucket, input.key), headers, UNSIGNED, date), input.expiresInSeconds);
    return {
      url: url.toString(),
      method: 'PUT',
      headers: { 'Content-Type': input.contentType, 'Content-Length': String(input.contentLength) },
      expiresAt: new Date(date.getTime() + input.expiresInSeconds * 1_000),
    };
  }

  async presignGet(input: PresignGetInput): Promise<PresignedRequest> {
    const date = this.now();
    const url = presignUrl(this.signing('GET', this.objectUrl(input.bucket, input.key), {}, UNSIGNED, date), input.expiresInSeconds);
    return { url: url.toString(), method: 'GET', headers: {}, expiresAt: new Date(date.getTime() + input.expiresInSeconds * 1_000) };
  }

  private async request(method: string, bucket: string, key: string, body?: Uint8Array, extra: Record<string, string> = {}): Promise<Response> {
    const url = this.objectUrl(bucket, key, true);
    const date = this.now();
    const payloadHash = hexSha256(body ?? new Uint8Array());
    const headers: Record<string, string> = { ...extra, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate(date).stamp };
    if (this.credentials.sessionToken) headers['x-amz-security-token'] = this.credentials.sessionToken;
    const authorization = authorizationHeader(this.signing(method, url, headers, payloadHash, date));
    try {
      return await fetchWithTimeout(
        this.fetch,
        url,
        { method, headers: { ...headers, authorization }, ...(body ? { body } : {}) },
        this.timeoutMs,
      );
    } catch (error) {
      throw new ProviderError('s3', `${method} unreachable`, { retryable: true, cause: error });
    }
  }

  private async fail(method: string, response: Response): Promise<never> {
    throw new ProviderError('s3', `${method} answered ${response.status}: ${await bodySnippet(response)}`, {
      status: response.status,
      retryable: isRetryableStatus(response.status),
    });
  }

  async headObject(bucket: string, key: string): Promise<StoredObjectInfo | null> {
    const response = await this.request('HEAD', bucket, key);
    if (response.status === 404) return null;
    if (!response.ok) return this.fail('HEAD', response);
    return { size: Number(response.headers.get('content-length') ?? 0), contentType: response.headers.get('content-type') };
  }

  async getObject(bucket: string, key: string): Promise<Uint8Array | null> {
    const response = await this.request('GET', bucket, key);
    if (response.status === 404) return null;
    if (!response.ok) return this.fail('GET', response);
    return new Uint8Array(await response.arrayBuffer());
  }

  async putObject(bucket: string, key: string, body: Uint8Array, options: { contentType: string; cacheControl?: string | undefined }): Promise<void> {
    const extra: Record<string, string> = { 'content-type': options.contentType, 'content-length': String(body.length) };
    if (options.cacheControl) extra['cache-control'] = options.cacheControl;
    const response = await this.request('PUT', bucket, key, body, extra);
    if (!response.ok) await this.fail('PUT', response);
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    const response = await this.request('DELETE', bucket, key);
    if (!response.ok && response.status !== 404) await this.fail('DELETE', response);
  }
}

/**
 * Object storage in memory. Presigned URLs point at a host that does not
 * exist; `upload()` plays the phone's PUT against a URL it handed out,
 * checking what S3 would check (expiry, content type and length).
 */
export class FakeObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();
  private readonly intents = new Map<string, { bucket: string; key: string; contentType: string; contentLength: number; expiresAt: Date }>();
  private counter = 0;
  now: () => Date = () => new Date();

  private static id(bucket: string, key: string): string {
    return `${bucket}/${key}`;
  }

  async presignPut(input: PresignPutInput): Promise<PresignedRequest> {
    this.counter += 1;
    const expiresAt = new Date(this.now().getTime() + input.expiresInSeconds * 1_000);
    const url = `https://storage.fake.invalid/${input.bucket}/${input.key}?sig=${this.counter}`;
    this.intents.set(url, { ...input, expiresAt });
    return { url, method: 'PUT', headers: { 'Content-Type': input.contentType, 'Content-Length': String(input.contentLength) }, expiresAt };
  }

  async presignGet(input: PresignGetInput): Promise<PresignedRequest> {
    return {
      url: `https://storage.fake.invalid/${input.bucket}/${input.key}?get=1`,
      method: 'GET',
      headers: {},
      expiresAt: new Date(this.now().getTime() + input.expiresInSeconds * 1_000),
    };
  }

  /** The phone's PUT to a presigned URL. Throws as S3 would refuse it. */
  upload(url: string, body: Uint8Array, contentType: string): void {
    const intent = this.intents.get(url);
    if (!intent) throw new Error('403: not a presigned URL');
    if (this.now() > intent.expiresAt) throw new Error('403: request has expired');
    if (contentType !== intent.contentType) throw new Error('403: signature does not match (content type)');
    if (body.length !== intent.contentLength) throw new Error('403: signature does not match (content length)');
    this.objects.set(FakeObjectStorage.id(intent.bucket, intent.key), { body, contentType });
  }

  async headObject(bucket: string, key: string): Promise<StoredObjectInfo | null> {
    const object = this.objects.get(FakeObjectStorage.id(bucket, key));
    return object ? { size: object.body.length, contentType: object.contentType } : null;
  }

  async getObject(bucket: string, key: string): Promise<Uint8Array | null> {
    return this.objects.get(FakeObjectStorage.id(bucket, key))?.body ?? null;
  }

  async putObject(bucket: string, key: string, body: Uint8Array, options: { contentType: string }): Promise<void> {
    this.objects.set(FakeObjectStorage.id(bucket, key), { body, contentType: options.contentType });
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    this.objects.delete(FakeObjectStorage.id(bucket, key));
  }

  /** Keys stored in a bucket under a prefix, sorted. */
  keys(bucket: string, prefix = ''): string[] {
    return [...this.objects.keys()]
      .filter((id) => id.startsWith(`${bucket}/${prefix}`))
      .map((id) => id.slice(bucket.length + 1))
      .sort();
  }
}
