import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { accountDeletionRoutes, locales, textDirection, type Locale } from '@app/shared';
import { describe, expect, inject, it } from 'vitest';
import { scriptHash } from '../src/lib/csp';
import { appPageIds, pageIds, pagePath, unlistedPageIds, type PageId } from '../src/lib/i18n';
import { PLAY_SUBSCRIPTIONS_URL } from '../src/lib/stores';
import {
  FIXTURE_API_ORIGIN,
  FIXTURE_APP_NAME,
  FIXTURE_BAZAAR_CERT,
  FIXTURE_BAZAAR_LISTING,
  FIXTURE_BAZAAR_PACKAGE,
  FIXTURE_GRACE_DAYS,
  FIXTURE_PLAY_CERTS,
  FIXTURE_PLAY_LISTING,
  FIXTURE_PLAY_PACKAGE,
  FIXTURE_PNG,
  FIXTURE_SCREENSHOT,
  FIXTURE_SITE,
} from './support/fixture';
import { all, attr, byTag, first, textOf, type Element } from './support/html';
import { BuiltSite } from './support/site';

/**
 * The built output, for both builds: the template brand without any build
 * setting, and the fixture brand with stores live, certificates, Google
 * sign-in, another API and another grace period.
 */
const builds = [
  {
    name: 'template',
    site: new BuiltSite(inject('templateDist'), 'https://example.com'),
    appName: 'App',
    api: 'https://api.example.com',
    listings: ['https://play.google.com/store/apps/details?id=com.example.app', 'https://cafebazaar.ir/app/com.example.app'],
    live: false,
    defaultLocale: 'en' as Locale,
  },
  {
    name: 'fixture',
    site: new BuiltSite(inject('fixtureDist'), FIXTURE_SITE),
    appName: FIXTURE_APP_NAME,
    api: FIXTURE_API_ORIGIN,
    listings: [FIXTURE_PLAY_LISTING, FIXTURE_BAZAAR_LISTING],
    live: true,
    defaultLocale: 'fa' as Locale,
  },
];

const storeAppLink = /^(market|bazaar):|play\.google\.com\/store\/apps|cafebazaar\.ir\/app/;

function csp(page: Element): string {
  const meta = first(page, (e) => e.tag === 'meta' && attr(e, 'http-equiv') === 'Content-Security-Policy');
  return attr(meta ?? page, 'content') ?? '';
}

function links(page: Element): { tag: string; url: string }[] {
  const out: { tag: string; url: string }[] = [];
  for (const element of all(page, () => true)) {
    for (const name of ['href', 'src', 'action']) {
      const value = attr(element, name);
      if (value !== undefined) out.push({ tag: element.tag, url: value });
    }
  }
  return out;
}

