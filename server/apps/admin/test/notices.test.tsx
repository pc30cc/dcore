import type { AdminAppearance, OriginsAdminView } from '@app/shared';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { messages } from '../src/i18n/messages';
import { translate } from '../src/i18n/translate';
import { page } from './moderationFixtures';
import { adminWith, fakeApi, isolatedIn, plan, planList, problem, renderPanel, resetPanel, signInAs, wholeText } from './panel';

/**
 * A notice that stays on a page (the plan editor's bar, a refusal under a
 * form, a sign-in step's error, a field's error) holds how to word it, not
 * finished text, like a toast: it is worded when drawn, so after a
 * language switch it is in the new language, and a value from the API in
 * it sits in a <bdi>, so a sentence in the other script keeps its own
 * punctuation. No isolate character is left in the page's text.
 */

const ISOLATES = /[\u2066-\u2069]/;
/** Reaches every page used here: the hosts page takes the top role. */
const superadmin = adminWith(['billing.read', 'billing.catalog', 'config.read', 'config.write'], ['superadmin']);
const MFA = `amf1.${'a'.repeat(43)}`;

const pick = (label: string, locale: string) => fireEvent.change(screen.getByLabelText(label), { target: { value: locale } });

/** A refusal the panel has no words for: its detail is the API's own English. */
const refused = (message: string) => problem(400, 'validation_failed', { errors: [{ in: 'body', pointer: '', code: 'custom', message }] });

beforeEach(() => {
  resetPanel();
  signInAs(superadmin);
});

describe('a notice on a page', () => {
  it('in the plan editor’s bar, isolates the API’s detail and follows a language switch', async () => {
    const plus = plan('plus', { rank: 1, sort: 1, names: { en: 'Plus', fa: 'پلاس' } });
    const api = fakeApi({ 'GET /v1/admin/plans': () => planList([plan('free'), plus]), 'PATCH /v1/admin/plans/plus': () => refused('name is required.') });
    const user = userEvent.setup();
    renderPanel('/revenue/plans/plus', api, { locale: 'fa' });
    const sort = await screen.findByLabelText(messages.fa['plan.sort']);
    await user.clear(sort);
    await user.type(sort, '7');
    await user.click(screen.getByRole('button', { name: messages.fa['form.save'] }));

    // The panel's sentence; the API's English only on a smaller line of its own, isolated.
    const persian = await screen.findByText(wholeText(`${messages.fa['common.error.invalid']}جزئیات فنی: name is required.`));
    expect(persian.querySelector(':scope > span.block')?.textContent).toBe('جزئیات فنی: name is required.');
    expect(isolatedIn(persian)).toEqual(['name is required.']);
    expect(persian.textContent).not.toMatch(ISOLATES);

    pick(messages.fa['language.label'], 'en');
    expect(document.documentElement.dir).toBe('ltr');
    const english = await screen.findByText(wholeText(`${messages.en['common.error.invalid']}Technical detail: name is required.`));
    expect(isolatedIn(english)).toEqual(['name is required.']);
    expect(screen.queryByText(wholeText(`${messages.fa['common.error.invalid']}جزئیات فنی: name is required.`))).toBeNull();
  });

  it('under the password form, follows a language switch', async () => {
    const api = fakeApi({ 'GET /v1/admin/me/sessions': () => ({ items: [] }), 'PUT /v1/admin/me/password': () => refused('Try again later.') });
    const user = userEvent.setup();
    renderPanel('/me/security', api);
    await user.type(await screen.findByLabelText('Current password'), 'old password here');
    await user.type(screen.getByLabelText('New password', { exact: true }), 'a much longer new password');
    await user.type(screen.getByLabelText('New password, again'), 'a much longer new password');
    await user.click(screen.getByRole('button', { name: messages.en['security.password.save'] }));
    expect(isolatedIn(await screen.findByText(wholeText(`${messages.en['common.error.invalid']}Technical detail: Try again later.`)))).toEqual(['Try again later.']);

    pick(messages.en['language.label'], 'fa');
    expect(isolatedIn(await screen.findByText(wholeText(`${messages.fa['common.error.invalid']}جزئیات فنی: Try again later.`)))).toEqual(['Try again later.']);
  });

  it('on the appearance page, follows a language switch', async () => {
    const view: AdminAppearance = {
      version: '3',
      defaultTemplate: 'neon',
      templates: [
        { id: 'neon', offered: true },
        { id: 'white', offered: true },
      ],
      neonGradient: { start: '#11CCAA', mid: '#0E9F8E', end: '#2255FF' },
    };
    const api = fakeApi({
      'GET /v1/admin/appearance': () => view,
      'PUT /v1/admin/appearance': () => problem(422, 'field_invalid', { detail: 'x', errors: [{ in: 'body', pointer: '/offered', code: 'default_not_offered', message: 'x' }] }),
    });
    const user = userEvent.setup();
    renderPanel('/app/appearance', api);
    await user.click(await screen.findByRole('radiogroup', { name: 'Default template' }).then((group) => within(group).getByRole('radio', { name: 'White' })));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Save appearance' }));
    await screen.findByText(messages.en['appearance.error.defaultNotOffered']);

    pick(messages.en['language.label'], 'fa');
    await screen.findByText(messages.fa['appearance.error.defaultNotOffered']);
    expect(screen.queryByText(messages.en['appearance.error.defaultNotOffered'])).toBeNull();
  });

  it('on the hosts page, isolates the API’s own text (notice, entries) and follows a language switch', async () => {
    const hosts = { api: ['https://api.example.com'], realtime: ['https://rt.example.com'], rtc: [], cdn: ['https://cdn.example.com'], web: ['https://example.com'] };
    const view = (version: number): OriginsAdminView => ({
      saved: true,
      version,
      hosts,
      bootstrap: ['https://cdn.example.com/bootstrap/origins.json'],
      allowIpHosts: false,
      defaults: { hosts, bootstrap: [] },
      signing: { configured: false, kid: null, publicKey: null, trusted: null },
      document: null,
    });
    let answer: unknown = problem(422, 'field_invalid', { detail: 'must use https', errors: [{ in: 'body', pointer: '/hosts/api/0', code: 'not_https', message: 'must use https' }] });
    const api = fakeApi({ 'GET /v1/admin/origins': () => view(4), 'PUT /v1/admin/origins': () => answer });
    const user = userEvent.setup();
    renderPanel('/hosts', api, { locale: 'fa' });
    const save = await screen.findByRole('button', { name: messages.fa['hosts.form.save'] });
    await user.click(save);

    // The panel's words, by the issue's code: none of the API's English is shown.
    await screen.findByText(wholeText(messages.fa['hosts.form.invalid']));
    const entry = await screen.findByText(wholeText(translate('fa', 'hosts.form.entry', { entry: 1, message: messages.fa['hosts.issue.not_https'] })));
    expect(isolatedIn(entry)).toEqual([messages.fa['hosts.issue.not_https']]);
    expect(document.body.textContent).not.toMatch(ISOLATES);
    expect(document.body.textContent).not.toContain('must use https');

    answer = view(5);
    await user.click(save);
    await screen.findByText(translate('fa', 'hosts.saved', { version: 5 }));
    pick(messages.fa['language.label'], 'en');
    await screen.findByText(translate('en', 'hosts.saved', { version: 5 }));
  });

  it('on the hosts page, words a read that failed in the panel’s language', async () => {
    renderPanel('/hosts', fakeApi({ 'GET /v1/admin/origins': () => problem(503, 'service_unavailable', { detail: 'The store is not reachable.' }) }), { locale: 'fa' });
    await screen.findByText(wholeText(messages.fa['common.error.unavailable']));
    expect(document.body.textContent).not.toContain('The store is not reachable.');
  });

  it('under a list that could not be read, isolates the API’s detail', async () => {
    renderPanel('/revenue/plans', fakeApi({ 'GET /v1/admin/plans': () => refused('limit is too large.') }), { locale: 'fa' });
    expect(isolatedIn(await screen.findByText(wholeText(`${messages.fa['common.error.invalid']}جزئیات فنی: limit is too large.`)))).toEqual(['limit is too large.']);
  });

  it('under a field (a phone number to look up, an audit target), follows a language switch', async () => {
    signInAs(adminWith(['moderation.read', 'moderation.device_bans', 'audit.read'], ['moderator']));
    const api = fakeApi({
      'GET /v1/admin/device-bans': () => page([]),
      'GET /v1/admin/audit': () => page([]),
      'GET /v1/admin/audit/admins': () => ({ items: [] }),
    });
    const user = userEvent.setup();
    const { router } = renderPanel('/moderation/device-bans', api);
    await user.type(await screen.findByRole('textbox', { name: 'Phone number' }), '09121234567{Enter}');
    await screen.findByText(messages.en['deviceBans.error.phone']);
    pick(messages.en['language.label'], 'fa');
    await screen.findByText(messages.fa['deviceBans.error.phone']);

    pick(messages.fa['language.label'], 'en');
    await router.navigate('/system/audit');
    const filters = await screen.findByRole('form', { name: 'Filters' });
    await user.selectOptions(within(filters).getByLabelText('Target'), 'report');
    await user.type(within(filters).getByLabelText('ID'), '12a');
    await user.click(within(filters).getByRole('button', { name: 'Apply' }));
    await within(filters).findByText(messages.en['audit.error.target']);
    pick(messages.en['language.label'], 'fa');
    await within(screen.getByRole('form', { name: messages.fa['audit.filters'] })).findByText(messages.fa['audit.error.target']);
  });
});

