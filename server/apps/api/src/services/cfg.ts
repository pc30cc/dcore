import { createHash } from 'node:crypto';
import { configSnapshot, type ConfigSnapshotRows, type Pool } from '@app/db';
import {
  appStores,
  configSchema,
  fieldType,
  intention,
  locales,
  parseAppConfig,
  reportReason,
  store as storeCodes,
  type AppConfig,
  type AppStore,
  type Brand,
  type Config,
  type Locale,
} from '@app/shared';
import type { KeyBuilder } from '@app/shared/server';
import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import { HttpProblem } from '../lib/problem.js';
import { clientPolicyFromConfig, type ClientPolicyHolder } from '../plugins/client.js';
import { BannedTerms } from './bannedTerms.js';
import { deletionReasonLabels, intentionLabels, label, reportReasonLabels } from './labels.js';
import { welcomeFor } from './welcome.js';

/**
 * The run-time configuration in process memory. One statement
 * (`config.snapshot`) loads app_config, the active brand's overrides, the
 * panel's strings, the catalogues, plans, banned terms and feature flags;
 * request paths only read the snapshot, never PostgreSQL.
 *
 * The admin panel bumps `cfg:v` and publishes the new version on
 * `cfg:changed` after every save ({@link publishConfigChange}). Each process
 * reloads on that message, and also when a poll of `cfg:v` (one GET a
 * minute) finds a version it has not loaded, which covers a message missed
 * while Valkey was unreachable. Until the first load succeeds the routes
 * that need the snapshot answer 503.
 *
 * `GET /v1/config` documents are built once per load, for each store and
 * locale, with their ETag (the version and a hash of the body), so serving
 * and revalidating one costs no work beyond a map lookup.
 */

export interface FieldOptionDef {
  id: number;
  active: boolean;
  i18n: Record<string, unknown>;
}

export interface FieldDefinition {
  id: number;
  key: string;
  kind: (typeof fieldType.names)[number];
  sort: number;
  filterSlot: number | null;
  maxChoices: number | null;
  active: boolean;
  required: boolean;
  public: boolean;
  filterable: boolean;
  premiumFilter: boolean;
  sensitive: boolean;
  discoveryColumn: string | null;
  i18n: Record<string, unknown>;
  options: FieldOptionDef[];
}

export interface PromptDefinition {
  id: number;
  voice: boolean;
  active: boolean;
  sort: number;
  i18n: Record<string, unknown>;
}

export interface PlanDefinition {
  id: number;
  key: string;
  rank: number;
  active: boolean;
  names: Record<string, unknown>;
  features: Record<string, number | boolean>;
}

export interface FeatureFlagDefinition {
  key: string;
  enabled: boolean;
  rolloutPct: number;
  rules: Record<string, unknown>;
}

export interface ConfigDocument {
  body: string;
  etag: string;
  document: Config;
}

export interface ConfigSnapshot {
  /** `cfg:v` when this snapshot was loaded (0 before the panel ever saved). */
  version: number;
  /** A hash of everything loaded: ETags that depend on the configuration use it, so they move even when `cfg:v` did not. */
  fingerprint: string;
  loadedAt: Date;
  app: AppConfig;
  brand: EffectiveBrand;
  /** Panel strings per locale (the active brand's over the shared ones). */
  strings: ReadonlyMap<Locale, Readonly<Record<string, string>>>;
  fields: readonly FieldDefinition[];
  fieldsById: ReadonlyMap<number, FieldDefinition>;
  fieldsByKey: ReadonlyMap<string, FieldDefinition>;
  prompts: readonly PromptDefinition[];
  promptsById: ReadonlyMap<number, PromptDefinition>;
  plans: readonly PlanDefinition[];
  bannedTerms: BannedTerms;
  flags: readonly FeatureFlagDefinition[];
  /** store_products, inactive rows included (the store catalogue is built from them). */
  storeProducts: ConfigSnapshotRows['storeProducts'];
  documents: ReadonlyMap<string, ConfigDocument>;
  /** The keys of app_config this build does not know (a newer panel). */
  unknownKeys: readonly string[];
}

