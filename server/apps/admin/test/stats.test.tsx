import { expandGrants, providerHealthNames, signupStageKeys } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasMessage } from '../src/i18n/translate';
import { messages } from '../src/i18n/messages';
import { saveBlob } from '../src/lib/download';
import { adminWith, fakeApi, owner, problem, renderPanel, resetPanel, signInAs } from './panel';
import { LAST_DAY, NOW, revenue, statsHandlers } from './statsFixtures';

/**
 * `/stats`: closed UTC days to yesterday, the range in the address; every
 * card one read; money only with dashboard.revenue (its reads never sent
 * without it); each chart's figures as a table and a CSV.
 */

vi.mock('../src/lib/download', async (original) => ({ ...(await original<object>()), saveBlob: vi.fn() }));

const theOwner = { ...owner, permissions: expandGrants(['*']) };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(NOW) });
  resetPanel();
  signInAs(theOwner);
  vi.mocked(saveBlob).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

const statsApi = (extra: Record<string, (call: Parameters<(typeof statsHandlers)['GET /v1/admin/stats/funnel']>[0]) => unknown> = {}) =>
  fakeApi({ ...statsHandlers, ...extra });

/** A column of a chart, from its path (`M x,bottom V … Q x,top … H … Q x+w,top …`), and whether it is drawn lighter. */
function columnBox(path: Element) {
  const match = /^M([\d.]+),([\d.]+)V[\d.]+Q[\d.]+,([\d.]+) [\d.]+,[\d.]+H[\d.]+Q([\d.]+),/.exec(path.getAttribute('d') ?? '');
  if (!match) throw new Error(`not a column: ${path.getAttribute('d')}`);
  const [x0, bottom, top, x1] = match.slice(1).map(Number) as [number, number, number, number];
  return { x0, width: x1 - x0, height: bottom - top, opacity: path.getAttribute('fill-opacity') };
}

/** The card whose title is `title`, once its reads have answered. */
async function card(title: string): Promise<HTMLElement> {
  const section = (await screen.findByRole('heading', { name: title, level: 2 })).closest('section')!;
  await waitFor(() => expect(section.getAttribute('aria-busy')).toBe('false'));
  return section;
}

