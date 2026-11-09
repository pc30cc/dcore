import type { AdminMe, AdminPlan } from '@app/shared';
import { DirectionProvider } from '@radix-ui/react-direction';
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { useI18n } from '../src/i18n/useI18n';
import { resetAuthForTests } from '../src/lib/auth';
import { setFetchForTests } from '../src/lib/http';
import { queryClient } from '../src/lib/queries';
import { setRuntimeConfigForTests } from '../src/lib/runtimeConfig';
import { resetSessionForTests, setAccessToken, signedIn } from '../src/lib/session';
import { ThemeProvider } from '../src/lib/theme';
import { routes } from '../src/routes';

/**
 * The panel in a memory router against a fake API: each request goes to the
 * handler of its "METHOD /path" (query string dropped), which answers a JSON
 * body (200), `[status, body]`, or a Response. Unhandled requests fail the
 * test loudly (501).
 */

export const API = 'https://api.test';

export interface Call {
  method: string;
  path: string;
  body: unknown;
  credentials: RequestCredentials | undefined;
  authorization: string | null;
}

/** A JSON body, `[status, body]`, or a Response (or a promise of one). */
export type Handler = (call: Call) => unknown;

export function problem(status: number, code: string, extra: Record<string, unknown> = {}): [number, unknown] {
  return [status, { type: `urn:problem-type:${code}`, title: code, status, code, ...extra }];
}

export function fakeApi(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      credentials: init?.credentials,
      authorization: headers.get('authorization'),
    };
    calls.push(call);
    const handler = handlers[`${call.method} ${call.path}`];
    if (!handler) return new Response(JSON.stringify({ code: 'not_implemented', status: 501 }), { status: 501 });
    const answer = await handler(call);
    if (answer instanceof Response) return answer;
    if (Array.isArray(answer) && typeof answer[0] === 'number') {
      const [status, body] = answer as [number, unknown];
      return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }
    return new Response(answer === undefined ? null : JSON.stringify(answer), { status: answer === undefined ? 204 : 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchFn, calls, of: (key: string) => calls.filter((call) => `${call.method} ${call.path}` === key) };
}

export function resetPanel(): void {
  setRuntimeConfigForTests({ ok: true, config: { apiOrigin: API, cdnOrigin: null, persianFont: null } });
  resetSessionForTests();
  resetAuthForTests();
  queryClient.clear();
}

/** Signs an admin in without the sign-in steps (pages under test start signed in). */
export function signInAs(me: AdminMe): void {
  setAccessToken('test-access-token', new Date(Date.now() + 600_000).toISOString());
  signedIn(me);
}

function Shell({ children }: { children: ReactNode }) {
  const { dir } = useI18n();
  return <DirectionProvider dir={dir}>{children}</DirectionProvider>;
}

export function renderPanel(path: string, api: ReturnType<typeof fakeApi>, options: { locale?: 'en' | 'fa' | 'tr' } = {}) {
  setFetchForTests(api.fetchFn);
  if (options.locale) window.localStorage.setItem('admin.locale', options.locale);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const view = render(
    <StrictMode>
      <ThemeProvider>
        <I18nProvider>
          <QueryClientProvider client={queryClient}>
            <Shell>
              <RouterProvider router={router} />
            </Shell>
          </QueryClientProvider>
        </I18nProvider>
      </ThemeProvider>
    </StrictMode>,
  );
  return { ...view, router };
}

export const owner: AdminMe = {
  id: '1',
  email: 'owner@example.com',
  displayName: 'Sara Owner',
  roles: ['superadmin'],
  createdAt: '2026-11-01T10:00:00.000Z',
  createdBy: null,
  lastLoginAt: '2026-11-09T10:00:00.000Z',
  totpEnabled: true,
  disabledAt: null,
  lockedUntil: null,
  permissions: ['billing.read', 'billing.catalog', 'admins.read', 'admins.manage'],
  sessionId: '77',
};

const flags = {
  see_likes: false,
  rewind: false,
  read_receipts: false,
  incognito: false,
  travel_mode: false,
  advanced_filters: false,
  profile_views: false,
  second_look: false,
  priority_likes: false,
  audio_calls: true,
  video_calls: true,
};
const quotas = { daily_likes: 25, weekly_superlikes: 1, daily_dm: 0, weekly_dm_gift: 1, monthly_boosts: 0 };

export function plan(key: string, overrides: Partial<AdminPlan> = {}): AdminPlan {
  return {
    id: String(key.length),
    key,
    rank: 0,
    sort: 0,
    active: true,
    archivedAt: null,
    onSale: key !== 'free',
    names: { en: key[0]!.toUpperCase() + key.slice(1) },
    descriptions: {},
    badge: null,
    features: { ...flags },
    quotas: { ...quotas },
    hasLiveSubscriptions: false,
    updatedAt: '2026-11-09T12:00:00.000Z',
    ...overrides,
  };
}

export const catalog = {
  flags: Object.entries(flags).map(([key, value]) => ({ key, default: value })),
  quotas: Object.keys(quotas).map((key) => ({ key, default: 0 })),
};

export function planList(items: AdminPlan[]) {
  return { items, catalog };
}
