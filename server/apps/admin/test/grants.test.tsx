import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { grantShownEnd } from '../src/lib/grants';
import { resetToastsForTests } from '../src/lib/toast';
import { adminWith, fakeApi, plan, planList, problem, renderPanel, resetPanel, signInAs, type Handler } from './panel';
import { adjustmentOf, adminRole, financeAdmin, grantOf, OTHER, pageOf, PERSON, personRef } from './revenueFixtures';
import { detail } from './userFixtures';

/**
 * `/revenue/grants`: plan days given (all, or the active and upcoming
 * ones), ending one early, the wallet's admin gifts and corrections, and
 * the two dialogs that make them: a person by public id, a `requestId`
 * made once per dialog, the refusals at their fields.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const plans = () =>
  planList([
    plan('free', { rank: 0 }),
    plan('plus', { rank: 1, names: { en: 'Plus', fa: 'پلاس' } }),
    plan('premium', { rank: 2, names: { en: 'Premium', fa: 'پریمیوم' } }),
    plan('gold', { rank: 3, archivedAt: '2026-10-01T10:00:00.000Z', active: false }),
  ]);

beforeEach(() => {
  resetPanel();
  resetToastsForTests();
  signInAs(financeAdmin);
});

function api(handlers: Record<string, Handler> = {}) {
  return fakeApi({
    'GET /v1/admin/grants': () =>
      pageOf([
        grantOf('3', { state: 'scheduled', plan: 'premium', user: personRef(OTHER, { name: 'Kaan Demir' }) }),
        grantOf('2'),
        grantOf('1', { state: 'revoked', revokedAt: '2026-11-24T10:00:00.000Z', revokedBy: { id: '5', displayName: 'Reza Tavakoli' }, revokeReason: 'Wrong account' }),
      ]),
    'GET /v1/admin/wallet-adjustments': () => pageOf([adjustmentOf('8'), adjustmentOf('7', { delta: -2, balanceAfter: 1, reason: 'correction', store: 'play', note: 'Double credit' })]),
    'GET /v1/admin/plans': plans,
    [`GET /v1/admin/users/${PERSON}`]: () => detail({ id: PERSON, name: 'Daniel Weber' }),
    [`GET /v1/admin/users/${PERSON}/purchases`]: () => ({ subscriptions: [], items: [] }),
    [`GET /v1/admin/users/${PERSON}/wallet`]: () => ({
      balances: [
        { item: 'superlike', store: null, balance: 4 },
        { item: 'boost', store: 'play', balance: 2 },
      ],
      ledger: { items: [], nextCursor: null },
    }),
    ...handlers,
  });
}

describe('plan days given', () => {
  it('lists every grant with its plan, period, state and giver; "End now" only on running and coming ones', async () => {
    renderPanel('/revenue/grants', api());
    expect(await screen.findByRole('heading', { level: 1, name: 'Gifts and corrections' })).toBeTruthy();
    expect((await screen.findAllByText('Upcoming')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Ended early').length).toBeGreaterThan(0);
    // Who ended it early, and why, in plain sight (a tooltip reaches no finger and no keyboard).
    expect(screen.getAllByText('Reza Tavakoli').every((el) => !el.hasAttribute('title'))).toBe(true);
    expect(screen.getAllByText('Wrong account').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'End now' })).toHaveLength(2);
    expect(screen.getByText('Kaan Demir')).toBeTruthy();
  });

  it('shows a grant ended before it began with its planned period, and one ended early with its real end', async () => {
    const before = grantOf('5', { state: 'revoked', startsAt: '2026-11-29T10:00:00.000Z', endsAt: '2026-12-29T10:00:00.000Z', revokedAt: '2026-11-28T10:00:00.000Z' });
    const during = grantOf('6', { state: 'revoked', startsAt: '2026-11-20T10:00:00.000Z', endsAt: '2026-12-20T10:00:00.000Z', revokedAt: '2026-11-25T10:00:00.000Z' });
    expect(grantShownEnd(before)).toBe(before.endsAt);
    expect(grantShownEnd(during)).toBe(during.revokedAt);
    expect(grantShownEnd(grantOf('7'))).toBe(grantOf('7').endsAt);
    renderPanel('/revenue/grants', api({ 'GET /v1/admin/grants': () => pageOf([before, during]) }));
    expect((await screen.findAllByText('Nov 29, 2026 – Dec 29, 2026')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Nov 20, 2026 – Nov 25, 2026').length).toBeGreaterThan(0);
    expect(screen.queryByText('Nov 29, 2026 – Nov 28, 2026')).toBeNull();
  });

  it('keeps the filter’s words on one line: the segments grow with them from sm', async () => {
    renderPanel('/revenue/grants', api());
    const filter = await screen.findByRole('radiogroup', { name: 'Show' });
    expect(filter.className).toContain('sm:w-auto');
    expect(filter.className).not.toContain('sm:w-72 ');
  });

  it('keeps the filter and the tab in the address', async () => {
    const fake = api();
    const user = userEvent.setup();
    const { router } = renderPanel('/revenue/grants', fake);
    await screen.findAllByText('Upcoming');
    await user.click(screen.getByRole('radio', { name: 'Active and upcoming' }));
    await waitFor(() => expect(router.state.location.search).toBe('?state=active'));
    await waitFor(() => expect(fake.of('GET /v1/admin/grants').at(-1)!.query['state']).toBe('active'));
    await user.click(screen.getByRole('tab', { name: 'Wallet' }));
    await waitFor(() => expect(router.state.location.search).toBe('?tab=wallet'));
    expect((await screen.findAllByText('Double credit')).length).toBeGreaterThan(0);
  });

  it('says when nothing was given yet, and when nothing is active', async () => {
    renderPanel('/revenue/grants?state=active', api({ 'GET /v1/admin/grants': () => pageOf([]) }));
    expect(await screen.findByText('No active or upcoming plan days.')).toBeTruthy();
  });

  it('ends a grant with a reason, and refreshes the list', async () => {
    const fake = api({ 'DELETE /v1/admin/grants/2': () => ({ grant: grantOf('2', { state: 'revoked' }), sideEffects: 'done' }) });
    const user = userEvent.setup();
    renderPanel('/revenue/grants', fake);
    await screen.findAllByText('Upcoming');
    await user.click(screen.getAllByRole('button', { name: 'End now' })[1]!);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Daniel Weber')).toBeTruthy();
    expect(within(dialog).getByText('These plan days end now; a plan bought in a store stays.')).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'End now' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Given by mistake');
    await user.click(confirm);
    expect(await screen.findByText('Plan days ended.')).toBeTruthy();
    expect(fake.of('DELETE /v1/admin/grants/2')[0]!.body).toEqual({ reason: 'Given by mistake' });
    await waitFor(() => expect(fake.of('GET /v1/admin/grants').length).toBeGreaterThan(1));
  });

  it('says an upcoming grant’s days are cancelled before they start (the current plan does not end)', async () => {
    const user = userEvent.setup();
    renderPanel('/revenue/grants', api());
    await screen.findAllByText('Upcoming');
    await user.click(screen.getAllByRole('button', { name: 'End now' })[0]!);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Kaan Demir')).toBeTruthy();
    expect(within(dialog).getByText('These plan days are cancelled before they start.')).toBeTruthy();
    expect(within(dialog).queryByText(/end now/i, { selector: 'p' })).toBeNull();
  });

  it('keeps the reason and the early end’s reason within reach below lg (their column hidden)', async () => {
    renderPanel('/revenue/grants', api());
    await screen.findAllByText('Upcoming');
    const reasons = screen.getAllByText('Beta tester thank-you');
    expect(reasons.some((el) => el.className.includes('lg:hidden'))).toBe(true);
    expect(reasons.some((el) => /\bhidden\b.*\blg:table-cell\b/.test(el.closest('td')?.className ?? ''))).toBe(true);
  });

  it('says when the days were given but the app or the start and end jobs could not be told', async () => {
    const fake = api({ 'POST /v1/admin/grants': () => [201, { grant: grantOf('9', { state: 'scheduled' }), sideEffects: 'failed' }] });
    const user = userEvent.setup();
    renderPanel('/revenue/grants', fake);
    await user.click(await screen.findByRole('button', { name: 'Give plan days' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Person ID' }), PERSON);
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Plan' }), 'premium');
    // A narrower days field on a phone keeps the three quick buttons on its line.
    expect(within(dialog).getByRole('textbox', { name: 'Days' }).className).toMatch(/\bw-20\b.*\bsm:w-28\b/);
    await user.click(within(dialog).getByRole('button', { name: '30 d' }));
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Contest winner');
    await user.click(within(dialog).getByRole('button', { name: 'Give plan days' }));
    expect(await screen.findByText('Saved. Some updates in the app will be late.')).toBeTruthy();
    expect(screen.queryByText('Plan days given.')).toBeNull();
  });

  it('words a grant that had ended meanwhile', async () => {
    const user = userEvent.setup();
    renderPanel('/revenue/grants', api({ 'DELETE /v1/admin/grants/3': () => problem(409, 'conflict', { reason: 'grant_ended' }) }));
    await screen.findAllByText('Upcoming');
    await user.click(screen.getAllByRole('button', { name: 'End now' })[0]!);
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'End now' }));
    expect(await screen.findByText('These plan days have already ended.')).toBeTruthy();
  });

  it('gives no gift buttons and no "End now" to a role that only reads billing', async () => {
    signInAs(adminWith(['billing.read'], ['analyst']));
    renderPanel('/revenue/grants', api());
    await screen.findAllByText('Upcoming');
    expect(screen.queryByRole('button', { name: 'Give plan days' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Adjust wallet' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'End now' })).toBeNull();
  });
});

describe('the "Give plan days" dialog', () => {
  it('checks the person id, names the person, and offers every plan but free and the archived', async () => {
    const user = userEvent.setup();
    renderPanel('/revenue/grants', api());
    await user.click(await screen.findByRole('button', { name: 'Give plan days' }));
    const dialog = await screen.findByRole('dialog');
    const id = within(dialog).getByRole('textbox', { name: 'Person ID' });
    await user.type(id, 'not-a-public-id');
    expect(await within(dialog).findByText('This is not a person ID.')).toBeTruthy();
    await user.clear(id);
    await user.type(id, PERSON.toUpperCase());
    expect(await within(dialog).findByText('Daniel Weber')).toBeTruthy();
    const options = within(within(dialog).getByRole('combobox', { name: 'Plan' }))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['Choose…', 'Plus', 'Premium']);
  });

  it('gives the days with a request id made once for the dialog, and treats a repeat as done', async () => {
    let first = true;
    const fake = api({
      'POST /v1/admin/grants': () => {
        if (first) {
          first = false;
          return problem(503, 'service_unavailable');
        }
        return problem(409, 'conflict', { reason: 'duplicate_request' });
      },
    });
    const user = userEvent.setup();
    renderPanel('/revenue/grants', fake);
    await user.click(await screen.findByRole('button', { name: 'Give plan days' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Person ID' }), PERSON);
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Plan' }), 'premium');
    await user.click(within(dialog).getByRole('button', { name: '7 d' }));
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Contest winner');
    await user.click(within(dialog).getByRole('button', { name: 'Give plan days' }));
    expect(await screen.findByText('The service is busy. Try again in a moment.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Give plan days' }));
    expect(await screen.findByText('This was already done.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [a, b] = fake.of('POST /v1/admin/grants').map((call) => call.body as Record<string, unknown>);
    expect(a).toMatchObject({ user: PERSON, plan: 'premium', days: 7, reason: 'Contest winner' });
    expect(a!['startsAt']).toBeUndefined();
    expect(a!['requestId']).toMatch(UUID);
    expect(b!['requestId']).toBe(a!['requestId']);
  });

  it('refuses days out of range before asking, and shows a refusal at its field', async () => {
    const fake = api({ 'POST /v1/admin/grants': () => problem(422, 'field_invalid', { errors: [{ pointer: '/plan', code: 'archived_plan', message: 'archived' }] }) });
    const user = userEvent.setup();
    renderPanel('/revenue/grants', fake);
    await user.click(await screen.findByRole('button', { name: 'Give plan days' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Person ID' }), PERSON);
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Plan' }), 'plus');
    const days = within(dialog).getByRole('textbox', { name: 'Days' });
    await user.clear(days);
    await user.type(days, '367');
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'r');
    await user.click(within(dialog).getByRole('button', { name: 'Give plan days' }));
    expect(await within(dialog).findByText('Enter 1 to 366 days.')).toBeTruthy();
    expect(fake.of('POST /v1/admin/grants')).toHaveLength(0);
    await user.clear(days);
    await user.type(days, '۳۰');
    await user.click(within(dialog).getByRole('button', { name: 'Give plan days' }));
    expect(await within(dialog).findByText('This plan is archived.')).toBeTruthy();
    expect((fake.of('POST /v1/admin/grants')[0]!.body as { days: number }).days).toBe(30);
  });

  it('starts the days when the person’s current plan ends, from their subscription', async () => {
    const ends = new Date(Date.now() + 20 * 86_400_000).toISOString();
    const fake = api({
      [`GET /v1/admin/users/${PERSON}/purchases`]: () => ({
        subscriptions: [{ store: 'play', plan: 'plus', status: 'renewing', startedAt: '2026-11-01T10:00:00.000Z', expiresAt: ends, autoRenew: true }],
        items: [],
      }),
      'POST /v1/admin/grants': () => [201, { grant: grantOf('9'), sideEffects: 'done' }],
    });
    const user = userEvent.setup();
    renderPanel('/revenue/grants', fake);
    await user.click(await screen.findByRole('button', { name: 'Give plan days' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Person ID' }), PERSON);
    expect(await within(dialog).findByText((_, el) => el?.tagName === 'LI' && /^Has .*Plus.* until /.test(el.textContent ?? ''))).toBeTruthy();
    // Offered only for the plan the person holds.
    expect(within(dialog).queryByRole('radio', { name: 'When the current plan ends' })).toBeNull();
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Plan' }), 'plus');
    await user.click(await within(dialog).findByRole('radio', { name: 'When the current plan ends' }));
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'After the paid one');
    await user.click(within(dialog).getByRole('button', { name: 'Give plan days' }));
    expect(await screen.findByText('Plan days given.')).toBeTruthy();
    expect(fake.of('POST /v1/admin/grants')[0]!.body).toMatchObject({ plan: 'plus', startsAt: ends, days: 30 });
  });

  it('refuses a start beyond the furthest the API takes, before asking', async () => {
    const fake = api({
      [`GET /v1/admin/users/${PERSON}/purchases`]: () => ({
        subscriptions: [{ store: 'bazaar', plan: 'premium', status: 'renewing', startedAt: '2026-11-01T10:00:00.000Z', expiresAt: '2099-01-01T10:00:00.000Z', autoRenew: true }],
        items: [],
      }),
    });
    const user = userEvent.setup();
    renderPanel('/revenue/grants', fake);
    await user.click(await screen.findByRole('button', { name: 'Give plan days' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Person ID' }), PERSON);
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Plan' }), 'premium');
    await user.click(await within(dialog).findByRole('radio', { name: 'When the current plan ends' }));
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'r');
    await user.click(within(dialog).getByRole('button', { name: 'Give plan days' }));
    expect(await within(dialog).findByText('The start is too far ahead.')).toBeTruthy();
    expect(fake.of('POST /v1/admin/grants')).toHaveLength(0);
  });
});

describe('wallet gifts and corrections', () => {
  it('lists every admin row with its kind, balance and note', async () => {
    renderPanel('/revenue/grants?tab=wallet', api());
    expect((await screen.findAllByText('Thanks for the bug report')).length).toBeGreaterThan(0);
    expect(screen.getByText('+5')).toBeTruthy();
    expect(screen.getByText('-2')).toBeTruthy();
    expect(screen.getAllByText('Correction').length).toBeGreaterThan(0);
    // The admin's gifts balance has one name, the wallet tab's: "Granted".
    expect(screen.getAllByText('Granted', { exact: false }).length).toBeGreaterThan(0);
    expect(screen.queryByText('Gifts')).toBeNull();
  });

  it('keeps the time, the kind and the note on a phone, inside the cells that stay (no wider table)', async () => {
    renderPanel('/revenue/grants?tab=wallet', api());
    const change = await screen.findByText('-2');
    const row = change.closest('tr')!;
    const [person, item, delta] = within(row).getAllByRole('cell');
    expect(person!.className).toContain('min-w-0');
    // The kind beside the balance, shown until its own column appears (lg).
    expect(within(item!).getByText(/Correction/).className).toContain('lg:hidden');
    // The time under the item, until its column appears (sm).
    const when = within(item!).getByText(/Nov 25, 2026/);
    expect(when.className).toContain('sm:hidden');
    // On a phone the day alone, on one line (the time has its own column from sm).
    expect(when.className).toContain('whitespace-nowrap');
    expect(when.textContent).toBe('Nov 25, 2026');
    // The note under the change, clamped, until its column appears (lg).
    const note = within(delta!).getByText('Double credit');
    expect(note.className).toContain('line-clamp-2');
    expect(note.className).toContain('lg:hidden');
    // No badge left in the change cell to push the table past the card.
    expect(within(delta!).queryByText('Correction')).toBeNull();
  });

  it('gives a gift to the gifts balance, showing the balance before and after', async () => {
    const fake = api({ [`POST /v1/admin/users/${PERSON}/wallet-adjust`]: () => [201, { entry: adjustmentOf('9'), sideEffects: 'done' }] });
    const user = userEvent.setup();
    renderPanel('/revenue/grants?tab=wallet', fake);
    await user.click(await screen.findByRole('button', { name: 'Adjust wallet' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Person ID' }), PERSON);
    await user.type(within(dialog).getByRole('textbox', { name: 'Amount' }), '5');
    expect(await within(dialog).findByText('Balance now: 4, after: 9')).toBeTruthy();
    await user.type(within(dialog).getByRole('textbox', { name: /Note/ }), 'Bug report');
    await user.click(within(dialog).getByRole('button', { name: 'Give' }));
    expect(await screen.findByText('Wallet updated.')).toBeTruthy();
    const body = fake.of(`POST /v1/admin/users/${PERSON}/wallet-adjust`)[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ kind: 'gift', item: 'superlike', quantity: 5, note: 'Bug report' });
    expect(body['requestId']).toMatch(UUID);
  });

  it('corrects a store balance and says, at the amount, when it does not hold that much', async () => {
    const fake = api({ [`POST /v1/admin/users/${PERSON}/wallet-adjust`]: () => problem(422, 'field_invalid', { errors: [{ pointer: '/delta', code: 'insufficient_balance', message: 'short' }] }) });
    const user = userEvent.setup();
    renderPanel('/revenue/grants?tab=wallet', fake);
    await user.click(await screen.findByRole('button', { name: 'Adjust wallet' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Person ID' }), PERSON);
    await user.click(within(dialog).getByRole('radio', { name: 'Correction' }));
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Item' }), 'boost');
    await user.click(within(dialog).getByRole('radio', { name: 'Google Play' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Amount' }), '-2');
    expect(await within(dialog).findByText('Balance now: 2, after: 0')).toBeTruthy();
    await user.type(within(dialog).getByRole('textbox', { name: /Note/ }), 'Fix');
    await user.click(within(dialog).getByRole('button', { name: 'Correct' }));
    // The balance had changed meanwhile: the server's refusal shows at the amount.
    expect(await within(dialog).findByText('Not enough in this balance.')).toBeTruthy();
    expect(fake.of(`POST /v1/admin/users/${PERSON}/wallet-adjust`)[0]!.body).toMatchObject({ kind: 'correction', item: 'boost', balance: 'play', delta: -2, note: 'Fix' });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('shows a correction below zero as refused before sending: the preview in red, the amount’s error, nothing asked', async () => {
    const fake = api();
    const user = userEvent.setup();
    renderPanel('/revenue/grants?tab=wallet', fake);
    await user.click(await screen.findByRole('button', { name: 'Adjust wallet' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Person ID' }), PERSON);
    await user.click(within(dialog).getByRole('radio', { name: 'Correction' }));
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Item' }), 'boost');
    await user.click(within(dialog).getByRole('radio', { name: 'Google Play' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Amount' }), '-50');
    const preview = await within(dialog).findByText('Balance now: 2, after: -48');
    expect(preview.className).toContain('text-destructive');
    expect(within(dialog).getByText('Not enough in this balance.')).toBeTruthy();
    await user.type(within(dialog).getByRole('textbox', { name: /Note/ }), 'Fix');
    await user.click(within(dialog).getByRole('button', { name: 'Correct' }));
    expect(fake.of(`POST /v1/admin/users/${PERSON}/wallet-adjust`)).toHaveLength(0);
    // The gifts balance reads as on the wallet tab.
    expect(within(dialog).getByRole('radio', { name: 'Granted' })).toBeTruthy();
  });

  it('says when the wallet changed but the app could not be told', async () => {
    const fake = api({ [`POST /v1/admin/users/${PERSON}/wallet-adjust`]: () => [201, { entry: adjustmentOf('9'), sideEffects: 'failed' }] });
    const user = userEvent.setup();
    renderPanel('/revenue/grants?tab=wallet', fake);
    await user.click(await screen.findByRole('button', { name: 'Adjust wallet' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Person ID' }), PERSON);
    await user.type(within(dialog).getByRole('textbox', { name: 'Amount' }), '5');
    await user.type(within(dialog).getByRole('textbox', { name: /Note/ }), 'Bug report');
    await user.click(within(dialog).getByRole('button', { name: 'Give' }));
    expect(await screen.findByText('Saved. Some updates in the app will be late.')).toBeTruthy();
    expect(screen.queryByText('Wallet updated.')).toBeNull();
  });

  it('refuses a correction of zero before asking', async () => {
    const fake = api();
    const user = userEvent.setup();
    renderPanel('/revenue/grants?tab=wallet', fake);
    await user.click(await screen.findByRole('button', { name: 'Adjust wallet' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Person ID' }), PERSON);
    await user.click(within(dialog).getByRole('radio', { name: 'Correction' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Amount' }), '0');
    await user.type(within(dialog).getByRole('textbox', { name: /Note/ }), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Correct' }));
    expect(await within(dialog).findByText('Enter −10,000 to 10,000, not 0.')).toBeTruthy();
    expect(fake.of(`POST /v1/admin/users/${PERSON}/wallet-adjust`)).toHaveLength(0);
  });

  it('offers the admin role gifts only: no Correction', async () => {
    signInAs(adminRole);
    const user = userEvent.setup();
    renderPanel('/revenue/grants?tab=wallet', api());
    await user.click(await screen.findByRole('button', { name: 'Adjust wallet' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('radio', { name: 'Correction' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Give' })).toBeTruthy();
    // Nor "End now" on the plan days.
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('tab', { name: 'Plan days' }));
    await screen.findAllByText('Upcoming');
    expect(screen.queryByRole('button', { name: 'End now' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Give plan days' })).toBeTruthy();
  });

  it('reads in Persian', async () => {
    renderPanel('/revenue/grants', api(), { locale: 'fa' });
    expect(await screen.findByRole('heading', { level: 1, name: 'هدیه‌ها و اصلاح‌ها' })).toBeTruthy();
    expect((await screen.findAllByText('پایان زودهنگام')).length).toBeGreaterThan(0);
    expect(screen.getByRole('tab', { name: 'روزهای پلن' })).toBeTruthy();
  });
});
