import { createHash, createPublicKey } from 'node:crypto';
import { providerKinds, providerSecretFields, providerSecretSchemas, providerSettingsSchemas, type ProviderKind, type ProviderSource } from '@app/shared';
import { z } from 'zod';
import { GOOGLE_TOKEN_URI, parseGoogleServiceAccount, type BazaarStoreConfig, type GoogleServiceAccount, type PlayStoreConfig } from './store.js';

/**
 * Provider credentials the admin panel saves (app_config `providers.<kind>`),
 * next to the deployment's own (the environment). Shared by the API and the
 * worker, so both read a stored entry the same way.
 *
 * A stored entry is `{ v: 1, enabled, settings, secrets }`: `settings` in
 * clear (template names, package names, the Bazaar public key), `secrets`
 * one sealed JSON object (AES-256-GCM under PROVIDER_KEYS, purpose
 * `providers.<kind>.secrets`, so a blob copied to another kind does not
 * open). Per kind, all or nothing: a stored entry replaces that kind's
 * environment values entirely; `enabled: false` turns the provider off even
 * where the environment has it; an entry that cannot be opened (PROVIDER_KEYS
 * changed) or no longer loads turns it off too (`unreadable`), never back
 * to the environment silently. No entry: the environment's values.
 *
 * Secrets never leave as text: reads and audit rows carry their
 * fingerprints (`providerFingerprint`), and every error here names a field,
 * never a value.
 */

export interface ProviderSealer {
  seal(plaintext: string, purpose: string): Buffer;
  openText(sealed: Uint8Array, purpose: string): string;
}

export interface FcmAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  privateKeyId?: string | undefined;
}

/** Each kind's configuration as its client takes it. */
export interface ProviderConfigs {
  kavenegar: { apiKey: string; template: string };
  smsir: { apiKey: string; templateId: number; parameter: string };
  telnyx: { apiKey: string; verifyProfileId: string };
  play: PlayStoreConfig;
  bazaar: BazaarStoreConfig;
  fcm: FcmAccount;
}

/** What the deployment's environment gives, per kind (absent: not set). */
export type EnvProviders = Partial<ProviderConfigs>;

export interface EffectiveProviders {
  sources: Record<ProviderKind, ProviderSource>;
  configs: Partial<ProviderConfigs>;
  /** The fingerprint of each kind's main secret as used now (null: none in use). */
  fingerprints: Record<ProviderKind, string | null>;
  /** Changes when a stored entry changes. */
  hash: string;
}

/** A refused provider write: the JSON pointer into the body and the admin field code. */
export class ProviderSettingsError extends Error {
  readonly pointer: string;
  readonly code: 'invalid' | 'secret_required' | 'credentials_invalid';

  constructor(pointer: string, code: 'invalid' | 'secret_required' | 'credentials_invalid', message: string) {
    super(message);
    this.name = 'ProviderSettingsError';
    this.pointer = pointer;
    this.code = code;
  }
}

export function providerConfigKey(kind: ProviderKind): string {
  return `providers.${kind}`;
}

export function providerSecretPurpose(kind: ProviderKind): string {
  return `providers.${kind}.secrets`;
}

export const providerConfigKeys: readonly string[] = providerKinds.map(providerConfigKey);

/** The first 12 hex digits of the SHA-256 of a secret (as `printf %s "$KEY" | sha256sum | cut -c1-12`). */
export function providerFingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 12);
}

/** A service account for FCM: Google's JSON (raw or base64) with its project; throws naming no value. */
export function parseFcmAccount(raw: string, projectId: string | null | undefined, field = 'serviceAccountJson'): FcmAccount {
  const account = parseGoogleServiceAccount(raw, field);
  const text = raw.trim();
  let project: unknown;
  try {
    project = (JSON.parse(text.startsWith('{') ? text : Buffer.from(text, 'base64').toString('utf8')) as Record<string, unknown>)['project_id'];
  } catch {
    project = undefined;
  }
  const chosen = projectId ?? (typeof project === 'string' ? project : undefined);
  if (!chosen) throw new Error(`${field} lacks project_id`);
  return { projectId: chosen, clientEmail: account.clientEmail, privateKey: account.privateKey, privateKeyId: account.privateKeyId };
}

