import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeApi, owner, problem, renderPanel, resetPanel, signInAs, type Handler } from './panel';
import { financeAdmin, listItemOf, personRef, summaryOf } from './revenueFixtures';

/**
 * `/revenue/purchases`: a store's purchases (tabs and the state filter in
 * the address), the search whose text travels in a body only, the "not
 * connected" notice and the list's empty, error and phone states.
 */

beforeEach(() => {
  resetPanel();
  signInAs(financeAdmin);
});

const list = (items: ReturnType<typeof listItemOf>[], connected = true, nextCursor: string | null = null) => ({ items, nextCursor, connected });

function api(handlers: Record<string, Handler> = {}) {
  return fakeApi({
    'GET /v1/admin/purchases': () =>
      list([
        listItemOf('101'),
        listItemOf('100', { productId: 'cons.boost.5', basePlanId: null, kind: 'consumable', plan: null, item: 'boost', grantQuantity: 5, state: 'consumed', expiresAt: null, user: null }),
      ]),
    ...handlers,
  });
}

describe('the purchases list', () => {
  it('lists Google Play first, and keeps the store and the state in the address', async () => {
    const fake = api();
    const user = userEvent.setup();
    const { router } = renderPanel('/revenue/purchases', fake);
    expect(await screen.findByRole('heading', { name: 'Purchases', level: 1 })).toBeTruthy();
    expect(await screen.findByText('sub.premium')).toBeTruthy();
    expect(fake.of('GET /v1/admin/purchases')[0]!.query).toMatchObject({ store: 'play', limit: '25' });
    // An unclaimed purchase: its state says so, the person cell is a dash (never "No account" twice in a row).
    const unclaimed = screen.getByRole('link', { name: /cons\.boost\.5/ }).closest('tr')!;
    expect(within(unclaimed).getAllByRole('cell')[1]!.textContent).toBe('—');
    expect(screen.queryByText('No account')).toBeNull();

    await user.click(screen.getByRole('tab', { name: 'Cafe Bazaar' }));
    await waitFor(() => expect(router.state.location.search).toBe('?store=bazaar'));
    await waitFor(() => expect(fake.of('GET /v1/admin/purchases').at(-1)!.query['store']).toBe('bazaar'));

    await user.selectOptions(screen.getByRole('combobox', { name: 'State' }), 'expired');
    await waitFor(() => expect(router.state.location.search).toBe('?store=bazaar&state=expired'));
    await waitFor(() => expect(fake.of('GET /v1/admin/purchases').at(-1)!.query).toMatchObject({ store: 'bazaar', state: 'expired' }));
  });

  it('links each row to its purchase, keeping the list view for the way back', async () => {
    const fake = api({ 'GET /v1/admin/purchases/101': () => ({}) });
    const user = userEvent.setup();
    const { router } = renderPanel('/revenue/purchases?state=active', fake);
    const link = await screen.findByRole('link', { name: /sub\.premium/ });
    expect(link.getAttribute('href')).toBe('/revenue/purchases/101');
    await user.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe('/revenue/purchases/101'));
    expect(router.state.location.state).toEqual({ from: '?state=active' });
  });

  it('posts the search text in the body; the address and the requests’ query never hold it', async () => {
    const token = 'opaque-token.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const fake = api({ 'POST /v1/admin/purchases/search': () => ({ items: [summaryOf('77', { store: 'bazaar', productId: 'sub.plus.1m', basePlanId: null })], matchedBy: 'token' }) });
    const user = userEvent.setup();
    const { router } = renderPanel('/revenue/purchases', fake);
    await screen.findByText('sub.premium');
    await user.type(screen.getByRole('textbox', { name: 'Find a purchase' }), token);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Found by purchase token')).toBeTruthy();
    expect(screen.getByText('sub.plus.1m')).toBeTruthy();
    // A result from another store says which.
    expect(screen.getByText('Cafe Bazaar', { selector: '[data-slot="badge"]' })).toBeTruthy();
    expect(fake.of('POST /v1/admin/purchases/search')[0]!.body).toEqual({ q: token });
    expect(router.state.location.search).toBe('');
    expect(fake.calls.some((call) => JSON.stringify(call.query).includes('opaque-token'))).toBe(false);
    // The state filter waits while results show; clearing goes back to the list.
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'State' }).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Back to the list' }));
    expect(await screen.findByText('sub.premium')).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Find a purchase' }).value).toBe('');
  });

  it('reads Persian digits of an id typed on a Persian keyboard, and says when nothing matched', async () => {
    const fake = api({ 'POST /v1/admin/purchases/search': () => ({ items: [], matchedBy: null }) });
    const user = userEvent.setup();
    renderPanel('/revenue/purchases', fake);
    await screen.findByText('sub.premium');
    await user.type(screen.getByRole('textbox', { name: 'Find a purchase' }), '۱۲۳۴۵');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('No purchase found.')).toBeTruthy();
    expect(fake.of('POST /v1/admin/purchases/search')[0]!.body).toEqual({ q: '12345' });
  });

  it('words a refused search (its limit) without losing the list', async () => {
    const fake = api({ 'POST /v1/admin/purchases/search': () => problem(429, 'rate_limited') });
    const user = userEvent.setup();
    renderPanel('/revenue/purchases', fake);
    await screen.findByText('sub.premium');
    await user.type(screen.getByRole('textbox', { name: 'Find a purchase' }), 'GPA.1');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Too many requests. Wait a minute and try again.')).toBeTruthy();
    expect(screen.getByText('sub.premium')).toBeTruthy();
  });

  it('says when the store is not connected on the server', async () => {
    renderPanel('/revenue/purchases', api({ 'GET /v1/admin/purchases': () => list([listItemOf('1')], false) }));
    expect(await screen.findByText(/This store is not connected on the server/)).toBeTruthy();
  });

  it('says nothing of the connection when the store is connected', async () => {
    renderPanel('/revenue/purchases', api());
    await screen.findByText('sub.premium');
    expect(screen.queryByText(/not connected/)).toBeNull();
  });

  it('tells an empty store from an empty state filter', async () => {
    const empty = () => list([]);
    renderPanel('/revenue/purchases', api({ 'GET /v1/admin/purchases': empty }));
    expect(await screen.findByText('No purchases.')).toBeTruthy();
    resetPanel();
    signInAs(financeAdmin);
    renderPanel('/revenue/purchases?state=paused', api({ 'GET /v1/admin/purchases': empty }));
    expect(await screen.findByText('No purchase in this state.')).toBeTruthy();
  });

  it('shows a failed read with a retry', async () => {
    let fail = true;
    const fake = api({ 'GET /v1/admin/purchases': () => (fail ? problem(500, 'internal', { requestId: 'req-1' }) : list([listItemOf('1')])) });
    const user = userEvent.setup();
    renderPanel('/revenue/purchases', fake);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('It could not be loaded')).toBeTruthy();
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('sub.premium')).toBeTruthy();
  });

  it('pages on with the cursor', async () => {
    const fake = api({
      'GET /v1/admin/purchases': (call) => (call.query['cursor'] ? list([listItemOf('5', { productId: 'sub.plus' })]) : list([listItemOf('9')], true, 'abc')),
    });
    const user = userEvent.setup();
    renderPanel('/revenue/purchases', fake);
    await screen.findByText('sub.premium');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('sub.plus')).toBeTruthy();
    expect(fake.of('GET /v1/admin/purchases').at(-1)!.query['cursor']).toBe('abc');
  });

  it('shows a deleted account as such, without a link to a page', async () => {
    renderPanel('/revenue/purchases', api({ 'GET /v1/admin/purchases': () => list([listItemOf('3', { user: personRef('mhh7wucumebdc', { name: null, status: 'purged' }) })]) }));
    expect(await screen.findByText('Deleted account')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /mhh7wucumebdc/ })).toBeNull();
  });

  it('keeps the state and the date with the product on a phone (their columns hidden)', async () => {
    renderPanel('/revenue/purchases', api());
    const product = await screen.findByRole('link', { name: /sub\.premium/ });
    const cell = product.closest('td')!;
    expect(within(cell).getByText('Active').closest('.sm\\:hidden')).toBeTruthy();
  });

  it('pairs no order id with a person in the list; a search shows it, in the page’s direction with the id isolated', async () => {
    const fake = api({ 'POST /v1/admin/purchases/search': () => ({ items: [summaryOf('77')], matchedBy: 'order' }) });
    const user = userEvent.setup();
    renderPanel('/revenue/purchases', fake, { locale: 'fa' });
    await screen.findByText('sub.premium');
    expect(screen.getAllByRole('columnheader').some((h) => h.textContent === 'شماره‌ی سفارش')).toBe(false);
    expect(screen.queryByText('GPA.3392-1184-0921-55341')).toBeNull();
    await user.type(screen.getByRole('textbox', { name: 'پیدا کردن خرید' }), 'GPA.3392-1184-0921-55341');
    await user.click(screen.getByRole('button', { name: 'جست‌وجو' }));
    const header = (await screen.findAllByRole('columnheader')).find((h) => h.textContent === 'شماره‌ی سفارش')!;
    expect(header.className).toContain('hidden lg:table-cell');
    const id = screen.getByText('GPA.3392-1184-0921-55341');
    expect(id.tagName).toBe('BDI');
    expect(id.getAttribute('dir')).toBe('ltr');
    // The block around it keeps the page's direction, so it starts where its header does.
    expect(id.parentElement!.hasAttribute('dir')).toBe(false);
  });

  it('reads in Persian by default', async () => {
    resetPanel();
    signInAs(owner);
    renderPanel('/revenue/purchases', api(), { locale: 'fa' });
    expect(await screen.findByRole('heading', { name: 'خریدها', level: 1 })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'گوگل‌پلی' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'وضعیت' })).toBeTruthy();
  });
});
