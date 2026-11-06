import { z } from 'zod';
import { localeSchema, type Locale } from './locale.js';

/**
 * Account deletion without signing in: the public API routes, the fields the
 * website's plain HTML forms post, and where the API sends a form post back
 * to. The website and the API both build on this module, so a form and the
 * route that answers it cannot drift apart.
 *
 * A route answers JSON to a JSON request, and `303 See Other` to a form post
 * (`application/x-www-form-urlencoded`), with a `Location` built by
 * {@link accountDeletionRedirect}. The website is static and runs no script on
 * these pages, so nothing a redirect carries in its query string can reach
 * the next form; that is why the code form asks for the phone number again
 * instead of carrying the request token, and why an error is named in the
 * URL fragment, which the page shows with CSS (`:target`).
 */
export const accountDeletionRoutes = {
  start: '/v1/public/account-deletion/start',
  confirm: '/v1/public/account-deletion/confirm',
  google: '/v1/public/account-deletion/google',
} as const;
export type AccountDeletionRoute = keyof typeof accountDeletionRoutes;

/** The fields each website form posts, in order. */
export const accountDeletionFormFields = {
  start: ['phone', 'locale'],
  confirm: ['phone', 'code', 'locale'],
  google: ['idToken', 'locale'],
} as const satisfies Record<AccountDeletionRoute, readonly string[]>;

/** The pages of the website's deletion flow. */
export const accountDeletionSteps = ['request', 'verify', 'done'] as const;
export type AccountDeletionStep = (typeof accountDeletionSteps)[number];

export function accountDeletionPagePath(locale: Locale, step: AccountDeletionStep): string {
  return step === 'request' ? `/${locale}/delete-account/` : `/${locale}/delete-account/${step}/`;
}

/**
 * The errors a form post can come back with. Each page has a message for the
 * ones its form can cause; any other problem code is sent back as `error`.
 */
export const accountDeletionFormErrors = [
  'phone_invalid',
  'rate_limited',
  'sms_unavailable',
  'otp_invalid',
  'otp_expired',
  'otp_locked',
  'google_token_invalid',
  'maintenance',
  'error',
] as const;
export type AccountDeletionFormError = (typeof accountDeletionFormErrors)[number];

/** Which page a route's form errors return to. */
export const accountDeletionErrorStep: Readonly<Record<AccountDeletionRoute, AccountDeletionStep>> = {
  start: 'request',
  confirm: 'verify',
  google: 'request',
};

export function isAccountDeletionFormError(code: string): code is AccountDeletionFormError {
  return (accountDeletionFormErrors as readonly string[]).includes(code);
}

/** The element id a page gives the message for `code`; the redirect's fragment. */
export function accountDeletionErrorId(code: AccountDeletionFormError): string {
  return `e-${code}`;
}

export interface AccountDeletionRedirectOptions {
  /** After `start`: the request token (`?r=`), for clients that can read it. */
  requestToken?: string | undefined;
  /** A problem code; codes the pages do not know become `error`. */
  error?: string | undefined;
}

/**
 * The `Location` of the API's `303` to a form post: the page of `step` on the
 * website, with `?r=<requestToken>` and `?e=<code>#e-<code>` when given.
 */
export function accountDeletionRedirect(
  siteOrigin: string,
  locale: Locale,
  step: AccountDeletionStep,
  options: AccountDeletionRedirectOptions = {},
): string {
  const url = new URL(accountDeletionPagePath(locale, step), siteOrigin);
  if (options.requestToken !== undefined) url.searchParams.set('r', options.requestToken);
  if (options.error !== undefined) {
    const code: AccountDeletionFormError = isAccountDeletionFormError(options.error) ? options.error : 'error';
    url.searchParams.set('e', code);
    url.hash = accountDeletionErrorId(code);
  }
  return url.toString();
}

const persianDigits = /[۰-۹]/g;
const arabicDigits = /[٠-٩]/g;

/** Persian and Arabic-Indic digits to ASCII: phones and codes typed on a Persian keyboard. */
export function asciiDigits(value: string): string {
  return value
    .replace(persianDigits, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(arabicDigits, (d) => String(d.charCodeAt(0) - 0x0660));
}

/** A phone number as typed: digits (any script), spaces, `+`, `-`, `.`, `(`, `)`. The API normalises it to E.164. */
const typedPhone = z
  .string()
  .transform((value) => asciiDigits(value).trim())
  .pipe(z.string().regex(/^\+?[0-9][0-9 ().-]{4,22}$/, 'phone_invalid'));
const typedCode = z
  .string()
  .transform((value) => asciiDigits(value).replace(/\s+/g, ''))
  .pipe(z.string().regex(/^[0-9]{4,8}$/, 'otp_invalid'));

export const accountDeletionStartBody = z.object({ phone: typedPhone, locale: localeSchema });
export const accountDeletionConfirmBody = z.union([
  z.object({ requestToken: z.string().min(16).max(256), code: typedCode }),
  z.object({ phone: typedPhone, code: typedCode, locale: localeSchema }),
]);
export const accountDeletionGoogleBody = z.object({ idToken: z.string().min(1).max(8192), locale: localeSchema.optional() });

export type AccountDeletionStartBody = z.infer<typeof accountDeletionStartBody>;
export type AccountDeletionConfirmBody = z.infer<typeof accountDeletionConfirmBody>;
export type AccountDeletionGoogleBody = z.infer<typeof accountDeletionGoogleBody>;
