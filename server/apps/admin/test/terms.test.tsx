import type { AdminBannedTerm } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { page } from './moderationFixtures';
import { adminWith, fakeApi, problem, renderPanel, resetPanel, signInAs } from './panel';

const writer = adminWith(['moderation.read', 'moderation.terms'], ['moderator']);
const readOnly = adminWith(['moderation.read'], ['support']);

function term(id: string, overrides: Partial<AdminBannedTerm> = {}): AdminBannedTerm {
  return {
    id,
    term: `term${id}`,
    match: 'word',
    severity: 'refuse',
    scope: ['name', 'messages'],
    locale: null,
    active: true,
    createdAt: '2026-11-20T10:00:00.000Z',
    createdBy: { id: '4', displayName: 'Mina Mod' },
    ...overrides,
  };
}

function termsApi(extra: Record<string, Parameters<typeof fakeApi>[0][string]> = {}) {
  return fakeApi({
    'GET /v1/admin/banned-terms': (call) =>
      call.query['cursor'] ? page([term('3', { term: 'older' })]) : page([term('9', { term: '(?:buy|sell)\\s+now', match: 'regex', severity: 'flag', scope: ['messages'] }), term('8', { term: 'تلگرام', locale: 'fa', active: false, severity: 'ask' })], 'c1'),
    ...extra,
  });
}

beforeEach(() => {
  resetPanel();
  signInAs(writer);
});

