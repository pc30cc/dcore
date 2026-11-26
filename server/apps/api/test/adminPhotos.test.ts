import { adminPhotoDecisionSchema, adminPhotoQueueSchema, adminTextQueueSchema, decodeCursor, problemSchemaFor, realtimePayloads, userChannel, type RealtimeEnvelope } from '@app/shared';
import { CdnUrlSigner, FakeObjectStorage, FakeRealtimePublisher, type MediaStore } from '@app/shared/server';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { json, migratedDatabase, row, seedUser, statements, type SeededUser, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, auditRows, installAuditFailure, refuseAudit, startAdminHarness, type AdminHarness } from './adminSupport.js';
import { reloadConfig, seedPhoto, seedPrompts, seedTexts } from './moderationSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * The photo and text queues and the decisions on a photo, on PostgreSQL and
 * Valkey: the queues' order and paging from their indexes (deleted accounts
 * left out, a name-only profile not in the text queue), every decision's
 * audit row in its transaction (a refused row changes nothing and tells
 * nobody), the person's `profile` event with the reason in their language,
 * and the statement counts.
 */

const ADMIN_IP = '93.184.216.34';
const USER_TARGET = 1;

describe.skipIf(!hasInfrastructure)('admin: the photo and text queues', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  const realtime = new FakeRealtimePublisher();
  const media: MediaStore = {
    storage: new FakeObjectStorage(),
    privateBucket: 'uploads',
    mediaBucket: 'media',
    urls: new CdnUrlSigner({ baseUrl: 'https://cdn.test.invalid', signingKey: 'admin-photos-cdn-signing-key-0123456', scheme: 'hmac' }),
  };
  const tokens = new Map<string, string>();
  const rawIds: string[] = [];
  const bodies: string[] = [];

  beforeAll(async () => {
    db = await migratedDatabase();
    await installAuditFailure(db);
    h = await startAdminHarness(db, {}, { jobs: new MemoryJobProducer(), realtime, media });
    for (const role of ['superadmin', 'admin', 'moderator', 'support', 'analyst']) tokens.set(role, (await adminAs(h, role)).accessToken);
  }, 120_000);

  afterAll(async () => {
    for (const id of rawIds) for (const body of bodies) expect(body.includes(id), `raw id ${id} in a response`).toBe(false);
    await h?.close();
    await db?.drop();
  });

  beforeEach(async () => {
    realtime.failWith = null;
    await refuseAudit(db);
  });

  async function person(name: string, options: { status?: number; locale?: string } = {}): Promise<SeededUser> {
    const user = await seedUser(h, { name, ...(options.status ? { status: options.status } : {}) });
    rawIds.push(user.id);
    if (options.locale) await db.sql.query(`UPDATE users SET locale = $2 WHERE id = $1`, [user.id, options.locale]);
    return user;
  }

  async function send(url: string, _body?: undefined, role = 'moderator'): Promise<LightMyRequestResponse> {
    const response = await admin(h, url, undefined, { token: tokens.get(role)!, ip: ADMIN_IP });
    bodies.push(response.body);
    return response;
  }

  const post = async (url: string, body: unknown = {}, role = 'moderator') => {
    const response = await admin(h, url, body, { token: tokens.get(role)!, method: 'POST', ip: ADMIN_IP });
    bodies.push(response.body);
    return response;
  };

  function events(user: SeededUser, type?: RealtimeEnvelope['t']): RealtimeEnvelope[] {
    return realtime.on(userChannel(user.publicUid)).filter((e) => type === undefined || e.t === type);
  }

  const photoRow = (id: string) => row<{ status: number; reject_reason: number | null; decided_by: number | null }>(db, `SELECT status, reject_reason, decided_by FROM photos WHERE id = $1`, [id]);

  // ─── The photo queue ──────────────────────────────────────────────────

  describe('photo queue', () => {
    it('lists photos waiting, oldest first, paged by id, with the person and their other photos; deleted accounts left out', async () => {
      await db.sql.query(`UPDATE photos SET status = 3 WHERE status = 2`);
      const a = await person('Queue A');
      await db.sql.query(`UPDATE users SET birth_date = (current_date - interval '30 years 2 days')::date, gender = 1, country = 'TR' WHERE id = $1`, [a.id]);
      const first = await seedPhoto(h, a.id, { position: 0, status: 2, modFlags: 1 | 8 });
      const other = await seedPhoto(h, a.id, { position: 1, status: 3 });
      const gone = await person('Queue Deleted', { status: 7 });
      await seedPhoto(h, gone.id, { status: 2 });
      const b = await person('Queue B');
      const second = await seedPhoto(h, b.id, { status: 2 });
      const third = await seedPhoto(h, b.id, { position: 1, status: 2 });

      const page = await send('/v1/admin/moderation/photos?limit=2');
      expect(page.statusCode, page.body).toBe(200);
      expect(statements(page)).toBe(1);
      const body = adminPhotoQueueSchema.parse(page.json());
      expect(body.items.map((p) => p.id)).toEqual([first, second]);
      expect(body.items[0]).toMatchObject({
        modFlags: ['nudity', 'possible_minor'],
        user: { id: a.publicUid, name: 'Queue A', age: 30, gender: 'woman', country: 'TR', verified: false },
        others: [{ id: other, status: 'approved' }],
      });
      expect(body.items[0]?.url).toMatch(/^https:\/\/cdn\.test\.invalid\//);
      expect(body.items[0]?.others[0]?.thumbUrl).toMatch(/^https:\/\/cdn\.test\.invalid\//);
      const next = adminPhotoQueueSchema.parse((await send(`/v1/admin/moderation/photos?limit=2&cursor=${body.nextCursor}`)).json());
      expect(next.items.map((p) => p.id)).toEqual([third]);
      expect(next.nextCursor).toBeNull();
      expect((await send('/v1/admin/moderation/photos?cursor=bm9wZQ')).statusCode).toBe(400);
    });

    it('is for the roles holding moderation.read', async () => {
      expect((await send('/v1/admin/moderation/photos', undefined, 'admin')).statusCode).toBe(200);
      const refused = await send('/v1/admin/moderation/photos', undefined, 'support');
      expect(refused.statusCode).toBe(403);
      problemSchemaFor('forbidden').parse(refused.json());
      expect((await send('/v1/admin/moderation/photos', undefined, 'analyst')).statusCode).toBe(403);
      expect((await admin(h, '/v1/admin/moderation/photos')).statusCode).toBe(401);
    });
  });

  // ─── Decisions ────────────────────────────────────────────────────────

  describe('photo decisions', () => {
    it('rejects with a reason: two statements, the record, the audit row about the person, the reason in their language', async () => {
      const u = await person('Photo Fa', { locale: 'fa-IR' });
      const photo = await seedPhoto(h, u.id, { status: 2 });
      const res = await post(`/v1/admin/moderation/photos/${photo}/reject`, { reason: 'nudity' });
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBe(2);
      expect(adminPhotoDecisionSchema.parse(res.json())).toEqual({ photo: { id: photo, status: 'rejected', rejectReason: 'nudity' }, sideEffects: 'done' });
      expect(await photoRow(photo)).toMatchObject({ status: 4, reject_reason: 2 });
      const record = await row<{ kind: number; reason_code: number; note: string; reason_text: string }>(db, `SELECT kind, reason_code, note, reason_text FROM moderation_actions WHERE user_id = $1`, [u.id]);
      expect(record).toEqual({ kind: 6, reason_code: 2, note: `photo ${photo}`, reason_text: 'Nudity or sexual content is not allowed.' });
      const audits = await auditRows(db, { action: 'photo.reject', targetType: USER_TARGET, targetId: u.id });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ ip: ADMIN_IP, detail: { photoId: photo, reason: 'nudity', before: { status: 'review' }, after: { status: 'rejected', rejectReason: 'nudity' } } });
      expect(audits[0]?.admin_id).not.toBeNull();
      const event = events(u, 'profile').at(-1);
      expect(realtimePayloads.profile.parse(event?.d)).toEqual({ photo: { id: photo, status: 'rejected', rejectReason: 'برهنگی یا محتوای جنسی مجاز نیست.' } });
    });

    it('answers 409 for a photo another admin decided since it was seen, keeping their decision and writing nothing', async () => {
      const u = await person('Two Moderators');
      const photo = await seedPhoto(h, u.id, { status: 2 });
      // A rejects from the queue; B approves the same photo from a stale queue page.
      expect((await post(`/v1/admin/moderation/photos/${photo}/reject`, { reason: 'nudity', from: 'review' })).statusCode).toBe(200);
      const heard = events(u).length;
      const stale = await post(`/v1/admin/moderation/photos/${photo}/approve`, { from: 'review' }, 'admin');
      expect(stale.statusCode).toBe(409);
      expect(json(stale)['detail']).toBe('Already decided.');
      expect(await photoRow(photo)).toMatchObject({ status: 4, reject_reason: 2 });
      expect(await auditRows(db, { action: 'photo.approve', targetId: u.id })).toHaveLength(0);
      expect(events(u).length).toBe(heard);
      // From the person's page, where it shows as rejected, it can still be approved.
      expect((await post(`/v1/admin/moderation/photos/${photo}/approve`, { from: 'rejected' }, 'admin')).json()).toMatchObject({ photo: { status: 'approved' } });
      expect((await post(`/v1/admin/moderation/photos/${photo}/approve`, { from: 'sideways' })).statusCode).toBe(400);
    });

    it('approves from waiting and from rejected, rejects an approved one; the same decision twice changes nothing but its side', async () => {
      const u = await person('Photo Back');
      const photo = await seedPhoto(h, u.id, { status: 4, rejectReason: 1 });
      const approved = await post(`/v1/admin/moderation/photos/${photo}/approve`);
      expect(adminPhotoDecisionSchema.parse(approved.json()).photo).toEqual({ id: photo, status: 'approved' });
      expect(realtimePayloads.profile.parse(events(u, 'profile').at(-1)?.d)).toEqual({ photo: { id: photo, status: 'approved' } });
      const heard = events(u).length;
      const again = await post(`/v1/admin/moderation/photos/${photo}/approve`);
      expect(again.statusCode).toBe(200);
      expect(statements(again)).toBe(1);
      // Nothing written, but the side runs again (it repairs one that failed): the same state is heard once more.
      expect(events(u).length).toBe(heard + 1);
      expect(realtimePayloads.profile.parse(events(u, 'profile').at(-1)?.d)).toEqual({ photo: { id: photo, status: 'approved' } });
      expect(await auditRows(db, { action: 'photo.approve', targetId: u.id })).toHaveLength(1);
      const live = await post(`/v1/admin/moderation/photos/${photo}/reject`, { reason: 'someone_else' });
      expect(adminPhotoDecisionSchema.parse(live.json()).photo).toEqual({ id: photo, status: 'rejected', rejectReason: 'someone_else' });
      expect((await post(`/v1/admin/moderation/photos/${photo}/reject`, { reason: 'someone_else' })).json()).toMatchObject({ photo: { status: 'rejected' } });
      expect(await auditRows(db, { action: 'photo.reject', targetId: u.id })).toHaveLength(1);
    });

    it('lapses the verified badge when the reference photo is rejected', async () => {
      const u = await person('Verified One');
      const main = await seedPhoto(h, u.id, { status: 3 });
      await db.sql.query(`INSERT INTO verifications (id, user_id, method, status, photo_id, decided_at) VALUES ($1, $2, 1, 3, $3, now())`, [h.app.ids.nextId(), u.id, main]);
      await db.sql.query(`UPDATE users SET is_verified = true WHERE id = $1`, [u.id]);
      expect((await post(`/v1/admin/moderation/photos/${main}/reject`, { reason: 'someone_else' })).statusCode).toBe(200);
      expect((await row<{ v: boolean }>(db, `SELECT is_verified AS v FROM users WHERE id = $1`, [u.id])).v).toBe(false);
    });

    it('refuses a photo still processing (409), no photo (404), the worker’s own reason (422) and other roles', async () => {
      const u = await person('Photo Errors');
      const processing = await seedPhoto(h, u.id, { status: 1 });
      const busy = await post(`/v1/admin/moderation/photos/${processing}/approve`);
      expect(busy.statusCode).toBe(409);
      problemSchemaFor('conflict').parse(busy.json());
      expect((await post('/v1/admin/moderation/photos/99999999999/approve')).statusCode).toBe(404);
      const wrong = await post(`/v1/admin/moderation/photos/${processing}/reject`, { reason: 'unreadable' });
      expect(wrong.statusCode).toBe(422);
      expect((json(wrong)['errors'] as unknown[])[0]).toMatchObject({ pointer: '/reason', code: 'wrong_reason' });
      expect((await post(`/v1/admin/moderation/photos/${processing}/approve`, {}, 'support')).statusCode).toBe(403);
      expect((await admin(h, `/v1/admin/moderation/photos/${processing}/approve`, {}, { method: 'POST' })).statusCode).toBe(401);
    });

    it('rolls back with a refused audit row: the photo as it was, no record, nothing sent', async () => {
      const u = await person('Photo Refused');
      const photo = await seedPhoto(h, u.id, { status: 2 });
      await refuseAudit(db, 'photo.reject');
      const published = realtime.published.length;
      const res = await post(`/v1/admin/moderation/photos/${photo}/reject`, { reason: 'violence' });
      expect(res.statusCode).toBe(500);
      expect(await photoRow(photo)).toEqual({ status: 2, reject_reason: null, decided_by: null });
      expect((await row<{ n: number }>(db, `SELECT count(*)::integer AS n FROM moderation_actions WHERE user_id = $1`, [u.id])).n).toBe(0);
      expect(realtime.published.length).toBe(published);
      expect(await auditRows(db, { action: 'photo.reject', targetId: u.id })).toEqual([]);
    });

    it('rolls an approval back with its refused audit row', async () => {
      const u = await person('Approve Refused');
      const photo = await seedPhoto(h, u.id, { status: 2 });
      await refuseAudit(db, 'photo.approve');
      const published = realtime.published.length;
      expect((await post(`/v1/admin/moderation/photos/${photo}/approve`)).statusCode).toBe(500);
      expect(await photoRow(photo)).toEqual({ status: 2, reject_reason: null, decided_by: null });
      expect(realtime.published.length).toBe(published);
    });

    it('answers the decision when the app side fails after the commit', async () => {
      const u = await person('Photo Late');
      const photo = await seedPhoto(h, u.id, { status: 2 });
      realtime.failWith = new Error('centrifugo down');
      const res = await post(`/v1/admin/moderation/photos/${photo}/approve`);
      expect(res.statusCode).toBe(200);
      expect(adminPhotoDecisionSchema.parse(res.json()).sideEffects).toBe('failed');
      expect((await photoRow(photo)).status).toBe(3);
    });
  });

  // ─── The text queue ───────────────────────────────────────────────────

  describe('text queue', () => {
    it('lists people with an about, job or answer waiting, by account; a name-only profile and a deleted account are not there', async () => {
      await db.sql.query(`UPDATE profiles SET text_state = 2`);
      await db.sql.query(`UPDATE profile_prompts SET status = 2`);
      const profileOnly = await person('Text About');
      await seedTexts(h, profileOnly.id, { about: 'I like tea', textState: 1 });
      const promptOnly = await person('Text Prompt');
      await seedTexts(h, promptOnly.id, { textState: 2 });
      await seedPrompts(h, promptOnly.id, [{ position: 0, answer: 'Mountains' }]);
      const both = await person('Text Both');
      await seedTexts(h, both.id, { job: 'Pilot', textState: 1 });
      await seedPrompts(h, both.id, [{ position: 0, answer: 'Sea', status: 2 }, { position: 1, answer: 'Sky' }]);
      const nameOnly = await person('Name Only');
      await seedTexts(h, nameOnly.id, { textState: 1 });
      const deleted = await person('Text Deleted', { status: 7 });
      await seedTexts(h, deleted.id, { about: 'Gone', textState: 1 });
      // The questions come from the catalogue in memory.
      await reloadConfig(h);

      const first = await send('/v1/admin/moderation/texts?limit=2');
      expect(first.statusCode, first.body).toBe(200);
      expect(statements(first)).toBe(1);
      const page = adminTextQueueSchema.parse(first.json());
      expect(page.items.map((i) => i.user.id)).toEqual([profileOnly.publicUid, promptOnly.publicUid]);
      expect(page.items[0]).toMatchObject({ about: { text: 'I like tea', state: 'checking' }, job: null, prompts: [] });
      expect(page.items[1]?.prompts).toMatchObject([{ position: 0, answer: 'Mountains', status: 'checking' }]);
      expect(page.items[1]?.prompts[0]?.question.en).toMatch(/^A good day/);
      // The cursor names the last person by public id, never by raw id.
      expect(decodeCursor(z.object({ u: z.string() }), page.nextCursor ?? '')).toEqual({ u: promptOnly.publicUid });
      const rest = adminTextQueueSchema.parse((await send(`/v1/admin/moderation/texts?cursor=${page.nextCursor}`)).json());
      expect(rest.items.map((i) => i.user.id)).toEqual([both.publicUid]);
      expect(rest.items[0]).toMatchObject({ job: { text: 'Pilot', state: 'checking' }, prompts: [{ status: 'approved' }, { status: 'checking' }] });
      expect((await send('/v1/admin/moderation/texts', undefined, 'support')).statusCode).toBe(403);
    });

    it('leaves the queue once decided: approve answers the texts after it', async () => {
      const u = await person('Text Decide');
      const version = await seedTexts(h, u.id, { about: 'Waiting', textState: 1 });
      const res = await post(`/v1/admin/moderation/texts/${u.publicUid}/approve`, { version });
      expect(res.statusCode, res.body).toBe(200);
      const queue = adminTextQueueSchema.parse((await send('/v1/admin/moderation/texts?limit=50')).json());
      expect(queue.items.map((i) => i.user.id)).not.toContain(u.publicUid);
    });
  });
});
