import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminWith, fakeApi, problem, renderPanel, resetPanel, signInAs } from './panel';
import { hold, moderator, page } from './moderationFixtures';

beforeEach(() => {
  resetPanel();
  signInAs(moderator);
});

function holdsApi(extra: Record<string, () => unknown> = {}) {
  return fakeApi({
    'GET /v1/admin/holds': (call) =>
      call.query['state'] === 'released'
        ? page([hold('72', { kind: 'threat', releasedAt: '2026-11-25T10:00:00.000Z', releasedBy: { id: '4', displayName: 'Rana Releaser' }, releasedReason: 'The case was closed.' })])
        : page([
            hold('71', { kind: 'child_safety', user: null, conversationId: '5001', createdBy: null, authorityRef: null, filing: { authority: 'ncmec', externalRef: 'CT-1234', filedAt: '2026-11-25T09:00:00.000Z', filedBy: null } }),
            hold('70'),
          ]),
    'POST /v1/admin/holds/70/release': () => hold('70', { releasedAt: '2026-11-25T12:00:00.000Z' }),
    'POST /v1/admin/holds': () => [201, hold('73')],
    ...extra,
  });
}

describe('the holds page', () => {
  it('lists the active holds: what each keeps, who placed it, the case and the filing', async () => {
    const api = holdsApi();
    renderPanel('/moderation/holds', api);
    expect(await screen.findByRole('heading', { name: 'Legal holds' })).toBeTruthy();
    const rows = (await screen.findAllByRole('row')).slice(1);
    expect(within(rows[0]!).getByText('Child safety')).toBeTruthy();
    expect(within(rows[0]!).getByText('5001')).toBeTruthy();
    expect(within(rows[0]!).getByText('Automatic')).toBeTruthy();
    expect(within(rows[0]!).getByText('CT-1234')).toBeTruthy();
    expect(within(rows[1]!).getByText('Held Person')).toBeTruthy();
    expect(within(rows[1]!).getByText('REQ-7')).toBeTruthy();
    expect(within(rows[1]!).getByRole('link', { name: '900' }).getAttribute('href')).toBe('/moderation/reports/900');
    expect(api.of('GET /v1/admin/holds')[0]?.query).toMatchObject({ state: 'active', limit: '25' });
  });

  it('shows the released ones with when, by whom and why', async () => {
    const { router } = renderPanel('/moderation/holds', holdsApi());
    await screen.findByText('Held Person');
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Released' }));
    // Once in its column, once under the subject for a phone (one of the two is hidden by width).
    expect(await screen.findAllByText('The case was closed.')).toHaveLength(2);
    expect(screen.getAllByText(/Rana Releaser/)).toHaveLength(2);
    expect(router.state.location.search).toBe('?state=released');
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
  });

  it('releases a hold only with a reason', async () => {
    const api = holdsApi();
    const user = userEvent.setup();
    renderPanel('/moderation/holds', api);
    await screen.findByText('Held Person');
    const row = screen.getByText('Held Person').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Actions for Authority request · Held Person' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Release' }));
    const dialog = await screen.findByRole('dialog', { name: 'Release the hold on Held Person' });
    // What it releases: the kind, the person, the report and the case; the confirm is destructive.
    expect(within(dialog).getByText('Authority request')).toBeTruthy();
    expect(within(dialog).getByText('Held Person')).toBeTruthy();
    expect(within(dialog).getByText('900')).toBeTruthy();
    expect(within(dialog).getByText('REQ-7')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Release' }).className).toContain('bg-destructive');
    await user.click(within(dialog).getByRole('button', { name: 'Release' }));
    expect(await within(dialog).findByText('Required.')).toBeTruthy();
    expect(api.of('POST /v1/admin/holds/70/release')).toHaveLength(0);
    await user.type(within(dialog).getByLabelText('Reason'), '  The request was withdrawn. ');
    await user.click(within(dialog).getByRole('button', { name: 'Release' }));
    await waitFor(() => expect(api.of('POST /v1/admin/holds/70/release')).toHaveLength(1));
    expect(api.of('POST /v1/admin/holds/70/release')[0]?.body).toEqual({ reason: 'The request was withdrawn.' });
    expect(await screen.findByText('Released.')).toBeTruthy();
  });

  it('names each hold’s menu and its release by the conversation when it keeps one', async () => {
    const user = userEvent.setup();
    renderPanel('/moderation/holds', holdsApi());
    await user.click(await screen.findByRole('button', { name: 'Actions for Child safety · Conversation 5001' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Release' }));
    const dialog = await screen.findByRole('dialog', { name: 'Release the hold on conversation 5001' });
    expect(within(dialog).getByText('NCMEC CyberTipline')).toBeTruthy();
    expect(within(dialog).getByText('CT-1234')).toBeTruthy();
  });

  it('writes a case number as free text: in its own direction and the text’s font, typed the same way', async () => {
    const user = userEvent.setup();
    const ref = 'پرونده ۱۴۰۵/۸۷۲۳۱-ب';
    renderPanel(
      '/moderation/holds',
      holdsApi({ 'GET /v1/admin/holds': () => page([hold('70', { authorityRef: ref, filing: { authority: 'police', externalRef: ref, filedAt: '2026-11-25T09:00:00.000Z', filedBy: null } })]) }),
    );
    const shown = await screen.findAllByText(ref);
    for (const node of shown) {
      expect(node.tagName).toBe('BDI');
      expect(node.getAttribute('dir')).toBe('auto');
      expect(node.className).not.toContain('font-mono');
    }
    await user.click(screen.getByRole('button', { name: 'New hold' }));
    const dialog = await screen.findByRole('dialog', { name: 'New hold' });
    expect(within(dialog).getByLabelText(/Case number/).getAttribute('dir')).toBe('auto');
  });

  it('places a new hold with the fields given, and nothing without a kind and a target', async () => {
    const api = holdsApi();
    const user = userEvent.setup();
    renderPanel('/moderation/holds', api);
    await screen.findByText('Held Person');
    await user.click(screen.getByRole('button', { name: 'New hold' }));
    const dialog = await screen.findByRole('dialog', { name: 'New hold' });
    await user.click(within(dialog).getByRole('button', { name: 'Place hold' }));
    expect(await within(dialog).findByText('Required.')).toBeTruthy();
    expect(within(dialog).getByText('Enter a person or a conversation.')).toBeTruthy();
    expect(api.of('POST /v1/admin/holds')).toHaveLength(0);
    await user.selectOptions(within(dialog).getByLabelText('Kind'), 'authority');
    await user.type(within(dialog).getByLabelText('Person ID'), 'AB12CD34EF56G');
    await user.type(within(dialog).getByLabelText(/Case number/), 'REQ-9');
    await user.click(within(dialog).getByRole('button', { name: 'Place hold' }));
    await waitFor(() => expect(api.of('POST /v1/admin/holds')).toHaveLength(1));
    expect(api.of('POST /v1/admin/holds')[0]?.body).toEqual({ kind: 'authority', user: 'AB12CD34EF56G', authorityRef: 'REQ-9' });
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('puts the API’s refusal on the field it names', async () => {
    const api = holdsApi({
      'POST /v1/admin/holds': () => problem(422, 'validation_failed', { errors: [{ pointer: '/user', code: 'unknown_user', message: 'No such user.' }] }),
    });
    const user = userEvent.setup();
    renderPanel('/moderation/holds', api);
    await screen.findByText('Held Person');
    await user.click(screen.getByRole('button', { name: 'New hold' }));
    const dialog = await screen.findByRole('dialog', { name: 'New hold' });
    await user.selectOptions(within(dialog).getByLabelText('Kind'), 'threat');
    await user.type(within(dialog).getByLabelText('Person ID'), 'ZZZZZZZZZZZZZ');
    await user.click(within(dialog).getByRole('button', { name: 'Place hold' }));
    expect(await within(dialog).findByText('No such person.')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'New hold' })).toBeTruthy();
  });

  it('is closed to a role without reports.hold, with no request', async () => {
    signInAs(adminWith(['users.read', 'reports.read'], ['support']));
    const api = holdsApi();
    renderPanel('/moderation/holds', api);
    expect(await screen.findByText('No access')).toBeTruthy();
    expect(api.of('GET /v1/admin/holds')).toHaveLength(0);
  });

  it('is right to left in Persian', async () => {
    renderPanel('/moderation/holds', holdsApi(), { locale: 'fa' });
    expect(await screen.findByRole('heading', { name: 'نگه‌داری قانونی' })).toBeTruthy();
    expect(document.documentElement.dir).toBe('rtl');
    expect(await screen.findByRole('button', { name: 'نگه‌داری جدید' })).toBeTruthy();
  });
});
