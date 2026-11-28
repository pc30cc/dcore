import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { providerFingerprint } from '@app/config';
import { PROVIDER_WRITES_PER_HOUR, adminProviderSchema, adminProvidersSchema, type AdminProvider } from '@app/shared';
import { DataSealer, FakeGooglePlay, PubSubOidcVerifier, secretFingerprint } from '@app/shared/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, migratedDatabase, row, rows, statements, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, lastAudit, startAdminHarness, type AdminHarness, type AdminSession } from './adminSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * Provider credentials from the admin panel (`/v1/admin/providers`): the
 * superadmin's only, write-only (fingerprints in every answer, audit row and
 * log), checked as the clients load them, and applied in this process at
 * once: the SMS router sends with the panel's key, a store verifier is
 * rebuilt in place, a provider turned off stops, an entry that cannot be
 * opened turns it off.
 */

const sha12 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);

function serviceAccount(email = 'push@demo-project.iam.gserviceaccount.com'): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return JSON.stringify({ type: 'service_account', project_id: 'demo-project', client_email: email, private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), private_key_id: 'k1' });
}

describe.skipIf(!hasInfrastructure)('admin: provider credentials', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  let superadmin: AdminSession;
  let adminRole: AdminSession;
  let delegated: AdminSession;
  const sent: { url: string; body: string }[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: input instanceof Request ? input.url : input.toString(), body: typeof init?.body === 'string' ? init.body : '' });
    return new Response(JSON.stringify({ return: { status: 200 }, entries: [{ messageid: 7 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startAdminHarness(db, {}, { providers: { fetch: fakeFetch, reportEveryMs: 60_000 } });
    superadmin = await adminAs(h, 'superadmin');
    adminRole = await adminAs(h, 'admin');
    // A role holding the exact grant (restricted permissions need it by name).
    await db.sql.query(`INSERT INTO admin_role_permissions (role_id, permission) SELECT id, 'config.providers' FROM admin_roles WHERE key = 'marketing' ON CONFLICT DO NOTHING`);
    await h.app.adminAuth.roles.reload();
    delegated = await adminAs(h, 'marketing');
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await db?.drop();
  });

  const list = async (session: AdminSession = superadmin) => {
    const res = await admin(h, '/v1/admin/providers', undefined, { token: session.accessToken });
    return { res, body: res.statusCode === 200 ? adminProvidersSchema.parse(res.json()) : null };
  };
  const one = async (kind: string): Promise<AdminProvider> => (await list()).body!.items.find((item) => item.kind === kind)!;
  const put = async (kind: string, body: Record<string, unknown>, session: AdminSession = superadmin) =>
    admin(h, `/v1/admin/providers/${kind}`, { kind, baseVersion: (await one(kind)).version, ...body }, { token: session.accessToken, method: 'PUT' });
  const remove = async (kind: string) => admin(h, `/v1/admin/providers/${kind}`, { baseVersion: (await one(kind)).version }, { token: superadmin.accessToken, method: 'DELETE' });
  const waitFor = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 300; i += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('not applied');
  };

  it('is the superadmin\'s (or an exact grant\'s); the admin role is refused', async () => {
    const { res, body } = await list();
    expect(res.statusCode).toBe(200);
    expect(statements(res)).toBe(1);
    expect(body!.items.map((item) => item.kind)).toEqual(['kavenegar', 'smsir', 'telnyx', 'play', 'bazaar', 'fcm']);
    expect(body!.items.find((item) => item.kind === 'fcm')!.env.known).toBe(false);
    expect((await list(adminRole)).res.statusCode).toBe(403);
    expect((await put('kavenegar', { enabled: true, settings: { template: 'otp' }, secrets: { apiKey: 'admin-role-key-1' } }, adminRole)).statusCode).toBe(403);
    expect((await list(delegated)).res.statusCode).toBe(200);
    expect((await admin(h, '/v1/admin/providers/rtc', undefined, { token: adminRole.accessToken })).statusCode).toBe(403);
    expect((await admin(h, '/v1/admin/providers/rtc', undefined, { token: delegated.accessToken })).statusCode).toBe(200);
  });

  it('keeps a secret write-only: fingerprints in the answer, the audit row and the logs, never the key', async () => {
    const key = `kave-${randomBytes(12).toString('hex')}`;
    const logsBefore = h.logs.length;
    const res = await put('kavenegar', { enabled: true, settings: { template: 'otp' }, secrets: { apiKey: key } });
    expect(res.statusCode, res.body).toBe(200);
    expect(statements(res)).toBeLessThanOrEqual(3);
    expect(res.body).not.toContain(key);
    const view = adminProviderSchema.parse(res.json());
    expect(view.source).toBe('panel');
    expect(view.panel?.secrets['apiKey']).toEqual({ set: true, fingerprint: sha12(key), unreadable: false });
    expect(secretFingerprint(key)).toBe(sha12(key));
    expect(providerFingerprint(key)).toBe(sha12(key));
    const audit = await lastAudit(db, { action: 'config.update', targetType: 6 });
    expect(JSON.stringify(audit?.detail)).not.toContain(key);
    expect(audit?.detail).toMatchObject({ key: 'providers.kavenegar', after: { secrets: { apiKey: sha12(key) } } });
    expect((await row<{ v: string }>(db, `SELECT value::text AS v FROM app_config WHERE key = 'providers.kavenegar'`)).v).not.toContain(key);
    expect(h.logs.slice(logsBefore).join('\n')).not.toContain(key);
    // Applied here: +98 numbers go through Kavenegar with the panel's key.
    await waitFor(() => h.app.sms.configured.includes('kavenegar'));
    sent.splice(0);
    const start = await call(h, '/v1/auth/otp/start', { method: 'POST', body: { phone: '+989121234567', locale: 'fa' } });
    expect(start.statusCode, start.body).toBe(200);
    expect(sent.some((request) => request.url.includes(encodeURIComponent(key)))).toBe(true);
    // The report lists this process with the same fingerprint.
    await waitFor(async () => (await one('kavenegar')).applied.some((a) => a.process === 'api' && a.fingerprint === sha12(key)));
    // Off: no longer used.
    expect((await put('kavenegar', { enabled: false, settings: { template: 'otp' } })).statusCode).toBe(200);
    await waitFor(() => !h.app.sms.configured.includes('kavenegar'));
    expect((await one('kavenegar')).source).toBe('off');
    // Back to the deployment's values (none here).
    const cleared = await remove('kavenegar');
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(adminProviderSchema.parse(cleared.json())).toMatchObject({ source: 'none', panel: null });
    expect((await lastAudit(db, { action: 'config.update', targetType: 6 }))?.detail).toMatchObject({ key: 'providers.kavenegar', cleared: true });
  });

  it('checks an entry as its client loads it; a secret not sent is kept', async () => {
    const missing = await put('smsir', { enabled: true, settings: { templateId: 100, parameter: 'CODE' } });
    expect(missing.json()).toMatchObject({ errors: [{ pointer: '/secrets/apiKey', code: 'secret_required' }] });
    const badAccount = await put('play', { enabled: true, settings: { packageName: 'com.example.app', rtdnAudience: null, rtdnPushServiceAccountEmail: null }, secrets: { serviceAccountJson: '{"nope": true}' } });
    expect(badAccount.json()).toMatchObject({ errors: [{ pointer: '/secrets/serviceAccountJson', code: 'credentials_invalid' }] });
    const pair = await put('play', { enabled: true, settings: { packageName: 'com.example.app', rtdnAudience: 'https://api.example.org/v1/webhooks/play', rtdnPushServiceAccountEmail: null }, secrets: { serviceAccountJson: serviceAccount() } });
    expect(pair.json()).toMatchObject({ errors: [{ code: 'invalid' }] });
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const notRsa = await put('bazaar', { enabled: true, settings: { packageName: 'com.example.app', rsaPublicKey: ec.padEnd(100, 'A'), auth: 'pishkhan', clientId: null }, secrets: { pishkhanToken: 'pishkhan-token-1' } });
    expect(notRsa.json()).toMatchObject({ errors: [{ pointer: '/settings/rsaPublicKey', code: 'credentials_invalid' }] });
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const oauth = { packageName: 'com.example.app', rsaPublicKey: rsa, auth: 'oauth', clientId: 'client-1' };
    const noSecrets = await put('bazaar', { enabled: true, settings: oauth, secrets: { clientSecret: 'client-secret-1' } });
    expect(noSecrets.json()).toMatchObject({ errors: [{ pointer: '/secrets/refreshToken', code: 'secret_required' }] });
    const first = await put('bazaar', { enabled: true, settings: oauth, secrets: { clientSecret: 'client-secret-1', refreshToken: 'refresh-token-1' } });
    expect(first.statusCode, first.body).toBe(200);
    const second = await put('bazaar', { enabled: true, settings: oauth, secrets: { refreshToken: 'refresh-token-2' } });
    const kept = adminProviderSchema.parse(second.json()).panel!.secrets;
    expect(kept['clientSecret']?.fingerprint).toBe(sha12('client-secret-1'));
    expect(kept['refreshToken']?.fingerprint).toBe(sha12('refresh-token-2'));
    await waitFor(() => h.app.store.verifiers.bazaar !== undefined);
    // A stale form is refused.
    const stale = await admin(h, '/v1/admin/providers/bazaar', { kind: 'bazaar', baseVersion: 'A'.repeat(22), enabled: false, settings: oauth }, { token: superadmin.accessToken, method: 'PUT' });
    expect(stale.json()).toMatchObject({ reason: 'settings_changed' });
    expect((await remove('bazaar')).statusCode).toBe(200);
    await waitFor(() => h.app.store.verifiers.bazaar === undefined);
  });

  it('rebuilds a store client in place, and turns off a provider whose entry cannot be opened', async () => {
    const account = serviceAccount('play@demo-project.iam.gserviceaccount.com');
    const res = await put('play', { enabled: true, settings: { packageName: 'com.example.app', rtdnAudience: null, rtdnPushServiceAccountEmail: null }, secrets: { serviceAccountJson: account } });
    expect(res.statusCode, res.body).toBe(200);
    const view = adminProviderSchema.parse(res.json());
    expect(view.panel?.account?.clientEmail).toBe('play@demo-project.iam.gserviceaccount.com');
    await waitFor(() => h.app.store.verifiers.play !== undefined);
    const verifier = h.app.store.verifiers.play;
    expect((await put('play', { enabled: false, settings: { packageName: 'com.example.app', rtdnAudience: null, rtdnPushServiceAccountEmail: null } })).statusCode).toBe(200);
    await waitFor(() => h.app.store.verifiers.play === undefined);
    expect(verifier).toBeDefined();
    // Sealed under keys this deployment does not hold.
    const foreign = new DataSealer(new Map([[1, randomBytes(32)]]), 1);
    const value = { v: 1, enabled: true, settings: { verifyProfileId: 'verify-profile-1' }, secrets: foreign.seal(JSON.stringify({ apiKey: 'foreign-key-1' }), 'providers.telnyx.secrets').toString('base64') };
    await db.sql.query(`INSERT INTO app_config (key, value) VALUES ('providers.telnyx', $1::jsonb)`, [JSON.stringify(value)]);
    const version = await h.redis.incr(`${h.prefix}cfg:v`);
    await h.redis.publish(`${h.prefix}cfg:changed`, String(version));
    await waitFor(() => h.app.providers.current().sources.telnyx === 'unreadable');
    expect(h.app.sms.configured).not.toContain('telnyx');
    const telnyx = await one('telnyx');
    expect(telnyx.source).toBe('unreadable');
    expect(telnyx.panel?.secrets['apiKey']).toEqual({ set: true, fingerprint: null, unreadable: true });
    // Saving it again (with the key) makes it usable.
    expect((await put('telnyx', { enabled: true, settings: { verifyProfileId: 'verify-profile-1' }, secrets: { apiKey: 'telnyx-key-12' } })).statusCode).toBe(200);
    await waitFor(() => h.app.sms.configured.includes('telnyx'));
    expect((await remove('telnyx')).statusCode).toBe(200);
    expect((await remove('play')).statusCode).toBe(200);
  });

  it('lets one of two first saves of a kind win; the other is told the entry changed meanwhile', async () => {
    const version = (await one('smsir')).version;
    const body = (apiKey: string) => ({ kind: 'smsir', baseVersion: version, enabled: true, settings: { templateId: 100, parameter: 'CODE' }, secrets: { apiKey } });
    const auditsBefore = (await row<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_log WHERE detail->>'key' = 'providers.smsir'`)).n;
    const [a, b] = await Promise.all([
      admin(h, '/v1/admin/providers/smsir', body('first-key-1234'), { token: superadmin.accessToken, method: 'PUT' }),
      admin(h, '/v1/admin/providers/smsir', body('second-key-1234'), { token: superadmin.accessToken, method: 'PUT' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect((a.statusCode === 409 ? a : b).json()).toMatchObject({ reason: 'settings_changed' });
    const winner = a.statusCode === 200 ? 'first-key-1234' : 'second-key-1234';
    expect((await one('smsir')).panel?.secrets['apiKey']?.fingerprint).toBe(sha12(winner));
    const audits = await rows<{ before: unknown }>(db, `SELECT detail->'before' AS before FROM audit_log WHERE detail->>'key' = 'providers.smsir' ORDER BY id OFFSET $1`, [auditsBefore]);
    expect(audits).toHaveLength(1);
    expect((await remove('smsir')).statusCode).toBe(200);
  });

  it('caps provider writes at 60 an hour per admin, and gives back the count of a save that changed nothing', async () => {
    const limit = h.app.keys.signInIpLimit('provider_write', String(superadmin.account.id));
    const settings = { verifyProfileId: 'verify-profile-2' };
    expect((await put('telnyx', { enabled: true, settings, secrets: { apiKey: 'telnyx-key-34' } })).statusCode).toBe(200);
    await h.redis.set(limit, String(PROVIDER_WRITES_PER_HOUR - 1), 'PX', 3_600_000);
    // Nothing changed: the count is given back.
    expect((await put('telnyx', { enabled: true, settings })).statusCode).toBe(200);
    expect(await h.redis.get(limit)).toBe(String(PROVIDER_WRITES_PER_HOUR - 1));
    // A change takes the last one of the hour; the next is refused.
    expect((await put('telnyx', { enabled: false, settings })).statusCode).toBe(200);
    const refused = await put('telnyx', { enabled: true, settings });
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: 'rate_limited' });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    await h.redis.del(limit);
    expect((await remove('telnyx')).statusCode).toBe(200);
  });

  it('says when the processes\' reports cannot be read, and leaves out (then removes) old ones', async () => {
    const spy = vi.spyOn(h.app.redis, 'hgetall').mockRejectedValueOnce(new Error('valkey down'));
    try {
      const { res, body } = await list();
      expect(res.statusCode).toBe(200);
      expect(body!.appliedKnown).toBe(false);
      expect(body!.items.every((item) => item.applied.length === 0)).toBe(true);
    } finally {
      spy.mockRestore();
    }
    const key = h.app.keys.providersApplied();
    const report = (atMs: number) => JSON.stringify({ atMs, hash: 'x', kinds: { kavenegar: { source: 'env', fp: 'aaaaaaaaaaaa' } } });
    await h.redis.hset(key, 'api:stale-host', report(Date.now() - 10 * 60_000), 'worker:gone', report(Date.now() - 2 * 3_600_000));
    const { body } = await list();
    expect(body!.appliedKnown).toBe(true);
    const names = body!.items.flatMap((item) => item.applied.map((a) => a.name));
    expect(names).not.toContain('stale-host');
    expect(names).not.toContain('gone');
    await waitFor(async () => (await h.redis.hexists(key, 'worker:gone')) === 0);
    expect(await h.redis.hexists(key, 'api:stale-host')).toBe(1);
    // This process reports under its host name alone.
    expect(h.app.providers.processName).toMatch(/^api:[^:]+$/);
    await h.redis.hdel(key, 'api:stale-host');
  });

  it('versions the RTC settings: a stale change is refused', async () => {
    const view = (await admin(h, '/v1/admin/providers/rtc', undefined, { token: superadmin.accessToken })).json<{ version: string; maxLiveCalls: number | null }>();
    expect(view.version).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const ok = await admin(h, '/v1/admin/providers/rtc', { maxLiveCalls: 40, baseVersion: view.version }, { token: superadmin.accessToken, method: 'PUT' });
    expect(ok.statusCode, ok.body).toBe(200);
    const stale = await admin(h, '/v1/admin/providers/rtc', { maxLiveCalls: 41, baseVersion: view.version }, { token: superadmin.accessToken, method: 'PUT' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ reason: 'settings_changed' });
    // Without a version (older panels) the change is taken.
    expect((await admin(h, '/v1/admin/providers/rtc', { maxLiveCalls: null }, { token: superadmin.accessToken, method: 'PUT' })).statusCode).toBe(200);
  });
});

describe.skipIf(!hasInfrastructure)('admin: Play notifications follow the panel\'s Play entry', () => {
  const PKG_ENV = 'com.example.app';
  const PKG_PANEL = 'com.example.panel';
  const AUD_ENV = 'https://api.example.test/v1/webhooks/play/rtdn';
  const AUD_PANEL = 'https://api.example.test/v1/webhooks/play/rtdn?panel=1';
  const EMAIL = 'rtdn-push@example-project.iam.gserviceaccount.com';
  const google = new FakeGooglePlay({ packageName: PKG_ENV });
  const jobs = new MemoryJobProducer();
  let db: TestDatabase;
  let h: AdminHarness;
  let superadmin: AdminSession;

  beforeAll(async () => {
    await google.start();
    db = await migratedDatabase();
    h = await startAdminHarness(
      db,
      {
        PLAY_PACKAGE_NAME: PKG_ENV,
        PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: google.account.clientEmail, private_key: google.account.privateKey, private_key_id: google.account.privateKeyId }),
        PLAY_RTDN_AUDIENCE: AUD_ENV,
        PLAY_RTDN_PUSH_SA_EMAIL: EMAIL,
      },
      {
        jobs,
        providers: {
          reportEveryMs: 60_000,
          // Google's OIDC check against the fake's keys: the audience is the one each entry names.
          rtdnAuthenticator: (rtdn) => new PubSubOidcVerifier({ audience: rtdn.audience, serviceAccountEmail: rtdn.pushServiceAccountEmail, jwksUrl: google.jwksUrl }),
        },
      },
    );
    superadmin = await adminAs(h, 'superadmin');
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await db?.drop();
    await google.stop();
  });

  let messageId = 9_100_000_000;
  const post = async (packageName: string, audience: string) => {
    messageId += 1;
    const data = FakeGooglePlay.data({ version: '1.0', packageName, eventTimeMillis: String(Date.now()), subscriptionNotification: { version: '1.0', notificationType: 4, purchaseToken: `tok-${messageId}` } });
    const before = jobs.jobs.length;
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/webhooks/play/rtdn',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await google.pushToken({ audience, email: EMAIL })}` },
      payload: JSON.stringify({ message: { data, messageId: String(messageId), message_id: String(messageId), attributes: {} }, subscription: 'projects/example/subscriptions/rtdn' }),
    });
    return { status: res.statusCode, queued: jobs.jobs.length > before };
  };
  const play = async () => (await admin(h, '/v1/admin/providers', undefined, { token: superadmin.accessToken })).json<{ items: AdminProvider[] }>().items.find((i) => i.kind === 'play')!;
  const putPlay = async (body: Record<string, unknown>) => admin(h, '/v1/admin/providers/play', { kind: 'play', baseVersion: (await play()).version, ...body }, { token: superadmin.accessToken, method: 'PUT' });
  const account = () => JSON.stringify({ client_email: google.account.clientEmail, private_key: google.account.privateKey, private_key_id: google.account.privateKeyId });
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 300 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(check()).toBe(true);
  };

  it('takes the deployment\'s, then the panel\'s package and audience, refuses when the panel turns Play off, and goes back', async () => {
    expect(await post(PKG_ENV, AUD_ENV)).toEqual({ status: 204, queued: true });
    expect((await post(PKG_ENV, AUD_PANEL)).status).toBe(401);
    // The deployment takes notifications: a panel entry without its audience would drop them all.
    const without = await putPlay({ enabled: true, settings: { packageName: PKG_PANEL, rtdnAudience: null, rtdnPushServiceAccountEmail: null }, secrets: { serviceAccountJson: account() } });
    expect(without.statusCode).toBe(422);
    expect(without.json()).toMatchObject({ errors: [{ pointer: '/settings/rtdnAudience', code: 'rtdn_required' }] });
    const saved = await putPlay({ enabled: true, settings: { packageName: PKG_PANEL, rtdnAudience: AUD_PANEL, rtdnPushServiceAccountEmail: EMAIL }, secrets: { serviceAccountJson: account() } });
    expect(saved.statusCode, saved.body).toBe(200);
    await until(() => h.app.providers.playRtdn()?.packageName === PKG_PANEL);
    // The panel's audience and package: its notifications are taken, the old package's dropped, the old audience refused.
    expect(await post(PKG_PANEL, AUD_PANEL)).toEqual({ status: 204, queued: true });
    expect(await post(PKG_ENV, AUD_PANEL)).toEqual({ status: 204, queued: false });
    expect((await post(PKG_PANEL, AUD_ENV)).status).toBe(401);
    // Play off in the panel: notifications are refused (Pub/Sub keeps them) until it is on again.
    expect((await putPlay({ enabled: false, settings: { packageName: PKG_PANEL, rtdnAudience: AUD_PANEL, rtdnPushServiceAccountEmail: EMAIL } })).statusCode).toBe(200);
    await until(() => h.app.providers.playRtdn() === null);
    expect((await post(PKG_PANEL, AUD_PANEL)).status).toBe(503);
    // Back to the deployment's values.
    const cleared = await admin(h, '/v1/admin/providers/play', { baseVersion: (await play()).version }, { token: superadmin.accessToken, method: 'DELETE' });
    expect(cleared.statusCode).toBe(200);
    await until(() => h.app.providers.playRtdn()?.packageName === PKG_ENV);
    expect(await post(PKG_ENV, AUD_ENV)).toEqual({ status: 204, queued: true });
    expect((await post(PKG_PANEL, AUD_PANEL)).status).toBe(401);
  });
});

