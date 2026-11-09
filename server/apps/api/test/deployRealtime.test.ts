import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { userChannel } from '@app/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { DEPLOY, composeEnv } from './deploySupport.js';

/**
 * The realtime server's configuration as production writes it
 * (deploy/centrifugo/start.sh from config.json and the environment), and
 * what the API and the app rely on in it: one personal namespace with
 * recovery and no client access to history or presence, no anonymous
 * access, the Redis engine on the realtime Valkey, browser origins from the
 * environment, and the compose wiring the API and Centrifugo share.
 */

const START = join(DEPLOY, 'centrifugo/start.sh');
const TEMPLATE = join(DEPLOY, 'centrifugo/config.json');
const work = mkdtempSync(join(tmpdir(), 'realtime-config-'));

const SECRET = 'tokenSecret_0123456789abcdefghijklmnopqrstuvwxyz';
const API_KEY = 'apiKey-0123456789abcdef';

afterAll(() => rmSync(work, { recursive: true, force: true }));

interface CentrifugoConfig {
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
  channel: { history_meta_ttl: string; without_namespace: Record<string, unknown>; namespaces: Record<string, unknown>[] };
  health: { enabled: boolean };
  admin: { enabled: boolean };
}

let runs = 0;
function render(env: Record<string, string | undefined>): { status: number; stderr: string; config?: CentrifugoConfig } {
  const out = join(work, `centrifugo-${++runs}.json`);
  const merged: Record<string, string> = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    CENTRIFUGO_TOKEN_HMAC_SECRET: SECRET,
    CENTRIFUGO_API_KEY: API_KEY,
    KV_RT_PASSWORD: 'kv-rt-password_1',
    CENTRIFUGO_TEMPLATE: TEMPLATE,
    CENTRIFUGO_CONFIG_OUT: out,
    CENTRIFUGO_CONFIG_ONLY: '1',
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  const run = spawnSync('sh', [START], { env: merged, encoding: 'utf8' });
  if (run.status !== 0) return { status: run.status ?? -1, stderr: run.stderr };
  return { status: 0, stderr: run.stderr, config: JSON.parse(readFileSync(out, 'utf8')) as CentrifugoConfig };
}

const CLIENT_SIDE = /^allow_(subscribe|publish|presence|history)_for_(client|subscriber|anonymous)$/;

