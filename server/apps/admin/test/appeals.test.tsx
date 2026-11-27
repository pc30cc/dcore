import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminWith, fakeApi, problem, renderPanel, resetPanel, signInAs } from './panel';
import { appeal, moderator, page, reader } from './moderationFixtures';

beforeEach(() => {
  resetPanel();
  signInAs(moderator);
});

function appealsApi(extra: Record<string, () => unknown> = {}) {
  const decided = appeal('42', { status: 'overturned', decisionText: 'We looked again; the ban is lifted.', decidedAt: '2026-11-25T11:00:00.000Z', decidedBy: { id: '3', displayName: 'Mina' } });
  return fakeApi({
    'GET /v1/admin/appeals': (call) => (call.query['status'] === 'decided' ? page([decided]) : page([appeal('41')])),
    'POST /v1/admin/appeals/41/uphold': () => ({ appeal: appeal('41', { status: 'upheld' }), sideEffects: 'done' }),
    'POST /v1/admin/appeals/41/overturn': () => ({ appeal: appeal('41', { status: 'overturned' }), sideEffects: 'done' }),
    ...extra,
  });
}

describe('the appeals page', () => {
  it('shows each open appeal with the action, the reason the person read, their words and their record', async () => {
    const api = appealsApi();
    renderPanel('/moderation/appeals', api);
    expect(await screen.findByText('I did not do this, please look again.')).toBeTruthy();
    const card = screen.getByRole('article');
    expect(within(card).getByText('Appealing Person')).toBeTruthy();
    expect(within(card).getByText('Ban')).toBeTruthy();
    expect(within(card).getByText('You harassed other members.')).toBeTruthy();
    expect(within(card).getByText('Earlier records (1)')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Uphold' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Overturn' })).toBeTruthy();
    expect(api.of('GET /v1/admin/appeals')[0]?.query).toMatchObject({ status: 'open', limit: '20' });
  });

  it('overturns with the message to the person, and the appeal leaves the queue', async () => {
    const api = appealsApi();
    const user = userEvent.setup();
    renderPanel('/moderation/appeals', api);
    await user.click(await screen.findByRole('button', { name: 'Overturn' }));
    const dialog = await screen.findByRole('dialog', { name: 'Overturn the action on Appealing Person' });
    await user.click(within(dialog).getByRole('button', { name: 'Overturn' }));
    expect(await within(dialog).findByText('Required.')).toBeTruthy();
    expect(api.of('POST /v1/admin/appeals/41/overturn')).toHaveLength(0);
    await user.type(within(dialog).getByLabelText(/Message to Appealing Person/), 'We looked again; the ban is lifted.');
    await user.click(within(dialog).getByRole('button', { name: 'Overturn' }));
    await waitFor(() => expect(api.of('POST /v1/admin/appeals/41/overturn')).toHaveLength(1));
    expect(api.of('POST /v1/admin/appeals/41/overturn')[0]?.body).toEqual({ text: 'We looked again; the ban is lifted.' });
    expect(await screen.findByText('Action overturned.')).toBeTruthy();
    expect(await screen.findByText('Nothing waiting.')).toBeTruthy();
  });

  it('says in which language the person reads the decision, and writes it in that direction', async () => {
    const user = userEvent.setup();
    renderPanel('/moderation/appeals', appealsApi({ 'GET /v1/admin/appeals': () => page([appeal('41', { locale: 'fa-IR' })]) }));
    await user.click(await screen.findByRole('button', { name: 'Uphold' }));
    const dialog = await screen.findByRole('dialog', { name: 'Uphold the action on Appealing Person' });
    expect(within(dialog).getByText('Persian')).toBeTruthy();
    const field = within(dialog).getByLabelText(/Message to Appealing Person/);
    expect(field.getAttribute('lang')).toBe('fa');
    expect(field.getAttribute('dir')).toBe('rtl');
  });

  it('upholds with its own words', async () => {
    const api = appealsApi();
    const user = userEvent.setup();
    renderPanel('/moderation/appeals', api);
    await user.click(await screen.findByRole('button', { name: 'Uphold' }));
    const dialog = await screen.findByRole('dialog', { name: 'Uphold the action on Appealing Person' });
    await user.type(within(dialog).getByLabelText(/Message to Appealing Person/), 'The ban stays.');
    await user.click(within(dialog).getByRole('button', { name: 'Uphold' }));
    await waitFor(() => expect(api.of('POST /v1/admin/appeals/41/uphold')[0]?.body).toEqual({ text: 'The ban stays.' }));
    expect(await screen.findByText('Action upheld.')).toBeTruthy();
  });

  it('drops an appeal decided elsewhere, with the words for it', async () => {
    const api = appealsApi({ 'POST /v1/admin/appeals/41/uphold': () => problem(409, 'conflict', { detail: 'Already decided.', reason: 'already_decided' }) });
    const user = userEvent.setup();
    renderPanel('/moderation/appeals', api);
    await user.click(await screen.findByRole('button', { name: 'Uphold' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'The ban stays.');
    await user.click(within(dialog).getByRole('button', { name: 'Uphold' }));
    expect(await screen.findByText('Already decided.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Nothing waiting.')).toBeTruthy();
  });

  it('shows the decided ones with the decision and no buttons', async () => {
    const { router } = renderPanel('/moderation/appeals', appealsApi());
    await screen.findByText('I did not do this, please look again.');
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Decided' }));
    expect(await screen.findByText('We looked again; the ban is lifted.')).toBeTruthy();
    expect(screen.getByText('Action overturned')).toBeTruthy();
    // When it was decided, beside who decided it.
    expect(screen.getByText('We looked again; the ban is lifted.').closest('p')?.textContent).toMatch(/Mina · .*2026/);
    expect(router.state.location.search).toBe('?status=decided');
    expect(screen.queryByRole('button', { name: 'Uphold' })).toBeNull();
  });

  it('offers no decision to a reader', async () => {
    signInAs(reader);
    renderPanel('/moderation/appeals', appealsApi());
    await screen.findByText('I did not do this, please look again.');
    expect(screen.queryByRole('button', { name: 'Uphold' })).toBeNull();
  });

  it('is closed to a role without appeals.read, with no request', async () => {
    signInAs(adminWith(['users.read'], ['support']));
    const api = appealsApi();
    renderPanel('/moderation/appeals', api);
    expect(await screen.findByText('No access')).toBeTruthy();
    expect(api.of('GET /v1/admin/appeals')).toHaveLength(0);
  });

  it('speaks Turkish', async () => {
    renderPanel('/moderation/appeals', appealsApi(), { locale: 'tr' });
    expect(await screen.findByRole('heading', { name: 'İtirazlar' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'İtirazı reddet' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'İtirazı kabul et' })).toBeTruthy();
    expect(screen.getByText('Önceki kayıtlar (1)')).toBeTruthy();
  });
});
