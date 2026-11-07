import { appStores, isLocale, store as storeCodes, type AppConfig, type AppStore, type Locale } from '@app/shared';
import type { FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { HttpProblem } from '../lib/problem.js';

/**
 * Who is calling: every app request carries `X-Client: <store>/<versionCode>`
 * (`bazaar/12031`). From it, and from settings held in memory:
 *
 * - `426 upgrade_required` (`minVersionCode`) when the build is below the
 *   store's required version (app_config `app.min_version`);
 * - `503 maintenance` (`message`, in the request's language) while
 *   app_config `app.maintenance` is on.
 *
 * Exempt from all three: the probes and anything outside `/v1`, webhooks,
 * admin routes and the website's public routes (none of them is the app).
 * `GET /v1/config` needs the header but answers during maintenance and to
 * old builds, so an old app can still learn what to show. Logout and
 * in-app deletion answer old builds too (deletion always works). A route
 * changes any of this with `config: { client: { … } }`.
 *
 * The request's language comes from `Accept-Language` (fa, en, tr).
 */

export interface ClientInfo {
  store: AppStore;
  /** The store code of sessions and devices (1 play, 2 bazaar). */
  storeCode: number;
  versionCode: number;
}

export interface ClientPolicy {
  /** Required version code per store; 0 lets every build in. */
  minVersion: Readonly<Record<AppStore, number>>;
  maintenance: { enabled: boolean; message: Partial<Record<Locale, string>> };
}

/** Where the policy comes from: process memory, refreshed when config changes (never read on a request path). */
export type ClientPolicySource = () => ClientPolicy;

export const OPEN_POLICY: ClientPolicy = { minVersion: { bazaar: 0, play: 0 }, maintenance: { enabled: false, message: {} } };

/** The policy from app_config (`app.min_version` uses the SQL store words). */
export function clientPolicyFromConfig(config: Pick<AppConfig, 'app.min_version' | 'app.maintenance'>): ClientPolicy {
  const versions = config['app.min_version'];
  return {
    minVersion: { bazaar: versions.cafe_bazaar.required, play: versions.google_play.required },
    maintenance: { enabled: config['app.maintenance'].enabled, message: config['app.maintenance'].message },
  };
}

/** The policy in memory; the config loader replaces it when app_config changes. */
export class ClientPolicyHolder {
  private policy: ClientPolicy;

  constructor(initial: ClientPolicy = OPEN_POLICY) {
    this.policy = initial;
  }

  get(): ClientPolicy {
    return this.policy;
  }

  set(policy: ClientPolicy): void {
    this.policy = policy;
  }
}

export interface ClientRouteConfig {
  /** `required` (default on app routes), `optional`, or `none` (not an app route). */
  header?: 'required' | 'optional' | 'none';
  /** Answer 426 to builds below the minimum (default true). */
  minVersion?: boolean;
  /** Answer 503 during maintenance (default true). */
  maintenance?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The calling app build, from `X-Client`; null when the route does not need it or it was absent. */
    client: ClientInfo | null;
    /** The language of server texts for this request. */
    locale: Locale;
  }
  interface FastifyContextConfig {
    client?: ClientRouteConfig;
  }
}

export interface ClientPluginOptions {
  policy: ClientPolicySource;
  /** The language when `Accept-Language` names none of ours. */
  defaultLocale: Locale;
}

const X_CLIENT = /^(bazaar|play)\/([1-9][0-9]{0,9})$/;
const MAX_VERSION_CODE = 2_147_483_647;

/** Reads `X-Client`; null when it is absent or malformed. */
export function parseClientHeader(value: string | string[] | undefined): ClientInfo | null {
  if (typeof value !== 'string') return null;
  const match = X_CLIENT.exec(value.trim());
  if (!match?.[1] || !match[2]) return null;
  const versionCode = Number(match[2]);
  if (versionCode > MAX_VERSION_CODE) return null;
  const store = match[1] as AppStore;
  return { store, storeCode: storeCodes.code(store), versionCode };
}

/** The first of our languages `Accept-Language` names, by quality; else the default. */
export function pickLocale(header: string | string[] | undefined, fallback: Locale): Locale {
  if (typeof header !== 'string' || header.length > 512) return fallback;
  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
      return { language: tag.trim().toLowerCase().split('-')[0] ?? '', q: q === undefined ? 1 : Number(q), index };
    })
    .filter((entry) => entry.q > 0 && Number.isFinite(entry.q))
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { language } of ranked) if (isLocale(language)) return language;
  return fallback;
}

const NOT_APP = [/^\/v1\/webhooks\//, /^\/v1\/admin\//, /^\/v1\/public\//];
const CONFIG = /^\/v1\/config$/;
const ALWAYS_ANSWERED = [/^\/v1\/auth\/logout$/, /^\/v1\/me\/deletion(\/|$)/];

function routeRules(request: FastifyRequest): Required<ClientRouteConfig> {
  const path = request.routeOptions.url ?? request.url.split('?')[0] ?? '';
  const own = request.routeOptions.config.client ?? {};
  let header: Required<ClientRouteConfig>['header'] = 'required';
  let minVersion = true;
  let maintenance = true;
  if (!path.startsWith('/v1/') || NOT_APP.some((re) => re.test(path))) {
    header = 'none';
    minVersion = false;
    maintenance = false;
  } else if (CONFIG.test(path)) {
    minVersion = false;
    maintenance = false;
  } else if (ALWAYS_ANSWERED.some((re) => re.test(path))) {
    minVersion = false;
  }
  return { header: own.header ?? header, minVersion: own.minVersion ?? minVersion, maintenance: own.maintenance ?? maintenance };
}

export const clientPlugin = fp<ClientPluginOptions>(
  async (app, { policy, defaultLocale }) => {
    app.decorateRequest('client', null);
    app.decorateRequest('locale', defaultLocale);

    app.addHook('onRequest', async (request) => {
      request.locale = pickLocale(request.headers['accept-language'], defaultLocale);
      const rules = routeRules(request);
      if (rules.header === 'none') return;
      const client = parseClientHeader(request.headers['x-client']);
      if (client === null) {
        if (rules.header === 'optional' && request.headers['x-client'] === undefined) return;
        throw new HttpProblem('bad_request', {
          detail: `The X-Client header must be <store>/<versionCode>, store one of ${appStores.join(', ')}.`,
        });
      }
      request.client = client;
      const current = policy();
      if (rules.maintenance && current.maintenance.enabled) {
        const message = current.maintenance.message[request.locale] ?? current.maintenance.message[defaultLocale];
        throw new HttpProblem('maintenance', { extensions: { message }, headers: { 'retry-after': '120' } });
      }
      const required = current.minVersion[client.store];
      if (rules.minVersion && client.versionCode < required) {
        throw new HttpProblem('upgrade_required', { extensions: { minVersionCode: required } });
      }
    });
  },
  { name: 'client', fastify: '5.x' },
);
