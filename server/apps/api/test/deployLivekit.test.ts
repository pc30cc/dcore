import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEPLOY, composeEnv, composeServices } from './deploySupport.js';

/**
 * The media server's configuration as production writes it
 * (deploy/livekit/start.sh from livekit.yaml and the environment): rooms
 * only the API creates, webhooks signed with the API key to the API's own
 * route, room defaults, the node address found at start or pinned, and the
 * ports the compose file publishes.
 */

const START = join(DEPLOY, 'livekit/start.sh');
const TEMPLATE = join(DEPLOY, 'livekit/livekit.yaml');
const WEBHOOK_ROUTE = fileURLToPath(new URL('../src/routes/livekitWebhook.ts', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'livekit-config-'));
const SECRET = 'livekitSecret_0123456789abcdefghijklmnop';

afterAll(() => rmSync(work, { recursive: true, force: true }));

interface LivekitConfig {
  port: number;
  rtc: { tcp_port: number; port_range_start: number; port_range_end: number; use_external_ip: boolean; node_ip?: string; congestion_control: Record<string, unknown> };
  room: { auto_create: boolean; empty_timeout: number; departure_timeout: number; max_participants: number };
  keys: Record<string, string>;
  webhook: { api_key: string; urls: string[] };
  turn: { enabled: boolean };
}

let runs = 0;
function render(env: Record<string, string | undefined>): { status: number; stderr: string; config?: LivekitConfig; file?: string } {
  const out = join(work, `livekit-${++runs}.yaml`);
  const merged: Record<string, string> = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    LIVEKIT_API_KEY: 'key_1',
    LIVEKIT_API_SECRET: SECRET,
    LIVEKIT_WEBHOOK_URL: 'http://api:8080/v1/webhooks/livekit',
    // Never reach the internet from a test: the HTTP lookup is skipped.
    LIVEKIT_NODE_IP_DETECT: '0',
    LIVEKIT_TEMPLATE: TEMPLATE,
    LIVEKIT_CONFIG_OUT: out,
    LIVEKIT_CONFIG_ONLY: '1',
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  const run = spawnSync('sh', [START], { env: merged, encoding: 'utf8' });
  if (run.status !== 0) return { status: run.status ?? -1, stderr: run.stderr };
  return { status: 0, stderr: run.stderr, config: parse(readFileSync(out, 'utf8')) as LivekitConfig, file: out };
}

describe('the media server configuration', () => {
  const live = composeEnv('livekit');
  const { config, status, stderr, file } = render({
    LIVEKIT_RTC_TCP_PORT: live['LIVEKIT_RTC_TCP_PORT'],
    LIVEKIT_RTC_UDP_START: live['LIVEKIT_RTC_UDP_START'],
    LIVEKIT_RTC_UDP_END: live['LIVEKIT_RTC_UDP_END'],
  });

  it('never creates a room for a client, and has the room defaults of a two-person call', () => {
    expect(status, stderr).toBe(0);
    expect(statSync(file!).mode & 0o077).toBe(0);
    expect(readFileSync(file!, 'utf8')).not.toMatch(/@[A-Z_]+@/);
    expect(config!.room).toEqual({ auto_create: false, empty_timeout: 300, departure_timeout: 20, max_participants: 4 });
    expect(config!.port).toBe(7880);
    expect(config!.turn.enabled).toBe(false);
    expect(config!.rtc.congestion_control).toMatchObject({ enabled: true, allow_pause: false, use_send_side_bwe: true });
  });

  it('signs its webhooks with the API key and posts them to the API\'s route', () => {
    expect(config!.keys).toEqual({ key_1: SECRET });
    expect(config!.webhook).toEqual({ api_key: 'key_1', urls: ['http://api:8080/v1/webhooks/livekit'] });
    const api = composeEnv('api');
    const worker = composeEnv('worker');
    expect(live['LIVEKIT_WEBHOOK_URL']).toBe(`http://api:${api['PORT']}/v1/webhooks/livekit`);
    expect(readFileSync(WEBHOOK_ROUTE, 'utf8')).toContain("'/v1/webhooks/livekit'");
    for (const side of [api, worker]) {
      expect(side['LIVEKIT_API_KEY']).toBe(live['LIVEKIT_API_KEY']);
      expect(side['LIVEKIT_API_SECRET']).toBe(live['LIVEKIT_API_SECRET']);
      expect(side['LIVEKIT_API_URL']).toBe(`http://livekit:${config!.port}`);
      // The identity key is a secret of its own, never LiveKit's.
      expect(side['LIVEKIT_IDENTITY_SECRET']).not.toBe(side['LIVEKIT_API_SECRET']);
    }
  });

  it('announces the ports the compose file publishes, the same on the host and in the container', () => {
    const ports = composeServices()['livekit']!.ports ?? [];
    expect(config!.rtc.tcp_port).toBe(Number(live['LIVEKIT_RTC_TCP_PORT']));
    expect(ports).toContain(`${config!.rtc.tcp_port}:${config!.rtc.tcp_port}/tcp`);
    const range = `${config!.rtc.port_range_start}-${config!.rtc.port_range_end}`;
    expect(ports).toContain(`${range}:${range}/udp`);
    expect(ports).toHaveLength(2);
    // Signalling stays behind the proxy.
    expect(ports.some((p) => p.includes('7880'))).toBe(false);
  });

  it('finds its address at start or uses a pinned public one, never a private one', () => {
    expect(config!.rtc).toMatchObject({ use_external_ip: true });
    expect(config!.rtc.node_ip).toBeUndefined();
    const pinned = render({ LIVEKIT_NODE_IP: '203.0.113.10' }).config!;
    expect(pinned.rtc).toMatchObject({ use_external_ip: false, node_ip: '203.0.113.10' });
    for (const ip of ['10.0.0.5', '172.18.0.2', '192.168.1.1', '127.0.0.1', '100.64.0.1', '300.1.1.1', '1.2.3', 'auto.example']) {
      expect(render({ LIVEKIT_NODE_IP: ip }).status, ip).toBe(64);
    }
  });

  it('refuses a configuration that cannot work, without echoing the secret', () => {
    const cases: Record<string, string | undefined>[] = [
      { LIVEKIT_API_SECRET: 'short' },
      { LIVEKIT_API_SECRET: undefined },
      { LIVEKIT_API_KEY: 'bad key' },
      { LIVEKIT_WEBHOOK_URL: 'ftp://api/x' },
      { LIVEKIT_WEBHOOK_URL: 'http://api:8080/x?a=1&b=2' },
      { LIVEKIT_RTC_TCP_PORT: '7880' },
      { LIVEKIT_RTC_TCP_PORT: '51050' },
      { LIVEKIT_RTC_UDP_START: '52000', LIVEKIT_RTC_UDP_END: '51000' },
      { LIVEKIT_RTC_UDP_START: '80' },
    ];
    for (const env of cases) {
      const refused = render(env);
      expect(refused.status, JSON.stringify(env)).toBe(64);
      expect(refused.stderr).not.toContain(SECRET);
    }
  });
});
