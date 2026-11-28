import { expandGrants, type AdminProvider } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { appliedSummary, missingSecrets, providerBody, providerFormOf } from '../src/lib/providerForm';
import { configList, configSaved, provider, providersView, rtcView, STORED, v } from './appFixtures';
import { adminWith, fakeApi, problem, renderPanel, resetPanel, signInAs, type Call } from './panel';

/**
 * `/app/providers` (owner only): where each provider's credentials come
 * from, its secrets by fingerprint only, which servers use them; the
 * write-only secret inputs, "Use deployment values", the SMS routing and
 * the calls network.
 */

const OWNER = adminWith(expandGrants(['*']), ['superadmin']);

beforeEach(() => {
  resetPanel();
  signInAs(OWNER);
});

function api(handlers: Record<string, (call: Call) => unknown> = {}) {
  return fakeApi({
    'GET /v1/admin/providers': () => providersView(),
    'GET /v1/admin/providers/rtc': () => rtcView(),
    'GET /v1/admin/config': configList(),
    ...handlers,
  });
}

/** A provider's row by its name. */
async function row(name: string) {
  const label = await screen.findByText(name, {
    selector: 'li span.font-medium',
  });
  return within(label.closest('li')!);
}

describe('the provider form', () => {
  it('starts from the panel’s entry, else the deployment’s, and sends only the secrets typed', () => {
    const view = providersView();
    const kavenegar = view.items.find((p) => p.kind === 'kavenegar')!;
    const form = providerFormOf(kavenegar);
    expect(form).toEqual({
      enabled: true,
      settings: { template: 'verify-otp' },
      secrets: {},
    });
    expect(missingSecrets(kavenegar, form)).toEqual([]);
    expect(providerBody(kavenegar, form)).toEqual({
      kind: 'kavenegar',
      baseVersion: kavenegar.version,
      enabled: true,
      settings: { template: 'verify-otp' },
    });
    const smsir = view.items.find((p) => p.kind === 'smsir')!;
    expect(providerFormOf(smsir).settings).toEqual({
      templateId: '100200',
      parameter: 'CODE',
    });
    // A deployment's key is not the panel's: an entry made here needs its own.
    expect(missingSecrets(smsir, providerFormOf(smsir))).toEqual(['apiKey']);
    expect(
      providerBody(smsir, {
        ...providerFormOf(smsir),
        secrets: { apiKey: ' key-12345678 ' },
      }),
    ).toMatchObject({
      settings: { templateId: 100200, parameter: 'CODE' },
      secrets: { apiKey: 'key-12345678' },
    });
  });

  it('counts the servers that use what is shown, and the ones on an older entry', () => {
    const kavenegar = providersView().items.find((p) => p.kind === 'kavenegar')!;
    expect(appliedSummary(kavenegar)).toEqual({ api: 2, worker: 0, older: 1 });
  });

  it('asks a Bazaar entry for the secrets of its access kind only', () => {
    const bazaar = providersView().items.find((p) => p.kind === 'bazaar')!;
    const form = providerFormOf(bazaar);
    expect(missingSecrets(bazaar, form)).toEqual([]);
    expect(
      missingSecrets(bazaar, {
        ...form,
        settings: { ...form.settings, auth: 'oauth' },
      }),
    ).toEqual(['clientSecret', 'refreshToken']);
    expect(providerBody(bazaar, form).settings).toMatchObject({
      auth: 'pishkhan',
      clientId: null,
    });
  });
});

