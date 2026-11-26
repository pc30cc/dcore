import { createHash } from 'node:crypto';
import {
  adminActionPageSchema,
  adminReasonsSchema,
  adminReportPageSchema,
  adminUserConsentsSchema,
  adminUserDetailSchema,
  adminUserDevicesSchema,
  adminUserListSchema,
  adminUserPhotosSchema,
  adminUserPurchasesSchema,
  adminUserSearchResultSchema,
  adminUserSessionsSchema,
  adminUserWalletSchema,
  auditPageSchema,
  problemSchemaFor,
  type AdminUserSearchResult,
} from '@app/shared';
import { CdnUrlSigner, FakeObjectStorage, FakeRealtimePublisher, type MediaStore } from '@app/shared/server';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { migratedDatabase, row, seedUser, statements, type SeededUser, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, auditRows, startAdminHarness, type AdminHarness } from './adminSupport.js';
import { reloadConfig, seedPhone, seedPhoto, seedPrompts, seedReport, seedTexts } from './moderationSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * The admin panel's reads of people on PostgreSQL and Valkey: the list and
 * each filter, the search by public id, phone (any spelling), store order
 * id, purchase token and name (Latin and Persian, through the trigram
 * index), the user page and every tab, each route's permission, its exact
 * statement count, and the privacy rules: people are public ids, the search
 * text is never logged, a purged account is nowhere.
 */

const CDN_KEY = 'admin-users-cdn-signing-key-0123456789';
const PHONE = '+989121234567';

