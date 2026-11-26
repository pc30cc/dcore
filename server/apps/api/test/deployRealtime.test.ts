import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { userChannel } from '@app/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { CENTRIFUGO_SAMPLE, centrifugoRenderer, composeEnv, composeServices } from './deploySupport.js';

/**
 * The realtime server's configuration as production writes it
 * (deploy/centrifugo/start.sh from deploy/centrifugo/config.json), checked for
 * what the API and the app rely on in it: one personal namespace with
 * recovery and no client access to history or presence, the person's
 * channel kept to them by exactly one check (Centrifugo's user-limited
 * channel or the API's subscribe check, which deployRealtimeProxy.test.ts
 * holds to its details), no anonymous access, the Redis engine on the
 * realtime Valkey, browser origins from the environment, the subscribe-check
 * inputs start.sh validates, and the compose wiring the API and Centrifugo
 * share.
 */

const work = mkdtempSync(join(tmpdir(), 'realtime-config-'));
const { secret: SECRET, apiKey: API_KEY, proxyKey: PROXY_KEY } = CENTRIFUGO_SAMPLE;
const render = centrifugoRenderer(work);

afterAll(() => rmSync(work, { recursive: true, force: true }));

const CLIENT_SIDE = /^allow_(subscribe|publish|presence|history)_for_(client|subscriber|anonymous)$/;

describe('the realtime server configuration (criterion 4)', () => {
  const { config, status, stderr, path } = render({ CENTRIFUGO_ALLOWED_ORIGINS: 'https://admin.example.com, https://example.com' });

  it('is written from the environment, complete, to a file only its owner reads', () => {
    expect(status, stderr).toBe(0);
    expect(config).toBeDefined();
    expect(JSON.stringify(config)).not.toMatch(/@[A-Z_]+@/);
    expect(statSync(path!).mode & 0o077).toBe(0);
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

  it('has one personal namespace: the channel kept to its person by exactly one check, history 100 for 900 s with forced recovery, presence for the server only, no join/leave', () => {
    const namespaces = config!.channel.namespaces;
    expect(namespaces.map((n) => n['name'])).toEqual(['user']);
    // Centrifugo refuses to start on a namespace name outside ^[-a-zA-Z0-9_.]{2,}$ (v6.10 checks it).
    for (const n of namespaces) expect(String(n['name'])).toMatch(/^[-a-zA-Z0-9_.]{2,}$/);
    expect(namespaces[0]).toMatchObject({
      name: 'user',
      history_size: 100,
      history_ttl: '900s',
      force_recovery: true,
      presence: true,
      join_leave: false,
      force_push_join_leave: false,
    });
    // A user-limited channel passes the subscribe check by, so a scope has one or the other, never both; the
    // namespace without a name takes no client subscription at all.
    const userLimited = namespaces[0]!['allow_user_limited_channels'] === true;
    const checked = namespaces[0]!['subscribe_proxy_enabled'] === true;
    expect(userLimited !== checked, `user-limited ${userLimited}, subscribe check ${checked}`).toBe(true);
    if (checked) expect(config!.channel.proxy?.subscribe?.endpoint).toBeDefined();
    expect(config!.channel.without_namespace['allow_user_limited_channels'] ?? false).toBe(false);
    expect(config!.channel.without_namespace['subscribe_proxy_enabled'] ?? false).toBe(false);
    // The channel the API hands out is a channel of that namespace (that check makes sure it is the person's own).
    const channel = userChannel('abcdefghijklm');
    expect(channel).toBe('user:#abcdefghijklm');
    expect(channel.split(':')[0]).toBe(namespaces[0]!['name']);
    // Positions outlive the history window, so a client coming back finds out it is too late rather than silently missing events.
    expect(hours(config!.channel.history_meta_ttl)).toBeGreaterThan(900 / 3_600);
  });

  it('runs the Redis engine on the realtime Valkey, and keeps the server API on the internal port', () => {
    expect(config!.engine).toEqual({ type: 'redis', redis: { address: 'redis://:kv-rt-password_1@kv-rt:6379/0' } });
    expect(render({ KV_RT_ADDRESS: 'kv-rt.internal:6380', KV_RT_DB: '2' }).config!.engine.redis.address).toBe('redis://:kv-rt-password_1@kv-rt.internal:6380/2');
    expect(config!.http_server).toEqual({ port: 8000, internal_port: '9000' });
    expect(config!.health.enabled).toBe(true);
    expect(config!.client).toMatchObject({ ping_interval: '25s', channel_limit: 8, user_connection_limit: 4 });
  });

  it('refuses a missing, short, reused or unsafe proxy key and a proxy URL with a path, without echoing a key', () => {
    const cases: Record<string, string | undefined>[] = [
      { CENTRIFUGO_PROXY_KEY: undefined },
      { CENTRIFUGO_PROXY_KEY: 'short-proxy-key' },
      { CENTRIFUGO_PROXY_KEY: `${PROXY_KEY}"` },
      { CENTRIFUGO_PROXY_KEY: `${PROXY_KEY}&` },
      { CENTRIFUGO_PROXY_KEY: SECRET },
      { CENTRIFUGO_PROXY_KEY: `${API_KEY}${API_KEY}`, CENTRIFUGO_API_KEY: `${API_KEY}${API_KEY}` },
      { CENTRIFUGO_PROXY_URL: 'http://api:8081/path' },
      { CENTRIFUGO_PROXY_URL: 'http://api:8081?x=1' },
      { CENTRIFUGO_PROXY_URL: 'http://api:8081&x' },
      { CENTRIFUGO_PROXY_URL: 'ftp://api:8081' },
      { CENTRIFUGO_PROXY_URL: 'http://' },
    ];
    for (const env of cases) {
      const refused = render(env);
      expect(refused.status, JSON.stringify(env)).toBe(64);
      expect(refused.stderr).not.toContain(PROXY_KEY);
      expect(refused.stderr).not.toContain(SECRET);
    }
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
    // The subscribe checks: one shared key, Centrifugo calls the API's internal port, which no domain or published port exposes.
    expect(api['CENTRIFUGO_PROXY_KEY']).toBe('${SERVICE_PASSWORD_64_CENTRIFUGOPROXY}');
    expect(centrifugo['CENTRIFUGO_PROXY_KEY']).toBe(api['CENTRIFUGO_PROXY_KEY']);
    expect(new URL(centrifugo['CENTRIFUGO_PROXY_URL']!)).toMatchObject({ hostname: 'api', port: api['REALTIME_PROXY_PORT'] });
    expect(api['REALTIME_PROXY_PORT']).not.toBe(api['PORT']);
    expect(Object.keys(api).filter((k) => k.startsWith('SERVICE_URL_API_'))).toEqual([`SERVICE_URL_API_${api['PORT']}`]);
    expect(composeServices()['api']?.ports).toBeUndefined();
  });
});

function hours(duration: string): number {
  const m = /^(\d+)(h|m|s)$/.exec(duration);
  if (!m) throw new Error(`not a duration: ${duration}`);
  const n = Number(m[1]);
  return m[2] === 'h' ? n : m[2] === 'm' ? n / 60 : n / 3_600;
}
