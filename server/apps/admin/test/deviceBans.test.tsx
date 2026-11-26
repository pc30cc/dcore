import type { AdminDeviceBan } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { page, person } from './moderationFixtures';
import { SARA, detail } from './userFixtures';
import { adminWith, fakeApi, problem, renderPanel, resetPanel, signInAs } from './panel';

const writer = adminWith(['moderation.read', 'moderation.device_bans'], ['moderator']);
const readOnly = adminWith(['moderation.read'], ['support']);
/** Reads people too: the dialog shows who a public id names before banning. */
const peopleWriter = adminWith(['users.read', 'moderation.read', 'moderation.device_bans'], ['moderator']);
const PHONE_FORMAT = 'Write the number with its country code, like +44 7700 900123.';

function ban(id: string, overrides: Partial<AdminDeviceBan> = {}): AdminDeviceBan {
  return {
    id,
    kind: 'device',
    store: 'bazaar',
    reason: 'Ban evasion ring',
    createdAt: '2026-11-20T10:00:00.000Z',
    createdBy: { id: '4', displayName: 'Mina Mod' },
    expiresAt: null,
    active: true,
    user: person(1, 'Banned Person'),
    actionId: '55',
    ...overrides,
  };
}

function bansApi(extra: Record<string, Parameters<typeof fakeApi>[0][string]> = {}) {
  return fakeApi({
    'GET /v1/admin/device-bans': (call) =>
      call.query['kind'] === 'phone'
        ? page([ban('7', { kind: 'phone', store: null, user: null, actionId: null, createdBy: null, reason: 'Under 18', expiresAt: '2026-01-01T00:00:00.000Z', active: false })])
        : page([ban('9'), ban('7', { kind: 'phone', store: null, user: null, actionId: null, createdBy: null, reason: 'Under 18', expiresAt: '2026-01-01T00:00:00.000Z', active: false })]),
    'POST /v1/admin/device-bans/search': () => ({ items: [ban('12', { kind: 'phone', store: null, reason: 'Typed number' })] }),
    'POST /v1/admin/device-bans': () => [201, { items: [ban('13')] }],
    'DELETE /v1/admin/device-bans/9': () => undefined,
    ...extra,
  });
}

beforeEach(() => {
  resetPanel();
  signInAs(writer);
});