describe.skipIf(!hasInfrastructure)('admin: people (reads)', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  const media: MediaStore = {
    storage: new FakeObjectStorage(),
    privateBucket: 'uploads',
    mediaBucket: 'media',
    urls: new CdnUrlSigner({ baseUrl: 'https://cdn.test.invalid', signingKey: CDN_KEY, scheme: 'hmac' }),
  };
  const tokens = new Map<string, string>();
  const rawIds: string[] = [];
  const bodies: string[] = [];

  let sara: SeededUser;
  let ali: SeededUser;
  let other: SeededUser;
  let pending: SeededUser;
  let suspended: SeededUser;
  let banned: SeededUser;
  let shadow: SeededUser;
  let tester: SeededUser;
  let purged: SeededUser;
  let saraPhoto: string;
  let saraPrompt: number;
  let token: string;

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startAdminHarness(db, {}, { jobs: new MemoryJobProducer(), realtime: new FakeRealtimePublisher(), media });
    for (const role of ['superadmin', 'admin', 'moderator', 'support', 'finance', 'marketing', 'analyst']) tokens.set(role, (await adminAs(h, role)).accessToken);

    other = await seedUser(h, { name: 'Zeynep Kaya' });
    sara = await seedUser(h, { name: 'Sara Ahmadi', country: 'IR' });
    ali = await seedUser(h, { name: 'علی رضایی' });
    pending = await seedUser(h, { name: 'Pending One', status: 2 });
    suspended = await seedUser(h, { name: 'Suspended One', status: 5 });
    banned = await seedUser(h, { name: 'Banned One', status: 6 });
    shadow = await seedUser(h, { name: 'Shadow One' });
    tester = await seedUser(h, { name: 'Tester One' });
    purged = await seedUser(h, { status: 8 });
    for (const u of [other, sara, ali, pending, suspended, banned, shadow, tester, purged]) rawIds.push(u.id);
    await db.sql.query(`UPDATE users SET is_shadowbanned = true WHERE id = $1`, [shadow.id]);
    await db.sql.query(`UPDATE users SET flags = 1 WHERE id = $1`, [tester.id]);
    await db.sql.query(`UPDATE users SET locale = 'fa', last_active_on = current_date WHERE id = $1`, [sara.id]);

    // Sara's page: texts, prompts, photos, a phone, purchases, wallet, a linked device, consents, reports, actions, audit.
    await seedTexts(h, sara.id, { about: 'I like mountains', job: 'Architect', textState: 3 });
    await db.sql.query(`UPDATE profiles SET text_reject_reason = 1 WHERE user_id = $1`, [sara.id]);
    [saraPrompt] = await seedPrompts(h, sara.id, [{ position: 0, answer: 'Tea at sunrise', status: 1 }]) as [number];
    saraPhoto = await seedPhoto(h, sara.id, { position: 0, status: 3 });
    await seedPhoto(h, sara.id, { position: 1, status: 4, rejectReason: 2, modFlags: 1 });
    await seedPhoto(h, sara.id, { position: 2, status: 1 });
    await seedPhone(h, sara.id, PHONE);
    const plus = await row<{ id: number }>(db, `SELECT id FROM store_products WHERE store = 1 AND product_id = 'sub.plus' ORDER BY id LIMIT 1`);
    const pack = await row<{ id: number }>(db, `SELECT id FROM store_products WHERE store = 2 AND product_id = 'cons.boost.5'`);
    const playPurchase = h.app.ids.nextId();
    await db.sql.query(
      `INSERT INTO store_purchases (id, user_id, purchased_at, expires_at, product_ref, store, kind, state, token_hash, token, order_id, auto_renew)
       VALUES ($1, $2, now(), now() + interval '30 days', $3, 1, 1, 2, decode($4, 'hex'), $5, 'GPA.3311-2233-4455-66778', true)`,
      [playPurchase, sara.id, plus.id, sha256Hex('play-purchase-token-of-sara-0123456789'), 'play-purchase-token-of-sara-0123456789'],
    );
    await db.sql.query(
      `INSERT INTO store_purchases (id, user_id, purchased_at, product_ref, store, kind, state, token_hash, token, order_id, quantity)
       VALUES ($1, $2, now(), $3, 2, 2, 10, decode($4, 'hex'), $5, 'BZ-ORDER-99001', 1)`,
      [h.app.ids.nextId(), ali.id, pack.id, sha256Hex('bazaar-token-of-ali-000000000000'), 'bazaar-token-of-ali-000000000000'],
    );
    await db.sql.query(
      `INSERT INTO subscriptions (user_id, started_at, expires_at, purchase_id, plan_id, store, status, auto_renew)
       SELECT $1, now(), now() + interval '30 days', $2, id, 1, 1, true FROM plans WHERE key = 'plus'`,
      [sara.id, playPurchase],
    );
    await db.sql.query(`INSERT INTO wallet_balances (user_id, balance, item, store) VALUES ($1, 4, 2, 2), ($1, 1, 1, 0)`, [sara.id]);
    for (let i = 0; i < 3; i += 1) {
      await db.sql.query(`INSERT INTO wallet_ledger (id, user_id, delta, balance_after, item, store, reason) VALUES ($1, $2, $3, $4, 2, 2, $5)`, [
        h.app.ids.nextId(),
        sara.id,
        i === 0 ? 5 : -1,
        i === 0 ? 5 : 5 - i,
        i === 0 ? 1 : 2,
      ]);
    }
    await db.sql.query(
      `INSERT INTO devices (id, user_id, app_version, platform, store, fingerprint_hash, locale)
       SELECT $1, $2, 90, 1, 2, fingerprint_hash, 'fa' FROM devices WHERE user_id = $3`,
      [h.app.ids.nextId(), other.id, sara.id],
    );
    await db.sql.query(`INSERT INTO user_consents (user_id, kind, version, store) VALUES ($1, 1, 3, 2), ($1, 2, 3, 2)`, [sara.id]);
    await seedReport(h, { targetId: sara.id, reporterId: other.id, reason: 2, priority: 55 });
    await seedReport(h, { targetId: sara.id, reporterId: null, reason: 7, status: 4 });
    await seedReport(h, { targetId: other.id, reporterId: sara.id, reason: 1 });
    const warning = h.app.ids.nextId();
    await db.sql.query(`INSERT INTO moderation_actions (id, user_id, kind, reason_code, reason_text, note) VALUES ($1, $2, 1, 7, 'Please stop sending links.', 'second time')`, [warning, sara.id]);
    await db.sql.query(`INSERT INTO appeals (id, user_id, action_id, body) VALUES ($1, $2, $3, 'It was one link.')`, [h.app.ids.nextId(), sara.id, warning]);
    await db.sql.query(`INSERT INTO moderation_actions (id, user_id, kind, reason_code, reason_text) VALUES ($1, $2, 6, 2, 'Nudity or sexual content is not allowed.')`, [h.app.ids.nextId(), sara.id]);
    await db.sql.query(`INSERT INTO audit_log (id, admin_id, target_type, target_id, action, detail) VALUES ($1, NULL, 1, $2, 'user.warn', '{"reason": "spam"}')`, [h.app.ids.nextId(), sara.id]);
    await reloadConfig(h);
    token = tokens.get('superadmin')!;
  }, 120_000);

  afterAll(async () => {
    // People are public ids on the admin wire: no seeded raw id in any answer of the suite.
    for (const id of rawIds) for (const body of bodies) expect(body.includes(id), `raw id ${id} in a response`).toBe(false);
    await h?.close();
    await db?.drop();
  });

  function sha256Hex(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  async function get(url: string, role = 'superadmin'): Promise<LightMyRequestResponse> {
    const response = await admin(h, url, undefined, { token: tokens.get(role)! });
    bodies.push(response.body);
    return response;
  }

  /** A lookup by phone, or a hit by order id or token, is the search and its audit row (2); anything else 1. */
  async function search(q: string, expected = 1, as = token): Promise<{ response: LightMyRequestResponse; result: AdminUserSearchResult }> {
    const response = await admin(h, '/v1/admin/users/search', { q }, { token: as });
    bodies.push(response.body);
    expect(response.statusCode, response.body).toBe(200);
    expect(statements(response)).toBe(expected);
    return { response, result: adminUserSearchResultSchema.parse(response.json()) };
  }

  describe('the list', () => {
    it('lists people newest first in pages, without purged accounts, in one statement', async () => {
      const first = await get('/v1/admin/users?limit=3');
      expect(first.statusCode, first.body).toBe(200);
      expect(statements(first)).toBe(1);
      const page = adminUserListSchema.parse(first.json());
      expect(page.items.map((u) => u.id)).toEqual([tester.publicUid, shadow.publicUid, banned.publicUid]);
      expect(page.nextCursor).not.toBeNull();
      const all: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await get(`/v1/admin/users?limit=4${cursor ? `&cursor=${cursor}` : ''}`);
        const p = adminUserListSchema.parse(res.json());
        all.push(...p.items.map((u) => u.id));
        cursor = p.nextCursor;
      } while (cursor);
      expect(all).not.toContain(purged.publicUid);
      expect(all.slice(0, 8)).toEqual([tester, shadow, banned, suspended, pending, ali, sara, other].map((u) => u.publicUid));
      const saraRow = adminUserListSchema.parse((await get('/v1/admin/users?limit=100')).json()).items.find((u) => u.id === sara.publicUid);
      expect(saraRow?.photoUrl).toMatch(/^https:\/\/cdn\.test\.invalid\//);
      expect(saraRow?.country).toBe('IR');
      expect(saraRow?.lastActiveOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it.each([
      ['pending_review', () => [pending]],
      ['suspended', () => [suspended]],
      ['banned', () => [banned]],
      ['shadowbanned', () => [shadow]],
      ['test', () => [tester]],
    ] as const)('filters %s', async (filter, expected) => {
      const res = await get(`/v1/admin/users?filter=${filter}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBe(1);
      const page = adminUserListSchema.parse(res.json());
      expect(page.items.map((u) => u.id)).toEqual(expected().map((u) => u.publicUid));
      if (filter === 'shadowbanned') expect(page.items[0]?.shadowbanned).toBe(true);
      if (filter === 'test') expect(page.items[0]?.test).toBe(true);
    });

    it('refuses a cursor it did not make and a filter it does not know', async () => {
      const bad = await get('/v1/admin/users?cursor=bm90LWEtY3Vyc29y');
      expect(bad.statusCode).toBe(400);
      expect(problemSchemaFor('validation_failed').parse(bad.json()).errors).toEqual([expect.objectContaining({ in: 'query', pointer: '/cursor', code: 'invalid' })]);
      // 19 digits past the 63-bit range: refused as a cursor, never handed to the ::bigint cast (a 500).
      const huge = Buffer.from(JSON.stringify({ id: '9999999999999999999' })).toString('base64url');
      for (const path of ['/v1/admin/users', `/v1/admin/users/${sara.publicUid}/reports`, `/v1/admin/users/${sara.publicUid}/moderation`, `/v1/admin/users/${sara.publicUid}/wallet`, `/v1/admin/users/${sara.publicUid}/audit`]) {
        const res = await get(`${path}?cursor=${huge}`);
        expect(res.statusCode, path).toBe(400);
        expect(problemSchemaFor('validation_failed').parse(res.json()).errors).toEqual([expect.objectContaining({ in: 'query', pointer: '/cursor', code: 'invalid' })]);
      }
      expect((await get('/v1/admin/users?filter=everyone')).statusCode).toBe(400);
    });
  });

  describe('search', () => {
    it('finds a person by public id', async () => {
      const { result } = await search(sara.publicUid);
      expect(result.items.map((i) => [i.id, i.matchedBy])).toEqual([[sara.publicUid, 'id']]);
    });

    it.each(['+989121234567', '00989121234567', '۰۹۱۲۱۲۳۴۵۶۷'.replace(/^۰/, '+۹۸'), '+98 912 123 4567'])('finds a person by phone (%s)', async (q) => {
      const { result } = await search(q, 2);
      expect(result.items.map((i) => [i.id, i.matchedBy])).toEqual([[sara.publicUid, 'phone']]);
    });

    it('finds a buyer by a store order id of either store, and by a purchase token', async () => {
      expect((await search('GPA.3311-2233-4455-66778', 2)).result.items.map((i) => [i.id, i.matchedBy])).toEqual([[sara.publicUid, 'order']]);
      expect((await search('BZ-ORDER-99001', 2)).result.items.map((i) => [i.id, i.matchedBy])).toEqual([[ali.publicUid, 'order']]);
      expect((await search('bazaar-token-of-ali-000000000000', 2)).result.items.map((i) => [i.id, i.matchedBy])).toEqual([[ali.publicUid, 'token']]);
    });

    it('finds Latin and Persian names by part of a word', async () => {
      const latin = (await search('ahmad')).result.items;
      expect(latin[0]).toMatchObject({ id: sara.publicUid, matchedBy: 'name' });
      const persian = (await search('رضایی')).result.items;
      expect(persian[0]).toMatchObject({ id: ali.publicUid, matchedBy: 'name' });
      expect((await search('zey')).result.items[0]).toMatchObject({ id: other.publicUid, matchedBy: 'name' });
    });

    it('reads a 13-letter word as a name whether or not it decodes as a public id, and finds nothing for nonsense', async () => {
      await db.sql.query(`UPDATE profiles SET display_name = 'Kayaabcdefghij' WHERE user_id = $1`, [other.id]);
      try {
        const word = 'kayaabcdefghi';
        expect(word).toMatch(/^[a-z2-7]{13}$/);
        expect((await search(word)).result.items.some((i) => i.id === other.publicUid && i.matchedBy === 'name')).toBe(true);
      } finally {
        await db.sql.query(`UPDATE profiles SET display_name = 'Zeynep Kaya' WHERE user_id = $1`, [other.id]);
      }
      expect((await search('qqqqxxxxwwww')).result.items).toEqual([]);
      expect((await search('zz')).result.items).toEqual([]);
    });

    it('never writes the search text into a log line', async () => {
      const marker = 'Sara Ahmadi-marker-zq';
      const before = h.logs.length;
      await search(marker);
      await search('+989121234567', 2);
      const lines = h.logs.slice(before).join('\n');
      expect(lines).not.toContain(marker);
      expect(lines).not.toContain('9121234567');
      expect(lines).not.toContain('Ahmadi');
    });

    it('audits each lookup by phone or purchase without the text, and meters it with the device-ban lookup (30/h, fails closed)', async () => {
      // Support holds users.read only: the lookup is theirs too, metered and on the record.
      const support = await adminAs(h, 'support');
      const before = await auditRows(db, { action: 'user.search', targetType: 0 });
      expect((await search(PHONE, 2, support.accessToken)).result.items.map((i) => i.id)).toEqual([sara.publicUid]);
      expect((await search('+989000000001', 2, support.accessToken)).result.items).toEqual([]);
      expect((await search('BZ-ORDER-99001', 2, support.accessToken)).result.items.map((i) => i.id)).toEqual([ali.publicUid]);
      // A name or an id is neither metered nor recorded.
      await search('ahmad', 1, support.accessToken);
      const rows = (await auditRows(db, { action: 'user.search', targetType: 0 })).slice(before.length);
      expect(rows.map((r) => r.detail)).toEqual([
        { by: 'phone', hits: 1 },
        { by: 'phone', hits: 0 },
        { by: 'order', hits: 1 },
      ]);
      expect(JSON.stringify(rows)).not.toMatch(/9121234567|9000000001|BZ-ORDER/);

      // One budget with POST /device-bans/search: 30 lookups an hour per admin, then 429; Valkey down is 503.
      const busy = await adminAs(h, 'admin');
      for (let i = 0; i < 15; i += 1) await search(PHONE, 2, busy.accessToken);
      for (let i = 0; i < 15; i += 1) {
        expect((await admin(h, '/v1/admin/device-bans/search', { phone: PHONE }, { token: busy.accessToken })).statusCode).toBe(200);
      }
      const limited = await admin(h, '/v1/admin/users/search', { q: PHONE }, { token: busy.accessToken });
      expect(limited.statusCode).toBe(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      // A name search is not held by the spent budget.
      expect((await admin(h, '/v1/admin/users/search', { q: 'ahmad' }, { token: busy.accessToken })).statusCode).toBe(200);
      vi.spyOn(h.app.limits, 'take').mockRejectedValueOnce(new Error('valkey down'));
      expect((await admin(h, '/v1/admin/users/search', { q: PHONE }, { token })).statusCode).toBe(503);
    });

    it('refuses an empty or a huge query', async () => {
      expect((await admin(h, '/v1/admin/users/search', { q: '   ' }, { token })).statusCode).toBe(400);
      expect((await admin(h, '/v1/admin/users/search', { q: 'x'.repeat(4_097) }, { token })).statusCode).toBe(400);
    });
  });

  describe('what a role reads beyond users.read', () => {
    it('keeps shadowbans, internal notes, holds and linked accounts from support and finance; moderation sees them', async () => {
      const shadowban = h.app.ids.nextId();
      await db.sql.query(
        `INSERT INTO moderation_actions (id, user_id, kind, reason_code, reason_text, note) VALUES ($1, $2, 4, 7, 'Spam', 'seen in three reports')`,
        [shadowban, shadow.id],
      );
      const hold = h.app.ids.nextId();
      await db.sql.query(`INSERT INTO legal_holds (id, user_id, kind) VALUES ($1, $2, 1)`, [hold, sara.id]);
      // A lifted ban, its lift record and a device-ban record: the lift's and the device ban's texts are internal.
      const [ban, lift, deviceBan] = [h.app.ids.nextId(), h.app.ids.nextId(), h.app.ids.nextId()];
      await db.sql.query(`INSERT INTO moderation_actions (id, user_id, kind, reason_code, reason_text, revoked_at) VALUES ($1, $2, 3, 7, 'Banned for spam.', now())`, [ban, shadow.id]);
      await db.sql.query(`INSERT INTO moderation_actions (id, user_id, kind, reason_code, reason_text) VALUES ($1, $2, 5, 7, 'Reporter withdrew.')`, [lift, shadow.id]);
      await db.sql.query(`INSERT INTO moderation_actions (id, user_id, kind, reason_code, reason_text) VALUES ($1, $2, 9, 99, 'Same device as another account.')`, [deviceBan, shadow.id]);
      const texts = async (role: string) => {
        const records = adminActionPageSchema.parse((await get(`/v1/admin/users/${shadow.publicUid}/moderation?limit=100`, role)).json());
        return new Map(records.items.map((a) => [a.id, { text: a.reasonText, note: a.note }]));
      };
      try {
        for (const role of ['support', 'finance']) {
          const seen = await texts(role);
          expect(seen.get(ban), role).toEqual({ text: 'Banned for spam.', note: null });
          expect(seen.get(lift), role).toEqual({ text: '', note: null });
          expect(seen.get(deviceBan), role).toEqual({ text: '', note: null });
          expect([...seen.values()].every((x) => x.note === null), role).toBe(true);
        }
        const all = await texts('moderator');
        expect([all.get(ban)?.text, all.get(lift)?.text, all.get(deviceBan)?.text]).toEqual(['Banned for spam.', 'Reporter withdrew.', 'Same device as another account.']);
        for (const role of ['support', 'finance']) {
          expect((await get('/v1/admin/users?filter=shadowbanned', role)).statusCode, role).toBe(403);
          const list = adminUserListSchema.parse((await get('/v1/admin/users?limit=100', role)).json());
          expect(list.items.find((u) => u.id === shadow.publicUid)?.shadowbanned, role).toBe(false);
          const page = adminUserDetailSchema.parse((await get(`/v1/admin/users/${shadow.publicUid}`, role)).json());
          expect(page.shadowbanned, role).toBe(false);
          expect(page.standing.map((a) => a.kind), role).not.toContain('shadowban');
          const records = adminActionPageSchema.parse((await get(`/v1/admin/users/${shadow.publicUid}/moderation`, role)).json());
          expect(records.items.map((a) => a.id), role).not.toContain(shadowban);
          const saraPage = adminUserDetailSchema.parse((await get(`/v1/admin/users/${sara.publicUid}`, role)).json());
          expect(saraPage.heldNow, role).toBe(false);
          expect(saraPage.standing.map((a) => a.note), role).toEqual([null]);
          const devices = adminUserDevicesSchema.parse((await get(`/v1/admin/users/${sara.publicUid}/devices`, role)).json());
          expect(devices.items.flatMap((d) => d.linked), role).toEqual([]);
        }
        const moderator = 'moderator';
        expect((await get('/v1/admin/users?filter=shadowbanned', moderator)).statusCode).toBe(200);
        const page = adminUserDetailSchema.parse((await get(`/v1/admin/users/${shadow.publicUid}`, moderator)).json());
        expect(page.shadowbanned).toBe(true);
        expect(page.standing.map((a) => [a.kind, a.note])).toEqual([['shadowban', 'seen in three reports']]);
        const saraPage = adminUserDetailSchema.parse((await get(`/v1/admin/users/${sara.publicUid}`, moderator)).json());
        expect(saraPage.heldNow).toBe(true);
        expect(saraPage.standing.map((a) => a.note)).toEqual(['second time']);
        const devices = adminUserDevicesSchema.parse((await get(`/v1/admin/users/${sara.publicUid}/devices`, moderator)).json());
        expect(devices.items.flatMap((d) => d.linked.map((u) => u.id))).toEqual([other.publicUid]);
      } finally {
        await db.sql.query(`DELETE FROM moderation_actions WHERE id = ANY($1::bigint[])`, [[shadowban, ban, lift, deviceBan]]);
        await db.sql.query(`DELETE FROM legal_holds WHERE id = $1`, [hold]);
      }
    });
  });

  describe('the user page', () => {
    it('shows the header and profile, standing actions and open reports, in one statement', async () => {
      const res = await get(`/v1/admin/users/${sara.publicUid}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBe(1);
      const user = adminUserDetailSchema.parse(res.json());
      expect(user).toMatchObject({
        id: sara.publicUid,
        name: 'Sara Ahmadi',
        status: 'active',
        locale: 'fa',
        gender: 'man',
        phoneOnFile: true,
        googleOnFile: false,
        heldNow: false,
        openReports: { count: 1, more: false },
        profile: {
          about: 'I like mountains',
          job: 'Architect',
          textState: 'rejected',
          textRejectReason: 'contact_details',
          prompts: [{ position: 0, promptId: saraPrompt, answer: 'Tea at sunrise', status: 'checking' }],
        },
      });
      expect(user.profile?.prompts[0]?.question.en).toMatch(/^A good day/);
      expect(user.standing.map((a) => [a.kind, a.reason, a.note, a.appeal?.status])).toEqual([['warning', 'spam', 'second time', 'open']]);
      expect(user.photoUrl).toBeDefined();
      expect(res.body).not.toContain('9121234567');
    });

    it('answers 404 for a purged account, an unknown one and a malformed id, and 400 for a non-id', async () => {
      expect((await get(`/v1/admin/users/${purged.publicUid}`)).statusCode).toBe(404);
      const unknown = h.app.publicIds.user.encode('99999999999999');
      expect((await get(`/v1/admin/users/${unknown}`)).statusCode).toBe(404);
      expect((await get(`/v1/admin/users/${purged.publicUid}/photos`)).statusCode).toBe(404);
      expect((await get('/v1/admin/users/123')).statusCode).toBe(400);
    });
  });

  describe('tabs', () => {
    it('photos: every state, the reject reason and flags, links for what is not processing', async () => {
      const res = await get(`/v1/admin/users/${sara.publicUid}/photos`);
      expect(statements(res)).toBe(1);
      const { items } = adminUserPhotosSchema.parse(res.json());
      expect(items.map((p) => [p.position, p.status, p.rejectReason ?? null, p.modFlags])).toEqual([
        [0, 'approved', null, []],
        [1, 'rejected', 'nudity', ['nudity']],
        [2, 'processing', null, []],
      ]);
      expect(items[0]?.id).toBe(saraPhoto);
      expect(items[0]?.url).toMatch(/^https:\/\/cdn\.test\.invalid\//);
      expect(items[0]?.thumbUrl).toMatch(/^https:\/\/cdn\.test\.invalid\//);
      expect(items[2]?.url).toBeUndefined();
    });

    it('reports: received and filed, newest first, paged', async () => {
      const received = adminReportPageSchema.parse((await get(`/v1/admin/users/${sara.publicUid}/reports?limit=1`)).json());
      expect(received.items).toHaveLength(1);
      expect(received.items[0]).toMatchObject({ reason: 'spam', status: 'dismissed', reporter: null, reported: { id: sara.publicUid } });
      const next = adminReportPageSchema.parse((await get(`/v1/admin/users/${sara.publicUid}/reports?limit=1&cursor=${received.nextCursor}`)).json());
      expect(next.items[0]).toMatchObject({ reason: 'harassment', status: 'open', priority: 55, reporter: { id: other.publicUid, name: 'Zeynep Kaya' }, evidence: 'complete', filed: false });
      expect(next.nextCursor).toBeNull();
      const filed = await get(`/v1/admin/users/${sara.publicUid}/reports?side=filed`);
      expect(statements(filed)).toBe(1);
      expect(adminReportPageSchema.parse(filed.json()).items.map((r) => [r.reported.id, r.reporter?.id])).toEqual([[other.publicUid, sara.publicUid]]);
    });

    it('moderation: every kind, newest first, with the appeal and the reason per kind', async () => {
      const res = await get(`/v1/admin/users/${sara.publicUid}/moderation`);
      expect(statements(res)).toBe(1);
      const page = adminActionPageSchema.parse(res.json());
      expect(page.items.map((a) => [a.kind, a.reason, a.standing])).toEqual([
        ['photo_rejected', 'nudity', false],
        ['warning', 'spam', true],
      ]);
      expect(page.items[1]?.appeal).toMatchObject({ status: 'open', body: 'It was one link.', decisionText: null, decidedBy: null });
    });

    it('purchases: subscriptions and purchases, never the token', async () => {
      const res = await get(`/v1/admin/users/${sara.publicUid}/purchases`);
      expect(statements(res)).toBe(1);
      const body = adminUserPurchasesSchema.parse(res.json());
      expect(body.subscriptions).toEqual([expect.objectContaining({ store: 'play', plan: 'plus', status: 'renewing', autoRenew: true })]);
      expect(body.items).toEqual([expect.objectContaining({ store: 'play', productId: 'sub.plus', kind: 'subscription', state: 'active', orderId: 'GPA.3311-2233-4455-66778' })]);
      expect(res.body).not.toContain('play-purchase-token-of-sara');
    });

    it('wallet: balances per source and the ledger in pages', async () => {
      const res = await get(`/v1/admin/users/${sara.publicUid}/wallet?limit=2`);
      expect(statements(res)).toBe(1);
      const body = adminUserWalletSchema.parse(res.json());
      expect(body.balances).toEqual([
        { item: 'superlike', store: null, balance: 1 },
        { item: 'boost', store: 'bazaar', balance: 4 },
      ]);
      expect(body.ledger.items.map((l) => [l.delta, l.reason])).toEqual([[-1, 'use'], [-1, 'use']]);
      const more = adminUserWalletSchema.parse((await get(`/v1/admin/users/${sara.publicUid}/wallet?limit=2&cursor=${body.ledger.nextCursor}`)).json());
      expect(more.ledger.items.map((l) => [l.delta, l.reason])).toEqual([[5, 'purchase']]);
    });

    it('devices: the other accounts seen on the same device, never a hash', async () => {
      const res = await get(`/v1/admin/users/${sara.publicUid}/devices`);
      expect(statements(res)).toBe(1);
      const { items } = adminUserDevicesSchema.parse(res.json());
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ platform: 'android', store: 'bazaar', integrity: 'unknown', push: false });
      expect(items[0]?.linked.map((u) => u.id)).toEqual([other.publicUid]);
    });

    it('sessions and consents', async () => {
      const sessions = await get(`/v1/admin/users/${sara.publicUid}/sessions`);
      expect(statements(sessions)).toBe(1);
      expect(adminUserSessionsSchema.parse(sessions.json()).items).toEqual([expect.objectContaining({ id: sara.sessionId, revokedAt: null, store: 'bazaar', deviceId: sara.deviceId })]);
      const consents = await get(`/v1/admin/users/${sara.publicUid}/consents`);
      expect(statements(consents)).toBe(1);
      expect(adminUserConsentsSchema.parse(consents.json()).items.map((c) => [c.kind, c.version, c.store])).toEqual([['terms', 3, 'bazaar'], ['privacy', 3, 'bazaar']]);
    });

    it('audit: the rows about the person, with the person as a public id', async () => {
      const res = await get(`/v1/admin/users/${sara.publicUid}/audit`);
      expect(statements(res)).toBe(1);
      const page = auditPageSchema.parse(res.json());
      expect(page.items).toEqual([expect.objectContaining({ action: 'user.warn', targetType: 'user', user: sara.publicUid, admin: null, detail: { reason: 'spam' } })]);
    });

    it('reasons: every table with the text a person reads in each language, without a statement', async () => {
      const res = await get('/v1/admin/moderation/reasons');
      expect(res.statusCode).toBe(200);
      expect(statements(res)).toBe(0);
      const body = adminReasonsSchema.parse(res.json());
      expect(body.moderation.find((r) => r.reason === 'harassment')?.texts).toEqual({
        en: 'You harassed or bullied other members.',
        fa: 'شما دیگر کاربران را آزار داده‌اید یا مزاحمشان شده‌اید.',
        tr: 'Diğer üyeleri taciz ettiniz veya rahatsız ettiniz.',
      });
      expect(body.photo.map((r) => r.reason)).toContain('unreadable');
      expect(body.text.find((r) => r.reason === 'other')?.texts.fa).toBe('این متن تأیید نشد.');
    });
  });

  describe('permissions', () => {
    const paths = (id: () => string) => [
      ['/v1/admin/users', 'users.read'],
      [`/v1/admin/users/${id()}`, 'users.read'],
      [`/v1/admin/users/${id()}/photos`, 'users.read'],
      [`/v1/admin/users/${id()}/moderation`, 'users.read'],
      [`/v1/admin/users/${id()}/purchases`, 'users.read'],
      [`/v1/admin/users/${id()}/wallet`, 'users.read'],
      [`/v1/admin/users/${id()}/devices`, 'users.read'],
      [`/v1/admin/users/${id()}/sessions`, 'users.read'],
      [`/v1/admin/users/${id()}/consents`, 'users.read'],
      [`/v1/admin/users/${id()}/reports`, 'reports.read'],
      [`/v1/admin/users/${id()}/audit`, 'audit.read'],
      ['/v1/admin/moderation/reasons', 'users.read'],
    ] as const;

    it('lets each role read what its grants cover, and refuses the rest', async () => {
      const allowed: Record<string, readonly string[]> = {
        'users.read': ['superadmin', 'admin', 'moderator', 'support', 'finance'],
        'reports.read': ['superadmin', 'admin', 'moderator'],
        'audit.read': ['superadmin', 'admin'],
      };
      for (const [url, permission] of paths(() => sara.publicUid)) {
        for (const role of ['superadmin', 'admin', 'moderator', 'support', 'finance', 'marketing', 'analyst']) {
          const res = await get(url, role);
          if (allowed[permission]!.includes(role)) expect(res.statusCode, `${role} ${url}`).toBe(200);
          else {
            expect(res.statusCode, `${role} ${url}`).toBe(403);
            problemSchemaFor('forbidden').parse(res.json());
          }
        }
        expect((await admin(h, url)).statusCode, url).toBe(401);
      }
      const searched = await admin(h, '/v1/admin/users/search', { q: 'sara' }, { token: tokens.get('analyst')! });
      expect(searched.statusCode).toBe(403);
      expect((await admin(h, '/v1/admin/users/search', { q: 'sara' }, { token: tokens.get('support')! })).statusCode).toBe(200);
    });
  });
});
