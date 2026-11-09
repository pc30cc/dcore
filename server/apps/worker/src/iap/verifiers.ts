import type { AppStore } from '@app/shared';
import type { KeyBuilder, RtdnJob, StoreVerifier } from '@app/shared/server';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { WorkerConfig } from '../config.js';
import type { JobContext } from '../queues/types.js';
import { bazaarIntegrationFactory } from './bazaar.js';
import { playIntegrationFactory } from './play.js';

/**
 * The store integrations of the worker: one `StoreVerifier` per configured
 * store (the same interface as the API's), plus Google Play's two jobs of
 * its own: a real-time developer notification (`rtdn`, decoded and turned
 * into a re-check of the token it names) and the daily voided-purchases
 * sweep (`voided`). Each store integration registers its factory here.
 */

export type RtdnHandler = (job: RtdnJob, context: JobContext) => Promise<Record<string, unknown>>;
export type VoidedHandler = (context: JobContext) => Promise<Record<string, unknown>>;

export interface IapServices {
  verifiers: Partial<Record<AppStore, StoreVerifier>>;
  rtdn?: RtdnHandler | undefined;
  voided?: VoidedHandler | undefined;
}

export interface IapIntegration {
  verifier: StoreVerifier;
  rtdn?: RtdnHandler | undefined;
  voided?: VoidedHandler | undefined;
}

/** What a store integration may use besides its configuration: kv-core (call counters shared by every process) and the key names. */
export interface IapIntegrationDeps {
  redis: Redis;
  keys: KeyBuilder;
}

export type IapIntegrationFactory = (config: WorkerConfig, log: Logger, deps: IapIntegrationDeps) => IapIntegration | null;

/** One factory per store; a store integration registers its own. */
export const iapIntegrationFactories: Partial<Record<AppStore, IapIntegrationFactory>> = {
  bazaar: bazaarIntegrationFactory,
  play: playIntegrationFactory,
};

export function iapServicesFrom(config: WorkerConfig, log: Logger, deps: IapIntegrationDeps): IapServices {
  const out: IapServices = { verifiers: {} };
  for (const store of ['play', 'bazaar'] as const) {
    if (config.store[store] === undefined) continue;
    const factory = iapIntegrationFactories[store];
    if (!factory) {
      log.warn({ store }, 'store: credentials are set but this build has no integration for the store; its iap jobs wait');
      continue;
    }
    const integration = factory(config, log, deps);
    if (!integration) continue;
    out.verifiers[store] = integration.verifier;
    if (integration.rtdn) out.rtdn = integration.rtdn;
    if (integration.voided) out.voided = integration.voided;
  }
  return out;
}