describe('a refused sign-in step', () => {
  it('follows a language switch on the password step', async () => {
    resetPanel();
    const api = fakeApi({
      'POST /v1/admin/auth/refresh': () => problem(401, 'refresh_invalid'),
      'POST /v1/admin/auth/login': () => problem(401, 'unauthorized', { detail: 'E-mail or password not valid.' }),
    });
    const user = userEvent.setup();
    renderPanel('/login', api);
    await user.type(await screen.findByLabelText('Work e-mail'), 'admin@example.com');
    await user.type(screen.getByLabelText('Password', { exact: true }), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText(messages.en['login.error.credentials']);

    pick(messages.en['language.label'], 'fa');
    await screen.findByText(messages.fa['login.error.credentials']);
    expect(screen.queryByText(messages.en['login.error.credentials'])).toBeNull();
  });

  it('follows a language switch on the code step', async () => {
    resetPanel();
    const api = fakeApi({
      'POST /v1/admin/auth/refresh': () => problem(401, 'refresh_invalid'),
      'POST /v1/admin/auth/login': () => ({ mfaToken: MFA, enrollRequired: false, expiresAt: new Date(Date.now() + 300_000).toISOString() }),
      'POST /v1/admin/auth/totp': () => problem(400, 'otp_invalid', { attemptsLeft: 3 }),
    });
    const user = userEvent.setup();
    renderPanel('/login', api);
    await user.type(await screen.findByLabelText('Work e-mail'), 'admin@example.com');
    await user.type(screen.getByLabelText('Password', { exact: true }), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText('Authentication code'), '123456');
    await screen.findByText(translate('en', 'login.error.codeLeft', { count: 3 }));

    pick(messages.en['language.label'], 'fa');
    await screen.findByText(translate('fa', 'login.error.codeLeft', { count: 3 }));
  });
});
