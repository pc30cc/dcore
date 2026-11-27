import { isLocale, isRtl, type Locale } from '@app/shared';
import { translate } from './translate';

/**
 * index.html of the panel, written at build time (vite.config.ts): one page
 * per language of the brand (`index.<locale>.html`, its `<html lang dir>`
 * and `<title>` in that language) and `index.html`, the build's default.
 * The container serves the page of ADMIN_DEFAULT_LOCALE
 * (deploy/nginx/admin-runtime.sh), so the first paint already has the
 * panel's language and direction. The inline script is the same text in
 * every page (one CSP hash): it applies a language picked in the panel's
 * menu, else the one /config.js names.
 */

export interface IndexBrand {
  appName: string;
  defaultLocale: Locale;
  locales: readonly Locale[];
  /** The `<style>` the first paint needs (colours and font names). */
  style: string;
}

/**
 * The panel's default language at build time: ADMIN_DEFAULT_LOCALE trimmed,
 * Persian when it is unset or empty and the brand has it (else the brand's
 * own default). A value that is not one of the brand's languages stops the
 * build.
 */
export function panelLocaleOf(value: string | undefined, brand: Pick<IndexBrand, 'defaultLocale' | 'locales'>): Locale {
  const wanted = (value ?? '').trim();
  if (wanted === '') return brand.locales.includes('fa') ? 'fa' : brand.defaultLocale;
  if (!isLocale(wanted) || !brand.locales.includes(wanted)) {
    throw new Error(`ADMIN_DEFAULT_LOCALE=${wanted} is not a language of this brand (${brand.locales.join(', ')})`);
  }
  return wanted;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The document title in `locale`, as the panel sets it. */
export function panelTitle(locale: Locale, appName: string): string {
  return translate(locale, 'app.title', {}, appName);
}

/** JSON for an inline script: no `<` can close the script element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** The source index.html with its placeholders filled for the build's default language. */
export function brandIndexHtml(html: string, brand: IndexBrand, locale: Locale): string {
  const titles = Object.fromEntries(brand.locales.map((each) => [each, panelTitle(each, brand.appName)]));
  return html
    .replace('%APP_TITLE%', escapeHtml(panelTitle(locale, brand.appName)))
    .replace('%BRAND_STYLE%', brand.style)
    .replace('%DEFAULT_LOCALE%', locale)
    .replace('%DEFAULT_DIR%', isRtl(locale) ? 'rtl' : 'ltr')
    .replace('%LOCALES%', scriptJson(brand.locales))
    .replace('%RTL_LOCALES%', scriptJson(brand.locales.filter((each) => isRtl(each))))
    .replace('%TITLES%', scriptJson(titles));
}

const HTML_TAG = /<html\b[^>]*>/i;
const TITLE = /<title>[^<]*<\/title>/i;

/** A built index.html as the page of `locale`: only `<html lang dir>` and `<title>` change. */
export function indexHtmlFor(html: string, locale: Locale, appName: string): string {
  if (!HTML_TAG.test(html) || !TITLE.test(html)) throw new Error('index.html has no <html> or <title>');
  return html
    .replace(HTML_TAG, `<html lang="${locale}" dir="${isRtl(locale) ? 'rtl' : 'ltr'}">`)
    .replace(TITLE, `<title>${escapeHtml(panelTitle(locale, appName))}</title>`);
}
