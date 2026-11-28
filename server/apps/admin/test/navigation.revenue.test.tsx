import { expandGrants } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminWith, fakeApi, planList, renderPanel, resetPanel, signInAs } from './panel';

/**
 * The revenue area in the navigation: Purchases and Gifts and corrections,
 * after the plans and store products in Revenue, for every seeded role that
 * reads billing (finance, admin, the owner); hidden from the others, and
 * their addresses refused to them.
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

const READERS = ['superadmin', 'admin', 'finance'];

beforeEach(() => {
  resetPanel();
});

const api = () =>
  fakeApi({
    'GET /v1/admin/purchases': () => ({ items: [], nextCursor: null, connected: false }),
    'GET /v1/admin/grants': () => ({ items: [], nextCursor: null }),
    'GET /v1/admin/plans': () => planList([]),
    'GET /v1/admin/stats/live': () => ({}),
    'GET /v1/admin/users': () => ({ items: [], nextCursor: null }),
  });

describe('the revenue area in the navigation', () => {
  it.each(READERS)('gives a %s Purchases and Gifts and corrections, after the store products', async (role) => {
    signInAs(adminWith(expandGrants(SEEDED_GRANTS[role]!), [role]));
    renderPanel('/revenue/purchases', api());
    expect(await screen.findByRole('heading', { level: 1, name: 'Purchases' })).toBeTruthy();
    const nav = screen.getAllByRole('navigation', { name: 'Sections' })[0]!;
    const links = within(nav)
      .getAllByRole('link')
      .map((link) => [link.textContent?.trim(), link.getAttribute('href')]);
    const at = links.findIndex(([, href]) => href === '/revenue/products');
    expect(links.slice(at, at + 3)).toEqual([
      ['Store products', '/revenue/products'],
      ['Purchases', '/revenue/purchases'],
      ['Gifts and corrections', '/revenue/grants'],
    ]);
  });

  it.each(Object.keys(SEEDED_GRANTS).filter((role) => !READERS.includes(role)))('hides both from a %s, and refuses their addresses', async (role) => {
    signInAs(adminWith(expandGrants(SEEDED_GRANTS[role]!), [role]));
    const fake = api();
    renderPanel('/revenue/grants', fake);
    expect(await screen.findByText('No access')).toBeTruthy();
    const nav = screen.getAllByRole('navigation', { name: 'Sections' })[0]!;
    expect(within(nav).queryByRole('link', { name: 'Purchases' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Gifts and corrections' })).toBeNull();
    await waitFor(() => expect(fake.of('GET /v1/admin/grants')).toHaveLength(0));
  });

  it('names both in Persian', async () => {
    signInAs(adminWith(expandGrants(SEEDED_GRANTS['finance']!), ['finance']));
    renderPanel('/revenue/grants', api(), { locale: 'fa' });
    const nav = (await screen.findAllByRole('navigation', { name: 'بخش‌ها' }))[0]!;
    for (const word of ['درآمد', 'خریدها', 'هدیه‌ها و اصلاح‌ها']) expect(within(nav).getByText(word)).toBeTruthy();
  });
});