describe.each(builds)('the $name build', ({ site, appName, api, listings, live, defaultLocale }) => {
  const htmlPages = site.htmlPages();

  it('has every page in fa, en and tr, with the right language and direction', () => {
    for (const locale of locales) {
      for (const id of pageIds) {
        const page = site.page(pagePath(locale, id));
        const html = first(page, (e) => e.tag === 'html')!;
        expect(attr(html, 'lang'), `${locale}/${id}`).toBe(locale);
        expect(attr(html, 'dir'), `${locale}/${id}`).toBe(textDirection(locale));
        expect(textOf(first(page, (e) => e.tag === 'title')!), `${locale}/${id}`).toContain(appName);
        expect(byTag(page, 'h1'), `${locale}/${id}`).toHaveLength(1);
      }
    }
    expect(site.has('/404.html')).toBe(true);
    expect(attr(first(site.page('/fa/'), (e) => e.tag === 'html')!, 'dir')).toBe('rtl');
  });

  it('fills every placeholder', () => {
    for (const urlPath of htmlPages) {
      const text = textOf(site.page(urlPath));
      expect(text.match(/\{[A-Za-z][A-Za-z0-9_]*\}/g) ?? [], urlPath).toEqual([]);
    }
  });

  it('has only valid links', () => {
    const external = new Set([...listings, PLAY_SUBSCRIPTIONS_URL]);
    for (const urlPath of htmlPages) {
      const page = site.page(urlPath);
      const ids = new Set(all(page, (e) => e.attrs.has('id')).map((e) => attr(e, 'id')));
      for (const { tag, url } of links(page)) {
        const where = `${urlPath}: <${tag}> ${url}`;
        if (url.startsWith('#')) {
          expect(ids.has(url.slice(1)), where).toBe(true);
        } else if (url.startsWith('mailto:')) {
          expect(url, where).toMatch(/^mailto:[^@\s]+@[^@\s?]+\.[a-z]+(\?subject=[^\s]+)?$/);
        } else if (tag === 'form') {
          expect(Object.values(accountDeletionRoutes).map((route) => `${api}${route}`), where).toContain(url);
        } else {
          const local = site.localPath(url);
          if (local === undefined) {
            if (tag === 'a') expect(live || !listings.includes(url), where).toBe(true);
            expect(external.has(url), where).toBe(true);
          } else {
            expect(site.has(local), where).toBe(true);
          }
        }
      }
    }
  });

  it('keeps every store and download link off the pages the apps open', () => {
    for (const locale of locales) {
      for (const id of [...appPageIds, undefined] as (PageId | undefined)[]) {
        const urlPath = id === undefined ? '/404.html' : pagePath(locale, id);
        const page = site.page(urlPath);
        for (const { url } of links(page)) {
          expect(listings, `${urlPath} links ${url}`).not.toContain(url);
          expect(url, urlPath).not.toMatch(storeAppLink);
          const local = site.localPath(url)?.split(/[?#]/)[0];
          for (const code of locales) {
            expect(local, `${urlPath} links the landing`).not.toBe(pagePath(code));
            expect(local, `${urlPath} links the download page`).not.toBe(pagePath(code, 'download'));
          }
          // The subscription centres are named only where the deletion flow explains that deleting does not cancel.
          if (url === PLAY_SUBSCRIPTIONS_URL) expect(['delete-account', 'delete-account/done']).toContain(id);
        }
        expect(all(page, (e) => e.attrs.has('data-store')), urlPath).toEqual([]);
      }
    }
  });

  it('shows the store buttons on the landing and download pages only when live', () => {
    for (const locale of locales) {
      for (const id of ['', 'download'] as const) {
        const hrefs = all(site.page(pagePath(locale, id)), (e) => e.attrs.has('data-store')).map((e) => attr(e, 'href'));
        if (!live) {
          expect(hrefs).toEqual([]);
        } else {
          // Cafe Bazaar first in Persian.
          expect(hrefs).toEqual(locale === 'fa' ? [FIXTURE_BAZAAR_LISTING, FIXTURE_PLAY_LISTING] : [FIXTURE_PLAY_LISTING, FIXTURE_BAZAAR_LISTING]);
        }
      }
    }
    // No direct download anywhere: the stores are the only channels.
    for (const urlPath of htmlPages) {
      for (const { url } of links(site.page(urlPath))) expect(url, urlPath).not.toMatch(/\.(apk|aab|zip)(\?|$)/i);
    }
  });

  it('names the app on the child safety page', () => {
    for (const locale of locales) {
      const page = site.page(pagePath(locale, 'child-safety'));
      expect(textOf(byTag(page, 'h1')[0]!)).toContain(appName);
      expect(textOf(page)).toContain('CSAE');
    }
  });

  it('runs no script but the language redirect and the Google button', () => {
    for (const urlPath of htmlPages) {
      const page = site.page(urlPath);
      const policy = csp(page);
      expect(policy, urlPath).toMatch(/default-src 'self'/);
      for (const script of byTag(page, 'script')) {
        expect(attr(script, 'src'), urlPath).toBeUndefined();
        expect(policy, urlPath).toContain(scriptHash(textOf({ ...script, tag: 'div' })));
      }
      const scripts = byTag(page, 'script').length;
      const isRedirect = first(page, (e) => e.tag === 'meta' && attr(e, 'http-equiv') === 'refresh') !== undefined;
      const isDeletion = /^\/[a-z]{2}\/delete-account\/$/.test(urlPath);
      if (!isRedirect && !isDeletion) expect(scripts, urlPath).toBe(0);
      expect(policy.includes('accounts.google.com'), urlPath).toBe(isDeletion && live);
    }
  });

  it('serves assetlinks.json for both store packages', () => {
    const statements = JSON.parse(site.text('/.well-known/assetlinks.json')) as unknown;
    if (!live) {
      expect(statements).toEqual([]);
      return;
    }
    expect(statements).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: FIXTURE_PLAY_PACKAGE, sha256_cert_fingerprints: FIXTURE_PLAY_CERTS.map((f) => f.toUpperCase()) },
      },
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: FIXTURE_BAZAAR_PACKAGE, sha256_cert_fingerprints: [FIXTURE_BAZAAR_CERT] },
      },
    ]);
  });

  it('serves security.txt, robots.txt and a sitemap of every listed page', () => {
    const security = site.text('/.well-known/security.txt');
    expect(security).toMatch(/^Contact: mailto:\S+@\S+$/m);
    expect(security).toContain(`Canonical: ${site.origin}/.well-known/security.txt`);
    const expires = Date.parse(/^Expires: (.+)$/m.exec(security)?.[1] ?? '');
    expect(expires).toBeGreaterThan(Date.now());
    expect(expires - Date.now()).toBeLessThanOrEqual(366 * 24 * 3600 * 1000);

    expect(site.text('/robots.txt')).toContain(`Sitemap: ${site.origin}/sitemap.xml`);
    const listed = [...site.text('/sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] ?? '');
    const expected = locales.flatMap((locale) => pageIds.filter((id) => !unlistedPageIds.includes(id)).map((id) => `${site.origin}${pagePath(locale, id)}`));
    expect(listed.sort()).toEqual(expected.sort());
    for (const url of listed) expect(site.has(site.localPath(url)!), url).toBe(true);
    for (const id of unlistedPageIds) {
      expect(first(site.page(pagePath('en', id)), (e) => e.tag === 'meta' && attr(e, 'name') === 'robots')).toBeDefined();
    }
  });

  it('forwards the unlocalized paths to the default language', () => {
    for (const [urlPath, id] of [['/', ''], ['/privacy/', 'privacy'], ['/delete-account/', 'delete-account']] as const) {
      const refresh = first(site.page(urlPath), (e) => e.tag === 'meta' && attr(e, 'http-equiv') === 'refresh');
      expect(attr(refresh!, 'content')).toBe(`0; url=${pagePath(defaultLocale, id)}`);
    }
  });
});

