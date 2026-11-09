import { PlayDeveloperApi, PlayStoreVerifier } from '@app/shared/server';
import type { StoreVerifierFactory } from '../verifiers.js';

/**
 * Google Play in the API: the Developer API client on the service account of
 * `PLAY_SERVICE_ACCOUNT_JSON`, behind the purchase core's `StoreVerifier`.
 * A purchase waits on Google inside the request, so its deadlines are short:
 * 4 s an attempt, one retry of a read, 8 s in all; past them the app gets
 * 503 `store_unavailable` and sends the purchase again later.
 */
export const playVerifierFactory: StoreVerifierFactory = (config) => {
  const play = config.store.play;
  if (!play) return null;
  return new PlayStoreVerifier({
    api: new PlayDeveloperApi({ packageName: play.packageName, account: play.serviceAccount, timeoutMs: 4_000, totalTimeoutMs: 8_000, retries: 1 }),
  });
};
