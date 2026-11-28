import { providerSecretFields, type AdminProvider, type AdminProviderUpdate, type FieldIssue, type ProviderApplied, type ProviderKind, type ProviderSource, type SecretView } from '@app/shared';
import type { MessageKey } from '@/i18n/messages';
import { asciiDigits } from './format';

/**
 * The provider dialog's form: the kind's settings as typed (a number as
 * text, an empty optional field as null), the secrets typed now (a stored
 * one not typed is kept by the API) and which of them a save needs.
 */

export interface SettingField {
  name: string;
  label: MessageKey;
  input: 'text' | 'number' | 'email' | 'textarea';
  /** Empty: null (only fields the API takes as null). */
  optional?: boolean;
  /** Shown only with this Bazaar access kind. */
  auth?: BazaarAuth;
}

export interface SecretField {
  name: string;
  label: MessageKey;
  /** A service account (a JSON file's text), not a one-line key. */
  multiline?: boolean;
  auth?: BazaarAuth;
}

export type BazaarAuth = 'pishkhan' | 'oauth';
export const bazaarAuths: readonly BazaarAuth[] = ['pishkhan', 'oauth'];

export const providerName: Readonly<Record<ProviderKind, MessageKey>> = {
  kavenegar: 'provider.kavenegar',
  smsir: 'provider.smsir',
  telnyx: 'provider.telnyx',
  play: 'store.play',
  bazaar: 'store.bazaar',
  fcm: 'provider.fcm',
};

export const settingFields: Readonly<Record<ProviderKind, readonly SettingField[]>> = {
  kavenegar: [{ name: 'template', label: 'providers.field.template', input: 'text' }],
  smsir: [
    {
      name: 'templateId',
      label: 'providers.field.templateId',
      input: 'number',
    },
    { name: 'parameter', label: 'providers.field.parameter', input: 'text' },
  ],
  telnyx: [
    {
      name: 'verifyProfileId',
      label: 'providers.field.verifyProfileId',
      input: 'text',
    },
  ],
  play: [
    {
      name: 'packageName',
      label: 'providers.field.packageName',
      input: 'text',
    },
    {
      name: 'rtdnAudience',
      label: 'providers.field.rtdnAudience',
      input: 'text',
      optional: true,
    },
    {
      name: 'rtdnPushServiceAccountEmail',
      label: 'providers.field.rtdnEmail',
      input: 'email',
      optional: true,
    },
  ],
  bazaar: [
    {
      name: 'packageName',
      label: 'providers.field.packageName',
      input: 'text',
    },
    {
      name: 'rsaPublicKey',
      label: 'providers.field.rsaPublicKey',
      input: 'textarea',
    },
    {
      name: 'clientId',
      label: 'providers.field.clientId',
      input: 'text',
      optional: true,
      auth: 'oauth',
    },
  ],
  fcm: [
    {
      name: 'projectId',
      label: 'providers.field.projectId',
      input: 'text',
      optional: true,
    },
  ],
};

export const secretFields: Readonly<Record<ProviderKind, readonly SecretField[]>> = {
  kavenegar: [{ name: 'apiKey', label: 'providers.field.apiKey' }],
  smsir: [{ name: 'apiKey', label: 'providers.field.apiKey' }],
  telnyx: [{ name: 'apiKey', label: 'providers.field.apiKey' }],
  play: [
    {
      name: 'serviceAccountJson',
      label: 'providers.field.serviceAccount',
      multiline: true,
    },
  ],
  bazaar: [
    {
      name: 'pishkhanToken',
      label: 'providers.field.pishkhanToken',
      auth: 'pishkhan',
    },
    {
      name: 'clientSecret',
      label: 'providers.field.clientSecret',
      auth: 'oauth',
    },
    {
      name: 'refreshToken',
      label: 'providers.field.refreshToken',
      auth: 'oauth',
    },
  ],
  fcm: [
    {
      name: 'serviceAccountJson',
      label: 'providers.field.serviceAccount',
      multiline: true,
    },
  ],
};

/** What a new entry starts from when neither the panel nor the deployment has one. */
const DEFAULTS: Readonly<Record<ProviderKind, Readonly<Record<string, string>>>> = {
  kavenegar: { template: '' },
  smsir: { templateId: '', parameter: 'CODE' },
  telnyx: { verifyProfileId: '' },
  play: { packageName: '', rtdnAudience: '', rtdnPushServiceAccountEmail: '' },
  bazaar: { packageName: '', rsaPublicKey: '', auth: 'pishkhan', clientId: '' },
  fcm: { projectId: '' },
};

export interface ProviderForm {
  enabled: boolean;
  settings: Record<string, string>;
  /** Typed now; empty keeps the stored one. */
  secrets: Record<string, string>;
}

const asText = (value: string | number | boolean | null | undefined) => (value === null || value === undefined ? '' : String(value));

/** The dialog starts from the panel's entry, else the deployment's values, else the kind's defaults. */
export function providerFormOf(provider: AdminProvider): ProviderForm {
  const from = provider.panel?.settings ?? provider.env.settings ?? {};
  const settings: Record<string, string> = { ...DEFAULTS[provider.kind] };
  for (const name of Object.keys(settings)) if (name in from) settings[name] = asText(from[name]);
  return { enabled: provider.panel?.enabled ?? true, settings, secrets: {} };
}

export const authOf = (form: ProviderForm): BazaarAuth => (form.settings['auth'] === 'oauth' ? 'oauth' : 'pishkhan');

