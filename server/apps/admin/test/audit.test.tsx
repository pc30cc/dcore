import type { AuditEntry } from '@app/shared';
import { messages } from '../src/i18n/messages';
import { translate } from '../src/i18n/translate';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REVOKE_AFTER_MS, saveBlob } from '../src/lib/download';
import { page } from './moderationFixtures';
import { adminWith, fakeApi, problem, renderPanel, resetPanel, signInAs, wholeText } from './panel';

const auditor = adminWith(['audit.read', 'users.read'], ['admin']);

function entry(id: string, overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id,
    at: '2026-11-24T09:30:00.000Z',
    admin: { id: '4', displayName: 'Mina Mod' },
    action: 'user.ban',
    targetType: 'user',
    targetRef: null,
    user: 'userbaaaaaaaa',
    ip: '203.0.113.9',
    detail: { reason: 'scam', reasonText: 'متن پیام' },
    ...overrides,
  };
}

function auditApi(extra: Record<string, Parameters<typeof fakeApi>[0][string]> = {}) {
  return fakeApi({
    'GET /v1/admin/audit': (call) =>
      call.query['cursor']
        ? page([entry('1', { action: 'plan.update', targetType: 'plan', targetRef: '3', user: undefined, detail: null })])
        : page([entry('3'), entry('2', { action: 'hold.create', targetType: 'legal_hold', targetRef: '777', user: undefined, admin: null, ip: null })], 'c1'),
    'GET /v1/admin/audit/admins': () => ({
      items: [
        { id: '4', displayName: 'Mina Mod', disabled: false },
        { id: '5', displayName: 'Old Hand', disabled: true },
      ],
    }),
    ...extra,
  });
}