/** The brand as the app sees it: brand.json with the panel's overrides from the active `brands` row. */
export interface EffectiveBrand {
  id: string;
  appName: string;
  colors: Brand['colors'];
  legal: {
    privacyUrl: string;
    termsUrl: string;
    guidelinesUrl: string;
    childSafetyUrl: string;
    deleteAccountUrl: string;
    supportEmail: string;
  };
  planNames: Record<string, Partial<Record<Locale, string>>>;
  realtimeHost: string | undefined;
}

export interface ConfigServiceOptions {
  pool: Pool;
  redis: Redis;
  keys: KeyBuilder;
  brand: Brand;
  clientPolicy: ClientPolicyHolder;
  log: FastifyBaseLogger;
  /** Whether Google sign-in is configured (the play build lists it as a method). */
  googleSignIn: () => boolean;
  /** How often `cfg:v` is compared with the loaded version. */
  pollMs?: number | undefined;
  /** How long start-up waits for the first load before going on without it. */
  startTimeoutMs?: number | undefined;
}

export function documentKey(store: AppStore, locale: Locale): string {
  return `${store}:${locale}`;
}

/** What the admin panel calls after saving: a new `cfg:v`, announced to every process. */
export async function publishConfigChange(redis: Redis, keys: KeyBuilder): Promise<number> {
  const version = await redis.incr(keys.configVersion());
  await redis.publish(keys.configChannel(), String(version));
  return version;
}

function text(i18n: Record<string, unknown>, locale: Locale, fallback: string): string {
  const own = i18n[locale];
  if (typeof own === 'string' && own.length > 0) return own;
  const en = i18n['en'];
  return typeof en === 'string' && en.length > 0 ? en : fallback;
}

const legalOverride = ['privacyUrl', 'termsUrl', 'guidelinesUrl', 'childSafetyUrl', 'deleteAccountUrl', 'supportEmail'] as const;

function effectiveBrand(brand: Brand, row: ConfigSnapshotRows['brand'], log: FastifyBaseLogger): EffectiveBrand {
  const legalDomain = brand.domains.legal;
  const out: EffectiveBrand = {
    id: brand.id,
    appName: brand.appName,
    colors: brand.colors,
    legal: {
      privacyUrl: brand.legal.privacyUrl,
      termsUrl: brand.legal.termsUrl,
      guidelinesUrl: brand.legal.guidelinesUrl,
      childSafetyUrl: brand.legal.childSafetyUrl ?? `https://${legalDomain}/child-safety/`,
      deleteAccountUrl: brand.legal.deleteAccountUrl,
      supportEmail: brand.legal.supportEmail,
    },
    planNames: { ...(brand.planNames ?? {}) },
    realtimeHost: brand.domains.realtime,
  };
  if (!row) return out;
  if (row.key !== brand.id) log.warn({ active: row.key, built: brand.id }, 'config: the active brand row is not the brand this process was built for');
  const config = row.config;
  if (typeof config['appName'] === 'string' && config['appName'].length > 0) out.appName = config['appName'];
  const colors = config['colors'];
  const hex = /^#[0-9A-Fa-f]{6}$/;
  const themed = (value: unknown): value is { light: string; dark: string } =>
    typeof value === 'object' && value !== null && hex.test(String((value as Record<string, unknown>)['light'])) && hex.test(String((value as Record<string, unknown>)['dark']));
  if (typeof colors === 'object' && colors !== null) {
    const { brand: main, onBrand } = colors as Record<string, unknown>;
    if (themed(main) && themed(onBrand)) out.colors = { brand: main, onBrand };
  }
  const legal = config['legal'];
  if (typeof legal === 'object' && legal !== null) {
    for (const key of legalOverride) {
      const value = (legal as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.length > 0) out.legal[key] = value;
    }
  }
  const planNames = config['planNames'];
  if (typeof planNames === 'object' && planNames !== null) {
    for (const [plan, names] of Object.entries(planNames as Record<string, unknown>)) {
      if (typeof names !== 'object' || names === null) continue;
      const kept: Partial<Record<Locale, string>> = {};
      for (const locale of locales) {
        const value = (names as Record<string, unknown>)[locale];
        if (typeof value === 'string' && value.length > 0) kept[locale] = value;
      }
      out.planNames[plan] = { ...out.planNames[plan], ...kept };
    }
  }
  return out;
}

