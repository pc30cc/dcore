import { DESIGN_GRADIENT_DARK, type AdminAppearance, type GradientStops } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  appearanceBody,
  appearanceFormOf,
  appearanceProblem,
  appearanceServerProblem,
  offeredIds,
  sameAppearance,
  templateSwatches,
  withDefault,
  withOffered,
} from '../src/lib/appearance';
import { fakeApi, owner, problem, renderPanel, resetPanel, signInAs, type Call } from './panel';

const configAdmin = { ...owner, roles: ['admin'], permissions: ['config.read', 'config.write'] as typeof owner.permissions };

const TEAL: GradientStops = { start: '#11CCAA', mid: '#0E9F8E', end: '#2255FF' };

function view(defaultTemplate: 'neon' | 'white', offered: readonly ('neon' | 'white')[], version = 'v1', neonGradient: GradientStops = DESIGN_GRADIENT_DARK): AdminAppearance {
  return { version, defaultTemplate, templates: (['neon', 'white'] as const).map((id) => ({ id, offered: offered.includes(id) })), neonGradient };
}

/** The API's PUT: the body becomes the stored setting (display order) at a new version, as the route answers. */
function saving(into: { body?: unknown }) {
  return (call: Call) => {
    into.body = call.body;
    const body = call.body as { defaultTemplate: 'neon' | 'white'; offered: ('neon' | 'white')[] };
    return view(body.defaultTemplate, body.offered, 'v2');
  };
}

/** The default template's choices (the header's theme picker has radios too). */
function defaults(label = 'Default template') {
  return within(screen.getByRole('radiogroup', { name: label }));
}

beforeEach(() => {
  resetPanel();
  signInAs(configAdmin);
});

