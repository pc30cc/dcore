import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminWith, fakeApi, owner, plan, planList, problem, renderPanel, resetPanel, signInAs } from './panel';
import { ADMIN, action, detail, fullAdmin, moderatorAdmin, READ, readOnlyAdmin, SARA, summary } from './userFixtures';

beforeEach(() => {
  resetPanel();
  signInAs(moderatorAdmin);
});

function pageApi(extra: Record<string, () => unknown> = {}) {
  return fakeApi({
    [`GET /v1/admin/users/${SARA}`]: () => detail({ shadowbanned: true, heldNow: true, standing: [action('51')] }),
    [`GET /v1/admin/users/${SARA}/photos`]: () => ({
      items: [
        { id: '7', position: 0, status: 'approved', modFlags: [], hasFace: true, width: 1080, height: 1350, uploadedAt: '2026-11-20T10:00:00.000Z', decidedAt: null, decidedBy: null },
        { id: '8', position: 1, status: 'rejected', rejectReason: 'nudity', modFlags: ['nudity'], hasFace: true, width: 1080, height: 1350, uploadedAt: '2026-11-20T10:00:00.000Z', decidedAt: null, decidedBy: null },
      ],
    }),
    [`GET /v1/admin/users/${SARA}/moderation`]: () => ({
      items: [action('51'), action('50', { kind: 'shadowban', reason: 'spam', reasonText: 'Your account sent spam or unwanted promotion.', note: 'link farm', standing: false, revokedAt: '2026-11-22T09:00:00.000Z' })],
      nextCursor: null,
    }),
    ...extra,
  });
}

