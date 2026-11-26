import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { endOf, penaltyBody, penaltyProblems, personLocale, prefilledMessage } from '../src/lib/users';
import { adminWith, fakeApi, problem, renderPanel, resetPanel, signInAs } from './panel';
import { MODERATOR, moderatorAdmin, reasons, summary } from './userFixtures';

beforeEach(() => {
  resetPanel();
  signInAs(moderatorAdmin);
});

describe('user rules', () => {
  it('reads a person’s language from their locale, English when the product does not ship it', () => {
    expect(personLocale('fa-IR')).toBe('fa');
    expect(personLocale('tr')).toBe('tr');
    expect(personLocale('de')).toBe('en');
  });

  it('pre-fills the message in the person’s language', () => {
    expect(prefilledMessage(reasons, 'spam', 'fa')).toBe('از حساب شما پیام‌های ناخواسته یا تبلیغاتی فرستاده شده است.');
    expect(prefilledMessage(reasons, 'nope', 'fa')).toBe('');
  });

  it('ends a period from a preset or at the end of a chosen day, and refuses what is not ahead', () => {
    const now = Date.parse('2026-11-26T10:00:00.000Z');
    expect(endOf('3d', '', now)).toEqual({ endsAt: '2026-11-29T10:00:00.000Z' });
    expect(endOf('permanent', '', now)).toEqual({});
    expect(endOf('', '', now)).toEqual({ error: 'action.error.until' });
    expect(endOf('date', '2026-11-20', now)).toEqual({ error: 'action.error.untilPast' });
    expect(endOf('date', '2026-12-01', now).endsAt).toBe(new Date('2026-12-01T23:59:00').toISOString());
    expect(endOf('date', '', now)).toEqual({ error: 'action.error.date' });
  });

  it('puts the end’s problem on the date field once “a date” is chosen', () => {
    const now = Date.parse('2026-11-26T10:00:00.000Z');
    const form = { reason: 'spam' as const, message: 'Stop.', until: 'date' as const, date: '', note: '' };
    expect(penaltyProblems('suspend', form, now)).toEqual({ date: 'action.error.date' });
    expect(penaltyProblems('ban', { ...form, date: '2026-11-20' }, now)).toEqual({ date: 'action.error.untilPast' });
    expect(penaltyProblems('suspend', { ...form, until: '' }, now)).toEqual({ until: 'action.error.until' });
  });

  it('builds the exact body of each kind', () => {
    const now = Date.parse('2026-11-26T10:00:00.000Z');
    const form = { reason: 'spam' as const, message: ' Stop. ', until: '7d' as const, date: '', note: '' };
    expect(penaltyBody('warn', form, now)).toEqual({ reason: 'spam', reasonText: 'Stop.' });
    expect(penaltyBody('suspend', { ...form, note: ' second ' }, now, '77')).toEqual({ reason: 'spam', reasonText: 'Stop.', note: 'second', endsAt: '2026-12-03T10:00:00.000Z', reportId: '77' });
    expect(penaltyBody('ban', { ...form, until: 'permanent' }, now)).toEqual({ reason: 'spam', reasonText: 'Stop.' });
    expect(penaltyBody('shadowban', form, now)).toEqual({ reason: 'spam', endsAt: '2026-12-03T10:00:00.000Z' });
    expect(penaltyProblems('suspend', { ...form, until: '' }, now)).toEqual({ until: 'action.error.until' });
    expect(penaltyProblems('shadowban', { ...form, message: '' }, now)).toEqual({});
    expect(penaltyProblems('warn', { ...form, reason: '', message: ' ' }, now)).toEqual({ reason: 'form.required', message: 'form.required' });
  });
});

