import { exportStartedSchema, idFloor } from '@app/shared';
import { FakeObjectStorage, type MediaStore } from '@app/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, json, migratedDatabase, seedUser, startHarness, statements, type Harness, type TestDatabase } from './accountSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * `POST /v1/me/export`: no statement, one export a week, the same answer to
 * the same request sent again, nothing used up when the job cannot be queued,
 * and no export without object storage.
 */

describe.skipIf(!hasInfrastructure)('the data export request (PostgreSQL, Valkey)', () => {
  let db: TestDatabase;
  let h: Harness;
  let bare: Harness;
  const jobs = new MemoryJobProducer();
  const media: MediaStore = { storage: new FakeObjectStorage(), privateBucket: 'uploads', mediaBucket: 'media', urls: null };

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startHarness(db, {}, { jobs, media });
    bare = await startHarness(db, {}, { jobs: new MemoryJobProducer(), media: null });
  }, 90_000);
  afterAll(async () => {
    await bare?.close();
    await h?.close();
    await db?.drop();
  });

  const ask = (harness: Harness, token: string) => call(harness, '/v1/me/export', { method: 'POST', token });

  it('queues one export a week, at no statement, and answers a repeat with the same export', async () => {
    const user = await seedUser(h, { name: 'Ava' });
    const first = await ask(h, user.token);
    expect(first.statusCode, first.body).toBe(202);
    expect(statements(first)).toBe(0);
    const { exportId } = exportStartedSchema.parse(first.json());
    const queued = jobs.jobs.filter((j) => j.queue === 'account' && j.name === 'export');
    expect(queued).toEqual([
      { queue: 'account', name: 'export', id: `export.${exportId}`, data: { userId: user.id, exportId }, options: { attempts: 8, backoffMs: 30_000 } },
    ]);
    // The same request again (a retry whose answer was lost, a second tap): the same export, nothing more queued.
    const again = await ask(h, user.token);
    expect(again.statusCode).toBe(202);
    expect(exportStartedSchema.parse(again.json()).exportId).toBe(exportId);
    expect(jobs.jobs.filter((j) => j.name === 'export')).toHaveLength(1);
    // Later in the week: refused with when to come back.
    await h.app.redis.set(h.app.keys.raw('exp', user.id), idFloor(Date.now() - 10 * 60_000).toString(), 'KEEPTTL');
    const later = await ask(h, user.token);
    expect(later.statusCode).toBe(429);
    expect(json(later)['code']).toBe('rate_limited');
    expect(Number(later.headers['retry-after'])).toBeGreaterThan(6 * 86_400);
    // The answer names the export only, never the person.
    for (const body of [first.body, again.body, later.body]) expect(body).not.toContain(user.id);
  });

  it('keeps the week’s export when the job could not be queued, and refuses without object storage', async () => {
    const user = await seedUser(h, { name: 'Ben' });
    jobs.failWith = new Error('valkey down');
    try {
      expect((await ask(h, user.token)).statusCode).toBe(503);
    } finally {
      jobs.failWith = null;
    }
    expect(await h.app.redis.exists(h.app.keys.raw('exp', user.id))).toBe(0);
    expect((await ask(h, user.token)).statusCode).toBe(202);

    const other = await seedUser(bare, { name: 'Cleo' });
    const refused = await ask(bare, other.token);
    expect(refused.statusCode).toBe(503);
    expect(json(refused)['code']).toBe('service_unavailable');
  });

  it('needs a signed-in person', async () => {
    expect((await call(h, '/v1/me/export', { method: 'POST' })).statusCode).toBe(401);
  });
});