beforeEach(() => {
  resetPanel();
  signInAs(auditor);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the audit log page', () => {
  it('lists who did what to what, when and from where; the detail opens on demand; Load more sends the cursor', async () => {
    const api = auditApi();
    const user = userEvent.setup();
    renderPanel('/system/audit', api);
    expect(await screen.findByRole('heading', { name: 'Audit log' })).toBeTruthy();
    const rows = (await screen.findAllByRole('row')).slice(1);
    expect(within(rows[0]!).getByText('user.ban')).toBeTruthy();
    expect(within(rows[0]!).getByText('Mina Mod')).toBeTruthy();
    expect(within(rows[0]!).getByRole('link', { name: 'userbaaaaaaaa' }).getAttribute('href')).toBe('/users/userbaaaaaaaa');
    expect(within(rows[0]!).getByText('203.0.113.9')).toBeTruthy();
    expect(within(rows[1]!).getByText('System')).toBeTruthy();
    expect(within(rows[1]!).getByRole('link', { name: '777' }).getAttribute('href')).toBe('/moderation/holds');
    expect(screen.queryByText(/"reasonText"/)).toBeNull();
    await user.click(within(rows[0]!).getByRole('button', { name: 'Show details' }));
    expect(await screen.findByText(/"reasonText"/)).toBeTruthy();
    expect(screen.getByText('"متن پیام"').tagName).toBe('BDI');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await within(screen.getByRole('table')).findByText('plan.update')).toBeTruthy();
    expect(api.of('GET /v1/admin/audit').at(-1)?.query).toEqual({ limit: '50', cursor: 'c1' });
  });

  it('writes the filters into the address and asks the API for the admin’s days', async () => {
    const api = auditApi();
    const user = userEvent.setup();
    const { router } = renderPanel('/system/audit', api);
    await within(await screen.findByRole('table')).findByText('user.ban');
    const filters = screen.getByRole('form', { name: 'Filters' });
    // The name is isolated inside the option (no <bdi> there): the same words around it.
    await waitFor(() => expect(within(filters).getByRole('option', { name: (name) => name.replace(/[\u2066-\u2069]/g, '') === 'Old Hand (disabled)' })).toBeTruthy());
    await user.selectOptions(within(filters).getByLabelText('Admin'), '4');
    await user.selectOptions(within(filters).getByLabelText('Action'), 'user.ban');
    await user.selectOptions(within(filters).getByLabelText('Target'), 'user');
    await user.type(within(filters).getByLabelText('ID'), 'userbaaaaaaaa');
    await user.type(within(filters).getByLabelText('From'), '2026-11-20');
    await user.type(within(filters).getByLabelText('To'), '2026-11-24');
    await user.click(within(filters).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('action')).toBe('user.ban'));
    expect(Object.fromEntries(new URLSearchParams(router.state.location.search))).toEqual({ admin: '4', targetType: 'user', target: 'userbaaaaaaaa', action: 'user.ban', from: '2026-11-20', to: '2026-11-24' });
    await waitFor(() => expect(api.of('GET /v1/admin/audit').at(-1)?.query['action']).toBe('user.ban'));
    const query = api.of('GET /v1/admin/audit').at(-1)!.query;
    expect(query).toMatchObject({ admin: '4', targetType: 'user', target: 'userbaaaaaaaa', limit: '50' });
    expect(query['from']).toBe(new Date('2026-11-20T00:00:00').toISOString());
    expect(query['to']).toBe(new Date('2026-11-25T00:00:00').toISOString());
  });

  it('exports the filtered rows as a file through the API, and says when there are too many', async () => {
    let answer: unknown = new Response('﻿time,admin_id\r\n', { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8' } });
    const api = auditApi({ 'POST /v1/admin/audit/export': () => answer });
    const created = vi.fn((_blob: Blob) => 'blob:audit');
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() });
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(`${this.download} ${this.getAttribute('href')}`);
    });
    const user = userEvent.setup();
    renderPanel('/system/audit?action=user.ban&from=2026-11-20&to=2026-11-21', api);
    await within(await screen.findByRole('table')).findByText('user.ban');
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(clicked).toEqual(['audit-2026-11-20-2026-11-21.csv blob:audit']));
    expect(api.of('POST /v1/admin/audit/export')[0]?.body).toEqual({
      action: 'user.ban',
      from: new Date('2026-11-20T00:00:00').toISOString(),
      to: new Date('2026-11-22T00:00:00').toISOString(),
    });
    expect(api.of('POST /v1/admin/audit/export')[0]?.authorization).toBe('Bearer test-access-token');
    expect(await created.mock.calls[0]![0].text()).toContain('time,admin_id');
    answer = problem(422, 'field_invalid', { errors: [{ in: 'body', pointer: '', code: 'too_many_rows', message: translate('en', 'audit.export.tooMany', { max: 10_000 }) }] });
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText(translate('en', 'audit.export.tooMany', { max: 10_000 }))).toBeTruthy();
    expect(clicked).toHaveLength(1);
  });

  it('checks the target before applying it: what cannot name a row stays out of the address and the request', async () => {
    const api = auditApi();
    const user = userEvent.setup();
    const { router } = renderPanel('/system/audit', api);
    await within(await screen.findByRole('table')).findByText('user.ban');
    const filters = screen.getByRole('form', { name: 'Filters' });
    await user.selectOptions(within(filters).getByLabelText('Target'), 'user');
    const target = within(filters).getByLabelText('ID');
    await user.type(target, '+989121234567');
    await user.click(within(filters).getByRole('button', { name: 'Apply' }));
    const error = await within(filters).findByText('Write a public ID (13 characters).');
    expect(target.getAttribute('aria-describedby')).toBe(error.id);
    expect(router.state.location.search).toBe('');
    expect(api.of('GET /v1/admin/audit').every((call) => call.query['target'] === undefined)).toBe(true);
    await user.selectOptions(within(filters).getByLabelText('Target'), 'report');
    await user.clear(target);
    await user.type(target, '12a');
    await user.click(within(filters).getByRole('button', { name: 'Apply' }));
    expect(await within(filters).findByText('Write a number.')).toBeTruthy();
    await user.clear(target);
    await user.type(target, '12');
    await user.click(within(filters).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(router.state.location.search).toBe('?targetType=report&target=12'));
  });

  it('drops a target from the address that cannot name a row', async () => {
    const api = auditApi();
    renderPanel('/system/audit?targetType=user&target=%2B989121234567', api);
    await within(await screen.findByRole('table')).findByText('user.ban');
    expect(api.of('GET /v1/admin/audit')[0]?.query).toEqual({ targetType: 'user', limit: '50' });
  });

  it('says nothing matched when filters are set, and that the log is empty when none are', async () => {
    const api = auditApi({ 'GET /v1/admin/audit': () => page([]) });
    const { unmount } = renderPanel('/system/audit?action=user.ban', api);
    expect(await screen.findByText('No rows match these filters.')).toBeTruthy();
    unmount();
    renderPanel('/system/audit', api);
    expect(await screen.findByText('No audit rows.')).toBeTruthy();
  });

  it('names an admin target, labels the detail column, and wraps a long detail inside the table', async () => {
    const long = 'دلیل بسیار طولانی '.repeat(28);
    const api = auditApi({
      'GET /v1/admin/audit': () => page([entry('6', { action: 'admin.update', targetType: 'admin', targetRef: '5', user: undefined, detail: { reasonText: long } })]),
    });
    const user = userEvent.setup();
    renderPanel('/system/audit', api);
    const table = await screen.findByRole('table');
    expect(await within(table).findByText('Old Hand')).toBeTruthy();
    expect(within(table).getByText('Old Hand').getAttribute('title')).toBe('Old Hand · 5');
    expect(within(table).getByRole('columnheader', { name: 'Details' })).toBeTruthy();
    await user.click(within(table).getByRole('button', { name: 'Show details' }));
    const pre = (await within(table).findByText(/"reasonText"/)).closest('pre')!;
    // Lines wrap and the block takes only the width it is given: a 500-character reason never widens the table.
    expect(pre.className).toContain('whitespace-pre-wrap');
    expect(pre.className).toContain('wrap-anywhere');
    expect(pre.parentElement?.className).toContain('w-0 min-w-full');
  });

  it('takes the days in the Persian calendar, and asks for the Gregorian ones', async () => {
    const user = userEvent.setup();
    const { router } = renderPanel('/system/audit', auditApi(), { locale: 'fa' });
    const filters = await screen.findByRole('form', { name: 'فیلترها' });
    const from = within(filters).getByLabelText('از');
    await user.type(from, '۱۴۰۵/۰۸/۲۹');
    const shown = await within(filters).findByText('جمعه، ۲۹ آبان ۱۴۰۵');
    expect(from.getAttribute('aria-describedby')).toBe(shown.id);
    await user.type(within(filters).getByLabelText('تا'), '1405/9/3');
    await user.click(within(filters).getByRole('button', { name: messages.fa['audit.apply'] }));
    await waitFor(() => expect(Object.fromEntries(new URLSearchParams(router.state.location.search))).toEqual({ from: '2026-11-20', to: '2026-11-24' }));
  });

  it('says so at the field when the end comes before the start, and asks nothing', async () => {
    const user = userEvent.setup();
    const { router } = renderPanel('/system/audit', auditApi(), { locale: 'fa' });
    const filters = await screen.findByRole('form', { name: 'فیلترها' });
    await user.type(within(filters).getByLabelText('از'), '۱۴۰۵/۰۹/۰۳');
    const to = within(filters).getByLabelText<HTMLInputElement>('تا');
    await user.type(to, '۱۴۰۵/۰۸/۲۹');
    await user.click(within(filters).getByRole('button', { name: messages.fa['audit.apply'] }));
    // The end field refuses a day before the start (its own validity, as a browser date field's min does).
    expect(await within(filters).findByText(messages.fa['form.day.beforeMin'].replace('{day}', '۱۴۰۵/۰۹/۰۳'))).toBeTruthy();
    expect(to.validity.valid).toBe(false);
    expect(router.state.location.search).toBe('');
  });

  it('applies nothing while a day field holds text that is not a day: the list never widens to every day', async () => {
    const user = userEvent.setup();
    const { router } = renderPanel('/system/audit?from=2026-11-20', auditApi(), { locale: 'fa' });
    const filters = await screen.findByRole('form', { name: 'فیلترها' });
    const from = within(filters).getByLabelText<HTMLInputElement>('از');
    await waitFor(() => expect(from.value).toBe('۱۴۰۵/۰۸/۲۹'));
    for (const typed of ['1405/13/01', '2026/11/27']) {
      await user.clear(from);
      await user.type(from, `${typed}{Enter}`);
      expect(from.validity.valid).toBe(false);
      expect(within(filters).getByText(messages.fa['form.day.invalid'].replace('{example}', from.placeholder))).toBeTruthy();
      expect(Object.fromEntries(new URLSearchParams(router.state.location.search))).toEqual({ from: '2026-11-20' });
    }
    // A day again: valid, and applied.
    await user.clear(from);
    await user.type(from, '۱۴۰۵/۰۸/۲۸{Enter}');
    expect(from.validity.valid).toBe(true);
    await waitFor(() => expect(Object.fromEntries(new URLSearchParams(router.state.location.search))).toEqual({ from: '2026-11-19' }));
  });

  it('reads an id typed in Persian digits', async () => {
    const user = userEvent.setup();
    const { router } = renderPanel('/system/audit', auditApi(), { locale: 'fa' });
    const filters = await screen.findByRole('form', { name: 'فیلترها' });
    await user.selectOptions(within(filters).getByLabelText(messages.fa['audit.targetType']), 'report');
    await user.type(within(filters).getByLabelText(messages.fa['audit.target']), '۱۲');
    await user.click(within(filters).getByRole('button', { name: messages.fa['audit.apply'] }));
    await waitFor(() => expect(router.state.location.search).toBe('?targetType=report&target=12'));
  });

  it('keeps the saved file’s address for a minute before letting it go', () => {
    vi.useFakeTimers();
    try {
      const revoke = vi.fn();
      Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:audit'), revokeObjectURL: revoke });
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
      saveBlob(new Blob(['x']), 'audit.csv');
      vi.advanceTimersByTime(REVOKE_AFTER_MS - 1);
      expect(revoke).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(revoke).toHaveBeenCalledWith('blob:audit');
    } finally {
      vi.useRealTimers();
    }
  });

  it('links a purchase target to its page for a reader of billing', async () => {
    const rows = () => page([entry('9', { action: 'purchase.refund', targetType: 'purchase', targetRef: '105424043695398946', user: undefined, detail: { note: 'Charged twice' } })]);
    signInAs(adminWith(['audit.read', 'billing.read'], ['finance']));
    renderPanel('/system/audit', auditApi({ 'GET /v1/admin/audit': rows }));
    const link = await screen.findByRole('link', { name: '105424043695398946' });
    expect(link.getAttribute('href')).toBe('/revenue/purchases/105424043695398946');
    expect(within(link.closest('tr')!).getByText('Purchase refunded')).toBeTruthy();
  });

  it('shows a purchase target as its id alone to a role that does not read billing', async () => {
    renderPanel('/system/audit', auditApi({ 'GET /v1/admin/audit': () => page([entry('9', { action: 'purchase.refund', targetType: 'purchase', targetRef: '105424043695398946', user: undefined, detail: null })]) }));
    expect(await screen.findByText('105424043695398946')).toBeTruthy();
    expect(screen.queryByRole('link', { name: '105424043695398946' })).toBeNull();
  });

  it('names a settings row by its key and links it to the page it is edited on', async () => {
    const rows = () =>
      page([
        entry('11', { action: 'config.update', targetType: 'config', targetRef: null, user: undefined, detail: { key: 'limits.rates', before: {}, after: {} } }),
        entry('12', { action: 'config.update', targetType: 'config', targetRef: null, user: undefined, detail: { key: 'brand', changed: ['appName'] } }),
        entry('13', { action: 'config.update', targetType: 'config', targetRef: null, user: undefined, detail: { key: 'providers.kavenegar', changed: [] } }),
        entry('14', { action: 'config.update', targetType: 'config', targetRef: null, user: undefined, detail: { key: 'auth.sms_routing' } }),
        entry('15', { action: 'config.update', targetType: 'config', targetRef: null, user: undefined, detail: { key: 'ui.templates' } }),
      ]);
    signInAs(adminWith(['audit.read', 'config.read'], ['admin']));
    renderPanel('/system/audit', auditApi({ 'GET /v1/admin/audit': rows }));
    expect((await screen.findByRole('link', { name: 'limits.rates' })).getAttribute('href')).toBe('/app/config');
    expect(screen.getByRole('link', { name: 'brand' }).getAttribute('href')).toBe('/app/brand');
    expect(screen.getByRole('link', { name: 'ui.templates' }).getAttribute('href')).toBe('/app/appearance');
    // The providers page needs config.providers: without it the key is shown with no link.
    expect(screen.getByText('providers.kavenegar')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'providers.kavenegar' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'auth.sms_routing' })).toBeNull();
  });

  it('names a role change by the role’s name in the panel’s language and links it to the roles page for a reader of admins', async () => {
    const rows = () =>
      page([
        entry('16', { action: 'role.update', targetType: 'config', targetRef: null, user: undefined, detail: { role: 'support', before: [], after: [] } }),
        entry('17', { action: 'role.update', targetType: 'config', targetRef: null, user: undefined, detail: { role: 'marketing', before: [], after: [] } }),
      ]);
    signInAs(adminWith(['audit.read', 'admins.read'], ['superadmin']));
    let view = renderPanel('/system/audit', auditApi({ 'GET /v1/admin/audit': rows }));
    const support = await screen.findByRole('link', { name: 'Support' });
    expect(support.getAttribute('href')).toBe('/system/roles');
    // The key stays on hover; the row's kind is the role, never the settings its target code names.
    expect(support.getAttribute('title')).toBe('support');
    const row = within(support.closest('tr')!);
    expect(row.getByText('Role')).toBeTruthy();
    expect(row.queryByText('Settings')).toBeNull();
    expect(row.queryByText('support')).toBeNull();
    expect(screen.getByRole('link', { name: 'Marketing' }).getAttribute('href')).toBe('/system/roles');
    view.unmount();

    // In Persian, by the glossary's words.
    view = renderPanel('/system/audit', auditApi({ 'GET /v1/admin/audit': rows }), { locale: 'fa' });
    const supportFa = await screen.findByRole('link', { name: 'کارشناس پشتیبانی' });
    expect(supportFa.getAttribute('href')).toBe('/system/roles');
    for (const link of [supportFa, screen.getByRole('link', { name: 'کارشناس بازاریابی' })]) {
      const rowFa = within(link.closest('tr')!);
      expect(rowFa.getByText('نقش')).toBeTruthy();
      expect(rowFa.queryByText('تنظیمات')).toBeNull();
    }
    view.unmount();

    // Without admins.read: the role's name, no link (and no read of the roles list).
    signInAs(adminWith(['audit.read'], ['auditor']));
    const api = auditApi({ 'GET /v1/admin/audit': rows });
    renderPanel('/system/audit', api, { locale: 'en' });
    const table = within(await screen.findByRole('table'));
    expect((await table.findAllByText('Support')).length).toBeGreaterThan(0);
    expect(table.queryByRole('link', { name: 'Support' })).toBeNull();
    expect(api.of('GET /v1/admin/roles')).toHaveLength(0);
  });

  it('names a custom role by its stored name, read with the roles list', async () => {
    const custom = { key: 'team_lead', names: { fa: 'سرپرست تیم پشتیبانی', en: 'Support team lead', tr: 'Destek ekip lideri' }, grants: ['users.read'], permissions: ['users.read'] };
    const rows = () => page([entry('19', { action: 'role.update', targetType: 'config', targetRef: null, user: undefined, detail: { role: 'team_lead', before: [], after: [] } })]);
    signInAs(adminWith(['audit.read', 'admins.read'], ['superadmin']));
    let view = renderPanel('/system/audit', auditApi({ 'GET /v1/admin/audit': rows, 'GET /v1/admin/roles': () => ({ items: [custom] }) }));
    const link = await screen.findByRole('link', { name: 'Support team lead' });
    expect(link.getAttribute('href')).toBe('/system/roles');
    expect(link.getAttribute('title')).toBe('team_lead');
    expect(screen.queryByRole('link', { name: 'team_lead' })).toBeNull();
    view.unmount();
    view = renderPanel('/system/audit', auditApi({ 'GET /v1/admin/audit': rows, 'GET /v1/admin/roles': () => ({ items: [custom] }) }), { locale: 'fa' });
    expect(await screen.findByRole('link', { name: 'سرپرست تیم پشتیبانی' })).toBeTruthy();
    view.unmount();
  });

  it('shows on a phone, under the action, the role or what a jobs page action acted on (the target column is hidden there)', async () => {
    const rows = () =>
      page([
        entry('31', { action: 'role.update', targetType: 'config', targetRef: null, user: undefined, detail: { role: 'support', before: [], after: [] } }),
        entry('32', { action: 'system.task_run', targetType: 'none', targetRef: null, user: undefined, detail: { queue: 'maint', name: 'partitions', jobId: 'partitions.run.1' } }),
        entry('33', { action: 'system.jobs_retry', targetType: 'none', targetRef: null, user: undefined, detail: { queue: 'photo', name: 'process', count: 7, more: false } }),
        entry('34', { action: 'user.ban' }),
      ]);
    signInAs(adminWith(['audit.read', 'admins.read'], ['superadmin']));
    renderPanel('/system/audit', auditApi({ 'GET /v1/admin/audit': rows }), { locale: 'fa' });
    const actionCell = async (code: string) => (await screen.findByText(code)).closest('td')!;
    const role = await actionCell('role.update');
    const roleLine = within(role).getByText('کارشناس پشتیبانی');
    expect(roleLine.className.split(' ')).toContain('md:hidden');
    expect(within(await actionCell('system.task_run')).getByText('ساخت و حذف پارتیشن‌ها').className.split(' ')).toContain('md:hidden');
    expect(within(await actionCell('system.jobs_retry')).getByText(wholeText('عکس‌ها، پردازش عکس، ۷\u00a0کار'))).toBeTruthy();
    // Other rows keep their action cell as it was.
    expect((await actionCell('user.ban')).querySelectorAll('.md\\:hidden')).toHaveLength(0);
  });

  it('names a role this build has no words for by its key', async () => {
    signInAs(adminWith(['audit.read', 'admins.read'], ['superadmin']));
    renderPanel('/system/audit', auditApi({ 'GET /v1/admin/audit': () => page([entry('18', { action: 'role.update', targetType: 'config', targetRef: null, user: undefined, detail: { role: 'reviewer' } })]) }));
    expect((await screen.findByRole('link', { name: 'reviewer' })).getAttribute('href')).toBe('/system/roles');
  });

  it('names what a jobs page action acted on: the task, the queue’s job and count, the stream and count', async () => {
    const system = (id: string, action: AuditEntry['action'], detail: AuditEntry['detail']) => entry(id, { action, targetType: 'none', targetRef: null, user: undefined, detail });
    const rows = () =>
      page([
        system('21', 'system.task_run', { queue: 'maint', name: 'partitions', jobId: 'partitions.run.29404800' }),
        system('22', 'system.task_run', { queue: 'growth', name: 'tick', jobId: 'tick.run.29404800' }),
        system('23', 'system.jobs_retry', { queue: 'photo', name: 'process', count: 7, more: false }),
        system('24', 'system.jobs_remove', { queue: 'push', name: 'send', count: 200, more: true }),
        system('25', 'system.dead_letters_delete', { stream: 'like', ids: ['1764322000000-1', '1764322000000-2'] }),
        system('26', 'system.dead_letters_delete', { stream: 'msg', upTo: '1764323000000-0', lengthBefore: 9, count: 4 }),
        // Written before the count was recorded: the stream alone.
        system('27', 'system.dead_letters_delete', { stream: 'match', upTo: '1764323000000-0', lengthBefore: 3 }),
      ]);
    signInAs(adminWith(['audit.read'], ['admin']));
    const view = renderPanel('/system/audit', auditApi({ 'GET /v1/admin/audit': rows }));
    const subject = async (code: string, nth = 0) => {
      const cells = (await screen.findAllByText(code)).map((label) => label.closest('tr')!);
      return within(cells[nth]!.querySelectorAll('td')[3] as HTMLElement);
    };
    let cell = await subject('system.task_run');
    expect(cell.getByText('Task')).toBeTruthy();
    expect(cell.getByText('Partitions')).toBeTruthy();
    // A task this build has no words for: its code, in mono.
    cell = await subject('system.task_run', 1);
    expect(cell.getByText('growth/tick').className).toContain('font-mono');
    cell = await subject('system.jobs_retry');
    expect(cell.getByText('Queue')).toBeTruthy();
    expect(cell.getByText('Photos')).toBeTruthy();
    expect(cell.getByText('Photo processing')).toBeTruthy();
    expect(cell.getByText('7 jobs')).toBeTruthy();
    // A count never breaks from its noun: its space is a no-break one.
    expect(cell.getByText('Photos').parentElement!.textContent).toBe('Photos · Photo processing · 7\u00a0jobs');
    cell = await subject('system.jobs_remove');
    expect(cell.getByText('Push notifications')).toBeTruthy();
    expect(cell.getByText('200 jobs')).toBeTruthy();
    cell = await subject('system.dead_letters_delete');
    expect(cell.getByText('Likes')).toBeTruthy();
    expect(cell.getByText('2 entries')).toBeTruthy();
    cell = await subject('system.dead_letters_delete', 1);
    expect(cell.getByText('Messages')).toBeTruthy();
    expect(cell.getByText('4 entries')).toBeTruthy();
    cell = await subject('system.dead_letters_delete', 2);
    expect(cell.getByText('Matches')).toBeTruthy();
    expect(cell.queryByText(/entries/)).toBeNull();
    view.unmount();

    renderPanel('/system/audit', auditApi({ 'GET /v1/admin/audit': rows }), { locale: 'fa' });
    cell = await subject('system.task_run');
    expect(cell.getByText('کار')).toBeTruthy();
    expect(cell.getByText('ساخت و حذف پارتیشن‌ها')).toBeTruthy();
    cell = await subject('system.jobs_retry');
    expect(cell.getByText('پردازش عکس')).toBeTruthy();
    expect(cell.getByText('۷ کار')).toBeTruthy();
    // Persian's own comma between the parts: a "·" beside Persian digits would read as a zero («۷ · » as «۷۰»).
    expect(cell.getByText('پردازش عکس').parentElement!.textContent).toBe('عکس‌ها، پردازش عکس، ۷\u00a0کار');
    cell = await subject('system.dead_letters_delete', 1);
    expect(cell.getByText('پیام‌ها')).toBeTruthy();
    expect(cell.getByText('۴ ورودی')).toBeTruthy();
  });

  it('links a provider row to the providers page for the owner', async () => {
    signInAs(adminWith(['audit.read', 'config.read', 'config.providers'], ['superadmin']));
    renderPanel('/system/audit', auditApi({ 'GET /v1/admin/audit': () => page([entry('13', { action: 'config.update', targetType: 'config', targetRef: null, user: undefined, detail: { key: 'providers.kavenegar' } })]) }));
    expect((await screen.findByRole('link', { name: 'providers.kavenegar' })).getAttribute('href')).toBe('/app/providers');
  });

  it('filters by a purchase', async () => {
    const api = auditApi();
    renderPanel('/system/audit?targetType=purchase&target=105424043695398946', api);
    await screen.findByRole('heading', { name: 'Audit log' });
    await waitFor(() => expect(api.of('GET /v1/admin/audit')[0]?.query).toMatchObject({ targetType: 'purchase', target: '105424043695398946' }));
  });

  it('is for audit.read: without it, no request and no access', async () => {
    signInAs(adminWith(['users.read', 'moderation.read'], ['moderator']));
    const api = auditApi();
    renderPanel('/system/audit', api);
    expect(await screen.findByText('No access')).toBeTruthy();
    expect(api.calls.filter((c) => c.path.startsWith('/v1/admin/audit'))).toHaveLength(0);
    expect(screen.queryByRole('link', { name: 'Audit log' })).toBeNull();
  });

  it('is in Persian, right to left', async () => {
    renderPanel('/system/audit', auditApi(), { locale: 'fa' });
    expect(await screen.findByRole('heading', { name: 'لاگ ممیزی' })).toBeTruthy();
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByRole('button', { name: 'خروجی CSV' })).toBeTruthy();
  });
});
