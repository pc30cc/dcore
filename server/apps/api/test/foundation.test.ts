import { many, one, sql, withTransaction } from '@app/db';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ApiApp } from '../src/app.js';
import { STATEMENTS_HEADER } from '../src/plugins/pgBudget.js';
import { TEST_DATABASE_URL, TEST_REDIS_URL, UNREACHABLE_REDIS_URL, hasInfrastructure, testApp, testConfig } from './support.js';

/** The request-path foundation against real PostgreSQL and Redis: statement budgets, the deny list, id leases. */
describe.skipIf(!hasInfrastructure)('foundation plugins (PostgreSQL and Redis)', () => {
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

  async function started(env: Record<string, string> = {}, routes?: (instance: ApiApp) => void): Promise<ApiApp> {
    const config = testConfig({ DATABASE_URL: TEST_DATABASE_URL ?? '', REDIS_URL: TEST_REDIS_URL ?? '', ...env });
    prefix = config.redis.keyPrefix;
    app = await testApp(config);
    routes?.(app);
    await app.ready();
    while (app.redis.status !== 'ready') await new Promise((resolve) => setTimeout(resolve, 10));
    return app;
  }

  describe('statement budgets', () => {
    const routes = (instance: ApiApp) => {
      const pool = instance.pg;
      instance.get('/test/one', { config: { pgBudget: 1 } }, async () => one(pool, sql`SELECT 1 AS v`));
      instance.get('/test/two-over', { config: { pgBudget: 1 } }, async () => {
        await one(pool, sql`SELECT 1 AS v`);
        return one(pool, sql`SELECT 2 AS v`);
      });
      instance.get('/test/swallowed', { config: { pgBudget: 0 } }, async () => {
        // A handler that catches the refusal still fails the request.
        await one(pool, sql`SELECT 1 AS v`).catch(() => undefined);
        return { ok: true };
      });
      instance.get('/test/tx', { config: { pgBudget: 2 } }, async () =>
        withTransaction(pool, async (tx) => {
          await many(tx, sql`SELECT 1 AS v`);
          return one(tx, sql`SELECT 2 AS v`);
        }),
      );
      instance.post(
        '/test/body',
        { config: { pgBudget: 1 }, schema: { body: z.object({ n: z.number().int() }) } },
        async (request) => one(pool, sql`SELECT ${(request.body).n}::int AS v`),
      );
    };

    it('counts each request, refuses the statement past the budget and fails the request', async () => {
      const instance = await started({}, routes);
      const okResponse = await instance.inject({ method: 'GET', url: '/test/one' });
      expect(okResponse.statusCode).toBe(200);
      expect(okResponse.headers[STATEMENTS_HEADER]).toBe('1');

      const over = await instance.inject({ method: 'GET', url: '/test/two-over' });
      expect(over.statusCode).toBe(500);
      expect(over.json()).toMatchObject({ code: 'internal', detail: expect.stringContaining('budget of 1') as unknown });
      expect(over.headers[STATEMENTS_HEADER]).toBe('2');

      const swallowed = await instance.inject({ method: 'GET', url: '/test/swallowed' });
      expect(swallowed.statusCode).toBe(500);

      const tx = await instance.inject({ method: 'GET', url: '/test/tx' });
      expect(tx.statusCode).toBe(200);
      expect(tx.headers[STATEMENTS_HEADER]).toBe('2');
    });

    it('keeps counting after the body is parsed, and per request under concurrency', async () => {
      const instance = await started({ DATABASE_POOL_MAX: '1' }, routes);
      const body = await instance.inject({ method: 'POST', url: '/test/body', payload: { n: 7 } });
      expect(body.json()).toEqual({ v: 7 });
      expect(body.headers[STATEMENTS_HEADER]).toBe('1');
      const responses = await Promise.all(
        Array.from({ length: 12 }, (_, i) => instance.inject({ method: 'GET', url: i % 2 === 0 ? '/test/one' : '/test/tx' })),
      );
      expect(responses.map((r) => r.headers[STATEMENTS_HEADER])).toEqual(Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? '1' : '2')));
      expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    });

    it('only counts, refusing nothing, in count mode', async () => {
      const instance = await started({ PG_BUDGET: 'count' }, routes);
      const over = await instance.inject({ method: 'GET', url: '/test/two-over' });
      expect(over.statusCode).toBe(200);
      expect(over.headers[STATEMENTS_HEADER]).toBe('2');
    });
  });

  describe('deny list', () => {
    const routes = (instance: ApiApp) => {
      instance.get('/test/me', { config: { pgBudget: 0 }, preHandler: instance.requireUser }, async (request) => ({ sub: request.principal?.subject }));
    };
    const call = (instance: ApiApp, token: string) =>
      instance.inject({ method: 'GET', url: '/test/me', headers: { authorization: `Bearer ${token}` } });

    it('revokes one session at once, and leaves the others', async () => {
      const instance = await started({}, routes);
      const uid = instance.publicIds.user.encode(112314686237569028n);
      const a = await instance.tokens.issue({ kind: 'app', subject: uid, sessionId: '112314686237569100' });
      const b = await instance.tokens.issue({ kind: 'app', subject: uid, sessionId: '112314686237569101' });
      expect((await call(instance, a.token)).statusCode).toBe(200);
      await instance.denyList.revokeSession('112314686237569100');
      const revoked = await call(instance, a.token);
      expect(revoked.statusCode).toBe(401);
      expect(revoked.json()).toMatchObject({ code: 'unauthorized' });
      expect((await call(instance, b.token)).statusCode).toBe(200);
      const ttl = await redis.ttl(instance.keys.denySession('112314686237569100'));
      expect(ttl).toBeGreaterThan(900);
      expect(ttl).toBeLessThanOrEqual(900 + 30 + 30);
    });

    it('revokes every token of a user issued up to the cutoff, and none issued after it', async () => {
      const instance = await started({}, routes);
      const uid = instance.publicIds.user.encode(112314686237569029n);
      const before = await instance.tokens.issue({ kind: 'app', subject: uid, sessionId: '112314686237569200' });
      await instance.denyList.revokeUser('112314686237569029');
      expect((await call(instance, before.token)).statusCode).toBe(401);

      const other = instance.publicIds.user.encode(112314686237569030n);
      const later = await instance.tokens.issue({ kind: 'app', subject: other, sessionId: '112314686237569201' });
      // A cutoff two seconds ago: this token was issued after it.
      await instance.denyList.revokeUser('112314686237569030', new Date(Date.now() - 2_000));
      expect((await call(instance, later.token)).statusCode).toBe(200);
      // A later revocation moves the cutoff forward, never back.
      await instance.denyList.revokeUser('112314686237569030', new Date(Date.now() + 1_000));
      await instance.denyList.revokeUser('112314686237569030', new Date(Date.now() - 60_000));
      expect((await call(instance, later.token)).statusCode).toBe(401);
    });

    it('lets requests through when Valkey cannot be read', async () => {
      const config = testConfig({ DATABASE_URL: TEST_DATABASE_URL ?? '', REDIS_URL: UNREACHABLE_REDIS_URL });
      prefix = config.redis.keyPrefix;
      app = await testApp(config);
      routes(app);
      await app.ready();
      const { token } = await app.tokens.issue({ kind: 'app', subject: app.publicIds.user.encode(5n), sessionId: '1' });
      expect((await call(app, token)).statusCode).toBe(200);
    });
  });

  it('leases a generator number on start and mints ids under it', async () => {
    const instance = await started();
    for (let i = 0; i < 100 && instance.ids.generator === null; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(instance.ids.generator).not.toBeNull();
    const a = BigInt(instance.ids.nextId());
    const b = BigInt(instance.ids.nextId());
    expect(b > a).toBe(true);
    expect(await redis.exists(instance.keys.idLease(instance.ids.generator!))).toBe(1);
  });
});
