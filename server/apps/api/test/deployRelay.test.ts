import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_RTC_SETTINGS, mintTurnCredential, participantNetwork, type RtcSettings } from '@app/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEPLOY } from './deploySupport.js';

/**
 * The in-country relay as deploy/relay/ sets it up, run for real: coturn
 * (the distribution's turnserver) with the configuration configure.sh
 * writes, the probe's STUN responder standing in for the media server, and
 * the probe checking it the way a phone uses it, with the very credential
 * the API hands a participant (participantNetwork). Needs turnserver and
 * python3 (infra/dev/native.sh installs coturn); REQUIRE_INTEGRATION=1
 * turns their absence into a failure.
 */

const CONFIGURE = join(DEPLOY, 'relay/configure.sh');
const PROBE = join(DEPLOY, 'relay/probe.py');
const has = (command: string) => spawnSync('sh', ['-c', `command -v ${command}`]).status === 0;
const available = has('turnserver') && has('python3');
if (!available && process.env['REQUIRE_INTEGRATION'] === '1') throw new Error('REQUIRE_INTEGRATION=1 but turnserver or python3 is missing (infra/dev/native.sh install)');

/** A local IPv4 that is not loopback (coturn refuses loopback peers, as production must). */
function localAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  }
  return undefined;
}

const address = localAddress();
if (available && !address && process.env['REQUIRE_INTEGRATION'] === '1') throw new Error('the relay test needs a non-loopback IPv4 address');

