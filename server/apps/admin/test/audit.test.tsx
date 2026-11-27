import type { AuditEntry } from '@app/shared';
import { messages } from '../src/i18n/messages';
import { translate } from '../src/i18n/translate';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REVOKE_AFTER_MS, saveBlob } from '../src/lib/download';
import { page } from './moderationFixtures';
import { adminWith, fakeApi, problem, renderPanel, resetPanel, signInAs } from './panel';

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
