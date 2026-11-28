import { effectiveProviders, providerConfigKey, type EffectiveProviders, type EnvProviders } from '@app/config';
import { providerRows } from '@app/db';
import type { ProviderKind } from '@app/shared';
import { DataSealer, FcmSender, PROCESS_REPORT_EVERY_MS, parseKeyRing, type KeyBuilder, type ProcessInfo, type PushSender } from '@app/shared/server';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { WorkerConfig } from './config.js';
import { iapServicesFrom, type IapIntegrationFactory, type IapServices } from './iap/verifiers.js';
import type { WorkerServices } from './services.js';

/**
 * The provider credentials of the worker (FCM and the two stores): the
 * deployment's unless the admin panel saved an entry for the kind, which
 * then wins entirely (an entry turned off, or one that cannot be opened,
 * turns the provider off). Every 5 seconds one GET of `cfg:v`; when it moved,
 * one statement reads the provider entries and, when they changed, the
 * clients are rebuilt and set on the services (`services.push`,
 * `services.iap`), which every job reads when it starts; a running job keeps
 * the client it began with. The first read happens before the queue workers
 * start. What the process applied is reported to `prov:applied` (field
 * `worker:<id>`, fingerprints only), with the photo moderation state and the
 * process's own state (`proc`: start time, the settings version read, the
 * queues and streams it runs; the jobs page lists workers from it), after
 * every rebuild, every new settings version and every 30 seconds; `stop()`
 * removes the field.
 */

const WORKER_KINDS = ['play', 'bazaar', 'fcm'] as const satisfies readonly ProviderKind[];
const KEYS = WORKER_KINDS.map(providerConfigKey);

export interface WorkerProvidersOptions {
  config: WorkerConfig;
  services: WorkerServices;
  redis: Redis;
  keys: KeyBuilder;
  log: Logger;
  /** The sealer of the panel's secrets; default from PROVIDER_KEYS (none: panel entries read `unreadable`). */
  sealer?: DataSealer | null | undefined;
  /** How often `cfg:v` is looked at (5 s) and the report written again (30 s). */
  checkMs?: number | undefined;
  reportMs?: number | undefined;
  /** What this process runs, for the report's `proc` (none: no process state is reported). */
  process?: { startedAtMs: number; queues: readonly string[]; streams: readonly ('like' | 'match' | 'msg')[]; maint: boolean } | undefined;
  /** FCM's sender from an account (tests). */
  pushSender?: ((account: NonNullable<EnvProviders['fcm']>) => PushSender) | undefined;
  /** Store integration factories (tests). */
  iapFactories?: Partial<Record<'play' | 'bazaar', IapIntegrationFactory>> | undefined;
  /** How long start() waits for the first read before the workers start anyway. */
  startTimeoutMs?: number | undefined;
}

/** The worker's environment values. */
export function workerEnvProviders(config: WorkerConfig): EnvProviders {
  const env: EnvProviders = {};
  if (config.store.play) env.play = config.store.play;
  if (config.store.bazaar) env.bazaar = config.store.bazaar;
  if (config.push) env.fcm = config.push.account;
  return env;
}

export function sealerOf(config: WorkerConfig): DataSealer | null {
  return config.providerKeys ? new DataSealer(parseKeyRing(config.providerKeys.keys, 'PROVIDER_KEYS'), config.providerKeys.keyId) : null;
}

export class WorkerProviders {
  private readonly options: WorkerProvidersOptions;
  private readonly env: EnvProviders;
  private readonly sealer: DataSealer | null;
  private readonly basePush: PushSender | null | undefined;
  private readonly baseIap: IapServices | undefined;
  private effective: EffectiveProviders;
  private version: string | null = null;
  private hash: string | null = null;
  private lastReport = 0;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(options: WorkerProvidersOptions) {
    this.options = options;
    this.env = workerEnvProviders(options.config);
    this.sealer = options.sealer !== undefined ? options.sealer : sealerOf(options.config);
    this.basePush = options.services.push;
    this.baseIap = options.services.iap;
    this.effective = effectiveProviders(this.env, {}, this.sealer);
  }

  /** What the process uses now. */
  current(): EffectiveProviders {
    return this.effective;
  }

