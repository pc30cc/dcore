import { randomBytes } from 'node:crypto';
import { crc32, inflateRawSync } from 'node:zlib';
import { createPool, instrumentPool, statementCounter, type Pool } from '@app/db';
import { userChannel } from '@app/shared';
import {
  EXPORT_EVERY_SECONDS,
  FakeObjectStorage,
  FakeRealtimePublisher,
  IdGenerator,
  createKeys,
  createPublicIds,
  exportObjectKey,
  parseExportReady,
  photoVariantKey,
  type ExportData,
  type MediaStore,
} from '@app/shared/server';
import { DelayedError, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type JobContext } from '../src/index.js';
import { exportJob } from '../src/export/job.js';
import { buildZip } from '../src/export/zip.js';
import { FakePhotoModerator } from '../src/photos/moderation.js';
import type { WorkerServices } from '../src/services.js';
import { ensureGroupRoles, hasDatabase, loginRole, migratedDatabase, type TestDatabase } from './db.js';
import { TEST_REDIS_URL, baseEnv, connect, hasRedis } from './support.js';

/**
 * The data export: the ZIP writer on its own, then the `account/export` job
 * against PostgreSQL and Valkey with an in-memory object store: what goes in
 * the archive (the person's own data only), the link announced over
 * realtime, a retry after the upload, the removal once the link ran out.
 */

/** Reads a ZIP back through its central directory, checking every CRC. */
function readZip(archive: Buffer): Map<string, Buffer> {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(0);
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    expect(archive.readUInt32LE(at)).toBe(0x02014b50);
    const flags = archive.readUInt16LE(at + 8);
    const method = archive.readUInt16LE(at + 10);
    const sum = archive.readUInt32LE(at + 16);
    const size = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const local = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    expect(flags & 0x0800).toBe(0x0800);
    expect(archive.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const body = archive.subarray(start, start + size);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    expect(crc32(data) >>> 0, name).toBe(sum);
    out.set(name, data);
    at += 46 + nameLength;
  }
  return out;
}

describe('the ZIP writer', () => {
  it('deflates text, stores pictures as they are, and reads back with every CRC right', () => {
    const picture = randomBytes(2_000);
    const archive = buildZip([
      { name: 'account.json', data: Buffer.from(JSON.stringify({ name: 'Négar نگار' })) },
      { name: 'photos/1.webp', data: picture, compress: false },
      { name: 'empty.json', data: new Uint8Array() },
    ]);
    const entries = readZip(archive);
    expect([...entries.keys()]).toEqual(['account.json', 'photos/1.webp', 'empty.json']);
    expect(JSON.parse(entries.get('account.json')!.toString('utf8'))).toEqual({ name: 'Négar نگار' });
    expect(entries.get('photos/1.webp')!.equals(picture)).toBe(true);
    expect(entries.get('empty.json')!.length).toBe(0);
  });

  it('refuses names that could leave the archive, and a name twice', () => {
    for (const name of ['../x', '/etc/passwd', 'a//b', 'a\\b', '', 'photos/..']) {
      expect(() => buildZip([{ name, data: new Uint8Array(1) }]), name).toThrow(/not a safe entry name/);
    }
    expect(() => buildZip([{ name: 'a', data: new Uint8Array(1) }, { name: 'a', data: new Uint8Array(1) }])).toThrow(/twice/);
  });
});

