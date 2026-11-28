import { expandGrants } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { brandBody, brandFormOf, brandProblems, changedBrandFields, previewable } from '../src/lib/brandForm';
import { setRuntimeConfigForTests } from '../src/lib/runtimeConfig';
import { brandView, v } from './appFixtures';
import { adminWith, API, fakeApi, problem, renderPanel, resetPanel, signInAs, type Call } from './panel';

/**
 * `/app/brand`: the run-time name, support e-mail, legal links and welcome
 * pictures (an empty field is brand.json's, shown as the placeholder), and
 * what is built into the app, read-only.
 */

const ADMIN = adminWith(expandGrants(['config.*']), ['admin']);

beforeEach(() => {
  resetPanel();
  setRuntimeConfigForTests({
    ok: true,
    config: {
      apiOrigin: API,
      cdnOrigin: 'https://cdn.test',
      persianFont: null,
      defaultLocale: 'en',
    },
  });
  signInAs(ADMIN);
});

describe('the brand form', () => {
  it('sends an empty field as null (brand.json’s value) and the pictures in their order', () => {
    const form = brandFormOf(brandView());
    expect(form.values.appName).toBe('Spark Prime');
    expect(form.values.termsUrl).toBe('');
    const body = brandBody(
      {
        ...form,
        values: {
          ...form.values,
          appName: '',
          supportEmail: ' help@example.com ',
        },
      },
      v('brand'),
    );
    expect(body).toMatchObject({
      baseVersion: v('brand'),
      appName: null,
      supportEmail: 'help@example.com',
      termsUrl: null,
      welcomeImages: ['https://cdn.test/w/1.jpg', 'https://other.test/w/2.jpg'],
    });
  });

  it('refuses a name with braces, an http link, a link off the brand’s domains, a picture off the CDN and one listed twice', () => {
    const view = brandView();
    const form = brandFormOf(view);
    const problems = brandProblems(
      {
        values: {
          ...form.values,
          appName: 'Spark {x}',
          privacyUrl: 'http://example.com/p',
          deleteAccountUrl: 'https://look-alike.test/delete',
        },
        images: [...form.images, { rowId: 99, url: 'https://cdn.test/w/1.jpg' }],
      },
      view,
    );
    expect(problems).toEqual({
      appName: 'brand.error.name',
      privacyUrl: 'brand.error.url',
      deleteAccountUrl: 'brand.error.host',
      'images/1': 'brand.error.media',
      'images/2': 'brand.error.duplicate',
    });
  });

  it('takes a Persian name with a half-space, and refuses invisible direction marks, as the API does', () => {
    const view = brandView({ welcomeImages: [] });
    const named = (appName: string) => brandProblems({ ...brandFormOf(view), values: { ...brandFormOf(view).values, appName } }, view)['appName'];
    expect(named('هم\u200cدم')).toBeUndefined();
    expect(named('App\u202e')).toBe('brand.error.name');
    expect(named('A\u200eB')).toBe('brand.error.name');
  });

  it('lists what changed, and previews only pictures on the CDN', () => {
    const initial = brandFormOf(brandView());
    expect(
      changedBrandFields(
        {
          ...initial,
          values: { ...initial.values, termsUrl: 'https://x.test/t' },
        },
        initial,
      ),
    ).toEqual(['brand.termsUrl']);
    expect(changedBrandFields({ ...initial, images: [...initial.images].reverse() }, initial)).toEqual(['brand.welcome.title']);
    expect(previewable('https://cdn.test/w/1.jpg', 'https://cdn.test')).toBe(true);
    expect(previewable('https://other.test/w/2.jpg', 'https://cdn.test')).toBe(false);
    expect(previewable('https://cdn.test/w/1.jpg', null)).toBe(false);
  });
});

