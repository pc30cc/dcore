import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { groupSecret, normalizeCode, safeReturnPath } from '../src/lib/signIn';
import { fakeApi, owner, problem, renderPanel, resetPanel } from './panel';

const MFA = `amf1.${'a'.repeat(43)}`;
const later = () => new Date(Date.now() + 300_000).toISOString();
const token = (value = 'access-1') => ({ accessToken: value, expiresAt: new Date(Date.now() + 600_000).toISOString() });
const OTPAUTH = 'otpauth://totp/Test:owner%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Test&algorithm=SHA1&digits=6&period=30';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

beforeEach(() => {
  resetPanel();
});

async function enterCredentials(user: ReturnType<typeof userEvent.setup>, password = 'correct horse battery') {
  await user.type(await screen.findByLabelText('Work e-mail'), 'owner@example.com');
  await user.type(screen.getByLabelText('Password', { exact: true }), password);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
}

describe('sign-in', () => {
  it('signs in with e-mail, password and a code, then opens the page asked for', async () => {
    const api = fakeApi({
      'POST /v1/admin/auth/refresh': () => problem(401, 'refresh_invalid'),
      'POST /v1/admin/auth/login': () => ({ mfaToken: MFA, enrollRequired: false, expiresAt: later() }),
      'POST /v1/admin/auth/totp': () => token(),
      'GET /v1/admin/me': () => owner,
      'GET /v1/admin/plans': () => ({ items: [], catalog: { flags: [], quotas: [] } }),
    });
    const user = userEvent.setup();
    const { router } = renderPanel('/revenue/plans', api);

    // No session yet: the guard tries the refresh cookie once, then asks to sign in.
    await screen.findByRole('heading', { name: 'Sign in to Test Admin' });
    expect(api.of('POST /v1/admin/auth/refresh')[0]?.credentials).toBe('include');
    await enterCredentials(user);
    expect(api.of('POST /v1/admin/auth/login')[0]?.body).toEqual({ email: 'owner@example.com', password: 'correct horse battery' });

    await screen.findByRole('heading', { name: 'Enter your code' });
    // Persian digits count; the code goes once it has 6 digits.
    await user.type(screen.getByLabelText('Authentication code'), '۱۲۳۴۵۶');
    await screen.findByRole('heading', { name: 'Plans' });
    expect(router.state.location.pathname).toBe('/revenue/plans');
    const sent = api.of('POST /v1/admin/auth/totp')[0];
    expect(sent?.body).toEqual({ mfaToken: MFA, code: '123456' });
    // The refresh cookie is set on the code step's answer, so that request carries credentials.
    expect(sent?.credentials).toBe('include');
    expect(api.of('GET /v1/admin/me')[0]?.authorization).toBe('Bearer access-1');
    expect(api.of('GET /v1/admin/plans')[0]?.authorization).toBe('Bearer access-1');
    expect(api.of('GET /v1/admin/plans')[0]?.credentials).toBe('omit');
  });

  it('answers every refused password the same way and says when the account locks', async () => {
    const api = fakeApi({
      'POST /v1/admin/auth/refresh': () => problem(401, 'refresh_invalid'),
      'POST /v1/admin/auth/login': () => problem(401, 'unauthorized', { detail: 'E-mail or password not valid.' }),
    });
    const user = userEvent.setup();
    renderPanel('/login', api);
    await screen.findByText(/After 5 failed attempts/);
    await enterCredentials(user, 'wrong');
    await screen.findByText(/The e-mail or password is not right, or the account is locked for 15 minutes/);
  });

  it('says how many codes are left, and goes back to the password when the account locks', async () => {
    let codes = 0;
    const api = fakeApi({
      'POST /v1/admin/auth/refresh': () => problem(401, 'refresh_invalid'),
      'POST /v1/admin/auth/login': () => ({ mfaToken: MFA, enrollRequired: false, expiresAt: later() }),
      'POST /v1/admin/auth/totp': () => (++codes === 1 ? problem(400, 'otp_invalid', { attemptsLeft: 3 }) : problem(429, 'otp_locked')),
    });
    const user = userEvent.setup();
    const { router } = renderPanel('/login', api);
    await enterCredentials(user);
    const code = await screen.findByLabelText('Authentication code');
    await user.type(code, '000000');
    await screen.findByText('Wrong code. 3 attempts left before the account locks for 15 minutes.');
    expect((code as HTMLInputElement).value).toBe('');
    await user.type(code, '111111');
    // The ticket is over: the password step says the account is locked.
    await screen.findByText('Too many failed attempts: the account is locked for 15 minutes.');
    expect(router.state.location.pathname).toBe('/login');
    // And the code step cannot be reopened without a new ticket.
    await router.navigate('/login/totp');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });

  it('sends an expired ticket back to the password step with a notice', async () => {
    const api = fakeApi({
      'POST /v1/admin/auth/refresh': () => problem(401, 'refresh_invalid'),
      'POST /v1/admin/auth/login': () => ({ mfaToken: MFA, enrollRequired: false, expiresAt: later() }),
      'POST /v1/admin/auth/totp': () => problem(401, 'unauthorized'),
    });
    const user = userEvent.setup();
    renderPanel('/login', api);
    await enterCredentials(user);
    await user.type(await screen.findByLabelText('Authentication code'), '123456');
    await screen.findByText('The sign-in expired (after 5 minutes). Start again with your e-mail and password.');
    expect(screen.getByRole('heading', { name: 'Sign in to Test Admin' })).toBeTruthy();
  });

  it('enrols the authenticator on the first sign-in: one secret, a QR drawn in the page, the key by hand', async () => {
    const api = fakeApi({
      'POST /v1/admin/auth/refresh': () => problem(401, 'refresh_invalid'),
      'POST /v1/admin/auth/login': () => ({ mfaToken: MFA, enrollRequired: true, expiresAt: later() }),
      'POST /v1/admin/auth/totp/enroll': () => ({ otpauthUri: OTPAUTH, secret: SECRET }),
      'POST /v1/admin/auth/totp/confirm': () => token('access-2'),
      'GET /v1/admin/me': () => ({ ...owner, totpEnabled: true }),
    });
    const user = userEvent.setup();
    const { router } = renderPanel('/login', api);
    await enterCredentials(user);
    await screen.findByRole('heading', { name: 'Set up your authenticator' });
    const qr = await screen.findByRole('img', { name: 'QR code for your authenticator app' });
    expect(qr.tagName.toLowerCase()).toBe('svg');
    expect(qr.querySelectorAll('path').length).toBeGreaterThan(0);
    expect(screen.getByText(groupSecret(SECRET))).toBeTruthy();
    // StrictMode runs effects twice: the secret is still asked once (a second ask would replace it).
    expect(api.of('POST /v1/admin/auth/totp/enroll')).toHaveLength(1);
    // No request leaves the page to draw the code.
    expect(api.calls.every((call) => call.path.startsWith('/v1/admin/'))).toBe(true);

    await user.type(screen.getByLabelText('Code from the app'), '654321');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(api.of('POST /v1/admin/auth/totp/confirm')[0]?.body).toEqual({ mfaToken: MFA, code: '654321' });
    expect(api.of('POST /v1/admin/auth/totp/confirm')[0]?.credentials).toBe('include');
  });

  it('opens the panel straight away with a refresh cookie from an earlier visit', async () => {
    const api = fakeApi({
      'POST /v1/admin/auth/refresh': () => token('access-3'),
      'GET /v1/admin/me': () => owner,
      'GET /v1/admin/plans': () => ({ items: [], catalog: { flags: [], quotas: [] } }),
    });
    renderPanel('/revenue/plans', api);
    await screen.findByRole('heading', { name: 'Plans' });
    expect(api.of('POST /v1/admin/auth/login')).toHaveLength(0);
  });

  it('asks to sign in again when the session ends under an open panel', async () => {
    let refreshes = 0;
    const api = fakeApi({
      // The first refresh opens the panel; the session is then revoked elsewhere.
      'POST /v1/admin/auth/refresh': () => (++refreshes === 1 ? token('access-4') : problem(401, 'refresh_invalid')),
      'GET /v1/admin/me': () => owner,
      'GET /v1/admin/plans': () => problem(401, 'unauthorized'),
    });
    const { router } = renderPanel('/revenue/plans', api);
    await screen.findByText('Your session ended');
    expect(router.state.location.pathname).toBe('/login');
    // The refused read asked for one refresh, which the API refused too: no loop.
    expect(refreshes).toBe(2);
    expect(api.of('GET /v1/admin/plans').every((call) => call.authorization === 'Bearer access-4')).toBe(true);
  });

  it('signs out: the API forgets the session and the sign-in page says so', async () => {
    const api = fakeApi({
      'POST /v1/admin/auth/refresh': () => token('access-5'),
      'GET /v1/admin/me': () => owner,
      'POST /v1/admin/auth/logout': () => undefined,
    });
    const user = userEvent.setup();
    renderPanel('/', api);
    await user.click(await screen.findByRole('button', { name: 'Your account' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    await screen.findByText('You are signed out.');
    const logout = api.of('POST /v1/admin/auth/logout')[0];
    expect(logout?.credentials).toBe('include');
    expect(logout?.authorization).toBe('Bearer access-5');
  });

  it('shows only the sections the roles reach', async () => {
    const api = fakeApi({
      'POST /v1/admin/auth/refresh': () => token(),
      'GET /v1/admin/me': () => ({ ...owner, roles: ['analyst'], permissions: ['dashboard.read'] }),
    });
    const { router } = renderPanel('/', api);
    await screen.findByRole('link', { name: /Dashboard/ });
    expect(screen.queryByRole('link', { name: 'Plans' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Admins' })).toBeNull();
    await router.navigate('/revenue/plans');
    await screen.findByText('No access');
  });
});

describe('sign-in helpers', () => {
  it('reads codes typed in any digits and keeps 6', () => {
    expect(normalizeCode('۱۲۳ ۴۵۶')).toBe('123456');
    expect(normalizeCode('١٢٣٤٥٦٧')).toBe('123456');
    expect(normalizeCode('12-34-56')).toBe('123456');
  });

  it('only returns to panel paths', () => {
    expect(safeReturnPath('/revenue/plans?x=1')).toBe('/revenue/plans?x=1');
    expect(safeReturnPath('//evil.example.com')).toBe('/');
    expect(safeReturnPath('https://evil.example.com')).toBe('/');
    expect(safeReturnPath('/login/totp')).toBe('/');
    expect(safeReturnPath(undefined)).toBe('/');
  });

  it('groups the secret by four for typing', () => {
    expect(groupSecret('ABCDEFGHIJ')).toBe('ABCD EFGH IJ');
  });
});
