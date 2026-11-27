// @vitest-environment node
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locales } from '@app/shared';
import { Box } from 'lucide-react';
import type { RouteObject } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { messageModules, messages } from '../src/i18n/messages';
import type { Section } from '../src/lib/sections';

/**
 * The panel's areas (dashboard, content, revenue, growth, app, support,
 * system): each has its own locale module, composed into the panel's
 * strings with every key defined once, and its own `pages/<area>/area.tsx`,
 * whose navigation items and routes the shell spreads where they belong.
 */

const AREAS = ['dashboard', 'content', 'revenue', 'growth', 'app', 'support', 'system'] as const;
const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** Every key defined in more than one module, with the modules that define it. */
function duplicateKeys(modules: Readonly<Record<string, Readonly<Record<string, string>>>>): string[] {
  const owners = new Map<string, string[]>();
  for (const [name, strings] of Object.entries(modules)) for (const key of Object.keys(strings)) owners.set(key, [...(owners.get(key) ?? []), name]);
  return [...owners].filter(([, names]) => names.length > 1).map(([key, names]) => `${key}: ${names.join(', ')}`);
}

const modulesOf = (locale: (typeof locales)[number]) => Object.fromEntries(Object.entries(messageModules).map(([name, module]) => [name, module[locale] as Readonly<Record<string, string>>]));

describe('the locale modules', () => {
  it('are the core one and one per area, each area a folder of its own', () => {
    expect(Object.keys(messageModules)).toEqual(['core', ...AREAS]);
    const dir = join(SRC, 'i18n/locales');
    const folders = readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
    expect(folders.sort()).toEqual([...AREAS].sort());
    for (const area of AREAS) expect(readdirSync(join(dir, area)).sort(), area).toEqual(['en.ts', 'fa.ts', 'tr.ts']);
  });

  it('define every key once, in one module, in every language', () => {
    for (const locale of locales) expect(duplicateKeys(modulesOf(locale)), locale).toEqual([]);
  });

  it('would catch a key defined twice (the check itself)', () => {
    expect(duplicateKeys({ core: { 'nav.users': 'Users' }, content: { 'nav.users': 'People' } })).toEqual(['nav.users: core, content']);
    expect(duplicateKeys({ core: {}, growth: { 'x.y': 'A' }, support: { 'x.y': 'B' }, system: { 'x.z': 'C' } })).toEqual(['x.y: growth, support']);
  });

  it('give an area the same keys in every language', () => {
    for (const [name, module] of Object.entries(messageModules)) {
      for (const locale of locales) expect(Object.keys(module[locale]).sort(), `${name}:${locale}`).toEqual(Object.keys(module.en).sort());
    }
  });

  it('make up the panel’s strings, each word its module’s own', () => {
    for (const locale of locales) {
      const composed = messages[locale] as Readonly<Record<string, string>>;
      const all = Object.values(modulesOf(locale)).flatMap((module) => Object.entries(module));
      expect(Object.keys(composed).sort(), locale).toEqual(all.map(([key]) => key).sort());
      for (const [key, value] of all) expect(composed[key], `${locale}:${key}`).toBe(value);
    }
  });
});

describe('the area modules of the pages', () => {
  it('exist for every area', () => {
    for (const area of AREAS) expect(existsSync(join(SRC, 'pages', area, 'area.tsx')), area).toBe(true);
  });

  it('give every item of the navigation a page: a placeholder while it has a spec, else its route', async () => {
    const { sectionGroups } = await import('../src/lib/sections');
    const { routes } = await import('../src/routes');
    const children = routes.find((route) => route.path === '/')?.children ?? [];
    for (const item of sectionGroups.flatMap((group) => group.items)) {
      const route = children.find((child) => (item.path === '' ? child.index === true : child.path === item.path));
      expect(route, item.path || '(index)').toBeDefined();
    }
  });
});

describe('the shell', () => {
  afterEach(() => {
    vi.resetModules();
    for (const area of AREAS) vi.doUnmock(`../src/pages/${area}/area`);
  });

  /** An item and a route standing for an area's own (a page of `area`). */
  const probe = (name: string) => ({ section: { path: `probe/${name}`, label: 'nav.users', icon: Box } satisfies Section, route: { path: `probe/${name}`, element: null } satisfies RouteObject });

  it('spreads each area’s items into their group, in their place, and each area’s routes into the shell', async () => {
    vi.resetModules();
    const probes = Object.fromEntries(AREAS.map((area) => [area, probe(area)]));
    const roles = probe('system-roles');
    for (const area of AREAS) {
      const { section, route } = probes[area]!;
      vi.doMock(`../src/pages/${area}/area`, () =>
        area === 'system' ? { roleSections: [roles.section], jobSections: [section], routes: [roles.route, route] } : { sections: [section], routes: [route] },
      );
    }
    const { sectionGroups } = await import('../src/lib/sections');
    const { routes } = await import('../src/routes');
    const paths = (label: string) => sectionGroups.find((group) => group.label === label)?.items.map((item) => item.path);

    expect(paths('nav.group.overview')).toEqual(['probe/dashboard']);
    expect(paths('nav.group.operations')).toEqual(['users', 'probe/support']);
    expect(paths('nav.group.revenue')).toEqual(['revenue/plans', 'revenue/products', 'probe/revenue']);
    expect(paths('nav.group.product')).toEqual(['app/appearance', 'probe/content', 'probe/growth', 'probe/app']);
    expect(paths('nav.group.system')).toEqual(['system/admins', 'probe/system-roles', 'hosts', 'system/audit', 'probe/system']);

    const children = routes.find((route) => route.path === '/')?.children ?? [];
    const fallback = children.findIndex((child) => child.path === '*');
    expect(fallback).toBe(children.length - 1);
    for (const route of [...Object.values(probes).map((p) => p.route), roles.route]) expect(children.indexOf(route), route.path).toBeGreaterThanOrEqual(0);
  });
});
