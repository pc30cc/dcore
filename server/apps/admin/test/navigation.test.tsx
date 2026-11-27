import { expandGrants } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminWith, fakeApi, renderPanel, resetPanel, signInAs } from './panel';
import { detail, SARA } from './userFixtures';

/**
 * The panel's navigation for each seeded role: the W7d pages each one sees
 * (the grants as migrations 0002, 0024, 0026 and 0033 seed them, expanded
 * as the API expands them), `/moderation`, which opens the first moderation
 * page the role may open, and the user page's tabs that depend on the role.
 */

const SEEDED_GRANTS: Readonly<Record<string, readonly string[]>> = {
  superadmin: ['*'],
  // users.chats is restricted (users.* does not cover it): 0033 grants it by name.
  admin: ['users.*', 'moderation.*', 'reports.*', 'appeals.*', 'content.*', 'billing.read', 'config.*', 'campaigns.*', 'support.*', 'dashboard.read', 'audit.read', 'billing.catalog', 'users.chats'],
  moderator: ['users.read', 'moderation.*', 'reports.*', 'appeals.*', 'dashboard.read', 'users.warn', 'users.suspend', 'users.ban', 'users.shadowban', 'users.lift', 'users.revoke_sessions'],
  support: ['users.read', 'support.*', 'dashboard.read'],
  finance: ['users.read', 'billing.*', 'dashboard.read'],
  marketing: ['campaigns.*', 'content.read', 'dashboard.read'],
  analyst: ['dashboard.read'],
};

const W7D = ['Users', 'Photos', 'Texts', 'Reports', 'Appeals', 'Legal holds', 'Banned terms', 'Device bans', 'Audit log'];

const EXPECTED: Readonly<Record<string, readonly string[]>> = {
  superadmin: W7D,
  admin: W7D,
  moderator: ['Users', 'Photos', 'Texts', 'Reports', 'Appeals', 'Legal holds', 'Banned terms', 'Device bans'],
  support: ['Users'],
  finance: ['Users'],
  marketing: [],
  analyst: [],
};

/** The roles whose user page has the Chats tab. */
const CHATS: ReadonlySet<string> = new Set(['superadmin', 'admin']);

const FIRST: Readonly<Record<string, string | null>> = {
  superadmin: '/moderation/photos',
  admin: '/moderation/photos',
  moderator: '/moderation/photos',
  support: null,
  finance: null,
  marketing: null,
  analyst: null,
};

function signInRole(role: string): void {
  const permissions = expandGrants(SEEDED_GRANTS[role]!);
  signInAs(adminWith(permissions, [role]));
}

// Every page answers empty: the test is about which pages are reachable.
const emptyApi = () =>
  fakeApi(
    Object.fromEntries(
      ['/v1/admin/moderation/photos', '/v1/admin/moderation/texts', '/v1/admin/reports', '/v1/admin/appeals', '/v1/admin/holds', '/v1/admin/banned-terms', '/v1/admin/device-bans', '/v1/admin/audit', '/v1/admin/users'].map(
        (path) => [`GET ${path}`, () => ({ items: [], nextCursor: null })],
      ),
    ),
  );

beforeEach(() => {
  resetPanel();
});

describe('the navigation', () => {
  it.each(Object.keys(SEEDED_GRANTS))('shows a %s the W7d pages the role may open, in their groups', async (role) => {
    signInRole(role);
    renderPanel('/me/security', emptyApi());
    const nav = (await screen.findAllByRole('navigation', { name: 'Sections' }))[0]!;
    const links = within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent?.replace('Soon', '').trim() ?? '');
    expect(links.filter((label) => W7D.includes(label))).toEqual(EXPECTED[role]);
    // The moderation pages sit under their own group; the audit log under System.
    if (EXPECTED[role]!.includes('Photos')) expect(within(nav).getByText('Moderation')).toBeTruthy();
    else expect(within(nav).queryByText('Moderation')).toBeNull();
    if (EXPECTED[role]!.includes('Audit log')) expect(within(nav).getByRole('link', { name: 'Audit log' }).getAttribute('href')).toBe('/system/audit');
  });

  it.each(Object.keys(SEEDED_GRANTS))('opens the first moderation page a %s may open from /moderation', async (role) => {
    signInRole(role);
    const { router } = renderPanel('/moderation', emptyApi());
    const first = FIRST[role];
    if (first) await waitFor(() => expect(router.state.location.pathname).toBe(first));
    else expect(await screen.findByText('No access')).toBeTruthy();
  });

  it.each(Object.keys(SEEDED_GRANTS))('gives a %s the user page’s Chats tab only with users.chats (superadmin and admin)', async (role) => {
    signInRole(role);
    const api = fakeApi({ [`GET /v1/admin/users/${SARA}`]: () => detail(), [`GET /v1/admin/users/${SARA}/photos`]: () => ({ items: [] }) });
    renderPanel(`/users/${SARA}?tab=chats`, api);
    if (!expandGrants(SEEDED_GRANTS[role]!).includes('users.read')) {
      expect(await screen.findByText('No access')).toBeTruthy();
    } else {
      expect(await screen.findByRole('tab', { name: 'Profile' })).toBeTruthy();
      expect(screen.queryByRole('tab', { name: 'Chats' }) !== null).toBe(CHATS.has(role));
    }
    if (!CHATS.has(role)) expect(api.calls.filter((call) => call.path.includes('/chats'))).toHaveLength(0);
  });

  it('opens the reports first for a role that reads reports only', async () => {
    signInAs(adminWith(['reports.read', 'appeals.read']));
    const { router } = renderPanel('/moderation', emptyApi());
    await waitFor(() => expect(router.state.location.pathname).toBe('/moderation/reports'));
  });

  it('keeps the sidebar’s Moderation group in Persian', async () => {
    signInRole('moderator');
    renderPanel('/me/security', emptyApi(), { locale: 'fa' });
    const nav = (await screen.findAllByRole('navigation', { name: 'بخش‌ها' }))[0]!;
    for (const word of ['نظارت', 'عکس‌ها', 'گزارش‌ها', 'اعتراض‌ها', 'واژه‌های ممنوع', 'مسدودسازی دستگاه']) expect(within(nav).getByText(word)).toBeTruthy();
  });
});
