import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, storeConfigOf } from '../src/index.js';

/**
 * Store credentials: every store is optional, a half-set store stops the
 * process with the variable's name, and no message carries a value.
 */

const serviceAccount = JSON.stringify({
  type: 'service_account',
  client_email: 'billing@project.iam.gserviceaccount.com',
  private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  private_key_id: 'k1',
});
const rsaKey = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function issues(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error.issues.map((i) => `${i.variable}: ${i.message}`);
    throw error;
  }
  return [];
}

describe('store credentials', () => {
  it('leaves both stores unconfigured when nothing is set', () => {
    expect(storeConfigOf({})).toEqual({ play: undefined, bazaar: undefined });
  });

  it('reads Google Play (raw or base64 JSON) with and without RTDN', () => {
    const play = storeConfigOf({ PLAY_PACKAGE_NAME: 'app.example.play', PLAY_SERVICE_ACCOUNT_JSON: Buffer.from(serviceAccount).toString('base64') }).play;
    expect(play).toMatchObject({ packageName: 'app.example.play', serviceAccount: { clientEmail: 'billing@project.iam.gserviceaccount.com', tokenUri: 'https://oauth2.googleapis.com/token' }, rtdn: undefined });
    const withRtdn = storeConfigOf({
      PLAY_PACKAGE_NAME: 'app.example.play',
      PLAY_SERVICE_ACCOUNT_JSON: serviceAccount,
      PLAY_RTDN_AUDIENCE: 'https://api.example.com/v1/webhooks/play/rtdn',
      PLAY_RTDN_PUSH_SA_EMAIL: 'push@project.iam.gserviceaccount.com',
    }).play;
    expect(withRtdn?.rtdn).toEqual({ audience: 'https://api.example.com/v1/webhooks/play/rtdn', pushServiceAccountEmail: 'push@project.iam.gserviceaccount.com' });
  });

  it('reads Cafe Bazaar with the Pishkhan token, or the older OAuth client', () => {
    const token = storeConfigOf({ BAZAAR_PACKAGE_NAME: 'app.example.bazaar', BAZAAR_RSA_PUBLIC_KEY: rsaKey, BAZAAR_PISHKHAN_API_TOKEN: 'pishkhan-token-value' }).bazaar;
    expect(token?.auth).toEqual({ kind: 'pishkhan', token: 'pishkhan-token-value' });
    const oauth = storeConfigOf({
      BAZAAR_PACKAGE_NAME: 'app.example.bazaar',
      BAZAAR_RSA_PUBLIC_KEY: rsaKey,
      BAZAAR_CLIENT_ID: 'client-id',
      BAZAAR_CLIENT_SECRET: 'client-secret-value',
      BAZAAR_REFRESH_TOKEN: 'refresh-token-value',
    }).bazaar;
    expect(oauth?.auth.kind).toBe('oauth');
  });

  it('refuses a half-set store, naming the variables and never a value', () => {
    const found = [
      ...issues(() => storeConfigOf({ PLAY_PACKAGE_NAME: 'app.example.play' })),
      ...issues(() => storeConfigOf({ PLAY_PACKAGE_NAME: 'app.example.play', PLAY_SERVICE_ACCOUNT_JSON: '{"client_email":"secret-looking-value"}' })),
      ...issues(() => storeConfigOf({ PLAY_RTDN_AUDIENCE: 'https://api.example.com/rtdn' })),
      ...issues(() => storeConfigOf({ BAZAAR_PISHKHAN_API_TOKEN: 'pishkhan-token-value' })),
      ...issues(() => storeConfigOf({ BAZAAR_PACKAGE_NAME: 'app.example.bazaar', BAZAAR_RSA_PUBLIC_KEY: rsaKey, BAZAAR_CLIENT_ID: 'client-id' })),
    ];
    expect(found.some((i) => i.startsWith('PLAY_SERVICE_ACCOUNT_JSON'))).toBe(true);
    expect(found.some((i) => i.startsWith('PLAY_RTDN_PUSH_SA_EMAIL'))).toBe(true);
    expect(found.some((i) => i.startsWith('BAZAAR_RSA_PUBLIC_KEY'))).toBe(true);
    expect(found.some((i) => i.startsWith('BAZAAR_CLIENT_ID'))).toBe(true);
    for (const issue of found) {
      expect(issue).not.toContain('secret-looking-value');
      expect(issue).not.toContain('pishkhan-token-value');
    }
  });
});
