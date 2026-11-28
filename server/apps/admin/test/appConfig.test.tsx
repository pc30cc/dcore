import { expandGrants } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { closedBySave, countriesCheck, legalCheck, limitsCheck, maintenanceValue, raisedRequired, typedNumber, versionsCheck } from '../src/lib/appConfigForm';
import { configList, configSaved, STORED, v } from './appFixtures';
import { adminWith, fakeApi, problem, renderPanel, resetPanel, signInAs, type Call } from './panel';

/**
 * `/app/config`: one card per setting, each saving only its own keys with
 * the versions it read; the risky changes confirmed (a higher required
 * version typed again, maintenance on, sign-up closed, calls off, legal
 * versions raised, any retention change); the owner-only legal values and
 * the website's restore period read-only to others.
 */

const OWNER = adminWith(expandGrants(['*']), ['superadmin']);
const ADMIN = adminWith(expandGrants(['config.*', 'moderation.*', 'users.*']), ['admin']);
const READER = adminWith(['config.read'], ['analyst']);

beforeEach(() => {
  resetPanel();
  signInAs(OWNER);
});

function api(handlers: Record<string, (call: Call) => unknown> = {}) {
  return fakeApi({
    'GET /v1/admin/config': configList(),
    'GET /v1/admin/moderation/profiles': () => ({
      items: [],
      nextCursor: null,
    }),
    ...handlers,
  });
}

/** A card by its title. */
async function card(title: string) {
  const heading = await screen.findByText(title, {
    selector: '[data-slot="card-title"]',
  });
  return within(heading.closest<HTMLElement>('[data-slot="card"]')!);
}

describe('the settings forms', () => {
  it('read numbers typed in any digits and check the API’s bounds', () => {
    expect(typedNumber(' ۴۵ ')).toBe(45);
    expect(typedNumber('4.5')).toBeNull();
    const checked = versionsCheck({
      cafe_bazaar: { required: '50', recommended: '49' },
      google_play: { required: '2100000001', recommended: '1' },
    });
    expect(checked.value).toBeNull();
    expect(checked.problems).toMatchObject({
      'cafe_bazaar/recommended': { key: 'appConfig.error.belowRequired' },
      'google_play/required': { key: 'appConfig.error.range' },
    });
    expect(
      limitsCheck({
        swipes_per_hour: '59',
        messages_per_minute: '60',
        messages_per_conversation: '20',
        reports_per_day: '10',
      }).problems,
    ).toHaveProperty('swipes_per_hour');
  });

  it('names the stores whose required version rises, and what a save closes to sign-up', () => {
    const before = STORED['app.min_version'];
    expect(
      raisedRequired(before, {
        ...before,
        google_play: { required: 45, recommended: 45 },
      }),
    ).toEqual([{ store: 'google_play', code: 45 }]);
    expect(
      raisedRequired(before, {
        ...before,
        google_play: { required: 39, recommended: 44 },
      }),
    ).toEqual([]);
    const countries = STORED['signup.countries'];
    expect(
      closedBySave(countries, {
        default: { allowed: false },
        countries: [...countries.countries, { code: 'DE', allowed: false, unit: 'km', language: null }],
      }),
    ).toEqual({ others: true, codes: ['DE'] });
    // A row taken out falls back to the other countries' setting: removing an open country while they are closed closes it.
    const closedElsewhere = { default: { allowed: false }, countries: [{ code: 'IR', allowed: true, unit: 'km' as const, language: 'fa' as const }] };
    expect(closedBySave(closedElsewhere, { default: { allowed: false }, countries: [] })).toEqual({ others: false, codes: ['IR'] });
    // Taking out a closed row while the others are open opens it: nothing closes.
    expect(closedBySave({ default: { allowed: true }, countries: [{ code: 'IR', allowed: false, unit: 'km', language: null }] }, { default: { allowed: true }, countries: [] })).toEqual({ others: false, codes: [] });
    expect(
      countriesCheck({
        defaultAllowed: true,
        countries: [
          { rowId: 1, code: 'de', allowed: true, unit: 'mi', language: '' },
          { rowId: 2, code: 'DE', allowed: false, unit: 'km', language: 'en' },
        ],
      }).problems,
    ).toHaveProperty('countries/1/code');
  });

  it('leaves an empty maintenance message out, and refuses a lowered legal version', () => {
    expect(
      maintenanceValue({
        enabled: true,
        message: { fa: ' ', en: ' Back soon. ', tr: '' },
      }),
    ).toEqual({ enabled: true, message: { en: 'Back soon.' } });
    const checked = legalCheck(
      {
        versions: { terms: '1', privacy: '3', guidelines: '1' },
        name: '',
        email: '',
      },
      STORED['legal.versions'],
    );
    expect(checked.problems['versions/terms']).toEqual({
      key: 'appConfig.error.lowered',
    });
    expect(
      legalCheck(
        {
          versions: { terms: '2', privacy: '3', guidelines: '1' },
          name: ' ',
          email: '',
        },
        STORED['legal.versions'],
      ).contact,
    ).toEqual({ name: null, email: null });
  });
});

