import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REALTIME_EXPIRED_CLOSE_DELAY_SECONDS } from '@app/shared/server';
import { afterAll, describe, expect, it } from 'vitest';
import { SUBSCRIBE_PROXY_PATH } from '../src/realtime/subscribeProxy.js';
import { CENTRIFUGO_SAMPLE, centrifugoRenderer } from './deploySupport.js';

/**
 * The realtime server's subscribe check as deploy/centrifugo/config.json
 * turns it on: every subscription to the personal namespace goes to the
 * API's internal listener with the connection meta and the shared key, no
 * channel is user-limited (that would pass the check by), nothing else lets
 * a client subscribe, and an expired connection closes after the delay the
 * deny list's lifetime covers.
 *
 * This file and config.json's subscribe check ship together, after the API
 * that puts `meta` in connection tokens has run for at least
 * REALTIME_TOKEN_TTL_SECONDS plus that delay: a token minted without it is
 * refused at every subscription.
 */

const work = mkdtempSync(join(tmpdir(), 'realtime-proxy-config-'));
const render = centrifugoRenderer(work);

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('the realtime server configuration: the subscribe check', () => {
  const { config, status, stderr } = render();

  it('asks the API before every subscription, with the connection meta and the shared key', () => {
    expect(status, stderr).toBe(0);
    expect(config!.channel.proxy?.subscribe).toEqual({
      endpoint: `${CENTRIFUGO_SAMPLE.proxyUrl}${SUBSCRIBE_PROXY_PATH}`,
      timeout: '1s',
      include_connection_meta: true,
      http: { static_headers: { 'X-Realtime-Proxy-Key': CENTRIFUGO_SAMPLE.proxyKey } },
    });
    expect(render({ CENTRIFUGO_PROXY_URL: undefined }).config!.channel.proxy?.subscribe?.endpoint).toBe(`http://api:8081${SUBSCRIBE_PROXY_PATH}`);
    expect(config!.channel.namespaces.map((n) => [n['name'], n['allow_user_limited_channels'], n['subscribe_proxy_enabled']])).toEqual([['user', false, true]]);
  });

  it('lets no subscription pass the check by', () => {
    // No other proxy, no server-side subscription, no subscription tokens, no headers passed on.
    for (const key of ['proxy', 'subscription_token', 'subscribe_to_user_personal_channel', 'http_headers', 'emulated_headers']) {
      expect(config!.client, key).not.toHaveProperty(key);
    }
    expect(JSON.stringify(config)).not.toMatch(/sub_refresh|subscribe_to_user_personal_channel|http_headers|emulated_headers|"connect"|"refresh"/);
    // Every scope either takes no client subscription or has it checked, and none is user-limited.
    const scopes: Record<string, unknown>[] = [config!.channel.without_namespace, ...config!.channel.namespaces];
    for (const scope of scopes) {
      expect(scope['allow_user_limited_channels'] ?? false).toBe(false);
      expect(scope['subscribe_proxy_enabled'] === true || scope['allow_subscribe_for_client'] === false).toBe(true);
    }
  });

  it('closes an expired connection after the delay the deny list covers', () => {
    expect(config!.client['expired_close_delay']).toBe(`${REALTIME_EXPIRED_CLOSE_DELAY_SECONDS}s`);
  });
});
