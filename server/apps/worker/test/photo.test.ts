import { randomBytes } from 'node:crypto';
import { instrumentPool, statementCounter, createPool, type Pool } from '@app/db';
import {
  FakeObjectStorage,
  FakeRealtimePublisher,
  IdGenerator,
  createKeys,
  createPublicIds,
  photoUploadKey,
  photoVariantKey,
  queuePrefix,
  type MediaStore,
} from '@app/shared/server';
import { DelayedError, Queue, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import pino from 'pino';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, startWorker, type JobContext } from '../src/index.js';
import { hammingDistance, perceptualHash, processImage, sniffFormat, UnreadableImageError } from '../src/photos/image.js';
import { FakePhotoModerator } from '../src/photos/moderation.js';
import { deletePhotoJob, photoQueue, processPhotoJob, REJECT_TOO_SMALL, REJECT_UNREADABLE, type DeleteJobData, type ProcessJobData } from '../src/queues/photo.js';
import type { WorkerServices } from '../src/services.js';
import { hasDatabase, migratedDatabase, type TestDatabase } from './db.js';
import { EXIF_MAKE, picture, webpChunks } from './images.js';
import { TEST_REDIS_URL, baseEnv, connect, eventually, hasRedis } from './support.js';

describe('the image pipeline (sharp)', () => {
  it('turns the picture upright and writes variants without any metadata', async () => {
    const input = await picture({ orientation: 6 });
    const before = await sharp(input).metadata();
    // The test file really carries a GPS position, a camera make and an orientation.
    expect(before.orientation).toBe(6);
    expect(before.exif?.toString('latin1')).toContain(EXIF_MAKE);
    expect([before.width, before.height]).toEqual([1600, 1280]);

    const out = await processImage(input, { maxPixels: 50_000_000 });
    expect([out.width, out.height]).toEqual([1280, 1600]);
    expect(out.variants.map((v) => [v.size, v.width, v.height])).toEqual([
      [320, 320, 400],
      [640, 640, 800],
      [1080, 1080, 1350],
    ]);
    for (const variant of out.variants) {
      // On the bytes: image data chunks only, no EXIF, XMP or ICC chunk, and no trace of the tags.
      expect(webpChunks(variant.body).every((c) => c === 'VP8 ' || c === 'VP8L' || c === 'VP8X' || c === 'ALPH')).toBe(true);
      const text = Buffer.from(variant.body).toString('latin1');
      for (const needle of ['Exif', 'EXIF', 'GPS', EXIF_MAKE, 'XMP', 'ICCP', 'http://ns.adobe.com']) expect(text).not.toContain(needle);
      const meta = await sharp(variant.body).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
    }
    expect(out.blurhash.length).toBeGreaterThan(20);
    expect(out.blurhash.length).toBeLessThanOrEqual(64);
  });

  it('gives a re-encoded or resized copy the same perceptual hash, another picture a far one', async () => {
    const original = await processImage(await picture({ seed: 3 }), { maxPixels: 50_000_000 });
    const copy = await processImage(await sharp(await picture({ seed: 3, gps: false })).resize(900).jpeg({ quality: 55 }).toBuffer(), { maxPixels: 50_000_000 });
    const other = await processImage(await picture({ seed: 4 }), { maxPixels: 50_000_000 });
    expect(hammingDistance(original.phash, copy.phash)).toBeLessThanOrEqual(3);
    expect(hammingDistance(original.phash, other.phash)).toBeGreaterThan(10);
    // Signed 64-bit, as PostgreSQL's bigint takes it.
    expect(original.phash).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(original.phash).toBeLessThan(2n ** 63n);
    expect(() => perceptualHash(new Uint8Array(100))).toThrow(RangeError);
  });

  it('decodes only JPEG and WebP, and refuses what is too small or too large', async () => {
    const png = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#808080' } }).png().toBuffer();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"></svg>');
    expect(sniffFormat(png)).toBeNull();
    expect(sniffFormat(svg)).toBeNull();
    await expect(processImage(png, { maxPixels: 50_000_000 })).rejects.toMatchObject({ reason: 'format' });
    await expect(processImage(svg, { maxPixels: 50_000_000 })).rejects.toMatchObject({ reason: 'format' });
    const truncated = (await picture()).subarray(0, 4_000);
    await expect(processImage(truncated, { maxPixels: 50_000_000 })).rejects.toBeInstanceOf(UnreadableImageError);
    await expect(processImage(await picture({ width: 300, height: 600 }), { maxPixels: 50_000_000 })).rejects.toMatchObject({ reason: 'too_small' });
    await expect(processImage(await picture({ width: 2000, height: 2000 }), { maxPixels: 1_000_000 })).rejects.toMatchObject({ reason: 'too_large' });
    const webp = await sharp(await picture({ gps: false })).webp().toBuffer();
    expect(sniffFormat(webp)).toBe('webp');
    expect((await processImage(webp, { maxPixels: 50_000_000 })).variants).toHaveLength(3);
  });
});

