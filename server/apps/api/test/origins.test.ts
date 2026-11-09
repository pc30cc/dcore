import { randomBytes } from 'node:crypto';
import { configSchema, originsAdminViewSchema, originsDocumentSchema, readOriginsPayload, realtimeTokenSchema } from '@app/shared';
import { OriginsSigner, generateOriginsKeyPair, readOriginsDocument, verifyOriginsDocument, createKeys, type OriginsTrust } from '@app/shared/server';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { ORIGINS_SIGN_EVERY_MS } from '../src/services/origins.js';
import { welcomeFor } from '../src/services/welcome.js';
import { call, migratedDatabase, problemExt, row, rows, seedUser, setAppConfig, startHarness, statements, type Harness, type TestDatabase } from './accountSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * The signed origins document (`GET /v1/origins`), its hosts in the admin
 * panel (`/v1/admin/origins`) and the welcome block of `GET /v1/config`,
 * against PostgreSQL and Valkey.
 */

const pair = generateOriginsKeyPair();
const SIGNING = { ORIGINS_SIGNING_KEY: pair.privateKey, ORIGINS_SIGNING_KID: 'o1' };
const trust: OriginsTrust = { keys: [{ kid: 'o1', key: pair.publicKey }], brand: '_template' };

const DEFAULT_HOSTS = {
  api: ['https://api.example.com'],
  realtime: ['https://rt.example.com'],
  rtc: ['https://rtc.example.com'],
  cdn: ['https://cdn.example.com'],
  web: ['https://example.com'],
};

const NEW_HOSTS = {
  api: ['https://api2.example.net', 'https://api.example.com'],
  realtime: ['https://rt2.example.net'],
  rtc: ['https://rtc2.example.net:8443'],
  cdn: ['https://cdn2.example.net'],
  web: ['https://example.org'],
};