describe('/app/config', () => {
  it('reads the page’s settings in one request and saves a card’s own key with the version it read', async () => {
    const puts: Call[] = [];
    const fake = api({
      'PUT /v1/admin/config/limits.rates': configSaved(puts),
    });
    const user = userEvent.setup();
    renderPanel('/app/config', fake);
    const limits = await card('Limits per person');
    expect(fake.of('GET /v1/admin/config')[0]!.query['keys']!.split(',')).toContain('limits.rates');
    expect(fake.of('GET /v1/admin/config')[0]!.query['keys']).not.toContain('auth.sms_routing');
    const save = limits.getByRole<HTMLButtonElement>('button', {
      name: 'Save',
    });
    expect(save.disabled).toBe(true);
    const swipes = limits.getByRole('textbox', { name: 'Swipes an hour' });
    await user.clear(swipes);
    await user.type(swipes, '900');
    await user.click(save);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toEqual({
      value: { ...STORED['limits.rates'], swipes_per_hour: 900 },
      baseVersion: v('limits.rates'),
    });
    expect(await screen.findByText('Saved.')).toBeTruthy();
    // The card starts again from the stored value (a new card: its version moved).
    await waitFor(async () =>
      expect(
        (await card('Limits per person')).getByRole<HTMLButtonElement>('button', {
          name: 'Save',
        }).disabled,
      ).toBe(true),
    );
    expect(
      (await card('Limits per person')).getByRole<HTMLInputElement>('textbox', {
        name: 'Swipes an hour',
      }).value,
    ).toBe('900');
  });

  it('shows a range refused before asking, and one the API refuses at its field', async () => {
    const fake = api({
      'PUT /v1/admin/config/limits.rates': () =>
        problem(422, 'field_invalid', {
          errors: [
            {
              in: 'body',
              pointer: '/value/reports_per_day',
              code: 'out_of_range',
              message: 'x',
            },
          ],
        }),
    });
    const user = userEvent.setup();
    renderPanel('/app/config', fake);
    const limits = await card('Limits per person');
    const swipes = limits.getByRole('textbox', { name: 'Swipes an hour' });
    await user.clear(swipes);
    await user.type(swipes, '10');
    await user.click(limits.getByRole('button', { name: 'Save' }));
    expect(limits.getByText('Use a number from 60 to 1200.')).toBeTruthy();
    expect(fake.of('PUT /v1/admin/config/limits.rates')).toHaveLength(0);
    await user.clear(swipes);
    await user.type(swipes, '700');
    await user.click(limits.getByRole('button', { name: 'Save' }));
    expect(await limits.findByText('Use a number from 10 to 50.')).toBeTruthy();
    expect(limits.getByText('Fix the marked fields and try again.')).toBeTruthy();
  });

  it('asks to type the new required version again and names the store it must be live on', async () => {
    const puts: Call[] = [];
    const fake = api({
      'PUT /v1/admin/config/app.min_version': configSaved(puts),
    });
    const user = userEvent.setup();
    renderPanel('/app/config', fake);
    const versions = await card('App versions');
    const required = versions.getByRole('textbox', {
      name: 'Required version on Google Play',
    });
    await user.clear(required);
    await user.type(required, '44');
    await user.click(versions.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Builds below 44 on Google Play stop working until updated: make sure 44 is live on Google Play.')).toBeTruthy();
    const raise = within(dialog).getByRole<HTMLButtonElement>('button', {
      name: 'Raise',
    });
    expect(raise.disabled).toBe(true);
    await user.type(within(dialog).getByRole('textbox', { name: 'Type 44 for Google Play' }), '43');
    expect(raise.disabled).toBe(true);
    await user.clear(within(dialog).getByRole('textbox', { name: 'Type 44 for Google Play' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Type 44 for Google Play' }), '44');
    expect(raise.disabled).toBe(false);
    await user.click(raise);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toMatchObject({
      value: { google_play: { required: 44, recommended: 44 } },
      baseVersion: v('app.min_version'),
    });
  });

  it('saves a lower required version without asking, and refuses a suggested one below it', async () => {
    const puts: Call[] = [];
    const fake = api({
      'PUT /v1/admin/config/app.min_version': configSaved(puts),
    });
    const user = userEvent.setup();
    renderPanel('/app/config', fake);
    const versions = await card('App versions');
    const suggested = versions.getByRole('textbox', {
      name: 'Suggested version on Cafe Bazaar',
    });
    await user.clear(suggested);
    await user.type(suggested, '40');
    await user.click(versions.getByRole('button', { name: 'Save' }));
    expect(versions.getByText('Suggested cannot be below Required.')).toBeTruthy();
    const required = versions.getByRole('textbox', {
      name: 'Required version on Cafe Bazaar',
    });
    await user.clear(required);
    await user.type(required, '39');
    await user.click(versions.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('confirms turning maintenance on and sends only the messages written', async () => {
    const puts: Call[] = [];
    const fake = api({
      'PUT /v1/admin/config/app.maintenance': configSaved(puts),
    });
    const user = userEvent.setup();
    renderPanel('/app/config', fake);
    const maintenance = await card('Maintenance');
    const footer = maintenance.getByText('Leila Moradi').closest('[data-slot="card-footer"]')!;
    expect(footer.textContent).toMatch(/^Changed Nov 20, 2026, .+ by Leila Moradi/);
    await user.click(maintenance.getByRole('switch', { name: 'Maintenance mode' }));
    await user.type(maintenance.getByRole('textbox', { name: /Message \(Persian\)/ }), 'به‌زودی برمی‌گردیم');
    await user.click(maintenance.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('The app stops for everyone until you turn it off.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toEqual({
      value: {
        enabled: true,
        message: { fa: 'به‌زودی برمی‌گردیم', en: 'Back soon.' },
      },
      baseVersion: v('app.maintenance'),
    });
  });

  it('confirms turning a call kind off', async () => {
    const puts: Call[] = [];
    const user = userEvent.setup();
    renderPanel('/app/config', api({ 'PUT /v1/admin/config/calls.enabled': configSaved(puts) }));
    const calls = await card('Calls');
    await user.click(calls.getByRole('switch', { name: 'Video calls' }));
    await user.click(calls.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Turn video calls off?')).toBeTruthy();
    expect(within(dialog).getByText('New video calls stop; calls in progress continue.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await waitFor(() =>
      expect(puts[0]?.body).toEqual({
        value: { audio: true, video: false },
        baseVersion: v('calls.enabled'),
      }),
    );
  });

  it('adds a country by its code, names it, and confirms closing its sign-up', async () => {
    const puts: Call[] = [];
    const user = userEvent.setup();
    renderPanel('/app/config', api({ 'PUT /v1/admin/config/signup.countries': configSaved(puts) }));
    const countries = await card('Countries');
    expect(countries.getAllByRole<HTMLInputElement>('textbox', { name: 'Country code' })[0]!.value).toBe('IR');
    await user.click(countries.getByRole('button', { name: 'Add country' }));
    const codes = countries.getAllByRole('textbox', { name: 'Country code' });
    await user.type(codes[1]!, 'd');
    await user.click(countries.getByRole('button', { name: 'Save' }));
    expect(countries.getByText('Use a two-letter country code.')).toBeTruthy();
    await user.type(codes[1]!, 'e');
    expect(countries.getByText('Germany')).toBeTruthy();
    // A new row starts closed while other countries are open.
    expect(countries.getByRole('switch', { name: 'Sign-up in Germany' }).getAttribute('aria-checked')).toBe('false');
    await user.click(countries.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('New sign-ups from Germany are refused; existing accounts keep working.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Close sign-up' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toMatchObject({
      value: {
        default: { allowed: true },
        countries: [STORED['signup.countries'].countries[0], { code: 'DE', allowed: false, unit: 'km', language: null }],
      },
    });
  });

  it('confirms removing an open country while other countries are closed', async () => {
    const puts: Call[] = [];
    const user = userEvent.setup();
    renderPanel(
      '/app/config',
      api({
        'GET /v1/admin/config': configList({ 'signup.countries': { default: { allowed: false }, countries: [{ code: 'DE', allowed: true, unit: 'km', language: null }] } }),
        'PUT /v1/admin/config/signup.countries': configSaved(puts),
      }),
    );
    const countries = await card('Countries');
    await user.click(countries.getByRole('button', { name: 'Remove Germany' }));
    await user.click(countries.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('New sign-ups from Germany are refused; existing accounts keep working.')).toBeTruthy();
    expect(puts).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Close sign-up' }));
    await waitFor(() => expect(puts[0]?.body).toMatchObject({ value: { default: { allowed: false }, countries: [] } }));
  });

  it('sets a country\'s distance unit, keeping its stored language, without a confirm', async () => {
    const puts: Call[] = [];
    const user = userEvent.setup();
    renderPanel(
      '/app/config',
      api({
        'GET /v1/admin/config': configList({ 'signup.countries': { default: { allowed: true }, countries: [{ code: 'GB', allowed: true, unit: 'km', language: 'en' }] } }),
        'PUT /v1/admin/config/signup.countries': configSaved(puts),
      }),
    );
    const countries = await card('Countries');
    const unit = countries.getByRole<HTMLSelectElement>('combobox', { name: 'Distance unit in United Kingdom' });
    expect(unit.value).toBe('km');
    expect(within(unit).getAllByRole('option').map((o) => o.textContent)).toEqual(['Kilometres', 'Miles']);
    // The unit is the only choice per country besides sign-up: the language is not edited here.
    expect(countries.getAllByRole('combobox')).toHaveLength(1);
    await user.selectOptions(unit, 'mi');
    await user.click(countries.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(puts[0]!.body).toMatchObject({ value: { default: { allowed: true }, countries: [{ code: 'GB', allowed: true, unit: 'mi', language: 'en' }] } });
  });

  it('names the distance units in Persian', async () => {
    renderPanel('/app/config', api(), { locale: 'fa' });
    const countries = await card('کشورها');
    const unit = countries.getByRole<HTMLSelectElement>('combobox', { name: /^واحد فاصله در / });
    expect(within(unit).getAllByRole('option').map((o) => o.textContent)).toEqual(['کیلومتر', 'مایل']);
  });

  it('confirms raising a legal version by naming the texts asked again, and saves only the key that changed', async () => {
    const puts: Call[] = [];
    const user = userEvent.setup();
    renderPanel(
      '/app/config',
      api({
        'PUT /v1/admin/config/legal.versions': configSaved(puts),
        'PUT /v1/admin/config/safety.child_safety_contact': configSaved(puts),
      }),
    );
    const legal = await card('Legal');
    const terms = legal.getByRole('textbox', { name: 'Terms' });
    await user.clear(terms);
    await user.type(terms, '1');
    await user.click(legal.getByRole('button', { name: 'Save' }));
    expect(legal.getByText('A version can only go up.')).toBeTruthy();
    await user.clear(terms);
    await user.type(terms, '3');
    await user.click(legal.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Everyone is asked to accept the terms again.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.path).toBe('/v1/admin/config/legal.versions');
  });

  it('confirms every retention change with the policy, keeps the restore period read-only, and stops at the first refusal', async () => {
    const fake = api({
      'PUT /v1/admin/config/retention.unmatched_messages_days': () => problem(503, 'service_unavailable'),
      'PUT /v1/admin/config/retention.message_requests_days': configSaved(),
    });
    const user = userEvent.setup();
    renderPanel('/app/config', fake);
    const retention = await card('Data retention');
    expect(
      retention.getByRole<HTMLInputElement>('textbox', {
        name: /Restore period of deleted accounts/,
      }).disabled,
    ).toBe(true);
    expect(retention.getByText('This setting cannot be changed from the panel.')).toBeTruthy();
    for (const [name, value] of [
      ['Messages after an unmatch', '14'],
      ['Answered message requests', '60'],
    ] as const) {
      const input = retention.getByRole('textbox', { name });
      await user.clear(input);
      await user.type(input, value);
    }
    await user.click(retention.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('The privacy policy states these lengths: update it first.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await retention.findByText('The service is busy. Try again in a moment.')).toBeTruthy();
    expect(fake.of('PUT /v1/admin/config/retention.unmatched_messages_days')).toHaveLength(1);
    expect(fake.of('PUT /v1/admin/config/retention.message_requests_days')).toHaveLength(0);
  });

  it('reloads the settings when another admin saved meanwhile', async () => {
    const fake = api({
      'PUT /v1/admin/config/onboarding.waitlist': () => problem(409, 'conflict', { reason: 'settings_changed' }),
    });
    const user = userEvent.setup();
    renderPanel('/app/config', fake);
    const signup = await card('Sign-up');
    await user.click(signup.getByRole('switch', { name: 'Review new profiles first' }));
    await user.click(signup.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('New sign-ups wait for review before others see them.')).toBeTruthy();
    const reads = fake.of('GET /v1/admin/config').length;
    await user.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByText('Someone changed this meanwhile. The latest is shown.')).toBeTruthy();
    await waitFor(() => expect(fake.of('GET /v1/admin/config').length).toBeGreaterThan(reads));
  });

  it('says when a change needs the second factor', async () => {
    const user = userEvent.setup();
    renderPanel(
      '/app/config',
      api({
        'PUT /v1/admin/config/safety.child_safety_contact': () => problem(403, 'forbidden', { reason: 'mfa_required' }),
      }),
    );
    const legal = await card('Legal');
    await user.clear(legal.getByRole('textbox', { name: 'Name' }));
    await user.click(legal.getByRole('button', { name: 'Save' }));
    expect(await legal.findByText('This change needs two-step sign-in. Sign in again with your code.')).toBeTruthy();
  });

  it('links the waitlist to the new-profile queue for a moderator', async () => {
    renderPanel('/app/config', api());
    const signup = await card('Sign-up');
    expect(signup.getByRole('link', { name: 'New profiles' }).getAttribute('href')).toBe('/moderation/profiles');
  });

  it('gives the admin role every card but the owner’s legal values, which read as read-only', async () => {
    signInAs(ADMIN);
    renderPanel('/app/config', api());
    for (const title of ['Legal', 'Data retention']) {
      const owned = await card(title);
      expect(owned.getByText('Read only')).toBeTruthy();
      expect(owned.queryByRole('button', { name: 'Save' })).toBeNull();
    }
    expect((await card('App versions')).getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.queryByText('Your role can see these settings but not change them.')).toBeNull();
  });

  it('shows a reader every setting, changes nothing and offers no button', async () => {
    signInAs(READER);
    renderPanel('/app/config', api());
    expect(await screen.findByText('Your role can see these settings but not change them.')).toBeTruthy();
    expect(screen.queryAllByRole('button', { name: 'Save' })).toHaveLength(0);
    expect(screen.getByRole('switch', { name: 'Maintenance mode' }).closest('fieldset')?.disabled).toBe(true);
    expect(screen.queryByRole('link', { name: 'New profiles' })).toBeNull();
  });

  it('shows a failed read with a retry', async () => {
    renderPanel(
      '/app/config',
      fakeApi({
        'GET /v1/admin/config': () => problem(500, 'internal', { requestId: 'req-1' }),
      }),
    );
    expect(await screen.findByText('It could not be loaded')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('reads in Persian, with Persian digits, and takes Persian digits typed', async () => {
    const puts: Call[] = [];
    const user = userEvent.setup();
    renderPanel('/app/config', api({ 'PUT /v1/admin/config/limits.rates': configSaved(puts) }), { locale: 'fa' });
    const limits = await card('محدودیت‌های هر کاربر');
    const swipes = limits.getByRole<HTMLInputElement>('textbox', {
      name: 'کشیدن کارت در ساعت',
    });
    expect(swipes.value).toBe('۶۰۰');
    expect(limits.getByText('۶۰ تا ۱۲۰۰')).toBeTruthy();
    await user.clear(swipes);
    await user.type(swipes, '۹۰۰');
    await user.click(limits.getByRole('button', { name: 'ذخیره' }));
    await waitFor(() => expect((puts[0]?.body as { value: { swipes_per_hour: number } } | undefined)?.value.swipes_per_hour).toBe(900));
  });
});