describe('/app/brand', () => {
  function api(handlers: Record<string, (call: Call) => unknown> = {}) {
    return fakeApi({ 'GET /v1/admin/brand': () => brandView(), ...handlers });
  }

  it('shows the build values as placeholders, previews CDN pictures only, and saves after a confirm that lists the changes', async () => {
    const puts: Call[] = [];
    const fake = api({
      'PUT /v1/admin/brand': (call) => {
        puts.push(call);
        return brandView({
          version: v('brand-2'),
          saved: {},
          welcomeImages: [],
        });
      },
    });
    const user = userEvent.setup();
    renderPanel('/app/brand', fake);
    const name = await screen.findByRole<HTMLInputElement>('textbox', {
      name: /App name/,
    });
    expect(name.value).toBe('Spark Prime');
    expect(name.placeholder).toBe('Spark');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Terms' }).placeholder).toBe('https://example.com/terms');
    expect(screen.getByRole('link', { name: 'Open Terms' }).getAttribute('href')).toBe('https://example.com/terms');
    // Only the CDN's picture is drawn (the panel loads images from the CDN alone).
    expect(document.querySelectorAll('main img')).toHaveLength(1);
    await user.clear(name);
    await user.click(screen.getByRole('button', { name: 'Remove picture 2' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['App name', 'Welcome pictures']);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toMatchObject({
      baseVersion: v('brand'),
      appName: null,
      welcomeImages: ['https://cdn.test/w/1.jpg'],
    });
    expect(await screen.findByText('The app’s own pictures are shown.')).toBeTruthy();
  });

  it('adds, moves and removes pictures, at most sixteen', async () => {
    const user = userEvent.setup();
    renderPanel(
      '/app/brand',
      api({
        'GET /v1/admin/brand': () =>
          brandView({
            welcomeImages: Array.from({ length: 15 }, (_, i) => `https://cdn.test/w/${i}.jpg`),
          }),
      }),
    );
    const add = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'Add picture',
    });
    await user.click(add);
    expect(add.disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Move picture 2 up' }));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Picture 1' }).value).toBe('https://cdn.test/w/1.jpg');
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Move picture 1 up',
      }).disabled,
    ).toBe(true);
    // The empty picture added is refused before asking.
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText('Use an https:// address.')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('keeps the support e-mail and the legal links to config.legal; the name and pictures still save', async () => {
    const puts: Call[] = [];
    const user = userEvent.setup();
    renderPanel(
      '/app/brand',
      api({
        'GET /v1/admin/brand': () => brandView({ welcomeImages: ['https://cdn.test/w/1.jpg'] }),
        'PUT /v1/admin/brand': (call) => {
          puts.push(call);
          return brandView({ version: v('brand-2') });
        },
      }),
    );
    const email = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Support e-mail' });
    expect(email.disabled).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Account deletion' }).disabled).toBe(true);
    expect(screen.getByText('Read only')).toBeTruthy();
    const name = screen.getByRole<HTMLInputElement>('textbox', { name: /App name/ });
    await user.clear(name);
    await user.type(name, 'Spark Two');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toMatchObject({ appName: 'Spark Two', supportEmail: null, deleteAccountUrl: null });
  });

  it('shows the API’s refusal of a link or picture host at its field', async () => {
    signInAs(adminWith([...expandGrants(['config.*']), 'config.legal'], ['superadmin']));
    const user = userEvent.setup();
    renderPanel(
      '/app/brand',
      api({
        'GET /v1/admin/brand': () => brandView({ welcomeImages: ['https://cdn.test/w/1.jpg'] }),
        'PUT /v1/admin/brand': () =>
          problem(422, 'field_invalid', {
            errors: [
              { in: 'body', pointer: '/privacyUrl', code: 'host_not_allowed', message: 'x' },
              { in: 'body', pointer: '/welcomeImages/0', code: 'host_not_allowed', message: 'x' },
            ],
          }),
      }),
    );
    await user.type(await screen.findByRole('textbox', { name: 'Privacy policy' }), 'https://example.com/privacy-2');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Use an address on the brand’s own domains.')).toBeTruthy();
    expect(screen.getByText('Use a picture from the app’s media server.')).toBeTruthy();
  });

  it('shows a refusal at its field, and stops every save when the database holds another brand', async () => {
    signInAs(adminWith([...expandGrants(['config.*']), 'config.legal'], ['superadmin']));
    let answer: unknown = problem(422, 'field_invalid', {
      errors: [
        {
          in: 'body',
          pointer: '/welcomeImages/0',
          code: 'duplicate',
          message: 'x',
        },
      ],
    });
    const user = userEvent.setup();
    renderPanel('/app/brand', api({ 'GET /v1/admin/brand': () => brandView({ welcomeImages: ['https://cdn.test/w/1.jpg'] }), 'PUT /v1/admin/brand': () => answer }));
    await user.type(await screen.findByRole('textbox', { name: 'Support e-mail' }), 'help@example.com');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Save',
      }),
    );
    expect(await screen.findByText('This picture is listed twice.')).toBeTruthy();
    answer = problem(409, 'conflict', { reason: 'brand_mismatch' });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Save',
      }),
    );
    expect(await screen.findByText('This database holds another brand. Nothing can be saved here.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  });

  it('shows the build values read-only, and a reader no button', async () => {
    signInAs(adminWith(['config.read'], ['analyst']));
    renderPanel('/app/brand', api());
    expect(await screen.findByText('Your role can see the brand but not change it.')).toBeTruthy();
    expect(screen.getByText('Changes with a new app version')).toBeTruthy();
    expect(screen.getByText('_template')).toBeTruthy();
    expect(screen.getAllByText('#5B2FD9').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add picture' })).toBeNull();
  });

  it('reads in Persian', async () => {
    renderPanel('/app/brand', api(), { locale: 'fa' });
    expect(await screen.findByRole('heading', { level: 1, name: 'برند' })).toBeTruthy();
    expect(screen.getByText('ساخته‌شده در اپ')).toBeTruthy();
  });
});
