import { hostname } from 'node:os';
import { effectiveProviders, type EffectiveProviders, type EnvProviders, type ProviderConfigs } from '@app/config';
import { providerKinds, type AppStore, type ProviderKind, type ProviderSource } from '@app/shared';
import {
  DataSealer,
  KavenegarSender,
  PROCESS_REPORT_EVERY_MS,
  PubSubOidcVerifier,
  parseKeyRing,
  SmsIrSender,
  TelnyxSender,
  type ProcessInfo,
  type PubSubPushAuthenticator,
  type SmsSender,
  type StoreVerifier,
} from '@app/shared/server';
import fp from 'fastify-plugin';
import type { ApiConfig } from '../config.js';
import { storeVerifierFactories, type StoreVerifierFactory } from './billing/verifiers.js';
import type { ConfigSnapshot } from './cfg.js';

/**
 * The provider credentials in this API process: the deployment's (the
 * environment, built at start) unless the admin panel saved an entry for the
 * kind (app_config `providers.<kind>`), which then wins entirely; an entry
 * turned off or one that cannot be opened turns the provider off. After
 * every configuration load (`cfg:changed` after a panel save, or the minute
 * poll) the clients of the kinds whose entries moved are rebuilt in place:
 * the SMS router's senders, the store verifiers in `app.store.verifiers`
 * (read per call by every route) and the Play RTDN authenticator (read per
 * request). FCM is the worker's.
 *
 * The panel's secrets are sealed under PROVIDER_KEYS (purposes
 * `providers.<kind>.secrets`), the ring the worker shares; DATA_KEYS never
 * seals them, so the worker never needs it.
 *
 * Each process reports what it applied to `prov:applied` (field
 * `api:<hostname>`; each container has its own hostname), so the panel can
 * show which processes use which key, by fingerprint only. The report also
 * carries the process's own state (`proc`: when it started, the settings
 * version it loaded, the roles version and whether their load fails), which
 * the jobs page lists. It is written at start, after every configuration
 * load and every roles load, and every 30 seconds; the field is removed
 * when the app closes. A failure there never changes what is applied.
 */

type Fetch = typeof fetch;

export interface ProvidersOptions {
  /** The SMS clients' fetch (tests). */
  fetch?: Fetch | undefined;
  /** Store verifier factories (tests); otherwise the store integrations'. */
  storeFactories?: Partial<Record<AppStore, StoreVerifierFactory>> | undefined;
  /** How often the report is written again (30 s). */
  reportEveryMs?: number | undefined;
  /** The report's field name (tests running two apps on one Valkey); otherwise `api:<hostname>`. */
  processName?: string | undefined;
  /** Builds Play's RTDN authenticator from an audience and push e-mail (tests); otherwise Google's OIDC check. */
  rtdnAuthenticator?: ((rtdn: { audience: string; pushServiceAccountEmail: string }) => PubSubPushAuthenticator) | undefined;
}

export interface ProviderRuntime {
  /** The deployment's values (FCM is not the API's). */
  readonly env: EnvProviders;
  /** What this process uses now. */
  current(): EffectiveProviders;
  /** Play's RTDN check as it stands (null: Play notifications are refused). */
  playRtdn(): { packageName: string; authenticator: PubSubPushAuthenticator } | null;
  /** The name this process reports under. */
  readonly processName: string;
  /** Seals and opens the panel's provider secrets (PROVIDER_KEYS); null without them (outside production only): panel entries read `unreadable`. */
  readonly sealer: DataSealer | null;
}

declare module 'fastify' {
  interface FastifyInstance {
    providers: ProviderRuntime;
  }
}

const SMS_KINDS = ['kavenegar', 'smsir', 'telnyx'] as const;
const STORE_KINDS = ['play', 'bazaar'] as const;

/** The environment's providers of the API. */
export function apiEnvProviders(config: ApiConfig): EnvProviders {
  const env: EnvProviders = {};
  if (config.sms.kavenegar) env.kavenegar = config.sms.kavenegar;
  if (config.sms.smsir) env.smsir = config.sms.smsir;
  if (config.sms.telnyx) env.telnyx = config.sms.telnyx;
  if (config.store.play) env.play = config.store.play;
  if (config.store.bazaar) env.bazaar = config.store.bazaar;
  return env;
}

