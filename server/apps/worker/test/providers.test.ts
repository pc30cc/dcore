import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mergeProviderUpdate, providerFingerprint } from '@app/config';
import { createPool, type Pool } from '@app/db';
import { DataSealer, createKeys, type PushSender } from '@app/shared/server';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { envVariables, loadConfig } from '../src/config.js';
import { WorkerProviders, sealerOf } from '../src/providers.js';
import type { QueueDefinition } from '../src/queues/types.js';
import { startWorker } from '../src/worker.js';
import type { WorkerServices } from '../src/services.js';
import { hasDatabase, migratedDatabase, type TestDatabase } from './db.js';
import { TEST_REDIS_URL, baseEnv, connect, hasRedis } from './support.js';

/**
 * The worker's provider loop: FCM and the store clients follow the admin
 * panel's entries within one check of `cfg:v`, the first read happens before
 * the queues start, and each process reports what it uses (fingerprints and
 * the photo moderation state) to `prov:applied`.
 */

function serviceAccount(): string {
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return JSON.stringify({ client_email: 'push@demo-project.iam.gserviceaccount.com', private_key: privateKey, project_id: 'demo-project' });
}

describe.skipIf(!hasDatabase || !hasRedis)('worker: provider credentials from the panel', () => {
  let db: TestDatabase;
  let pool: Pool;
  let redis: Redis;
  const prefix = `t${randomBytes(4).toString('hex')}:`;
  const keys = createKeys(prefix);
  const log = pino({ level: 'silent' });
  const rawKey = randomBytes(32);
  const providerKeys = JSON.stringify({ 1: rawKey.toString('base64url') });
  const sealer = new DataSealer(new Map([[1, rawKey]]), 1);
  const envPush = { send: async () => ({ ok: true }) } as unknown as PushSender;

  beforeAll(async () => {
    db = await migratedDatabase();
    pool = createPool({ connectionString: db.url, applicationName: 'worker-providers-test', max: 2 });
    redis = connect();
  }, 60_000);

  afterAll(async () => {
    const stale = await redis?.keys(`${prefix}*`);
    if (stale?.length) await redis.del(...stale);
    redis?.disconnect();
    await pool?.end();
    await db?.drop();
  });

  const services = (): WorkerServices => ({ pg: pool, push: envPush, iap: { verifiers: {} } }) as unknown as WorkerServices;
  const save = async (key: string, value: unknown) => {
    await db.admin.query(`INSERT INTO app_config (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(value)]);
    await redis.incr(keys.configVersion());
  };
  const remove = async (key: string) => {
    await db.admin.query(`DELETE FROM app_config WHERE key = $1`, [key]);
    await redis.incr(keys.configVersion());
  };

  it('replaces the FCM sender after a panel save, turns it off, and goes back to the deployment\'s', async () => {
    const config = loadConfig({ ...baseEnv(), REDIS_URL: 'redis://localhost:6379', PROVIDER_KEYS: providerKeys, WORKER_ID: 'wtest1' });
    const own = services();
    const made: string[] = [];
    const providers = new WorkerProviders({ config, services: own, redis, keys, log, checkMs: 60_000, pushSender: (account) => (made.push(account.clientEmail), { send: async () => ({ ok: true }) }) as unknown as PushSender });
    await providers.start();
    expect(own.push).toBe(envPush);
    const sa = serviceAccount();
    await save('providers.fcm', mergeProviderUpdate('fcm', null, { enabled: true, settings: { projectId: null }, secrets: { serviceAccountJson: sa } }, sealer).value);
    await providers.refresh();
    expect(made).toEqual(['push@demo-project.iam.gserviceaccount.com']);
    expect(own.push).not.toBe(envPush);
    expect(providers.current().sources.fcm).toBe('panel');
    // Unchanged cfg:v: nothing is read or rebuilt.
    await providers.refresh();
    expect(made).toHaveLength(1);
    const report = JSON.parse((await redis.hget(keys.providersApplied(), 'worker:wtest1')) ?? '{}') as { kinds: Record<string, { source: string; fp: string | null }>; moderation: { provider: string; autoApprove: boolean } };
    expect(report.kinds['fcm']).toEqual({ source: 'panel', fp: providerFingerprint((JSON.parse(sa) as { private_key: string }).private_key) });
    expect(report.moderation).toEqual({ provider: 'fake', autoApprove: false });
    await save('providers.fcm', mergeProviderUpdate('fcm', null, { enabled: false, settings: { projectId: null }, secrets: { serviceAccountJson: sa } }, sealer).value);
    await providers.refresh();
    expect(own.push).toBeNull();
    await remove('providers.fcm');
    await providers.refresh();
    expect(own.push).toBe(envPush);
    await providers.stop();
  });

  it('reports the process state with the providers, after a new settings version, and removes it on stop', async () => {
    const config = loadConfig({ ...baseEnv(), REDIS_URL: 'redis://localhost:6379', PROVIDER_KEYS: providerKeys, WORKER_ID: 'wproc1' });
    const providers = new WorkerProviders({ config, services: services(), redis, keys, log, checkMs: 60_000, process: { startedAtMs: 1_000, queues: ['photo', 'maint'], streams: ['like'], maint: true } });
    await providers.start();
    const read = async () => JSON.parse((await redis.hget(keys.providersApplied(), 'worker:wproc1')) ?? 'null') as { atMs: number; proc: Record<string, unknown> } | null;
    const version = Number((await redis.get(keys.configVersion())) ?? '0');
    expect((await read())?.proc).toEqual({ kind: 'worker', startedAtMs: 1_000, cfgVersion: version, queues: ['photo', 'maint'], streams: ['like'], maint: true });
    // A settings change with no provider change still shows the new version at once.
    await save('app.maintenance', { enabled: false });
    await providers.refresh();
    expect((await read())?.proc['cfgVersion']).toBe(version + 1);
    await providers.stop();
    expect(await read()).toBeNull();
  });

  it('builds a store client from the panel\'s entry, and reads an entry as unreadable without PROVIDER_KEYS', async () => {
    const value = mergeProviderUpdate('play', null, { enabled: true, settings: { packageName: 'com.example.app', rtdnAudience: null, rtdnPushServiceAccountEmail: null }, secrets: { serviceAccountJson: serviceAccount() } }, sealer).value;
    await save('providers.play', value);
    const withKeys = services();
    const providers = new WorkerProviders({ config: loadConfig({ ...baseEnv(), REDIS_URL: 'redis://localhost:6379', PROVIDER_KEYS: providerKeys, WORKER_ID: 'wtest2' }), services: withKeys, redis, keys, log, checkMs: 60_000 });
    await providers.start();
    expect(withKeys.iap?.verifiers.play).toBeDefined();
    expect(providers.current().sources.play).toBe('panel');
    await providers.stop();
    const without = services();
    const blind = new WorkerProviders({ config: loadConfig({ ...baseEnv(), REDIS_URL: 'redis://localhost:6379', WORKER_ID: 'wtest3' }), services: without, redis, keys, log, checkMs: 60_000 });
    await blind.start();
    expect(blind.current().sources.play).toBe('unreadable');
    expect(without.iap?.verifiers.play).toBeUndefined();
    await blind.stop();
    await remove('providers.play');
  });

  it('requires PROVIDER_KEYS in production and never takes DATA_KEYS', () => {
    expect(() => loadConfig({ ...baseEnv(), REDIS_URL: 'redis://localhost:6379', NODE_ENV: 'production' })).toThrow(/PROVIDER_KEYS/);
    expect(() => loadConfig({ ...baseEnv(), REDIS_URL: 'redis://localhost:6379', PROVIDER_KEYS: providerKeys, PROVIDER_KEY_ID: '2' })).toThrow(/PROVIDER_KEY_ID/);
    // The API's master ring is not a variable of the worker: set by mistake, it is not read and opens nothing here.
    expect(envVariables).not.toContain('DATA_KEYS');
    expect(envVariables).not.toContain('DATA_KEY_ID');
    expect(envVariables).not.toContain('HASH_PEPPERS');
    const masterKey = randomBytes(32).toString('base64url');
    const config = loadConfig({ ...baseEnv(), REDIS_URL: 'redis://localhost:6379', DATA_KEYS: JSON.stringify({ 1: masterKey }) });
    expect(config.providerKeys).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain(masterKey);
    expect(sealerOf(config)).toBeNull();
  });

  it('applies the panel\'s FCM entry before any queue worker takes a job queued earlier', async () => {
    const sa = serviceAccount();
    await save('providers.fcm', mergeProviderUpdate('fcm', null, { enabled: true, settings: { projectId: null }, secrets: { serviceAccountJson: sa } }, sealer).value);
    const config = loadConfig({ ...baseEnv(), REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix, PROVIDER_KEYS: providerKeys, WORKER_ID: 'wtest4' });
    const panelPush = { send: async () => ({ ok: true }) } as unknown as PushSender;
    const own: WorkerServices = { ...services(), keys };
    // A job waiting in its queue before the worker starts.
    const queue = new Queue('probe', { connection: redis, prefix: config.queuePrefix });
    await queue.add('send', {});
    const used: unknown[] = [];
    const probe: QueueDefinition = {
      name: 'probe',
      async process(_job, context) {
        used.push(context.services.push);
        return null;
      },
    };
    const runtime = await startWorker(config, { logger: log, queues: [probe], consumers: [], services: own, providers: { checkMs: 60_000, pushSender: () => panelPush } });
    try {
      for (let i = 0; i < 500 && used.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(used).toEqual([panelPush]);
    } finally {
      await runtime.stop();
      await queue.obliterate({ force: true });
      await queue.close();
      await remove('providers.fcm');
    }
  });
});