describe('the banned terms page', () => {
  it('lists the terms with their match, severity, scope, language and state; Load more sends the cursor', async () => {
    const api = termsApi();
    const user = userEvent.setup();
    renderPanel('/moderation/terms', api);
    expect(await screen.findByRole('heading', { name: 'Banned terms' })).toBeTruthy();
    const rows = (await screen.findAllByRole('row')).slice(1);
    const regex = within(rows[0]!).getByText('(?:buy|sell)\\s+now');
    expect(regex.getAttribute('dir')).toBe('ltr');
    expect(within(rows[0]!).getByText('Regular expression')).toBeTruthy();
    expect(within(rows[0]!).getByText('Flag')).toBeTruthy();
    expect(within(rows[0]!).getByText('Messages')).toBeTruthy();
    expect(within(rows[0]!).getByText('Any language')).toBeTruthy();
    expect(within(rows[1]!).getByText('تلگرام').getAttribute('dir')).toBe('auto');
    expect(within(rows[1]!).getByText('Persian')).toBeTruthy();
    expect(within(rows[1]!).getByRole('switch', { name: 'Active: تلگرام' }).getAttribute('aria-checked')).toBe('false');
    expect(api.of('GET /v1/admin/banned-terms')[0]?.query).toEqual({ limit: '50' });
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('older')).toBeTruthy();
    expect(api.of('GET /v1/admin/banned-terms').at(-1)?.query).toEqual({ limit: '50', cursor: 'c1' });
  });

  it('searches with ?q= in the address (a term is not personal data)', async () => {
    const api = termsApi();
    const user = userEvent.setup();
    const { router } = renderPanel('/moderation/terms', api);
    await screen.findByText('تلگرام');
    await user.type(screen.getByRole('textbox', { name: 'Search terms' }), 'buy{Enter}');
    await waitFor(() => expect(router.state.location.search).toBe('?q=buy'));
    await waitFor(() => expect(api.of('GET /v1/admin/banned-terms').at(-1)?.query).toEqual({ q: 'buy', limit: '50' }));
    await user.click(screen.getByRole('button', { name: 'Clear the search' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('adds a term: nothing is sent before saving, then the exact body', async () => {
    const api = termsApi({ 'POST /v1/admin/banned-terms': () => [201, { term: term('10'), sideEffects: 'done' }] });
    const user = userEvent.setup();
    renderPanel('/moderation/terms', api);
    await screen.findByText('تلگرام');
    await user.click(screen.getByRole('button', { name: 'New term' }));
    const dialog = await screen.findByRole('dialog', { name: 'New term' });
    await user.click(within(dialog).getByRole('button', { name: 'Add term' }));
    expect(await within(dialog).findByText('Required.')).toBeTruthy();
    expect(api.of('POST /v1/admin/banned-terms')).toHaveLength(0);
    await user.type(within(dialog).getByLabelText('Term'), 'scamlink');
    await user.click(within(dialog).getByRole('radio', { name: 'Part of a word' }));
    await user.click(within(dialog).getByRole('radio', { name: 'Ask' }));
    for (const scope of ['Name', 'Job title']) await user.click(within(dialog).getByRole('checkbox', { name: scope }));
    await user.selectOptions(within(dialog).getByLabelText('Language'), 'en');
    await user.click(within(dialog).getByRole('button', { name: 'Add term' }));
    await waitFor(() => expect(api.of('POST /v1/admin/banned-terms')).toHaveLength(1));
    expect(api.of('POST /v1/admin/banned-terms')[0]?.body).toEqual({ term: 'scamlink', match: 'substring', severity: 'ask', scope: ['about', 'prompts', 'messages'], locale: 'en', active: true });
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('shows the API’s refusals at the term: a pattern outside the subset, a term that exists', async () => {
    let answer: unknown = problem(422, 'field_invalid', { errors: [{ in: 'body', pointer: '/term', code: 'regex_unsupported', message: 'x' }] });
    const api = termsApi({ 'POST /v1/admin/banned-terms': () => answer });
    const user = userEvent.setup();
    renderPanel('/moderation/terms', api);
    await screen.findByText('تلگرام');
    await user.click(screen.getByRole('button', { name: 'New term' }));
    const dialog = await screen.findByRole('dialog', { name: 'New term' });
    await user.type(within(dialog).getByLabelText('Term'), '(a+)+');
    await user.click(within(dialog).getByRole('radio', { name: 'Regular expression' }));
    expect(within(dialog).getByLabelText('Term').getAttribute('dir')).toBe('ltr');
    await user.click(within(dialog).getByRole('button', { name: 'Add term' }));
    expect(await within(dialog).findByText(/This pattern is not supported/)).toBeTruthy();
    answer = problem(409, 'conflict', { detail: 'This term exists.' });
    await user.click(within(dialog).getByRole('button', { name: 'Add term' }));
    expect(await within(dialog).findByText('This term exists.')).toBeTruthy();
  });

  it('edits a term sending only what changed, switches one off inline, and removes one after confirming', async () => {
    const api = termsApi({
      'PATCH /v1/admin/banned-terms/9': () => ({ term: term('9'), sideEffects: 'failed' }),
      'PATCH /v1/admin/banned-terms/8': () => ({ term: term('8', { active: true }), sideEffects: 'done' }),
      'DELETE /v1/admin/banned-terms/9': () => undefined,
    });
    const user = userEvent.setup();
    renderPanel('/moderation/terms', api);
    await screen.findByText('تلگرام');
    await user.click(screen.getByRole('button', { name: 'Actions for (?:buy|sell)\\s+now' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit term' });
    await user.click(within(dialog).getByRole('radio', { name: 'Refuse' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.of('PATCH /v1/admin/banned-terms/9')).toHaveLength(1));
    expect(api.of('PATCH /v1/admin/banned-terms/9')[0]?.body).toEqual({ severity: 'refuse' });
    expect(await screen.findByText('Saved. Some updates in the app will be late.')).toBeTruthy();

    await user.click(screen.getByRole('switch', { name: 'Active: تلگرام' }));
    await waitFor(() => expect(api.of('PATCH /v1/admin/banned-terms/8')[0]?.body).toEqual({ active: true }));

    await user.click(screen.getByRole('button', { name: 'Actions for (?:buy|sell)\\s+now' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Remove this term?' });
    expect(api.of('DELETE /v1/admin/banned-terms/9')).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.of('DELETE /v1/admin/banned-terms/9')).toHaveLength(1));
    expect(await screen.findByText('Removed.')).toBeTruthy();
  });

  it('shows a reader the list without anything to change', async () => {
    signInAs(readOnly);
    renderPanel('/moderation/terms', termsApi());
    await screen.findByText('تلگرام');
    expect(screen.queryByRole('button', { name: 'New term' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
    // The state in words, not a switch the reader cannot use.
    expect(screen.queryByRole('switch')).toBeNull();
    const rows = (await screen.findAllByRole('row')).slice(1);
    expect(within(rows[0]!).getByText('Active')).toBeTruthy();
    expect(within(rows[1]!).getByText('Off')).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).toBeNull();
  });

  it('names the row-action column, shows one chip for every place, and keeps the search in the page’s direction', async () => {
    const api = termsApi({
      'GET /v1/admin/banned-terms': () => page([term('11', { scope: ['name', 'about', 'prompts', 'messages', 'job'] }), term('12', { scope: ['name', 'messages'] })]),
    });
    renderPanel('/moderation/terms', api);
    const rows = (await screen.findAllByRole('row')).slice(1);
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeTruthy();
    expect(within(rows[0]!).getByText('Everywhere')).toBeTruthy();
    expect(within(rows[0]!).queryByText('Name')).toBeNull();
    expect(within(rows[1]!).getByText('Name')).toBeTruthy();
    expect(within(rows[1]!).getByText('Messages')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Search terms' }).getAttribute('dir')).toBeNull();
  });

  it('moves a segmented choice with the arrow keys, one tab stop a group, mirrored right to left', async () => {
    const user = userEvent.setup();
    renderPanel('/moderation/terms', termsApi(), { locale: 'fa' });
    await user.click(await screen.findByRole('button', { name: 'واژه‌ی جدید' }));
    const dialog = await screen.findByRole('dialog');
    const match = within(dialog).getByRole('radiogroup', { name: 'نوع تطبیق' });
    const [part, whole, regex] = within(match).getAllByRole('radio');
    expect([part!.tabIndex, whole!.tabIndex, regex!.tabIndex]).toEqual([-1, 0, -1]);
    whole!.focus();
    // Right to left: the left arrow goes to the next one.
    await user.keyboard('{ArrowLeft}');
    expect(regex!.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(regex);
    await user.keyboard('{ArrowLeft}');
    expect(part!.getAttribute('aria-checked')).toBe('true');
    await user.keyboard('{End}');
    expect(regex!.getAttribute('aria-checked')).toBe('true');
    await user.keyboard('{ArrowRight}');
    expect(whole!.getAttribute('aria-checked')).toBe('true');
    expect(within(dialog).getByRole('radio', { name: 'پرسش از کاربر' })).toBeTruthy();
  });

  it('words the refusals of the pattern engine at the term', async () => {
    let code = 'regex_word_boundary';
    const api = termsApi({ 'POST /v1/admin/banned-terms': () => problem(422, 'field_invalid', { errors: [{ in: 'body', pointer: '/term', code, message: 'x' }] }) });
    const user = userEvent.setup();
    renderPanel('/moderation/terms', api);
    await screen.findByText('تلگرام');
    await user.click(screen.getByRole('button', { name: 'New term' }));
    const dialog = await screen.findByRole('dialog', { name: 'New term' });
    await user.type(within(dialog).getByLabelText('Term'), '\\bعلی\\b');
    await user.click(within(dialog).getByRole('radio', { name: 'Regular expression' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add term' }));
    expect(await within(dialog).findByText('\\b knows Latin letters only. Use Whole word.')).toBeTruthy();
    code = 'regex_too_large';
    await user.click(within(dialog).getByRole('button', { name: 'Add term' }));
    expect(await within(dialog).findByText('This pattern is too large. Split it into several terms.')).toBeTruthy();
  });

  it('is in Persian, right to left, with the glossary’s words', async () => {
    renderPanel('/moderation/terms', termsApi(), { locale: 'fa' });
    expect(await screen.findByRole('heading', { name: 'واژه‌های ممنوع' })).toBeTruthy();
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByRole('button', { name: 'واژه‌ی جدید' })).toBeTruthy();
    expect((await screen.findAllByText('عبارت منظم')).length).toBeGreaterThan(0);
  });
});
