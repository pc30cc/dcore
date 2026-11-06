import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  accountDeletionConfirmBody,
  accountDeletionErrorStep,
  accountDeletionFormFields,
  accountDeletionGoogleBody,
  accountDeletionRedirect,
  accountDeletionRoutes,
  accountDeletionStartBody,
  type AccountDeletionRoute,
  type Locale,
} from '@app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { FIXTURE_API_ORIGIN, FIXTURE_GRACE_DAYS, FIXTURE_SITE } from './support/fixture';
import { all, attr, first, formData, textOf, type Element } from './support/html';
import { BuiltSite } from './support/site';

/**
 * The deletion flow as a browser without JavaScript runs it: read the page,
 * fill in the form, post exactly what the form holds, follow the API's 303
 * to the next static page. The API is a mock of the public deletion routes
 * in form mode, built on the shared contract module the real routes use.
 */
const site = new BuiltSite(inject('fixtureDist'), FIXTURE_SITE);
const CODE = '483920';
const GOOD_ID_TOKEN = 'header.payload.signature';

interface Received {
  route: AccountDeletionRoute;
  contentType: string | undefined;
  origin: string | undefined;
  fields: [string, string][];
}

const received: Received[] = [];
const pending = new Map<string, { locale: Locale; code: string }>();

function digits(phone: string): string {
  return phone.replace(/[^0-9+]/g, '');
}

function routeOf(url: string | undefined): AccountDeletionRoute | undefined {
  return (Object.entries(accountDeletionRoutes) as [AccountDeletionRoute, string][]).find(([, path]) => path === url)?.[0];
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function seeOther(res: ServerResponse, location: string): void {
  res.writeHead(303, { location }).end();
}

/** The mock API: the three public routes, answering a form post with a 303 back to the site. */
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const route = routeOf(req.url);
  if (req.method !== 'POST' || route === undefined) {
    res.writeHead(404).end();
    return;
  }
  const contentType = req.headers['content-type'];
  if (contentType !== 'application/x-www-form-urlencoded') {
    res.writeHead(415).end();
    return;
  }
  const fields = [...new URLSearchParams(await readBody(req))];
  received.push({ route, contentType, origin: req.headers.origin, fields });
  const body = Object.fromEntries(fields);
  const fail = (locale: Locale, error: string) => seeOther(res, accountDeletionRedirect(FIXTURE_SITE, locale, accountDeletionErrorStep[route], { error }));
  const locale: Locale = body['locale'] === 'en' || body['locale'] === 'tr' ? body['locale'] : 'fa';

  if (route === 'start') {
    const parsed = accountDeletionStartBody.safeParse(body);
    if (!parsed.success) return fail(locale, 'phone_invalid');
    // The same answer whether or not an account uses the number.
    pending.set(digits(parsed.data.phone), { locale: parsed.data.locale, code: CODE });
    return seeOther(res, accountDeletionRedirect(FIXTURE_SITE, parsed.data.locale, 'verify', { requestToken: 'r'.repeat(32) }));
  }
  if (route === 'confirm') {
    const parsed = accountDeletionConfirmBody.safeParse(body);
    if (!parsed.success || !('phone' in parsed.data)) return fail(locale, 'otp_invalid');
    const request = pending.get(digits(parsed.data.phone));
    if (request?.code !== parsed.data.code) return fail(parsed.data.locale, 'otp_invalid');
    pending.delete(digits(parsed.data.phone));
    return seeOther(res, accountDeletionRedirect(FIXTURE_SITE, request.locale, 'done'));
  }
  const parsed = accountDeletionGoogleBody.safeParse(body);
  if (!parsed.success || parsed.data.idToken !== GOOD_ID_TOKEN) return fail(locale, 'google_token_invalid');
  return seeOther(res, accountDeletionRedirect(FIXTURE_SITE, parsed.data.locale ?? 'fa', 'done'));
}