describe.skipIf(!hasDatabase || !hasRedis)('the account/export job (PostgreSQL, Valkey)', () => {
  let db: TestDatabase;
  let pg: Pool;
  let redis: Redis;
  let ids: IdGenerator;
  let storage: FakeObjectStorage;
  let realtime: FakeRealtimePublisher;
  let context: JobContext;
  const prefix = `t${randomBytes(4).toString('hex')}:`;
  const keys = createKeys(prefix);
  const env = baseEnv();
  const publicIds = createPublicIds(env['ID_PUBLIC_KEY']!, env['ID_BILLING_KEY']!);
  let workerRole: Awaited<ReturnType<typeof loginRole>>;

  beforeAll(async () => {
    await ensureGroupRoles();
    workerRole = await loginRole(['app_rw', 'app_maint']);
    db = await migratedDatabase();
    pg = instrumentPool(createPool({ connectionString: db.urlFor(workerRole.name, workerRole.password), applicationName: 'export-test', max: 4 }), statementCounter);
    redis = connect();
    ids = new IdGenerator({ redis, keyPrefix: prefix });
    await ids.start();
    storage = new FakeObjectStorage();
    const media: MediaStore = { storage, privateBucket: 'uploads', mediaBucket: 'media', urls: null };
    realtime = new FakeRealtimePublisher();
    const services: WorkerServices = { pg, cache: redis, ids, keys, publicIds, realtime, media, photoModerator: new FakePhotoModerator({ autoApprove: false }) };
    const config = loadConfig({ ...env, DATABASE_URL: db.url, REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix, WORKER_ID: 'export-test' });
    context = { config, redis, log: pino({ level: 'silent' }), services, token: 'test-token' };
  }, 90_000);

  afterAll(async () => {
    await ids?.stop();
    await pg?.end();
    const left = await redis.keys(`${prefix}*`);
    if (left.length > 0) await redis.del(...left);
    await redis?.quit();
    await db?.drop();
    await workerRole?.drop();
  });

  type FakeJob = Job<ExportData> & { delayedUntil?: number };
  function fakeJob(data: ExportData): FakeJob {
    const job = {
      name: 'export',
      data,
      id: `export.${data.exportId}`,
      async updateData(next: ExportData) {
        job.data = next;
      },
      async moveToDelayed(timestamp: number) {
        job.delayedUntil = timestamp;
      },
    } as unknown as FakeJob;
    return job;
  }

  async function person(name: string, status = 3): Promise<string> {
    const id = ids.nextId();
    await db.admin.query(`INSERT INTO users (id, status, birth_date, gender, country, onboarding_step) VALUES ($1, $2, DATE '1994-05-17', 2, 'IR', 30)`, [id, status]);
    await db.admin.query(`INSERT INTO profiles (user_id, display_name, about) VALUES ($1, $2, 'Tea and mountains.')`, [id, name]);
    return id;
  }

  async function match(a: string, b: string, state = 1): Promise<string> {
    const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
    const id = ids.nextId();
    await db.admin.query(
      `INSERT INTO matches (id, user_lo, user_hi, source, state, ended_at, ended_by) VALUES ($1, $2, $3, 1, $4::smallint, CASE WHEN $4::smallint = 1 THEN NULL ELSE now() END, CASE WHEN $4::smallint = 1 THEN NULL ELSE 3 END)`,
      [id, lo, hi, state],
    );
    return id;
  }

  async function message(matchId: string, senderId: string, body: string): Promise<string> {
    const id = ids.nextId();
    await db.admin.query(`INSERT INTO messages (match_id, id, sender_id, kind, body) VALUES ($1, $2, $3, 1, $4)`, [matchId, id, senderId, body]);
    return id;
  }

  it('puts the person’s own data in a ZIP, announces a 24-hour link, and removes the archive when it runs out', async () => {
    const me = await person('Mina');
    const peer = await person('Peyman Secret');
    const blocker = await person('Bahar Hidden');
    const active = await match(me, peer);
    const blocked = await match(me, blocker, 3);
    const mine = [await message(active, me, 'hello from me'), await message(blocked, me, 'are you there?')];
    await message(active, peer, 'a reply that is not mine');
    // Two photos, one approved with its variants in the media bucket, one rejected.
    const photo = ids.nextId();
    await db.admin.query(`INSERT INTO photos (id, user_id, position, status, width, height, blob_ver) VALUES ($1, $2, 0, 3, 10, 10, 2)`, [photo, me]);
    await db.admin.query(`INSERT INTO photos (id, user_id, position, status, reject_reason, width, height) VALUES ($1, $2, 1, 4, 1, 10, 10)`, [ids.nextId(), me]);
    const picture = randomBytes(512);
    await storage.putObject('media', photoVariantKey(photo, 2, 1080), picture, { contentType: 'image/webp' });
    // A purchase of the person's, with its store token (which never goes in the archive).
    await db.admin.query(
      `INSERT INTO store_purchases (id, user_id, purchased_at, expires_at, product_ref, store, kind, state, token_hash, token, order_id)
       SELECT $1, $2, now(), now() + interval '30 days', p.id, p.store, p.kind, 2, sha256('tok-secret-123456'::bytea), 'tok-secret-123456', 'GPA.1234'
         FROM store_products p ORDER BY p.id LIMIT 1`,
      [ids.nextId(), me],
    );

    const exportId = ids.nextId();
    const job = fakeJob({ userId: me, exportId });
    const startedAt = Date.now();
    const { result, tally } = await statementCounter.measure(() => exportJob(job, context).catch((error: unknown) => error));
    // Announced, then delayed until the link runs out (the same job removes the archive then).
    expect(result).toBeInstanceOf(DelayedError);
    expect(tally.statements).toBe(2);
    expect(job.data.stored?.key).toBe(exportObjectKey(exportId));
    expect(job.data.published).toBe(true);
    const expiresAtMs = job.data.stored!.expiresAtMs;
    expect(expiresAtMs - startedAt).toBeGreaterThanOrEqual(24 * 3_600_000 - 5_000);
    expect(job.delayedUntil).toBe(expiresAtMs);
    // What GET /v1/me/export reads: this export, stored, with its link's end, kept for the week.
    expect(parseExportReady(await redis.get(keys.exportReady(me)))).toEqual({ id: exportId, exp: expiresAtMs });
    expect(await redis.ttl(keys.exportReady(me))).toBeGreaterThan(EXPORT_EVERY_SECONDS - 60);

    const stored = await storage.getObject('uploads', `exports/${exportId}.zip`);
    expect(stored).not.toBeNull();
    const entries = readZip(Buffer.from(stored!));
    expect([...entries.keys()].sort()).toEqual(['account.json', 'conversations.json', 'messages.json', 'photos/1.webp', 'purchases.json']);
    expect(entries.get('photos/1.webp')!.equals(picture)).toBe(true);
    const account = JSON.parse(entries.get('account.json')!.toString('utf8')) as unknown;
    expect(account).toMatchObject({ account: { status: 'active', country: 'IR', birthDate: '1994-05-17' }, profile: { displayName: 'Mina', about: 'Tea and mountains.' } });
    // A block reads as an ended conversation, like any other end.
    const conversations = JSON.parse(entries.get('conversations.json')!.toString('utf8')) as { conversationId: string; state: string }[];
    expect(conversations.map((c) => [c.conversationId, c.state])).toEqual([
      [active, 'active'],
      [blocked, 'ended'],
    ]);
    const messages = JSON.parse(entries.get('messages.json')!.toString('utf8')) as { conversationId: string; messages: { id: string; kind: string; body: string }[] }[];
    expect(messages.flatMap((c) => c.messages.map((m) => m.id))).toEqual(mine);
    expect(messages[0]!.messages[0]).toMatchObject({ kind: 'text', body: 'hello from me' });
    const purchases = JSON.parse(entries.get('purchases.json')!.toString('utf8')) as { purchases: unknown[] };
    expect(purchases.purchases).toHaveLength(1);
    expect(purchases.purchases[0]).toMatchObject({ orderId: 'GPA.1234', state: 2 });
    // Nothing of anybody else, and no store token or internal id of the person.
    const text = [...entries].filter(([name]) => name.endsWith('.json')).map(([, data]) => data.toString('utf8')).join('\n');
    for (const leaked of [peer, blocker, me, publicIds.user.encode(peer), publicIds.user.encode(blocker), 'Peyman', 'Bahar', 'a reply that is not mine', 'tok-secret']) {
      expect(text, leaked).not.toContain(leaked);
    }

    // The link, over realtime, to the person only.
    const events = realtime.on(userChannel(publicIds.user.encode(me))).filter((e) => e.t === 'account');
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(job.data.stored!.eventId);
    const announced = events[0]!.d as { status: string; export: { url: string; expiresAt: string } };
    expect(announced.status).toBe('active');
    expect(announced.export.url).toContain(`exports/${exportId}.zip`);
    expect(announced.export.expiresAt).toBe(new Date(expiresAtMs).toISOString());

    // Woken early: it waits again, touching nothing.
    const early = await statementCounter.measure(() => exportJob(job, context).catch((error: unknown) => error));
    expect(early.result).toBeInstanceOf(DelayedError);
    expect(early.tally.statements).toBe(0);
    expect(await storage.getObject('uploads', `exports/${exportId}.zip`)).not.toBeNull();
    // Past the link's end: the archive goes.
    job.data = { ...job.data, stored: { ...job.data.stored!, expiresAtMs: Date.now() - 1 } };
    expect(await exportJob(job, context)).toEqual({ outcome: 'removed' });
    expect(await storage.getObject('uploads', `exports/${exportId}.zip`)).toBeNull();
  });

  it('announces the same archive under the same event id when the worker died after the upload', async () => {
    const me = await person('Sara');
    const exportId = ids.nextId();
    const job = fakeJob({ userId: me, exportId });
    // The first run dies right after recording the upload.
    let first = true;
    const dying = Object.assign(Object.create(Object.getPrototypeOf(job) as object) as object, job, {
      async updateData(next: ExportData) {
        job.data = next;
        if (first && next.stored && !next.published) {
          first = false;
          throw new Error('the worker died');
        }
      },
    }) as FakeJob;
    await expect(exportJob(dying, context)).rejects.toThrow('the worker died');
    const eventId = job.data.stored!.eventId;
    expect(realtime.on(userChannel(publicIds.user.encode(me))).filter((e) => e.t === 'account')).toHaveLength(0);
    // The retry publishes (reading the status once), without building the archive again.
    const retry = await statementCounter.measure(() => exportJob(fakeJob(job.data), context).catch((error: unknown) => error));
    expect(retry.result).toBeInstanceOf(DelayedError);
    expect(retry.tally.statements).toBe(1);
    expect(realtime.on(userChannel(publicIds.user.encode(me))).filter((e) => e.t === 'account').map((e) => e.id)).toEqual([eventId]);
  });

  it('exports nothing for an account deleted meanwhile', async () => {
    const gone = await person('Gone');
    await db.admin.query(`UPDATE users SET status = 7, deleted_at = now(), deleted_via = 1 WHERE id = $1`, [gone]);
    const exportId = ids.nextId();
    expect(await exportJob(fakeJob({ userId: gone, exportId }), context)).toEqual({ outcome: 'missing' });
    expect(await storage.getObject('uploads', `exports/${exportId}.zip`)).toBeNull();
    expect(await redis.exists(keys.exportReady(gone))).toBe(0);
  });
});
