import { z } from 'zod';
import { ConfigError, type ConfigIssue } from './env.js';

/**
 * Store credentials (API and worker). Every variable is optional: a store
 * whose variables are missing is "not configured", its purchase routes
 * answer 503 `store_unavailable` and its jobs wait, while the rest of the
 * API runs. Values are secrets or close to it: messages name the variable
 * and the problem, never the value.
 *
 * Google Play: the package name and a service account with access to the
 * Play Developer API; RTDN (Pub/Sub push) also needs the OIDC audience the
 * push subscription was created with and the push service account's e-mail.
 * Cafe Bazaar: the package name, the app's RSA public key (base64 DER, as
 * Pishkhan shows it) and either the Pishkhan API token or the older OAuth
 * client with its refresh token.
 */

const packageName = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/, 'must be an Android application id such as com.example.app');

export const storeEnvShape = {
  PLAY_PACKAGE_NAME: packageName.optional(),
  /** Service-account JSON (raw, or base64 of it) with access to the Play Developer API. */
  PLAY_SERVICE_ACCOUNT_JSON: z.string().min(2).optional(),
  /** The audience the Pub/Sub push subscription puts in its OIDC token (we use the full RTDN URL). */
  PLAY_RTDN_AUDIENCE: z.string().min(8).max(500).optional(),
  /** The service account the push subscription authenticates as (the token's `email`). */
  PLAY_RTDN_PUSH_SA_EMAIL: z.email().optional(),
  BAZAAR_PACKAGE_NAME: packageName.optional(),
  /** The app's RSA public key from Pishkhan (base64 of the X.509 DER). Public, but kept with the rest. */
  BAZAAR_RSA_PUBLIC_KEY: z
    .string()
    .transform((value) => value.replace(/\s+/g, ''))
    .pipe(z.string().regex(/^[A-Za-z0-9+/]{100,2000}={0,2}$/, 'must be the base64 public key Pishkhan shows'))
    .optional(),
  /** The Pishkhan API token (`CAFEBAZAAR-PISHKHAN-API-SECRET` header). */
  BAZAAR_PISHKHAN_API_TOKEN: z.string().min(8).optional(),
  /** The older OAuth client of the developer API, with a refresh token; used only without the Pishkhan token. */
  BAZAAR_CLIENT_ID: z.string().min(4).optional(),
  BAZAAR_CLIENT_SECRET: z.string().min(8).optional(),
  BAZAAR_REFRESH_TOKEN: z.string().min(8).optional(),
};

type StoreEnv = {
  PLAY_PACKAGE_NAME?: string | undefined;
  PLAY_SERVICE_ACCOUNT_JSON?: string | undefined;
  PLAY_RTDN_AUDIENCE?: string | undefined;
  PLAY_RTDN_PUSH_SA_EMAIL?: string | undefined;
  BAZAAR_PACKAGE_NAME?: string | undefined;
  BAZAAR_RSA_PUBLIC_KEY?: string | undefined;
  BAZAAR_PISHKHAN_API_TOKEN?: string | undefined;
  BAZAAR_CLIENT_ID?: string | undefined;
  BAZAAR_CLIENT_SECRET?: string | undefined;
  BAZAAR_REFRESH_TOKEN?: string | undefined;
};

/** A Google service account: what signs the OAuth assertion of the Play Developer API. */
export interface GoogleServiceAccount {
  clientEmail: string;
  privateKey: string;
  privateKeyId: string | undefined;
  /** `token_uri` of the JSON (Google's OAuth token endpoint). */
  tokenUri: string;
}

export interface PlayStoreConfig {
  packageName: string;
  serviceAccount: GoogleServiceAccount;
  /** Undefined: RTDN pushes are refused (503) until both values are set. */
  rtdn: { audience: string; pushServiceAccountEmail: string } | undefined;
}

export type BazaarAuth =
  | { kind: 'pishkhan'; token: string }
  | { kind: 'oauth'; clientId: string; clientSecret: string; refreshToken: string };

export interface BazaarStoreConfig {
  packageName: string;
  /** base64 DER (X.509 SubjectPublicKeyInfo). */
  rsaPublicKey: string;
  auth: BazaarAuth;
}

export interface StoreConfig {
  play: PlayStoreConfig | undefined;
  bazaar: BazaarStoreConfig | undefined;
}

const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

/** Service-account JSON (raw or base64); throws an Error that names no value. */
export function parseGoogleServiceAccount(raw: string, variable: string): GoogleServiceAccount {
  const text = raw.trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.startsWith('{') ? text : Buffer.from(text, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error(`${variable} is not service-account JSON`);
  }
  const email = parsed['client_email'];
  const key = parsed['private_key'];
  if (typeof email !== 'string' || !email.includes('@') || typeof key !== 'string' || !key.includes('PRIVATE KEY')) {
    throw new Error(`${variable} lacks client_email or private_key`);
  }
  const tokenUri = parsed['token_uri'];
  const keyId = parsed['private_key_id'];
  return {
    clientEmail: email,
    privateKey: key.includes('\\n') ? key.replaceAll('\\n', '\n') : key,
    privateKeyId: typeof keyId === 'string' ? keyId : undefined,
    tokenUri: typeof tokenUri === 'string' && z.url({ protocol: /^https$/ }).safeParse(tokenUri).success ? tokenUri : GOOGLE_TOKEN_URI,
  };
}