/** The fingerprint a secret field is shown by: a service account's is its private key's. */
export function secretFieldFingerprint(field: string, value: string): string {
  if (field === 'serviceAccountJson') {
    try {
      return providerFingerprint(parseGoogleServiceAccount(value, field).privateKey);
    } catch {
      return providerFingerprint(value);
    }
  }
  return providerFingerprint(value);
}

/** The main secret of each kind's configuration, by its fingerprint. */
export function mainFingerprint<K extends ProviderKind>(kind: K, config: ProviderConfigs[K]): string {
  switch (kind) {
    case 'kavenegar':
    case 'smsir':
    case 'telnyx':
      return providerFingerprint((config as ProviderConfigs['kavenegar']).apiKey);
    case 'play':
      return providerFingerprint((config as PlayStoreConfig).serviceAccount.privateKey);
    case 'fcm':
      return providerFingerprint((config as FcmAccount).privateKey);
    case 'bazaar': {
      const auth = (config as BazaarStoreConfig).auth;
      return providerFingerprint(auth.kind === 'pishkhan' ? auth.token : auth.refreshToken);
    }
  }
  throw new Error(`unknown provider kind ${String(kind)}`);
}

const storedSchema = z.looseObject({
  enabled: z.boolean(),
  settings: z.record(z.string(), z.unknown()),
  secrets: z.string().nullable().optional(),
});

export interface OpenedProvider {
  enabled: boolean;
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
}

/** A stored entry, its secrets opened; null for none, `unreadable` for one that does not parse or open. */
export function openStoredProvider(kind: ProviderKind, value: unknown, sealer: ProviderSealer | null): OpenedProvider | 'unreadable' | null {
  if (value === undefined || value === null) return null;
  const parsed = storedSchema.safeParse(value);
  if (!parsed.success) return 'unreadable';
  let secrets: Record<string, string> = {};
  if (parsed.data.secrets) {
    if (!sealer) return 'unreadable';
    try {
      const opened = JSON.parse(sealer.openText(Buffer.from(parsed.data.secrets, 'base64'), providerSecretPurpose(kind))) as unknown;
      const fields = z.record(z.string(), z.string()).safeParse(opened);
      if (!fields.success) return 'unreadable';
      secrets = fields.data;
    } catch {
      return 'unreadable';
    }
  }
  return { enabled: parsed.data.enabled, settings: parsed.data.settings, secrets };
}

function required(secrets: Record<string, string>, name: string): string {
  const value = secrets[name];
  if (!value) throw new ProviderSettingsError(`/secrets/${name}`, 'secret_required', `${name} is required`);
  return value;
}

/**
 * A kind's client configuration from settings and secrets, checked: a missing
 * secret is `secret_required`, a service account or key that does not load
 * `credentials_invalid`, a malformed setting `invalid` (pointers into a
 * provider write's body).
 */
