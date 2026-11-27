import { expandGrants } from '@app/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../src/i18n/messages';
import { LIVE_POLL_MS } from '../src/lib/stats';
import { adminWith, fakeApi, owner, problem, renderPanel, resetPanel, signInAs } from './panel';

/** The owner as the API describes it: every permission (`*` expanded). */
const theOwner = { ...owner, permissions: expandGrants(['*']) };
import { live, liveWaiting } from './statsFixtures';

/**
 * `/`: today's figures from `GET /v1/admin/stats/live` (no database read),
 * read again every 30 s; money only with dashboard.revenue; queue rows open
 * their pages only for an admin who may; nothing else is requested.
 */

beforeEach(() => {
  resetPanel();
  signInAs(theOwner);
});

afterEach(() => {
  vi.useRealTimers();
});

const liveApi = (answer: () => unknown = () => live()) => fakeApi({ 'GET /v1/admin/stats/live': answer });

/** The figure of the tile named `label`. */
function tile(label: string): HTMLElement {
  return screen.getByText(label, { selector: 'div' }).parentElement!;
}

describe('the dashboard', () => {
  it('shows today’s figures in tiles, and nothing but the live read is requested', async () => {
    const api = liveApi();
    renderPanel('/', api);
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeTruthy();
    expect(await screen.findByText('1,384')).toBeTruthy();
    expect(within(tile('Online now')).getByText('1,384')).toBeTruthy();
    expect(within(tile('Active today')).getByText('2,954')).toBeTruthy();
    expect(within(tile('Sign-ups')).getByText('187')).toBeTruthy();
    expect(within(tile('Matches')).getByText('2,391')).toBeTruthy();
    expect(within(tile('Likes')).getByText('21,837')).toBeTruthy();
    expect(within(tile('Likes')).getByText('702 super likes · 33,015 passes')).toBeTruthy();
    expect(within(tile('Calls')).getByText('268 answered · 5 now')).toBeTruthy();
    expect(within(tile('Reports filed')).getByText('41')).toBeTruthy();
    expect(screen.getByText('Today (UTC)')).toBeTruthy();
    expect(new Set(api.calls.map((call) => call.path))).toEqual(new Set(['/v1/admin/stats/live']));
  });

  it('writes Persian digits in Persian', async () => {
    renderPanel('/', liveApi(), { locale: 'fa' });
    expect(await screen.findByRole('heading', { name: messages.fa['nav.dashboard'] })).toBeTruthy();
    expect(await screen.findByText('۱٬۳۸۴')).toBeTruthy();
    expect(screen.getByText('۲٬۹۵۴')).toBeTruthy();
    expect(screen.getByText('۷۰۲ سوپرلایک، ۳۳٬۰۱۵ رد')).toBeTruthy();
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('shows today’s revenue per currency, with the estimate marked, only with dashboard.revenue', async () => {
    renderPanel('/', liveApi());
    const card = (await screen.findByRole('heading', { name: 'Revenue today' })).closest('section')!;
    expect(within(card).getByText('$312.47')).toBeTruthy();
    expect(within(card).getByText(/41,720,000/)).toBeTruthy();
    expect(within(card).getAllByText('Estimate')).toHaveLength(1);
  });

  it('shows every currency of the day, none left out (amounts of different currencies are not compared)', async () => {
    const revenueToday = [
      { currency: 'INR', amountMicros: '84000000000', estimated: false },
      { currency: 'IRR', amountMicros: '41720000000000', estimated: true },
      { currency: 'TRY', amountMicros: '2900000000', estimated: false },
      { currency: 'USD', amountMicros: '312470000', estimated: false },
    ];
    renderPanel('/', liveApi(() => live({ revenueToday })));
    const card = (await screen.findByRole('heading', { name: 'Revenue today' })).closest('section')!;
    const lines = within(card).getAllByRole('listitem');
    expect(lines).toHaveLength(4);
    expect(within(card).getByText('$312.47')).toBeTruthy();
    expect(within(card).getByText(/84,000/)).toBeTruthy();
    expect(within(card).getByText(/2,900/)).toBeTruthy();
  });

  it('has no revenue card for a role without dashboard.revenue', async () => {
    signInAs(adminWith(expandGrants(['users.read', 'moderation.*', 'reports.*', 'appeals.*', 'dashboard.read']), ['moderator']));
    // The API leaves revenueToday out for such a role.
    const { revenueToday: _omitted, ...answer } = live();
    renderPanel('/', liveApi(() => answer));
    expect(await screen.findByText('1,384')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Revenue today' })).toBeNull();
    expect(screen.queryByText('$312.47')).toBeNull();
  });

  it('links each review queue to its page only for an admin who may open it, and support requests not before that page is built', async () => {
    signInAs(adminWith(['dashboard.read', 'moderation.read', 'support.read']));
    renderPanel('/', liveApi());
    const card = (await screen.findByRole('heading', { name: 'Waiting for review' })).closest('section')!;
    expect(within(card).getByRole('link', { name: /Photos/ }).getAttribute('href')).toBe('/moderation/photos');
    expect(within(card).getByRole('link', { name: /Texts/ }).getAttribute('href')).toBe('/moderation/texts');
    // No reports.read, no appeals.read: plain rows.
    expect(within(card).queryByRole('link', { name: /Open reports/ })).toBeNull();
    expect(within(card).queryByRole('link', { name: /Appeals/ })).toBeNull();
    expect(within(card).getByText('2 urgent')).toBeTruthy();
    // The support page is still a placeholder: no link, and a capped count reads "10,000+".
    expect(within(card).queryByRole('link', { name: /Support requests/ })).toBeNull();
    expect(within(card).getByText('10,000+')).toBeTruthy();
    // A row without a link keeps the chevron's place, so its count lines up with the linked rows'.
    const rows = within(card).getAllByRole('listitem');
    for (const row of rows) expect(row.querySelectorAll('svg[aria-hidden="true"], span[aria-hidden="true"].size-4')).toHaveLength(1);
  });

  it('shows the background service, the saving queues and the busy job queues, failures in red', async () => {
    renderPanel('/', liveApi());
    const card = (await screen.findByRole('heading', { name: 'System health' })).closest('section')!;
    expect(within(card).getByText('Running, seen ' + new Intl.DateTimeFormat('en', { timeStyle: 'short' }).format(new Date('2026-11-27T09:59:10.000Z')))).toBeTruthy();
    const streams = within(card).getByRole('table', { name: 'Saving queues' });
    const msg = within(streams).getByRole('row', { name: /Messages/ });
    expect(within(msg).getByText('1').className).toContain('text-destructive');
    expect(within(msg).getByText('2 min').className).toContain('text-destructive');
    const jobs = within(card).getByRole('table', { name: 'Jobs' });
    expect(within(jobs).getByText('photo')).toBeTruthy();
    expect(within(jobs).getByText('push')).toBeTruthy();
    // An idle queue is left out.
    expect(within(jobs).queryByText('maint')).toBeNull();
    // Jobs and health is not built yet: no link to it.
    expect(within(card).queryByRole('link')).toBeNull();
  });

  it('shows the providers’ calls today with their failure rate', async () => {
    renderPanel('/', liveApi());
    const card = (await screen.findByRole('heading', { name: 'Providers today' })).closest('section')!;
    const sms = within(card).getByRole('row', { name: /SMS codes/ });
    expect(within(sms).getByText('271')).toBeTruthy();
    expect(within(sms).getByText('2.2%')).toBeTruthy();
    const store = within(card).getByRole('row', { name: /Store checks/ });
    expect(within(store).getByText('—')).toBeTruthy();
  });

  it('says it waits for the background service when there is no snapshot, and that the service is not running', async () => {
    renderPanel('/', liveApi(() => liveWaiting()));
    expect(await screen.findByText('Not running')).toBeTruthy();
    expect(within(tile('Online now')).getByText('—')).toBeTruthy();
    expect(within(tile('Online now')).getByText('Waiting for the background service')).toBeTruthy();
    expect(within(tile('Sign-ups')).getByText('—')).toBeTruthy();
    expect(within(tile('Sign-ups')).getByText('Waiting for the background service')).toBeTruthy();
    // The counters of the API itself are still shown.
    expect(within(tile('Likes')).getByText('21,837')).toBeTruthy();
    const review = screen.getByRole('heading', { name: 'Waiting for review' }).closest('section')!;
    expect(within(review).getByText('Waiting for the background service')).toBeTruthy();
  });

  it('shows why the first read failed, with a retry', async () => {
    renderPanel('/', liveApi(() => problem(403, 'forbidden', { reason: 'role' })));
    expect(await screen.findByText('It could not be loaded')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('reads again every 30 s, and keeps the last figures with a note when a read fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let fail = false;
    const api = liveApi(() => (fail ? problem(503, 'service_unavailable') : live()));
    renderPanel('/', api);
    expect(await screen.findByText('1,384')).toBeTruthy();
    const reads = () => api.of('GET /v1/admin/stats/live').length;
    const first = reads();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
    });
    await waitFor(() => expect(reads()).toBeGreaterThan(first));
    fail = true;
    await act(async () => {
      // The failed read and its retries.
      await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 10_000);
    });
    expect(await screen.findByText('Not updated; trying again')).toBeTruthy();
    expect(screen.getByText('1,384')).toBeTruthy();
  });
});

describe('the panel’s home', () => {
  it('opens the first page the admin may open when the dashboard is not theirs', async () => {
    signInAs(adminWith(['users.read']));
    const { router } = renderPanel('/', fakeApi({ 'GET /v1/admin/users': () => ({ items: [], nextCursor: null }) }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/users'));
  });

  it('says there is no access when no page is theirs', async () => {
    signInAs(adminWith([]));
    renderPanel('/', fakeApi({}));
    expect(await screen.findByText('No access')).toBeTruthy();
  });
});