function verified(response: LightMyRequestResponse) {
  return verifyOriginsDocument(response.json(), trust);
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe.skipIf(!hasInfrastructure)('the signed origins document', () => {
  let db: TestDatabase;
  const open: Harness[] = [];

  async function harness(env: Record<string, string | undefined> = SIGNING, jobs = new MemoryJobProducer(), now?: () => number): Promise<Harness> {
    const h = await startHarness(db, env, { jobs, ...(now ? { origins: { now } } : {}) });
    open.push(h);
    // The document is signed when the configuration loaded.
    await waitFor(() => h.app.origins.effective() !== null, 'the origins settings');
    return h;
  }

  async function adminToken(h: Harness, roles: string[] = ['superadmin']): Promise<{ id: number; token: string }> {
    const admin = await row<{ id: number }>(db, `INSERT INTO admin_users (email, display_name) VALUES ($1, 'Ops') RETURNING id`, [`ops-${randomBytes(4).toString('hex')}@example.com`]);
    const { token } = await h.app.tokens.issue({ kind: 'admin', subject: String(admin.id), sessionId: '7', roles });
    return { id: admin.id, token };
  }

  const admin = (h: Harness, token: string, method: 'GET' | 'PUT', body?: unknown) =>
    h.app.inject({ method, url: '/v1/admin/origins', headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { payload: body as Record<string, unknown> }) });

  beforeAll(async () => {
    db = await migratedDatabase();
  }, 60_000);
  afterEach(async () => {
    while (open.length > 0) await open.pop()?.close();
    await db.sql.query(`UPDATE public.app_config SET value = 'null' WHERE key = 'origins.hosts'`);
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("serves this deployment's own hosts, signed, from memory, to any build", async () => {
    const h = await harness();
    const first = await h.app.inject({ method: 'GET', url: '/v1/origins' });
    expect(first.statusCode).toBe(200);
    expect(statements(first)).toBe(0);
    expect(first.headers['content-type']).toMatch(/^application\/json/);
    expect(first.headers['cache-control']).toBe('public, max-age=300, stale-if-error=86400');
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/^"o1-[A-Za-z0-9_-]{16}"$/);
    originsDocumentSchema.parse(first.json());
    const payload = verified(first);
    expect(payload).toMatchObject({ brand: '_template', version: 1, hosts: DEFAULT_HOSTS, bootstrap: ['https://cdn.example.com/bootstrap/origins.json'] });
    const issued = Date.parse(payload.issuedAt);
    expect(issued % ORIGINS_SIGN_EVERY_MS).toBe(0);
    expect(Date.now() - issued).toBeLessThan(ORIGINS_SIGN_EVERY_MS);
    expect(Date.parse(payload.expiresAt) - issued).toBe(30 * 86_400_000);

    const again = await h.app.inject({ method: 'GET', url: '/v1/origins', headers: { 'if-none-match': etag } });
    expect(again.statusCode).toBe(304);
    expect(statements(again)).toBe(0);

    // The worker reads the same bytes from Valkey.
    await waitFor(async () => (await readOriginsDocument(h.redis, createKeys(h.prefix)))?.body === first.body, 'the stored document');

    // An old build and maintenance do not stop it: an app must always learn where the server is.
    await setAppConfig(h, 'app.maintenance', { enabled: true, message: { en: 'Back soon.' } });
    await setAppConfig(h, 'app.min_version', { cafe_bazaar: { required: 999, recommended: 999 }, google_play: { required: 999, recommended: 999 } });
    try {
      expect((await call(h, '/v1/me/consents')).statusCode).toBe(503);
      const during = await h.app.inject({ method: 'GET', url: '/v1/origins', headers: { 'x-client': 'bazaar/3' } });
      expect(during.statusCode).toBe(200);
      expect(verified(during).version).toBe(1);
    } finally {
      await setAppConfig(h, 'app.maintenance', { enabled: false, message: {} });
      await setAppConfig(h, 'app.min_version', { cafe_bazaar: { required: 1, recommended: 1 }, google_play: { required: 1, recommended: 1 } });
    }
  });

  it('answers 503 without a signing key, and never signs with a malformed one', async () => {
    const h = await harness({});
    const response = await h.app.inject({ method: 'GET', url: '/v1/origins' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'service_unavailable' });
    expect(statements(response)).toBe(0);
    await expect(startHarness(db, { ORIGINS_SIGNING_KEY: 'too-short' })).rejects.toThrow(/ORIGINS_SIGNING_KEY/);
  });

  it('signs the same hosts again every hour, with a new ETag, and keeps the newest in Valkey', async () => {
    let clock = Date.parse('2026-11-09T10:15:00.000Z');
    const h = await harness(SIGNING, new MemoryJobProducer(), () => clock);
    const first = await h.app.inject({ method: 'GET', url: '/v1/origins' });
    expect(readOriginsPayload(first.json()).issuedAt).toBe('2026-11-09T10:00:00.000Z');
    clock += 30 * 60_000;
    const same = await h.app.inject({ method: 'GET', url: '/v1/origins' });
    expect(same.body).toBe(first.body);
    clock += 30 * 60_000;
    const next = await h.app.inject({ method: 'GET', url: '/v1/origins', headers: { 'if-none-match': String(first.headers.etag) } });
    expect(next.statusCode).toBe(200);
    expect(next.headers.etag).not.toBe(first.headers.etag);
    expect(readOriginsPayload(next.json())).toMatchObject({ issuedAt: '2026-11-09T11:00:00.000Z', expiresAt: '2026-12-09T11:00:00.000Z', version: 1 });
    expect(verifyOriginsDocument(next.json(), { ...trust, now: new Date(clock) }).version).toBe(1);
    await waitFor(async () => (await readOriginsDocument(h.redis, createKeys(h.prefix)))?.issuedAtMs === Date.parse('2026-11-09T11:00:00.000Z'), 'the re-signed document in Valkey');
  });

  it('lets a superadmin change the hosts: checked, audited, version raised, served at once everywhere, queued for publishing', async () => {
    const jobs = new MemoryJobProducer();
    const h = await harness(SIGNING, jobs);
    // Another API process on the same database and Valkey.
    const other = await harness({ ...SIGNING, REDIS_KEY_PREFIX: h.prefix });
    const { id: adminId, token } = await adminToken(h);

    const view = await admin(h, token, 'GET');
    expect(view.statusCode).toBe(200);
    expect(statements(view)).toBe(1);
    expect(originsAdminViewSchema.parse(view.json())).toMatchObject({
      saved: false,
      version: 1,
      hosts: DEFAULT_HOSTS,
      defaults: { hosts: DEFAULT_HOSTS },
      allowIpHosts: false,
      signing: { configured: true, kid: 'o1', publicKey: pair.publicKey, trusted: null },
      document: { version: 1 },
    });

    // The rules: https, origins only, no IP, at least one API host; nothing is written.
    const refused = await admin(h, token, 'PUT', {
      hosts: { api: ['http://api.example.com', 'https://api.example.com/v1'], cdn: ['https://203.0.114.7'], web: ['https://10.0.0.1'] },
      bootstrap: ['https://cdn.example.com/'],
    });
    expect(refused.statusCode).toBe(422);
    expect(statements(refused)).toBeLessThanOrEqual(2);
    const problem = problemExt('field_invalid', refused.json()) as { errors?: { pointer: string }[] };
    expect(problem.errors?.map((e) => e.pointer)).toEqual(['/hosts/api/0', '/hosts/api/1', '/hosts/cdn/0', '/hosts/web/0', '/bootstrap/0']);
    expect((await admin(h, token, 'PUT', { hosts: { api: [] } })).statusCode).toBe(422);
    expect((await admin(h, token, 'PUT', { hosts: { api: ['https://api.example.com'] }, allowIpHosts: true, extra: 1 })).statusCode).toBe(400);
    expect(await rows(db, `SELECT 1 FROM audit_log WHERE action = 'config.update' AND detail->>'key' = 'origins.hosts'`)).toEqual([]);

    const configBefore = configSchema.parse((await call(h, '/v1/config?store=bazaar&locale=en')).json()).v;
    const saved = await admin(h, token, 'PUT', { hosts: NEW_HOSTS, bootstrap: ['https://mirror.example.org/o/origins.json'], baseVersion: 1 });
    expect(saved.statusCode).toBe(200);
    expect(statements(saved)).toBe(2);
    const after = originsAdminViewSchema.parse(saved.json());
    expect(after).toMatchObject({ saved: true, version: 2, hosts: NEW_HOSTS, bootstrap: ['https://mirror.example.org/o/origins.json'], document: { version: 2 } });

    // Stored, with its audit row (names and hosts before and after; hosts are not secrets).
    expect((await row<{ value: unknown }>(db, `SELECT value FROM app_config WHERE key = 'origins.hosts'`)).value).toEqual({
      version: 2,
      hosts: NEW_HOSTS,
      bootstrap: ['https://mirror.example.org/o/origins.json'],
      allowIpHosts: false,
    });
    const audit = await rows<{ admin_id: number; target_type: number; session_id: string; detail: Record<string, unknown> }>(
      db,
      `SELECT admin_id, target_type, session_id::text, detail FROM audit_log WHERE action = 'config.update' AND detail->>'key' = 'origins.hosts'`,
    );
    expect(audit).toEqual([
      {
        admin_id: adminId,
        target_type: 6,
        session_id: '7',
        detail: { key: 'origins.hosts', version: { from: 1, to: 2 }, before: null, after: { hosts: NEW_HOSTS, bootstrap: ['https://mirror.example.org/o/origins.json'], allowIpHosts: false } },
      },
    ]);

    // This process serves it at once; the other one once cfg:changed reached it.
    const served = await h.app.inject({ method: 'GET', url: '/v1/origins' });
    expect(verified(served)).toMatchObject({ version: 2, hosts: NEW_HOSTS, bootstrap: ['https://mirror.example.org/o/origins.json'] });
    await waitFor(() => other.app.origins.current()?.payload.version === 2, 'the other process');
    expect((await other.app.inject({ method: 'GET', url: '/v1/origins' })).body).toBe(served.body);
    // The configuration version moved, so apps revalidating GET /v1/config see a change and fetch the document again.
    await waitFor(() => h.app.cfg.get().version > configBefore, 'the new configuration version');
    expect(configSchema.parse((await call(h, '/v1/config?store=bazaar&locale=en')).json()).v).toBeGreaterThan(configBefore);
    // The worker is asked to publish this version.
    expect(jobs.jobs.filter((job) => job.queue === 'system')).toEqual([
      { queue: 'system', name: 'origins-publish', id: 'origins-publish.2', data: { version: 2 }, options: { attempts: 8, backoffMs: 1_000 } },
    ]);
    await waitFor(async () => (await readOriginsDocument(h.redis, createKeys(h.prefix)))?.version === 2, 'version 2 in Valkey');

    // The hosts other routes hand out follow the panel now.
    const user = await seedUser(h, { name: 'Ada' });
    const realtime = realtimeTokenSchema.parse((await call(h, '/v1/realtime/token', { method: 'POST', token: user.token })).json());
    expect(realtime.wsUrl).toBe('wss://rt2.example.net/connection/websocket');
    expect(h.app.calls.rtc.clientWsUrl()).toBe('wss://rtc2.example.net:8443');

    // Saving the same hosts again changes nothing: no version, no audit row, no job.
    const unchanged = await admin(h, token, 'PUT', { hosts: NEW_HOSTS, baseVersion: 2 });
    expect(unchanged.statusCode).toBe(200);
    expect(statements(unchanged)).toBe(1);
    expect(originsAdminViewSchema.parse(unchanged.json()).version).toBe(2);
    expect(await rows(db, `SELECT 1 FROM audit_log WHERE detail->>'key' = 'origins.hosts'`)).toHaveLength(1);
    expect(jobs.jobs.filter((job) => job.queue === 'system')).toHaveLength(1);

    // A save over a version the panel did not see is refused.
    const stale = await admin(h, token, 'PUT', { hosts: DEFAULT_HOSTS, baseVersion: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'conflict' });

    // IP addresses only when allowed, and only public ones; the version goes on.
    const ip = await admin(h, token, 'PUT', { hosts: { ...NEW_HOSTS, api: [...NEW_HOSTS.api, 'https://8.8.8.8'] }, allowIpHosts: true, baseVersion: 2 });
    expect(ip.statusCode).toBe(200);
    const third = originsAdminViewSchema.parse(ip.json());
    expect(third).toMatchObject({ version: 3, allowIpHosts: true });
    // Absent bootstrap URLs keep the saved ones.
    expect(third.bootstrap).toEqual(['https://mirror.example.org/o/origins.json']);
    expect((await admin(h, token, 'PUT', { hosts: { api: ['https://127.0.0.1'] }, allowIpHosts: true, baseVersion: 3 })).statusCode).toBe(422);
  });

  it('never goes below a version apps may hold, even over a hand-written value the rules refuse', async () => {
    const h = await harness();
    const { token } = await adminToken(h);
    await db.sql.query(`UPDATE public.app_config SET value = '{"version": 9, "hosts": {"api": ["ftp://x"]}}' WHERE key = 'origins.hosts'`);
    const saved = await admin(h, token, 'PUT', { hosts: { api: ['https://api.example.com'] } });
    expect(saved.statusCode).toBe(200);
    expect(originsAdminViewSchema.parse(saved.json()).version).toBe(10);
  });

  it('is for superadmins only', async () => {
    const h = await harness();
    const moderator = await adminToken(h, ['moderator']);
    expect((await admin(h, moderator.token, 'GET')).statusCode).toBe(403);
    expect((await admin(h, moderator.token, 'PUT', { hosts: { api: ['https://api.example.com'] } })).statusCode).toBe(403);
    const user = await seedUser(h, { name: 'Ada' });
    expect((await admin(h, user.token, 'GET')).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'GET', url: '/v1/admin/origins' })).statusCode).toBe(401);
  });

  it('warns about a signing key that brand.json does not list (apps would refuse the document)', async () => {
    const other = generateOriginsKeyPair();
    const h = await startHarness(db, SIGNING, {
      jobs: new MemoryJobProducer(),
      accountServices: { brand: { ...(await import('@app/config')).loadBrand(), origins: { publicKeys: [{ kid: 'o1', key: other.publicKey }], bootstrap: [] } } },
    });
    open.push(h);
    expect(h.logs.some((line) => line.includes('the signing key is not in brand.json origins.publicKeys'))).toBe(true);
    const { token } = await adminToken(h);
    expect(originsAdminViewSchema.parse((await admin(h, token, 'GET')).json()).signing.trusted).toBe(false);
    // The right key under its id is trusted.
    const good = await startHarness(db, SIGNING, {
      jobs: new MemoryJobProducer(),
      accountServices: { brand: { ...(await import('@app/config')).loadBrand(), origins: { publicKeys: [{ kid: 'o1', key: pair.publicKey }], bootstrap: [] } } },
    });
    open.push(good);
    const goodToken = await adminToken(good);
    expect(originsAdminViewSchema.parse((await admin(good, goodToken.token, 'GET')).json()).signing.trusted).toBe(true);
  });
});