export function providerConfigOf<K extends ProviderKind>(kind: K, settingsIn: Record<string, unknown>, secrets: Record<string, string>): ProviderConfigs[K] {
  const parsed = providerSettingsSchemas[kind].safeParse(settingsIn);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join('/') ?? '';
    throw new ProviderSettingsError(`/settings${path ? `/${path}` : ''}`, 'invalid', 'a setting is not valid');
  }
  const settings = parsed.data as Record<string, unknown>;
  switch (kind) {
    case 'kavenegar':
      return { apiKey: required(secrets, 'apiKey'), template: settings['template'] as string } as ProviderConfigs[K];
    case 'smsir':
      return { apiKey: required(secrets, 'apiKey'), templateId: settings['templateId'] as number, parameter: settings['parameter'] as string } as ProviderConfigs[K];
    case 'telnyx':
      return { apiKey: required(secrets, 'apiKey'), verifyProfileId: settings['verifyProfileId'] as string } as ProviderConfigs[K];
    case 'play': {
      const audience = settings['rtdnAudience'] as string | null;
      const email = settings['rtdnPushServiceAccountEmail'] as string | null;
      if ((audience === null) !== (email === null)) {
        throw new ProviderSettingsError(audience === null ? '/settings/rtdnAudience' : '/settings/rtdnPushServiceAccountEmail', 'invalid', 'the RTDN audience and e-mail come together');
      }
      let account: GoogleServiceAccount;
      try {
        account = parseGoogleServiceAccount(required(secrets, 'serviceAccountJson'), 'serviceAccountJson');
      } catch (error) {
        if (error instanceof ProviderSettingsError) throw error;
        throw new ProviderSettingsError('/secrets/serviceAccountJson', 'credentials_invalid', 'not a service account');
      }
      // Every token exchange goes to the account's token_uri: from the panel only Google's own is taken, so a pasted
      // file cannot point the API's and the worker's requests at another host.
      if (account.tokenUri !== GOOGLE_TOKEN_URI) {
        throw new ProviderSettingsError('/secrets/serviceAccountJson', 'credentials_invalid', 'the token_uri is not Google\'s');
      }
      const play: PlayStoreConfig = {
        packageName: settings['packageName'] as string,
        serviceAccount: account,
        rtdn: audience !== null && email !== null ? { audience, pushServiceAccountEmail: email } : undefined,
      };
      return play as ProviderConfigs[K];
    }
    case 'bazaar': {
      const rsaPublicKey = settings['rsaPublicKey'] as string;
      try {
        const key = createPublicKey({ key: Buffer.from(rsaPublicKey, 'base64'), format: 'der', type: 'spki' });
        if (key.asymmetricKeyType !== 'rsa') throw new Error('not rsa');
      } catch {
        throw new ProviderSettingsError('/settings/rsaPublicKey', 'credentials_invalid', 'not an RSA public key');
      }
      const auth: BazaarStoreConfig['auth'] =
        settings['auth'] === 'pishkhan'
          ? { kind: 'pishkhan', token: required(secrets, 'pishkhanToken') }
          : (() => {
              const clientId = settings['clientId'] as string | null;
              if (!clientId) throw new ProviderSettingsError('/settings/clientId', 'invalid', 'the OAuth client id is required');
              return { kind: 'oauth' as const, clientId, clientSecret: required(secrets, 'clientSecret'), refreshToken: required(secrets, 'refreshToken') };
            })();
      return { packageName: settings['packageName'] as string, rsaPublicKey, auth } as ProviderConfigs[K];
    }
    case 'fcm': {
      try {
        return parseFcmAccount(required(secrets, 'serviceAccountJson'), settings['projectId'] as string | null) as ProviderConfigs[K];
      } catch (error) {
        if (error instanceof ProviderSettingsError) throw error;
        throw new ProviderSettingsError('/secrets/serviceAccountJson', 'credentials_invalid', 'not a service account');
      }
    }
  }
  throw new Error(`unknown provider kind ${String(kind)}`);
}

/** The secret fields a kind keeps (Bazaar: those of its access kind only). */
function keptSecretFields(kind: ProviderKind, settings: Record<string, unknown>): readonly string[] {
  if (kind === 'bazaar') return settings['auth'] === 'pishkhan' ? ['pishkhanToken'] : ['clientSecret', 'refreshToken'];
  return providerSecretFields[kind];
}

/** The stored rows' hash: a process rebuilds its clients only when it moved. */
export function providersHash(stored: Readonly<Record<string, unknown>>): string {
  return createHash('sha256')
    .update(JSON.stringify(providerKinds.map((kind) => stored[providerConfigKey(kind)] ?? null)))
    .digest('base64url')
    .slice(0, 16);
}

/**
 * What a process uses for each kind: the stored entry (panel, off,
 * unreadable), else its environment's (env), else none.
 */
export function effectiveProviders(env: EnvProviders, stored: Readonly<Record<string, unknown>>, sealer: ProviderSealer | null): EffectiveProviders {
  const sources = {} as Record<ProviderKind, ProviderSource>;
  const fingerprints = {} as Record<ProviderKind, string | null>;
  const configs: Partial<ProviderConfigs> = {};
  for (const kind of providerKinds) {
    const raw = stored[providerConfigKey(kind)];
    const set = <K extends ProviderKind>(k: K, config: ProviderConfigs[K]) => {
      (configs as Record<K, ProviderConfigs[K]>)[k] = config;
      fingerprints[k] = mainFingerprint(k, config);
    };
    fingerprints[kind] = null;
    if (raw !== undefined && raw !== null) {
      const opened = openStoredProvider(kind, raw, sealer);
      if (opened === null) {
        sources[kind] = 'none';
      } else if (opened === 'unreadable') {
        sources[kind] = 'unreadable';
      } else if (!opened.enabled) {
        sources[kind] = 'off';
      } else {
        try {
          set(kind, providerConfigOf(kind, opened.settings, opened.secrets));
          sources[kind] = 'panel';
        } catch {
          sources[kind] = 'unreadable';
        }
      }
      continue;
    }
    const fromEnv = env[kind];
    if (fromEnv !== undefined) {
      set(kind, fromEnv);
      sources[kind] = 'env';
    } else {
      sources[kind] = 'none';
    }
  }
  return { sources, configs, fingerprints, hash: providersHash(stored) };
}

