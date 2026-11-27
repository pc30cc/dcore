import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminWith, fakeApi, problem, renderPanel, resetPanel, signInAs, type Call } from './panel';
import { ADMIN, action, detail, emptyPhotos, fullAdmin, reasons, SARA } from './userFixtures';

beforeEach(() => {
  resetPanel();
  signInAs(fullAdmin);
});

const FA_SPAM = 'از حساب شما پیام‌های ناخواسته یا تبلیغاتی فرستاده شده است.';
const FA_HARASS = 'شما دیگر کاربران را آزار داده‌اید یا مزاحمشان شده‌اید.';

function api(extra: Record<string, (call: Call) => unknown> = {}) {
  return fakeApi({
    [`GET /v1/admin/users/${SARA}`]: () => detail({ standing: [action('51')] }),
    [`GET /v1/admin/users/${SARA}/photos`]: () => emptyPhotos,
    'GET /v1/admin/moderation/reasons': () => reasons,
    ...extra,
  });
}

const result = (sideEffects: 'done' | 'failed' = 'done') => ({ user: detail(), action: action('60'), sideEffects });

async function open(item: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Actions' }));
  await user.click(await screen.findByRole('menuitem', { name: item }));
  return { user, dialog: await screen.findByRole(item === 'Sign out everywhere' || item === 'Delete account' ? 'alertdialog' : 'dialog') };
}

