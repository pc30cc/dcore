import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminWith, fakeApi, problem, renderPanel, resetPanel, signInAs } from './panel';

/**
 * A deployment that requires no second factor (ADMIN_TOTP_REQUIRED=false):
 * the login answer carries the finished sign-in, so the panel goes straight
 * in; and every page says, while it lasts, that the password alone signs in.
 * The panel learns it from /v1/admin/me (`totpRequired`), never from its build.
 */

const MFA = `amf1.${'a'.repeat(43)}`;
/** A signed-in superadmin (every page of these tests open to it). */
const superadmin = adminWith(['billing.read', 'billing.catalog', 'admins.read', 'admins.manage'], ['superadmin']);
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const token = (value: string) => ({ accessToken: value, expiresAt: later(600_000) });
const WARNING = {
  en: 'Two-step sign-in is off: anyone who has an admin’s password can sign in.',
  fa: 'ورود دومرحله‌ای خاموش است؛ هر کس رمز را داشته باشد وارد می‌شود.',
  tr: 'İki adımlı giriş kapalı: bir yöneticinin parolasını bilen herkes giriş yapabilir.',
};
const sessions = (mfa: boolean) => ({
  items: [
    { id: '77', createdAt: later(-60_000), refreshedAt: later(-1_000), expiresAt: later(3_600_000), ip: '203.0.113.9', userAgent: 'Firefox/140 (X11; Linux)', current: true, mfa },
  ],
});

beforeEach(() => {
  resetPanel();
});

describe('sign-in without a second factor', () => {
  it('goes straight to the page asked for when the login answer completes the sign-in', async () => {
    const api = fakeApi({
      'POST /v1/admin/auth/refresh': () => problem(401, 'refresh_invalid'),
      'POST /v1/admin/auth/login': () => ({ mfaToken: MFA, enrollRequired: true, expiresAt: later(300_000), session: token('access-direct') }),
      'GET /v1/admin/me': () => ({ ...superadmin, totpEnabled: false, totpRequired: false }),
      'GET /v1/admin/plans': () => ({ items: [], catalog: { flags: [], quotas: [] } }),
    });
    const user = userEvent.setup();
    const { router } = renderPanel('/revenue/plans', api);
    await screen.findByRole('heading', { name: 'Sign in to Test Admin' });
    await user.type(screen.getByLabelText('Work e-mail'), 'staff@example.com');
    await user.type(screen.getByLabelText('Password', { exact: true }), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByRole('heading', { name: 'Plans' });
    expect(router.state.location.pathname).toBe('/revenue/plans');
    // No code step, and no enrolment either, though the account has no authenticator.
    expect(api.calls.filter((call) => call.path.startsWith('/v1/admin/auth/totp'))).toEqual([]);
    expect(screen.queryByRole('heading', { name: 'Set up your authenticator' })).toBeNull();
    // The refresh cookie comes with the login answer, so that request carries credentials.
    expect(api.of('POST /v1/admin/auth/login')[0]?.credentials).toBe('include');
    expect(api.of('GET /v1/admin/me')[0]?.authorization).toBe('Bearer access-direct');
    expect(api.of('GET /v1/admin/plans')[0]?.authorization).toBe('Bearer access-direct');
    expect(screen.getByText(WARNING.en).closest('[role="alert"]')).not.toBeNull();
  });

  it('signs an admin who has TOTP in from the session alone: that answer carries no ticket', async () => {
    const api = fakeApi({
      'POST /v1/admin/auth/refresh': () => problem(401, 'refresh_invalid'),
      'POST /v1/admin/auth/login': () => ({ enrollRequired: false, session: token('access-only') }),
      'GET /v1/admin/me': () => ({ ...superadmin, totpRequired: false }),
      'GET /v1/admin/plans': () => ({ items: [], catalog: { flags: [], quotas: [] } }),
    });
    const user = userEvent.setup();
    const { router } = renderPanel('/revenue/plans', api);
    await user.type(await screen.findByLabelText('Work e-mail'), 'staff@example.com');
    await user.type(screen.getByLabelText('Password', { exact: true }), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByRole('heading', { name: 'Plans' });
    expect(router.state.location.pathname).toBe('/revenue/plans');
    expect(api.calls.filter((call) => call.path.startsWith('/v1/admin/auth/totp'))).toEqual([]);
    expect(api.of('GET /v1/admin/me')[0]?.authorization).toBe('Bearer access-only');
  });

  it('still asks for the code when the login answer carries no session', async () => {
    const api = fakeApi({
      'POST /v1/admin/auth/refresh': () => problem(401, 'refresh_invalid'),
      'POST /v1/admin/auth/login': () => ({ mfaToken: MFA, enrollRequired: false, expiresAt: later(300_000) }),
    });
    const user = userEvent.setup();
    renderPanel('/login', api);
    await user.type(await screen.findByLabelText('Work e-mail'), 'staff@example.com');
    await user.type(screen.getByLabelText('Password', { exact: true }), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Enter your code' });
    expect(api.of('GET /v1/admin/me')).toHaveLength(0);
  });
});

describe('the warning while no second factor is required', () => {
  const api = () =>
    fakeApi({
      'GET /v1/admin/me/sessions': () => sessions(true),
      'GET /v1/admin/plans': () => ({ items: [], catalog: { flags: [], quotas: [] } }),
    });

  it('is not there while TOTP is required', async () => {
    signInAs(superadmin);
    renderPanel('/me/security', api());
    await screen.findByRole('heading', { name: 'Security and sessions' });
    await screen.findByText('This session');
    for (const text of Object.values(WARNING)) expect(screen.queryByText(text)).toBeNull();
    expect(screen.queryByText('Two-step sign-in is off')).toBeNull();
    expect(screen.queryByText('Password only')).toBeNull();
  });

  it.each(['en', 'fa', 'tr'] as const)('stays on every page, in %s', async (locale) => {
    signInAs({ ...superadmin, totpRequired: false });
    const { router } = renderPanel('/me/security', api(), { locale });
    const bar = await screen.findByText(WARNING[locale]);
    expect(bar.closest('[role="alert"]')).not.toBeNull();
    await router.navigate('/revenue/plans');
    await waitFor(() => expect(router.state.location.pathname).toBe('/revenue/plans'));
    expect(screen.getByText(WARNING[locale])).toBeTruthy();
  });

  it('says so on the security page too, and marks the sessions the password alone opened', async () => {
    signInAs({ ...superadmin, totpRequired: false });
    renderPanel('/me/security', fakeApi({ 'GET /v1/admin/me/sessions': () => sessions(false) }));
    const notice = (await screen.findByText('Two-step sign-in is off')).closest<HTMLElement>('[role="alert"]')!;
    expect(within(notice).getByText(/Admins sign in with the password alone/)).toBeTruthy();
    const row = (await screen.findByText('This session')).closest('li')!;
    expect(within(row).getByText('Password only')).toBeTruthy();
  });
});