describe.skipIf(!hasInfrastructure)('admin: provider credentials without PROVIDER_KEYS (outside production)', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  let superadmin: AdminSession;

  beforeAll(async () => {
    db = await migratedDatabase();
    // An empty value is an unset one: the API starts, as the worker does, with no ring for the panel's entries.
    h = await startAdminHarness(db, { PROVIDER_KEYS: '' }, { providers: { reportEveryMs: 60_000 } });
    superadmin = await adminAs(h, 'superadmin');
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await db?.drop();
  });

  const telnyx = async (): Promise<AdminProvider> => {
    const res = await admin(h, '/v1/admin/providers', undefined, { token: superadmin.accessToken });
    expect(res.statusCode, res.body).toBe(200);
    return adminProvidersSchema.parse(res.json()).items.find((item) => item.kind === 'telnyx')!;
  };

  it('starts, shows a stored entry as unreadable, refuses saves without writing, and still goes back to the deployment\'s values', async () => {
    expect(h.app.config.secrets.providerKeys).toBeUndefined();
    expect(h.app.providers.sealer).toBeNull();
    expect(h.logs.join('\n')).toContain('PROVIDER_KEYS is not set');
    // An entry another deployment sealed.
    const foreign = new DataSealer(new Map([[1, randomBytes(32)]]), 1);
    const value = { v: 1, enabled: true, settings: { verifyProfileId: 'verify-profile-1' }, secrets: foreign.seal(JSON.stringify({ apiKey: 'foreign-key-1' }), 'providers.telnyx.secrets').toString('base64') };
    await db.sql.query(`INSERT INTO app_config (key, value) VALUES ('providers.telnyx', $1::jsonb)`, [JSON.stringify(value)]);
    const version = await h.redis.incr(`${h.prefix}cfg:v`);
    await h.redis.publish(`${h.prefix}cfg:changed`, String(version));
    for (let i = 0; i < 300 && h.app.providers.current().sources.telnyx !== 'unreadable'; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.app.providers.current().sources.telnyx).toBe('unreadable');
    expect(h.app.sms.configured).not.toContain('telnyx');
    const view = await telnyx();
    expect(view.source).toBe('unreadable');
    expect(view.panel?.secrets['apiKey']).toEqual({ set: true, fingerprint: null, unreadable: true });
    // A save is refused before anything is read or written: no audit row, the stored value unchanged.
    const auditsBefore = (await row<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_log WHERE detail->>'key' = 'providers.telnyx'`)).n;
    const before = (await row<{ v: string }>(db, `SELECT value::text AS v FROM app_config WHERE key = 'providers.telnyx'`)).v;
    for (const kind of ['telnyx', 'kavenegar']) {
      const res = await admin(h, `/v1/admin/providers/${kind}`, { kind, baseVersion: view.version, enabled: true, settings: kind === 'telnyx' ? { verifyProfileId: 'verify-profile-1' } : { template: 'otp' }, secrets: { apiKey: 'new-key-123' } }, { token: superadmin.accessToken, method: 'PUT' });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toMatchObject({ reason: 'read_only' });
      expect(statements(res)).toBe(0);
    }
    expect((await row<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_log WHERE detail->>'key' = 'providers.telnyx'`)).n).toBe(auditsBefore);
    expect((await row<{ v: string }>(db, `SELECT value::text AS v FROM app_config WHERE key = 'providers.telnyx'`)).v).toBe(before);
    expect((await rows(db, `SELECT 1 FROM app_config WHERE key = 'providers.kavenegar'`)).length).toBe(0);
    // Clearing needs no key: back to the deployment's values (none here), audited as unreadable.
    const cleared = await admin(h, '/v1/admin/providers/telnyx', { baseVersion: (await telnyx()).version }, { token: superadmin.accessToken, method: 'DELETE' });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(adminProviderSchema.parse(cleared.json())).toMatchObject({ source: 'none', panel: null });
    expect((await lastAudit(db, { action: 'config.update', targetType: 6 }))?.detail).toMatchObject({ key: 'providers.telnyx', cleared: true, before: 'unreadable' });
  });
});
