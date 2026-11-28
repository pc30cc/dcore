import { ADMIN_CONFIG_BOUNDS, distanceUnits, locales, type AppConfig, type DistanceUnit, type FieldIssue, type Locale } from '@app/shared';
import type { MessageKey } from '@/i18n/messages';
import type { Translate } from '@/i18n/translate';
import { asciiDigits } from './format';
import { fieldText } from './problemText';

/**
 * The forms of `/app/config`, one per card: what the inputs hold (numbers
 * as typed, in any digits), the value a save sends, the checks the API
 * makes again (bounds, a suggested version not below the required one,
 * legal versions that only go up), and what each change asks the admin to
 * confirm.
 */

export type Stores = 'cafe_bazaar' | 'google_play';
export const versionStores: readonly Stores[] = ['cafe_bazaar', 'google_play'];
/** The panel's store word for each `app.min_version` key. */
export const storeOfVersionKey: Readonly<Record<Stores, 'bazaar' | 'play'>> = {
  cafe_bazaar: 'bazaar',
  google_play: 'play',
};

/** An input for a number typed as text: Latin digits laid out left to right in every language. */
export const numberInput = {
  inputMode: 'numeric',
  dir: 'ltr',
  autoComplete: 'off',
  spellCheck: false,
} as const;

/** A whole number typed in any digits (no sign, no grouping), or null. */
export function typedNumber(value: string): number | null {
  const text = asciiDigits(value.trim());
  return /^\d{1,10}$/.test(text) ? Number(text) : null;
}

/** A field's problem: a key and its values. */
export interface Problem {
  key: MessageKey;
  values?: Readonly<Record<string, number | string>>;
}
export type Problems = Readonly<Record<string, Problem>>;

const range = (min: number, max: number): Problem => ({
  key: 'appConfig.error.range',
  values: { min, max },
});

function inRange(problems: Record<string, Problem>, field: string, value: string, min: number, max: number): number | null {
  const n = typedNumber(value);
  if (n === null || n < min || n > max) {
    problems[field] = range(min, max);
    return null;
  }
  return n;
}

// ─── Versions ─────────────────────────────────────────────────────────────

export type VersionsForm = Record<Stores, { required: string; recommended: string }>;

export function versionsFormOf(value: AppConfig['app.min_version'], plain: (n: number) => string): VersionsForm {
  return {
    cafe_bazaar: {
      required: plain(value.cafe_bazaar.required),
      recommended: plain(value.cafe_bazaar.recommended),
    },
    google_play: {
      required: plain(value.google_play.required),
      recommended: plain(value.google_play.recommended),
    },
  };
}

export function versionsCheck(form: VersionsForm): {
  value: AppConfig['app.min_version'] | null;
  problems: Problems;
} {
  const problems: Record<string, Problem> = {};
  const out: Partial<Record<Stores, { required: number; recommended: number }>> = {};
  for (const store of versionStores) {
    const required = inRange(problems, `${store}/required`, form[store].required, 0, ADMIN_CONFIG_BOUNDS.versionCodeMax);
    const recommended = inRange(problems, `${store}/recommended`, form[store].recommended, 0, ADMIN_CONFIG_BOUNDS.versionCodeMax);
    if (required !== null && recommended !== null) {
      if (recommended < required)
        problems[`${store}/recommended`] = {
          key: 'appConfig.error.belowRequired',
        };
      out[store] = { required, recommended };
    }
  }
  if (Object.keys(problems).length > 0 || !out.cafe_bazaar || !out.google_play) return { value: null, problems };
  return {
    value: { cafe_bazaar: out.cafe_bazaar, google_play: out.google_play },
    problems,
  };
}

/** The stores whose required version a save raises, with the new code (each is typed again to confirm). */
export function raisedRequired(before: AppConfig['app.min_version'], after: AppConfig['app.min_version']): { store: Stores; code: number }[] {
  return versionStores.filter((store) => after[store].required > before[store].required).map((store) => ({ store, code: after[store].required }));
}

// ─── Maintenance ──────────────────────────────────────────────────────────

export const MAINTENANCE_MESSAGE_MAX = 500;

export interface MaintenanceForm {
  enabled: boolean;
  message: Record<Locale, string>;
}

