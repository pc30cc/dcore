import type { Locale } from '@app/shared';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { BUILD_DEFAULT_LOCALE, initialLocale } from '../src/i18n/defaultLocale';
import { brandIndexHtml, indexHtmlFor, panelLocaleOf } from '../src/i18n/indexHtml';
import { translate } from '../src/i18n/translate';
import { readRuntimeConfig, setRuntimeConfigForTests } from '../src/lib/runtimeConfig';
import { API, fakeApi, problem, renderPanel, resetPanel } from './panel';

/**
 * The panel's language for someone who has not picked one: the deployment's
 * ADMIN_DEFAULT_LOCALE as /config.js names it, else the build's default
 * (Persian); a language picked in the panel's menu wins on that browser.
 */

function withDefault(defaultLocale: Locale | null): void {
  resetPanel();
  setRuntimeConfigForTests({ ok: true, config: { apiOrigin: API, cdnOrigin: null, persianFont: null, defaultLocale } });
}

const signedOut = () => fakeApi({ 'POST /v1/admin/auth/refresh': () => problem(401, 'refresh_invalid') });
const heading = (locale: Locale) => translate(locale, 'login.title', {}, 'Test');

beforeEach(() => {
  document.documentElement.removeAttribute('lang');
  document.documentElement.removeAttribute('dir');
});

describe('the default language', () => {
  it('is Persian, right to left, on the sign-in page when nothing names one', async () => {
    withDefault(null);
    expect(BUILD_DEFAULT_LOCALE).toBe('fa');
    renderPanel('/', signedOut());
    await screen.findByRole('heading', { name: heading('fa') });
    expect(document.documentElement.lang).toBe('fa');
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.title).toBe(translate('fa', 'app.title', {}, 'Test'));
    // Nothing is stored until someone picks a language.
    expect(window.localStorage.getItem('admin.locale')).toBeNull();
  });

  it.each(['fa', 'en', 'tr'] as const)('follows ADMIN_DEFAULT_LOCALE=%s from /config.js', async (locale) => {
    withDefault(locale);
    renderPanel('/', signedOut());
    await screen.findByRole('heading', { name: heading(locale) });
    expect(document.documentElement.lang).toBe(locale);
    expect(document.documentElement.dir).toBe(locale === 'fa' ? 'rtl' : 'ltr');
  });

  it('gives way to a language picked in the menu, which is kept', async () => {
    withDefault('fa');
    window.localStorage.setItem('admin.locale', 'en');
    renderPanel('/', signedOut());
    await screen.findByRole('heading', { name: heading('en') });
    expect(document.documentElement.dir).toBe('ltr');

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(translate('en', 'language.label')), 'tr');
    await screen.findByRole('heading', { name: heading('tr') });
    expect(window.localStorage.getItem('admin.locale')).toBe('tr');
  });

  it('ignores a stored value that is not one of the brand\'s languages', () => {
    withDefault('tr');
    for (const stored of ['de', 'FA', '', 'fa-IR']) {
      window.localStorage.setItem('admin.locale', stored);
      expect(initialLocale(), stored).toBe('tr');
    }
    window.localStorage.setItem('admin.locale', 'fa');
    expect(initialLocale()).toBe('fa');
  });
});

describe('/config.js', () => {
  it('takes defaultLocale only as one of the brand\'s languages', () => {
    const read = (defaultLocale: unknown) => {
      const result = readRuntimeConfig({ apiOrigin: 'https://api.example.com', defaultLocale }, false, undefined);
      return result.ok ? result.config.defaultLocale : 'refused';
    };
    expect(read('fa')).toBe('fa');
    expect(read('en')).toBe('en');
    expect(read('tr')).toBe('tr');
    for (const bad of ['de', 'FA', ' fa', 42, null, undefined, '', ['fa']]) expect(read(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe('the built pages (index.html and index.<locale>.html)', () => {
  const brand = { appName: 'A&B <Co>', defaultLocale: 'en' as const, locales: ['en', 'fa', 'tr'] as const, style: '<style>:root{}</style>' };
  const source = `<!doctype html>
<html lang="%DEFAULT_LOCALE%" dir="%DEFAULT_DIR%">
  <head>
    <title>%APP_TITLE%</title>
    %BRAND_STYLE%
    <script>var l = %LOCALES%, r = %RTL_LOCALES%, t = %TITLES%;</script>
  </head>
  <body></body>
</html>`;
  const scripts = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);

  it('defaults to Persian when ADMIN_DEFAULT_LOCALE is unset, takes a brand language, and refuses any other', () => {
    expect(panelLocaleOf(undefined, brand)).toBe('fa');
    expect(panelLocaleOf('  ', brand)).toBe('fa');
    expect(panelLocaleOf(' tr ', brand)).toBe('tr');
    expect(panelLocaleOf(undefined, { defaultLocale: 'en', locales: ['en', 'tr'] })).toBe('en');
    expect(() => panelLocaleOf('de', brand)).toThrow(/ADMIN_DEFAULT_LOCALE=de/);
    expect(() => panelLocaleOf('fa', { defaultLocale: 'en', locales: ['en', 'tr'] })).toThrow();
  });

  it('writes each language\'s <html lang dir> and title, with one inline script for all', () => {
    const built = brandIndexHtml(source, brand, 'fa');
    expect(built).toContain('<html lang="fa" dir="rtl">');
    expect(built).toContain(`<title>${translate('fa', 'app.title', {}, 'A&#38;B &#60;Co&#62;')}</title>`);
    // The titles map cannot close the script element.
    expect(scripts(built)[0]).not.toContain('<Co>');
    expect(scripts(built)[0]).toContain('\\u003cCo>');
    const pages = brand.locales.map((locale) => indexHtmlFor(built, locale, brand.appName));
    expect(pages[0]).toContain('<html lang="en" dir="ltr">');
    expect(pages[0]).toContain('<title>A&#38;B &#60;Co&#62; Admin</title>');
    expect(pages[1]).toContain('<html lang="fa" dir="rtl">');
    expect(pages[2]).toContain('<html lang="tr" dir="ltr">');
    for (const page of pages) expect(scripts(page)).toEqual(scripts(built));
    expect(indexHtmlFor(pages[2]!, 'fa', brand.appName)).toBe(built);
  });
});