describe.skipIf(!available || !address)('the in-country relay (coturn, the probe)', () => {
  const work = mkdtempSync(join(tmpdir(), 'relay-'));
  const secret = randomBytes(24).toString('hex');
  const base = 30_000 + Math.floor(Math.random() * 9_000);
  const port = base;
  const peerPort = base + 1;
  const relayStart = 40_000 + Math.floor(Math.random() * 80) * 100;
  const conf = join(work, 'turnserver.conf');
  const secretFile = join(work, 'secret');
  const children: ChildProcess[] = [];
  const ip = address!;
  const settings: RtcSettings = {
    ...EMPTY_RTC_SETTINGS,
    relay: {
      urls: [`turn:${ip}:${port}?transport=udp`, `turn:${ip}:${port}?transport=tcp`],
      secret,
      secretStored: true,
      countries: ['IR'],
      credentialTtlSeconds: 6 * 3_600,
    },
  };

  function configure(env: Record<string, string>) {
    return spawnSync('sh', [CONFIGURE], {
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', CONFIG_ONLY: '1', CONF: conf, SECRET_FILE: secretFile, ...env },
      encoding: 'utf8',
    });
  }

  function probe(env: Record<string, string>, transport: 'udp' | 'tcp') {
    return spawnSync('python3', ['-I', PROBE, 'check', ip, String(port), transport], {
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', PEER_IP: ip, PEER_PORT: String(peerPort), DENIED_PEER: '203.0.113.7', PINGS: '3', ...env },
      encoding: 'utf8',
      timeout: 60_000,
    });
  }

  function credentialFile(turn: { username: string; credential: string }): string {
    const file = join(work, `credential-${randomBytes(3).toString('hex')}.json`);
    writeFileSync(file, JSON.stringify(turn), { mode: 0o600 });
    return file;
  }

  async function listening(): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      const up = await new Promise<boolean>((resolve) => {
        const socket = createConnection({ host: ip, port }, () => {
          socket.end();
          resolve(true);
        });
        socket.on('error', () => resolve(false));
      });
      if (up) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('turnserver did not start listening');
  }

  beforeAll(async () => {
    writeFileSync(secretFile, `${secret}\n`);
    chmodSync(secretFile, 0o600);
    const written = configure({ PUBLIC_IP: ip, PEER_IPS: ip, PORT: String(port), MIN_PORT: String(relayStart), MAX_PORT: String(relayStart + 99) });
    expect(written.status, written.stderr).toBe(0);
    children.push(spawn('turnserver', ['-c', conf, '--pidfile', join(work, 'turnserver.pid'), '--log-file', join(work, 'turnserver.log')], { stdio: 'ignore' }));
    children.push(spawn('python3', ['-I', PROBE, 'serve', ip, String(peerPort), '120'], { stdio: 'ignore' }));
    await listening();
  }, 30_000);

  afterAll(() => {
    for (const child of children) child.kill('SIGTERM');
    rmSync(work, { recursive: true, force: true });
  });

  it('writes a relay that needs credentials and may reach the media server only', () => {
    const text = readFileSync(conf, 'utf8');
    for (const line of [
      'use-auth-secret',
      `static-auth-secret=${secret}`,
      'denied-peer-ip=0.0.0.0-255.255.255.255',
      `allowed-peer-ip=${ip}`,
      'no-tcp-relay',
      'no-multicast-peers',
      'no-cli',
      'no-tls',
      'user-quota=32',
      'total-quota=3000',
      'max-bps=1000000',
      'max-allocate-lifetime=600',
      'realm=relay',
    ]) {
      expect(text.split('\n'), line).toContain(line);
    }
    // The allow-list comes after the blanket denial, and names nothing else.
    expect(text.split('\n').filter((l) => l.startsWith('allowed-peer-ip='))).toEqual([`allowed-peer-ip=${ip}`]);
  });

  it('takes the very credential the API hands a participant in a relay country, over UDP and TCP', () => {
    const network = participantNetwork(settings, 'IR', Date.now());
    expect(network.relayed).toBe(true);
    expect(network.turn!.username).toMatch(/^\d{10}:r[0-9a-f]{16}$/);
    const file = credentialFile(network.turn!);
    for (const transport of ['udp', 'tcp'] as const) {
      const run = probe({ TURN_CREDENTIAL_FILE: file }, transport);
      expect(run.status, `${transport}: ${run.stdout}${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('allocate ok');
      expect(run.stdout).toContain(`permission to ${ip}: ok`);
      expect(run.stdout).toMatch(new RegExp(`${ip.replaceAll('.', '\\.')} answered 3/3`));
      expect(run.stdout).toContain('permission to 203.0.113.7 (must be refused): REFUSED 403');
      // Neither the secret nor the password is ever printed.
      expect(run.stdout + run.stderr).not.toContain(secret);
      expect(run.stdout + run.stderr).not.toContain(network.turn!.credential);
    }
    // Elsewhere nobody gets the relay: LiveKit's own ICE servers stay.
    expect(participantNetwork(settings, 'DE', Date.now()).turn).toBeNull();
    expect(participantNetwork(settings, null, Date.now()).turn).toBeNull();
  });

  it('mints with the shared secret exactly as the API does (the probe\'s own credential)', () => {
    const run = probe({ TURN_SECRET_FILE: secretFile }, 'udp');
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout + run.stderr).not.toContain(secret);
  });

  it('refuses an expired credential and one signed with another secret', () => {
    const expired = mintTurnCredential({ sharedSecret: secret, ttlSeconds: -120 });
    const late = probe({ TURN_CREDENTIAL_FILE: credentialFile(expired) }, 'udp');
    expect(late.status).toBe(1);
    expect(late.stdout).toContain('allocate FAILED: 401');
    const forged = mintTurnCredential({ sharedSecret: randomBytes(24).toString('hex'), ttlSeconds: 3_600 });
    const wrong = probe({ TURN_CREDENTIAL_FILE: credentialFile(forged) }, 'tcp');
    expect(wrong.status).toBe(1);
    expect(wrong.stdout).toContain('allocate FAILED: 401');
  });

  it('refuses settings that would make an open or a broken relay', () => {
    const good = { PUBLIC_IP: ip, PEER_IPS: ip, PORT: String(port), MIN_PORT: String(relayStart), MAX_PORT: String(relayStart + 99) };
    for (const bad of [
      { USER_QUOTA: '0' },
      { PEER_IPS: 'everyone' },
      { PEER_IPS: '' },
      { PUBLIC_IP: '' },
      { PORT: String(relayStart + 5) },
      { MIN_PORT: '60000', MAX_PORT: '50000' },
      { REALM: 'with space' },
    ]) {
      const run = spawnSync('sh', [CONFIGURE], {
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', CONFIG_ONLY: '1', CONF: join(work, 'refused.conf'), SECRET_FILE: secretFile, ...good, ...bad },
        encoding: 'utf8',
      });
      expect(run.status, JSON.stringify(bad)).not.toBe(0);
      expect(run.stderr).not.toContain(secret);
    }
    writeFileSync(join(work, 'short'), 'tooshort');
    const short = spawnSync('sh', [CONFIGURE], {
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', CONFIG_ONLY: '1', CONF: join(work, 'refused.conf'), SECRET_FILE: join(work, 'short'), ...good },
      encoding: 'utf8',
    });
    expect(short.status).not.toBe(0);
  });
});
