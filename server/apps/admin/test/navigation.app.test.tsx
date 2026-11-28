import { expandGrants } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { brandView, configList, providersView, rtcView } from './appFixtures';
import { adminWith, fakeApi, renderPanel, resetPanel, signInAs } from './panel';

/**
 * The app area in the navigation: App settings and Brand for whoever reads
 * the configuration, Providers for the owner alone (a restricted
 * permission), after the other Product pages; New profiles in Moderation,
 * after the text queue, for whoever reads moderation. Each address refuses
 * the others without asking the API.
 */

const SEEDED_GRANTS: Readonly<Record<string, readonly string[]>> = {
  superadmin: ['*'],
  admin: [
    'users.*',
    'moderation.*',
    'reports.*',
    'appeals.*',
    'content.*',
    'billing.read',
    'config.*',
    'campaigns.*',
    'support.*',
    'dashboard.read',
    'audit.read',
    'billing.catalog',
    'users.chats',
    'dashboard.revenue',
  ],
  moderator: ['users.read', 'moderation.*', 'reports.*', 'appeals.*', 'dashboard.read', 'users.warn', 'users.suspend', 'users.ban', 'users.shadowban', 'users.lift', 'users.revoke_sessions'],
  support: ['users.read', 'support.*', 'dashboard.read'],
  finance: ['users.read', 'billing.*', 'dashboard.read', 'dashboard.revenue'],
  marketing: ['campaigns.*', 'content.read', 'dashboard.read'],
  analyst: ['dashboard.read', 'dashboard.revenue'],
};

const as = (role: string) => signInAs(adminWith(expandGrants(SEEDED_GRANTS[role]!), [role]));

const api = () =>
  fakeApi({
    'GET /v1/admin/config': configList(),
    'GET /v1/admin/brand': () => brandView(),
    'GET /v1/admin/providers': () => providersView(),
    'GET /v1/admin/providers/rtc': () => rtcView(),
    'GET /v1/admin/moderation/profiles': () => ({
      items: [],
      nextCursor: null,
    }),
    'GET /v1/admin/stats/live': () => ({}),
  });

const links = () =>
  within(screen.getAllByRole('navigation', { name: 'Sections' })[0]!)
    .getAllByRole('link')
    .map((link) => [link.textContent?.trim(), link.getAttribute('href')] as const);

beforeEach(() => {
  resetPanel();
});

describe('the app area in the navigation', () => {
  it('gives the owner App settings, Brand and Providers after the other product pages, and New profiles after Texts', async () => {
    as('superadmin');
    renderPanel('/app/config', api());
    expect(await screen.findByRole('heading', { level: 1, name: 'App settings' })).toBeTruthy();
    const all = links();
    const at = all.findIndex(([, href]) => href === '/app/config');
    expect(all.slice(at, at + 3)).toEqual([
      ['App settings', '/app/config'],
      ['Brand', '/app/brand'],
      ['Providers', '/app/providers'],
    ]);
    expect(at).toBeGreaterThan(all.findIndex(([, href]) => href === '/app/appearance'));
    const texts = all.findIndex(([, href]) => href === '/moderation/texts');
    expect(all[texts + 1]).toEqual(['New profiles', '/moderation/profiles']);
    // The old placeholder is gone.
    expect(all.find(([, href]) => href === '/brand')).toBeUndefined();
  });

  it('gives the admin role the settings, the brand and the queue, but not the providers, whose address it is refused', async () => {
    as('admin');
    const fake = api();
    renderPanel('/app/providers', fake);
    expect(await screen.findByText('No access')).toBeTruthy();
    const hrefs = links().map(([, href]) => href);
    expect(hrefs).toEqual(expect.arrayContaining(['/app/config', '/app/brand', '/moderation/profiles']));
    expect(hrefs).not.toContain('/app/providers');
    await waitFor(() => expect(fake.of('GET /v1/admin/providers')).toHaveLength(0));
  });

  it('gives a moderator the queue and none of the settings', async () => {
    as('moderator');
    const fake = api();
    renderPanel('/moderation/profiles', fake);
    expect(await screen.findByRole('heading', { level: 1, name: 'New profiles' })).toBeTruthy();
    const hrefs = links().map(([, href]) => href);
    expect(hrefs).toContain('/moderation/profiles');
    expect(hrefs).not.toContain('/app/config');
    expect(hrefs).not.toContain('/app/brand');
  });

  it.each(['support', 'finance', 'marketing', 'analyst'])('hides all four from a %s, and refuses their addresses', async (role) => {
    as(role);
    const fake = api();
    renderPanel('/app/config', fake);
    expect(await screen.findByText('No access')).toBeTruthy();
    const hrefs = links().map(([, href]) => href);
    for (const href of ['/app/config', '/app/brand', '/app/providers', '/moderation/profiles']) expect(hrefs, href).not.toContain(href);
    await waitFor(() => expect(fake.of('GET /v1/admin/config')).toHaveLength(0));
  });

  it('names them in Persian', async () => {
    as('superadmin');
    renderPanel('/app/brand', api(), { locale: 'fa' });
    const nav = (await screen.findAllByRole('navigation', { name: 'بخش‌ها' }))[0]!;
    for (const word of ['تنظیمات اپ', 'برند', 'سرویس‌دهنده‌ها', 'پروفایل‌های تازه']) expect(within(nav).getByText(word)).toBeTruthy();
  });
});
