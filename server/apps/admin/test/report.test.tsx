import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeApi, problem, renderPanel, resetPanel, signInAs } from './panel';
import { hold, moderator, reader, reportDetail, reportSummary } from './moderationFixtures';
import { detail, reasons } from './userFixtures';

beforeEach(() => {
  resetPanel();
  signInAs(moderator);
});

const ID = '301';

function reportApi(extra: Record<string, (call: { body: unknown }) => unknown> = {}, overrides: Parameters<typeof reportDetail>[1] = {}) {
  const reported = reportDetail(ID).reported;
  return fakeApi({
    [`GET /v1/admin/reports/${ID}`]: () => reportDetail(ID, overrides),
    [`POST /v1/admin/reports/${ID}/evidence`]: () => ({
      evidenceAt: '2026-11-25T09:01:00.000Z',
      chat: [
        {
          filingId: ID,
          conversationId: '5001',
          takenAt: '2026-11-25T09:01:00.000Z',
          messages: [
            { id: '1', from: 'reported', kind: 'text', flags: ['risky'], body: 'Answer me now', at: '2026-11-25T08:50:00.000Z', late: false, named: true },
            { id: '2', from: 'reporter', kind: 'text', flags: [], body: 'Please stop', at: '2026-11-25T08:51:00.000Z', late: false, named: false },
            { id: '3', from: 'reported', kind: 'image', flags: [], body: null, at: '2026-11-25T08:52:00.000Z', late: true, named: false },
          ],
          requests: [],
        },
      ],
    }),
    [`POST /v1/admin/reports/${ID}/assign`]: () => reportSummary(ID, { status: 'in_review', assignee: { id: moderator.id, displayName: moderator.displayName } }),
    [`POST /v1/admin/reports/${ID}/resolve`]: () => ({ items: [reportSummary(ID, { status: 'actioned', resolution: 'warning', resolvedAt: '2026-11-25T12:00:00.000Z' })] }),
    [`POST /v1/admin/reports/${ID}/dismiss`]: () => ({ items: [reportSummary(ID, { status: 'dismissed', resolution: 'no_violation' }), reportSummary('302', { status: 'dismissed' })] }),
    [`POST /v1/admin/reports/${ID}/hold-and-file`]: () => ({ filing: { authority: 'police', externalRef: 'CASE-9', filedAt: '2026-11-25T12:00:00.000Z', filedBy: null }, holds: [] }),
    [`GET /v1/admin/users/${reported.id}`]: () => detail({ id: reported.id, name: reported.name, locale: 'en' }),
    'GET /v1/admin/moderation/reasons': () => reasons,
    [`POST /v1/admin/users/${reported.id}/warn`]: () => ({ user: detail({ id: reported.id }), action: { id: '81', kind: 'warning' }, sideEffects: 'done' }),
    ...extra,
  });
}

