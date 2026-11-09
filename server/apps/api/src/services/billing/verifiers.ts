import type { AppStore } from '@app/shared';
import type { KeyBuilder, StoreVerifier } from '@app/shared/server';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type { ApiConfig } from '../../config.js';
import { bazaarVerifierFactory } from './bazaar/index.js';
import { playVerifierFactory } from './play/index.js';

/**
 * The store integrations this process runs, from its configuration. A store
 * without one answers 503 `store_unavailable` on its purchase routes and
 * gives `unavailable` for its tokens in a restore; nothing else changes.
 *
 * Each store's integration is built here from `config.store.<store>` (the
 * Google Play client and Pub/Sub verifier, the Cafe Bazaar client and RSA
 * check) and implements `StoreVerifier` from `@app/shared/server`.
 */
export type StoreVerifiers = Partial<Record<AppStore, StoreVerifier>>;

/** What a store integration may use besides its configuration: kv-core (call counters shared by every process) and the key names. */
export interface StoreVerifierDeps {
  redis: Redis;
  keys: KeyBuilder;
}

export type StoreVerifierFactory = (config: ApiConfig, log: FastifyBaseLogger, deps: StoreVerifierDeps) => StoreVerifier | null;

/** One factory per store; a store integration registers its own. */
export const storeVerifierFactories: Partial<Record<AppStore, StoreVerifierFactory>> = {
  bazaar: bazaarVerifierFactory,
  play: playVerifierFactory,
};

export function storeVerifiersFrom(config: ApiConfig, log: FastifyBaseLogger, deps: StoreVerifierDeps): StoreVerifiers {
  const out: StoreVerifiers = {};
  for (const store of ['play', 'bazaar'] as const) {
    const configured = config.store[store] !== undefined;
    const factory = storeVerifierFactories[store];
    if (!configured) continue;
    if (!factory) {
      log.warn({ store }, 'store: credentials are set but this build has no integration for the store; its purchases answer 503');
      continue;
    }
    const verifier = factory(config, log, deps);
    if (verifier) out[store] = verifier;
  }
  return out;
}
