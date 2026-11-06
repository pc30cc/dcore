import { locales, placeholders } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { deletion } from '../src/content/deletion';
import { sitePages } from '../src/content/pages';
import type { ContentSection } from '../src/content/types';
import { ui } from '../src/content/ui';
import { brandValues, documentSlugs } from '../src/lib/i18n';
import { segments } from '../src/lib/richText';
import { allPaths, listedPaths, unlocalizedRedirects } from '../src/lib/routes';

const known = new Set(Object.keys(brandValues('en')));

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

/** The shape of a value: the same keys, list lengths and string positions in every locale. */
function shape(value: unknown): unknown {
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, shape(v)]));
  }
  return value;
}

const sectionShape = (sections: readonly ContentSection[]) =>
  sections.map((section) => [section.body.length, section.list?.length ?? 0, section.ordered ?? false, section.faq?.length ?? 0]);

describe('site content', () => {
  it('has every document in every locale with the same structure', () => {
    for (const slug of documentSlugs) {
      const page = sitePages[slug];
      for (const locale of locales) {
        expect(page.content[locale].title.trim(), `${slug}/${locale}`).not.toBe('');
        expect(sectionShape(page.content[locale].sections), `${slug}/${locale}`).toEqual(sectionShape(page.content.en.sections));
      }
    }
  });

  it('has every UI and deletion text in every locale', () => {
    for (const locale of locales) {
      expect(shape(ui[locale]), `ui/${locale}`).toEqual(shape(ui.en));
      expect(shape(deletion[locale]), `deletion/${locale}`).toEqual(shape(deletion.en));
      expect(sectionShape(deletion[locale].sections)).toEqual(sectionShape(deletion.en.sections));
    }
  });

  it('uses only placeholders the build can fill', () => {
    for (const text of [...strings(sitePages), ...strings(ui), ...strings(deletion)]) {
      for (const name of placeholders(text)) expect(known.has(name), `{${name}} in "${text}"`).toBe(true);
    }
  });

  it('names the app on the child safety page through {appName}, in every locale', () => {
    for (const locale of locales) {
      const page = sitePages['child-safety'].content[locale];
      expect(page.title).toContain('{appName}');
      expect(page.description).toContain('{appName}');
      // A contact for child safety, as the store requires.
      expect(strings(page.sections).some((text) => text.includes('{supportEmail}'))).toBe(true);
    }
  });

  it('lists every page in every brand locale and forwards unlocalized paths', () => {
    expect(allPaths()).toContain('/en/delete-account/');
    expect(allPaths()).toContain('/fa/delete-account/verify/');
    expect(allPaths()).toContain('/tr/download/');
    expect(allPaths()).toContain('/fa/child-safety/');
    expect(listedPaths()).not.toContain('/en/delete-account/done/');
    const redirects = unlocalizedRedirects();
    expect(redirects).toContainEqual({ path: 'privacy', id: 'privacy' });
    expect(redirects).toContainEqual({ path: 'delete-account', id: 'delete-account' });
    // The template brand's guidelines URL is /guidelines.
    expect(redirects).toContainEqual({ path: 'guidelines', id: 'community-guidelines' });
    expect(redirects.some((r) => r.path.includes('verify'))).toBe(false);
  });

  it('fills numbers in the locale’s own digits', () => {
    expect(brandValues('fa')['graceDays']).toBe('۳۰');
    expect(brandValues('en')['graceDays']).toBe('30');
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
