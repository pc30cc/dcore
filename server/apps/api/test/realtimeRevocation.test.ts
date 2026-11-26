import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realtimeEnvelope, realtimeTokenSchema, userChannel } from '@app/shared';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSubscribeProxy, type SubscribeProxy } from '../src/realtime/subscribeProxy.js';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { REALTIME_SECRET, call, migratedDatabase, seedUser, statements, type SeededUser, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, startAdminHarness, type AdminHarness } from './adminSupport.js';
import { DEPLOY } from './deploySupport.js';
import { refreshTokenFor } from './moderationSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * Revocation end to end, on the released Centrifugo binary with the
 * configuration production writes (deploy/centrifugo/start.sh; the engine in
 * memory and local ports here), the API's subscribe check on a port of its
 * own, the real Centrifugo publisher, and a WebSocket client speaking the
 * JSON protocol as the app does. A connection token minted before a
 * revocation stops working: the live connection closes with 3005 at once,
 * and the same token, used again, still connects (the open-source server
 * checks a JWT itself) but its subscription is closed with 4501 and it
 * receives nothing. A person whose access was not revoked connects and
 * subscribes with no PostgreSQL statement.
 *
 * Needs the Centrifugo release of the deploy image (CENTRIFUGO_BIN, else
 * $STATE_DIR/bin, else PATH; infra/dev/native.sh install puts it there);
 * REQUIRE_INTEGRATION=1 turns its absence into a failure.
 */

const VERSION = 'v6.10.2';
const API_KEY = 'e2e-api-key-0123456789abcdef';
const PROXY_KEY = 'e2e-proxy-key-0123456789abcdefghijklmnop';
const DAY_MS = 86_400_000;
const ADMIN_IP = '93.184.216.34';

function findBinary(): string | undefined {
  const candidates = [process.env['CENTRIFUGO_BIN'], join(process.env['STATE_DIR'] ?? '/var/tmp/app-dev', 'bin/centrifugo'), 'centrifugo'];
  for (const candidate of candidates) {
    if (!candidate || (candidate.includes('/') && !existsSync(candidate))) continue;
    const run = spawnSync(candidate, ['version'], { encoding: 'utf8' });
    if (run.status === 0 && run.stdout.includes(VERSION)) return candidate;
  }
  return undefined;
}

const binary = findBinary();
if (!binary && process.env['REQUIRE_INTEGRATION'] === '1') throw new Error(`REQUIRE_INTEGRATION=1 but Centrifugo ${VERSION} is missing (infra/dev/native.sh install)`);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually<T>(read: () => T | undefined | Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

type Frame = Record<string, unknown>;

/** A Centrifugo client over the JSON protocol: commands with ids, pushes, pings answered, the close code kept. */
class RealtimeClient {
  private nextId = 1;
  private readonly waiting = new Map<number, (frame: Frame) => void>();
  readonly pushes: Frame[] = [];
  closed: { code: number; reason: string } | null = null;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      for (const line of String(event.data).split('\n')) {
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as Frame;
        if (Object.keys(frame).length === 0) {
          ws.send('{}');
          continue;
        }
        const id = typeof frame['id'] === 'number' ? frame['id'] : undefined;
        if (id !== undefined) {
          this.waiting.get(id)?.(frame);
          this.waiting.delete(id);
        } else if (frame['push']) {
          this.pushes.push(frame['push'] as Frame);
        }
      }
    });
    ws.addEventListener('close', (event) => {
      this.closed = { code: event.code, reason: event.reason };
      for (const resolve of this.waiting.values()) resolve({ closed: this.closed });
      this.waiting.clear();
    });
  }

  static async open(url: string): Promise<RealtimeClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('the WebSocket did not open')), { once: true });
    });
    return new RealtimeClient(ws);
  }

  /** The reply to a command; `{closed}` when the server answered by closing the socket. */
  async command(body: Frame, ms = 5_000): Promise<Frame> {
    if (this.closed) return { closed: this.closed };
    const id = this.nextId++;
    const reply = new Promise<Frame>((resolve) => this.waiting.set(id, resolve));
    this.ws.send(JSON.stringify({ id, ...body }));
    return Promise.race([reply, sleep(ms).then((): Frame => ({ timeout: true }))]);
  }

  async connect(token: string): Promise<Frame> {
    return this.command({ connect: { token, name: 'e2e' } });
  }

  async subscribe(channel: string): Promise<Frame> {
    return this.command({ subscribe: { channel } });
  }

  async closedWith(ms = 3_000): Promise<{ code: number; reason: string }> {
    return eventually(() => this.closed ?? undefined, ms, 'the socket to close');
  }

  close(): void {
    if (!this.closed) this.ws.close();
  }
}

