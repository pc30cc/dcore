import { meSchema, ownProfileSchema, photoCompletedSchema, photoUploadTicketSchema } from '@app/shared';
import { CdnUrlSigner, FakeObjectStorage, photoUploadKey, type MediaStore } from '@app/shared/server';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BullJobProducer, MemoryJobProducer } from '../src/services/jobs.js';
import { call, json, migratedDatabase, problemExt, row, rows, seedUser, startHarness, statements, type Harness, type TestDatabase } from './accountSupport.js';
import { hasInfrastructure, TEST_REDIS_URL } from './support.js';

/**
 * The photo routes (§3.4) against PostgreSQL and Valkey, with storage and
 * the job queue faked behind their interfaces: shapes, statement budgets
 * and the rules (positions, limits, the minimum, who owns what).
 */

const CDN_KEY = 'cdn-signing-key-0123456789abcdef';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2_000, 7)]);

describe.skipIf(!hasInfrastructure)('photos', () => {
  let db: TestDatabase;
  let h: Harness;
  let storage: FakeObjectStorage;
  let jobs: MemoryJobProducer;
  const rawIds: string[] = [];

  beforeAll(async () => {
    db = await migratedDatabase();
    storage = new FakeObjectStorage();
    jobs = new MemoryJobProducer();
    const media: MediaStore = {
      storage,
      privateBucket: 'uploads',
      mediaBucket: 'media',
      urls: new CdnUrlSigner({ baseUrl: 'https://cdn.test.invalid', signingKey: CDN_KEY, scheme: 'hmac' }),
    };
    h = await startHarness(db, {}, { media, jobs });
  }, 60_000);

  afterAll(async () => {
    for (const id of rawIds) for (const body of h?.bodies ?? []) expect(body.includes(id), `raw id ${id} in a response`).toBe(false);
    await h?.close();
    await db?.drop();
  });

  const seed = async (options: Parameters<typeof seedUser>[1] = {}) => {
    const user = await seedUser(h, { name: 'Ana', ...options });
    rawIds.push(user.id);
    return user;
  };

  async function photo(userId: string, position: number, status = 3): Promise<string> {
    const id = h.app.ids.nextId();
    await db.sql.query(
      `INSERT INTO photos (id, user_id, position, status, reject_reason, width, height, blurhash)
       VALUES ($1, $2, $3, $4, CASE WHEN $4::smallint = 4 THEN 1 END, CASE WHEN $4::smallint > 1 THEN 1280 END, CASE WHEN $4::smallint > 1 THEN 1600 END,
               CASE WHEN $4::smallint > 1 THEN 'LEHV6nWB2yk8pyo0adR*.7kCMdnj' END)`,
      [id, userId, position, status],
    );
    await h.redis.incr(`${h.prefix}mev:${userId}`);
    return id;
  }

  const start = (token: string, body: Record<string, unknown>) => call(h, '/v1/me/photos', { method: 'POST', token, body });

  describe('POST /v1/me/photos', () => {
    it('hands out a presigned PUT and keeps the intent in Valkey, with no statement while the account view is cached', async () => {
      const user = await seed();
      const cold = await start(user.token, { position: 0, mime: 'image/jpeg', bytes: JPEG.length });
      expect(cold.statusCode).toBe(201);
      expect(statements(cold)).toBe(1);
      const ticket = photoUploadTicketSchema.strict().parse(cold.json());
      expect(ticket.upload.method).toBe('PUT');
      expect(ticket.upload.url).toContain(`/uploads/${photoUploadKey(ticket.photoId)}`);
      expect(ticket.upload.headers).toEqual({ 'Content-Type': 'image/jpeg', 'Content-Length': String(JPEG.length) });
      expect(Date.parse(ticket.upload.expiresAt) - Date.now()).toBeGreaterThan(3_500_000);
      expect(await h.redis.hgetall(`${h.prefix}up:${ticket.photoId}`)).toEqual({ uid: user.id, pos: '0', mime: 'image/jpeg', bytes: String(JPEG.length) });
      expect(await h.redis.ttl(`${h.prefix}up:${ticket.photoId}`)).toBeGreaterThan(3_500);
      // Nothing in PostgreSQL yet.
      expect(await rows(db, 'SELECT id FROM photos WHERE id = $1', [ticket.photoId])).toEqual([]);

      const warm = await start(user.token, { position: 1, mime: 'image/webp', bytes: 1_000 });
      expect(warm.statusCode).toBe(201);
      expect(statements(warm)).toBe(0);
    });

    it('refuses other types (415), files over 15 MB (413), a taken position (409) and a tenth photo (422)', async () => {
      const user = await seed();
      for (const mime of ['image/heic', 'image/png', 'image/svg+xml']) {
        const refused = await start(user.token, { position: 0, mime, bytes: 1_000 });
        expect(refused.statusCode, mime).toBe(415);
        expect(json(refused)['code']).toBe('unsupported_media_type');
      }
      const big = await start(user.token, { position: 0, mime: 'image/jpeg', bytes: 15 * 1024 * 1024 + 1 });
      expect(big.statusCode).toBe(413);
      expect(json(big)['code']).toBe('payload_too_large');

      await photo(user.id, 0);
      const taken = await start(user.token, { position: 0, mime: 'image/jpeg', bytes: 1_000 });
      expect(taken.statusCode).toBe(409);
      expect(json(taken)['code']).toBe('position_taken');
      for (let position = 1; position < 9; position += 1) await photo(user.id, position);
      const tenth = await start(user.token, { position: 3, mime: 'image/jpeg', bytes: 1_000 });
      expect(tenth.statusCode).toBe(422);
      expect(json(tenth)['code']).toBe('photo_limit');
    });

    it('answers a suspended account with its reason and stops after 30 uploads a day', async () => {
      const banned = await seed({ status: 6, scope: 'restricted' });
      await db.sql.query(
        `INSERT INTO moderation_actions (id, user_id, kind, reason_code, reason_text, starts_at) VALUES ($1, $2, 3, 1, 'Spam', now())`,
        [h.app.ids.nextId(), banned.id],
      );
      const refused = await start(banned.token, { position: 0, mime: 'image/jpeg', bytes: 1_000 });
      expect(refused.statusCode).toBe(403);
      expect(problemExt('account_banned', refused.json())).toMatchObject({ reasonText: 'Spam' });

      const busy = await seed();
      let last = 0;
      for (let i = 0; i < 31; i += 1) last = (await start(busy.token, { position: i % 9, mime: 'image/jpeg', bytes: 1_000 })).statusCode;
      expect(last).toBe(429);
    });
  });

  describe('POST /v1/me/photos/:photoId/complete', () => {
    it('needs the upload, queues processing before the row, and writes the row in one statement', async () => {
      const user = await seed();
      const ticket = photoUploadTicketSchema.parse((await start(user.token, { position: 2, mime: 'image/jpeg', bytes: JPEG.length })).json());
      const url = `/v1/me/photos/${ticket.photoId}/complete`;

      const early = await call(h, url, { method: 'POST', token: user.token });
      expect(early.statusCode).toBe(422);
      expect(json(early)['code']).toBe('upload_missing');
      expect(statements(early)).toBe(0);

      storage.upload(ticket.upload.url, JPEG, 'image/jpeg');
      const version = await h.redis.get(`${h.prefix}mev:${user.id}`);
      const done = await call(h, url, { method: 'POST', token: user.token });
      expect(done.statusCode).toBe(202);
      expect(statements(done)).toBe(1);
      expect(photoCompletedSchema.strict().parse(done.json())).toEqual({ photo: { id: ticket.photoId, position: 2, status: 'processing' } });
      expect(await row(db, 'SELECT user_id::text AS uid, position, status FROM photos WHERE id = $1', [ticket.photoId])).toEqual({ uid: user.id, position: 2, status: 1 });
      expect(await h.redis.get(`${h.prefix}mev:${user.id}`)).not.toBe(version);
      const queued = jobs.jobs.filter((j) => j.id === `process.${ticket.photoId}`);
      expect(queued).toEqual([
        { queue: 'photo', name: 'process', id: `process.${ticket.photoId}`, data: { photoId: ticket.photoId, userId: user.id }, options: { delayMs: 1_000, attempts: 6, backoffMs: 5_000 } },
      ]);

      // A retried request finds the same photo; nothing is added twice.
      const again = await call(h, url, { method: 'POST', token: user.token });
      expect(again.statusCode).toBe(202);
      expect(statements(again)).toBe(1);
      expect(json(again)).toEqual(json(done));
      expect(jobs.jobs.filter((j) => j.id === `process.${ticket.photoId}`)).toHaveLength(1);
      expect(await rows(db, 'SELECT id FROM photos WHERE user_id = $1', [user.id])).toHaveLength(1);
    });

    it('is the uploader\'s only, and moves to a free position when another photo took the asked one', async () => {
      const user = await seed();
      const other = await seed();
      const first = photoUploadTicketSchema.parse((await start(user.token, { position: 4, mime: 'image/jpeg', bytes: JPEG.length })).json());
      const second = photoUploadTicketSchema.parse((await start(user.token, { position: 4, mime: 'image/jpeg', bytes: JPEG.length })).json());
      storage.upload(first.upload.url, JPEG, 'image/jpeg');
      storage.upload(second.upload.url, JPEG, 'image/jpeg');

      const stolen = await call(h, `/v1/me/photos/${first.photoId}/complete`, { method: 'POST', token: other.token });
      expect(stolen.statusCode).toBe(404);
      const unknown = await call(h, `/v1/me/photos/${h.app.ids.nextId()}/complete`, { method: 'POST', token: user.token });
      expect(unknown.statusCode).toBe(404);

      expect(json(await call(h, `/v1/me/photos/${first.photoId}/complete`, { method: 'POST', token: user.token }))).toMatchObject({ photo: { position: 4 } });
      const moved = await call(h, `/v1/me/photos/${second.photoId}/complete`, { method: 'POST', token: user.token });
      expect(moved.statusCode).toBe(202);
      expect(json(moved)).toMatchObject({ photo: { position: 0 } });
    });

    it('writes nothing when the job queue cannot take the job', async () => {
      const user = await seed();
      const ticket = photoUploadTicketSchema.parse((await start(user.token, { position: 0, mime: 'image/jpeg', bytes: JPEG.length })).json());
      storage.upload(ticket.upload.url, JPEG, 'image/jpeg');
      jobs.failWith = new Error('valkey down');
      try {
        const refused = await call(h, `/v1/me/photos/${ticket.photoId}/complete`, { method: 'POST', token: user.token });
        expect(refused.statusCode).toBe(503);
        expect(json(refused)['code']).toBe('service_unavailable');
      } finally {
        jobs.failWith = null;
      }
      expect(await rows(db, 'SELECT id FROM photos WHERE id = $1', [ticket.photoId])).toEqual([]);
    });
  });

  describe('PUT /v1/me/photos/order', () => {
    it('puts every photo at its index in one transaction of two statements', async () => {
      const user = await seed();
      const [a, b, c] = [await photo(user.id, 0), await photo(user.id, 1), await photo(user.id, 2, 2)];
      const before = await row<{ version: number }>(db, 'SELECT version FROM profiles WHERE user_id = $1', [user.id]);
      const response = await call(h, '/v1/me/photos/order', { method: 'PUT', token: user.token, body: { photoIds: [c, a, b] } });
      expect(response.statusCode).toBe(200);
      expect(statements(response)).toBe(2);
      const profile = ownProfileSchema.parse(response.json());
      expect(profile.photos.map((p) => [p.id, p.position])).toEqual([
        [c, 0],
        [a, 1],
        [b, 2],
      ]);
      const stored = await rows<{ id: string; position: number }>(db, 'SELECT id::text, position FROM photos WHERE user_id = $1 ORDER BY position', [user.id]);
      expect(stored.map((r) => r.id)).toEqual([c, a, b]);
      expect((await row<{ version: number }>(db, 'SELECT version FROM profiles WHERE user_id = $1', [user.id])).version).toBe(before.version + 1);
      // The next read of the account is warm and agrees.
      const me = await call(h, '/v1/me', { token: user.token });
      expect(statements(me)).toBe(0);
      expect(meSchema.parse(me.json()).profile?.photos.map((p) => p.id)).toEqual([c, a, b]);
    });

    it('moves nothing unless the list names every photo of the account once', async () => {
      const user = await seed();
      const other = await seed();
      const [a, b] = [await photo(user.id, 0), await photo(user.id, 1)];
      const foreign = await photo(other.id, 0);
      for (const photoIds of [[a], [a, foreign], [b, a, foreign]]) {
        const refused = await call(h, '/v1/me/photos/order', { method: 'PUT', token: user.token, body: { photoIds } });
        expect(refused.statusCode, JSON.stringify(photoIds)).toBe(422);
        expect(json(refused)['code']).toBe('field_invalid');
      }
      const stored = await rows<{ id: string }>(db, 'SELECT id::text FROM photos WHERE user_id = $1 ORDER BY position', [user.id]);
      expect(stored.map((r) => r.id)).toEqual([a, b]);
    });
  });

  describe('DELETE /v1/me/photos/:photoId', () => {
    it('deletes the row in one statement and queues the blob delete; keeps the minimum of a finished profile', async () => {
      const user = await seed();
      const [a, b, c] = [await photo(user.id, 0), await photo(user.id, 1), await photo(user.id, 2)];
      const rejected = await photo(user.id, 3, 4);
      const gone = await call(h, `/v1/me/photos/${a}`, { method: 'DELETE', token: user.token });
      expect(gone.statusCode).toBe(204);
      expect(statements(gone)).toBe(1);
      expect(await rows(db, 'SELECT id FROM photos WHERE id = $1', [a])).toEqual([]);
      const job = jobs.jobs.find((j) => j.name === 'delete' && j.data['photoId'] === a);
      expect(job).toMatchObject({ queue: 'photo', data: { photoId: a, userId: user.id, blobVer: 1 }, options: { delayMs: 10_000, attempts: 10 } });
      expect(job?.id).toMatch(new RegExp(`^delete\\.${a}\\.\\d+$`));

      // Two photos left that are not rejected: neither may go, the rejected one may.
      const kept = await call(h, `/v1/me/photos/${b}`, { method: 'DELETE', token: user.token });
      expect(kept.statusCode).toBe(422);
      expect(json(kept)['code']).toBe('photo_min');
      expect(jobs.jobs.some((j) => j.data['photoId'] === b)).toBe(false);
      expect((await call(h, `/v1/me/photos/${rejected}`, { method: 'DELETE', token: user.token })).statusCode).toBe(204);
      expect(await rows(db, 'SELECT id FROM photos WHERE user_id = $1 ORDER BY position', [user.id])).toHaveLength(2);
      void c;
    });

    it('lets only one of two deletes at once pass the minimum', async () => {
      const user = await seed();
      const [, b, c] = [await photo(user.id, 0), await photo(user.id, 1), await photo(user.id, 2)];
      const results = await Promise.all([b, c].map((id) => call(h, `/v1/me/photos/${id}`, { method: 'DELETE', token: user.token })));
      expect(results.map((r) => r.statusCode).sort()).toEqual([204, 422]);
      expect(await rows(db, 'SELECT id FROM photos WHERE user_id = $1', [user.id])).toHaveLength(2);
    });

    it('lets a sign-up in progress remove any photo, and nobody remove someone else\'s', async () => {
      const newcomer = await seed({ status: 1 });
      const only = await photo(newcomer.id, 0, 1);
      const stranger = await seed();
      expect((await call(h, `/v1/me/photos/${only}`, { method: 'DELETE', token: stranger.token })).statusCode).toBe(404);
      expect((await call(h, `/v1/me/photos/${only}`, { method: 'DELETE', token: newcomer.token })).statusCode).toBe(204);
      expect((await call(h, `/v1/me/photos/${only}`, { method: 'DELETE', token: newcomer.token })).statusCode).toBe(404);
    });

    it('keeps the photo when its blob delete cannot be queued', async () => {
      const user = await seed({ status: 1 });
      const only = await photo(user.id, 0);
      jobs.failWith = new Error('valkey down');
      try {
        expect((await call(h, `/v1/me/photos/${only}`, { method: 'DELETE', token: user.token })).statusCode).toBe(503);
      } finally {
        jobs.failWith = null;
      }
      expect(await rows(db, 'SELECT id FROM photos WHERE id = $1', [only])).toHaveLength(1);
    });
  });

  describe('own photos in GET /v1/me', () => {
    it('carry a signed CDN link of the 640 variant once processed, none while processing', async () => {
      const user = await seed();
      const approved = await photo(user.id, 0, 3);
      const waiting = await photo(user.id, 1, 1);
      const me = meSchema.parse((await call(h, '/v1/me', { token: user.token })).json());
      const shown = me.profile?.photos.find((p) => p.id === approved);
      expect(shown?.url).toMatch(new RegExp(`^https://cdn\\.test\\.invalid/p/${approved}/1/640\\.webp\\?exp=\\d+&sig=[A-Za-z0-9_-]+$`));
      expect(CdnUrlSigner.verifyHmac(shown!.url!, CDN_KEY)).toBe(true);
      expect(CdnUrlSigner.verifyHmac(shown!.url!.replace(`/${approved}/`, `/${waiting}/`), CDN_KEY)).toBe(false);
      expect(me.profile?.photos.find((p) => p.id === waiting)?.url).toBeUndefined();
    });
  });
});

