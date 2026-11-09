import { createHash } from 'node:crypto';
import {
  ORIGINS_DEFAULT_VERSION,
  checkBootstrapUrl,
  checkOrigin,
  originRoles,
  wireTime,
  type Brand,
  type OriginHosts,
  type OriginRole,
  type OriginsDocument,
  type OriginsPayload,
  type OriginsSettings,
} from '@app/shared';
import { storeOriginsDocument, type KeyBuilder, type OriginsSigner } from '@app/shared/server';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type { ApiConfig } from '../config.js';

/**
 * The signed origins document in process memory (`GET /v1/origins` sends
 * no statement). It is rebuilt from the configuration snapshot (app_config
 * `origins.hosts`, refreshed on `cfg:changed`), or from the deployment's own
 * hosts while the panel never saved any, and signed again every hour.
 *
 * `issuedAt` is the start of the hour, so every API process signs the same
 * bytes within an hour (Ed25519 is deterministic): ETags and edge caches
 * agree across processes. Each new document is also written to Valkey
 * (`origins:doc`, newest wins), where the worker picks it up to publish the
 * copies on the bootstrap hosts.
 */

export interface OriginDefaults {
  hosts: OriginHosts;
  bootstrap: string[];
}

export interface EffectiveOrigins {
  /** True when the hosts come from the panel (app_config); false for the deployment's own. */
  saved: boolean;
  version: number;
  hosts: OriginHosts;
  bootstrap: string[];
  allowIpHosts: boolean;
}

export interface ServedOrigins {
  /** The JSON body as sent. */
  body: string;
  etag: string;
  document: OriginsDocument;
  payload: OriginsPayload;
  issuedAtMs: number;
}

/** Where the worker keeps a copy in the media bucket (served by the CDN under the same path). */
export const ORIGINS_OBJECT_KEY = 'bootstrap/origins.json';

/** How often the same hosts are signed again (and `issuedAt` moves). */
export const ORIGINS_SIGN_EVERY_MS = 3_600_000;

export interface OriginsServiceOptions {
  brandId: string;
  /** Null without ORIGINS_SIGNING_KEY: nothing is served. */
  signer: OriginsSigner | null;
  defaults: OriginDefaults;
  ttlSeconds: number;
  redis: Redis;
  keys: KeyBuilder;
  log: FastifyBaseLogger;
  now?: (() => number) | undefined;
  signEveryMs?: number | undefined;
}