/** The fields shown for the form's Bazaar access kind (every field for the other kinds). */
export function shownSettings(kind: ProviderKind, form: ProviderForm): readonly SettingField[] {
  return settingFields[kind].filter((field) => !field.auth || field.auth === authOf(form));
}
export function shownSecrets(kind: ProviderKind, form: ProviderForm): readonly SecretField[] {
  return secretFields[kind].filter((field) => !field.auth || field.auth === authOf(form));
}

/** The stored panel secret of a field, when it can still be used (an unreadable one is typed again). */
export function storedSecret(provider: AdminProvider, name: string): SecretView | null {
  const view = provider.panel?.secrets[name];
  return view && view.set && !view.unreadable ? view : null;
}

/** The secrets a save cannot do without: shown ones neither stored nor typed. */
export function missingSecrets(provider: AdminProvider, form: ProviderForm): string[] {
  return shownSecrets(provider.kind, form)
    .filter((field) => !storedSecret(provider, field.name) && !form.secrets[field.name]?.trim())
    .map((field) => field.name);
}

/** The settings as the API takes them: numbers as numbers, an empty optional field null. */
export function providerSettingsValue(kind: ProviderKind, form: ProviderForm): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const field of settingFields[kind]) {
    const text = (form.settings[field.name] ?? '').trim();
    if (field.input === 'number') out[field.name] = Number(asciiDigits(text));
    else if (field.input === 'textarea') out[field.name] = text.replace(/\s+/g, '');
    else out[field.name] = field.optional && text === '' ? null : text;
  }
  if (kind === 'bazaar') {
    out['auth'] = authOf(form);
    if (authOf(form) === 'pishkhan') out['clientId'] = null;
  }
  return out;
}

/** Settings the dialog refuses before asking: a required one left empty, a number that is not one. */
export function settingProblems(kind: ProviderKind, form: ProviderForm): Record<string, MessageKey> {
  const problems: Record<string, MessageKey> = {};
  for (const field of shownSettings(kind, form)) {
    const text = (form.settings[field.name] ?? '').trim();
    if (!text) {
      if (!field.optional || (kind === 'bazaar' && field.name === 'clientId')) problems[`settings/${field.name}`] = 'form.required';
    } else if (field.input === 'number' && !/^\d{1,10}$/.test(asciiDigits(text))) {
      problems[`settings/${field.name}`] = 'appConfig.error.invalid';
    }
  }
  return problems;
}

export function providerBody(provider: AdminProvider, form: ProviderForm): AdminProviderUpdate {
  const typed: Record<string, string> = {};
  for (const field of shownSecrets(provider.kind, form)) {
    const value = form.secrets[field.name]?.trim();
    if (value) typed[field.name] = value;
  }
  return {
    kind: provider.kind,
    baseVersion: provider.version,
    enabled: form.enabled,
    settings: providerSettingsValue(provider.kind, form),
    ...(Object.keys(typed).length > 0 ? { secrets: typed } : {}),
  } as AdminProviderUpdate;
}

/** A refusal's field issues by the dialog's fields (`settings/<name>`, `secrets/<name>`). */
export function providerServerProblems(issues: readonly FieldIssue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) out[issue.pointer.replace(/^\//, '')] = issue.code;
  return out;
}

/** The field whose fingerprint names what a process uses (the API's main secret of the kind). */
export function mainSecretField(kind: ProviderKind, auth: BazaarAuth): string {
  if (kind === 'bazaar') return auth === 'pishkhan' ? 'pishkhanToken' : 'refreshToken';
  return providerSecretFields[kind][0];
}

/** The values a row shows: the panel's for an entry, the deployment's otherwise. */
export function shownValues(provider: AdminProvider): {
  settings: AdminProvider['env']['settings'];
  secrets: Record<string, SecretView>;
  account?: AdminProvider['env']['account'];
} | null {
  if (provider.panel)
    return {
      settings: provider.panel.settings,
      secrets: provider.panel.secrets,
      account: provider.panel.account,
    };
  if (provider.env.set)
    return {
      settings: provider.env.settings,
      secrets: provider.env.secrets ?? {},
      account: provider.env.account,
    };
  return null;
}

export const providerTone: Readonly<Record<ProviderSource, 'success' | 'muted' | 'destructive' | 'secondary' | 'outline'>> = {
  panel: 'success',
  env: 'secondary',
  off: 'muted',
  unreadable: 'destructive',
  none: 'outline',
};

/**
 * What the running processes use: how many API and worker processes report
 * the source and fingerprint this page shows, and how many report another
 * (an older entry, until they reload).
 */
export function appliedSummary(provider: AdminProvider): {
  api: number;
  worker: number;
  older: number;
} {
  const shown = shownValues(provider);
  const auth: BazaarAuth = shown?.settings?.['auth'] === 'oauth' ? 'oauth' : 'pishkhan';
  const expected = shown?.secrets[mainSecretField(provider.kind, auth)]?.fingerprint ?? null;
  const live = (a: ProviderApplied) => a.source === 'panel' || a.source === 'env';
  const current = (a: ProviderApplied) => a.source === provider.source && (expected === null || a.fingerprint === null || a.fingerprint === expected);
  const using = provider.applied.filter(live);
  return {
    api: using.filter((a) => a.process === 'api' && current(a)).length,
    worker: using.filter((a) => a.process === 'worker' && current(a)).length,
    older: provider.applied.filter((a) => !current(a)).length,
  };
}

/** The kinds whose API is the store's: a package change moves where purchases are checked. */
export const storeKinds: readonly ProviderKind[] = ['play', 'bazaar'];