describe('the users page', () => {
  const people = [summary('aaaaaaaaaaaaa', { name: 'Sara Ahmadi', shadowbanned: true }), summary('bbbbbbbbbbbbb', { name: 'علی رضایی', status: 'banned', test: true })];

  it('lists people, loads more with the cursor, and writes the filter into the URL', async () => {
    const api = fakeApi({
      'GET /v1/admin/users': (call) =>
        call.query['cursor'] === 'c2' ? { items: [summary('ccccccccccccc', { name: 'Zeynep Kaya' })], nextCursor: null } : { items: call.query['filter'] === 'banned' ? [people[1]] : people, nextCursor: 'c2' },
    });
    const user = userEvent.setup();
    const { router } = renderPanel('/users', api);
    expect(await screen.findByText('Sara Ahmadi')).toBeTruthy();
    expect(screen.getByText('علی رضایی')).toBeTruthy();
    expect(screen.getAllByText('Shadowbanned').length).toBeGreaterThan(0);
    expect(screen.getByText('Test account')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Zeynep Kaya')).toBeTruthy();
    const cursors = api.of('GET /v1/admin/users').map((c) => c.query['cursor'] ?? null);
    expect(cursors[0]).toBeNull();
    expect(cursors.at(-1)).toBe('c2');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'banned');
    await waitFor(() => expect(router.state.location.search).toBe('?filter=banned'));
    await waitFor(() => expect(api.of('GET /v1/admin/users').at(-1)?.query).toEqual({ filter: 'banned', limit: '20' }));
  });

  it('searches with the text in the body only, never in the URL, and goes back to the list', async () => {
    const api = fakeApi({
      'GET /v1/admin/users': () => ({ items: people, nextCursor: null }),
      'POST /v1/admin/users/search': () => ({ items: [{ ...people[0]!, matchedBy: 'phone' }] }),
    });
    const user = userEvent.setup();
    const { router } = renderPanel('/users', api);
    await screen.findByText('علی رضایی');
    // A plain text box in a search form: no browser clear button beside the panel's own.
    const box = within(screen.getByRole('search')).getByRole('textbox', { name: 'Search' });
    expect(box.getAttribute('type')).toBe('text');
    await user.type(box, '+98 912 123 4567');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('by phone')).toBeTruthy();
    expect(screen.queryByText('علی رضایی')).toBeNull();
    expect(api.of('POST /v1/admin/users/search')[0]?.body).toEqual({ q: '+98 912 123 4567' });
    expect(router.state.location.pathname + router.state.location.search).toBe('/users');
    expect(api.calls.every((c) => !JSON.stringify(c.query).includes('912'))).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByText('علی رضایی')).toBeTruthy();
  });

  it('shows only the error when the list fails to load, never “No people.” under it', async () => {
    renderPanel('/users', fakeApi({ 'GET /v1/admin/users': () => problem(503, 'service_unavailable') }));
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText('No people.')).toBeNull();
  });

  it('names countries in the panel’s language', async () => {
    renderPanel('/users', fakeApi({ 'GET /v1/admin/users': () => ({ items: [summary('aaaaaaaaaaaaa', { country: 'TR' })], nextCursor: null }) }));
    expect(await screen.findByText('Türkiye')).toBeTruthy();
    expect(screen.queryByText('TR')).toBeNull();
  });

  it('opens a person’s page from a row', async () => {
    const api = fakeApi({ 'GET /v1/admin/users': () => ({ items: people, nextCursor: null }) });
    const user = userEvent.setup();
    const { router } = renderPanel('/users', api);
    await user.click(await screen.findByText('Sara Ahmadi'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/users/aaaaaaaaaaaaa'));
  });

  it('is hidden from a role without users.read, and sends nothing', async () => {
    signInAs(adminWith(['billing.read'], ['finance']));
    const api = fakeApi({});
    renderPanel('/users', api);
    await screen.findByText('No access');
    const nav = screen.getByRole('navigation');
    expect(within(nav).queryByRole('link', { name: /Users/ })).toBeNull();
    await waitFor(() => expect(api.calls.filter((call) => call.path.startsWith('/v1/admin/users'))).toHaveLength(0));
  });

  it('shows the navigation item to a role that reads users', async () => {
    signInAs(adminWith(MODERATOR, ['moderator']));
    renderPanel('/users', fakeApi({ 'GET /v1/admin/users': () => ({ items: [], nextCursor: null }) }));
    expect(await screen.findByText('No people.')).toBeTruthy();
    expect(within(screen.getByRole('navigation')).getByRole('link', { name: /Users/ })).toBeTruthy();
  });

  it('speaks Persian, right to left', async () => {
    const api = fakeApi({ 'GET /v1/admin/users': () => ({ items: people, nextCursor: null }) });
    renderPanel('/users', api, { locale: 'fa' });
    expect(await screen.findByRole('heading', { name: 'کاربران' })).toBeTruthy();
    expect(await screen.findByText('علی رضایی')).toBeTruthy();
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getAllByText('پنهان‌سازی بی‌صدا').length).toBeGreaterThan(0);
    expect(screen.getByText('حساب آزمایشی')).toBeTruthy();
    expect(screen.getAllByText('مسدود').length).toBe(2);
  });

  it('speaks Turkish', async () => {
    renderPanel('/users', fakeApi({ 'GET /v1/admin/users': () => ({ items: people, nextCursor: null }) }), { locale: 'tr' });
    expect(await screen.findByRole('heading', { name: 'Kullanıcılar' })).toBeTruthy();
    expect(await screen.findByText('Sara Ahmadi')).toBeTruthy();
    expect(screen.getAllByText('Gölge yasak').length).toBeGreaterThan(0);
    expect(screen.getByText('Test hesabı')).toBeTruthy();
  });
});