describe('the statistics page', () => {
  it('reads the last 30 closed days by default, every card once, money included for the owner', async () => {
    const api = statsApi();
    renderPanel('/stats', api);
    expect(await screen.findByRole('heading', { name: 'Statistics' })).toBeTruthy();
    await card('Moderators');
    await card('Revenue');
    for (const call of api.calls.filter((c) => c.path !== '/v1/admin/stats/places')) {
      expect(call.query, call.path).toMatchObject({ from: '2026-10-28', to: LAST_DAY });
    }
    expect(new Set(api.calls.map((c) => c.path))).toEqual(
      new Set(['daily', 'retention', 'funnel', 'places', 'revenue', 'conversion', 'moderation'].map((name) => `/v1/admin/stats/${name}`)),
    );
    // Active people, engagement, calls and providers: four daily reads of up to 8 metrics.
    const daily = api.of('GET /v1/admin/stats/daily').map((c) => c.query['metrics']!);
    expect(new Set(daily)).toEqual(
      new Set(['dau,wau,mau', 'likes,superlikes,passes,matches,conversations,replied,messages', 'calls,calls_answered,call_minutes', 'sms_ok,sms_fail,push_ok,push_fail,store_ok,store_err']),
    );
    expect(screen.getByText(`Days in UTC · last full day ${new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${LAST_DAY}T12:00:00Z`))}`)).toBeTruthy();
  });

  it('takes the range from the address, and puts a new one there', async () => {
    const api = statsApi();
    const { router } = renderPanel('/stats?days=90', api);
    await card('Active people');
    await waitFor(() => expect(api.of('GET /v1/admin/stats/funnel')[0]?.query).toMatchObject({ from: '2026-08-29', to: LAST_DAY }));
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: '7 days' }));
    await waitFor(() => expect(router.state.location.search).toBe('?days=7'));
    await waitFor(() => expect(api.of('GET /v1/admin/stats/funnel').at(-1)?.query).toMatchObject({ from: '2026-11-20', to: LAST_DAY }));
    await user.click(screen.getByRole('radio', { name: '30 days' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('reads 30 days for a range it does not offer', async () => {
    const api = statsApi();
    renderPanel('/stats?days=12', api);
    await card('Active people');
    await waitFor(() => expect(api.of('GET /v1/admin/stats/funnel')[0]?.query).toMatchObject({ from: '2026-10-28' }));
    expect(screen.getByRole('radio', { name: '30 days' }).getAttribute('aria-checked')).toBe('true');
  });

  it('shows the active people of the newest day, with their chart and its table', async () => {
    renderPanel('/stats?days=7', statsApi());
    const active = await card('Active people');
    // dau 100+i, wau 200+i, mau 300+i over 7 days: the newest are 106, 206, 306.
    expect(within(active).getByText('106')).toBeTruthy();
    expect(within(active).getByText('206')).toBeTruthy();
    expect(within(active).getByText('306')).toBeTruthy();
    expect(within(active).getByRole('img', { name: /^Active people, / })).toBeTruthy();
    const user = userEvent.setup();
    const show = within(active).getByRole('button', { name: 'Show table' });
    expect(show.getAttribute('aria-expanded')).toBe('false');
    await user.click(show);
    const table = within(active).getByRole('table', { name: 'Active people' });
    expect(within(table).getAllByRole('row')).toHaveLength(8);
    expect(within(table).getByRole('columnheader', { name: 'Monthly' })).toBeTruthy();
    await user.click(within(active).getByRole('button', { name: 'Hide table' }));
    expect(within(active).queryByRole('table')).toBeNull();
  });

  it('saves a card’s figures as a CSV with a byte order mark, CRLF lines and plain numbers', async () => {
    renderPanel('/stats?days=7', statsApi());
    const active = await card('Active people');
    await userEvent.setup().click(within(active).getByRole('button', { name: 'Download CSV' }));
    expect(saveBlob).toHaveBeenCalledTimes(1);
    const [blob, name] = vi.mocked(saveBlob).mock.calls[0]!;
    expect(name).toBe(`stats-active-2026-11-20-${LAST_DAY}.csv`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes.slice(3));
    expect(text.split('\r\n')[0]).toBe('Day,Daily,Weekly,Monthly');
    expect(text.split('\r\n')[1]).toBe('2026-11-20,100,200,300');
    expect(text.endsWith('\r\n')).toBe(true);
  });

  it('shows likes, matches, conversations and calls with their rates', async () => {
    renderPanel('/stats?days=7', statsApi());
    const engagement = await card('Likes, matches and conversations');
    // likes 100..106 = 721 (and calls, the first metric of the other read), superlikes 200..206 = 1421, matches 400..406 = 2821.
    expect(within(engagement).getAllByText('721')).toHaveLength(2);
    expect(within(engagement).getByText('2,821')).toBeTruthy();
    expect(within(engagement).getByText(`${new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 }).format(2821 / (721 + 1421))} of likes`)).toBeTruthy();
    expect(within(engagement).getByText('Call minutes')).toBeTruthy();
  });

  it('shows the sign-up steps in the app’s order with each one’s share', async () => {
    renderPanel('/stats', statsApi());
    const steps = await card('Sign-up steps');
    const labels = within(steps).getAllByRole('listitem').map((item) => item.querySelector('span')?.textContent);
    expect(labels).toEqual(signupStageKeys.map((stage) => messages.en[`stats.stage.${stage}`]));
    expect(within(steps).getAllByText('600 · 60%').length).toBeGreaterThan(0);
    expect(within(steps).getByText('14')).toBeTruthy();
  });

  it('shows retention as shares, a dash (spoken "Not yet") where the day has not come, and the average first with its base', async () => {
    renderPanel('/stats?days=7', statsApi());
    const retention = await card('Retention by sign-up day');
    const rows = within(retention).getAllByRole('row');
    // Header, average, 7 cohorts newest first.
    expect(rows).toHaveLength(9);
    expect(within(rows[1]!).getByText('Average')).toBeTruthy();
    // Day 1 of six measured cohorts: 80 of 200 each; the base is the six cohorts' sign-ups.
    expect(within(rows[1]!).getByText('40%')).toBeTruthy();
    expect(within(rows[1]!).getByTitle('of 1,200 sign-ups')).toBeTruthy();
    expect(within(rows[2]!).getAllByText('Not yet')).toHaveLength(1);
    expect(within(rows[2]!).getByText('Not yet').className).toContain('sr-only');
    expect(within(rows[2]!).getByText('—')).toBeTruthy();
    expect(within(rows[3]!).getByText('40%')).toBeTruthy();
    // No cohort of 7 days reaches day 7 or 30: those columns are left out (the CSV keeps them).
    expect(within(retention).getByRole('columnheader', { name: 'Day 1' })).toBeTruthy();
    expect(within(retention).queryByRole('columnheader', { name: 'Day 7' })).toBeNull();
    expect(within(retention).queryByRole('columnheader', { name: 'Day 30' })).toBeNull();
    // A short range names the day without its year.
    const newest = new Intl.DateTimeFormat('en', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(`${LAST_DAY}T12:00:00Z`));
    expect(within(rows[2]!).getByText(newest)).toBeTruthy();
    expect(within(retention).getByRole('button', { name: 'Download CSV' })).toBeTruthy();
    expect(within(retention).queryByRole('button', { name: 'Show table' })).toBeNull();
  });

  it('groups a long range’s cohorts by week', async () => {
    renderPanel('/stats?days=90', statsApi());
    const retention = await card('Retention by sign-up day');
    expect(within(retention).getByRole('columnheader', { name: 'Week from' })).toBeTruthy();
    // 90 days: 13 weeks back from the newest day (the oldest one 6 days), the average and the header.
    expect(within(retention).getAllByRole('row')).toHaveLength(15);
  });

  it('shows the places with small groups hidden, Other last, city names in the panel’s language', async () => {
    renderPanel('/stats', statsApi(), { locale: 'fa' });
    const placesCard = await card(messages.fa['stats.places.title']);
    const rows = within(placesCard).getAllByRole('row');
    expect(within(rows[1]!).getByText('تهران')).toBeTruthy();
    expect(within(rows[2]!).getByText('مشهد')).toBeTruthy();
    expect(within(rows[2]!).getAllByText(messages.fa['stats.places.small']).length).toBeGreaterThan(0);
    expect(within(rows.at(-1)!).getByText(messages.fa['stats.places.other'])).toBeTruthy();
    expect(within(rows.at(-1)!).getByText('۵۵۴')).toBeTruthy();
    // Other's withheld cell is withheld on screen too, never a number.
    expect(within(rows.at(-1)!).getAllByText(messages.fa['stats.places.small']).length).toBeGreaterThan(0);
    // Women to men from two published cells (812 / 1,043), a dash when one is withheld.
    expect(within(rows[1]!).getByText('۰٫۷۸')).toBeTruthy();
    expect(within(rows[2]!).getByText('۰٫۷۵')).toBeTruthy();
    expect(within(placesCard).getByRole('columnheader', { name: messages.fa['stats.places.ratio'] })).toBeTruthy();
    const user = userEvent.setup();
    await user.click(within(placesCard).getByRole('radio', { name: messages.fa['stats.places.countries'] }));
    expect(await within(placesCard).findByText('ایران')).toBeTruthy();
  });

  it('shows revenue in one currency, never converted, and reads another when picked', async () => {
    const api = statsApi();
    renderPanel('/stats?days=7', api);
    const revenue = await card('Revenue');
    expect(within(revenue).getByText('Includes estimates')).toBeTruthy();
    expect(within(revenue).getByText('Unknown product')).toBeTruthy();
    expect(within(revenue).getByText('Unknown')).toBeTruthy();
    // The plan key and its period are each isolated, so a Latin key never reorders Persian digits.
    const plan = within(revenue).getAllByRole('cell').find((cell) => cell.textContent === '\u2068plus\u2069, \u20681 month\u2069');
    expect(plan).toBeTruthy();
    // Renewals turned off over the range (2 a day) next to the churn.
    expect(within(revenue).getByText('Renewal turned off').nextElementSibling?.textContent).toBe('14');
    // At a narrow width the secondary columns leave the table for a line under the first cell.
    expect(within(revenue).getByRole('columnheader', { name: 'Plan and period' }).className).toContain('hidden sm:table-cell');
    for (const header of within(revenue).getAllByRole('columnheader', { name: 'Payments' })) expect(header.className).not.toContain('hidden');
    // Money figures are never cut.
    for (const value of within(revenue).getAllByRole('definition')) expect(value.className).not.toMatch(/truncate|whitespace-nowrap/);
    // The day table holds every series of the charts: MRR, subscriptions, ends and renewals turned off.
    await userEvent.setup().click(within(revenue).getByRole('button', { name: 'Show table' }));
    for (const name of ['Monthly recurring revenue', 'Active subscriptions', 'Renewing', 'Ended', 'Renewal turned off']) {
      expect(within(revenue).getAllByRole('columnheader', { name }).length, name).toBeGreaterThan(0);
    }
    await userEvent.setup().selectOptions(within(revenue).getByRole('combobox', { name: 'Currency' }), 'USD');
    await waitFor(() => expect(api.of('GET /v1/admin/stats/revenue').at(-1)?.query['currency']).toBe('USD'));
    await waitFor(() => expect(within(revenue).queryByText('Includes estimates')).toBeNull());
    // 7.99 × (10 + 11 + 12 + 10 + 11 + 12 + 10) payments.
    expect(within(revenue).getByText('$607.24')).toBeTruthy();
  });

  it('shows paying sign-ups with their store, measured only once their days have come', async () => {
    renderPanel('/stats?days=7', statsApi());
    const conversion = await card('Paying sign-ups');
    // d7 is measured for the oldest cohort only (5 of 100).
    expect(within(conversion).getAllByText('5%').length).toBeGreaterThan(0);
    // The rate's base (one cohort of 100), then each store, every fact kept whole.
    for (const fact of ['of 100 sign-ups', 'Google Play: 3', 'Cafe Bazaar: 2']) {
      const kept = within(conversion)
        .getAllByText(fact)
        .filter((element) => element.tagName === 'BDI' && element.closest('span.whitespace-nowrap'));
      expect(kept, fact).toHaveLength(1);
    }
  });

  it('shows each moderator’s decisions, wait and overturns, nothing about their accounts, and the decisions by day as a table', async () => {
    renderPanel('/stats', statsApi());
    const moderators = await card('Moderators');
    const mina = within(moderators).getByRole('row', { name: /Mina Karimi/ });
    expect(within(mina).getByText('1,013')).toBeTruthy();
    expect(within(mina).getByText('35 min')).toBeTruthy();
    const omid = within(moderators).getByRole('row', { name: /Omid Rahmani/ });
    expect(within(omid).queryByText('Disabled')).toBeNull();
    expect(within(omid).getByText('—')).toBeTruthy();
    // The chart's figures: a table of days and its own CSV.
    await userEvent.setup().click(within(moderators).getByRole('button', { name: 'Show table' }));
    const byDay = within(moderators).getAllByRole('table').at(-1)!;
    expect(within(byDay).getAllByRole('row')).toHaveLength(31);
    expect(within(moderators).getAllByRole('button', { name: 'Download CSV' })).toHaveLength(2);
    await userEvent.setup().click(within(moderators).getAllByRole('button', { name: 'Download CSV' }).at(-1)!);
    expect(vi.mocked(saveBlob).mock.calls.at(-1)?.[1]).toBe(`stats-moderators-days-2026-10-28-${LAST_DAY}.csv`);
  });

  it('labels its chart axes in the page’s direction and speaks the picked day', async () => {
    renderPanel('/stats', statsApi(), { locale: 'fa' });
    const active = await card(messages.fa['stats.active.title']);
    const texts = [...active.querySelectorAll('svg text')].map((text) => text.textContent ?? '');
    expect(texts.length).toBeGreaterThan(3);
    // Each label isolated right to left inside the left-to-right chart: «۶ آبان», never «آبان ۶».
    for (const text of texts) expect(text.startsWith('\u2067') && text.endsWith('\u2069'), text).toBe(true);
    const chart = within(active).getByRole('img');
    chart.focus();
    await userEvent.setup().keyboard('{End}');
    const spoken = active.parentElement!.querySelector('[aria-live="polite"]') ?? active.querySelector('[aria-live="polite"]');
    expect(spoken?.textContent).toContain(messages.fa['stats.metric.dau']);
  });

  it('sums a narrow chart’s days into whole weeks back from the last day: the newest column is never a stub', async () => {
    // The same amount every day, no refunds: every whole week's column has the same height.
    const even = (call: Parameters<typeof revenue>[0]) => {
      const answer = revenue(call);
      return { ...answer, days: answer.days.map((d) => ({ ...d, grossMicros: '10000000', refundMicros: '0', refunds: 0 })) };
    };
    renderPanel('/stats', statsApi({ 'GET /v1/admin/stats/revenue': even }));
    const revenueCard = await card('Revenue');
    const chart = within(revenueCard).getAllByRole('img')[0]!;
    // 30 days at the default width: 2 + 4 × 7 days, the short group the oldest.
    const columns = [...chart.querySelectorAll('svg path')].map(columnBox);
    expect(columns).toHaveLength(5);
    const week = columns.at(-1)!.height;
    for (const column of columns.slice(1)) expect(column.height).toBeCloseTo(week, 3);
    expect(columns[0]!.height).toBeCloseTo((week * 2) / 7, 1);
    // Only the short group is drawn lighter.
    expect(columns.map((column) => column.opacity)).toEqual(['0.4', null, null, null, null]);
    // The readout names each column's span, and the short one's days.
    const spoken = () => (chart.nextElementSibling?.textContent ?? '').replace(/\s/g, ' ');
    chart.focus();
    const user = userEvent.setup();
    await user.keyboard('{End}');
    expect(spoken()).toMatch(/^Nov 20 – 26, 2026, Payments /);
    await user.keyboard('{Home}');
    expect(spoken()).toMatch(/^Oct 28 – 29, 2026 \(2 days\), Payments /);
  });

  it('groups a year’s columns into whole weeks so none is a hairline, even on a phone', async () => {
    renderPanel('/stats?days=365', statsApi());
    const revenueCard = await card('Revenue');
    const chart = within(revenueCard).getAllByRole('img')[0]!;
    const columns = [...chart.querySelectorAll('svg path')].map(columnBox);
    // At the default width a week's pair would be under 4 px: three weeks a column (17 × 21 + 8 days),
    // 18 of payments and the one refund's.
    expect(columns).toHaveLength(19);
    for (const column of columns) expect(column.width).toBeGreaterThanOrEqual(4);
    chart.focus();
    const user = userEvent.setup();
    await user.keyboard('{End}');
    expect((chart.nextElementSibling?.textContent ?? '').replace(/\s/g, ' ')).toMatch(/^Nov 6 – 26, 2026, /);
    await user.keyboard('{Home}');
    expect((chart.nextElementSibling?.textContent ?? '').replace(/\s/g, ' ')).toMatch(/^Nov 27 – Dec 4, 2025 \(8 days\), /);
  });

  it('shows one notice with one retry when every read fails, not one per card', async () => {
    let down = true;
    const fail = (ok: (call: Parameters<(typeof statsHandlers)['GET /v1/admin/stats/funnel']>[0]) => unknown) => (call: Parameters<(typeof statsHandlers)['GET /v1/admin/stats/funnel']>[0]) =>
      down ? problem(503, 'service_unavailable') : ok(call);
    const api = statsApi(Object.fromEntries(Object.entries(statsHandlers).map(([route, handler]) => [route, fail(handler as never)])));
    renderPanel('/stats', api);
    const alerts = await screen.findAllByText('It could not be loaded');
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Try again' }).filter((b) => b.closest('.hidden') === null)).toHaveLength(1));
    expect(screen.getAllByText('It could not be loaded').filter((a) => a.closest('.hidden') === null)).toHaveLength(1);
    expect(alerts.length).toBeGreaterThan(0);
    down = false;
    await userEvent.setup().click(screen.getAllByRole('button', { name: 'Try again' }).find((b) => b.closest('.hidden') === null)!);
    await card('Moderators');
    await waitFor(() => expect(screen.queryAllByText('It could not be loaded')).toHaveLength(0));
  });

  it('shows the providers’ failure rates', async () => {
    renderPanel('/stats?days=7', statsApi());
    const providers = await card('Providers');
    // sms_fail 200..206 of sms_ok 100..106 + sms_fail.
    expect(within(providers).getAllByText('SMS codes')).toHaveLength(2);
    expect(within(providers).getByText('1,421 failed of 2,142')).toBeTruthy();
  });

  it('says there are no figures yet before the first night', async () => {
    const empty = (call: { query: Record<string, string> }) => ({ from: call.query['from'], to: call.query['to'], lastDay: null, series: [] });
    renderPanel('/stats', statsApi({ 'GET /v1/admin/stats/daily': empty }));
    const active = await card('Active people');
    expect(await within(active).findByText('No figures yet')).toBeTruthy();
    expect(screen.getByText('Days in UTC')).toBeTruthy();
  });

  it('never shows or reads money without dashboard.revenue', async () => {
    signInAs(adminWith(expandGrants(['users.read', 'moderation.*', 'reports.*', 'appeals.*', 'dashboard.read']), ['moderator']));
    const api = statsApi();
    renderPanel('/stats', api);
    await card('Moderators');
    await card('Providers');
    expect(screen.queryByRole('heading', { name: 'Revenue' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Paying sign-ups' })).toBeNull();
    expect(api.calls.filter((c) => c.path === '/v1/admin/stats/revenue' || c.path === '/v1/admin/stats/conversion')).toHaveLength(0);
  });

  it('is for dashboard.read: without it, no request and no access', async () => {
    signInAs(adminWith(['users.read']));
    const api = statsApi();
    renderPanel('/stats', api);
    expect(await screen.findByText('No access')).toBeTruthy();
    expect(api.calls.filter((c) => c.path.startsWith('/v1/admin/stats'))).toHaveLength(0);
  });

  it('has words for every sign-up step, provider and saving queue in every language', () => {
    const keys = [
      ...signupStageKeys.map((stage) => `stats.stage.${stage}`),
      ...providerHealthNames.map((name) => `stats.provider.${name}`),
      ...['like', 'match', 'msg'].map((name) => `dashboard.stream.${name}`),
    ];
    for (const key of keys) {
      expect(hasMessage(key), key).toBe(true);
      for (const locale of ['en', 'fa', 'tr'] as const) expect((messages[locale] as Record<string, string>)[key], `${locale}:${key}`).toBeTruthy();
    }
  });
});
