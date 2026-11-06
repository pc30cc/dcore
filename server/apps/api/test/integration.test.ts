import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApiApp } from '../src/app.js';
import { TEST_DATABASE_URL, TEST_REDIS_URL, hasInfrastructure, testApp, testConfig } from './support.js';

describe.skipIf(!hasInfrastructure)('with PostgreSQL and Redis', () => {
  let app: ApiApp;
  let redis: Redis;
  let prefix: string;

  beforeAll(() => {
    redis = new Redis(TEST_REDIS_URL ?? '');
  });
  afterAll(async () => {
    await redis.quit();
  });
  afterEach(async () => {
    await app?.close();
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length > 0) await redis.del(...keys);
  });

  async function started(env: Record<string, string> = {}): Promise<ApiApp> {
    const config = testConfig({ DATABASE_URL: TEST_DATABASE_URL ?? '', REDIS_URL: TEST_REDIS_URL ?? '', ...env });
    prefix = config.redis.keyPrefix;
    app = await testApp(config);
    app.get('/test/ping', async () => ({ pong: true }));
    await app.ready();
    // ready() starts the Redis connection without waiting for it.
    while (app.redis.status !== 'ready') await new Promise((resolve) => setTimeout(resolve, 10));
    return app;
  }

  it('is ready when both answer', async () => {
    const res = await (await started()).inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ready',
      checks: { postgres: { status: 'up' }, redis: { status: 'up' } },
    });
  });

  it('limits requests per client in Redis and answers 429 as problem+json', async () => {
    const instance = await started({ RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_MS: '60000' });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await instance.inject({ method: 'GET', url: '/test/ping' })).statusCode);
    expect(statuses).toEqual([200, 200, 200, 429]);

    const limited = await instance.inject({ method: 'GET', url: '/test/ping' });
    expect(limited.headers['content-type']).toBe('application/problem+json; charset=utf-8');
    expect(limited.json()).toMatchObject({ code: 'rate_limited', status: 429 });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.headers['x-ratelimit-limit']).toBe('3');
    expect(await redis.keys(`${prefix}rl:*`)).not.toHaveLength(0);

    // Probes are never limited, and a signed-in user has a bucket of their own.
    expect((await instance.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const { token } = await instance.tokens.issue({ kind: 'app', subject: 'u_1', sessionId: 's_1' });
    const signedIn = await instance.inject({ method: 'GET', url: '/test/ping', headers: { authorization: `Bearer ${token}` } });
    expect(signedIn.statusCode).toBe(200);
  });

  it('shares one readiness check between concurrent probes', async () => {
    const instance = await started({ READINESS_CACHE_MS: '5000' });
    const ping = vi.spyOn(instance.redis, 'ping');
    const results = await Promise.all(Array.from({ length: 20 }, () => instance.inject({ method: 'GET', url: '/readyz' })));
    expect(results.every((res) => res.statusCode === 200)).toBe(true);
    expect(ping).toHaveBeenCalledTimes(1);
  });
});