describe('the user page', () => {
  it('shows the header with the public id and every badge, the texts with their states, and the photos', async () => {
    const api = pageApi();
    renderPanel(`/users/${SARA}`, api);
    expect(await screen.findByRole('heading', { name: /Sara Ahmadi/ })).toBeTruthy();
    // The button's name carries the id itself, not only "Copy ID".
    expect(screen.getByRole('button', { name: `Copy ID ${SARA}` }).textContent).toContain(SARA);
    expect(screen.getByText('Shadowbanned')).toBeTruthy();
    expect(screen.getByText('Legal hold')).toBeTruthy();
    expect(screen.getByText('I like mountains')).toBeTruthy();
    expect(screen.getByText('Tea at sunrise')).toBeTruthy();
    expect(screen.getAllByText('Waiting').length).toBeGreaterThan(0);
    expect(await screen.findByText('Nudity or sexual')).toBeTruthy();
    // Only the open tab is read.
    expect(api.of(`GET /v1/admin/users/${SARA}/moderation`)).toHaveLength(0);
  });

  it('reads a tab when it is first opened, with its name in the URL', async () => {
    const api = pageApi();
    const user = userEvent.setup();
    const { router } = renderPanel(`/users/${SARA}`, api);
    await user.click(await screen.findByRole('tab', { name: 'Moderation' }));
    expect(await screen.findByText('link farm', { exact: false })).toBeTruthy();
    expect(screen.getAllByText('Shadowban').length).toBeGreaterThan(0);
    expect(router.state.location.search).toBe('?tab=moderation');
    expect(api.of(`GET /v1/admin/users/${SARA}/moderation`).length).toBeGreaterThan(0);
    expect(screen.queryByRole('tab', { name: 'Audit log' })).toBeNull();
  });

  it('shows the phone only to a role holding users.view_phone, on request, and keeps it out of the URL', async () => {
    renderPanel(`/users/${SARA}`, pageApi());
    await screen.findByRole('heading', { name: /Sara Ahmadi/ });
    expect(screen.queryByRole('button', { name: 'Show phone' })).toBeNull();
  });

  it('reveals the number through the audited route', async () => {
    signInAs(fullAdmin);
    const api = pageApi({ [`POST /v1/admin/users/${SARA}/reveal-phone`]: () => ({ phone: '+989121234567' }) });
    const user = userEvent.setup();
    const { router } = renderPanel(`/users/${SARA}`, api);
    await user.click(await screen.findByRole('button', { name: 'Show phone' }));
    expect(await screen.findByText('+989121234567')).toBeTruthy();
    expect(api.of(`POST /v1/admin/users/${SARA}/reveal-phone`)).toHaveLength(1);
    expect(router.state.location.search).not.toContain('989');
    expect(screen.getByRole('tab', { name: 'Audit log' })).toBeTruthy();
  });

  it('offers no write to a read-only role', async () => {
    signInAs(readOnlyAdmin);
    renderPanel(`/users/${SARA}`, pageApi());
    await screen.findByRole('heading', { name: /Sara Ahmadi/ });
    expect(screen.queryByRole('button', { name: 'Actions' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve texts' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Test account' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Reports' })).toBeNull();
  });

  it('lets the owner make a test account after a question', async () => {
    signInAs({ ...owner, permissions: [...ADMIN, 'users.test_account'] });
    const api = pageApi({ [`POST /v1/admin/users/${SARA}/test-account`]: () => ({ user: detail({ test: true }), sideEffects: 'done' }) });
    const user = userEvent.setup();
    renderPanel(`/users/${SARA}`, api);
    await user.click(await screen.findByRole('switch', { name: 'Test account' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(api.of(`POST /v1/admin/users/${SARA}/test-account`)).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Make test account' }));
    await waitFor(() => expect(api.of(`POST /v1/admin/users/${SARA}/test-account`)[0]?.body).toEqual({ test: true }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('is not the test switch of an admin who is not the owner', async () => {
    signInAs(adminWith([...ADMIN, 'users.test_account']));
    renderPanel(`/users/${SARA}`, pageApi());
    await screen.findByRole('heading', { name: /Sara Ahmadi/ });
    expect(screen.queryByRole('switch', { name: 'Test account' })).toBeNull();
  });

  it('speaks Persian, right to left', async () => {
    renderPanel(`/users/${SARA}`, pageApi(), { locale: 'fa' });
    expect(await screen.findByRole('heading', { name: /Sara Ahmadi/ })).toBeTruthy();
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByRole('tab', { name: 'نظارت' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'گزارش‌ها' })).toBeTruthy();
    expect(screen.getByText('پنهان‌شده (بی‌صدا)')).toBeTruthy();
    expect(screen.getByText('نگه‌داری قانونی')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'اقدام‌ها' })).toBeTruthy();
  });
});

describe('the user page: review fixes', () => {
  it('opens the profile, and reads nothing it may not, when the URL names a tab the role cannot open', async () => {
    signInAs(readOnlyAdmin);
    const api = pageApi();
    for (const tab of ['audit', 'reports']) {
      const { unmount } = renderPanel(`/users/${SARA}?tab=${tab}`, api);
      expect(await screen.findByText('I like mountains')).toBeTruthy();
      expect(screen.getByRole('tab', { name: 'Profile' }).getAttribute('aria-selected')).toBe('true');
      unmount();
    }
    expect(api.of(`GET /v1/admin/users/${SARA}/audit`)).toHaveLength(0);
    expect(api.of(`GET /v1/admin/users/${SARA}/reports`)).toHaveLength(0);
  });

  it('keeps the way back while the person loads, and names an unknown one without a retry', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const slow = fakeApi({ [`GET /v1/admin/users/${SARA}`]: () => new Promise((resolve) => (answer = resolve)) });
    const { unmount } = renderPanel(`/users/${SARA}`, slow);
    expect(await within(screen.getByRole('main')).findByRole('link', { name: 'Users' })).toBeTruthy();
    answer(detail());
    expect(await screen.findByRole('heading', { name: /Sara Ahmadi/ })).toBeTruthy();
    unmount();
    renderPanel('/users/zzzzzzzzzzzzz', fakeApi({ 'GET /v1/admin/users/zzzzzzzzzzzzz': () => problem(404, 'not_found') }));
    expect(await screen.findByRole('heading', { name: 'No such person' })).toBeTruthy();
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Users' }).getAttribute('href')).toBe('/users');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('names the parts a text rejection took, and gives a sign-out no reason', async () => {
    const api = pageApi({
      [`GET /v1/admin/users/${SARA}/moderation`]: () => ({
        items: [
          action('62', { kind: 'sessions_revoked', reason: 'other', reasonText: '', note: null, standing: false }),
          action('61', { kind: 'text_rejected', reason: 'contact_details', note: 'about/job, prompt 1, prompt 3', standing: false }),
          action('60', { kind: 'text_rejected', reason: 'offensive', note: 'name', standing: false }),
          action('59', { kind: 'lift', reason: 'spam', reasonText: 'Lifted.', standing: false }),
        ],
        nextCursor: null,
      }),
    });
    const user = userEvent.setup();
    renderPanel(`/users/${SARA}`, api);
    await user.click(await screen.findByRole('tab', { name: 'Moderation' }));
    expect(await screen.findByText('Signed out everywhere')).toBeTruthy();
    expect(screen.queryByText('Other')).toBeNull();
    expect(screen.getByText('About and job')).toBeTruthy();
    expect(screen.getByText('Prompt 1')).toBeTruthy();
    expect(screen.getByText('Prompt 3')).toBeTruthy();
    expect(screen.getByText('Display name')).toBeTruthy();
    expect(screen.queryByText(/about\/job/)).toBeNull();
    expect(screen.queryByText('name')).toBeNull();
    // The lift's default text is no note.
    expect(screen.queryByText('Lifted.')).toBeNull();
  });

  it('shows no note line for a lift whose text was withheld from the caller', async () => {
    const api = pageApi({
      [`GET /v1/admin/users/${SARA}/moderation`]: () => ({
        items: [
          action('64', { kind: 'lift', reason: 'spam', reasonText: '', standing: false }),
          action('63', { kind: 'lift', reason: 'spam', reasonText: 'Reporter withdrew.', standing: false }),
        ],
        nextCursor: null,
      }),
    });
    const user = userEvent.setup();
    renderPanel(`/users/${SARA}`, api);
    await user.click(await screen.findByRole('tab', { name: 'Moderation' }));
    expect(await screen.findByText('Reporter withdrew.')).toBeTruthy();
    // One note line: the lift with a text; the one sent empty has none.
    expect(screen.getAllByText('Note:', { exact: false })).toHaveLength(1);
  });

  it('shows countries, languages and plans by their names', async () => {
    signInAs(adminWith([...ADMIN, 'billing.read']));
    const api = pageApi({
      [`GET /v1/admin/users/${SARA}`]: () => detail({ locale: 'tr-DE', country: 'DE' }),
      [`GET /v1/admin/users/${SARA}/purchases`]: () => ({
        subscriptions: [{ store: 'bazaar', plan: 'plus', status: 'renewing', startedAt: '2026-11-01T10:00:00.000Z', expiresAt: '2026-12-01T10:00:00.000Z', autoRenew: true }],
        items: [],
      }),
      'GET /v1/admin/plans': () => planList([plan('plus', { names: { en: 'Plus', fa: 'پلاس' } })]),
      [`GET /v1/admin/users/${SARA}/devices`]: () => ({
        items: [{ id: '5', platform: 'android', store: 'bazaar', appVersion: 120, integrity: 'unknown', locale: 'tr-DE', updatedAt: '2026-11-25T10:00:00.000Z', disabledAt: null, push: true, linked: [] }],
      }),
    });
    const user = userEvent.setup();
    renderPanel(`/users/${SARA}`, api);
    expect(await screen.findByText('Germany')).toBeTruthy();
    expect(screen.getByText('Turkish (Germany)')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Purchases' }));
    expect(await screen.findByText('Plus')).toBeTruthy();
    expect(screen.getByText('plus')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Devices' }));
    expect(await screen.findByText('120')).toBeTruthy();
    expect(screen.getAllByText('Turkish (Germany)').length).toBeGreaterThan(0);
  });

  it('shows the plan key alone to a role that does not read billing, and reads no plans', async () => {
    signInAs(adminWith(READ, ['support']));
    const api = pageApi({
      [`GET /v1/admin/users/${SARA}/purchases`]: () => ({
        subscriptions: [{ store: 'play', plan: 'plus', status: 'renewing', startedAt: '2026-11-01T10:00:00.000Z', expiresAt: '2026-12-01T10:00:00.000Z', autoRenew: true }],
        items: [],
      }),
    });
    const user = userEvent.setup();
    renderPanel(`/users/${SARA}`, api);
    await user.click(await screen.findByRole('tab', { name: 'Purchases' }));
    expect(await screen.findByText('plus')).toBeTruthy();
    expect(api.of('GET /v1/admin/plans')).toHaveLength(0);
  });

  it('switches received and filed reports as tabs, with the arrow keys', async () => {
    const api = pageApi({ [`GET /v1/admin/users/${SARA}/reports`]: () => ({ items: [], nextCursor: null }) });
    const user = userEvent.setup();
    renderPanel(`/users/${SARA}`, api);
    await user.click(await screen.findByRole('tab', { name: 'Reports' }));
    const received = await screen.findByRole('tab', { name: 'Received' });
    expect(received.getAttribute('aria-selected')).toBe('true');
    received.focus();
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Filed' }).getAttribute('aria-selected')).toBe('true'));
    await waitFor(() => expect(api.of(`GET /v1/admin/users/${SARA}/reports`).at(-1)?.query['side']).toBe('filed'));
    expect(new Set(api.of(`GET /v1/admin/users/${SARA}/reports`).map((c) => c.query['side']))).toEqual(new Set(['received', 'filed']));
  });

  it('isolates each string of an audit detail, so a Persian value keeps its direction', async () => {
    signInAs(fullAdmin);
    const api = pageApi({
      [`GET /v1/admin/users/${SARA}/audit`]: () => ({
        items: [{ id: '9', at: '2026-11-26T08:00:00.000Z', admin: { id: '3', displayName: 'Mina' }, action: 'user.warn', targetType: 'user', targetRef: null, user: SARA, ip: null, detail: { reasonText: 'پیام فرستاده شد.' } }],
        nextCursor: null,
      }),
    });
    const user = userEvent.setup();
    renderPanel(`/users/${SARA}`, api);
    await user.click(await screen.findByRole('tab', { name: 'Audit log' }));
    await user.click(await screen.findByRole('button', { name: 'Show details' }));
    const value = await screen.findByText('"پیام فرستاده شد."');
    expect(value.tagName).toBe('BDI');
  });

  it('writes the app version in Persian digits', async () => {
    const api = pageApi({
      [`GET /v1/admin/users/${SARA}/devices`]: () => ({
        items: [{ id: '5', platform: 'android', store: 'bazaar', appVersion: 120, integrity: 'unknown', locale: null, updatedAt: '2026-11-25T10:00:00.000Z', disabledAt: null, push: true, linked: [summary('ccccccccccccc')] }],
      }),
    });
    const user = userEvent.setup();
    renderPanel(`/users/${SARA}`, api, { locale: 'fa' });
    expect(await screen.findByText('ایران')).toBeTruthy();
    await user.click(await screen.findByRole('tab', { name: 'دستگاه‌ها' }));
    expect(await screen.findByText('۱۲۰')).toBeTruthy();
  });
});
