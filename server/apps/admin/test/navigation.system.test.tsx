import { expandGrants } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminWith, fakeApi, renderPanel, resetPanel, signInAs } from './panel';
import { HOLDERS, ROLES, health, partitions, queues, streams } from './systemFixtures';

/**
 * The system area in the navigation: Roles after Admins (`admins.read`),
 * Jobs and health at the end of the System group (`system.read`), among the
 * seeded roles both held by the owner role alone; `/system` opens the jobs page. Each
 * address refuses the others without asking the API.
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

const as = (role: string) => signInAs(adminWith(expandGrants(SEEDED_GRANTS[role]!), [role]));

const api = () =>
  fakeApi({
    'GET /v1/admin/system/health': () => health(),
    'GET /v1/admin/system/queues': () => queues(),
    'GET /v1/admin/system/streams': () => streams(),
    'GET /v1/admin/system/partitions': () => partitions(),
    'GET /v1/admin/roles': () => ({ items: ROLES }),
    'GET /v1/admin/roles/holders': () => HOLDERS,
    'GET /v1/admin/stats/live': () => ({}),
  });

const links = () =>
  within(screen.getAllByRole('navigation', { name: 'Sections' })[0]!)
    .getAllByRole('link')
    .map((link) => [link.textContent?.trim(), link.getAttribute('href')] as const);

beforeEach(() => {
  resetPanel();
});

describe('the system area in the navigation', () => {
  it('gives the owner Roles after Admins and Jobs and health at the end of the System group', async () => {
    as('superadmin');
    renderPanel('/system/roles', api());
    expect(await screen.findByRole('heading', { level: 1, name: 'Roles' })).toBeTruthy();
    const all = links();
    const admins = all.findIndex(([, href]) => href === '/system/admins');
    expect(all[admins + 1]).toEqual(['Roles', '/system/roles']);
    expect(all.at(-1)).toEqual(['Jobs and health', '/system/jobs']);
    // The placeholder is gone.
    expect(all.find(([, href]) => href === '/system')).toBeUndefined();
  });

  it('opens the jobs page at /system', async () => {
    as('superadmin');
    const { router } = renderPanel('/system', api());
    expect(await screen.findByRole('heading', { level: 1, name: 'Jobs and health' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/system/jobs');
  });

  it.each(['admin', 'moderator', 'support', 'finance', 'marketing', 'analyst'])('hides both from a %s and refuses their addresses', async (role) => {
    as(role);
    const fake = api();
    renderPanel('/system/jobs', fake);
    expect(await screen.findByText('No access')).toBeTruthy();
    const hrefs = links().map(([, href]) => href);
    expect(hrefs).not.toContain('/system/jobs');
    expect(hrefs).not.toContain('/system/roles');
    await waitFor(() => expect(fake.of('GET /v1/admin/system/health')).toHaveLength(0));
    expect(fake.of('GET /v1/admin/system/queues')).toHaveLength(0);
  });

  it('opens Roles alone to an admin holding admins.read, and Jobs and health alone with system.read', async () => {
    signInAs(adminWith(['admins.read'], ['ops']));
    const fake = api();
    const view = renderPanel('/system/jobs', fake);
    expect(await screen.findByText('No access')).toBeTruthy();
    expect(links().map(([, href]) => href)).toContain('/system/roles');
    view.unmount();
    signInAs(adminWith(['system.read'], ['ops']));
    renderPanel('/system/roles', fake);
    expect(await screen.findByText('No access')).toBeTruthy();
    expect(links().map(([, href]) => href)).toContain('/system/jobs');
    expect(fake.of('GET /v1/admin/roles/holders')).toHaveLength(0);
  });

  it('names them in Persian', async () => {
    as('superadmin');
    renderPanel('/system/jobs', api(), { locale: 'fa' });
    const nav = (await screen.findAllByRole('navigation', { name: 'بخش‌ها' }))[0]!;
    for (const word of ['نقش‌ها', 'کارها و سلامت سیستم']) expect(within(nav).getByText(word)).toBeTruthy();
  });
});