function sameSettings(a: EffectiveOrigins, b: EffectiveOrigins): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class OriginsService {
  private settings: EffectiveOrigins | null = null;
  private served: ServedOrigins | null = null;
  /** The last document Valkey accepted (or already held something newer than). */
  private stored: ServedOrigins | null = null;
  private storing: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly startedAtMs: number;
  private readonly now: () => number;
  private readonly signEveryMs: number;

  constructor(private readonly options: OriginsServiceOptions) {
    this.now = options.now ?? Date.now;
    this.signEveryMs = options.signEveryMs ?? ORIGINS_SIGN_EVERY_MS;
    this.startedAtMs = this.now();
  }

  get signer(): OriginsSigner | null {
    return this.options.signer;
  }

  get defaults(): OriginDefaults {
    return this.options.defaults;
  }

  /** The stored settings from the configuration snapshot; null: the deployment's own hosts. */
  update(stored: OriginsSettings | null): void {
    const next: EffectiveOrigins = stored
      ? { saved: true, version: stored.version, hosts: stored.hosts, bootstrap: stored.bootstrap, allowIpHosts: stored.allowIpHosts }
      : { saved: false, version: ORIGINS_DEFAULT_VERSION, hosts: this.options.defaults.hosts, bootstrap: this.options.defaults.bootstrap, allowIpHosts: false };
    if (this.settings && sameSettings(this.settings, next)) return;
    if (this.settings && next.version < this.settings.version) {
      this.options.log.error({ loaded: next.version, serving: this.settings.version }, 'origins: the stored version went back; apps keep the newer document they hold');
    }
    this.settings = next;
    this.served = null;
    this.current();
  }

  /** The hosts in effect; null until the configuration loaded. */
  effective(): EffectiveOrigins | null {
    return this.settings;
  }

  /** The first origin of a role when the panel saved hosts (the panel then wins over the environment). */
  override(role: OriginRole): string | undefined {
    return this.settings?.saved ? this.settings.hosts[role][0] : undefined;
  }

  /** The document to serve now, signed again when the hour turned; null without a key or before the configuration loaded. */
  current(): ServedOrigins | null {
    const { signer } = this.options;
    const settings = this.settings;
    if (!signer || !settings) return null;
    const issuedAtMs = Math.floor(this.now() / this.signEveryMs) * this.signEveryMs;
    if (this.served?.issuedAtMs === issuedAtMs) return this.served;
    const payload: OriginsPayload = {
      brand: this.options.brandId,
      version: settings.version,
      issuedAt: wireTime(issuedAtMs),
      expiresAt: wireTime(issuedAtMs + this.options.ttlSeconds * 1_000),
      hosts: settings.hosts,
      bootstrap: settings.bootstrap,
    };
    const document = signer.sign(payload);
    const body = JSON.stringify(document);
    const etag = `"o${settings.version}-${createHash('sha256').update(body).digest('base64url').slice(0, 16)}"`;
    this.served = { body, etag, document, payload, issuedAtMs };
    void this.store();
    return this.served;
  }

  /** Writes the current document to Valkey for the worker (newest wins there). */
  private store(): Promise<void> {
    if (this.storing) return this.storing;
    const served = this.served;
    const settings = this.settings;
    if (!served || !settings || this.stored === served) return Promise.resolve();
    const { redis, keys, log } = this.options;
    if (redis.status !== 'ready') return Promise.resolve();
    let failed = false;
    this.storing = storeOriginsDocument(redis, keys, {
      version: settings.version,
      issuedAtMs: served.issuedAtMs,
      signerStartedAtMs: this.startedAtMs,
      body: served.body,
    })
      .then((accepted) => {
        this.stored = served;
        if (accepted) log.info({ version: settings.version, issuedAt: served.payload.issuedAt }, 'origins: document stored for publishing');
      })
      .catch((error: unknown) => {
        failed = true;
        log.warn({ err: error }, 'origins: the document could not be stored for publishing; retried within a minute');
      })
      .finally(() => {
        this.storing = null;
        // A newer document may have been made meanwhile (after a failure, the timer retries).
        if (!failed && this.served && this.stored !== this.served) void this.store();
      });
    return this.storing;
  }

  /** Signs again when the hour turns and retries a failed store, once a minute. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.current();
      void this.store();
    }, Math.min(60_000, this.signEveryMs));
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.storing?.catch(() => undefined);
  }
}

/**
 * The deployment's own hosts, what the document carries until the panel
 * saves some: the API from brand.json (its hosts are rewritten from the
 * deployment's public addresses when the container starts), realtime from
 * CENTRIFUGO_WS_URL, the CDN from CDN_BASE_URL, the website from SITE_ORIGIN,
 * each else from brand.json; the bootstrap URLs: the copy the worker keeps in the
 * media bucket (`<CDN_BASE_URL>/bootstrap/origins.json`) when a CDN is configured,
 * then brand.json's. An entry the rules refuse (a development host) is left out
 * with a warning.
 */
export function originDefaults(brand: Brand, config: ApiConfig, log: FastifyBaseLogger): OriginDefaults {
  const fromHost = (host: string | undefined): string[] => (host ? [`https://${host}`] : []);
  const fromUrl = (value: string): string[] => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'wss:' ? [`https://${url.host}`] : [];
    } catch {
      return [];
    }
  };
  const candidates: Record<OriginRole, string[]> = {
    api: fromHost(brand.domains.api),
    realtime: config.realtime.wsUrl ? fromUrl(config.realtime.wsUrl) : fromHost(brand.domains.realtime),
    rtc: fromHost(brand.domains.rtc),
    cdn: config.storage?.cdn ? fromUrl(config.storage.cdn.baseUrl) : fromHost(brand.domains.cdn),
    web: config.siteOrigin ? fromUrl(config.siteOrigin) : fromHost(brand.domains.legal),
  };
  const hosts = { api: [], realtime: [], rtc: [], cdn: [], web: [] } as Record<OriginRole, string[]>;
  for (const role of originRoles) {
    for (const entry of candidates[role]) {
      const checked = checkOrigin(entry, { allowIpHosts: false });
      if (checked.ok) hosts[role].push(checked.value);
      else log.warn({ role, entry, reason: checked.message }, 'origins: a host of the deployment is left out of the document');
    }
  }
  const bootstrap: string[] = [];
  const cdnCopy: string[] = [];
  if (config.storage?.cdn) {
    const base = new URL(config.storage.cdn.baseUrl);
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/${ORIGINS_OBJECT_KEY}`;
    cdnCopy.push(base.toString());
  }
  for (const entry of [...cdnCopy, ...brand.origins.bootstrap]) {
    const checked = checkBootstrapUrl(entry, { allowIpHosts: false });
    if (checked.ok) {
      if (!bootstrap.includes(checked.value)) bootstrap.push(checked.value);
    } else log.warn({ entry, reason: checked.message }, 'origins: a bootstrap URL is left out of the document');
  }
  return { hosts, bootstrap };
}