describe('the fixture build', () => {
  const site = builds[1]!.site;

  it('forwards the exact legal URLs the brand gave the stores', () => {
    for (const [urlPath, id] of [['/account/delete/', 'delete-account'], ['/rules/', 'community-guidelines'], ['/help/', 'support']] as const) {
      const refresh = first(site.page(urlPath), (e) => e.tag === 'meta' && attr(e, 'http-equiv') === 'refresh');
      expect(attr(refresh!, 'content')).toBe(`0; url=${pagePath('fa', id)}`);
    }
  });

  it('shows the brand copy and screenshots on the landing page', () => {
    const page = site.page('/en/');
    expect(textOf(page)).toContain('Highlight one');
    const img = first(page, (e) => e.tag === 'img')!;
    expect(attr(img, 'src')).toBe(`/media/${FIXTURE_SCREENSHOT}`);
    expect([attr(img, 'width'), attr(img, 'height'), attr(img, 'alt')]).toEqual(['3', '2', 'The deck']);
    expect(readFileSync(site.file(`/media/${FIXTURE_SCREENSHOT}`)!)).toEqual(FIXTURE_PNG);
  });

  it('states the grace period of the build setting in each language’s digits', () => {
    expect(textOf(site.page('/fa/delete-account/'))).toContain('۱۴ روز');
    expect(textOf(site.page('/en/delete-account/done/'))).toContain(`${FIXTURE_GRACE_DAYS} days`);
  });

  it('builds nothing outside the expected files', () => {
    const top = readdirSync(site.dist).sort();
    expect(top).toEqual(
      ['.well-known', '404.html', '_astro', 'account', 'child-safety', 'community-guidelines', 'delete-account', 'download', 'en', 'fa', 'help', 'index.html', 'media', 'privacy', 'robots.txt', 'rules', 'sitemap.xml', 'support', 'terms', 'tr'].sort(),
    );
    expect(readdirSync(path.join(site.dist, '.well-known')).sort()).toEqual(['assetlinks.json', 'security.txt']);
  });
});