  /** The first read (bounded by `startTimeoutMs`), then the check every `checkMs`. */
  async start(): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([this.refresh(), new Promise<void>((resolve) => (timeout = setTimeout(resolve, this.options.startTimeoutMs ?? 5_000)))]);
    clearTimeout(timeout);
    this.timer = setInterval(() => void this.refresh(), this.options.checkMs ?? 5_000);
    this.timer.unref();
  }

  /** Stops the checks and removes this process's report (best effort). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
    const { redis, keys, config, log } = this.options;
    if (redis.status !== 'ready') return;
    await redis.hdel(keys.providersApplied(), `worker:${config.workerId}`).catch((error: unknown) => log.debug({ err: error }, 'providers: report not removed'));
  }

  /** One check: `cfg:v`, and the entries when it moved. Never throws. */
  refresh(): Promise<void> {
    this.running ??= this.check().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async check(): Promise<void> {
    const { redis, keys, log } = this.options;
    try {
      const version = (await redis.get(keys.configVersion())) ?? '0';
      if (version !== this.version) {
        const rows = await providerRows(this.options.services.pg, KEYS);
        this.version = version;
        const next = effectiveProviders(this.env, rows, this.sealer);
        if (next.hash !== this.hash) {
          this.apply(next);
          this.hash = next.hash;
        }
        // A new settings version shows on the jobs page at once.
        await this.report();
        return;
      }
    } catch (error) {
      log.warn({ err: error }, 'providers: not checked; the clients stay as they are');
    }
    if (Date.now() - this.lastReport >= (this.options.reportMs ?? PROCESS_REPORT_EVERY_MS)) await this.report();
  }

  private apply(next: EffectiveProviders): void {
    const { services, log, config } = this.options;
    const before = this.effective;
    for (const kind of WORKER_KINDS) {
      if (next.sources[kind] === 'unreadable' && before.sources[kind] !== 'unreadable') {
        log.error({ kind }, 'providers: the panel entry cannot be read (PROVIDER_KEYS missing or changed?); the provider is off until it is saved again');
      }
    }
    // FCM: the panel's account, none when off, the start's otherwise.
    const fcm = next.sources.fcm;
    if (fcm === 'panel' && next.configs.fcm) {
      if (!(before.sources.fcm === 'panel' && before.fingerprints.fcm === next.fingerprints.fcm && services.push)) {
        services.push = this.options.pushSender ? this.options.pushSender(next.configs.fcm) : new FcmSender({ account: next.configs.fcm });
      }
    } else if (fcm === 'off' || fcm === 'unreadable') {
      services.push = null;
    } else {
      services.push = this.basePush ?? null;
    }
    // Stores: one integration per store from the panel's entry, else the start's.
    const verifiers: IapServices['verifiers'] = {};
    const out: IapServices = { verifiers };
    for (const store of ['play', 'bazaar'] as const) {
      const source = next.sources[store];
      if (source === 'panel' && next.configs[store]) {
        try {
          const one = iapServicesFrom({ ...config, store: { play: undefined, bazaar: undefined, [store]: next.configs[store] } }, log, { redis: this.options.redis, keys: this.options.keys }, this.options.iapFactories);
          if (one.verifiers[store]) verifiers[store] = one.verifiers[store];
          if (store === 'play') {
            if (one.rtdn) out.rtdn = one.rtdn;
            if (one.voided) out.voided = one.voided;
          }
        } catch (error) {
          log.error({ err: error, store }, 'providers: the panel entry does not build a store client; the store is off');
          next.sources[store] = 'unreadable';
          next.fingerprints[store] = null;
        }
      } else if (source === 'env' || source === 'none') {
        const base = this.baseIap;
        if (base?.verifiers[store]) verifiers[store] = base.verifiers[store];
        if (store === 'play' && base) {
          if (base.rtdn) out.rtdn = base.rtdn;
          if (base.voided) out.voided = base.voided;
        }
      }
    }
    services.iap = out;
    this.effective = next;
    log.info({ sources: next.sources }, 'providers: applied');
  }

  private processState(process: NonNullable<WorkerProvidersOptions['process']>): ProcessInfo {
    const version = this.version === null ? null : Number(this.version);
    return {
      kind: 'worker',
      startedAtMs: process.startedAtMs,
      cfgVersion: version !== null && Number.isSafeInteger(version) && version >= 0 ? version : null,
      queues: [...process.queues],
      streams: [...process.streams],
      maint: process.maint,
    };
  }

  private async report(): Promise<void> {
    const { redis, keys, config, log } = this.options;
    const body = {
      atMs: Date.now(),
      hash: this.effective.hash,
      kinds: Object.fromEntries(WORKER_KINDS.map((kind) => [kind, { source: this.effective.sources[kind], fp: this.effective.fingerprints[kind] }])),
      moderation: { provider: config.photos.provider, autoApprove: config.photos.autoApprove },
      ...(this.options.process ? { proc: this.processState(this.options.process) } : {}),
    };
    try {
      await redis.hset(keys.providersApplied(), `worker:${config.workerId}`, JSON.stringify(body));
      this.lastReport = body.atMs;
    } catch (error) {
      log.debug({ err: error }, 'providers: report not written');
    }
  }
}
