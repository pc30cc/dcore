import { BazaarVerifier, PardakhtClient, RedisBazaarCallMeter, providerOutcome } from '@app/shared/server';
import type { StoreVerifierFactory } from '../verifiers.js';

/**
 * Cafe Bazaar in the API: the developer API client with the Pishkhan token
 * (or the older OAuth client), every call counted in kv-core against the
 * day's quota, and the RSA check of the app's public key. A key that is not
 * an RSA public key stops the process at start, naming the variable. The
 * panel's refund and stop of renewal are offered only as
 * BAZAAR_ADMIN_ACTIONS lists them.
 */
export const bazaarVerifierFactory: StoreVerifierFactory = (config, log, deps) => {
  const bazaar = config.store.bazaar;
  if (!bazaar) return null;
  const meter = new RedisBazaarCallMeter(deps.redis, deps.keys, {}, Date.now, (error) =>
    log.warn({ err: error }, 'bazaar: call counter unavailable; the call goes ahead uncounted'),
  );
  try {
    return new BazaarVerifier({
      packageName: bazaar.packageName,
      rsaPublicKey: bazaar.rsaPublicKey,
      api: new PardakhtClient({
        packageName: bazaar.packageName,
        auth: bazaar.auth,
        meter,
        onOutcome: providerOutcome(deps.redis, deps.keys, 'store', (error) => log.debug({ err: error }, 'store outcome not counted')),
      }),
      log,
      // Off unless BAZAAR_ADMIN_ACTIONS turns them on (their shapes are confirmed on a sandbox first).
      adminActions: config.bazaarAdminActions,
    });
  } catch (error) {
    throw new Error(`BAZAAR_RSA_PUBLIC_KEY: ${(error as Error).message}`, { cause: error });
  }
};
