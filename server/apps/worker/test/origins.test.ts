import { ConfigError } from '@app/config';
import {
  FakeObjectStorage,
  OriginsSigner,
  createKeys,
  generateOriginsKeyPair,
  originsKeys,
  storeOriginsDocument,
  verifyOriginsDocument,
  type MediaStore,
} from '@app/shared/server';
import type { OriginsPayload } from '@app/shared';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, systemQueue, type JobContext } from '../src/index.js';
import { NotSignedYetError, REPUBLISH_AFTER_MS, publishOrigins } from '../src/origins/publish.js';
import { ORIGINS_OBJECT_KEY, PublishError, parsePublishTargets, targetOf, type PublishTarget } from '../src/origins/targets.js';
import type { WorkerServices } from '../src/services.js';
import { takeWorkerSlot } from '../src/workerSlot.js';
import { TEST_REDIS_URL, baseEnv, connect, hasRedis } from './support.js';

/**
 * Publishing the signed origins document to the bootstrap targets: the
 * worker copies the newest document the API stored in Valkey to each target
 * that does not hold it yet, once a day again, and keeps a record per target.
 */

const pair = generateOriginsKeyPair();
const signer = new OriginsSigner('o1', pair.privateKey);
const log = pino({ level: 'silent' });

function payload(version: number, issuedAt: string): OriginsPayload {
  return {
    brand: '_template',
    version,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + 30 * 86_400_000).toISOString(),
    hosts: { api: ['https://api.example.com'], realtime: [], rtc: [], cdn: ['https://cdn.example.com'], web: [] },
    bootstrap: ['https://cdn.example.com/bootstrap/origins.json'],
  };
}

class MemoryTarget implements PublishTarget {
  readonly bodies: string[] = [];
  failing = false;
  constructor(readonly id: string) {}
  async put(body: Uint8Array): Promise<void> {
    if (this.failing) throw new PublishError(this.id, 'answered 503');
    this.bodies.push(new TextDecoder().decode(body));
  }
}

