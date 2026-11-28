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
    expect(within(jobs).getByRole('rowheader', { name: 'Photos' })).toBeTruthy();
    expect(within(jobs).getByRole('rowheader', { name: 'Push notifications' })).toBeTruthy();
    // An idle queue is left out.
    expect(within(jobs).queryByRole('rowheader', { name: 'Maintenance' })).toBeNull();
    // The owner reads the jobs page: the card links to it.
    expect(within(card).getByRole('link', { name: 'Jobs and health' }).getAttribute('href')).toBe('/system/jobs');
  });

  it('counts under Waiting what waits to be saved, delivered or not, as the jobs page counts In queue', async () => {
    renderPanel(
      '/',
      liveApi(() =>
        live({
          streams: [
            // The writer stopped reading: nothing being saved, five not delivered yet.
            { name: 'like', length: 5, waiting: 5, pending: 0, dead: 0, lagMs: 4_000 },
            { name: 'match', length: 10, waiting: 0, pending: 0, dead: 0, lagMs: 0 },
            // Unknown: no reader group, or a snapshot written before the count was recorded.
            { name: 'msg', length: 3, waiting: null, pending: 1, dead: 0, lagMs: null },
          ],
        }),
      ),
    );
    const card = (await screen.findByRole('heading', { name: 'System health' })).closest('section')!;
    const streams = within(card).getByRole('table', { name: 'Saving queues' });
    const waiting = (name: RegExp) => within(within(streams).getByRole('row', { name })).getAllByRole('cell')[0]!.textContent;
    expect(waiting(/Likes/)).toBe('5');
    expect(waiting(/Matches/)).toBe('0');
    expect(waiting(/Messages/)).toBe('—');
  });

  it('links the health card to the jobs page only for an admin who may read it', async () => {
    signInAs(adminWith(['dashboard.read']));
    renderPanel('/', liveApi());
    const card = (await screen.findByRole('heading', { name: 'System health' })).closest('section')!;
    expect(within(card).queryByRole('link')).toBeNull();
  });

  it('names each job queue in the panel’s language, and one this build has no words for by its code', async () => {
    const queues = ['system', 'account', 'safety', 'chat', 'maint', 'iap', 'stats', 'reels'];
    const answer = () => live({ jobs: queues.map((queue) => ({ queue, waiting: 1, active: 0, delayed: 0, failed: 0 })) });
    const expected = {
      en: ['System', 'Accounts', 'Safety', 'Chats', 'Maintenance', 'Store purchases', 'Statistics'],
      fa: ['سیستم', 'حساب‌ها', 'ایمنی', 'گفتگوها', 'نگه‌داشت', 'خریدها', 'آمار'],
      tr: ['Sistem', 'Hesaplar', 'Güvenlik', 'Sohbetler', 'Bakım', 'Mağaza satın almaları', 'İstatistikler'],
    } as const;
    for (const locale of ['en', 'fa', 'tr'] as const) {
      const view = renderPanel('/', liveApi(answer), { locale });
      const card = (await screen.findByRole('heading', { name: messages[locale]['dashboard.health.title'] })).closest('section')!;
      const jobs = within(card).getByRole('table', { name: messages[locale]['dashboard.health.jobs'] });
      const names = within(jobs).getAllByRole('rowheader');
      expect(names.map((name) => name.textContent)).toEqual([...expected[locale], 'reels']);
      // Words read as words; only the unknown code keeps the code's type.
      expect(names.slice(0, -1).every((name) => !name.className.includes('font-mono'))).toBe(true);
      expect(names.at(-1)!.className).toContain('font-mono');
      // On a phone the names give way (a long word may break), never the figures: the table stays inside the card.
      for (const name of names) expect(name.className.split(' ')).toEqual(expect.arrayContaining(['wrap-anywhere', 'hyphens-auto']));
      const figures = [...within(jobs).getAllByRole('columnheader'), ...within(jobs).getAllByRole('cell')].filter((cell) => cell.textContent !== '');
      for (const figure of figures) expect(figure.className.split(' ')).toEqual(expect.arrayContaining(['ps-2', 'sm:ps-3', 'whitespace-nowrap']));
      view.unmount();
      resetPanel();
      signInAs(theOwner);
    }
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