function smsSender(kind: (typeof SMS_KINDS)[number], configs: Partial<ProviderConfigs>, timeoutMs: number, fetchFn: Fetch | undefined): SmsSender | null {
  switch (kind) {
    case 'kavenegar':
      return configs.kavenegar ? new KavenegarSender({ ...configs.kavenegar, timeoutMs, ...(fetchFn ? { fetch: fetchFn } : {}) }) : null;
    case 'smsir':
      return configs.smsir ? new SmsIrSender({ ...configs.smsir, timeoutMs, ...(fetchFn ? { fetch: fetchFn } : {}) }) : null;
    case 'telnyx':
      return configs.telnyx ? new TelnyxSender({ ...configs.telnyx, timeoutMs, ...(fetchFn ? { fetch: fetchFn } : {}) }) : null;
  }
}

/** The JSON a process writes to `prov:applied`. */
export interface AppliedReport {
  atMs: number;
  hash: string;
  kinds: Partial<Record<ProviderKind, { source: ProviderSource; fp: string | null }>>;
  moderation?: { provider: string; autoApprove: boolean } | undefined;
  /** The process's own state (shared `ops/processes.ts`). */
  proc?: ProcessInfo | undefined;
}

export function reportOf(effective: EffectiveProviders, kinds: readonly ProviderKind[], atMs: number): AppliedReport {
  return {
    atMs,
    hash: effective.hash,
    kinds: Object.fromEntries(kinds.map((kind) => [kind, { source: effective.sources[kind], fp: effective.fingerprints[kind] }])),
  };
}