export function maintenanceFormOf(value: AppConfig['app.maintenance']): MaintenanceForm {
  return {
    enabled: value.enabled,
    message: {
      fa: value.message.fa ?? '',
      en: value.message.en ?? '',
      tr: value.message.tr ?? '',
    },
  };
}

/** An empty message is left out: the app shows its own text in that language. */
export function maintenanceValue(form: MaintenanceForm): AppConfig['app.maintenance'] {
  const message: Partial<Record<Locale, string>> = {};
  for (const locale of locales) {
    const text = form.message[locale].trim();
    if (text) message[locale] = text;
  }
  return { enabled: form.enabled, message };
}

export function maintenanceProblems(form: MaintenanceForm): Problems {
  const problems: Record<string, Problem> = {};
  for (const locale of locales) {
    if ([...form.message[locale].trim()].length > MAINTENANCE_MESSAGE_MAX)
      problems[`message/${locale}`] = {
        key: 'appConfig.error.tooLong',
        values: { max: MAINTENANCE_MESSAGE_MAX },
      };
  }
  return problems;
}

// ─── Countries ────────────────────────────────────────────────────────────

export const COUNTRIES_MAX = 300;

export interface CountryRow {
  /** Kept across edits so a row keeps its inputs while others are added or removed. */
  rowId: number;
  code: string;
  allowed: boolean;
  unit: DistanceUnit;
  language: Locale | '';
}

export interface CountriesForm {
  defaultAllowed: boolean;
  countries: CountryRow[];
}

export const units: readonly DistanceUnit[] = distanceUnits;

let nextRow = 1;
export const newRowId = () => nextRow++;

export function countriesFormOf(value: AppConfig['signup.countries']): CountriesForm {
  return {
    defaultAllowed: value.default.allowed,
    countries: value.countries.map((c) => ({
      rowId: newRowId(),
      code: c.code,
      allowed: c.allowed,
      unit: c.unit,
      language: c.language ?? '',
    })),
  };
}

/** A code as typed, made the stored form (two upper-case letters). */
export const countryCode = (text: string) => text.trim().toUpperCase();

export function countriesCheck(form: CountriesForm): {
  value: AppConfig['signup.countries'] | null;
  problems: Problems;
} {
  const problems: Record<string, Problem> = {};
  const seen = new Set<string>();
  form.countries.forEach((row, i) => {
    const code = countryCode(row.code);
    if (!/^[A-Z]{2}$/.test(code))
      problems[`countries/${i}/code`] = {
        key: 'appConfig.countries.error.code',
      };
    else if (seen.has(code))
      problems[`countries/${i}/code`] = {
        key: 'appConfig.countries.error.twice',
      };
    seen.add(code);
  });
  if (Object.keys(problems).length > 0) return { value: null, problems };
  return {
    value: {
      default: { allowed: form.defaultAllowed },
      countries: form.countries.map((row) => ({
        code: countryCode(row.code),
        allowed: row.allowed,
        unit: row.unit,
        language: row.language === '' ? null : row.language,
      })),
    },
    problems,
  };
}

/**
 * What a save closes to new sign-ups that was open: other countries
 * (`default`), and every country, listed before or after, open before and
 * closed after (a removed row falls back to the other countries' setting).
 */
export function closedBySave(before: AppConfig['signup.countries'], after: AppConfig['signup.countries']): { others: boolean; codes: string[] } {
  const open = (setting: AppConfig['signup.countries'], code: string) => setting.countries.find((c) => c.code === code)?.allowed ?? setting.default.allowed;
  const codes = [...new Set([...before.countries.map((c) => c.code), ...after.countries.map((c) => c.code)])];
  return {
    others: before.default.allowed && !after.default.allowed,
    codes: codes.filter((code) => open(before, code) && !open(after, code)),
  };
}

// ─── Limits ───────────────────────────────────────────────────────────────

export type LimitName = keyof typeof ADMIN_CONFIG_BOUNDS.limits;
export const limitNames = Object.keys(ADMIN_CONFIG_BOUNDS.limits) as LimitName[];
export type LimitsForm = Record<LimitName, string>;

export function limitsFormOf(value: AppConfig['limits.rates'], plain: (n: number) => string): LimitsForm {
  return Object.fromEntries(limitNames.map((name) => [name, plain(value[name])])) as LimitsForm;
}