describe('the report page', () => {
  it('shows the report, its filing and the profile as it was, and no chat until asked', async () => {
    const api = reportApi();
    renderPanel(`/moderation/reports/${ID}`, api);
    expect(await screen.findByRole('heading', { name: 'Harassment' })).toBeTruthy();
    expect(screen.getAllByText('They kept writing after I asked them to stop.').length).toBeGreaterThan(0);
    expect(screen.getByText('Hello there')).toBeTruthy();
    expect(screen.getByText('2 messages named')).toBeTruthy();
    expect(screen.queryByText('Please stop')).toBeNull();
    expect(api.of(`POST /v1/admin/reports/${ID}/evidence`)).toHaveLength(0);
  });

  it('shows the chat on request, through the audited view, each side where it belongs', async () => {
    const api = reportApi();
    renderPanel(`/moderation/reports/${ID}`, api);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Show chat' }));
    expect(await screen.findByText('Please stop')).toBeTruthy();
    expect(api.of(`POST /v1/admin/reports/${ID}/evidence`)).toHaveLength(1);
    const mine = screen.getByText('Answer me now').closest('li');
    const theirs = screen.getByText('Please stop').closest('li');
    expect(mine?.className).toContain('justify-end');
    expect(theirs?.className).toContain('justify-start');
    expect(within(mine!).getByText('Reported')).toBeTruthy();
    expect(within(mine!).getByText('Flagged')).toBeTruthy();
    // The message the filing named is marked; the others are not.
    expect(within(mine!).getByText('Named')).toBeTruthy();
    expect(within(theirs!).queryByText('Named')).toBeNull();
    expect(screen.getByText('Image')).toBeTruthy();
    expect(screen.getByText(/copied late/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show chat' })).toBeNull();
  });

  it('hides the chat button from a role without reports.view_chat, and the writes from a reader', async () => {
    signInAs(reader);
    renderPanel(`/moderation/reports/${ID}`, reportApi());
    await screen.findByRole('heading', { name: 'Harassment' });
    expect(screen.queryByRole('button', { name: 'Show chat' })).toBeNull();
    expect(screen.getByText('Your role cannot view chats.')).toBeTruthy();
    for (const name of ['Assign to me', 'Close with action', 'Close without action', 'Hold and report', 'Warn']) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('assigns the report to the admin, as they saw it, and reads it again for its history', async () => {
    const me = { id: moderator.id, displayName: moderator.displayName };
    let assigned = false;
    const api = reportApi({
      [`GET /v1/admin/reports/${ID}`]: () =>
        assigned
          ? reportDetail(ID, { status: 'in_review', assignee: me, history: [{ id: '91', at: '2026-11-25T12:00:00.000Z', admin: me, action: 'report.assign' }] })
          : reportDetail(ID),
      [`POST /v1/admin/reports/${ID}/assign`]: () => {
        assigned = true;
        return reportSummary(ID, { status: 'in_review', assignee: me });
      },
    });
    renderPanel(`/moderation/reports/${ID}`, api);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Assign to me' }));
    await waitFor(() => expect(api.of(`POST /v1/admin/reports/${ID}/assign`)).toHaveLength(1));
    expect(api.of(`POST /v1/admin/reports/${ID}/assign`)[0]?.body).toEqual({ to: moderator.id, from: null });
    expect(await screen.findByRole('button', { name: 'Unassign' })).toBeTruthy();
    // The write's own line shows up without a reload.
    expect(await screen.findByText('Assignment changed')).toBeTruthy();
    expect(api.of(`GET /v1/admin/reports/${ID}`).length).toBeGreaterThan(1);
  });

  it('lists its history by name, consecutive chat views of one admin as one line, an unknown action as its code', async () => {
    const mina = { id: '3', displayName: 'Mina' };
    const omid = { id: '4', displayName: 'Omid' };
    const at = '2026-11-25T12:00:00.000Z';
    const history = [
      { id: '96', at, admin: mina, action: 'report.resolve' },
      { id: '95', at, admin: mina, action: 'report.view_chat' },
      { id: '94', at, admin: mina, action: 'report.view_chat' },
      { id: '93', at, admin: mina, action: 'report.view_chat' },
      { id: '92', at, admin: omid, action: 'report.view_chat' },
      { id: '91', at, admin: null, action: 'report.future_thing' },
    ];
    renderPanel(`/moderation/reports/${ID}`, reportApi({}, { history }));
    const card = (await screen.findByRole('heading', { name: 'History' })).closest('section')!;
    const lines = within(card).getAllByRole('listitem').map((li) => li.textContent);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('Closed with action');
    expect(lines[1]).toContain('Chat viewed ×3');
    expect(lines[1]).toContain('Mina');
    expect(lines[2]).toContain('Chat viewed');
    expect(lines[2]).not.toContain('×');
    expect(within(card).getByText('report.future_thing').tagName).toBe('BDI');
  });

  it('shows its own id and its conversation’s, each copied with a click, and places a hold started from the report', async () => {
    const api = reportApi({ 'POST /v1/admin/holds': () => [201, hold('73', { reportId: ID })] });
    const user = userEvent.setup();
    renderPanel(`/moderation/reports/${ID}`, api);
    expect(await screen.findByRole('button', { name: `Copy ID ${ID}` })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy ID 5001' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'New hold' }));
    const dialog = await screen.findByRole('dialog', { name: 'New hold' });
    const reported = reportDetail(ID).reported;
    expect(within(dialog).getByLabelText<HTMLInputElement>('Person ID').value).toBe(reported.id);
    expect(within(dialog).getByLabelText<HTMLInputElement>('Conversation ID').value).toBe('5001');
    expect(within(dialog).getByLabelText<HTMLInputElement>(/Report ID/).value).toBe(ID);
    expect(within(dialog).getByLabelText<HTMLSelectElement>('Kind').value).toBe('authority');
    await user.click(within(dialog).getByRole('button', { name: 'Place hold' }));
    await waitFor(() => expect(api.of('POST /v1/admin/holds')).toHaveLength(1));
    expect(api.of('POST /v1/admin/holds')[0]?.body).toEqual({ kind: 'authority', user: reported.id, conversationId: '5001', reportId: ID });
  });

  it('keeps Hold and report a secondary action unless the report is about child safety or a threat', async () => {
    renderPanel(`/moderation/reports/${ID}`, reportApi());
    const plain = await screen.findByRole('button', { name: 'Hold and report' });
    expect(plain.className).not.toContain('bg-destructive');
    expect(plain.className).toContain('text-destructive');
  });

  it('makes Hold and report the strong action on a threat', async () => {
    renderPanel(`/moderation/reports/${ID}`, reportApi({}, { reason: 'threat' }));
    expect((await screen.findByRole('button', { name: 'Hold and report' })).className).toContain('bg-destructive');
  });

  it('shows the whole name of the people in it, and the same hold colours as the holds page', async () => {
    const long = 'عبدالرضا میرزاحسینی اصفهانی‌نژاد فرد';
    renderPanel(`/moderation/reports/${ID}`, reportApi({}, { reported: { id: reportDetail(ID).reported.id, name: long, status: 'active' }, holds: [hold('70')] }));
    const card = (await screen.findByRole('heading', { name: 'Reported' })).closest('section')!;
    const name = within(card).getByText(long);
    expect(name.className).not.toContain('truncate');
    expect(within(screen.getByRole('heading', { name: 'Holds and filing' }).closest('section')!).getByText('Authority request').className).toContain('bg-secondary');
  });

  it('says someone else took it', async () => {
    const api = reportApi({ [`POST /v1/admin/reports/${ID}/assign`]: () => problem(409, 'conflict', { detail: 'Someone else took it.', reason: 'taken' }) });
    renderPanel(`/moderation/reports/${ID}`, api);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Assign to me' }));
    expect(await screen.findByText('Someone else took it.')).toBeTruthy();
  });

  it('closes without action: nothing sent before confirming, then the exact body', async () => {
    const api = reportApi();
    const user = userEvent.setup();
    renderPanel(`/moderation/reports/${ID}`, api);
    await user.click(await screen.findByRole('button', { name: 'Close without action' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Close without action' }));
    expect(await within(dialog).findByText('Required.')).toBeTruthy();
    expect(api.of(`POST /v1/admin/reports/${ID}/dismiss`)).toHaveLength(0);
    await user.selectOptions(within(dialog).getByLabelText('Resolution'), 'no_violation');
    await user.type(within(dialog).getByLabelText(/Internal note/), 'Looked at the chat');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Also close this person’s other open reports for the same reason' }));
    await user.click(within(dialog).getByRole('button', { name: 'Close without action' }));
    await waitFor(() => expect(api.of(`POST /v1/admin/reports/${ID}/dismiss`)).toHaveLength(1));
    expect(api.of(`POST /v1/admin/reports/${ID}/dismiss`)[0]?.body).toEqual({ resolution: 'no_violation', note: 'Looked at the chat', sameTarget: true });
    expect(await screen.findByText('2 reports closed.')).toBeTruthy();
  });

  it('warns the reported person from the report, then offers to close it with the matching resolution', async () => {
    const api = reportApi();
    const user = userEvent.setup();
    renderPanel(`/moderation/reports/${ID}`, api);
    await user.click(await screen.findByRole('button', { name: 'Warn' }));
    const warn = await screen.findByRole('dialog');
    await user.selectOptions(within(warn).getByLabelText('Reason'), 'spam');
    await user.click(within(warn).getByRole('button', { name: 'Warn' }));
    const reported = reportDetail(ID).reported;
    await waitFor(() => expect(api.of(`POST /v1/admin/users/${reported.id}/warn`)).toHaveLength(1));
    expect(api.of(`POST /v1/admin/users/${reported.id}/warn`)[0]?.body).toMatchObject({ reason: 'spam', reportId: ID });
    const close = await screen.findByRole('dialog', { name: 'Close with action' });
    expect(within(close).getByLabelText<HTMLSelectElement>('Resolution').value).toBe('warning');
    await user.click(within(close).getByRole('button', { name: 'Close with action' }));
    await waitFor(() => expect(api.of(`POST /v1/admin/reports/${ID}/resolve`)[0]?.body).toEqual({ resolution: 'warning' }));
  });

  it('holds and reports a child-safety report, with whom to contact', async () => {
    const api = reportApi({}, { reason: 'child_safety', childSafetyContact: { name: 'Safety Desk', email: 'safety@example.com' } });
    const user = userEvent.setup();
    renderPanel(`/moderation/reports/${ID}`, api);
    await user.click(await screen.findByRole('button', { name: 'Hold and report' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Safety Desk')).toBeTruthy();
    expect(within(dialog).getByText('safety@example.com')).toBeTruthy();
    expect(within(dialog).getByLabelText<HTMLSelectElement>('Authority').value).toBe('ncmec');
    await user.type(within(dialog).getByLabelText(/Case number/), 'CT-1234');
    await user.click(within(dialog).getByRole('button', { name: 'Hold and report' }));
    await waitFor(() => expect(api.of(`POST /v1/admin/reports/${ID}/hold-and-file`)[0]?.body).toEqual({ authority: 'ncmec', externalRef: 'CT-1234' }));
    expect(await screen.findByText('Held and reported.')).toBeTruthy();
  });

  it('veils the photos of a child-safety report until the admin chooses to look', async () => {
    const filing = { ...reportDetail(ID).filings[0]!, photo: { id: '72', status: 'approved' as const, url: 'https://cdn.test/72-640.jpg' } };
    const user = userEvent.setup();
    renderPanel(`/moderation/reports/${ID}`, reportApi({}, { reason: 'child_safety', filings: [filing] }));
    const show = await screen.findByRole('button', { name: 'Show photo' });
    const img = show.parentElement!.querySelector('img')!;
    expect(img.className).toContain('blur');
    await user.click(show);
    expect(img.className).not.toContain('blur');
  });

  it('aligns the person’s words with their labels whatever their script, and the case number in its own direction', async () => {
    renderPanel(
      `/moderation/reports/${ID}`,
      reportApi({}, { filing: { authority: 'police', externalRef: 'پرونده ۱۴۰۵/۸۷۲۳۱-ب', filedAt: '2026-11-25T12:00:00.000Z', filedBy: null }, filed: true }),
    );
    const about = await screen.findByText('Hello there');
    expect(about.className).toContain('bidi-plain');
    expect(about.getAttribute('dir')).toBeNull();
    const ref = screen.getByText('پرونده ۱۴۰۵/۸۷۲۳۱-ب');
    expect(ref.tagName).toBe('BDI');
    expect(ref.getAttribute('dir')).toBe('auto');
  });

  it('shows no loading title next to an error', async () => {
    renderPanel(`/moderation/reports/${ID}`, fakeApi({ [`GET /v1/admin/reports/${ID}`]: () => problem(500, 'internal') }));
    expect(await screen.findByRole('heading', { name: 'Report' })).toBeTruthy();
    await act(async () => undefined);
    expect(document.querySelector('h1 [data-slot="skeleton"], h1 .animate-pulse')).toBeNull();
  });

  it('has no chat card for a report about a photo', async () => {
    renderPanel(`/moderation/reports/${ID}`, reportApi({}, { context: 'photo', conversationId: null, filings: [] }));
    await screen.findByRole('heading', { name: 'Harassment' });
    expect(screen.queryByRole('button', { name: 'Show chat' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Chat' })).toBeNull();
  });

  it('says there is no such report', async () => {
    renderPanel('/moderation/reports/404', fakeApi({ 'GET /v1/admin/reports/404': () => problem(404, 'not_found') }));
    expect(await screen.findByRole('heading', { name: 'No such report' })).toBeTruthy();
    // The page's own way back (the sidebar has a Reports link too).
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Reports' })).toBeTruthy();
  });

  it('takes the penalty before a report reads closed with it, and goes back to the list it came from', async () => {
    const reported = reportDetail(ID).reported;
    const api = reportApi({ [`POST /v1/admin/users/${reported.id}/ban`]: () => ({ user: detail({ id: reported.id }), action: { id: '82', kind: 'ban' }, sideEffects: 'done' }) });
    const user = userEvent.setup();
    const { router } = renderPanel('/moderation/reports?view=mine', api);
    await router.navigate(`/moderation/reports/${ID}`, { state: { from: '?view=mine' } });
    // The back link keeps the view the report was opened from.
    await screen.findByRole('button', { name: 'Close with action' });
    expect(screen.getAllByRole('link', { name: 'Reports' }).map((link) => link.getAttribute('href'))).toContain('/moderation/reports?view=mine');
    await user.click(await screen.findByRole('button', { name: 'Close with action' }));
    const close = await screen.findByRole('dialog');
    await user.selectOptions(within(close).getByLabelText('Resolution'), 'ban');
    // Choosing "Ban" hands over to the ban itself: nothing is closed yet.
    await user.click(within(close).getByRole('button', { name: 'Continue' }));
    const ban = await screen.findByRole('dialog', { name: /^Ban / });
    expect(api.of(`POST /v1/admin/reports/${ID}/resolve`)).toHaveLength(0);
    // The report's own reason starts the person's message.
    expect(within(ban).getByLabelText<HTMLSelectElement>('Reason').value).toBe('harassment');
    await user.click(within(ban).getByRole('button', { name: 'Ban' }));
    await waitFor(() => expect(api.of(`POST /v1/admin/users/${reported.id}/ban`)).toHaveLength(1));
    expect(api.of(`POST /v1/admin/users/${reported.id}/ban`)[0]?.body).toMatchObject({ reason: 'harassment', reportId: ID });
    const again = await screen.findByRole('dialog', { name: 'Close with action' });
    expect(within(again).getByLabelText<HTMLSelectElement>('Resolution').value).toBe('ban');
    await user.click(within(again).getByRole('button', { name: 'Close with action' }));
    await waitFor(() => expect(api.of(`POST /v1/admin/reports/${ID}/resolve`)[0]?.body).toEqual({ resolution: 'ban' }));
    await waitFor(() => expect(`${router.state.location.pathname}${router.state.location.search}`).toBe('/moderation/reports?view=mine'));
  });
});
