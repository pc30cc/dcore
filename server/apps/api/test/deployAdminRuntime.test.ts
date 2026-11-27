import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { composeEnv, DEPLOY } from './deploySupport.js';

/**
 * The admin container's start-up step (deploy/nginx/admin-runtime.sh) and
 * the build steps of its pages (admin-index.mjs, csp.mjs): the panel's
 * default language, ADMIN_DEFAULT_LOCALE (unset: Persian), reaches
 * /config.js and the index.html nginx serves, whose <html lang dir> already
 * has it; a value the panel has no page for stops the container.
 */

const work = mkdtempSync(join(tmpdir(), 'admin-runtime-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const SCRIPT = '<script>(function(){document.documentElement.dataset.x="1"})();</script>';
const page = (locale: string, dir: string) =>
  `<!doctype html><html lang="${locale}" dir="${dir}"><head><title>${locale}</title>${SCRIPT}</head><body></body></html>\n`;

function htmlDir(locales: readonly string[]): string {
  const dir = mkdtempSync(join(work, 'html-'));
  writeFileSync(join(dir, 'index.html'), page('fa', 'rtl'));
  for (const locale of locales) writeFileSync(join(dir, `index.${locale}.html`), page(locale, locale === 'fa' ? 'rtl' : 'ltr'));
  return dir;
}

const fullHtml = htmlDir(['en', 'fa', 'tr']);
const template = join(work, 'csp.template');
writeFileSync(template, 'add_header Content-Security-Policy "connect-src \'self\' @API_ORIGIN@" always;\n');

interface Run {
  status: number;
  stderr: string;
  out: string;
}

let runs = 0;
function run(env: Record<string, string | undefined>, html = fullHtml): Run {
  const out = join(work, `runtime-${++runs}`);
  const merged: Record<string, string> = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    DEPLOY_LIB_DIR: join(DEPLOY, 'scripts'),
    RUNTIME_DIR: out,
    CSP_TEMPLATE: template,
    HTML_DIR: html,
    PUBLIC_API_URL: 'https://api.example.com',
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  const result = spawnSync('sh', [join(DEPLOY, 'nginx/admin-runtime.sh')], { env: merged, encoding: 'utf8' });
  return { status: result.status ?? -1, stderr: result.stderr, out };
}

function configOf(out: string): Record<string, unknown> {
  const js = readFileSync(join(out, 'config.js'), 'utf8');
  const match = /^window\.__APP_CONFIG__ = Object\.freeze\((.*)\);\n$/s.exec(js);
  if (!match) throw new Error(`config.js has another shape: ${js}`);
  const fromJs = JSON.parse(match[1]!) as Record<string, unknown>;
  expect(JSON.parse(readFileSync(join(out, 'config.json'), 'utf8'))).toEqual(fromJs);
  return fromJs;
}

describe('admin-runtime.sh: the panel\'s default language', () => {
  it.each([
    ['unset', undefined, 'fa'],
    ['empty', '', 'fa'],
    ['blank', '  ', 'fa'],
    ['en', 'en', 'en'],
    ['tr', 'tr', 'tr'],
    ['fa', 'fa', 'fa'],
    ['spaced', ' tr ', 'tr'],
    ['with CR/LF', 'en\r\n', 'en'],
  ])('%s gives %s, %s', (_label, value, locale) => {
    const result = run({ ADMIN_DEFAULT_LOCALE: value });
    expect(result.status, result.stderr).toBe(0);
    expect(configOf(result.out)).toEqual({
      apiOrigin: 'https://api.example.com',
      cdnOrigin: '',
      persianFontCss: '',
      persianFontFamily: '',
      defaultLocale: locale,
    });
    expect(readFileSync(join(result.out, 'index.html'), 'utf8')).toBe(readFileSync(join(fullHtml, `index.${locale}.html`), 'utf8'));
    expect(result.stderr).toContain(`panel language ${locale}`);
    for (const name of ['config.js.tmp', 'config.json.tmp', 'csp.conf.tmp', 'index.html.tmp']) expect(existsSync(join(result.out, name)), name).toBe(false);
  });

  it.each(['de', 'FA', 'fa-IR', 'fa"', 'x', 'en tr', "fa'", 'f$', '../a'])('refuses %j and writes nothing', (value) => {
    const result = run({ ADMIN_DEFAULT_LOCALE: value });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ADMIN_DEFAULT_LOCALE');
    expect(existsSync(join(result.out, 'config.js'))).toBe(false);
    expect(existsSync(join(result.out, 'index.html'))).toBe(false);
  });

  it('names the languages the build has when the value is not one of them', () => {
    const result = run({ ADMIN_DEFAULT_LOCALE: 'de' });
    expect(result.stderr).toMatch(/it has: en fa tr/);
  });

  it('stops a panel without Persian that leaves the setting unset, and serves it the language it names', () => {
    const noPersian = htmlDir(['en', 'tr']);
    const unset = run({ ADMIN_DEFAULT_LOCALE: undefined }, noPersian);
    expect(unset.status).toBe(1);
    expect(unset.stderr).toMatch(/ADMIN_DEFAULT_LOCALE=fa is not a language of this panel \(it has: en tr\)/);
    const english = run({ ADMIN_DEFAULT_LOCALE: 'en' }, noPersian);
    expect(english.status, english.stderr).toBe(0);
    expect(configOf(english.out)['defaultLocale']).toBe('en');
  });

  it('still refuses a missing API address first', () => {
    const result = run({ PUBLIC_API_URL: undefined, ADMIN_DEFAULT_LOCALE: 'en' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PUBLIC_API_URL');
  });

  it('is passed by compose with Persian as the default', () => {
    expect(composeEnv('admin')['ADMIN_DEFAULT_LOCALE']).toBe('${ADMIN_DEFAULT_LOCALE:-fa}');
  });
});

describe('the build steps of the admin pages', () => {
  const node = (args: string[]) => spawnSync(process.execPath, args, { encoding: 'utf8' });

  it('puts /config.js first in <head> of every page, once', () => {
    const dir = htmlDir(['en', 'fa']);
    const files = ['index.html', 'index.en.html', 'index.fa.html'].map((name) => join(dir, name));
    for (let pass = 0; pass < 2; pass += 1) {
      const result = node([join(DEPLOY, 'nginx/admin-index.mjs'), ...files]);
      expect(result.status, result.stderr).toBe(0);
    }
    for (const file of files) {
      const html = readFileSync(file, 'utf8');
      expect(html.split('<script src="/config.js"></script>')).toHaveLength(2);
      expect(html.indexOf('/config.js')).toBeLessThan(html.indexOf(SCRIPT));
    }
  });

  it('allows the inline script of every page by one hash', () => {
    const dir = mkdtempSync(join(work, 'csp-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.html'), page('en', 'ltr'));
    writeFileSync(join(dir, 'b.html'), page('fa', 'rtl'));
    const both = node([join(DEPLOY, 'nginx/csp.mjs'), 'admin', join(dir, 'a.html'), join(dir, 'b.html')]);
    const one = node([join(DEPLOY, 'nginx/csp.mjs'), 'admin', join(dir, 'a.html')]);
    expect(both.status, both.stderr).toBe(0);
    expect(both.stdout).toBe(one.stdout);
    expect(both.stdout.match(/'sha256-/g)).toHaveLength(1);
  });
});