function buildStrings(rows: ConfigSnapshotRows['strings'], activeBrandId: number | undefined): Map<Locale, Record<string, string>> {
  const out = new Map<Locale, Record<string, string>>(locales.map((locale) => [locale, {}]));
  // Shared rows (brand 0) first, so the active brand's rows win.
  const ordered = [...rows].sort((a, b) => (a.brandId === 0 ? 0 : 1) - (b.brandId === 0 ? 0 : 1));
  for (const row of ordered) {
    if (row.brandId !== 0 && row.brandId !== activeBrandId) continue;
    const locale = row.locale.split('-')[0] as Locale;
    const bucket = out.get(locale);
    if (bucket) bucket[row.key] = row.value;
  }
  return out;
}

function catalogLabel(strings: Readonly<Record<string, string>>, key: string, fallback: string): string {
  return strings[key] ?? fallback;
}

/** The strings the app may override: push texts and catalogue labels are the server's own. */
function appStrings(strings: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(strings).filter(([key]) => !key.startsWith('push.') && !key.startsWith('catalog.') && !key.startsWith('photo.reject.')));
}

export interface BuiltSnapshotInput {
  rows: ConfigSnapshotRows;
  version: number;
  brand: Brand;
  googleSignIn: boolean;
  log: FastifyBaseLogger;
}

/** Turns the loaded rows into a snapshot (pure; throws on an app_config value that does not parse). */
export function buildSnapshot({ rows, version, brand, googleSignIn, log }: BuiltSnapshotInput): ConfigSnapshot {
  const { config: app, unknown } = parseAppConfig(Object.entries(rows.appConfig).map(([key, value]) => ({ key, value })));
  const effective = effectiveBrand(brand, rows.brand, log);
  const strings = buildStrings(rows.strings, rows.brand?.id);
  const fields: FieldDefinition[] = rows.fields.map((f) => ({
    id: f.id,
    key: f.key,
    kind: fieldType.name(f.type),
    sort: f.sort,
    filterSlot: f.filterSlot,
    maxChoices: f.maxChoices,
    active: f.active,
    required: f.required,
    public: f.public,
    filterable: f.filterable,
    premiumFilter: f.premiumFilter,
    sensitive: f.sensitive,
    discoveryColumn: f.discoveryColumn,
    i18n: f.i18n,
    options: (f.options ?? []).map((o) => ({ id: o.id, active: o.active !== false, i18n: o.i18n ?? {} })),
  }));
  const prompts: PromptDefinition[] = rows.prompts.map((p) => ({ id: p.id, voice: p.kind === 2, active: p.active, sort: p.sort, i18n: p.i18n }));
  const plans: PlanDefinition[] = rows.plans.map((p) => ({ ...p }));
  const bannedTerms = new BannedTerms(rows.bannedTerms);
  if (bannedTerms.invalid.length > 0) log.warn({ ids: bannedTerms.invalid }, 'config: banned terms skipped (pattern does not compile)');

  const documents = new Map<string, ConfigDocument>();
  for (const store of appStores) {
    const versions = app['app.min_version'][store === 'play' ? 'google_play' : 'cafe_bazaar'];
    for (const locale of locales) {
      const own = strings.get(locale) ?? {};
      const message = app['app.maintenance'].message[locale];
      const welcome = welcomeFor(brand.welcome, app['brand.welcome'], locale);
      const document: Config = {
        v: version,
        appName: effective.appName,
        colors: effective.colors,
        legal: { ...effective.legal, versions: app['legal.versions'] },
        planNames: Object.fromEntries(
          plans
            .filter((plan) => plan.active && plan.key !== 'free')
            .map((plan) => [plan.key, effective.planNames[plan.key]?.[locale] ?? text(plan.names, locale, plan.key)]),
        ),
        minVersion: { required: versions.required, recommended: versions.recommended },
        maintenance: { enabled: app['app.maintenance'].enabled, ...(message ? { message } : {}) },
        auth: { otpLength: app['auth.otp'].length, methods: store === 'play' && googleSignIn ? ['phone', 'google'] : ['phone'] },
        catalog: {
          fields: fields
            .filter((f) => f.active)
            .map((f) => ({
              id: f.id,
              key: f.key,
              label: text(f.i18n, locale, f.key),
              kind: f.kind,
              ...(f.kind === 'single' || f.kind === 'multi'
                ? { options: f.options.filter((o) => o.active).map((o) => ({ id: o.id, label: text(o.i18n, locale, String(o.id)) })) }
                : {}),
              private: !f.public,
              filterable: f.filterable,
              sensitive: f.sensitive,
              required: f.required,
            })),
          prompts: prompts.filter((p) => p.active).map((p) => ({ id: p.id, text: text(p.i18n, locale, ''), ...(p.voice ? { category: 'voice' } : {}) })),
          intentions: intention.names.map((key) => ({
            key,
            label: catalogLabel(own, `catalog.intention.${key}`, label(intentionLabels[key], locale, key)),
          })),
          reportReasons: reportReason.names.map((key) => ({
            key,
            label: catalogLabel(own, `catalog.report.${key}`, label(reportReasonLabels[key], locale, key)),
          })),
          deletionReasons: Object.keys(deletionReasonLabels).map((key) => ({
            key,
            label: catalogLabel(own, `catalog.deletion.${key}`, label(deletionReasonLabels[key], locale, key)),
          })),
        },
        limits: {
          photosMax: 9,
          photosMin: PHOTOS_MIN,
          promptsMax: 3,
          aboutMax: 500,
          messageMax: app['chat.max_body_chars'],
          commentMax: 300,
        },
        calls: app['calls.enabled'],
        strings: appStrings(own),
        ...(welcome ? { welcome } : {}),
      };
      // The document is what every client parses: refuse to serve one the contract does not accept.
      const checked = configSchema.parse(document);
      const body = JSON.stringify(checked);
      const hash = createHash('sha256').update(body).digest('base64url').slice(0, 16);
      documents.set(documentKey(store, locale), { body, etag: `"c${version}-${hash}"`, document: checked });
    }
  }

  return {
    version,
    fingerprint: createHash('sha256').update(JSON.stringify(rows)).update(effective.appName).digest('base64url').slice(0, 12),
    loadedAt: new Date(),
    app,
    brand: effective,
    strings,
    fields,
    fieldsById: new Map(fields.map((f) => [f.id, f])),
    fieldsByKey: new Map(fields.map((f) => [f.key, f])),
    prompts,
    promptsById: new Map(prompts.map((p) => [p.id, p])),
    plans,
    bannedTerms,
    flags: rows.flags,
    storeProducts: rows.storeProducts,
    documents,
    unknownKeys: unknown,
  };
}