describe('action dialogs', () => {
  it('warns: the message follows the reason in the person’s language until edited, then the exact body is sent', async () => {
    const fake = api({ [`POST /v1/admin/users/${SARA}/warn`]: () => result() });
    renderPanel(`/users/${SARA}`, fake);
    const { user, dialog } = await open('Warn');
    expect(within(dialog).getByRole('heading', { name: 'Warn Sara Ahmadi' })).toBeTruthy();
    const reason = within(dialog).getByLabelText('Reason');
    const message = within(dialog).getByLabelText<HTMLTextAreaElement>(/Message to Sara Ahmadi/);
    await user.selectOptions(reason, 'spam');
    await waitFor(() => expect(message.value).toBe(FA_SPAM));
    expect(message.dir).toBe('rtl');
    await user.selectOptions(reason, 'harassment');
    expect(message.value).toBe(FA_HARASS);
    await user.type(message, ' Again.');
    await user.selectOptions(reason, 'spam');
    expect(message.value).toBe(`${FA_HARASS} Again.`);
    expect(fake.of(`POST /v1/admin/users/${SARA}/warn`)).toHaveLength(0);
    await user.type(within(dialog).getByLabelText(/Internal note/), 'second time');
    await user.click(within(dialog).getByRole('button', { name: 'Warn' }));
    await waitFor(() => expect(fake.of(`POST /v1/admin/users/${SARA}/warn`)).toHaveLength(1));
    expect(fake.of(`POST /v1/admin/users/${SARA}/warn`)[0]?.body).toEqual({ reason: 'spam', reasonText: `${FA_HARASS} Again.`, note: 'second time' });
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('suspends only with an end, and maps an end the API refuses', async () => {
    let calls = 0;
    const fake = api({
      [`POST /v1/admin/users/${SARA}/suspend`]: () => {
        calls += 1;
        return calls === 1 ? problem(422, 'field_invalid', { errors: [{ in: 'body', pointer: '/endsAt', code: 'ends_in_past', message: 'x' }] }) : result();
      },
    });
    renderPanel(`/users/${SARA}`, fake);
    const { user, dialog } = await open('Suspend');
    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'spam');
    await user.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    expect(within(dialog).getByText('Choose when it ends.')).toBeTruthy();
    expect(fake.of(`POST /v1/admin/users/${SARA}/suspend`)).toHaveLength(0);
    await user.selectOptions(within(dialog).getByLabelText('Until'), '3d');
    await user.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    expect(await within(dialog).findByText('Choose a later date.')).toBeTruthy();
    const body = fake.of(`POST /v1/admin/users/${SARA}/suspend`)[0]?.body as { endsAt: string; reasonText: string };
    expect(Math.abs(Date.parse(body.endsAt) - (Date.now() + 3 * 86_400_000))).toBeLessThan(60_000);
    expect(body.reasonText).toBe(FA_SPAM);
  });

  it('shadowbans without a message, and says when the app side was late', async () => {
    const fake = api({ [`POST /v1/admin/users/${SARA}/shadowban`]: () => result('failed') });
    renderPanel(`/users/${SARA}`, fake);
    const { user, dialog } = await open('Shadowban');
    expect(within(dialog).queryByLabelText(/Message to/)).toBeNull();
    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'fake');
    await user.click(within(dialog).getByRole('button', { name: 'Shadowban' }));
    await waitFor(() => expect(fake.of(`POST /v1/admin/users/${SARA}/shadowban`)[0]?.body).toEqual({ reason: 'fake' }));
    expect(await screen.findByText('Saved. Some updates in the app will be late.')).toBeTruthy();
  });

  it('bans and, when asked, bans the phone and devices too, for the same period', async () => {
    signInAs(adminWith([...ADMIN, 'moderation.device_bans'], ['admin']));
    const fake = api({
      [`POST /v1/admin/users/${SARA}/ban`]: () => result(),
      'POST /v1/admin/device-bans': () => [201, { items: [] }],
    });
    renderPanel(`/users/${SARA}`, fake);
    const { user, dialog } = await open('Ban');
    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'spam');
    await user.selectOptions(within(dialog).getByLabelText('Until'), '30d');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Also ban phone, devices and Google account' }));
    expect(fake.of('POST /v1/admin/device-bans')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Ban' }));
    await waitFor(() => expect(fake.of('POST /v1/admin/device-bans')).toHaveLength(1));
    const ban = fake.of(`POST /v1/admin/users/${SARA}/ban`)[0]?.body as { endsAt: string };
    // Tied to the ban: lifting it or overturning its appeal removes them.
    expect(fake.of('POST /v1/admin/device-bans')[0]?.body).toEqual({ from: 'user', user: SARA, kinds: ['device', 'phone', 'google'], reason: 'moderation:spam', expiresAt: ban.endsAt, forAction: '60' });
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('offers the phone and devices only to a role that may ban them, and only for a ban', async () => {
    const fake = api();
    renderPanel(`/users/${SARA}`, fake);
    const { dialog } = await open('Ban');
    expect(within(dialog).queryByRole('checkbox', { name: 'Also ban phone, devices and Google account' })).toBeNull();
  });

  it('lifts a standing action', async () => {
    const fake = api({ [`POST /v1/admin/users/${SARA}/lift`]: () => result() });
    renderPanel(`/users/${SARA}`, fake);
    const { user, dialog } = await open('Lift…');
    await user.click(within(dialog).getByRole('button', { name: 'Lift' }));
    await waitFor(() => expect(fake.of(`POST /v1/admin/users/${SARA}/lift`)[0]?.body).toEqual({ actionId: '51' }));
  });

  it('signs out everywhere and deletes after a question, with the note', async () => {
    const fake = api({
      [`POST /v1/admin/users/${SARA}/revoke-sessions`]: () => ({ sessions: 2, sideEffects: 'done' }),
      [`POST /v1/admin/users/${SARA}/delete`]: () => ({ user: detail({ status: 'deleted' }), purgeAt: '2026-12-26T10:00:00.000Z', sideEffects: 'done' }),
    });
    renderPanel(`/users/${SARA}`, fake);
    let { user, dialog } = await open('Sign out everywhere');
    await user.type(within(dialog).getByLabelText(/Internal note/), 'lost phone');
    expect(fake.of(`POST /v1/admin/users/${SARA}/revoke-sessions`)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() => expect(fake.of(`POST /v1/admin/users/${SARA}/revoke-sessions`)[0]?.body).toEqual({ note: 'lost phone' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    ({ user, dialog } = await open('Delete account'));
    await user.click(within(dialog).getByRole('button', { name: 'Delete account' }));
    await waitFor(() => expect(fake.of(`POST /v1/admin/users/${SARA}/delete`)[0]?.body).toEqual({}));
  });

  it('renames with a reason and the profile version; a refused name and a stale profile have their words', async () => {
    let calls = 0;
    const fake = api({
      [`PATCH /v1/admin/users/${SARA}/profile`]: () => {
        calls += 1;
        return calls === 1 ? problem(422, 'field_invalid', { errors: [{ in: 'body', pointer: '/displayName', code: 'name_refused', message: 'x' }] }) : problem(409, 'conflict', { detail: 'The profile changed; reload it.', reason: 'stale' });
      },
    });
    renderPanel(`/users/${SARA}`, fake);
    const { user, dialog } = await open('Rename');
    const field = within(dialog).getByLabelText('Display name');
    await user.clear(field);
    await user.type(field, 'Sara');
    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'offensive');
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(await within(dialog).findByText('This name is not allowed.')).toBeTruthy();
    expect(fake.of(`PATCH /v1/admin/users/${SARA}/profile`)[0]?.body).toEqual({ displayName: 'Sara', reason: 'offensive', version: 12 });
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(await screen.findByText('The profile changed. It was reloaded.')).toBeTruthy();
  });
});

describe('action dialogs: review fixes', () => {
  it('drops the message’s “required” once a chosen reason fills it', async () => {
    renderPanel(`/users/${SARA}`, api());
    const { user, dialog } = await open('Warn');
    await user.click(within(dialog).getByRole('button', { name: 'Warn' }));
    expect(within(dialog).getAllByText('Required.')).toHaveLength(2);
    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'spam');
    const message = within(dialog).getByLabelText<HTMLTextAreaElement>(/Message to Sara Ahmadi/);
    await waitFor(() => expect(message.value).toBe(FA_SPAM));
    expect(within(dialog).queryByText('Required.')).toBeNull();
    expect(message.getAttribute('aria-invalid')).toBe('false');
    // The person's language by its name, not its code.
    expect(within(dialog).getByText('Persian')).toBeTruthy();
  });

  it('puts a missing or past date on the date field, and shows the end in the panel’s calendar', async () => {
    renderPanel(`/users/${SARA}`, api());
    const { user, dialog } = await open('Suspend');
    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'spam');
    await user.selectOptions(within(dialog).getByLabelText('Until'), 'date');
    await user.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    const date = within(dialog).getByLabelText<HTMLInputElement>('Date');
    expect(date.getAttribute('aria-invalid')).toBe('true');
    expect(within(dialog).getByText('Choose a date.')).toBeTruthy();
    expect(within(dialog).getByLabelText('Until').getAttribute('aria-invalid')).toBe('false');
    fireEvent.change(date, { target: { value: '2020-01-01' } });
    await user.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    expect(within(dialog).getByText('Choose a later date.')).toBeTruthy();
    expect(date.getAttribute('aria-invalid')).toBe('true');
    const later = new Date(Date.now() + 10 * 86_400_000);
    const day = `${later.getFullYear()}-${String(later.getMonth() + 1).padStart(2, '0')}-${String(later.getDate()).padStart(2, '0')}`;
    fireEvent.change(date, { target: { value: day } });
    expect(within(dialog).queryByText('Choose a later date.')).toBeNull();
    expect(within(dialog).getByText(/^Until /)).toBeTruthy();
  });

  it('calls the lift’s text an internal note: no message to the person, whatever stands', async () => {
    const fake = api({
      [`GET /v1/admin/users/${SARA}`]: () => detail({ shadowbanned: true, standing: [action('52', { kind: 'shadowban', reasonText: 'Shadowban.' })] }),
      [`POST /v1/admin/users/${SARA}/lift`]: () => result(),
    });
    renderPanel(`/users/${SARA}`, fake);
    const { user, dialog } = await open('Lift…');
    expect(within(dialog).queryByLabelText(/Message to/)).toBeNull();
    const note = within(dialog).getByLabelText<HTMLTextAreaElement>(/Internal note/);
    expect(note.getAttribute('lang')).toBeNull();
    await user.type(note, 'flagged by mistake');
    await user.click(within(dialog).getByRole('button', { name: 'Lift' }));
    await waitFor(() => expect(fake.of(`POST /v1/admin/users/${SARA}/lift`)[0]?.body).toEqual({ actionId: '52', reasonText: 'flagged by mistake' }));
  });

  it('starts the sign-out and delete questions with an empty note: a cancelled note is never sent', async () => {
    const fake = api({ [`POST /v1/admin/users/${SARA}/delete`]: () => ({ user: detail({ status: 'deleted' }), purgeAt: '2026-12-26T10:00:00.000Z', sideEffects: 'done' }) });
    renderPanel(`/users/${SARA}`, fake);
    let { user, dialog } = await open('Sign out everywhere');
    await user.type(within(dialog).getByLabelText(/Internal note/), 'about the person');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    ({ user, dialog } = await open('Delete account'));
    expect(within(dialog).getByLabelText<HTMLTextAreaElement>(/Internal note/).value).toBe('');
    await user.click(within(dialog).getByRole('button', { name: 'Delete account' }));
    await waitFor(() => expect(fake.of(`POST /v1/admin/users/${SARA}/delete`)[0]?.body).toEqual({}));
  });

  it('offers a deleted account no sign-out and no rename, and says until when it can be restored', async () => {
    renderPanel(
      `/users/${SARA}`,
      api({ [`GET /v1/admin/users/${SARA}`]: () => detail({ status: 'deleted', deletedAt: '2026-11-26T10:00:00.000Z', purgeAt: '2026-12-26T10:00:00.000Z' }) }),
    );
    await screen.findByRole('heading', { name: /Sara Ahmadi/ });
    expect(screen.getByText(/^Restorable until /)).toBeTruthy();
    expect(screen.queryByText(/Deleted · /)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions' })).toBeNull();
  });
});

describe('text decisions', () => {
  it('approves the waiting texts with the profile version', async () => {
    const fake = api({ [`POST /v1/admin/moderation/texts/${SARA}/approve`]: () => ({ texts: {}, sideEffects: 'done' }) });
    const user = userEvent.setup();
    renderPanel(`/users/${SARA}`, fake);
    await user.click(await screen.findByRole('button', { name: 'Approve texts' }));
    await waitFor(() => expect(fake.of(`POST /v1/admin/moderation/texts/${SARA}/approve`)[0]?.body).toEqual({ version: 12 }));
    expect(await screen.findByText('Approved.')).toBeTruthy();
  });

  it('rejects with the keys: 2 chooses the second reason, Enter sends the parts that wait', async () => {
    const fake = api({ [`POST /v1/admin/moderation/texts/${SARA}/reject`]: () => ({ texts: {}, sideEffects: 'done' }) });
    const user = userEvent.setup();
    renderPanel(`/users/${SARA}`, fake);
    await user.click(await screen.findByRole('button', { name: 'Reject texts' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('checkbox', { name: 'About and job' })).toHaveProperty('checked', true);
    // Each answer is named by its question, as on the profile tab.
    expect(within(dialog).getByRole('checkbox', { name: 'A good day' })).toHaveProperty('checked', true);
    expect(within(dialog).getByRole('checkbox', { name: 'My travel' })).toHaveProperty('checked', false);
    fireEvent.keyDown(window, { code: 'Digit2', key: '2' });
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: /Offensive language/ })).toHaveProperty('checked', true));
    expect(fake.of(`POST /v1/admin/moderation/texts/${SARA}/reject`)).toHaveLength(0);
    fireEvent.keyDown(window, { code: 'Enter', key: 'Enter' });
    await waitFor(() => expect(fake.of(`POST /v1/admin/moderation/texts/${SARA}/reject`)[0]?.body).toEqual({ version: 12, reason: 'offensive', profile: true, prompts: [0] }));
    expect(await screen.findByText('Rejected.')).toBeTruthy();
  });

  it('says the profile changed on a stale version, and reloads it', async () => {
    const fake = api({ [`POST /v1/admin/moderation/texts/${SARA}/reject`]: () => problem(409, 'conflict', { detail: 'The profile changed; reload it.', reason: 'stale' }) });
    const user = userEvent.setup();
    renderPanel(`/users/${SARA}`, fake);
    await user.click(await screen.findByRole('button', { name: 'Reject texts' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: /Sexual content/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('The profile changed. It was reloaded.')).toBeTruthy();
    await waitFor(() => expect(fake.of(`GET /v1/admin/users/${SARA}`).length).toBeGreaterThan(1));
  });

  it('Enter on Cancel, on the close button or on a part backs out or toggles: it never sends the rejection', async () => {
    const fake = api({ [`POST /v1/admin/moderation/texts/${SARA}/reject`]: () => ({ texts: {}, sideEffects: 'done' }) });
    const user = userEvent.setup();
    renderPanel(`/users/${SARA}`, fake);
    for (const control of ['Cancel', 'Close']) {
      await user.click(await screen.findByRole('button', { name: 'Reject texts' }));
      const dialog = await screen.findByRole('dialog');
      await user.keyboard('3');
      await waitFor(() => expect(within(dialog).getByRole('radio', { name: /Sexual content/ })).toHaveProperty('checked', true));
      within(dialog).getByRole('button', { name: control }).focus();
      await user.keyboard('{Enter}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
    await user.click(await screen.findByRole('button', { name: 'Reject texts' }));
    const dialog = await screen.findByRole('dialog');
    await user.keyboard('3');
    const part = within(dialog).getByRole('checkbox', { name: 'About and job' });
    part.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(fake.of(`POST /v1/admin/moderation/texts/${SARA}/reject`)).toHaveLength(0);
    // From the chosen reason itself, Enter still sends.
    within(dialog).getByRole('radio', { name: /Sexual content/ }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(fake.of(`POST /v1/admin/moderation/texts/${SARA}/reject`)).toHaveLength(1));
  });

  it('moves the focus to the reason a digit chooses, so one option looks chosen', async () => {
    const user = userEvent.setup();
    renderPanel(`/users/${SARA}`, api());
    await user.click(await screen.findByRole('button', { name: 'Reject texts' }));
    const dialog = await screen.findByRole('dialog');
    await user.keyboard('4');
    const chosen = within(dialog).getAllByRole('radio').find((radio) => (radio as HTMLInputElement).checked);
    expect(chosen).toBeTruthy();
    expect(document.activeElement).toBe(chosen);
  });

  it('says there are no texts, and offers no decision, when the profile has none', async () => {
    signInAs(fullAdmin);
    const empty = detail();
    renderPanel(`/users/${SARA}`, api({ [`GET /v1/admin/users/${SARA}`]: () => ({ ...empty, profile: { ...empty.profile!, about: null, job: null, prompts: [] } }) }));
    expect(await screen.findByText('No texts.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reject texts' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve texts' })).toBeNull();
  });
});
