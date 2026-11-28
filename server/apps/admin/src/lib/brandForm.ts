import {
  BRAND_URL_MAX,
  BRAND_WELCOME_IMAGES_MAX,
  brandAppNameValid,
  brandUrlFromOrigin,
  brandUrlOnHosts,
  brandValueKeys,
  type AdminBrand,
  type AdminBrandUpdate,
  type BrandValueKey,
  type FieldIssue,
} from '@app/shared';
import type { MessageKey } from '@/i18n/messages';

/**
 * The brand form: the run-time values the app and the API read (an empty
 * field is brand.json's), and the welcome pictures in their order. The
 * checks are the API's (it checks them again).
 */

export interface BrandForm {
  values: Record<BrandValueKey, string>;
  images: { rowId: number; url: string }[];
}

let nextRow = 1;
export const newImageRow = (url = '') => ({ rowId: nextRow++, url });

export function brandFormOf(view: AdminBrand): BrandForm {
  return {
    values: Object.fromEntries(brandValueKeys.map((key) => [key, view.saved[key] ?? ''])) as Record<BrandValueKey, string>,
    images: view.welcomeImages.map((url) => newImageRow(url)),
  };
}

export const brandLabel: Readonly<Record<BrandValueKey, MessageKey>> = {
  appName: 'brand.appName',
  supportEmail: 'brand.supportEmail',
  privacyUrl: 'brand.privacyUrl',
  termsUrl: 'brand.termsUrl',
  guidelinesUrl: 'brand.guidelinesUrl',
  childSafetyUrl: 'brand.childSafetyUrl',
  deleteAccountUrl: 'brand.deleteAccountUrl',
};

export const brandUrlKeys = ['privacyUrl', 'termsUrl', 'guidelinesUrl', 'childSafetyUrl', 'deleteAccountUrl'] as const satisfies readonly BrandValueKey[];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function httpsUrl(text: string): boolean {
  if (text.length > BRAND_URL_MAX) return false;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** Where the API takes links and pictures from (the view carries them). */
export type BrandRules = Pick<AdminBrand, 'linkHosts' | 'mediaOrigin'>;

/** The field's problem, by field (`appName`, `privacyUrl`, `images/2`), as message keys: the API's own rules. */
export function brandProblems(form: BrandForm, rules: BrandRules): Record<string, MessageKey> {
  const problems: Record<string, MessageKey> = {};
  const name = form.values.appName;
  if (name !== '' && !brandAppNameValid(name)) problems['appName'] = 'brand.error.name';
  const email = form.values.supportEmail.trim();
  if (email && !EMAIL.test(email)) problems['supportEmail'] = 'brand.error.email';
  for (const key of brandUrlKeys) {
    const text = form.values[key].trim();
    if (text && !httpsUrl(text)) problems[key] = 'brand.error.url';
    else if (text && !brandUrlOnHosts(text, rules.linkHosts)) problems[key] = 'brand.error.host';
  }
  const seen = new Set<string>();
  form.images.forEach((row, i) => {
    const url = row.url.trim();
    if (!httpsUrl(url)) problems[`images/${i}`] = 'brand.error.url';
    else if (!brandUrlFromOrigin(url, rules.mediaOrigin)) problems[`images/${i}`] = 'brand.error.media';
    else if (seen.has(url)) problems[`images/${i}`] = 'brand.error.duplicate';
    seen.add(url);
  });
  return problems;
}

/** The fields that change what the privacy policy and the stores name: they need `config.legal`. */
export const brandLegalFields: readonly BrandValueKey[] = ['supportEmail', ...brandUrlKeys];

/** Whether a save changes a legal value (null and the build's value are the same: brand.json's). */
export function changesLegal(form: BrandForm, initial: BrandForm): boolean {
  return brandLegalFields.some((key) => form.values[key].trim() !== initial.values[key].trim());
}

export function brandBody(form: BrandForm, baseVersion: string): AdminBrandUpdate {
  const text = (key: BrandValueKey) => (key === 'appName' ? form.values.appName : form.values[key].trim()) || null;
  return {
    baseVersion,
    appName: text('appName'),
    supportEmail: text('supportEmail'),
    privacyUrl: text('privacyUrl'),
    termsUrl: text('termsUrl'),
    guidelinesUrl: text('guidelinesUrl'),
    childSafetyUrl: text('childSafetyUrl'),
    deleteAccountUrl: text('deleteAccountUrl'),
    welcomeImages: form.images.map((row) => row.url.trim()),
  };
}

/** The fields a save changes, by label, in the form's order (the confirm lists them). */
export function changedBrandFields(form: BrandForm, initial: BrandForm): MessageKey[] {
  const changed: MessageKey[] = brandValueKeys.filter((key) => form.values[key].trim() !== initial.values[key].trim()).map((key) => brandLabel[key]);
  const urls = (f: BrandForm) => f.images.map((row) => row.url.trim()).join('\n');
  if (urls(form) !== urls(initial)) changed.push('brand.welcome.title');
  return changed;
}

/** A refusal's field issues, by the form's fields. */
export function brandServerProblems(issues: readonly FieldIssue[]): Record<string, MessageKey> {
  const out: Record<string, MessageKey> = {};
  for (const issue of issues) {
    const path = issue.pointer.replace(/^\//, '');
    const image = /^welcomeImages\/(\d+)$/.exec(path);
    const field = image ? `images/${image[1]}` : path;
    out[field] =
      issue.code === 'duplicate'
        ? 'brand.error.duplicate'
        : issue.code === 'host_not_allowed'
          ? image
            ? 'brand.error.media'
            : 'brand.error.host'
          : field === 'appName'
            ? 'brand.error.name'
            : field === 'supportEmail'
              ? 'brand.error.email'
              : 'brand.error.url';
  }
  return out;
}

export const WELCOME_IMAGES_MAX = BRAND_WELCOME_IMAGES_MAX;

/** Whether a picture may be shown here: the panel's pages load images only from the CDN (the panel's CSP). */
export function previewable(url: string, cdnOrigin: string | null): boolean {
  if (!cdnOrigin) return false;
  try {
    return new URL(url).origin === cdnOrigin;
  } catch {
    return false;
  }
}