describe('publish targets from the environment', () => {
  it('reads S3 buckets and PUT endpoints, with defaults', () => {
    const targets = parsePublishTargets(
      JSON.stringify([
        { kind: 's3', id: 'r2', endpoint: 'https://acct.r2.example.net', bucket: 'boot', accessKeyId: 'id', secretAccessKey: 'secret-value-123' },
        { kind: 'put', id: 'mirror', url: 'https://storage.example.org/zone/origins.json', headers: { AccessKey: 'k' } },
      ]),
    );
    expect(targets).toEqual([
      { kind: 's3', id: 'r2', endpoint: 'https://acct.r2.example.net', region: 'auto', bucket: 'boot', key: ORIGINS_OBJECT_KEY, accessKeyId: 'id', secretAccessKey: 'secret-value-123', pathStyle: true },
      { kind: 'put', id: 'mirror', url: 'https://storage.example.org/zone/origins.json', headers: { AccessKey: 'k' } },
    ]);
  });

  it('refuses what it cannot use, naming the entry and the field, never a value', () => {
    const refused = (value: unknown): string => {
      try {
        parsePublishTargets(typeof value === 'string' ? value : JSON.stringify(value));
        return 'accepted';
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(refused('not json')).toBe('must be a JSON array of targets');
    expect(refused([{ kind: 'put', id: 'm', url: 'http://insecure.example.org/o.json' }])).toMatch(/^target 0\.url/);
    expect(refused([{ kind: 's3', id: 'x', endpoint: 'https://s3.example.net', bucket: 'B!', accessKeyId: 'id', secretAccessKey: 'top-secret-value' }])).toMatch(/^target 0\.bucket/);
    expect(refused([{ kind: 's3', id: 'x', endpoint: 'https://s3.example.net', bucket: 'ok', key: '../up', accessKeyId: 'id', secretAccessKey: 'top-secret-value' }])).not.toContain('top-secret-value');
    expect(refused([{ kind: 'put', id: 'a', url: 'https://a.example.org/o.json' }, { kind: 'put', id: 'a', url: 'https://b.example.org/o.json' }])).toMatch(/same id/);
    expect(refused([{ kind: 'put', id: 'media', url: 'https://a.example.org/o.json' }])).toMatch(/media/);
    expect(refused([{ kind: 'ftp', id: 'a' }])).toMatch(/^target 0/);
  });

  it('is part of the worker configuration, which refuses a bad list by name', () => {
    expect(loadConfig({ ...baseEnv(), REDIS_URL: 'redis://127.0.0.1:1/0' }).origins).toEqual({ media: true, targets: [] });
    let error: unknown;
    try {
      loadConfig({ ...baseEnv(), REDIS_URL: 'redis://127.0.0.1:1/0', ORIGINS_PUBLISH_TARGETS: '[{"kind":"s3","secretAccessKey":"hunter2-secret"}]' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toMatch(/ORIGINS_PUBLISH_TARGETS/);
    expect(String(error)).not.toContain('hunter2-secret');
  });

  it('uploads to an S3 bucket with a signed PUT and to a plain endpoint with its headers', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    let status = 200;
    const fetchFn = async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response('', { status });
    };
    const body = new TextEncoder().encode('{"alg":"Ed25519"}');
    const [s3, put] = parsePublishTargets(
      JSON.stringify([
        { kind: 's3', id: 'r2', endpoint: 'https://acct.r2.example.net', bucket: 'boot', key: 'o/origins.json', accessKeyId: 'AKID', secretAccessKey: 'secret' },
        { kind: 'put', id: 'mirror', url: 'https://storage.example.org/zone/origins.json', headers: { AccessKey: 'k-123' } },
      ]),
    );
    await targetOf(s3!, fetchFn).put(body);
    await targetOf(put!, fetchFn).put(body);
    expect(requests[0]?.url).toBe('https://acct.r2.example.net/boot/o/origins.json');
    const s3Headers = requests[0]?.init.headers as Record<string, string>;
    expect(requests[0]?.init.method).toBe('PUT');
    expect(s3Headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=.*content-type.*, Signature=[0-9a-f]{64}$/);
    expect(s3Headers['content-type']).toBe('application/json');
    expect(s3Headers['cache-control']).toBe('public, max-age=300');
    expect(requests[1]).toMatchObject({ url: 'https://storage.example.org/zone/origins.json', init: { method: 'PUT', headers: { AccessKey: 'k-123', 'content-type': 'application/json' } } });
    status = 401;
    await expect(targetOf(put!, fetchFn).put(body)).rejects.toThrow(/mirror: answered 401/);
    await expect(targetOf(s3!, fetchFn).put(body)).rejects.toThrow(/answered 401/);
    const unreachable = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(targetOf(put!, unreachable).put(body)).rejects.toThrow(/mirror: unreachable/);
  });
});

describe.skipIf(!hasRedis)('publishing the document (redis-server)', () => {
  let redis: Redis;
  const prefix = `t${Math.random().toString(36).slice(2, 10)}:`;
  const keys = createKeys(prefix);

  async function store(version: number, issuedAt: string): Promise<string> {
    const body = JSON.stringify(signer.sign(payload(version, issuedAt)));
    await storeOriginsDocument(redis, keys, { version, issuedAtMs: Date.parse(issuedAt), signerStartedAtMs: 1, body });
    return body;
  }

  beforeAll(() => {
    redis = connect();
  });
  afterAll(async () => {
    const left = await redis.keys(`${prefix}*`);
    if (left.length > 0) await redis.del(...left);
    await redis.quit();
  });

  it('copies the newest document to every target once, then again only for a new version, a failure or a day later', async () => {
    const a = new MemoryTarget('a');
    const b = new MemoryTarget('b');
    let now = Date.parse('2026-11-09T10:30:00.000Z');
    const context = { redis, keys, targets: [a, b], log, now: () => now };

    expect(await publishOrigins(context)).toEqual({ outcome: 'nothing_signed', published: [], failed: [] });
    // Right after a save the job waits (and is retried) until the API signed that version.
    await expect(publishOrigins(context, 2)).rejects.toThrow(NotSignedYetError);

    const v2 = await store(2, '2026-11-09T10:00:00.000Z');
    b.failing = true;
    expect(await publishOrigins(context, 2)).toEqual({ outcome: 'published', version: 2, published: ['a'], failed: ['b'] });
    expect(a.bodies).toEqual([v2]);
    // The bytes are the API's, signature included.
    expect(verifyOriginsDocument(JSON.parse(a.bodies[0]!), { keys: [{ kid: 'o1', key: pair.publicKey }], now: new Date(now) }).version).toBe(2);
    expect(await redis.hgetall(originsKeys(keys).published('a'))).toMatchObject({ v: '2', at: String(now) });
    expect(await redis.exists(originsKeys(keys).published('b'))).toBe(0);

    // The next round retries only the target that failed.
    b.failing = false;
    now += 600_000;
    expect(await publishOrigins(context)).toEqual({ outcome: 'published', version: 2, published: ['b'], failed: [] });
    expect(await publishOrigins(context)).toEqual({ outcome: 'current', version: 2, published: [], failed: [] });

    // The same hosts signed again an hour later: not uploaded until a day passed.
    await store(2, '2026-11-09T11:00:00.000Z');
    now = Date.parse('2026-11-09T11:30:00.000Z');
    expect((await publishOrigins(context)).outcome).toBe('current');
    // a was last written at 10:30, b at 10:40 (its retry): each a day after its own upload.
    now = Date.parse('2026-11-09T10:30:00.000Z') + REPUBLISH_AFTER_MS + 1;
    expect(await publishOrigins(context)).toEqual({ outcome: 'published', version: 2, published: ['a'], failed: [] });
    now = Date.parse('2026-11-09T10:40:00.000Z') + REPUBLISH_AFTER_MS + 1;
    expect(await publishOrigins(context)).toEqual({ outcome: 'published', version: 2, published: ['b'], failed: [] });

    // A new version goes out at once.
    const v3 = await store(3, '2026-11-10T11:00:00.000Z');
    expect((await publishOrigins(context, 3)).published).toEqual(['a', 'b']);
    expect(a.bodies.at(-1)).toBe(v3);
    expect(a.bodies).toHaveLength(3);
  });

  it('never publishes bytes apps could not read', async () => {
    const other = createKeys(`${prefix}x:`);
    const target = new MemoryTarget('a');
    await storeOriginsDocument(redis, other, { version: 4, issuedAtMs: 1, signerStartedAtMs: 1, body: '{"not":"a document"}' });
    expect(await publishOrigins({ redis, keys: other, targets: [target], log })).toEqual({ outcome: 'current', version: 4, published: [], failed: ['a'] });
    expect(target.bodies).toEqual([]);
  });

  it('runs as the system queue\'s origins-publish job, writing bootstrap/origins.json to the media bucket the CDN serves', async () => {
    const jobPrefix = `${prefix}job:`;
    const jobKeys = createKeys(jobPrefix);
    const storage = new FakeObjectStorage();
    const media: MediaStore = { storage, privateBucket: 'uploads', mediaBucket: 'media', urls: null };
    const config = loadConfig({ ...baseEnv(), REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: jobPrefix, WORKER_ID: 'origins-test' });
    const context: JobContext = { config, redis, log, services: { keys: jobKeys, media } as unknown as WorkerServices };
    const job = (data: Record<string, unknown>) =>
      ({ name: 'origins-publish', id: 'origins-publish.5', data, opts: {}, attemptsMade: 0, timestamp: Date.now() }) as unknown as Job<Record<string, unknown>, unknown>;

    const body = JSON.stringify(signer.sign(payload(5, new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString())));
    await storeOriginsDocument(redis, jobKeys, { version: 5, issuedAtMs: 1, signerStartedAtMs: 1, body });
    await expect(systemQueue.process(job({ version: 6 }), context)).rejects.toThrow(NotSignedYetError);
    expect(await systemQueue.process(job({ version: 5 }), context)).toMatchObject({ outcome: 'published', published: ['media'] });
    expect(new TextDecoder().decode((await storage.getObject('media', ORIGINS_OBJECT_KEY)) ?? new Uint8Array())).toBe(body);
    expect(storage.objects.get(`media/${ORIGINS_OBJECT_KEY}`)?.contentType).toBe('application/json');
    // The scheduled round (no version) finds it current.
    expect(await systemQueue.process(job({}), context)).toMatchObject({ outcome: 'current' });
    // Without storage and without other targets there is nowhere to publish.
    const bare: JobContext = { ...context, services: { keys: jobKeys, media: null } as unknown as WorkerServices };
    expect(await systemQueue.process(job({}), bare)).toMatchObject({ outcome: 'no_targets' });
  });

  it('names a worker without WORKER_ID after a leased slot, never twice', async () => {
    const slotPrefix = `${prefix}slot:`;
    const config = loadConfig({ ...baseEnv(), REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: slotPrefix });
    expect(config.workerIdSource).toBe('lease');
    expect(loadConfig({ ...baseEnv(), REDIS_URL: TEST_REDIS_URL ?? '', WORKER_ID: 'by-hand' }).workerIdSource).toBe('env');
    const lost: string[] = [];
    const first = await takeWorkerSlot(config, { onLost: () => lost.push('first') });
    const second = await takeWorkerSlot(config, { onLost: () => lost.push('second') });
    expect([first.config.workerId, second.config.workerId]).toEqual(['w0', 'w1']);
    expect(await redis.exists(`${slotPrefix}wslot:0`, `${slotPrefix}wslot:1`)).toBe(2);
    // A worker that stops frees its name for the next one.
    await first.release();
    const third = await takeWorkerSlot(config, { onLost: () => lost.push('third') });
    expect(third.config.workerId).toBe('w0');
    await Promise.all([second.release(), third.release()]);
    expect(lost).toEqual([]);
  });
});