describe('the appearance form', () => {
  it('always offers the default, also when the API listed it off', () => {
    const form = appearanceFormOf({ ...view('white', ['neon']), templates: [{ id: 'neon', offered: true }, { id: 'white', offered: false }] });
    expect(form).toEqual({ defaultTemplate: 'white', offered: { neon: true, white: true } });
  });

  it('offers a template made the default, and never stops offering the default', () => {
    const form = appearanceFormOf(view('neon', ['neon']));
    const next = withDefault(form, 'white');
    expect(next).toEqual({ defaultTemplate: 'white', offered: { neon: true, white: true } });
    expect(withOffered(next, 'white', false)).toBe(next);
    expect(withOffered(next, 'neon', false)).toEqual({ defaultTemplate: 'white', offered: { neon: false, white: true } });
    expect(appearanceProblem(next)).toBeNull();
    expect(appearanceProblem({ defaultTemplate: 'white', offered: { neon: true, white: false } })).toBe('appearance.error.defaultNotOffered');
  });

  it('sends the offered templates in display order with the version the form was built from, and compares by what is sent', () => {
    const form = { defaultTemplate: 'white' as const, offered: { white: true, neon: true } };
    expect(offeredIds(form)).toEqual(['neon', 'white']);
    expect(appearanceBody(form, 'v7')).toEqual({ baseVersion: 'v7', defaultTemplate: 'white', offered: ['neon', 'white'] });
    expect(sameAppearance(form, { defaultTemplate: 'white', offered: { neon: true, white: true } })).toBe(true);
    expect(sameAppearance(form, { defaultTemplate: 'neon', offered: { neon: true, white: true } })).toBe(false);
  });

  it('maps the API’s refusal of a default that is not offered', () => {
    expect(appearanceServerProblem([{ in: 'body', pointer: '/offered', code: 'default_not_offered', message: 'x' }])).toBe('appearance.error.defaultNotOffered');
    expect(appearanceServerProblem([{ in: 'body', pointer: '/offered', code: 'invalid_value', message: 'x' }])).toBeNull();
  });

  it('draws neon with the brand’s gradient and white with its fixed palette', () => {
    const swatches = templateSwatches(TEAL);
    expect(swatches.neon.canvas).toBe('#0A090E');
    expect(swatches.neon.button).toBe('linear-gradient(250deg, #11CCAA 0%, #0E9F8E 52%, #2255FF 100%)');
    expect(templateSwatches(DESIGN_GRADIENT_DARK).neon.button).toMatch(/^linear-gradient\(.*#7B2BFF.*#C21FD0.*#E0157A/);
    expect(swatches.white).toMatchObject({ canvas: '#FFFFFF', button: '#111114', accent: '#5B2FD9' });
    expect(templateSwatches(TEAL).white).toEqual(templateSwatches(DESIGN_GRADIENT_DARK).white);
  });
});

describe('the appearance page', () => {
  it('is in the navigation for roles with the config permission, and its swatches carry the templates’ colours', async () => {
    const api = fakeApi({ 'GET /v1/admin/appearance': () => view('neon', ['neon', 'white'], 'v1', TEAL) });
    renderPanel('/', api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Appearance' }));
    await screen.findByRole('heading', { name: 'App appearance' });
    expect(defaults().getByRole('radio', { name: 'Dark' })).toHaveProperty('checked', true);
    expect(defaults().getByRole('radio', { name: 'White' })).toHaveProperty('checked', false);
    const neon = screen.getByRole('img', { name: 'Preview of Dark' });
    const white = screen.getByRole('img', { name: 'Preview of White' });
    expect(neon.style.background).toBe('rgb(10, 9, 14)');
    expect(white.style.background).toBe('rgb(255, 255, 255)');
    // The neon button is the brand's gradient as the API names it; white's is the ink with a violet accent.
    expect(neon.innerHTML).toContain('linear-gradient');
    expect(neon.innerHTML).toContain('rgb(17, 204, 170)');
    expect(neon.innerHTML).toContain('rgb(34, 85, 255)');
    expect(neon.innerHTML).not.toContain('rgb(123, 43, 255)');
    expect(white.innerHTML).toContain('rgb(17, 17, 20)');
    expect(white.innerHTML).toContain('rgb(91, 47, 217)');
    expect(screen.getByRole('switch', { name: 'Offer Dark' }).hasAttribute('disabled')).toBe(true);
    // The default's switch is explained by the Default badge alone.
    expect(screen.getByRole('switch', { name: 'Offer Dark' }).getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(screen.getByRole('switch', { name: 'Offer Dark' }).getAttribute('aria-describedby')!)?.textContent).toBe('Default');
    expect(screen.getByRole('switch', { name: 'Offer White' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save changes' }).disabled).toBe(true);
    // No explanations around one choice and two switches, and no promise about when apps follow.
    expect(screen.queryByText(/second/i)).toBeNull();
    expect(screen.queryByText(/keeps that choice|pink|violet|Offered$|Not offered|Always offered/i)).toBeNull();
    expect(screen.getByText('Offered templates')).toBeTruthy();
  });

  it('changes the default and the offered templates, asks before saving, and shows what was saved', async () => {
    const put: { body?: unknown } = {};
    const api = fakeApi({ 'GET /v1/admin/appearance': () => view('neon', ['neon', 'white']), 'PUT /v1/admin/appearance': saving(put) });
    const user = userEvent.setup();
    renderPanel('/app/appearance', api);
    await user.click(await screen.findByRole('radiogroup', { name: 'Default template' }).then((group) => within(group).getByRole('radio', { name: 'White' })));
    // The new default is always offered; the old one may now be turned off.
    expect(screen.getByRole('switch', { name: 'Offer White' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('switch', { name: 'Offer Dark' }));
    expect(screen.getByText('Unsaved changes')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Default: White')).toBeTruthy();
    expect(within(dialog).getByText('Offered: White')).toBeTruthy();
    expect(within(dialog).queryByText(/second/i)).toBeNull();
    expect(api.of('PUT /v1/admin/appearance')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Save appearance' }));
    await screen.findByText('Saved.');
    expect(put.body).toEqual({ baseVersion: 'v1', defaultTemplate: 'white', offered: ['white'] });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    // The form starts again from the saved setting.
    expect(defaults().getByRole('radio', { name: 'White' })).toHaveProperty('checked', true);
    expect(screen.getByRole('switch', { name: 'Offer Dark' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save changes' }).disabled).toBe(true);
  });

  it('starts again from the newer setting when another admin saved meanwhile', async () => {
    let current = view('neon', ['neon', 'white'], 'v1');
    const api = fakeApi({
      'GET /v1/admin/appearance': () => current,
      'PUT /v1/admin/appearance': () => {
        // Admin A saved white as the default while this form was open.
        current = view('white', ['neon', 'white'], 'v9');
        return problem(409, 'conflict', { detail: 'The appearance was changed meanwhile.' });
      },
    });
    const user = userEvent.setup();
    renderPanel('/app/appearance', api);
    await user.click(await screen.findByRole('switch', { name: 'Offer White' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Save appearance' }));
    await screen.findByText('Another admin changed this meanwhile. Their setting is shown now.');
    expect(api.of('PUT /v1/admin/appearance')[0]!.body).toMatchObject({ baseVersion: 'v1' });
    // The page reads the setting again and shows it, with nothing unsaved.
    await waitFor(() => expect(defaults().getByRole('radio', { name: 'White' })).toHaveProperty('checked', true));
    expect(api.of('GET /v1/admin/appearance').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('switch', { name: 'Offer White' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('No unsaved changes')).toBeTruthy();
  });

  it('sends nothing when the confirmation is cancelled, and discards the changes on request', async () => {
    const api = fakeApi({ 'GET /v1/admin/appearance': () => view('neon', ['neon', 'white']) });
    const user = userEvent.setup();
    renderPanel('/app/appearance', api);
    await user.click(await screen.findByRole('switch', { name: 'Offer White' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.of('PUT /v1/admin/appearance')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByRole('switch', { name: 'Offer White' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('No unsaved changes')).toBeTruthy();
  });

  it('turns the API’s refusals into the panel’s words', async () => {
    let answer: unknown = problem(422, 'field_invalid', { detail: 'x', errors: [{ in: 'body', pointer: '/offered', code: 'default_not_offered', message: 'x' }] });
    const api = fakeApi({ 'GET /v1/admin/appearance': () => view('neon', ['neon', 'white']), 'PUT /v1/admin/appearance': () => answer });
    const user = userEvent.setup();
    renderPanel('/app/appearance', api);
    await user.click(await screen.findByRole('radiogroup', { name: 'Default template' }).then((group) => within(group).getByRole('radio', { name: 'White' })));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Save appearance' }));
    await screen.findByText('The default template must be offered.');

    answer = problem(403, 'forbidden');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Save appearance' }));
    await screen.findByText('Your role does not include this. Ask the owner if you need it.');
    expect(api.of('PUT /v1/admin/appearance')).toHaveLength(2);
  });

  it('shows the setting read-only to a role that may read it but not change it', async () => {
    signInAs({ ...owner, roles: ['viewer'], permissions: ['config.read'] });
    const api = fakeApi({ 'GET /v1/admin/appearance': () => view('white', ['neon', 'white']) });
    renderPanel('/app/appearance', api);
    await screen.findByText('Your role can see the appearance but not change it.');
    expect(defaults().getByRole('radio', { name: 'White' })).toHaveProperty('checked', true);
    expect(defaults().getByRole('radio', { name: 'Dark' }).matches(':disabled')).toBe(true);
    expect(screen.getByRole('switch', { name: 'Offer Dark' }).matches(':disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  });

  it('is hidden from roles without the config permission, and its page refuses them without a request', async () => {
    signInAs({ ...owner, roles: ['finance'], permissions: ['billing.read', 'billing.catalog'] });
    const api = fakeApi({});
    const { router } = renderPanel('/', api);
    await screen.findByRole('link', { name: 'Plans' });
    expect(screen.queryByRole('link', { name: 'Appearance' })).toBeNull();
    await router.navigate('/app/appearance');
    await screen.findByText('No access');
    expect(api.of('GET /v1/admin/appearance')).toHaveLength(0);
  });
});

describe('the appearance page in Persian and Turkish', () => {
  it('lays out right to left with the Persian names', async () => {
    const api = fakeApi({ 'GET /v1/admin/appearance': () => view('neon', ['neon', 'white']) });
    renderPanel('/app/appearance', api, { locale: 'fa' });
    await screen.findByRole('heading', { name: 'ظاهر اپ' });
    expect(document.documentElement.dir).toBe('rtl');
    expect(defaults('قالب پیش‌فرض').getByRole('radio', { name: 'تیره' })).toHaveProperty('checked', true);
    expect(defaults('قالب پیش‌فرض').getByRole('radio', { name: 'سفید' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'پیش‌نمایش تیره' })).toBeTruthy();
    expect(screen.getByText('قالب پیش‌فرض')).toBeTruthy();
  });

  it('uses one Persian term for offered templates, on the page, in the confirmation and in the answer', async () => {
    const put: { body?: unknown } = {};
    const api = fakeApi({ 'GET /v1/admin/appearance': () => view('neon', ['neon', 'white']), 'PUT /v1/admin/appearance': saving(put) });
    const user = userEvent.setup();
    renderPanel('/app/appearance', api, { locale: 'fa' });
    expect(await screen.findByText('قالب‌های قابل انتخاب')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'تیره قابل انتخاب باشد' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('switch', { name: 'سفید قابل انتخاب باشد' }));
    await user.click(screen.getByRole('button', { name: 'ذخیره‌ی تغییرات' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('پیش‌فرض: تیره')).toBeTruthy();
    expect(within(dialog).getByText('قابل انتخاب: تیره')).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/ارائه|همراه/);
    await user.click(within(dialog).getByRole('button', { name: 'ذخیره‌ی ظاهر' }));
    await screen.findByText('ذخیره شد.');
    expect(document.body.textContent).not.toMatch(/ارائه|همراه|ثانیه/);
  });

  it('names the templates in Turkish and lists them in the confirmation', async () => {
    const api = fakeApi({ 'GET /v1/admin/appearance': () => view('neon', ['neon']) });
    const user = userEvent.setup();
    renderPanel('/app/appearance', api, { locale: 'tr' });
    await user.click(await screen.findByRole('switch', { name: 'Beyaz sunulsun' }));
    expect(defaults('Varsayılan tema').getByRole('radio', { name: 'Koyu' })).toHaveProperty('checked', true);
    await user.click(screen.getByRole('button', { name: 'Değişiklikleri kaydet' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Varsayılan: Koyu')).toBeTruthy();
    expect(within(dialog).getByText('Sunulanlar: Koyu ve Beyaz')).toBeTruthy();
  });
});
