import type { AdminAccount } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminState, passwordProblem, validateNewAdmin } from '../src/lib/admins';
import { fakeApi, owner, problem, renderPanel, resetPanel, signInAs } from './panel';

const roles = {
  items: [
    { key: 'superadmin', names: { en: 'Super admin', fa: 'مدیر ارشد' }, grants: ['*'], permissions: ['billing.read'] },
    { key: 'moderator', names: { en: 'Moderator', fa: 'ناظر' }, grants: ['moderation.*'], permissions: ['moderation.read', 'moderation.decide'] },
    { key: 'finance', names: { en: 'Finance', fa: 'مالی' }, grants: ['billing.*'], permissions: ['billing.read', 'billing.catalog'] },
  ],
};

function account(id: string, overrides: Partial<AdminAccount> = {}): AdminAccount {
  return {
    id,
    email: `a${id}@example.com`,
    displayName: `Admin ${id}`,
    roles: ['moderator'],
    createdAt: '2026-11-01T10:00:00.000Z',
    createdBy: '1',
    lastLoginAt: null,
    totpEnabled: true,
    disabledAt: null,
    lockedUntil: null,
    ...overrides,
  };
}

const self = account('1', { email: owner.email, displayName: owner.displayName, roles: ['superadmin'] });

beforeEach(() => {
  resetPanel();
  signInAs(owner);
});

describe('admin rules', () => {
  it('checks e-mail, name, roles and an optional password', () => {
    expect(validateNewAdmin({ email: 'x', displayName: ' ', roles: [], password: '' })).toEqual({ email: 'admins.error.email', displayName: 'form.required', roles: 'admins.error.roles' });
    expect(validateNewAdmin({ email: 'm@example.com', displayName: 'M', roles: ['moderator'], password: '' })).toEqual({});
    expect(passwordProblem('short', 'm@example.com')).toBe('admins.error.passwordShort');
    expect(passwordProblem('m@example.com', 'M@example.com')).toBe('admins.error.passwordEmail');
    expect(passwordProblem('a long enough one', 'm@example.com')).toBeNull();
  });

  it('tells disabled, locked and not-enrolled accounts apart', () => {
    const now = Date.parse('2026-11-09T12:00:00.000Z');
    expect(adminState(account('2', { disabledAt: '2026-11-08T00:00:00.000Z' }), now)).toBe('disabled');
    expect(adminState(account('2', { lockedUntil: '2026-11-09T12:10:00.000Z' }), now)).toBe('locked');
    expect(adminState(account('2', { lockedUntil: '2026-11-09T11:00:00.000Z' }), now)).toBe('active');
    expect(adminState(account('2', { totpEnabled: false }), now)).toBe('pending');
  });
});

describe('the admins page', () => {
  it('lists admins with their roles, and never offers actions on one’s own account', async () => {
    const api = fakeApi({
      'GET /v1/admin/admins': () => ({ items: [self, account('2'), account('3', { disabledAt: '2026-11-08T00:00:00.000Z' })], nextCursor: null }),
      'GET /v1/admin/roles': () => roles,
    });
    renderPanel('/system/admins', api);
    await screen.findByText('Admin 2');
    expect(screen.getAllByText('Moderator').length).toBeGreaterThan(0);
    expect(screen.getByText('Disabled')).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.queryByRole('button', { name: `Actions for ${owner.displayName}` })).toBeNull();
    expect(screen.getByRole('button', { name: 'Actions for Admin 2' })).toBeTruthy();
  });

  it('creates an admin and shows the made password once', async () => {
    const api = fakeApi({
      'GET /v1/admin/admins': () => ({ items: [self], nextCursor: null }),
      'GET /v1/admin/roles': () => roles,
      'POST /v1/admin/admins': () => [201, { admin: account('4', { email: 'neda@example.com', displayName: 'Neda', roles: ['finance'], totpEnabled: false }), initialPassword: 'Xk2-made-once-9' }],
    });
    const user = userEvent.setup();
    renderPanel('/system/admins', api);
    await user.click(await screen.findByRole('button', { name: 'New admin' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Create admin' }));
    expect(within(dialog).getByText('Choose at least one role.')).toBeTruthy();
    expect(api.of('POST /v1/admin/admins')).toHaveLength(0);
    await user.type(within(dialog).getByLabelText('Work e-mail'), 'neda@example.com');
    await user.type(within(dialog).getByLabelText('Name'), 'Neda');
    await user.click(within(dialog).getByRole('checkbox', { name: /Finance/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Create admin' }));
    await screen.findByText('Password, shown once');
    expect(screen.getByText('Xk2-made-once-9')).toBeTruthy();
    expect(api.of('POST /v1/admin/admins')[0]?.body).toEqual({ email: 'neda@example.com', displayName: 'Neda', roles: ['finance'] });
  });

  it('changes roles, resets the authenticator after a question, and keeps the last owner', async () => {
    const api = fakeApi({
      'GET /v1/admin/admins': () => ({ items: [self, account('2')], nextCursor: null }),
      'GET /v1/admin/roles': () => roles,
      'PATCH /v1/admin/admins/2': () => problem(409, 'conflict', { detail: 'At least one enabled owner must remain.' }),
      'POST /v1/admin/admins/2/reset-totp': () => account('2', { totpEnabled: false }),
    });
    const user = userEvent.setup();
    renderPanel('/system/admins', api);
    await user.click(await screen.findByRole('button', { name: 'Actions for Admin 2' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Reset authenticator' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(api.of('POST /v1/admin/admins/2/reset-totp')).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Reset authenticator' }));
    await screen.findByText('Authenticator not set up yet');

    await user.click(screen.getByRole('button', { name: 'Actions for Admin 2' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Change name and roles' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: /Finance/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await within(dialog).findByText('At least one enabled owner must remain.');
    expect(api.of('PATCH /v1/admin/admins/2')[0]?.body).toEqual({ roles: ['moderator', 'finance'] });
  });

  it('is the owner’s alone', async () => {
    signInAs({ ...owner, roles: ['admin'], permissions: ['billing.read'] });
    const api = fakeApi({});
    renderPanel('/system/admins', api);
    await screen.findByText('No access');
    await waitFor(() => expect(api.calls.filter((call) => call.path.startsWith('/v1/admin/admins'))).toHaveLength(0));
  });
});
