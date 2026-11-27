import { expandGrants } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminWith, fakeApi, renderPanel, resetPanel, signInAs } from './panel';
import { statsHandlers } from './statsFixtures';

/**
 * The dashboard area in the navigation: Dashboard and Statistics, first in
 * Overview, for every seeded role (each holds dashboard.read), and the home
 * page of a role without it.
 */

const SEEDED_GRANTS: Readonly<Record<string, readonly string[]>> = {
  superadmin: ['*'],
  admin: ['users.*', 'moderation.*', 'reports.*', 'appeals.*', 'content.*', 'billing.read', 'config.*', 'campaigns.*', 'support.*', 'dashboard.read', 'audit.read', 'billing.catalog', 'users.chats', 'dashboard.revenue'],
  moderator: ['users.read', 'moderation.*', 'reports.*', 'appeals.*', 'dashboard.read', 'users.warn', 'users.suspend', 'users.ban', 'users.shadowban', 'users.lift', 'users.revoke_sessions'],
  support: ['users.read', 'support.*', 'dashboard.read'],
  finance: ['users.read', 'billing.*', 'dashboard.read', 'dashboard.revenue'],
  marketing: ['campaigns.*', 'content.read', 'dashboard.read'],
  analyst: ['dashboard.read', 'dashboard.revenue'],
};

beforeEach(() => {
  resetPanel();
});

describe('the dashboard area in the navigation', () => {
  it.each(Object.keys(SEEDED_GRANTS))('gives a %s the dashboard and the statistics, first in Overview, and opens the dashboard at /', async (role) => {
    signInAs(adminWith(expandGrants(SEEDED_GRANTS[role]!), [role]));
    renderPanel('/', fakeApi(statsHandlers));
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeTruthy();
    const nav = screen.getAllByRole('navigation', { name: 'Sections' })[0]!;
    const links = within(nav).getAllByRole('link');
    expect(links.slice(0, 2).map((link) => [link.textContent?.trim(), link.getAttribute('href')])).toEqual([
      ['Dashboard', '/'],
      ['Statistics', '/stats'],
    ]);
    expect(within(nav).getByText('Overview')).toBeTruthy();
    // Built pages: no "Soon" on either.
    expect(links[0]!.textContent).not.toContain('Soon');
    expect(links[1]!.textContent).not.toContain('Soon');
  });

  it('hides both from a role without dashboard.read and opens its first page instead', async () => {
    signInAs(adminWith(['users.read']));
    const { router } = renderPanel('/', fakeApi({ 'GET /v1/admin/users': () => ({ items: [], nextCursor: null }) }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/users'));
    const nav = screen.getAllByRole('navigation', { name: 'Sections' })[0]!;
    expect(within(nav).queryByRole('link', { name: 'Dashboard' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Statistics' })).toBeNull();
    expect(within(nav).queryByText('Overview')).toBeNull();
  });

  it('keeps the Overview group in Persian', async () => {
    signInAs(adminWith(expandGrants(SEEDED_GRANTS['analyst']!), ['analyst']));
    renderPanel('/stats', fakeApi(statsHandlers), { locale: 'fa' });
    const nav = (await screen.findAllByRole('navigation', { name: 'بخش‌ها' }))[0]!;
    for (const word of ['نمای کلی', 'داشبورد', 'آمار']) expect(within(nav).getByText(word)).toBeTruthy();
  });
});