/** The variables of each store, for checks and docs. */
export const PLAY_ENV = ['PLAY_PACKAGE_NAME', 'PLAY_SERVICE_ACCOUNT_JSON', 'PLAY_RTDN_AUDIENCE', 'PLAY_RTDN_PUSH_SA_EMAIL'] as const;
export const BAZAAR_ENV = [
  'BAZAAR_PACKAGE_NAME',
  'BAZAAR_RSA_PUBLIC_KEY',
  'BAZAAR_PISHKHAN_API_TOKEN',
  'BAZAAR_CLIENT_ID',
  'BAZAAR_CLIENT_SECRET',
  'BAZAAR_REFRESH_TOKEN',
] as const;

/** Which stores are configured; throws ConfigError when a store's variables are half set. */
export function storeConfigOf(env: StoreEnv): StoreConfig {
  const issues: ConfigIssue[] = [];
  let play: PlayStoreConfig | undefined;
  const playCore = [env.PLAY_PACKAGE_NAME, env.PLAY_SERVICE_ACCOUNT_JSON];
  const rtdn = [env.PLAY_RTDN_AUDIENCE, env.PLAY_RTDN_PUSH_SA_EMAIL];
  if (playCore.some((v) => v !== undefined) && playCore.some((v) => v === undefined)) {
    issues.push({ variable: env.PLAY_PACKAGE_NAME === undefined ? 'PLAY_PACKAGE_NAME' : 'PLAY_SERVICE_ACCOUNT_JSON', message: 'PLAY_PACKAGE_NAME and PLAY_SERVICE_ACCOUNT_JSON come together' });
  }
  if (rtdn.some((v) => v !== undefined) && rtdn.some((v) => v === undefined)) {
    issues.push({ variable: env.PLAY_RTDN_AUDIENCE === undefined ? 'PLAY_RTDN_AUDIENCE' : 'PLAY_RTDN_PUSH_SA_EMAIL', message: 'PLAY_RTDN_AUDIENCE and PLAY_RTDN_PUSH_SA_EMAIL come together' });
  }
  if (rtdn.every((v) => v !== undefined) && env.PLAY_PACKAGE_NAME === undefined) {
    issues.push({ variable: 'PLAY_PACKAGE_NAME', message: 'required with PLAY_RTDN_AUDIENCE' });
  }
  if (env.PLAY_PACKAGE_NAME !== undefined && env.PLAY_SERVICE_ACCOUNT_JSON !== undefined) {
    try {
      play = {
        packageName: env.PLAY_PACKAGE_NAME,
        serviceAccount: parseGoogleServiceAccount(env.PLAY_SERVICE_ACCOUNT_JSON, 'PLAY_SERVICE_ACCOUNT_JSON'),
        rtdn:
          env.PLAY_RTDN_AUDIENCE !== undefined && env.PLAY_RTDN_PUSH_SA_EMAIL !== undefined
            ? { audience: env.PLAY_RTDN_AUDIENCE, pushServiceAccountEmail: env.PLAY_RTDN_PUSH_SA_EMAIL }
            : undefined,
      };
    } catch (error) {
      issues.push({ variable: 'PLAY_SERVICE_ACCOUNT_JSON', message: (error as Error).message });
    }
  }

  let bazaar: BazaarStoreConfig | undefined;
  const oauth = [env.BAZAAR_CLIENT_ID, env.BAZAAR_CLIENT_SECRET, env.BAZAAR_REFRESH_TOKEN];
  if (oauth.some((v) => v !== undefined) && oauth.some((v) => v === undefined)) {
    issues.push({ variable: 'BAZAAR_CLIENT_ID', message: 'BAZAAR_CLIENT_ID, BAZAAR_CLIENT_SECRET and BAZAAR_REFRESH_TOKEN come together' });
  }
  const auth: BazaarAuth | undefined =
    env.BAZAAR_PISHKHAN_API_TOKEN !== undefined
      ? { kind: 'pishkhan', token: env.BAZAAR_PISHKHAN_API_TOKEN }
      : env.BAZAAR_CLIENT_ID !== undefined && env.BAZAAR_CLIENT_SECRET !== undefined && env.BAZAAR_REFRESH_TOKEN !== undefined
        ? { kind: 'oauth', clientId: env.BAZAAR_CLIENT_ID, clientSecret: env.BAZAAR_CLIENT_SECRET, refreshToken: env.BAZAAR_REFRESH_TOKEN }
        : undefined;
  const bazaarSet = [env.BAZAAR_PACKAGE_NAME, env.BAZAAR_RSA_PUBLIC_KEY, auth];
  if (bazaarSet.some((v) => v !== undefined) && bazaarSet.some((v) => v === undefined)) {
    if (env.BAZAAR_PACKAGE_NAME === undefined) issues.push({ variable: 'BAZAAR_PACKAGE_NAME', message: 'required with the other BAZAAR_* variables' });
    if (env.BAZAAR_RSA_PUBLIC_KEY === undefined) issues.push({ variable: 'BAZAAR_RSA_PUBLIC_KEY', message: 'required with the other BAZAAR_* variables' });
    if (auth === undefined) issues.push({ variable: 'BAZAAR_PISHKHAN_API_TOKEN', message: 'required with the other BAZAAR_* variables (or the BAZAAR_CLIENT_* trio)' });
  }
  if (env.BAZAAR_PACKAGE_NAME !== undefined && env.BAZAAR_RSA_PUBLIC_KEY !== undefined && auth !== undefined) {
    bazaar = { packageName: env.BAZAAR_PACKAGE_NAME, rsaPublicKey: env.BAZAAR_RSA_PUBLIC_KEY, auth };
  }
  if (issues.length > 0) throw new ConfigError(issues);
  return { play, bazaar };
}
