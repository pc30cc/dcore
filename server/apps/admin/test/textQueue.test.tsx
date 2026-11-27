import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeApi, problem, renderPanel, resetPanel, signInAs } from './panel';
import { moderator, page, reader, textItem } from './moderationFixtures';

/** The position as the live region says it (the page header shows the same words for the eye). */
const LIVE = { selector: 'p[aria-live]' };

beforeEach(() => {
  resetPanel();
  signInAs(moderator);
});

const key = (code: string, k: string) => act(() => void fireEvent.keyDown(window, { code, key: k }));

function queueApi(extra: Record<string, () => unknown> = {}) {
  const first = textItem(1);
  const second = textItem(2, { about: null, job: { text: 'Pilot', state: 'checking' } });
  return fakeApi({
    'GET /v1/admin/moderation/texts': () => page([first, second]),
    [`POST /v1/admin/moderation/texts/${first.user.id}/approve`]: () => ({ texts: { ...first, about: { text: 'About text 1', state: 'approved' } }, sideEffects: 'done' }),
    [`POST /v1/admin/moderation/texts/${first.user.id}/reject`]: () => ({ texts: first, sideEffects: 'done' }),
    ...extra,
  });
}

describe('the text queue', () => {
  it('shows each person with their waiting parts and their states', async () => {
    renderPanel('/moderation/texts', queueApi());
    expect(await screen.findByText('About text 1')).toBeTruthy();
    expect(screen.getByText('Pilot')).toBeTruthy();
    expect(screen.getAllByText('A good day').length).toBe(2);
    expect(screen.getAllByText('Waiting').length).toBeGreaterThan(0);
    expect(screen.getByText('Person 1 of 2', LIVE)).toBeTruthy();
  });

  it('approves every waiting part of the focused person with A, with the version read', async () => {
    const api = queueApi();
    renderPanel('/moderation/texts', api);
    await screen.findByText('About text 1');
    key('KeyA', 'a');
    const id = textItem(1).user.id;
    await waitFor(() => expect(api.of(`POST /v1/admin/moderation/texts/${id}/approve`)).toHaveLength(1));
    expect(api.of(`POST /v1/admin/moderation/texts/${id}/approve`)[0]?.body).toEqual({ version: 11 });
    await waitFor(() => expect(screen.queryByText('About text 1')).toBeNull());
    // Said in the live region, no toast over the next card.
    expect(await screen.findByText('Approved. Person 1 of 1')).toBeTruthy();
    expect(screen.queryByText('Approved.')).toBeNull();
  });

  it('rejects with R: the waiting parts checked, a reason by its key, Enter sends', async () => {
    const api = queueApi();
    renderPanel('/moderation/texts', api);
    await screen.findByText('About text 1');
    key('KeyR', 'r');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('checkbox', { name: 'About and job' })).toHaveProperty('checked', true);
    expect(within(dialog).getByRole('checkbox', { name: 'A good day' })).toHaveProperty('checked', true);
    key('Digit1', '1');
    key('Enter', 'Enter');
    const id = textItem(1).user.id;
    await waitFor(() => expect(api.of(`POST /v1/admin/moderation/texts/${id}/reject`)).toHaveLength(1));
    expect(api.of(`POST /v1/admin/moderation/texts/${id}/reject`)[0]?.body).toEqual({ version: 11, reason: 'contact_details', profile: true, prompts: [0] });
  });

  it('reads the queue again when a profile changed in the meantime', async () => {
    const id = textItem(1).user.id;
    const api = queueApi({ [`POST /v1/admin/moderation/texts/${id}/approve`]: () => problem(409, 'conflict', { detail: 'The profile changed; reload it.', reason: 'stale' }) });
    renderPanel('/moderation/texts', api);
    await screen.findByText('About text 1');
    const reads = api.of('GET /v1/admin/moderation/texts').length;
    await userEvent.setup().click(screen.getAllByRole('button', { name: /^Approve/ })[0]!);
    expect(await screen.findByText('The profile changed. It was reloaded.')).toBeTruthy();
    await waitFor(() => expect(api.of('GET /v1/admin/moderation/texts').length).toBeGreaterThan(reads));
  });

  it('moves the focus with J and K', async () => {
    renderPanel('/moderation/texts', queueApi());
    await screen.findByText('Person 1 of 2', LIVE);
    key('KeyJ', 'j');
    expect(await screen.findByText('Person 2 of 2', LIVE)).toBeTruthy();
    key('KeyK', 'k');
    expect(await screen.findByText('Person 1 of 2', LIVE)).toBeTruthy();
  });

  it('offers no decision to a reader', async () => {
    signInAs(reader);
    const api = queueApi();
    renderPanel('/moderation/texts', api);
    await screen.findByText('About text 1');
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    key('KeyA', 'a');
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('speaks Turkish', async () => {
    renderPanel('/moderation/texts', queueApi(), { locale: 'tr' });
    expect(await screen.findByRole('heading', { name: 'Metinler' })).toBeTruthy();
    expect(await screen.findAllByRole('button', { name: /^Onayla/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /^Reddet/ })).toHaveLength(2);
  });

  it('keeps the keyboard focus in the list after a decision, on the card now in its place', async () => {
    const api = queueApi();
    const user = userEvent.setup();
    renderPanel('/moderation/texts', api);
    await screen.findByText('About text 1');
    screen.getAllByRole('button', { name: /^Approve/ })[0]!.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByText('About text 1')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole('button', { name: /^Approve/ })[0]));
  });

  it('says in the reject dialog what the decision does to each part', async () => {
    renderPanel('/moderation/texts', queueApi());
    await screen.findByText('About text 1');
    key('KeyR', 'r');
    const dialog = await screen.findByRole('dialog');
    const about = within(dialog).getByRole('checkbox', { name: 'About and job' });
    expect(document.getElementById(about.getAttribute('aria-describedby')!)?.textContent).toBe('Rejected');
    // A waiting part left unchecked is approved with the decision.
    await userEvent.setup().click(about);
    expect(document.getElementById(about.getAttribute('aria-describedby')!)?.textContent).toBe('Approved');
  });
});