let server: Server;
let apiBase = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      res.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(() => {
  received.length = 0;
  pending.clear();
});

function formById(page: Element, id: string): Element {
  const form = first(page, (e) => e.tag === 'form' && attr(e, 'id') === id);
  if (!form) throw new Error(`no form #${id}`);
  return form;
}

/**
 * Submits a form as a browser without JavaScript does: method and action
 * from the form, the urlencoded fields, the page's origin. The build's API
 * host is answered by the mock server, as DNS would point it there.
 * Returns the site path the 303 leads to.
 */
async function submit(form: Element, values: Record<string, string>): Promise<string> {
  expect(attr(form, 'method')).toBe('post');
  expect(attr(form, 'enctype')).toBeUndefined();
  const action = attr(form, 'action') ?? '';
  expect(action.startsWith(`${FIXTURE_API_ORIGIN}/`)).toBe(true);
  for (const field of all(form, (e) => e.tag === 'input' && e.attrs.has('required'))) {
    expect(values[attr(field, 'name') ?? ''], `required ${attr(field, 'name')}`).toBeTruthy();
  }
  const response = await fetch(action.replace(FIXTURE_API_ORIGIN, apiBase), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: FIXTURE_SITE },
    body: formData(form, values).toString(),
    redirect: 'manual',
  });
  expect(response.status).toBe(303);
  const location = response.headers.get('location') ?? '';
  const local = site.localPath(location);
  expect(local, location).toBeDefined();
  expect(site.has(local!), location).toBe(true);
  return local!;
}

function visibleError(urlPath: string): string | undefined {
  const fragment = urlPath.split('#')[1];
  if (fragment === undefined) return undefined;
  const page = site.page(urlPath);
  const element = first(page, (e) => attr(e, 'id') === fragment);
  expect(element, `#${fragment} on ${urlPath}`).toBeDefined();
  expect(attr(element!, 'class')).toBe('error');
  return textOf(element!);
}