export function limitsCheck(form: LimitsForm): {
  value: AppConfig['limits.rates'] | null;
  problems: Problems;
} {
  const problems: Record<string, Problem> = {};
  const out: Partial<Record<LimitName, number>> = {};
  for (const name of limitNames) {
    const { min, max } = ADMIN_CONFIG_BOUNDS.limits[name];
    const n = inRange(problems, name, form[name], min, max);
    if (n !== null) out[name] = n;
  }
  return Object.keys(problems).length > 0 ? { value: null, problems } : { value: out as AppConfig['limits.rates'], problems };
}

// ─── Retention ────────────────────────────────────────────────────────────

export type RetentionKey = keyof typeof ADMIN_CONFIG_BOUNDS.retention;
export const retentionKeys: readonly RetentionKey[] = [
  'retention.deleted_account_days',
  'retention.unmatched_messages_days',
  'retention.message_requests_days',
  'retention.unsent_body_hours',
  'retention.report_evidence_days',
];
export const retentionUnit = (key: RetentionKey): 'hours' | 'days' => (key === 'retention.unsent_body_hours' ? 'hours' : 'days');

export function retentionCheck(key: RetentionKey, text: string): { value: number | null; problem: Problem | null } {
  const { min, max } = ADMIN_CONFIG_BOUNDS.retention[key];
  const n = typedNumber(text);
  if (n === null || n < min || n > max) return { value: null, problem: range(min, max) };
  return { value: n, problem: null };
}

// ─── Legal ────────────────────────────────────────────────────────────────

export type LegalText = keyof AppConfig['legal.versions'];
export const legalTexts: readonly LegalText[] = ['terms', 'privacy', 'guidelines'];

export interface LegalForm {
  versions: Record<LegalText, string>;
  name: string;
  email: string;
}

export function legalFormOf(versions: AppConfig['legal.versions'], contact: AppConfig['safety.child_safety_contact'], plain: (n: number) => string): LegalForm {
  return {
    versions: {
      terms: plain(versions.terms),
      privacy: plain(versions.privacy),
      guidelines: plain(versions.guidelines),
    },
    name: contact.name ?? '',
    email: contact.email ?? '',
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function legalCheck(
  form: LegalForm,
  before: AppConfig['legal.versions'],
): {
  versions: AppConfig['legal.versions'] | null;
  contact: AppConfig['safety.child_safety_contact'] | null;
  problems: Problems;
} {
  const problems: Record<string, Problem> = {};
  const versions: Partial<Record<LegalText, number>> = {};
  for (const text of legalTexts) {
    const n = inRange(problems, `versions/${text}`, form.versions[text], 1, ADMIN_CONFIG_BOUNDS.legalVersionMax);
    if (n === null) continue;
    if (n < before[text]) problems[`versions/${text}`] = { key: 'appConfig.error.lowered' };
    else versions[text] = n;
  }
  const name = form.name.trim();
  const email = form.email.trim();
  if ([...name].length > ADMIN_CONFIG_BOUNDS.contactNameMax)
    problems['contact/name'] = {
      key: 'appConfig.error.tooLong',
      values: { max: ADMIN_CONFIG_BOUNDS.contactNameMax },
    };
  if (email && !EMAIL.test(email)) problems['contact/email'] = { key: 'appConfig.error.email' };
  if (Object.keys(problems).length > 0) return { versions: null, contact: null, problems };
  return {
    versions: versions as AppConfig['legal.versions'],
    contact: { name: name || null, email: email || null },
    problems,
  };
}

/** The texts a save asks everyone to accept again. */
export function raisedTexts(before: AppConfig['legal.versions'], after: AppConfig['legal.versions']): LegalText[] {
  return legalTexts.filter((text) => after[text] > before[text]);
}

// ─── Refusals ─────────────────────────────────────────────────────────────

/**
 * A refusal's field issues as the card's problems: `/value/<path>` of the
 * key saved, at `prefix` + `<path>` (e.g. `versions/terms`); a bound refused
 * says its range when the card knows it.
 */
export function serverProblems(issues: readonly FieldIssue[], t: Translate, prefix = '', bounds?: (path: string) => { min: number; max: number } | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const path = issue.pointer.replace(/^\/value\/?/, '');
    const field = `${prefix}${path}`;
    const known = issue.code === 'out_of_range' ? bounds?.(path) : null;
    out[field] = known ? t('appConfig.error.range', known) : (fieldText(issue.code, t, issue.pointer) ?? t('appConfig.error.invalid'));
  }
  return out;
}
