import { locales, placeholders } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { sitePages } from '../src/content/pages';
import { ui } from '../src/content/ui';
import { brandValues, pageSlugs } from '../src/lib/i18n';
import { segments } from '../src/lib/richText';
import { allPaths, unlocalizedRedirects } from '../src/lib/routes';

const known = new Set(Object.keys(brandValues('en')));

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

describe('site content', () => {
  it('has every page in every locale with the same structure', () => {
    for (const slug of pageSlugs) {
      const page = sitePages[slug];
      const shape = (locale: (typeof locales)[number]) =>
        page.content[locale].sections.map((section) => [section.body.length, section.list?.length ?? 0]);
      for (const locale of locales) {
        expect(page.content[locale].title.trim(), `${slug}/${locale}`).not.toBe('');
        expect(shape(locale), `${slug}/${locale}`).toEqual(shape('en'));
      }
    }
  });

  it('uses only placeholders the build can fill', () => {
    for (const text of [...strings(sitePages), ...strings(ui)]) {
      for (const name of placeholders(text)) expect(known.has(name), `{${name}} in "${text}"`).toBe(true);
    }
  });

  it('has every UI string in every locale', () => {
    const keys = Object.keys(ui.en).sort();
    for (const locale of locales) expect(Object.keys(ui[locale]).sort()).toEqual(keys);
  });

  it('builds every page in every brand locale and forwards unlocalized paths', () => {
    expect(allPaths()).toContain('/en/delete-account/');
    expect(allPaths()).toContain('/fa/child-safety/');
    const redirects = unlocalizedRedirects();
    expect(redirects).toContainEqual({ path: 'privacy', slug: 'privacy' });
    // The template brand's guidelines URL is /guidelines.
    expect(redirects).toContainEqual({ path: 'guidelines', slug: 'community-guidelines' });
  });
});

describe('segments', () => {
  it('links e-mail addresses and site paths without HTML in the content', () => {
    expect(segments('Write to a@b.test or see /en/x/.', { emails: ['a@b.test'], paths: ['/en/x/'] })).toEqual([
      { kind: 'text', value: 'Write to ' },
      { kind: 'email', value: 'a@b.test' },
      { kind: 'text', value: ' or see ' },
      { kind: 'link', value: '/en/x/', href: '/en/x/' },
      { kind: 'text', value: '.' },
    ]);
  });
});