describe('account deletion without JavaScript', () => {
  it('posts the start, confirm and Google forms with exactly their contract fields', () => {
    for (const locale of ['fa', 'en', 'tr'] as const) {
      const request = site.page(`/${locale}/delete-account/`);
      const verify = site.page(`/${locale}/delete-account/verify/`);
      const cases: [Element, AccountDeletionRoute][] = [
        [formById(request, 'start-form'), 'start'],
        [formById(verify, 'confirm-form'), 'confirm'],
        [formById(request, 'google-form'), 'google'],
      ];
      for (const [form, route] of cases) {
        expect(attr(form, 'action')).toBe(`${FIXTURE_API_ORIGIN}${accountDeletionRoutes[route]}`);
        expect(attr(form, 'method')).toBe('post');
        expect([...formData(form).keys()].sort()).toEqual([...accountDeletionFormFields[route]].sort());
        expect(formData(form).get('locale')).toBe(locale);
      }
    }
  });

  it('deletes an account: phone, code, done', async () => {
    const verifyPath = await submit(formById(site.page('/fa/delete-account/'), 'start-form'), { phone: '+۹۸ ۹۱۲ ۱۲۳ ۴۵۶۷' });
    expect(verifyPath.split('?')[0]).toBe('/fa/delete-account/verify/');
    expect(received[0]).toMatchObject({
      route: 'start',
      contentType: 'application/x-www-form-urlencoded',
      origin: FIXTURE_SITE,
      fields: [
        ['locale', 'fa'],
        ['phone', '+۹۸ ۹۱۲ ۱۲۳ ۴۵۶۷'],
      ],
    });

    const donePath = await submit(formById(site.page(verifyPath), 'confirm-form'), { phone: '+98 912 123 4567', code: '۴۸۳۹۲۰' });
    expect(donePath).toBe('/fa/delete-account/done/');
    expect(received[1]?.fields.sort()).toEqual(
      [
        ['locale', 'fa'],
        ['phone', '+98 912 123 4567'],
        ['code', '۴۸۳۹۲۰'],
      ].sort(),
    );
    expect(textOf(site.page(donePath))).toContain(new Intl.NumberFormat('fa').format(FIXTURE_GRACE_DAYS));
  });

  it('sends a wrong code back to the code page with its message', async () => {
    const verifyPath = await submit(formById(site.page('/en/delete-account/'), 'start-form'), { phone: '+90 532 123 45 67' });
    const back = await submit(formById(site.page(verifyPath), 'confirm-form'), { phone: '+90 532 123 45 67', code: '000000' });
    expect(back).toBe('/en/delete-account/verify/?e=otp_invalid#e-otp_invalid');
    expect(visibleError(back)).toContain('That code is not right');
  });

  it('sends an invalid number back to the request page with its message', async () => {
    const back = await submit(formById(site.page('/tr/delete-account/'), 'start-form'), { phone: 'not a number' });
    expect(back).toBe('/tr/delete-account/?e=phone_invalid#e-phone_invalid');
    expect(visibleError(back)).toContain('telefon numarasına benzemiyor');
  });

  it('shows a message for every error a form can come back with, hidden until targeted', () => {
    const css = all(site.page('/en/delete-account/'), (e) => e.tag === 'link' && attr(e, 'rel') === 'stylesheet')
      .map((e) => site.text(attr(e, 'href')!))
      .join('\n');
    expect(css).toMatch(/\.error\{[^}]*display:none/);
    expect(css).toMatch(/\.error:target\{[^}]*display:block/);
    for (const route of ['start', 'confirm', 'google'] as const) {
      for (const code of ['rate_limited', 'maintenance', 'error', 'some_new_code']) {
        const target = accountDeletionRedirect(FIXTURE_SITE, 'en', accountDeletionErrorStep[route], { error: code });
        expect(visibleError(site.localPath(target)!), target).toBeTruthy();
      }
    }
    expect(visibleError('/en/delete-account/verify/#e-otp_expired')).toContain('expired');
    expect(visibleError('/en/delete-account/verify/#e-otp_locked')).toContain('Too many wrong codes');
    expect(visibleError('/en/delete-account/#e-sms_unavailable')).toContain('text messages');
  });

  it('posts the Google ID token as a plain form', async () => {
    const form = formById(site.page('/en/delete-account/'), 'google-form');
    expect(await submit(form, { idToken: GOOD_ID_TOKEN })).toBe('/en/delete-account/done/');
    expect(received[0]?.fields).toEqual([
      ['idToken', GOOD_ID_TOKEN],
      ['locale', 'en'],
    ]);
    expect(await submit(form, { idToken: 'forged' })).toBe('/en/delete-account/?e=google_token_invalid#e-google_token_invalid');
  });

  it('loads Google’s script on the request page only, and tells a visitor without JavaScript what to do', () => {
    const page = site.page('/en/delete-account/');
    const noscript = first(page, (e) => e.tag === 'noscript');
    expect(textOf(noscript!)).toContain('needs JavaScript');
    const scripts = all(page, (e) => e.tag === 'script').map((e) => e.children.map((c) => ('text' in c ? c.text : '')).join(''));
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("'https://accounts.google.com/gsi/client'");
    expect(all(site.page('/en/delete-account/verify/'), (e) => e.tag === 'script')).toEqual([]);
  });
});

describe('the template build', () => {
  const template = new BuiltSite(inject('templateDist'), 'https://example.com');

  it('posts to the brand’s API and offers no Google button without a client id', () => {
    const page = template.page('/en/delete-account/');
    expect(attr(formById(page, 'start-form'), 'action')).toBe('https://api.example.com/v1/public/account-deletion/start');
    expect(first(page, (e) => attr(e, 'id') === 'google-form')).toBeUndefined();
    expect(all(page, (e) => e.tag === 'script')).toEqual([]);
  });
});
