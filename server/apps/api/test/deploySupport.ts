import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/** The repository's deploy folder, and its Coolify compose file read as data. */
export const DEPLOY = fileURLToPath(new URL('../../../../deploy', import.meta.url));

interface ComposeService {
  environment?: string[];
  ports?: string[];
}

export function composeServices(): Record<string, ComposeService> {
  const compose = parse(readFileSync(join(DEPLOY, 'coolify/docker-compose.yml'), 'utf8')) as { services: Record<string, ComposeService> };
  return compose.services;
}

/** A service's environment as name → value (a bare name has itself as value). */
export function composeEnv(service: string): Record<string, string> {
  const entries = (composeServices()[service]?.environment ?? []).map((line): [string, string] => {
    const at = line.indexOf('=');
    return at < 0 ? [line, line] : [line.slice(0, at), line.slice(at + 1)];
  });
  return Object.fromEntries(entries);
}

/** Centrifugo's configuration as deploy/centrifugo/start.sh writes it (the parts the tests read). */
export interface CentrifugoConfig {
  client: {
    allowed_origins: string[];
    token: { hmac_secret_key: string };
    allow_anonymous_connect_without_token: boolean;
    disallow_anonymous_connection_tokens: boolean;
    [key: string]: unknown;
  };
  http_api: { key: string };
  http_server: { port: number; internal_port: string };
  engine: { type: string; redis: { address: string } };
  channel: {
    history_meta_ttl: string;
    proxy?: { subscribe?: { endpoint: string; timeout: string; include_connection_meta: boolean; http: { static_headers: Record<string, string> } } };
    without_namespace: Record<string, unknown>;
    namespaces: Record<string, unknown>[];
  };
  health: { enabled: boolean };
  admin: { enabled: boolean };
}

/** The sample inputs of the renders below (distinct, long enough, in each value's alphabet). */
export const CENTRIFUGO_SAMPLE = {
  secret: 'tokenSecret_0123456789abcdefghijklmnopqrstuvwxyz',
  apiKey: 'apiKey-0123456789abcdef',
  proxyKey: 'proxyKey_0123456789abcdefghijklmnopqrstuvwxyz',
  proxyUrl: 'http://api.internal:8081',
} as const;

export interface CentrifugoRender {
  status: number;
  stderr: string;
  /** The file written (absent when start.sh refused). */
  path?: string;
  config?: CentrifugoConfig;
}

/**
 * Renders deploy/centrifugo/config.json through start.sh in its "write the
 * file and stop" mode, with the sample inputs; `env` overrides them (an
 * undefined value removes one). Files go to `work`.
 */
export function centrifugoRenderer(work: string): (env?: Record<string, string | undefined>) => CentrifugoRender {
  let runs = 0;
  return (env = {}) => {
    const out = join(work, `centrifugo-${++runs}.json`);
    const merged: Record<string, string> = {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      CENTRIFUGO_TOKEN_HMAC_SECRET: CENTRIFUGO_SAMPLE.secret,
      CENTRIFUGO_API_KEY: CENTRIFUGO_SAMPLE.apiKey,
      CENTRIFUGO_PROXY_KEY: CENTRIFUGO_SAMPLE.proxyKey,
      CENTRIFUGO_PROXY_URL: CENTRIFUGO_SAMPLE.proxyUrl,
      KV_RT_PASSWORD: 'kv-rt-password_1',
      CENTRIFUGO_TEMPLATE: join(DEPLOY, 'centrifugo/config.json'),
      CENTRIFUGO_CONFIG_OUT: out,
      CENTRIFUGO_CONFIG_ONLY: '1',
    };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
    const run = spawnSync('sh', [join(DEPLOY, 'centrifugo/start.sh')], { env: merged, encoding: 'utf8' });
    if (run.status !== 0) return { status: run.status ?? -1, stderr: run.stderr };
    return { status: 0, stderr: run.stderr, path: out, config: JSON.parse(readFileSync(out, 'utf8')) as CentrifugoConfig };
  };
}