export const providersPlugin = fp<ProvidersOptions>(
  async (app, options) => {
    const env = apiEnvProviders(app.config);
    const processName = options.processName ?? `api:${hostname().slice(0, 48)}`;
    const startedAtMs = Date.now();
    const providerKeys = app.config.secrets.providerKeys;
    const sealer = providerKeys !== undefined ? new DataSealer(parseKeyRing(providerKeys, 'PROVIDER_KEYS'), app.config.secrets.providerKeyId) : null;
    const log = app.log.child({ component: 'providers' });
    if (!sealer) log.warn('providers: PROVIDER_KEYS is not set; panel entries are not read and cannot be saved');
    // What runs without a panel entry: the senders and verifiers built at start (the environment's, or a test's).
    const baseSenders = new Map(app.sms.senderList().map((sender) => [sender.name, sender]));
    const baseVerifiers: Partial<Record<AppStore, StoreVerifier>> = { ...app.store.verifiers };
    const factories = options.storeFactories ?? storeVerifierFactories;
    const authenticatorOf = (rtdn: { audience: string; pushServiceAccountEmail: string }): PubSubPushAuthenticator =>
      options.rtdnAuthenticator ? options.rtdnAuthenticator(rtdn) : new PubSubOidcVerifier({ audience: rtdn.audience, serviceAccountEmail: rtdn.pushServiceAccountEmail });
    const baseRtdn = (): { packageName: string; authenticator: PubSubPushAuthenticator } | null => {
      const play = app.config.store.play;
      return play?.rtdn ? { packageName: play.packageName, authenticator: authenticatorOf(play.rtdn) } : null;
    };
    let effective = effectiveProviders(env, {}, sealer);
    let appliedHash: string | null = null;
    let rtdn = baseRtdn();
    let builtPlay: string | null = null;

    const apply = (snapshot: ConfigSnapshot): void => {
      if (snapshot.providersHash === appliedHash) return;
      const before = effective;
      const next = effectiveProviders(env, snapshot.providers, sealer);
      for (const kind of providerKinds) {
        if (sealer && next.sources[kind] === 'unreadable' && before.sources[kind] !== 'unreadable') {
          log.error({ kind }, 'providers: the panel entry cannot be read (PROVIDER_KEYS changed?); the provider is off until it is saved again');
        }
      }
      // SMS: the panel's sender where one is set, none where it is off, the start's otherwise.
      const senders = new Map(baseSenders);
      for (const kind of SMS_KINDS) {
        const source = next.sources[kind];
        if (source === 'panel') {
          const unchanged = before.sources[kind] === 'panel' && before.fingerprints[kind] === next.fingerprints[kind] && JSON.stringify(before.configs[kind]) === JSON.stringify(next.configs[kind]);
          const current = app.sms.senderList().find((s) => s.name === kind);
          const sender = unchanged && current ? current : smsSender(kind, next.configs, app.config.sms.timeoutMs, options.fetch);
          if (sender) senders.set(kind, sender);
        } else if (source === 'off' || source === 'unreadable') {
          senders.delete(kind);
        }
      }
      app.sms.setSenders(senders.values());
      // Stores: the same, in place (routes read app.store.verifiers per call).
      for (const store of STORE_KINDS) {
        const source = next.sources[store];
        if (source === 'panel') {
          const same = before.sources[store] === 'panel' && JSON.stringify(before.configs[store]) === JSON.stringify(next.configs[store]);
          if (same && app.store.verifiers[store]) continue;
          try {
            const factory = factories[store];
            const verifier = factory ? factory({ ...app.config, store: { ...app.config.store, [store]: next.configs[store] } }, log, { redis: app.redis, keys: app.keys }) : null;
            if (verifier) app.store.verifiers[store] = verifier;
            else delete app.store.verifiers[store];
          } catch (error) {
            log.error({ err: error, store }, 'providers: the panel entry does not build a store client; the store is off');
            delete app.store.verifiers[store];
            next.sources[store] = 'unreadable';
            next.fingerprints[store] = null;
          }
        } else if (source === 'off' || source === 'unreadable') {
          delete app.store.verifiers[store];
        } else {
          const base = baseVerifiers[store];
          if (base) app.store.verifiers[store] = base;
          else delete app.store.verifiers[store];
        }
      }
      // Play's RTDN check follows the panel's Play entry.
      const play = next.sources.play === 'panel' ? next.configs.play : undefined;
      const playKey = play ? JSON.stringify([play.packageName, play.rtdn ?? null]) : `src:${next.sources.play}`;
      if (playKey !== builtPlay) {
        builtPlay = playKey;
        if (next.sources.play === 'panel' && play) {
          rtdn = play.rtdn ? { packageName: play.packageName, authenticator: authenticatorOf(play.rtdn) } : null;
        } else if (next.sources.play === 'off' || next.sources.play === 'unreadable') {
          rtdn = null;
        } else {
          rtdn = baseRtdn();
        }
      }
      effective = next;
      appliedHash = snapshot.providersHash;
      log.info({ sources: next.sources }, 'providers: applied');
    };

    const processState = (): ProcessInfo => {
      const roles = app.adminAuth.roles.state();
      return { kind: 'api', startedAtMs, cfgVersion: app.cfg.peek()?.version ?? null, rolesVersion: roles.version, rolesFailing: roles.failing };
    };

    let closing = false;
    const report = async (): Promise<void> => {
      if (closing || app.redis.status !== 'ready') return;
      const body: AppliedReport = { ...reportOf(effective, providerKinds.filter((kind) => kind !== 'fcm'), Date.now()), proc: processState() };
      await app.redis.hset(app.keys.providersApplied(), processName, JSON.stringify(body)).catch((error: unknown) => log.debug({ err: error }, 'providers: report not written'));
    };

    app.decorate('providers', {
      env,
      processName,
      sealer,
      current: () => effective,
      playRtdn: () => rtdn,
    });

    let timer: NodeJS.Timeout | null = null;
    app.addHook('onReady', async () => {
      // Every load reports: the providers it applied and the settings version it now holds.
      app.cfg.onLoad((snapshot) => {
        apply(snapshot);
        void report();
      });
      app.adminAuth.roles.onLoaded(() => void report());
      timer = setInterval(() => void report(), options.reportEveryMs ?? PROCESS_REPORT_EVERY_MS);
      timer.unref();
      if (app.redis.status !== 'ready') app.redis.once('ready', () => void report());
    });
    // Before the connections close: a process that stops takes its report with it.
    app.addHook('preClose', async () => {
      closing = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (app.redis.status === 'ready') {
        await app.redis.hdel(app.keys.providersApplied(), processName).catch((error: unknown) => log.debug({ err: error }, 'providers: report not removed'));
      }
    });
    app.addHook('onClose', async () => {
      if (timer) clearInterval(timer);
    });
  },
  { name: 'providers', fastify: '5.x', dependencies: ['store', 'auth-services', 'admin-auth'] },
);