describe('/app/providers', () => {
  it('shows each provider’s source, its secrets as fingerprints only, and the servers using them', async () => {
    renderPanel('/app/providers', api());
    const kavenegar = await row('Kavenegar');
    expect(kavenegar.getByText('Set here')).toBeTruthy();
    expect(kavenegar.getByText('Fingerprint a1b2c3d4e5f6')).toBeTruthy();
    expect(kavenegar.getByText('verify-otp')).toBeTruthy();
    expect(kavenegar.getByText('In use: API ×2, 1 older')).toBeTruthy();
    expect(kavenegar.getByRole('button', { name: 'Use deployment values' })).toBeTruthy();
    const smsir = await row('sms.ir');
    expect(smsir.getByText('Deployment')).toBeTruthy();
    expect(smsir.queryByRole('button', { name: 'Use deployment values' })).toBeNull();
    expect((await row('Telnyx')).getByText('Not set up')).toBeTruthy();
    const play = await row('Google Play');
    expect(play.getAllByText('Cannot be read').length).toBeGreaterThan(0);
    expect(play.getByText('Save the key again.')).toBeTruthy();
    expect((await row('Cafe Bazaar')).getByText('Off')).toBeTruthy();
    expect((await row('Firebase Cloud Messaging')).getByText('Deployment')).toBeTruthy();
    // The deployment's storage, LiveKit and moderation, read-only.
    expect((await row('Object storage and CDN')).getByText('media-private · media')).toBeTruthy();
    expect((await row('LiveKit')).getByText('Fingerprint 444444444444')).toBeTruthy();
    expect((await row('Automatic review')).getByText('Human review only')).toBeTruthy();
    // No secret ever reaches the page: only 12-hex fingerprints.
    expect(document.body.textContent).not.toMatch(/key-|BEGIN|private_key/);
  });

  it('never fills a secret, keeps the stored one when left empty, and sends what is typed once', async () => {
    const puts: Call[] = [];
    const fake = api({
      'PUT /v1/admin/providers/kavenegar': (call) => {
        puts.push(call);
        return provider('kavenegar', {
          source: 'panel',
          version: v('p-kavenegar-2'),
          panel: {
            enabled: true,
            settings: { template: 'new-otp' },
            secrets: {
              apiKey: {
                set: true,
                fingerprint: 'ffffffffffff',
                unreadable: false,
              },
            },
          },
        });
      },
    });
    const user = userEvent.setup();
    renderPanel('/app/providers', fake);
    await user.click((await row('Kavenegar')).getByRole('button', { name: 'Edit Kavenegar' }));
    const dialog = within(await screen.findByRole('dialog'));
    const key = dialog.getByLabelText<HTMLInputElement>('API key');
    expect(key.value).toBe('');
    expect(key.type).toBe('password');
    expect(key.placeholder).toBe('Leave empty to keep a1b2c3d4e5f6');
    const template = dialog.getByRole('textbox', { name: 'Template' });
    await user.clear(template);
    await user.type(template, 'new-otp');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toEqual({
      kind: 'kavenegar',
      baseVersion: v('p-kavenegar'),
      enabled: true,
      settings: { template: 'new-otp' },
    });
    expect(await screen.findByText('Fingerprint ffffffffffff')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks for a key a new entry needs, before asking the API, and shows the API’s refusal at its field', async () => {
    const fake = api({
      'PUT /v1/admin/providers/telnyx': () =>
        problem(422, 'field_invalid', {
          errors: [
            {
              in: 'body',
              pointer: '/secrets/apiKey',
              code: 'credentials_invalid',
              message: 'x',
            },
          ],
        }),
    });
    const user = userEvent.setup();
    renderPanel('/app/providers', fake);
    await user.click((await row('Telnyx')).getByRole('button', { name: 'Edit Telnyx' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByRole('textbox', { name: 'Verify profile ID' }), 'profile-1234');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    expect(dialog.getByText('Enter this key.')).toBeTruthy();
    expect(fake.of('PUT /v1/admin/providers/telnyx')).toHaveLength(0);
    await user.type(dialog.getByLabelText('API key'), 'KEY-not-a-real-one');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    expect(await dialog.findByText('This key cannot be used.')).toBeTruthy();
  });

  it('shows the API’s read-only refusal in the dialog (a deployment without the provider keys)', async () => {
    const fake = api({
      'PUT /v1/admin/providers/telnyx': () => problem(403, 'forbidden', { reason: 'read_only' }),
    });
    const user = userEvent.setup();
    renderPanel('/app/providers', fake);
    await user.click((await row('Telnyx')).getByRole('button', { name: 'Edit Telnyx' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByRole('textbox', { name: 'Verify profile ID' }), 'profile-1234');
    await user.type(dialog.getByLabelText('API key'), 'KEY-not-a-real-one');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    expect(await dialog.findByText('This setting cannot be changed from the panel.')).toBeTruthy();
    expect(fake.of('PUT /v1/admin/providers/telnyx')).toHaveLength(1);
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('confirms turning a provider off and a store’s new package', async () => {
    const puts: Call[] = [];
    const answer = (call: Call): AdminProvider => {
      puts.push(call);
      return provider('kavenegar', { source: 'off' });
    };
    const user = userEvent.setup();
    renderPanel(
      '/app/providers',
      api({
        'PUT /v1/admin/providers/kavenegar': answer,
        'PUT /v1/admin/providers/bazaar': answer,
      }),
    );
    await user.click((await row('Kavenegar')).getByRole('button', { name: 'Edit Kavenegar' }));
    let dialog = within(await screen.findByRole('dialog'));
    await user.click(dialog.getByRole('switch', { name: 'On' }));
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    const off = await screen.findByRole('alertdialog');
    expect(within(off).getByText('It stops being used at once.')).toBeTruthy();
    await user.click(within(off).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toMatchObject({ enabled: false });

    await user.click(
      (await row('Cafe Bazaar')).getByRole('button', {
        name: 'Edit Cafe Bazaar',
      }),
    );
    dialog = within(await screen.findByRole('dialog'));
    const name = dialog.getByRole('textbox', { name: 'Package name' });
    await user.clear(name);
    await user.type(name, 'app.example.next');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    const moved = await screen.findByRole('alertdialog');
    expect(within(moved).getByText('Purchases are checked with the new package from now on.')).toBeTruthy();
  });

  it('goes back to the deployment’s values after a confirm', async () => {
    const deletes: Call[] = [];
    const user = userEvent.setup();
    renderPanel(
      '/app/providers',
      api({
        'DELETE /v1/admin/providers/kavenegar': (call) => {
          deletes.push(call);
          return provider('kavenegar', {
            source: 'env',
            version: v('p-kavenegar-3'),
            env: {
              known: true,
              set: true,
              settings: { template: 'old-otp' },
              secrets: {
                apiKey: {
                  set: true,
                  fingerprint: '0f0f0f0f0f0f',
                  unreadable: false,
                },
              },
            },
          });
        },
      }),
    );
    await user.click(
      (await row('Kavenegar')).getByRole('button', {
        name: 'Use deployment values',
      }),
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('What is saved here is removed.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Use deployment values' }));
    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0]!.body).toEqual({ baseVersion: v('p-kavenegar') });
    expect(await screen.findByText('Fingerprint 0f0f0f0f0f0f')).toBeTruthy();
  });

  it('routes numbers by prefix, marks a provider not set up, and shows the test provider refused in production', async () => {
    const puts: Call[] = [];
    let refuse = true;
    const user = userEvent.setup();
    renderPanel(
      '/app/providers',
      api({
        'PUT /v1/admin/config/auth.sms_routing': (call) => {
          if (refuse)
            return problem(422, 'field_invalid', {
              errors: [
                {
                  in: 'body',
                  pointer: '/value/default/1',
                  code: 'fake_provider',
                  message: 'x',
                },
              ],
            });
          return configSaved(puts)(call);
        },
      }),
    );
    const routing = within(
      (
        await screen.findByText('Routing', {
          selector: '[data-slot="card-title"]',
        })
      ).closest<HTMLElement>('[data-slot="card"]')!,
    );
    expect(routing.getByRole<HTMLInputElement>('textbox', { name: 'Prefix' }).value).toBe('+98');
    // Telnyx has no credentials anywhere: marked where it is routed.
    const other = within(routing.getByRole('group', { name: 'Other numbers' }));
    expect(other.getByText('Not set up')).toBeTruthy();
    await user.selectOptions(other.getByRole('combobox', { name: 'Add provider' }), 'fake');
    await user.click(routing.getByRole('button', { name: 'Save' }));
    expect(await routing.findByText('The test provider is never used in production.')).toBeTruthy();
    refuse = false;
    await user.click(other.getByRole('button', { name: 'Remove Test provider' }));
    await user.click(routing.getByRole('button', { name: 'Add route' }));
    await user.click(routing.getByRole('button', { name: 'Save' }));
    expect(routing.getByText('Use + and a country or area code.')).toBeTruthy();
    await user.type(routing.getAllByRole('textbox', { name: 'Prefix' })[1]!, '90');
    await user.selectOptions(within(routing.getByRole('group', { name: 'Providers for +90' })).getByRole('combobox', { name: 'Add provider' }), 'telnyx');
    await user.click(within(routing.getByRole('group', { name: 'Providers for +98' })).getByRole('button', { name: 'Try sms.ir earlier' }));
    await user.click(routing.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toEqual({
      value: {
        routes: [
          { prefix: '+98', providers: ['smsir', 'kavenegar'] },
          { prefix: '+90', providers: ['telnyx'] },
        ],
        default: STORED['auth.sms_routing'].default,
      },
      baseVersion: v('auth.sms_routing'),
    });
  });

  it('saves the calls network with its version, a new secret only when typed', async () => {
    const puts: Call[] = [];
    const user = userEvent.setup();
    renderPanel(
      '/app/providers',
      api({
        'PUT /v1/admin/providers/rtc': (call) => {
          puts.push(call);
          return rtcView({ version: v('rtc-2'), credentialTtlSeconds: 7_200 });
        },
      }),
    );
    const rtc = within(
      (
        await screen.findByText('Calls network', {
          selector: '[data-slot="card-title"]',
        })
      ).closest<HTMLElement>('[data-slot="card"]')!,
    );
    expect(rtc.getByText('wss://rtc.example.com')).toBeTruthy();
    expect(rtc.getByLabelText<HTMLInputElement>('Relay secret').placeholder).toBe('Leave empty to keep 9a8b7c6d5e4f');
    const ttl = rtc.getByRole('textbox', {
      name: 'Credential lifetime (minutes)',
    });
    await user.clear(ttl);
    await user.type(ttl, '5');
    await user.click(rtc.getByRole('button', { name: 'Save' }));
    expect(rtc.getByText('Use a number from 10 to 1440.')).toBeTruthy();
    await user.clear(ttl);
    await user.type(ttl, '120');
    await user.click(rtc.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toEqual({
      baseVersion: v('rtc'),
      wsUrl: null,
      turnUrls: ['turn:relay.example.com:3478'],
      countries: ['IR'],
      credentialTtlSeconds: 7_200,
      maxLiveCalls: null,
    });
  });

  it('asks before removing the relay secret, naming the countries that lose the relay', async () => {
    const puts: Call[] = [];
    const user = userEvent.setup();
    renderPanel(
      '/app/providers',
      api({
        'GET /v1/admin/providers/rtc': () => rtcView({ countries: ['DE', 'GB'] }),
        'PUT /v1/admin/providers/rtc': (call) => {
          puts.push(call);
          return rtcView({ version: v('rtc-2') });
        },
      }),
    );
    const rtc = within((await screen.findByText('Calls network', { selector: '[data-slot="card-title"]' })).closest<HTMLElement>('[data-slot="card"]')!);
    await user.click(rtc.getByRole('button', { name: 'Remove secret' }));
    await user.click(rtc.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Remove the relay secret?')).toBeTruthy();
    expect(within(dialog).getByText('Calls from Germany and United Kingdom stop using the relay at once.')).toBeTruthy();
    expect(puts).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Remove secret' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toMatchObject({ sharedSecret: '' });
  });

  it('reads a secret’s fingerprint to a screen reader as one, and an unreadable one as such', async () => {
    renderPanel('/app/providers', api());
    const kavenegar = await row('Kavenegar');
    const chip = kavenegar.getByText('Fingerprint a1b2c3d4e5f6');
    expect(chip.className).toContain('sr-only');
    // The dots and digits are drawn for the eye only.
    expect(chip.parentElement!.querySelector('[aria-hidden="true"]')?.textContent).toContain('a1b2c3d4e5f6');
    expect((await row('Google Play')).getAllByText('Cannot be read').some((node) => node.className.includes('sr-only'))).toBe(true);
  });

  it('is the owner’s alone: the admin role gets "No access" and no request', async () => {
    signInAs(adminWith(expandGrants(['config.*']), ['admin']));
    const fake = api();
    renderPanel('/app/providers', fake);
    expect(await screen.findByText('No access')).toBeTruthy();
    expect(fake.of('GET /v1/admin/providers')).toHaveLength(0);
  });

  it('says the second factor is needed when the API asks for it', async () => {
    renderPanel(
      '/app/providers',
      fakeApi({
        'GET /v1/admin/providers': () => problem(403, 'forbidden', { reason: 'mfa_required' }),
      }),
    );
    expect(await screen.findByText('This change needs two-step sign-in. Sign in again with your code.')).toBeTruthy();
  });

  it('reads in Persian', async () => {
    renderPanel('/app/providers', api(), { locale: 'fa' });
    expect(await screen.findByRole('heading', { level: 1, name: 'سرویس‌دهنده‌ها' })).toBeTruthy();
    expect(await screen.findByText('کاوه‌نگار')).toBeTruthy();
    expect(screen.getAllByText('تنظیم در پنل').length).toBeGreaterThan(0);
  });
});
