import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminWith, fakeApi, renderPanel, resetPanel, signInAs } from './panel';
import { moderator, page, reportSummary } from './moderationFixtures';

beforeEach(() => {
  resetPanel();
  signInAs(moderator);
});

function listApi() {
  return fakeApi({
    'GET /v1/admin/reports': (call) => {
      const view = call.query['view'];
      if (view === 'resolved') return page([reportSummary('301', { status: 'actioned', resolution: 'ban', resolvedAt: '2026-11-25T12:00:00.000Z' })]);
      if (view === 'mine') return page([reportSummary('302', { assignee: { id: '9', displayName: 'Mina Moderator' }, status: 'in_review' })]);
      if (call.query['cursor'] === 'more') return page([reportSummary('305', { priority: 20, reason: 'spam' })]);
      return page(
        [reportSummary('303', { priority: 100, reason: 'child_safety', reporter: null, evidence: 'collecting' }), reportSummary('304')],
        'more',
      );
    },
  });
}

describe('the reports page', () => {
  it('shows the queue most urgent first, the automatic reporter and the evidence still collecting', async () => {
    const api = listApi();
    renderPanel('/moderation/reports', api);
    expect(await screen.findByText('Child safety')).toBeTruthy();
    const rows = screen.getAllByRole('row').slice(1);
    // In its column, and with the reason for a phone.
    expect(within(rows[0]!).getAllByText('100')).toHaveLength(2);
    expect(within(rows[0]!).getByText('Automatic')).toBeTruthy();
    expect(within(rows[0]!).getByText('Collecting')).toBeTruthy();
    expect(within(rows[1]!).getByText('Reporter Two')).toBeTruthy();
    expect(api.of('GET /v1/admin/reports')[0]?.query).toMatchObject({ view: 'queue', limit: '25' });
  });

  it('loads more with the cursor', async () => {
    const api = listApi();
    renderPanel('/moderation/reports', api);
    await screen.findByText('Child safety');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Spam')).toBeTruthy();
    expect(api.of('GET /v1/admin/reports').at(-1)?.query['cursor']).toBe('more');
  });

  it('switches views in the URL; the closed view shows how each was closed', async () => {
    const api = listApi();
    const user = userEvent.setup();
    const { router } = renderPanel('/moderation/reports', api);
    await screen.findByText('Child safety');
    await user.click(screen.getByRole('tab', { name: 'Mine' }));
    expect(await screen.findByText('Mina Moderator')).toBeTruthy();
    expect(router.state.location.search).toBe('?view=mine');
    await user.click(screen.getByRole('tab', { name: 'Closed' }));
    expect(await screen.findByRole('columnheader', { name: 'Resolution' })).toBeTruthy();
    expect(screen.getByText('Ban')).toBeTruthy();
    expect(router.state.location.search).toBe('?view=resolved');
    await user.click(screen.getByRole('tab', { name: 'Queue' }));
    expect(router.state.location.search).toBe('');
  });

  it('opens a report from its row', async () => {
    const api = listApi();
    const { router } = renderPanel('/moderation/reports', api);
    await screen.findByText('Child safety');
    await userEvent.setup().click(screen.getByText('Child safety'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/moderation/reports/303'));
  });

  it('opens a report from the keyboard: the reason is a link named with the person, before the people’s links', async () => {
    const user = userEvent.setup();
    const { router } = renderPanel('/moderation/reports', listApi());
    const link = await screen.findByRole('link', { name: 'Child safety report on Reported One' });
    expect(link.getAttribute('href')).toBe('/moderation/reports/303');
    const row = link.closest('tr')!;
    const links = within(row).getAllByRole('link');
    expect(links[0]).toBe(link);
    // A long name is cut in the list, and whole on hover.
    expect(within(row).getByText('Reported One').getAttribute('title')).toBe('Reported One');
    link.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/moderation/reports/303'));
  });

  it('is closed to a role without reports.read, with no request', async () => {
    signInAs(adminWith(['users.read'], ['support']));
    const api = listApi();
    renderPanel('/moderation/reports', api);
    expect(await screen.findByText('No access')).toBeTruthy();
    expect(api.of('GET /v1/admin/reports')).toHaveLength(0);
  });

  it('is right to left in Persian, with the glossary words', async () => {
    renderPanel('/moderation/reports', listApi(), { locale: 'fa' });
    expect(await screen.findByRole('heading', { name: 'گزارش‌ها' })).toBeTruthy();
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByRole('tab', { name: 'سپرده به من' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'بسته‌شده' })).toBeTruthy();
    expect(await screen.findByText('ایمنی کودکان')).toBeTruthy();
    // «بخش», not «محل» (a place).
    expect(screen.getByRole('columnheader', { name: 'بخش' })).toBeTruthy();
  });
});
