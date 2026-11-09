import { BazaarVerifier, PardakhtClient, RedisBazaarCallMeter } from '@app/shared/server';
import type { IapIntegrationFactory } from './verifiers.js';

/**
 * Cafe Bazaar in the worker: the same verifier as the API's, its calls
 * marked `background` (re-checks at validUntil + 1 h, refund checks after
 * day 7, consumes, revokes), so they are paced per minute and held back near
 * the day's quota, which stays for purchases. Bazaar has no notifications,
 * so there is no `rtdn` or `voided` handler.
 */
export const bazaarIntegrationFactory: IapIntegrationFactory = (config, log, deps) => {
  const bazaar = config.store.bazaar;
  if (!bazaar) return null;
  const meter = new RedisBazaarCallMeter(deps.redis, deps.keys, {}, Date.now, (error) =>
    log.warn({ err: error }, 'bazaar: call counter unavailable; the call goes ahead uncounted'),
  );
  let verifier: BazaarVerifier;
  try {
    verifier = new BazaarVerifier({
      packageName: bazaar.packageName,
      rsaPublicKey: bazaar.rsaPublicKey,
      api: new PardakhtClient({ packageName: bazaar.packageName, auth: bazaar.auth, meter, timeoutMs: 15_000 }),
      log,
    });
  } catch (error) {
    throw new Error(`BAZAAR_RSA_PUBLIC_KEY: ${(error as Error).message}`, { cause: error });
  }
  return { verifier };
};