/** The photo minimum of discovery (`discovery_sync()` counts two approved photos). */
export const PHOTOS_MIN = 2;

export class ConfigService {
  private current: ConfigSnapshot | null = null;
  private loading: Promise<void> | null = null;
  private again = false;
  private subscriber: Redis | null = null;
  private poll: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private stopped = false;
  private failures = 0;
  private readonly listeners: ((snapshot: ConfigSnapshot) => void)[] = [];
  private readonly options: ConfigServiceOptions;

  constructor(options: ConfigServiceOptions) {
    this.options = options;
  }

  /** The loaded snapshot; 503 until the first load succeeded. */
  get(): ConfigSnapshot {
    if (this.current === null) {
      throw new HttpProblem('service_unavailable', { detail: 'Configuration is not loaded yet.', headers: { 'retry-after': '5' } });
    }
    return this.current;
  }

  peek(): ConfigSnapshot | null {
    return this.current;
  }

  /** Called after every load (and now, when one is loaded): other in-memory settings follow the snapshot. */
  onLoad(listener: (snapshot: ConfigSnapshot) => void): void {
    this.listeners.push(listener);
    if (this.current) this.notify(listener, this.current);
  }

  private notify(listener: (snapshot: ConfigSnapshot) => void, snapshot: ConfigSnapshot): void {
    try {
      listener(snapshot);
    } catch (error) {
      this.options.log.error({ err: error }, 'config: a listener failed');
    }
  }