describe.skipIf(!hasInfrastructure)('the welcome block of GET /v1/config', () => {
  let db: TestDatabase;
  let h: Harness | undefined;

  beforeAll(async () => {
    db = await migratedDatabase();
  }, 60_000);
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("sends brand.json's welcome per language, with the panel's overrides on top, from memory", async () => {
    h = await startHarness(db);
    const en = await call(h, '/v1/config?store=bazaar&locale=en');
    expect(statements(en)).toBe(0);
    expect(configSchema.strict().parse(en.json()).welcome).toEqual({
      eyebrow: 'Welcome to',
      headline: '{appName}, your headline *goes here*',
      subtitle: "A line or two under the headline, in the brand's own words.",
      gradient: { top: '#A9C2EE', middle: '#F06A3C', bottom: '#2B0A0E' },
      images: [],
    });
    const fa = configSchema.parse((await call(h, '/v1/config?store=play&locale=fa')).json());
    expect(fa.welcome?.headline).toBe('{appName}، تیتر شما *اینجا می‌نشیند*');

    await setAppConfig(h, 'brand.welcome', {
      headline: { en: 'Meet someone *worth it*' },
      gradient: { top: '#101010', middle: '#202020', bottom: '#303030' },
      images: ['https://cdn.example.com/brand/welcome/a.webp'],
    });
    try {
      const overridden = await call(h, '/v1/config?store=bazaar&locale=en', { headers: { 'if-none-match': String(en.headers.etag) } });
      expect(overridden.statusCode).toBe(200);
      expect(configSchema.parse(overridden.json()).welcome).toEqual({
        eyebrow: 'Welcome to',
        headline: 'Meet someone *worth it*',
        subtitle: "A line or two under the headline, in the brand's own words.",
        gradient: { top: '#101010', middle: '#202020', bottom: '#303030' },
        images: ['https://cdn.example.com/brand/welcome/a.webp'],
      });
      // Another language keeps the brand's text, and gets the panel's colours and pictures.
      const tr = configSchema.parse((await call(h, '/v1/config?store=bazaar&locale=tr')).json()).welcome;
      expect(tr?.headline).toBe('{appName}, başlığınız *burada yer alır*');
      expect(tr?.images).toEqual(['https://cdn.example.com/brand/welcome/a.webp']);
    } finally {
      await setAppConfig(h, 'brand.welcome', {});
    }
  });
});

