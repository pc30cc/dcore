import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { swipesResponseSchema } from '@app/shared';
import { FakeRealtimePublisher } from '@app/shared/server';
import { maintQueue } from '@app/worker';
import type { Job } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, migratedDatabase, row, seedUser, startHarness, statements, type Harness, type SeededUser, type TestDatabase } from './accountSupport.js';
import { eventsOf, startPipeline, type Pipeline } from './socialSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * Criterion 5 of the swipe path with a real FLUSHALL: Valkey loses
 * everything (like buckets, streams, consumer groups, caches, quotas) in the
 * middle of the suite. Mutual-like detection then falls back to the
 * PostgreSQL look-up (`check`) until the worker's `lk-rebuild` has put the
 * buckets back and set `lk:ready`; no match is lost and none is made twice.
 *
 * FLUSHALL empties a whole server, so this suite starts a redis-server of
 * its own (the other suites share TEST_REDIS_URL's server). The binary comes
 * with infra/dev/native.sh; with REQUIRE_INTEGRATION=1 its absence fails.
 */

const REDIS_SERVER = ['/usr/bin/redis-server', '/usr/local/bin/redis-server'].find((p) => existsSync(p));
if (!REDIS_SERVER && process.env['REQUIRE_INTEGRATION'] === '1') throw new Error('REQUIRE_INTEGRATION=1 but redis-server is not installed');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(!hasInfrastructure || !REDIS_SERVER)('a Valkey loss (FLUSHALL) in the middle of swiping', () => {
  let server: ChildProcess;
  let dir: string;
  let url: string;
  let direct: Redis;
  let db: TestDatabase;
  let h: Harness;
  let realtime: FakeRealtimePublisher;
  let pipeline: Pipeline;

  beforeAll(async () => {
    const port = await freePort();
    dir = mkdtempSync(join(tmpdir(), 'flushall-'));
    server = spawn(REDIS_SERVER!, ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--dir', dir], { stdio: 'ignore' });
    url = `redis://127.0.0.1:${port}/0`;
    direct = new Redis(url, { maxRetriesPerRequest: null, retryStrategy: (n) => Math.min(n * 50, 500) });
    await until(async () => (await direct.ping().catch(() => '')) === 'PONG', 10_000);
    db = await migratedDatabase();
    realtime = new FakeRealtimePublisher();
    h = await startHarness(db, { REDIS_URL: url }, { realtime, jobs: new MemoryJobProducer() });
    await direct.set(h.app.keys.likesReady(), '1');
    pipeline = await startPipeline(h, realtime, { redisUrl: url, graceMs: 100 });
  }, 90_000);

  afterAll(async () => {
    await pipeline?.stop();
    await h?.close();
    await db?.drop();
    await direct?.quit();
    server?.kill('SIGTERM');
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function person(name: string): Promise<SeededUser> {
    return seedUser(h, { name });
  }

  async function like(user: SeededUser, target: SeededUser) {
    const response = await call(h, '/v1/swipes', { method: 'POST', token: user.token, body: { swipes: [{ target: target.publicUid, action: 'like' }] } });
    expect(response.statusCode, response.body).toBe(200);
    return { result: swipesResponseSchema.parse(response.json()).results[0]!, statements: statements(response) };
  }

  async function matchesOf(a: SeededUser, b: SeededUser): Promise<string[]> {
    const { rows } = await db.sql.query<{ id: string }>(
      `SELECT id::text FROM matches WHERE user_lo = least($1::bigint, $2::bigint) AND user_hi = greatest($1::bigint, $2::bigint)`,
      [a.id, b.id],
    );
    return rows.map((r) => r.id);
  }

  it('finds the likes made before the loss in PostgreSQL, the ones made after in the buckets, and every match once', async () => {
    const [a1, b1, a2, b2, a3, b3] = await Promise.all(['A1', 'B1', 'A2', 'B2', 'A3', 'B3'].map((n) => person(n)));
    expect((await like(a1!, b1!)).result.result).toBe('liked');
    expect((await like(a3!, b3!)).result.result).toBe('liked');
    await until(async () => Number((await row<{ n: string }>(db, `SELECT count(*)::text AS n FROM likes WHERE actor_id = ANY ($1::bigint[])`, [[a1!.id, a3!.id]])).n) === 2);

    expect(await direct.flushall()).toBe('OK');
    expect(await direct.dbsize()).toBe(0);

    // Before the rebuild: B1's like back is a check, found in PostgreSQL, and a match.
    const back1 = await like(b1!, a1!);
    expect(back1.result.result).toBe('matched');
    // The lost account view and plan (1 each), the look-up (1), the INSERT (1).
    expect(back1.statements).toBe(4);
    // People who like each other after the loss: the second like finds the first in its bucket.
    expect((await like(a2!, b2!)).result.result).toBe('liked');
    const back2 = await like(b2!, a2!);
    expect(back2.result.result).toBe('matched');

    // The worker rebuilds the buckets from PostgreSQL and sets lk:ready.
    const job = { name: 'lk-rebuild', data: {} } as unknown as Job<{ day?: string }>;
    const outcome = await maintQueue.process(job, { ...pipeline.context, token: 'test' });
    expect(outcome).toMatchObject({ outcome: 'rebuilt' });
    expect(await direct.exists(h.app.keys.likesReady())).toBe(1);

    // After the rebuild: the like back finds A3 in the rebuilt bucket, with no look-up.
    await call(h, '/v1/swipes', { method: 'POST', token: b3!.token, body: { swipes: [{ target: h.app.publicIds.user.encode(h.app.ids.nextId()), action: 'pass' }] } });
    const back3 = await like(b3!, a3!);
    expect(back3.result.result).toBe('matched');
    expect(back3.statements).toBe(1);

    for (const [x, y, result] of [
      [a1!, b1!, back1],
      [a2!, b2!, back2],
      [a3!, b3!, back3],
    ] as const) {
      const ids = await matchesOf(x, y);
      expect(ids).toEqual([result.result.conversation!.id]);
    }
    // The worker (its groups recreated after the loss) announces each match once to each person.
    await until(() => [a1, b1, a2, b2, a3, b3].every((u) => eventsOf(realtime, u!.publicUid, 'conversation').length === 1), 20_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const u of [a1, b1, a2, b2, a3, b3]) expect(eventsOf(realtime, u!.publicUid, 'conversation')).toHaveLength(1);
    // The likes made after the loss reached PostgreSQL too (the like stream's group was recreated from its start).
    await until(async () => Number((await row<{ n: string }>(db, `SELECT count(*)::text AS n FROM likes WHERE actor_id = ANY ($1::bigint[])`, [[b1!.id, a2!.id, b2!.id, b3!.id]])).n) === 4);
  }, 60_000);
});