describe.skipIf(!hasInfrastructure || !binary)('revocation end to end on Centrifugo', () => {
  const work = mkdtempSync(join(tmpdir(), 'realtime-e2e-'));
  let db: TestDatabase;
  let h: AdminHarness;
  let proxy: SubscribeProxy;
  let centrifugo: ChildProcess | undefined;
  let output = '';
  const ports = { public: 0, internal: 0, proxy: 0 };
  const clients: RealtimeClient[] = [];
  let adminToken = '';
  let wsUrl = '';
  let eventSeq = 0;

  async function startProxy(): Promise<void> {
    proxy = await buildSubscribeProxy({ denyList: h.app.denyList, publicIds: h.app.publicIds, key: PROXY_KEY, logger: pino({ level: 'silent' }) });
    await proxy.listen({ host: '127.0.0.1', port: ports.proxy });
  }

  async function serverApi(method: string, body: unknown): Promise<Frame> {
    const res = await fetch(`http://127.0.0.1:${ports.internal}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Frame;
  }

  async function presence(user: SeededUser): Promise<number> {
    const reply = await serverApi('presence_stats', { channel: userChannel(user.publicUid) });
    return Number((reply['result'] as { num_clients?: number } | undefined)?.num_clients ?? 0);
  }

  async function publish(user: SeededUser): Promise<string> {
    eventSeq += 1;
    const envelope = realtimeEnvelope('conversation_end', h.app.ids.nextId(), Date.now(), { conversationId: `${1287390234923400000n + BigInt(eventSeq)}` });
    await h.app.realtime!.publish(userChannel(user.publicUid), envelope);
    return envelope.id;
  }

  const delivered = (client: RealtimeClient, id: string) => client.pushes.some((p) => ((p['pub'] as Frame | undefined)?.['data'] as Frame | undefined)?.['id'] === id);

  async function mint(token: string): Promise<string> {
    const res = await call(h, '/v1/realtime/token', { method: 'POST', token });
    expect(res.statusCode, res.body).toBe(200);
    return realtimeTokenSchema.parse(res.json()).token;
  }

  /** Connected and subscribed to the person's channel, as the app is in the foreground. */
  async function live(user: SeededUser, connectionToken: string): Promise<RealtimeClient> {
    const client = await RealtimeClient.open(wsUrl);
    clients.push(client);
    const connected = await client.connect(connectionToken);
    expect(connected['connect'], JSON.stringify(connected)).toBeDefined();
    const subscribed = await client.subscribe(userChannel(user.publicUid));
    expect(subscribed['subscribe'], JSON.stringify(subscribed)).toBeDefined();
    return client;
  }

  /** The same token again after the revocation: it connects, its subscription is closed with 4501, nothing reaches it. */
  async function refusedAfter(user: SeededUser, connectionToken: string): Promise<void> {
    const again = await RealtimeClient.open(wsUrl);
    clients.push(again);
    const connected = await again.connect(connectionToken);
    expect(connected['connect'], JSON.stringify(connected)).toBeDefined();
    const subscribed = await again.subscribe(userChannel(user.publicUid));
    expect(subscribed, JSON.stringify(subscribed)).toEqual({ closed: { code: 4501, reason: 'revoked' } });
    const id = await publish(user);
    await sleep(200);
    expect(delivered(again, id)).toBe(false);
    expect(await presence(user)).toBe(0);
  }

  beforeAll(async () => {
    ports.public = await freePort();
    ports.internal = await freePort();
    ports.proxy = await freePort();
    db = await migratedDatabase();
    wsUrl = `ws://127.0.0.1:${ports.public}/connection/websocket`;
    h = await startAdminHarness(
      db,
      { CENTRIFUGO_API_URL: `http://127.0.0.1:${ports.internal}`, CENTRIFUGO_API_KEY: API_KEY, CENTRIFUGO_WS_URL: wsUrl, CENTRIFUGO_PROXY_KEY: PROXY_KEY },
      { jobs: new MemoryJobProducer() },
    );
    adminToken = (await adminAs(h, 'admin')).accessToken;
    await startProxy();

    // The configuration as production writes it, on local ports with the engine in memory.
    const rendered = join(work, 'rendered.json');
    const run = spawnSync('sh', [join(DEPLOY, 'centrifugo/start.sh')], {
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        CENTRIFUGO_TOKEN_HMAC_SECRET: REALTIME_SECRET,
        CENTRIFUGO_API_KEY: API_KEY,
        CENTRIFUGO_PROXY_KEY: PROXY_KEY,
        CENTRIFUGO_PROXY_URL: `http://127.0.0.1:${ports.proxy}`,
        KV_RT_PASSWORD: 'unused-in-memory',
        CENTRIFUGO_TEMPLATE: join(DEPLOY, 'centrifugo/config.json'),
        CENTRIFUGO_CONFIG_OUT: rendered,
        CENTRIFUGO_CONFIG_ONLY: '1',
      },
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);
    const config = JSON.parse(readFileSync(rendered, 'utf8')) as Record<string, Record<string, unknown>>;
    config['engine'] = { type: 'memory' };
    config['http_server'] = { port: ports.public, internal_port: String(ports.internal) };
    config['log'] = { level: 'warn' };
    writeFileSync(join(work, 'config.json'), JSON.stringify(config));
    // Only PATH: Centrifugo maps CENTRIFUGO_* variables onto its own keys.
    centrifugo = spawn(binary!, ['--config', join(work, 'config.json')], { env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' }, cwd: work });
    centrifugo.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    centrifugo.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    await eventually(
      async () => {
        try {
          return (await fetch(`http://127.0.0.1:${ports.internal}/health`)).ok ? true : undefined;
        } catch {
          return undefined;
        }
      },
      10_000,
      'Centrifugo to start',
    ).catch((error: unknown) => {
      throw new Error(`${String(error)}\n${output}`);
    });
  }, 120_000);

  afterAll(async () => {
    for (const client of clients) client.close();
    centrifugo?.kill('SIGTERM');
    await proxy?.close();
    await h?.close();
    await db?.drop();
    rmSync(work, { recursive: true, force: true });
  });

  it('a person whose access stands connects, subscribes and receives, without a statement and without server-side subscriptions', async () => {
    const user = await seedUser(h, { name: 'Steady' });
    const res = await call(h, '/v1/realtime/token', { method: 'POST', token: user.token });
    expect(statements(res)).toBe(0);
    const connectionToken = realtimeTokenSchema.parse(res.json()).token;
    let queries = 0;
    const query = h.app.pg.query.bind(h.app.pg);
    const connect = h.app.pg.connect.bind(h.app.pg);
    h.app.pg.query = ((...args: Parameters<typeof query>) => {
      queries += 1;
      return query(...args);
    }) as typeof query;
    h.app.pg.connect = ((...args: Parameters<typeof connect>) => {
      queries += 1;
      return connect(...args);
    }) as typeof connect;
    let client: RealtimeClient;
    try {
      client = await RealtimeClient.open(wsUrl);
      clients.push(client);
      const connected = await client.connect(connectionToken);
      expect(connected['connect']).toBeDefined();
      expect((connected['connect'] as Frame)['subs']).toBeUndefined();
      expect((await client.subscribe(userChannel(user.publicUid)))['subscribe']).toBeDefined();
    } finally {
      h.app.pg.query = query;
      h.app.pg.connect = connect;
    }
    expect(queries).toBe(0);
    const id = await publish(user);
    await eventually(() => (delivered(client, id) ? true : undefined), 3_000, 'the publication');
    expect(await presence(user)).toBe(1);
  });

  it("refuses someone else's channel", async () => {
    const user = await seedUser(h, { name: 'Curious' });
    const other = await seedUser(h, { name: 'Private' });
    const client = await RealtimeClient.open(wsUrl);
    clients.push(client);
    await client.connect(await mint(user.token));
    const reply = await client.subscribe(userChannel(other.publicUid));
    expect((reply['error'] as Frame | undefined)?.['code']).toBe(403);
  });

  const revocations: [string, (user: SeededUser) => Promise<void>, { told?: boolean; renewed?: number }][] = [
    ['sign-out everywhere', async (user) => void expect((await call(h, '/v1/auth/logout', { method: 'POST', token: user.token, body: { all: true } })).statusCode).toBe(204), {}],
    ['a sign-out by an admin', async (user) => void expect((await admin(h, `/v1/admin/users/${user.publicUid}/revoke-sessions`, {}, { token: adminToken, ip: ADMIN_IP })).statusCode).toBe(200), {}],
    [
      'a suspension',
      async (user) =>
        void expect(
          (await admin(h, `/v1/admin/users/${user.publicUid}/suspend`, { reason: 'spam', reasonText: 'A pause.', endsAt: new Date(Date.now() + DAY_MS).toISOString() }, { token: adminToken, ip: ADMIN_IP })).statusCode,
        ).toBe(200),
      { told: true },
    ],
    ['a ban', async (user) => void expect((await admin(h, `/v1/admin/users/${user.publicUid}/ban`, { reason: 'scam', reasonText: 'Scam.' }, { token: adminToken, ip: ADMIN_IP })).statusCode).toBe(200), { told: true }],
    ['a deletion by an admin', async (user) => void expect((await admin(h, `/v1/admin/users/${user.publicUid}/delete`, {}, { token: adminToken, ip: ADMIN_IP })).statusCode).toBe(200), {}],
    ['a deletion in the app', async (user) => void expect((await call(h, '/v1/me/deletion', { method: 'POST', token: user.token, body: {} })).statusCode).toBe(202), {}],
  ];

  for (const [name, revoke, options] of revocations) {
    it(`${name}: the live connection closes with 3005, the same token is refused with 4501 and gets nothing`, async () => {
      const user = await seedUser(h, { name: `E2E ${name}` });
      const connectionToken = await mint(user.token);
      const client = await live(user, connectionToken);
      await revoke(user);
      expect(await client.closedWith()).toMatchObject({ code: 3005 });
      // A restriction is told first, so the app knows why its socket closed.
      if (options.told) expect(client.pushes.some((p) => ((p['pub'] as Frame | undefined)?.['data'] as Frame | undefined)?.['t'] === 'account')).toBe(true);
      await refusedAfter(user, connectionToken);
      // The app's next step, a new connection token, is refused too.
      expect((await call(h, '/v1/realtime/token', { method: 'POST', token: user.token })).statusCode).toBe(401);
    });
  }

  it('an under-age closure ends the connection and its token the same way', async () => {
    const kid = await seedUser(h, { status: 1, name: 'E2E Kid' });
    const connectionToken = await mint(kid.token);
    const client = await live(kid, connectionToken);
    const young = new Date();
    young.setUTCFullYear(young.getUTCFullYear() - 17);
    const closed = await call(h, '/v1/me/basics', { method: 'PUT', token: kid.token, body: { birthDate: young.toISOString().slice(0, 10), gender: 'woman', consents: { terms: 1, privacy: 1 } } });
    expect(closed.json()).toMatchObject({ code: 'under_age' });
    expect(await client.closedWith()).toMatchObject({ code: 3005 });
    await refusedAfter(kid, connectionToken);
  });

  it('a reused refresh token ends the session for realtime too', async () => {
    const user = await seedUser(h, { name: 'E2E Reuse' });
    const connectionToken = await mint(user.token);
    const client = await live(user, connectionToken);
    const refreshToken = await refreshTokenFor(h, user);
    expect((await call(h, '/v1/auth/refresh', { method: 'POST', body: { refreshToken } })).statusCode).toBe(200);
    await sleep(1_200);
    expect((await call(h, '/v1/auth/refresh', { method: 'POST', body: { refreshToken } })).json()).toMatchObject({ code: 'refresh_reused' });
    expect(await client.closedWith()).toMatchObject({ code: 3005 });
    await refusedAfter(user, connectionToken);
  });

  it('signing out on one phone closes both; that phone stays refused, the other one comes back, and a later sign-in subscribes', async () => {
    const user = await seedUser(h, { name: 'E2E Two Phones' });
    const sessionB = h.app.ids.nextId();
    await db.sql.query(
      `INSERT INTO sessions (id, user_id, device_id, expires_at, store, refresh_hash) VALUES ($1, $2, $3, now() + interval '30 days', 2, $4)`,
      [sessionB, user.id, user.deviceId, randomBytes(32)],
    );
    const accessB = (await h.app.tokens.issue({ kind: 'app', subject: user.publicUid, sessionId: sessionB, deviceId: user.deviceId, storeCode: 2, scope: 'full' })).token;
    const tokenA = await mint(user.token);
    const a = await live(user, tokenA);
    const b = await live(user, await mint(accessB));
    expect((await call(h, '/v1/auth/logout', { method: 'POST', token: user.token, body: {} })).statusCode).toBe(204);
    expect(await a.closedWith()).toMatchObject({ code: 3005 });
    expect(await b.closedWith()).toMatchObject({ code: 3005 });
    // Phone A's token: connects, then its subscription closes with 4501.
    const againA = await RealtimeClient.open(wsUrl);
    clients.push(againA);
    await againA.connect(tokenA);
    expect(await againA.subscribe(userChannel(user.publicUid))).toEqual({ closed: { code: 4501, reason: 'revoked' } });
    // Phone B asks for a new token (its session stands) and is back.
    const backB = await live(user, await mint(accessB));
    const id = await publish(user);
    await eventually(() => (delivered(backB, id) ? true : undefined), 3_000, 'the publication on phone B');

    // Signing out everywhere, then signing in again a second later: the new session subscribes.
    expect((await call(h, '/v1/auth/logout', { method: 'POST', token: accessB, body: { all: true } })).statusCode).toBe(204);
    await backB.closedWith();
    await sleep(1_100);
    const sessionC = h.app.ids.nextId();
    await db.sql.query(
      `INSERT INTO sessions (id, user_id, device_id, expires_at, store, refresh_hash) VALUES ($1, $2, $3, now() + interval '30 days', 2, $4)`,
      [sessionC, user.id, user.deviceId, randomBytes(32)],
    );
    const accessC = (await h.app.tokens.issue({ kind: 'app', subject: user.publicUid, sessionId: sessionC, deviceId: user.deviceId, storeCode: 2, scope: 'full' })).token;
    await live(user, await mint(accessC));
  });

  it('without the subscribe check a new subscription fails as temporary, and the live ones keep receiving', async () => {
    const user = await seedUser(h, { name: 'E2E Proxy Down' });
    const steady = await live(user, await mint(user.token));
    await proxy.close();
    try {
      const fresh = await RealtimeClient.open(wsUrl);
      clients.push(fresh);
      await fresh.connect(await mint(user.token));
      const reply = await fresh.subscribe(userChannel(user.publicUid));
      expect((reply['error'] as Frame | undefined)?.['code'], JSON.stringify(reply)).toBe(100);
      const id = await publish(user);
      await eventually(() => (delivered(steady, id) ? true : undefined), 3_000, 'the publication on the live connection');
    } finally {
      await startProxy();
    }
  });
});