  /** Loads once (waiting at most `startTimeoutMs`), then follows `cfg:changed` and polls `cfg:v`. */
  async start(): Promise<void> {
    this.stopped = false;
    const first = this.reload();
    const timeoutMs = this.options.startTimeoutMs ?? 5_000;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([first, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
    clearTimeout(timer);
    this.listen();
    const pollMs = this.options.pollMs ?? 60_000;
    this.poll = setInterval(() => void this.checkVersion(), pollMs);
    this.poll.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    if (this.retry) clearTimeout(this.retry);
    this.poll = null;
    this.retry = null;
    const subscriber = this.subscriber;
    this.subscriber = null;
    if (subscriber) {
      // quit() on a connection that never came up would wait for it (offline queue): drop it instead.
      if (subscriber.status === 'ready') {
        await Promise.race([subscriber.quit().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 1_000).unref())]);
      }
      subscriber.disconnect();
    }
    await this.loading?.catch(() => undefined);
  }

  /** Loads a new snapshot; concurrent calls share one load and ask for one more after it. */
  reload(): Promise<void> {
    if (this.loading) {
      this.again = true;
      return this.loading;
    }
    this.loading = this.load()
      .then(() => {
        this.failures = 0;
      })
      .catch((error: unknown) => {
        this.failures += 1;
        this.options.log.error({ err: error, failures: this.failures }, 'config: load failed');
        this.scheduleRetry();
      })
      .finally(() => {
        this.loading = null;
        if (this.again && !this.stopped) {
          this.again = false;
          void this.reload();
        }
      });
    return this.loading;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retry) return;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.failures, 6));
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.reload();
    }, delay);
    this.retry.unref();
  }

  private async readVersion(): Promise<number | null> {
    const { redis, keys } = this.options;
    if (redis.status !== 'ready') return null;
    const value = await redis.get(keys.configVersion());
    const version = value === null ? 0 : Number(value);
    return Number.isSafeInteger(version) && version >= 0 ? version : 0;
  }

  private async load(): Promise<void> {
    const { pool, brand, googleSignIn, log, clientPolicy } = this.options;
    // The version is read before the rows: a save that lands in between is picked up by its message.
    let version: number;
    try {
      version = (await this.readVersion()) ?? this.current?.version ?? 0;
    } catch (error) {
      log.warn({ err: error }, 'config: cfg:v unreadable; keeping the last version');
      version = this.current?.version ?? 0;
    }
    const rows = await configSnapshot(pool);
    const snapshot = buildSnapshot({ rows, version, brand, googleSignIn: googleSignIn(), log });
    this.current = snapshot;
    clientPolicy.set(clientPolicyFromConfig(snapshot.app));
    for (const listener of this.listeners) this.notify(listener, snapshot);
    if (snapshot.unknownKeys.length > 0) log.info({ keys: snapshot.unknownKeys }, 'config: app_config keys this build does not use');
    log.info({ version }, 'config: loaded');
  }

  private async checkVersion(): Promise<void> {
    try {
      const version = await this.readVersion();
      if (version !== null && version !== this.current?.version) await this.reload();
    } catch (error) {
      this.options.log.warn({ err: error }, 'config: cfg:v poll failed');
    }
  }

  private listen(): void {
    const { redis, keys, log } = this.options;
    // A connection of its own (subscriber mode), which waits for Valkey instead of failing fast.
    const subscriber = redis.duplicate({
      connectionName: 'api-cfg',
      lazyConnect: true,
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
      commandTimeout: undefined,
    });
    this.subscriber = subscriber;
    subscriber.on('error', (error: Error) => log.warn({ err: error }, 'config: subscriber connection error'));
    subscriber.on('message', (_channel: string, message: string) => {
      if (Number(message) !== this.current?.version) void this.reload();
    });
    // After a reconnect ioredis restores the subscription; a change missed meanwhile is caught here.
    subscriber.on('ready', () => void this.checkVersion());
    // Queued until the connection is up (lazy connect, offline queue).
    subscriber.subscribe(keys.configChannel()).catch((error: unknown) => {
      if (!this.stopped) log.warn({ err: error }, 'config: subscribe failed');
    });
  }
}

/** The store code of a store name (`play` 1, `bazaar` 2). */
export function storeCode(store: AppStore): number {
  return storeCodes.code(store);
}