type FakeJob<T> = Job<T> & { delayedUntil?: number };

function fakeJob<T>(name: string, data: T): FakeJob<T> {
  const job = {
    name,
    data,
    id: `${name}.test`,
    async updateData(next: T) {
      job.data = next;
    },
    async moveToDelayed(timestamp: number) {
      job.delayedUntil = timestamp;
    },
  } as unknown as FakeJob<T>;
  return job;
}

describe.skipIf(!hasDatabase || !hasRedis)('the photo jobs (PostgreSQL, Valkey)', () => {
  let db: TestDatabase;
  let pg: Pool;
  let redis: Redis;
  let ids: IdGenerator;
  let storage: FakeObjectStorage;
  let media: MediaStore;
  let realtime: FakeRealtimePublisher;
  let moderator: FakePhotoModerator;
  let services: WorkerServices;
  let context: JobContext;
  const prefix = `t${randomBytes(4).toString('hex')}:`;
  const keys = createKeys(prefix);

  beforeAll(async () => {
    db = await migratedDatabase();
    pg = instrumentPool(createPool({ connectionString: db.url, applicationName: 'worker-test', max: 4 }), statementCounter);
    redis = connect();
    ids = new IdGenerator({ redis, keyPrefix: prefix });
    await ids.start();
    storage = new FakeObjectStorage();
    media = { storage, privateBucket: 'uploads', mediaBucket: 'media', urls: null };
    realtime = new FakeRealtimePublisher();
    moderator = new FakePhotoModerator({ autoApprove: false, record: true });
    const env = baseEnv();
    services = {
      pg,
      cache: redis,
      ids,
      keys,
      publicIds: createPublicIds(env['ID_PUBLIC_KEY']!, env['ID_BILLING_KEY']!),
      realtime,
      media,
      photoModerator: moderator,
    };
    const config = loadConfig({ ...env, DATABASE_URL: db.url, REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix });
    context = { config, redis, log: pino({ level: 'silent' }), services, token: 'test-token' };
  }, 90_000);

  afterAll(async () => {
    await ids?.stop();
    await pg?.end();
    const left = await redis.keys(`${prefix}*`);
    if (left.length > 0) await redis.del(...left);
    await redis?.quit();
    await db?.drop();
  });

  async function person(status = 3): Promise<string> {
    const id = ids.nextId();
    await db.admin.query(
      `INSERT INTO users (id, status, birth_date, gender, country, onboarding_step) VALUES ($1, $2, DATE '1994-05-17', 2, 'IR', 30)`,
      [id, status],
    );
    await db.admin.query(`INSERT INTO profiles (user_id, display_name) VALUES ($1, 'Sam')`, [id]);
    return id;
  }

  /** What `complete` leaves: the upload in the private bucket and a row in status 1. */
  async function uploaded(userId: string, body: Buffer, position = 0): Promise<string> {
    const photoId = ids.nextId();
    await storage.putObject('uploads', photoUploadKey(photoId), body, { contentType: 'image/jpeg' });
    await db.admin.query(`INSERT INTO photos (id, user_id, position) VALUES ($1, $2, $3)`, [photoId, userId, position]);
    return photoId;
  }

  async function photoRow(photoId: string) {
    const { rows } = await db.admin.query<{
      status: number;
      width: number | null;
      height: number | null;
      blurhash: string | null;
      phash: string | null;
      mod_flags: number;
      reject_reason: number | null;
      decided_at: Date | null;
    }>(`SELECT status, width, height, blurhash, phash::text, mod_flags, reject_reason, decided_at FROM photos WHERE id = $1`, [photoId]);
    return rows[0];
  }

  async function card(userId: string): Promise<{ photos: { id: string }[] } | null> {
    const { rows } = await db.admin.query<{ card: { photos: { id: string }[] } | null }>(`SELECT profile_card($1) AS card`, [userId]);
    return rows[0]?.card ?? null;
  }

  it('strips, stores the variants, moderates and finishes the row in two statements', async () => {
    const userId = await person();
    const photoId = await uploaded(userId, await picture({ orientation: 6 }));
    const version = await redis.get(keys.meVersion(userId));

    const { result, tally } = await statementCounter.measure(() => processPhotoJob(fakeJob<ProcessJobData>('process', { photoId }), context));
    expect(result).toEqual({ outcome: 'processed', status: 'review' });
    expect(tally.statements).toBe(2);

    const row = await photoRow(photoId);
    expect(row).toMatchObject({ status: 2, width: 1280, height: 1600, mod_flags: 0, reject_reason: null, decided_at: null });
    expect(row?.blurhash).toMatch(/^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]{20,64}$/);
    expect(row?.phash).toMatch(/^-?\d+$/);
    // The upload is gone; the media bucket holds the stripped variants only.
    expect(storage.keys('uploads')).not.toContain(photoUploadKey(photoId));
    expect(storage.keys('media', `p/${photoId}/`)).toEqual([`p/${photoId}/1/1080.webp`, `p/${photoId}/1/320.webp`, `p/${photoId}/1/640.webp`]);
    for (const size of [320, 640, 1080] as const) {
      const stored = storage.objects.get(`media/${photoVariantKey(photoId, 1, size)}`);
      expect(stored?.contentType).toBe('image/webp');
      const text = Buffer.from(stored!.body).toString('latin1');
      expect(text).not.toContain('GPS');
      expect(text).not.toContain(EXIF_MAKE);
      expect((await sharp(stored!.body).metadata()).exif).toBeUndefined();
    }
    // The moderation provider saw the stripped 640 px variant, nothing else.
    const seen = moderator.seen.find((s) => s.photoId === photoId);
    expect(seen).toMatchObject({ mime: 'image/webp', width: 640, height: 800 });
    expect(Buffer.from(seen!.image).toString('latin1')).not.toContain(EXIF_MAKE);
    // The account view is rebuilt on the next read, and the person hears of it.
    expect(await redis.get(keys.meVersion(userId))).not.toBe(version);
    const event = realtime.published.find((p) => p.envelope.t === 'profile' && JSON.stringify(p.envelope.d).includes(photoId));
    expect(event?.channels).toEqual([`u:#${services.publicIds.user.encode(userId)}`]);
    expect(event?.envelope.d).toEqual({ photo: { id: photoId, status: 'review' } });
  });

  it('keeps a photo out of the profile card until it is approved', async () => {
    const userId = await person();
    const first = await uploaded(userId, await picture({ seed: 11 }), 0);
    expect((await card(userId))?.photos).toEqual([]);
    await processPhotoJob(fakeJob<ProcessJobData>('process', { photoId: first }), context);
    // Waiting for a human (status 2): still not on the card.
    expect((await card(userId))?.photos).toEqual([]);

    moderator.autoApprove = true;
    try {
      const second = await uploaded(userId, await picture({ seed: 12 }), 1);
      expect(await processPhotoJob(fakeJob<ProcessJobData>('process', { photoId: second }), context)).toEqual({ outcome: 'processed', status: 'approved' });
      const row = await photoRow(second);
      expect(row?.status).toBe(3);
      expect(row?.decided_at).toBeInstanceOf(Date);
      expect((await card(userId))?.photos.map((p) => String(p.id))).toEqual([second]);
    } finally {
      moderator.autoApprove = false;
    }
  });

  it('sends a near copy of another account\'s photo to a human, even with auto-approval', async () => {
    moderator.autoApprove = true;
    try {
      const author = await person();
      const original = await uploaded(author, await picture({ seed: 21 }));
      expect((await processPhotoJob(fakeJob<ProcessJobData>('process', { photoId: original }), context)).outcome).toBe('processed');
      expect((await photoRow(original))?.status).toBe(3);
      // The same account uploading its own picture again is not a duplicate.
      const again = await uploaded(author, await picture({ seed: 21 }), 1);
      expect((await processPhotoJob(fakeJob<ProcessJobData>('process', { photoId: again }), context)).outcome).toBe('processed');
      expect((await photoRow(again))?.status).toBe(3);

      const copier = await person();
      const copy = await uploaded(copier, await sharp(await picture({ seed: 21, gps: false })).resize(1000).jpeg({ quality: 60 }).toBuffer());
      expect(await processPhotoJob(fakeJob<ProcessJobData>('process', { photoId: copy }), context)).toEqual({ outcome: 'processed', status: 'review' });
      const row = await photoRow(copy);
      expect(row?.status).toBe(2);
      expect((row?.mod_flags ?? 0) & 32).toBe(32);
    } finally {
      moderator.autoApprove = false;
    }
  });

  it('rejects files it cannot read and pictures that are too small, without variants', async () => {
    const userId = await person();
    const garbage = await uploaded(userId, Buffer.from('not a picture at all, just text'), 0);
    const tiny = await uploaded(userId, await picture({ width: 200, height: 250 }), 1);
    const gone = ids.nextId();
    await db.admin.query(`INSERT INTO photos (id, user_id, position) VALUES ($1, $2, 2)`, [gone, userId]);

    expect(await processPhotoJob(fakeJob<ProcessJobData>('process', { photoId: garbage }), context)).toEqual({ outcome: 'processed', status: 'rejected' });
    expect(await processPhotoJob(fakeJob<ProcessJobData>('process', { photoId: tiny }), context)).toEqual({ outcome: 'processed', status: 'rejected' });
    expect(await processPhotoJob(fakeJob<ProcessJobData>('process', { photoId: gone }), context)).toEqual({ outcome: 'processed', status: 'rejected' });
    expect(await photoRow(garbage)).toMatchObject({ status: 4, reject_reason: REJECT_UNREADABLE, blurhash: null, phash: null });
    expect(await photoRow(tiny)).toMatchObject({ status: 4, reject_reason: REJECT_TOO_SMALL });
    expect(await photoRow(gone)).toMatchObject({ status: 4, reject_reason: REJECT_UNREADABLE });
    for (const id of [garbage, tiny, gone]) expect(storage.keys('media', `p/${id}/`)).toEqual([]);
  });

  it('waits for a row that is not committed yet, then treats the upload as an orphan', async () => {
    const photoId = ids.nextId();
    await storage.putObject('uploads', photoUploadKey(photoId), await picture(), { contentType: 'image/jpeg' });
    const job = fakeJob<ProcessJobData>('process', { photoId });
    for (let i = 0; i < 5; i += 1) {
      await expect(processPhotoJob(job, context)).rejects.toBeInstanceOf(DelayedError);
      expect(job.data.waits).toBe(i + 1);
      expect(job.delayedUntil).toBeGreaterThan(Date.now());
    }
    expect(await processPhotoJob(job, context)).toEqual({ outcome: 'skipped', reason: 'no_row' });
    expect(storage.keys('uploads')).not.toContain(photoUploadKey(photoId));
  });

  it('is idempotent: a second run finds the row finished and only tidies up', async () => {
    const userId = await person();
    const photoId = await uploaded(userId, await picture({ seed: 31 }));
    await processPhotoJob(fakeJob<ProcessJobData>('process', { photoId }), context);
    const before = await photoRow(photoId);
    await storage.putObject('uploads', photoUploadKey(photoId), Buffer.from('left behind'), { contentType: 'image/jpeg' });
    const { result, tally } = await statementCounter.measure(() => processPhotoJob(fakeJob<ProcessJobData>('process', { photoId }), context));
    expect(result).toEqual({ outcome: 'skipped', reason: 'finished' });
    expect(tally.statements).toBe(1);
    expect(await photoRow(photoId)).toEqual(before);
    expect(storage.keys('uploads')).not.toContain(photoUploadKey(photoId));
  });

  it('removes what it wrote when the photo is deleted while it runs', async () => {
    const userId = await person();
    const photoId = await uploaded(userId, await picture({ seed: 41 }));
    const original = moderator.check.bind(moderator);
    moderator.check = async (input) => {
      await db.admin.query('DELETE FROM photos WHERE id = $1', [photoId]);
      return original(input);
    };
    try {
      expect(await processPhotoJob(fakeJob<ProcessJobData>('process', { photoId }), context)).toEqual({ outcome: 'skipped', reason: 'deleted' });
    } finally {
      moderator.check = original;
    }
    expect(storage.keys('media', `p/${photoId}/`)).toEqual([]);
    expect(storage.keys('uploads')).not.toContain(photoUploadKey(photoId));
  });

  it('deletes every blob of a deleted photo, unless a legal hold names the account', async () => {
    const userId = await person();
    const photoId = await uploaded(userId, await picture({ seed: 51 }));
    await processPhotoJob(fakeJob<ProcessJobData>('process', { photoId }), context);
    // An older version's variants are removed too.
    await storage.putObject('media', photoVariantKey(photoId, 2, 640), Buffer.from('v2'), { contentType: 'image/webp' });
    await db.admin.query('DELETE FROM photos WHERE id = $1', [photoId]);

    const holdId = ids.nextId();
    await db.admin.query(`INSERT INTO legal_holds (id, user_id, kind) VALUES ($1, $2, 1)`, [holdId, userId]);
    const held = fakeJob<DeleteJobData>('delete', { photoId, userId, blobVer: 2 });
    await expect(deletePhotoJob(held, context)).rejects.toBeInstanceOf(DelayedError);
    expect(held.delayedUntil).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(storage.keys('media', `p/${photoId}/`)).toHaveLength(4);

    await db.admin.query(`UPDATE legal_holds SET released_at = now() WHERE id = $1`, [holdId]);
    const { result, tally } = await statementCounter.measure(() => deletePhotoJob(fakeJob<DeleteJobData>('delete', { photoId, userId, blobVer: 2 }), context));
    expect(result).toEqual({ outcome: 'deleted', objects: 7 });
    expect(tally.statements).toBe(1);
    expect(storage.keys('media', `p/${photoId}/`)).toEqual([]);
  });

  it('keeps the blobs of a photo whose delete did not commit (its row is still there)', async () => {
    const userId = await person();
    const photoId = await uploaded(userId, await picture({ seed: 53 }));
    await processPhotoJob(fakeJob<ProcessJobData>('process', { photoId }), context);
    const blobs = storage.keys('media', `p/${photoId}/`);
    expect(blobs).toHaveLength(3);
    // The route queued the job, then its COMMIT failed: the row stays.
    const job = fakeJob<DeleteJobData>('delete', { photoId, userId, blobVer: 1 });
    const waits: number[] = [];
    for (;;) {
      const before = Date.now();
      try {
        const { result, tally } = await statementCounter.measure(() => deletePhotoJob(job, context));
        expect(result).toEqual({ outcome: 'skipped', reason: 'not_deleted' });
        expect(tally.statements).toBe(1);
        break;
      } catch (error) {
        expect(error).toBeInstanceOf(DelayedError);
        waits.push((job.delayedUntil ?? 0) - before);
      }
    }
    // It looked again a few times, a little later each time, before giving up.
    expect(waits.length).toBe(5);
    expect(waits.every((ms, i) => i === 0 || ms > (waits[i - 1] ?? 0))).toBe(true);
    expect(storage.keys('media', `p/${photoId}/`)).toEqual(blobs);
    expect(await photoRow(photoId)).toBeDefined();

    // A slow commit: the row goes while the job waits, and the next look deletes the blobs.
    const slow = fakeJob<DeleteJobData>('delete', { photoId, userId, blobVer: 1 });
    await expect(deletePhotoJob(slow, context)).rejects.toBeInstanceOf(DelayedError);
    await db.admin.query('DELETE FROM photos WHERE id = $1', [photoId]);
    expect(await deletePhotoJob(slow, context)).toEqual({ outcome: 'deleted', objects: 4 });
    expect(storage.keys('media', `p/${photoId}/`)).toEqual([]);
  });

  it('runs through BullMQ: a job queued before its row commits is processed once the row is there', async () => {
    const config = loadConfig({ ...baseEnv(), DATABASE_URL: db.url, REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix, WORKER_ID: 'photo-test' });
    const runtime = await startWorker(config, { logger: pino({ level: 'silent' }), queues: [photoQueue(1)], services });
    const queue = new Queue('photo', { connection: redis, prefix: queuePrefix(prefix) });
    try {
      const userId = await person();
      const photoId = ids.nextId();
      await storage.putObject('uploads', photoUploadKey(photoId), await picture({ seed: 61 }), { contentType: 'image/jpeg' });
      await queue.add('process', { photoId, userId }, { jobId: `process.${photoId}`, attempts: 3 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await db.admin.query(`INSERT INTO photos (id, user_id, position) VALUES ($1, $2, 0)`, [photoId, userId]);
      await eventually(async () => (await photoRow(photoId))?.status === 2, 15_000);
      const job = await queue.getJob(`process.${photoId}`);
      await eventually(async () => (await job?.isCompleted()) === true, 5_000);
      // Waiting for the row is not a failed attempt.
      expect((await queue.getJob(`process.${photoId}`))?.failedReason).toBeFalsy();
    } finally {
      await queue.close();
      await runtime.stop();
    }
  }, 30_000);
});