describe('the realtime server configuration (criterion 4)', () => {
  const { config, status, stderr } = render({ CENTRIFUGO_ALLOWED_ORIGINS: 'https://admin.example.com, https://example.com' });

  it('is written from the environment, complete, to a file only its owner reads', () => {
    expect(status, stderr).toBe(0);
    expect(config).toBeDefined();
    expect(JSON.stringify(config)).not.toMatch(/@[A-Z_]+@/);
    expect(statSync(join(work, 'centrifugo-1.json')).mode & 0o077).toBe(0);
    expect(config!.client.token.hmac_secret_key).toBe(SECRET);
    expect(config!.http_api.key).toBe(API_KEY);
    expect(config!.client.allowed_origins).toEqual(['https://admin.example.com', 'https://example.com']);
  });

  it('keeps history and presence away from every client, and admits nobody anonymous', () => {
    const client = config!.client;
    expect(client.allow_anonymous_connect_without_token).toBe(false);
    expect(client.disallow_anonymous_connection_tokens).toBe(true);
    const channel = config!.channel;
    const scopes: Record<string, unknown>[] = [channel.without_namespace, ...channel.namespaces];
    for (const scope of scopes) {
      for (const [key, value] of Object.entries(scope)) {
        if (CLIENT_SIDE.test(key)) expect(value, key).toBe(false);
      }
      // Every client-side permission is stated, so a changed default cannot open one.
      for (const what of ['subscribe', 'publish', 'presence', 'history']) {
        // There is no "subscribe for subscriber": a subscriber already is one.
        for (const who of what === 'subscribe' ? ['client', 'anonymous'] : ['client', 'subscriber', 'anonymous']) {
          expect(scope, `allow_${what}_for_${who}`).toHaveProperty(`allow_${what}_for_${who}`, false);
        }
      }
    }
    expect(channel.without_namespace.presence).toBe(false);
    expect(channel.without_namespace.history_size).toBe(0);
    expect(config!.admin.enabled).toBe(false);
  });

  it('has one personal namespace: user-limited, history 100 for 900 s with forced recovery, presence for the server only, no join/leave', () => {
    const namespaces = config!.channel.namespaces;
    expect(namespaces.map((n) => n['name'])).toEqual(['u']);
    expect(namespaces[0]).toMatchObject({
      name: 'u',
      allow_user_limited_channels: true,
      history_size: 100,
      history_ttl: '900s',
      force_recovery: true,
      presence: true,
      join_leave: false,
      force_push_join_leave: false,
    });
    // The channel the API hands out is a user-limited channel of that namespace.
    const channel = userChannel('abcdefghijklm');
    expect(channel).toBe('u:#abcdefghijklm');
    expect(channel.split(':')[0]).toBe(namespaces[0]!['name']);
    // History metadata outlives the history itself (recovery positions stay valid).
    expect(hours(config!.channel.history_meta_ttl)).toBeGreaterThan(900 / 3_600);
  });

  it('runs the Redis engine on the realtime Valkey, and keeps the server API on the internal port', () => {
    expect(config!.engine).toEqual({ type: 'redis', redis: { address: 'redis://:kv-rt-password_1@kv-rt:6379/0' } });
    expect(render({ KV_RT_ADDRESS: 'kv-rt.internal:6380', KV_RT_DB: '2' }).config!.engine.redis.address).toBe('redis://:kv-rt-password_1@kv-rt.internal:6380/2');
    expect(config!.http_server).toEqual({ port: 8000, internal_port: '9000' });
    expect(config!.health.enabled).toBe(true);
    expect(config!.client).toMatchObject({ ping_interval: '25s', channel_limit: 8, user_connection_limit: 4 });
  });

  it('allows no origin unless told, and refuses a wildcard, a path or a bad value without echoing a secret', () => {
    expect(render({}).config!.client.allowed_origins).toEqual([]);
    for (const origins of ['*', 'https://example.com/path', 'example.com', 'https://exa"mple.com', 'javascript:alert(1)']) {
      const refused = render({ CENTRIFUGO_ALLOWED_ORIGINS: origins });
      expect(refused.status, origins).toBe(64);
    }
    const cases: Record<string, string | undefined>[] = [
      { CENTRIFUGO_TOKEN_HMAC_SECRET: undefined },
      { CENTRIFUGO_TOKEN_HMAC_SECRET: 'short' },
      { CENTRIFUGO_TOKEN_HMAC_SECRET: `${SECRET}"` },
      { CENTRIFUGO_API_KEY: 'tiny' },
      { CENTRIFUGO_API_KEY: SECRET },
      { KV_RT_PASSWORD: undefined },
      { KV_RT_PASSWORD: 'with space' },
      { KV_RT_ADDRESS: 'no-port' },
      { KV_RT_DB: '99' },
    ];
    for (const env of cases) {
      const refused = render(env);
      expect(refused.status, JSON.stringify(env)).toBe(64);
      expect(refused.stderr).not.toContain(SECRET);
    }
  });

  it('is wired in the compose file the way the API signs and calls it', () => {
    const centrifugo = composeEnv('centrifugo');
    const api = composeEnv('api');
    const worker = composeEnv('worker');
    // The API signs connection tokens with the secret Centrifugo verifies them with.
    expect(api['CENTRIFUGO_TOKEN_HMAC_SECRET']).toBe(centrifugo['CENTRIFUGO_TOKEN_HMAC_SECRET']);
    // Both processes call the server API with its key, on the internal port.
    for (const side of [api, worker]) {
      expect(side['CENTRIFUGO_API_KEY']).toBe(centrifugo['CENTRIFUGO_API_KEY']);
      expect(side['CENTRIFUGO_API_URL']).toBe(`http://centrifugo:${config!.http_server.internal_port}`);
    }
    // The engine is the realtime Valkey, not the queues' one.
    expect(centrifugo['KV_RT_ADDRESS']).toBe('kv-rt:6379');
    expect(centrifugo['KV_RT_PASSWORD']).toBe('${SERVICE_PASSWORD_KVRT}');
    expect(centrifugo).toHaveProperty('CENTRIFUGO_ALLOWED_ORIGINS');
    // Clients reach the public port only.
    expect(Object.keys(centrifugo).find((k) => k.startsWith('SERVICE_URL_CENTRIFUGO_'))).toBe(`SERVICE_URL_CENTRIFUGO_${config!.http_server.port}`);
  });
});

function hours(duration: string): number {
  const m = /^(\d+)(h|m|s)$/.exec(duration);
  if (!m) throw new Error(`not a duration: ${duration}`);
  const n = Number(m[1]);
  return m[2] === 'h' ? n : m[2] === 'm' ? n / 60 : n / 3_600;
}