describe('the welcome of one locale', () => {
  it('takes each text from the panel, else from brand.json in that locale, and leaves out what neither has', () => {
    const brand = { eyebrow: { en: 'Hi' }, headline: { en: 'A *b*', fa: 'ف *ب*' }, images: ['a.webp'] };
    expect(welcomeFor(brand, {}, 'en')).toEqual({ eyebrow: 'Hi', headline: 'A *b*', images: [] });
    expect(welcomeFor(brand, {}, 'tr')).toBeUndefined();
    expect(welcomeFor(brand, { subtitle: { tr: 'Alt' } }, 'tr')).toEqual({ subtitle: 'Alt', images: [] });
    expect(welcomeFor(undefined, {}, 'en')).toBeUndefined();
    expect(welcomeFor(undefined, { images: ['https://cdn.example.com/x.webp'] }, 'fa')).toEqual({ images: ['https://cdn.example.com/x.webp'] });
  });

  it('signs with a key made by the key tool, which the app can check', async () => {
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const apiRoot = fileURLToPath(new URL('..', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--conditions=@app/source', 'src/scripts/origins-keygen.ts', '--kid', 'o7'], { cwd: apiRoot, encoding: 'utf8', timeout: 60_000 });
    expect(result.status, result.stderr).toBe(0);
    const seed = /^ORIGINS_SIGNING_KEY=([A-Za-z0-9_-]{43})$/m.exec(result.stdout)?.[1];
    const listed = JSON.parse(/^(\{"kid".*\})$/m.exec(result.stdout)?.[1] ?? 'null') as { kid: string; key: string };
    expect(/^ORIGINS_SIGNING_KID=o7$/m.test(result.stdout)).toBe(true);
    expect(listed.kid).toBe('o7');
    const signer = new OriginsSigner('o7', seed ?? '');
    expect(signer.publicKey).toBe(listed.key);
    const now = new Date();
    const document = signer.sign({ brand: '_template', version: 1, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 86_400_000).toISOString(), hosts: { ...DEFAULT_HOSTS }, bootstrap: [] });
    expect(verifyOriginsDocument(document, { keys: [listed] }).version).toBe(1);
    const bad = spawnSync(process.execPath, ['--import', 'tsx', '--conditions=@app/source', 'src/scripts/origins-keygen.ts', '--kid', 'not valid!'], { cwd: apiRoot, encoding: 'utf8', timeout: 60_000 });
    expect(bad.status).toBe(64);
  });
});
