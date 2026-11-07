import { createHash, createHmac } from 'node:crypto';

/**
 * Signed CDN links of media (photo variants). A link is valid until the end
 * of the next UTC day: at least 24 hours, and the same string for every
 * request of a day, so the phone's image cache and the CDN keep working.
 *
 * Two schemes, because the CDN is not chosen yet:
 *
 * - `hmac`: `?exp=<unix seconds>&sig=<base64url HMAC-SHA256(key, "<path>\n<exp>")>`,
 *   checked by an edge function in front of the media bucket (it must
 *   refuse a missing, wrong or expired signature and compare in constant
 *   time);
 * - `bunny`: the CDN's own token authentication,
 *   `?token=<base64url SHA-256(key + path + exp)>&expires=<exp>`.
 *
 * `path` is the URL's path as sent, including any path of the base URL.
 */

export type CdnSigningScheme = 'hmac' | 'bunny';

export interface CdnOptions {
  /** `https://cdn.example.com` (a path prefix is allowed; no query, no trailing slash needed). */
  baseUrl: string;
  signingKey: string;
  scheme: CdnSigningScheme;
  now?: (() => Date) | undefined;
}

const DAY_MS = 86_400_000;

/** Unix seconds of the end of the next UTC day after `now`. */
export function mediaUrlExpiry(now: Date | number): number {
  const ms = typeof now === 'number' ? now : now.getTime();
  return ((Math.floor(ms / DAY_MS) + 2) * DAY_MS) / 1_000;
}

const KEY = /^[A-Za-z0-9._/-]{1,512}$/;

export class CdnUrlSigner {
  private readonly base: URL;
  /** The base URL's path without its trailing slash ('' for a bare origin). */
  private readonly basePath: string;
  private readonly key: string;
  readonly scheme: CdnSigningScheme;
  private readonly now: () => Date;

  constructor(options: CdnOptions) {
    const base = new URL(options.baseUrl);
    if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new TypeError('the CDN base URL must be http(s)');
    if (base.search || base.hash) throw new TypeError('the CDN base URL takes no query or fragment');
    if (options.signingKey.length < 16) throw new RangeError('the CDN signing key is too short');
    this.basePath = base.pathname.replace(/\/+$/, '');
    this.base = base;
    this.key = options.signingKey;
    this.scheme = options.scheme;
    this.now = options.now ?? (() => new Date());
  }

  /** The signed link of an object key of the media bucket. */
  url(objectKey: string): string {
    if (!KEY.test(objectKey) || objectKey.startsWith('/') || objectKey.split('/').some((s) => s === '' || s === '.' || s === '..')) {
      throw new TypeError('not a media object key');
    }
    const url = new URL(this.base.toString());
    url.pathname = `${this.basePath}/${objectKey}`;
    const path = url.pathname;
    const expires = mediaUrlExpiry(this.now());
    if (this.scheme === 'bunny') {
      const token = createHash('sha256').update(`${this.key}${path}${expires}`).digest('base64url');
      url.search = `token=${token}&expires=${expires}`;
    } else {
      const sig = createHmac('sha256', this.key).update(`${path}\n${expires}`).digest('base64url');
      url.search = `exp=${expires}&sig=${sig}`;
    }
    return url.toString();
  }

  /** What an edge function does with an `hmac` link (also the tests' check). */
  static verifyHmac(link: string, signingKey: string, now: Date | number = Date.now()): boolean {
    const url = new URL(link);
    const exp = Number(url.searchParams.get('exp'));
    const sig = url.searchParams.get('sig') ?? '';
    if (!Number.isSafeInteger(exp) || exp * 1_000 <= (typeof now === 'number' ? now : now.getTime())) return false;
    const expected = createHmac('sha256', signingKey).update(`${url.pathname}\n${exp}`).digest('base64url');
    return expected.length === sig.length && createHash('sha256').update(expected).digest().equals(createHash('sha256').update(sig).digest());
  }
}