/** An entry as audit rows and reads show it: settings in clear, secrets by fingerprint. */
export interface ProviderAuditView {
  enabled: boolean;
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
}

export function auditViewOf(opened: OpenedProvider): ProviderAuditView {
  return {
    enabled: opened.enabled,
    settings: opened.settings,
    secrets: Object.fromEntries(Object.entries(opened.secrets).map(([name, value]) => [name, secretFieldFingerprint(name, value)])),
  };
}

export interface ProviderWrite {
  enabled: boolean;
  settings: Record<string, unknown>;
  secrets?: Record<string, string | undefined> | undefined;
}

export interface MergedProvider {
  /** The value to store. */
  value: { v: 1; enabled: boolean; settings: Record<string, unknown>; secrets: string };
  /** The fields that changed (`enabled`, `settings.<name>`, `secrets.<name>`); empty: nothing to write. */
  changed: string[];
  before: ProviderAuditView | null;
  after: ProviderAuditView;
}

/**
 * A provider write: the stored secrets opened, the sent ones laid over them
 * (a secret not sent is kept; one of the other Bazaar access kind is
 * dropped), the whole entry checked as the clients would load it, and the
 * secrets sealed again. Throws {@link ProviderSettingsError}.
 */
export function mergeProviderUpdate(kind: ProviderKind, storedValue: unknown, write: ProviderWrite, sealer: ProviderSealer): MergedProvider {
  const settingsParsed = providerSettingsSchemas[kind].safeParse(write.settings);
  if (!settingsParsed.success) {
    const path = settingsParsed.error.issues[0]?.path.join('/') ?? '';
    throw new ProviderSettingsError(`/settings${path ? `/${path}` : ''}`, 'invalid', 'a setting is not valid');
  }
  const settings = settingsParsed.data as Record<string, unknown>;
  const sent = providerSecretSchemas[kind].partial().safeParse(Object.fromEntries(Object.entries(write.secrets ?? {}).filter(([, v]) => v !== undefined && v !== '')));
  if (!sent.success) {
    const path = sent.error.issues[0]?.path.join('/') ?? '';
    throw new ProviderSettingsError(`/secrets${path ? `/${path}` : ''}`, 'invalid', 'a secret is not valid');
  }
  const opened = openStoredProvider(kind, storedValue, sealer);
  // Secrets that cannot be opened are not kept: every one is typed again.
  const storedSecrets = opened && opened !== 'unreadable' ? opened.secrets : {};
  const kept = keptSecretFields(kind, settings);
  const merged: Record<string, string> = {};
  for (const name of kept) {
    const value = (sent.data as Record<string, string | undefined>)[name] ?? storedSecrets[name];
    if (value) merged[name] = value;
  }
  // Checked as the clients load it (a disabled entry too: turning it on later must not find it broken).
  providerConfigOf(kind, settings, merged);
  const before = opened && opened !== 'unreadable' ? auditViewOf(opened) : null;
  const after = auditViewOf({ enabled: write.enabled, settings, secrets: merged });
  const changed: string[] = [];
  if (before?.enabled !== after.enabled) changed.push('enabled');
  for (const name of new Set([...Object.keys(before?.settings ?? {}), ...Object.keys(after.settings)])) {
    if (JSON.stringify(before?.settings[name] ?? null) !== JSON.stringify(after.settings[name] ?? null)) changed.push(`settings.${name}`);
  }
  for (const name of new Set([...Object.keys(before?.secrets ?? {}), ...Object.keys(after.secrets)])) {
    if ((before?.secrets[name] ?? null) !== (after.secrets[name] ?? null)) changed.push(`secrets.${name}`);
  }
  if (opened === 'unreadable' && changed.length === 0) changed.push('secrets');
  return {
    value: { v: 1, enabled: write.enabled, settings, secrets: sealer.seal(JSON.stringify(merged), providerSecretPurpose(kind)).toString('base64') },
    changed,
    before,
    after,
  };
}
