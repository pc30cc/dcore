import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetToastsForTests } from '../src/lib/toast';
import { fakeApi, plan, planList, problem, renderPanel, resetPanel, signInAs, type Handler } from './panel';
import { adminRole, financeAdmin, purchaseOf } from './revenueFixtures';

/**
 * `/revenue/purchases/:id`: every stored field, the store's events (older
 * ones on demand), the admins' history, the actions `available` offers
 * and their dialogs (a note, the state seen, the refund's mode), and the
 * answers in the panel's words.
 */

const ID = '105424043695398946';
const PATH = `/v1/admin/purchases/${ID}`;

beforeEach(() => {
  resetPanel();
  resetToastsForTests();
  signInAs(financeAdmin);
});

function api(detail: () => unknown = () => purchaseOf(ID), handlers: Record<string, Handler> = {}) {
  return fakeApi({
    [`GET ${PATH}`]: detail,
    'GET /v1/admin/plans': () => planList([plan('premium', { names: { en: 'Premium', fa: 'پریمیوم' } })]),
    ...handlers,
  });
}

describe('a purchase', () => {
  it('shows its fields, its plan by name and the store events, never asking for a token', async () => {
    renderPanel(`/revenue/purchases/${ID}`, api());
    expect(await screen.findByRole('heading', { level: 1, name: 'sub.premium' })).toBeTruthy();
    const summary = screen.getByRole('heading', { name: 'Summary' }).closest('section')!;
    expect(await within(summary).findByText('Premium')).toBeTruthy();
    expect(within(summary).getByText('1 month')).toBeTruthy();
    expect(within(summary).getByText('Source of the current plan').nextElementSibling?.textContent).toBe('Yes');
    expect(within(summary).getByText('Germany')).toBeTruthy();
    expect(within(summary).getByRole('button', { name: `Copy ID ${ID}` })).toBeTruthy();
    const events = screen.getByRole('heading', { name: 'Store events' }).closest('section')!;
    expect(within(events).getByText('Renewed')).toBeTruthy();
    expect(within(events).getByText('Google notification')).toBeTruthy();
    expect(within(events).getAllByText('€9.99')).toHaveLength(2);
    expect(screen.getByText('No admin actions.')).toBeTruthy();
  });

  it('marks an estimated amount, and reads older events on demand with the cursor', async () => {
    const detail = purchaseOf(ID, {
      store: 'bazaar',
      events: {
        items: [
          {
            id: '9',
            at: '2026-11-20T10:00:00.000Z',
            event: 'verified',
            source: 'app',
            stateFrom: null,
            stateTo: 'active',
            expiresAt: null,
            amount: { micros: '2990000000000', currency: 'IRR', estimated: true },
            orderId: null,
          },
        ],
        nextCursor: 'c1',
      },
    });
    const fake = api(() => detail, {
      [`GET ${PATH}/events`]: () => ({
        items: [{ id: '3', at: '2026-10-20T10:00:00.000Z', event: 'expired', source: 'bazaar', stateFrom: 'active', stateTo: 'expired', expiresAt: null, amount: null, orderId: null }],
        nextCursor: null,
      }),
    });
    const user = userEvent.setup();
    renderPanel(`/revenue/purchases/${ID}`, fake);
    expect(await screen.findByTitle('Estimated from the list price')).toBeTruthy();
    expect(fake.of(`GET ${PATH}/events`)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Load older' }));
    expect(await screen.findByText('Cafe Bazaar check')).toBeTruthy();
    expect(fake.of(`GET ${PATH}/events`)[0]!.query['cursor']).toBe('c1');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load older' })).toBeNull());
  });

  it('shows the admins’ history with notes and the store’s refusal', async () => {
    const detail = purchaseOf(ID, {
      state: 'revoked',
      history: [
        { id: '2', at: '2026-11-25T10:00:00.000Z', action: 'purchase.refund', admin: { id: '1', displayName: 'Leila Moradi' }, note: 'Charged twice.', error: null, failed: null },
        { id: '1', at: '2026-11-25T09:59:00.000Z', action: 'purchase.action_failed', admin: { id: '1', displayName: 'Leila Moradi' }, note: null, error: 'refused', failed: 'refund_prorated' },
      ],
    });
    renderPanel(
      `/revenue/purchases/${ID}`,
      api(() => detail),
    );
    const history = (await screen.findByRole('heading', { name: 'Admin actions' })).closest('section')!;
    expect(within(history).getByText('Purchase refunded')).toBeTruthy();
    expect(within(history).getByText('Charged twice.')).toBeTruthy();
    const chip = within(history).getByText('Store refused');
    expect(chip.textContent).toContain('Refund');
  });

  it('shows a consumable’s credits and what was used before the refund', async () => {
    const detail = purchaseOf(ID, {
      kind: 'consumable',
      productId: 'cons.superlike.5',
      basePlanId: null,
      plan: null,
      item: 'superlike',
      grantQuantity: 5,
      state: 'revoked',
      period: null,
      wallet: { credited: 5, takenBack: 3 },
    });
    renderPanel(
      `/revenue/purchases/${ID}`,
      api(() => detail),
    );
    const wallet = (await screen.findByRole('heading', { name: 'Wallet' })).closest('section')!;
    expect(within(wallet).getByText('Already used').nextElementSibling?.textContent).toBe('2');
    expect(within(wallet).getByText('Taken back').nextElementSibling?.textContent).toBe('3');
  });

  it('offers exactly what `available` lists; without a connected store only "Mark refunded" and the notice', async () => {
    renderPanel(
      `/revenue/purchases/${ID}`,
      api(() => purchaseOf(ID, { connected: false, available: ['revoke'] })),
    );
    expect(await screen.findByRole('button', { name: 'Mark refunded' })).toBeTruthy();
    expect(screen.getByText(/This store is not connected on the server/)).toBeTruthy();
    for (const name of ['Re-check with store', 'Stop renewal', 'Refund']) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('shows no action to a role the purchase offers none (the admin role)', async () => {
    signInAs(adminRole);
    renderPanel(
      `/revenue/purchases/${ID}`,
      api(() => purchaseOf(ID, { available: [] })),
    );
    await screen.findByRole('heading', { level: 1, name: 'sub.premium' });
    expect(screen.queryByRole('button', { name: 'Mark refunded' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refund' })).toBeNull();
  });

  it('refunds for the unused time: a note is required, and the body carries the state seen', async () => {
    const fake = api(undefined, {
      [`POST ${PATH}/refund`]: () => ({ purchase: purchaseOf(ID, { state: 'revoked', available: [] }), outcome: 'done', sideEffects: 'done' }),
    });
    const user = userEvent.setup();
    renderPanel(`/revenue/purchases/${ID}`, fake);
    await user.click(await screen.findByRole('button', { name: 'Refund' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('The buyer gets the money back and access ends now.')).toBeTruthy();
    await user.click(within(dialog).getByRole('radio', { name: 'For the unused time' }));
    await user.click(within(dialog).getByRole('button', { name: 'Refund' }));
    expect(await within(dialog).findByText('Required.')).toBeTruthy();
    expect(fake.of(`POST ${PATH}/refund`)).toHaveLength(0);
    await user.type(within(dialog).getByRole('textbox'), '  Charged twice  ');
    await user.click(within(dialog).getByRole('button', { name: 'Refund' }));
    expect(await screen.findByText('Done.')).toBeTruthy();
    expect(fake.of(`POST ${PATH}/refund`)[0]!.body).toEqual({ from: 'active', prorated: true, note: 'Charged twice' });
    // The page shows the answer's purchase.
    await waitFor(() => expect(screen.getAllByText('Refunded').length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: 'Refund' })).toBeNull();
  });

  it('offers no refund mode where the store has only the full one', async () => {
    const user = userEvent.setup();
    renderPanel(
      `/revenue/purchases/${ID}`,
      api(() => purchaseOf(ID, { kind: 'consumable', period: null, available: ['refund', 'revoke'] })),
    );
    await user.click(await screen.findByRole('button', { name: 'Refund' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('radiogroup')).toBeNull();
  });

  it('stops the renewal with the date access ends, and says when the store had done it', async () => {
    const fake = api(undefined, { [`POST ${PATH}/cancel`]: () => ({ purchase: purchaseOf(ID, { state: 'canceled' }), outcome: 'already', sideEffects: 'done' }) });
    const user = userEvent.setup();
    renderPanel(`/revenue/purchases/${ID}`, fake);
    await user.click(await screen.findByRole('button', { name: 'Stop renewal' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Renewal stops; access stays until Dec 17, 2026 and no money goes back\./)).toBeTruthy();
    await user.type(within(dialog).getByRole('textbox'), 'Asked by the buyer');
    await user.click(within(dialog).getByRole('button', { name: 'Stop renewal' }));
    expect(await screen.findByText('The store had already done this.')).toBeTruthy();
    expect(fake.of(`POST ${PATH}/cancel`)[0]!.body).toEqual({ from: 'active', note: 'Asked by the buyer' });
  });

  it('re-checks without a note (an empty body), and words a pending outcome', async () => {
    const fake = api(undefined, { [`POST ${PATH}/recheck`]: () => ({ purchase: purchaseOf(ID), outcome: 'pending', sideEffects: 'done' }) });
    const user = userEvent.setup();
    renderPanel(`/revenue/purchases/${ID}`, fake);
    await user.click(await screen.findByRole('button', { name: 'Re-check with store' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('optional')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Re-check with store' }));
    expect(await screen.findByText('The store did it; this page updates shortly.')).toBeTruthy();
    expect(fake.of(`POST ${PATH}/recheck`)[0]!.body).toEqual({});
  });

  it('reads the purchase again when it changed meanwhile, and says so', async () => {
    const fake = api(undefined, { [`POST ${PATH}/revoke`]: () => problem(409, 'conflict', { reason: 'purchase_changed' }) });
    const user = userEvent.setup();
    renderPanel(`/revenue/purchases/${ID}`, fake);
    await user.click(await screen.findByRole('button', { name: 'Mark refunded' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'Refunded in the console');
    await user.click(within(dialog).getByRole('button', { name: 'Mark refunded' }));
    expect(await screen.findByText('This purchase changed meanwhile. Look again.')).toBeTruthy();
    await waitFor(() => expect(fake.of(`GET ${PATH}`).length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('words a store that refuses or cannot be reached, and keeps the dialog for another try', async () => {
    let answer: [number, unknown] = problem(409, 'conflict', { reason: 'store_refused' });
    const fake = api(undefined, { [`POST ${PATH}/refund`]: () => answer });
    const user = userEvent.setup();
    renderPanel(`/revenue/purchases/${ID}`, fake);
    await user.click(await screen.findByRole('button', { name: 'Refund' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'Duplicate');
    await user.click(within(dialog).getByRole('button', { name: 'Refund' }));
    expect(await screen.findByText('The store refused this action.')).toBeTruthy();
    answer = problem(503, 'store_unavailable');
    await user.click(within(dialog).getByRole('button', { name: 'Refund' }));
    expect(await screen.findByText('The store cannot be reached. Try again later.')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('says when a purchase does not exist in its header alone (no full stop, no second card), the way back above it', async () => {
    renderPanel(
      `/revenue/purchases/${ID}`,
      api(() => problem(404, 'not_found')),
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'No such purchase' })).toBeTruthy();
    expect(screen.getAllByText('No such purchase')).toHaveLength(1);
    const back = within(screen.getByRole('main')).getByRole('link', { name: 'Purchases' });
    expect(back.getAttribute('href')).toBe('/revenue/purchases');
  });

  it('shows a placeholder title while it loads, never the list’s', async () => {
    renderPanel(
      `/revenue/purchases/${ID}`,
      api(() => new Promise(() => undefined)),
    );
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('');
  });

  const pack = () =>
    purchaseOf(ID, { kind: 'consumable', productId: 'cons.boost.5', basePlanId: null, plan: null, item: 'boost', grantQuantity: 5, state: 'consumed', period: null, available: ['refund', 'revoke'], wallet: { credited: 5, takenBack: 0 } });

  it('confirms a pack’s mark refunded with what it takes back, never "access ends"', async () => {
    const user = userEvent.setup();
    renderPanel(`/revenue/purchases/${ID}`, api(pack));
    await user.click(await screen.findByRole('button', { name: 'Mark refunded' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('For a refund made elsewhere: nothing is sent to the store and what this pack added to the wallet is taken back, as far as it is unused.')).toBeTruthy();
    expect(within(dialog).queryByText(/access ends/)).toBeNull();
  });

  it('confirms a pack’s refund with what it takes back', async () => {
    const user = userEvent.setup();
    renderPanel(`/revenue/purchases/${ID}`, api(pack));
    await user.click(await screen.findByRole('button', { name: 'Refund' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('The buyer gets the money back and what this pack added to the wallet is taken back, as far as it is unused.')).toBeTruthy();
    expect(within(dialog).queryByText(/access ends/)).toBeNull();
  });

  it('keeps "access ends now" in a subscription’s mark refunded', async () => {
    const user = userEvent.setup();
    renderPanel(`/revenue/purchases/${ID}`, api(() => purchaseOf(ID, { available: ['revoke'] })));
    await user.click(await screen.findByRole('button', { name: 'Mark refunded' }));
    expect(within(await screen.findByRole('dialog')).getByText('For a refund made elsewhere: nothing is sent to the store and access ends now.')).toBeTruthy();
  });

  it('says a subscription the store had ended was not refunded now (the store would not refund it)', async () => {
    const fake = api(undefined, { [`POST ${PATH}/refund`]: () => ({ purchase: purchaseOf(ID, { state: 'expired', available: ['recheck'] }), outcome: 'already', sideEffects: 'done' }) });
    const user = userEvent.setup();
    renderPanel(`/revenue/purchases/${ID}`, fake);
    await user.click(await screen.findByRole('button', { name: 'Refund' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'Asked for a refund');
    await user.click(within(dialog).getByRole('button', { name: 'Refund' }));
    expect(await screen.findByText('The store shows this subscription ended already; nothing was refunded now.')).toBeTruthy();
    expect(screen.queryByText('The store had already done this.')).toBeNull();
  });

  it('words a re-check that found a store account not ours, and reads the purchase again', async () => {
    const fake = api(undefined, { [`POST ${PATH}/recheck`]: () => problem(409, 'conflict', { reason: 'foreign_account' }) });
    const user = userEvent.setup();
    renderPanel(`/revenue/purchases/${ID}`, fake);
    await user.click(await screen.findByRole('button', { name: 'Re-check with store' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Re-check with store' }));
    expect(await screen.findByText('The store names an account that is not ours: the purchase is refunded and revoked at the store.')).toBeTruthy();
    await waitFor(() => expect(fake.of(`GET ${PATH}`).length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('names a refused action in the history as an action, not a command (Turkish)', async () => {
    const detail = purchaseOf(ID, {
      history: [{ id: '1', at: '2026-11-25T09:59:00.000Z', action: 'purchase.action_failed', admin: { id: '1', displayName: 'Leila Moradi' }, note: null, error: 'unavailable', failed: 'refund' }],
    });
    renderPanel(
      `/revenue/purchases/${ID}`,
      api(() => detail),
      { locale: 'tr' },
    );
    const chip = await screen.findByText('Mağazaya ulaşılamadı');
    expect(chip.textContent).toContain('İade');
    expect(chip.textContent).not.toContain('İade et');
  });

  it('writes a rial amount before its unit in Persian; a symbol keeps its place', async () => {
    const { formatMoney } = await import('../src/lib/stats');
    expect(formatMoney('1990000000000', 'IRR', 'fa')).toBe('\u2066۱٬۹۹۰٬۰۰۰\u2069 ریال');
    expect(formatMoney('-12000000', 'IRR', 'fa')).toMatch(/^\u2066.*۱۲\u2069 ریال$/);
    expect(formatMoney('9990000', 'EUR', 'fa')).toContain('€');
    expect(formatMoney('9990000', 'EUR', 'fa').startsWith('\u2066')).toBe(false);
    expect(formatMoney('1990000000000', 'IRR', 'en')).toContain('1,990,000');
  });

  it('goes back to the purchase’s own store when opened directly', async () => {
    renderPanel(
      `/revenue/purchases/${ID}`,
      api(() => purchaseOf(ID, { store: 'bazaar', productId: 'sub.plus.1m', basePlanId: null })),
    );
    await screen.findByRole('heading', { level: 1, name: 'sub.plus.1m' });
    const back = within(screen.getByRole('main')).getByRole('link', { name: 'Purchases' });
    expect(back.getAttribute('href')).toBe('/revenue/purchases?store=bazaar');
  });

  it('reads in Persian, with its dates and amounts in Persian digits', async () => {
    renderPanel(`/revenue/purchases/${ID}`, api(), { locale: 'fa' });
    expect(await screen.findByRole('heading', { name: 'رویدادهای فروشگاه' })).toBeTruthy();
    expect(screen.getByText('تمدید شد')).toBeTruthy();
    expect(screen.getAllByText(/€\s*۹٫۹۹|۹٫۹۹\s*€/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'بازگشت وجه' })).toBeTruthy();
  });
});