describe('the device bans page', () => {
  it('lists bans with their kind, store, person, reason, author and end', async () => {
    renderPanel('/moderation/device-bans', bansApi());
    expect(await screen.findByRole('heading', { name: 'Device bans' })).toBeTruthy();
    const rows = (await screen.findAllByRole('row')).slice(1);
    expect(within(rows[0]!).getByText('Device')).toBeTruthy();
    expect(within(rows[0]!).getByText('Cafe Bazaar')).toBeTruthy();
    expect(within(rows[0]!).getByText('Banned Person')).toBeTruthy();
    expect(within(rows[0]!).getByText('Ban evasion ring')).toBeTruthy();
    expect(within(rows[0]!).getByText('Mina Mod')).toBeTruthy();
    expect(within(rows[0]!).getByText('Permanent')).toBeTruthy();
    expect(within(rows[0]!).getByText('Active')).toBeTruthy();
    expect(within(rows[1]!).getByText('Phone number')).toBeTruthy();
    expect(within(rows[1]!).getByText('Automatic')).toBeTruthy();
    expect(within(rows[1]!).getByText('Expired')).toBeTruthy();
  });

  it('filters by kind in the address, and looks a number up without putting it in the address', async () => {
    const api = bansApi();
    const user = userEvent.setup();
    const { router } = renderPanel('/moderation/device-bans', api);
    await screen.findByText('Banned Person');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'phone');
    await waitFor(() => expect(router.state.location.search).toBe('?kind=phone'));
    await waitFor(() => expect(api.of('GET /v1/admin/device-bans').at(-1)?.query).toEqual({ kind: 'phone', limit: '50' }));
    await user.type(screen.getByRole('textbox', { name: 'Phone number' }), '+989121234567{Enter}');
    expect(await screen.findByText('Typed number')).toBeTruthy();
    expect(api.of('POST /v1/admin/device-bans/search')[0]?.body).toEqual({ phone: '+989121234567' });
    expect(router.state.location.search).not.toContain('98912');
    expect(router.state.location.pathname).not.toContain('98912');
    await user.click(screen.getByRole('button', { name: 'Clear the number' }));
    expect(screen.queryByText('Typed number')).toBeNull();
  });

  it('says when a number is not one', async () => {
    const api = bansApi({ 'POST /v1/admin/device-bans/search': () => problem(422, 'field_invalid', { errors: [{ in: 'body', pointer: '/phone', code: 'phone_invalid', message: 'x' }] }) });
    const user = userEvent.setup();
    renderPanel('/moderation/device-bans', api);
    await screen.findByText('Banned Person');
    const input = screen.getByRole('textbox', { name: 'Phone number' });
    await user.type(input, '12{Enter}');
    const message = await screen.findByText(PHONE_FORMAT);
    // The reason is read with the field.
    expect(input.getAttribute('aria-describedby')).toBe(message.id);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(api.of('POST /v1/admin/device-bans/search')).toHaveLength(1);
  });

  it('asks for the country code of a number written the local way, without a lookup', async () => {
    const api = bansApi();
    const user = userEvent.setup();
    renderPanel('/moderation/device-bans', api);
    await screen.findByText('Banned Person');
    await user.type(screen.getByRole('textbox', { name: 'Phone number' }), '0912 123 4567{Enter}');
    expect(await screen.findByText(PHONE_FORMAT)).toBeTruthy();
    await user.clear(screen.getByRole('textbox', { name: 'Phone number' }));
    await user.type(screen.getByRole('textbox', { name: 'Phone number' }), '۰۹۱۲۱۲۳۴۵۶۷{Enter}');
    expect(await screen.findByText(PHONE_FORMAT)).toBeTruthy();
    expect(api.of('POST /v1/admin/device-bans/search')).toHaveLength(0);
  });

  it('puts the search icon on the side the number is written from, in Persian too', async () => {
    renderPanel('/moderation/device-bans', bansApi(), { locale: 'fa' });
    const input = await screen.findByRole('textbox', { name: 'شماره تلفن' });
    expect(input.getAttribute('dir')).toBe('ltr');
    expect(input.className).toContain('pl-9');
    expect(input.parentElement?.querySelector('svg')?.getAttribute('class')).toContain('left-3');
  });

  it('shows the whole list again after a new ban made while a lookup was shown', async () => {
    const api = bansApi();
    const user = userEvent.setup();
    renderPanel('/moderation/device-bans', api);
    await screen.findByText('Banned Person');
    await user.type(screen.getByRole('textbox', { name: 'Phone number' }), '+989121234567{Enter}');
    expect(await screen.findByText('Typed number')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'New ban' }));
    const dialog = await screen.findByRole('dialog', { name: 'New ban' });
    await user.click(within(dialog).getByRole('radio', { name: 'A phone number' }));
    await user.type(within(dialog).getByLabelText('Phone number'), '+989121234567');
    await user.type(within(dialog).getByLabelText('Reason'), 'Same number');
    await user.click(within(dialog).getByRole('button', { name: 'Ban' }));
    await waitFor(() => expect(screen.queryByText('Typed number')).toBeNull());
    expect(await screen.findByText('Ban evasion ring')).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Phone number' }).value).toBe('');
  });

  it('shows who a public id names before banning them, and bans no one it does not name', async () => {
    signInAs(peopleWriter);
    const api = bansApi({
      [`GET /v1/admin/users/${SARA}`]: () => detail(),
      'GET /v1/admin/users/nobodyaaaaaaa': () => problem(404, 'not_found'),
    });
    const user = userEvent.setup();
    renderPanel('/moderation/device-bans', api);
    await screen.findByText('Banned Person');
    await user.click(screen.getByRole('button', { name: 'New ban' }));
    const dialog = await screen.findByRole('dialog', { name: 'New ban' });
    const submit = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Ban' });
    await user.type(within(dialog).getByLabelText('Public ID'), 'nobodyaaaaaaa');
    expect(await within(dialog).findByText('No such person.')).toBeTruthy();
    expect(submit.disabled).toBe(true);
    await user.clear(within(dialog).getByLabelText('Public ID'));
    await user.type(within(dialog).getByLabelText('Public ID'), SARA);
    expect(await within(dialog).findByText('Sara Ahmadi')).toBeTruthy();
    expect(submit.disabled).toBe(false);
    await user.type(within(dialog).getByLabelText('Reason'), 'Ban evasion');
    await user.click(submit);
    await waitFor(() => expect(api.of('POST /v1/admin/device-bans')).toHaveLength(1));
    expect(api.of('POST /v1/admin/device-bans')[0]?.body).toMatchObject({ from: 'user', user: SARA });
  });

  it('moves the choice of what to ban by with the arrow keys (one tab stop), and links the kinds error', async () => {
    const api = bansApi();
    const user = userEvent.setup();
    renderPanel('/moderation/device-bans', api);
    await screen.findByText('Banned Person');
    await user.click(screen.getByRole('button', { name: 'New ban' }));
    const dialog = await screen.findByRole('dialog', { name: 'New ban' });
    const person = within(dialog).getByRole('radio', { name: 'A person' });
    const phone = within(dialog).getByRole('radio', { name: 'A phone number' });
    expect([person.tabIndex, phone.tabIndex]).toEqual([0, -1]);
    person.focus();
    await user.keyboard('{ArrowRight}');
    expect(phone.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(phone);
    expect([person.tabIndex, phone.tabIndex]).toEqual([-1, 0]);
    await user.keyboard('{Home}');
    expect(person.getAttribute('aria-checked')).toBe('true');
    for (const kind of ['Device', 'Phone number', 'Google account']) await user.click(within(dialog).getByRole('checkbox', { name: kind }));
    await user.click(within(dialog).getByRole('button', { name: 'Ban' }));
    const error = await within(dialog).findByText('Choose at least one.');
    expect(within(dialog).getByRole('group', { name: 'What to ban' }).getAttribute('aria-describedby')).toBe(error.id);
  });

  it('shows a typed end day in the Persian calendar under the picker', async () => {
    const user = userEvent.setup();
    renderPanel('/moderation/device-bans', bansApi(), { locale: 'fa' });
    await user.click(await screen.findByRole('button', { name: 'مسدودسازی جدید' }));
    const dialog = await screen.findByRole('dialog', { name: 'مسدودسازی جدید' });
    expect(within(dialog).getByRole('button', { name: 'مسدودسازی' })).toBeTruthy();
    await user.selectOptions(within(dialog).getByLabelText('پایان'), 'date');
    await user.type(within(dialog).getByLabelText('تاریخ'), '2027-03-21');
    expect(await within(dialog).findByText(new Intl.DateTimeFormat('fa', { dateStyle: 'medium' }).format(new Date('2027-03-21T12:00:00')))).toBeTruthy();
  });

  it('bans what a person signs in with: nothing is sent before confirming, then the exact body', async () => {
    const api = bansApi();
    const user = userEvent.setup();
    renderPanel('/moderation/device-bans', api);
    await screen.findByText('Banned Person');
    await user.click(screen.getByRole('button', { name: 'New ban' }));
    const dialog = await screen.findByRole('dialog', { name: 'New ban' });
    await user.click(within(dialog).getByRole('button', { name: 'Ban' }));
    expect(await within(dialog).findByText('Write a public id (13 letters).')).toBeTruthy();
    expect(api.of('POST /v1/admin/device-bans')).toHaveLength(0);
    await user.type(within(dialog).getByLabelText('Public ID'), 'userbaaaaaaaa');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Google account' }));
    await user.selectOptions(within(dialog).getByLabelText('Expires'), '30d');
    await user.type(within(dialog).getByLabelText('Reason'), 'Ban evasion');
    await user.click(within(dialog).getByRole('button', { name: 'Ban' }));
    await waitFor(() => expect(api.of('POST /v1/admin/device-bans')).toHaveLength(1));
    const body = api.of('POST /v1/admin/device-bans')[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ from: 'user', user: 'userbaaaaaaaa', kinds: ['device', 'phone'], reason: 'Ban evasion' });
    expect(Date.parse(String(body['expiresAt'])) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('bans a typed number, and shows the API’s refusals at their fields', async () => {
    let answer: unknown = problem(422, 'field_invalid', { errors: [{ in: 'body', pointer: '/phone', code: 'phone_invalid', message: 'x' }] });
    const api = bansApi({ 'POST /v1/admin/device-bans': () => answer });
    const user = userEvent.setup();
    renderPanel('/moderation/device-bans', api);
    await screen.findByText('Banned Person');
    await user.click(screen.getByRole('button', { name: 'New ban' }));
    const dialog = await screen.findByRole('dialog', { name: 'New ban' });
    await user.click(within(dialog).getByRole('radio', { name: 'A phone number' }));
    expect(within(dialog).getByLabelText('Phone number').getAttribute('placeholder')).toBe('+44 7700 900123');
    // The local way is refused in the dialog, before anything is sent.
    await user.type(within(dialog).getByLabelText('Phone number'), '0912 123 4567');
    await user.type(within(dialog).getByLabelText('Reason'), 'Reported many times');
    await user.click(within(dialog).getByRole('button', { name: 'Ban' }));
    expect(await within(dialog).findByText(PHONE_FORMAT)).toBeTruthy();
    expect(api.of('POST /v1/admin/device-bans')).toHaveLength(0);
    await user.clear(within(dialog).getByLabelText('Phone number'));
    await user.type(within(dialog).getByLabelText('Phone number'), '+98 21 1234');
    await user.click(within(dialog).getByRole('button', { name: 'Ban' }));
    await waitFor(() => expect(api.of('POST /v1/admin/device-bans')).toHaveLength(1));
    expect(await within(dialog).findByText(PHONE_FORMAT)).toBeTruthy();
    expect(api.of('POST /v1/admin/device-bans')[0]?.body).toEqual({ from: 'phone', phone: '+98 21 1234', reason: 'Reported many times' });
    answer = problem(404, 'not_found');
    await user.click(within(dialog).getByRole('radio', { name: 'A person' }));
    await user.type(within(dialog).getByLabelText('Public ID'), 'usernobodyaaa');
    await user.click(within(dialog).getByRole('button', { name: 'Ban' }));
    expect(await within(dialog).findByText('No such person.')).toBeTruthy();
    answer = problem(422, 'field_invalid', { errors: [{ in: 'body', pointer: '/kinds', code: 'nothing_to_ban', message: 'x' }] });
    await user.click(within(dialog).getByRole('button', { name: 'Ban' }));
    expect(await within(dialog).findByText('This person has nothing of these kinds to ban.')).toBeTruthy();
  });

  it('removes a ban after confirming; a reader sees no way to change anything', async () => {
    const api = bansApi();
    const user = userEvent.setup();
    renderPanel('/moderation/device-bans', api);
    await screen.findByText('Banned Person');
    await user.click(screen.getByRole('button', { name: 'Actions for Device · Banned Person' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Remove this ban?' });
    expect(within(confirm).getByText('Ban evasion ring')).toBeTruthy();
    expect(api.of('DELETE /v1/admin/device-bans/9')).toHaveLength(0);
    // A removal says why (kept in its audit row): nothing to send before.
    expect(within(confirm).getByRole('button', { name: 'Remove' })).toHaveProperty('disabled', true);
    await user.type(within(confirm).getByLabelText('Reason'), 'Entered by mistake.');
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.of('DELETE /v1/admin/device-bans/9')).toHaveLength(1));
    expect(api.of('DELETE /v1/admin/device-bans/9')[0]?.body).toEqual({ reason: 'Entered by mistake.' });
    expect(await screen.findByText('Removed.')).toBeTruthy();
  });

  it('shows a reader the list without anything to change', async () => {
    signInAs(readOnly);
    renderPanel('/moderation/device-bans', bansApi());
    await screen.findByText('Banned Person');
    expect(screen.queryByRole('button', { name: 'New ban' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
  });

  it('is in Turkish with the glossary’s words', async () => {
    renderPanel('/moderation/device-bans', bansApi(), { locale: 'tr' });
    expect(await screen.findByRole('heading', { name: 'Cihaz yasakları' })).toBeTruthy();
    expect(await screen.findByText('Kalıcı')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Yeni yasak' })).toBeTruthy();
  });
});