describe.skipIf(!TEST_REDIS_URL)('the BullMQ job producer (redis-server)', () => {
  it('adds each job once, with its queue\'s retention, on the app\'s own connection', async () => {
    const { Redis } = await import('ioredis');
    const prefix = `t${Math.random().toString(36).slice(2, 8)}:`;
    const redis = new Redis(TEST_REDIS_URL ?? '', { enableOfflineQueue: false, maxRetriesPerRequest: 1, lazyConnect: true });
    const producer = new BullJobProducer({ redis, keyPrefix: prefix });
    // Not connected yet: refused at once instead of breaking the queue for good.
    await expect(producer.add('photo', 'process', 'process.1', { photoId: '1' })).rejects.toThrow(/cannot be reached/);
    await redis.connect();
    await producer.add('photo', 'process', 'process.1', { photoId: '1' }, { delayMs: 60_000, attempts: 3, backoffMs: 1_000 });
    await producer.add('photo', 'process', 'process.1', { photoId: '1' }, { delayMs: 60_000 });
    const queue = new Queue('photo', { connection: redis, prefix: `${prefix}bull` });
    try {
      const job = await queue.getJob('process.1');
      expect(job?.opts).toMatchObject({ removeOnComplete: { age: 3_600, count: 10_000 }, removeOnFail: { age: 604_800, count: 50_000 }, attempts: 3, delay: 60_000 });
      expect(await queue.getDelayedCount()).toBe(1);
    } finally {
      await queue.close();
      await producer.close();
      // The queues leave the app's connection open.
      expect(redis.status).toBe('ready');
      const keys = await redis.keys(`${prefix}*`);
      if (keys.length > 0) await redis.del(...keys);
      await redis.quit();
    }
  });
});
