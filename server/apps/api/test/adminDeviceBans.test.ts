import { adminDeviceBanListSchema, adminDeviceBanPageSchema, problemSchemaFor } from '@app/shared';
import { hashDomains } from '@app/shared/server';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { json, migratedDatabase, row, rows, seedUser, statements, type SeededUser, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, auditRows, installAuditFailure, refuseAudit, startAdminHarness, type AdminHarness, type AdminSession } from './adminSupport.js';
import { authApp, device, phone, settingsWith, signInWithPhone, type AuthHarness } from './authSupport.js';
import { seedPhone } from './moderationSupport.js';
import { hasInfrastructure, testSecret } from './support.js';

/**
 * Device, phone and Google-account bans in the admin panel: a ban made from
 * a person (each kind, every row tied to one kind-9 record), from a typed
 * number, its renewal (the longer expiry wins, permanent stays), a row per
 * cause of a value (the server's own, a typed number, each record: none
 * takes another's over), the phone lookup and its limit, removal, and the
 * audit row of each write (rolled back with a refused one). Sign-in is a
 * second app on the same database and the same peppers: a banned number or
 * device is refused there, and signs in again once the ban is removed.
 */

const BAN_TARGET = 18;
const DAY = 86_400_000;

describe.skipIf(!hasInfrastructure)('admin: device bans', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  let auth: AuthHarness;
  const admins = new Map<string, AdminSession>();
  const bodies: string[] = [];
  const shared = { HASH_PEPPERS: JSON.stringify({ 1: testSecret() }), ID_PUBLIC_KEY: testSecret() };

  beforeAll(async () => {
    db = await migratedDatabase();
    await installAuditFailure(db);
    h = await startAdminHarness(db, shared);
    auth = await authApp(db, { env: shared, settings: settingsWith({ caps: { resend_seconds: 1, phone_daily: 100, ip_hourly: 100, install_daily: 100 } }) });
    for (const role of ['admin', 'moderator', 'support', 'analyst']) admins.set(role, await adminAs(h, role));
  }, 120_000);

  afterAll(async () => {
    // No ban hash, raw user id or phone number in any answer.
    const hashes = await rows<{ h: string }>(db, `SELECT encode(value_hash, 'hex') AS h FROM device_bans`);
    const users = await rows<{ id: string }>(db, `SELECT id::text FROM users`);
    for (const body of bodies) {
      for (const { h: hex } of hashes) expect(body.includes(hex)).toBe(false);
      // No raw user id either: people are public ids on the admin wire.
      for (const { id } of users) expect(body.includes(id), `raw id ${id}`).toBe(false);
      expect(body).not.toMatch(/\+98912\d{7}/);
    }
    await auth?.close();
    await h?.close();
    await db?.drop();
  });

  beforeEach(async () => {
    await refuseAudit(db);
  });

  async function as(role: string, url: string, body?: unknown, method?: 'POST' | 'DELETE'): Promise<LightMyRequestResponse> {
    const res = await admin(h, url, body, { token: admins.get(role)!.accessToken, ...(method ? { method } : {}) });
    bodies.push(res.body);
    return res;
  }

  /** A code for the same number again: past the resend wait (1 s here). */
  const resendGap = () => new Promise((resolve) => setTimeout(resolve, 1_050));

  const issue = (res: LightMyRequestResponse): unknown => {
    problemSchemaFor('field_invalid').parse(res.json());
    return (json(res)['errors'] as unknown[])[0];
  };

  /** A person who signed in with a number on the play build, and the device they used. */
  async function signedUp(dev = device()): Promise<{ number: string; dev: ReturnType<typeof device>; publicUid: string; userId: string }> {
    const number = phone('ir');
    const res = await signInWithPhone(auth, number, dev);
    expect(res.statusCode, res.body).toBe(200);
    const { user_id: userId } = await row<{ user_id: string }>(db, `SELECT user_id::text FROM auth_identities WHERE provider = 1 AND subject_hash = $1`, [
      h.app.secrets.hasher.hash(hashDomains.phone, number).hash,
    ]);
    return { number, dev, userId, publicUid: h.app.publicIds.user.encode(userId) };
  }

  it('bans what a person signs in with: each kind a row tied to one kind-9 record, two statements, an audit row per ban', async () => {
    const person = await signedUp();
    await db.sql.query(`INSERT INTO auth_identities (id, user_id, provider, subject_hash) VALUES (id_next(), $1, 2, $2)`, [
      person.userId,
      h.app.secrets.hasher.hash(hashDomains.google, 'g-sub-1').hash,
    ]);
    const res = await as('moderator', '/v1/admin/device-bans', { from: 'user', user: person.publicUid, kinds: ['device', 'phone', 'google'], reason: 'Ban evasion ring' });
    expect(res.statusCode, res.body).toBe(201);
    expect(statements(res)).toBe(2);
    const { items } = adminDeviceBanListSchema.parse(res.json());
    expect(items.map((b) => [b.kind, b.store, b.expiresAt, b.active])).toEqual([
      ['device', 'play', null, true],
      ['phone', null, null, true],
      ['google', null, null, true],
    ]);
    expect(new Set(items.map((b) => b.actionId)).size).toBe(1);
    expect(items.every((b) => b.user?.id === person.publicUid && b.reason === 'Ban evasion ring')).toBe(true);
    expect(items[0]?.createdBy?.id).toBe(String(admins.get('moderator')!.account.id));
    const record = await row<{ kind: number; reason_code: number; reason_text: string; user_id: string }>(
      db,
      `SELECT kind, reason_code, reason_text, user_id::text FROM moderation_actions WHERE id = $1`,
      [items[0]!.actionId],
    );
    expect(record).toEqual({ kind: 9, reason_code: 99, reason_text: 'Ban evasion ring', user_id: person.userId });
    const audits = await auditRows(db, { action: 'device_ban.create', targetType: BAN_TARGET });
    expect(audits.map((a) => a.target_id).sort()).toEqual(items.map((b) => b.id).sort());
    expect(audits[0]?.detail).toMatchObject({ kind: 'device', store: 'play', expiresAt: null, renewed: false, user: person.publicUid, reason: 'Ban evasion ring' });
    expect(JSON.stringify(audits)).not.toContain(person.userId);
    expect(JSON.stringify(audits)).not.toContain(person.number);

    // The next sign-in with the number, or on the device with another number, is refused.
    await resendGap();
    const again = await signInWithPhone(auth, person.number, device());
    expect(again.statusCode).toBe(403);
    expect(again.json()).toMatchObject({ code: 'phone_banned' });
    const onDevice = await signInWithPhone(auth, phone('ir'), person.dev);
    expect(onDevice.statusCode).toBe(403);
    expect(onDevice.json()).toMatchObject({ code: 'device_banned' });
  });

  it('bans the kinds asked only, and refuses a person with nothing of those kinds or no account', async () => {
    const user: SeededUser = await seedUser(h, { name: 'Device Only' });
    const one = await as('admin', '/v1/admin/device-bans', { from: 'user', user: user.publicUid, kinds: ['device'], reason: 'Spam device' });
    expect(adminDeviceBanListSchema.parse(one.json()).items.map((b) => [b.kind, b.store])).toEqual([['device', 'bazaar']]);
    const actions = async () => (await row<{ n: number }>(db, `SELECT count(*)::integer AS n FROM moderation_actions WHERE user_id = $1`, [user.id])).n;
    const before = await actions();
    expect(issue(await as('admin', '/v1/admin/device-bans', { from: 'user', user: user.publicUid, kinds: ['phone', 'google'], reason: 'x' }))).toMatchObject({
      pointer: '/kinds',
      code: 'nothing_to_ban',
    });
    expect(await actions()).toBe(before);
    expect((await as('admin', '/v1/admin/device-bans', { from: 'user', user: 'aaaaaaaaaaaaa', kinds: ['phone'], reason: 'x' })).statusCode).toBe(404);
    const purged = await seedUser(h, { status: 8 });
    expect((await as('admin', '/v1/admin/device-bans', { from: 'user', user: purged.publicUid, kinds: ['device'], reason: 'x' })).statusCode).toBe(404);
    expect((await as('admin', '/v1/admin/device-bans', { from: 'user', user: user.publicUid, kinds: [], reason: 'x' })).statusCode).toBe(400);
    expect((await as('admin', '/v1/admin/device-bans', { from: 'user', user: user.publicUid, kinds: ['device'], reason: '' })).statusCode).toBe(400);
    expect((await as('support', '/v1/admin/device-bans', { from: 'user', user: user.publicUid, kinds: ['device'], reason: 'x' })).statusCode).toBe(403);
    expect((await as('analyst', '/v1/admin/device-bans', { from: 'user', user: user.publicUid, kinds: ['device'], reason: 'x' })).statusCode).toBe(403);
  });

  it('bans a typed number; a renewal keeps the longer expiry and a permanent ban stays permanent; removing it lets the number in', async () => {
    const number = phone('ir');
    const typed = `۰۰۹۸۹${number.slice(4).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]!)}`;
    const in30 = new Date(Date.now() + 30 * DAY).toISOString();
    const in60 = new Date(Date.now() + 60 * DAY).toISOString();
    const first = await as('admin', '/v1/admin/device-bans', { from: 'phone', phone: typed, expiresAt: in30, reason: 'Abuse reports' });
    expect(first.statusCode, first.body).toBe(201);
    expect(statements(first)).toBe(2);
    const [ban] = adminDeviceBanListSchema.parse(first.json()).items;
    expect(ban).toMatchObject({ kind: 'phone', store: null, expiresAt: in30, active: true, user: null, actionId: null });
    const refused = await signInWithPhone(auth, number);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'phone_banned' });

    const renew = async (expiresAt?: string) =>
      adminDeviceBanListSchema.parse((await as('admin', '/v1/admin/device-bans', { from: 'phone', phone: number, ...(expiresAt ? { expiresAt } : {}), reason: 'Renewed' })).json()).items[0]!;
    expect(await renew(in60)).toMatchObject({ id: ban!.id, expiresAt: in60 });
    expect(await renew(in30)).toMatchObject({ id: ban!.id, expiresAt: in60 });
    expect(await renew()).toMatchObject({ id: ban!.id, expiresAt: null });
    expect(await renew(in30)).toMatchObject({ id: ban!.id, expiresAt: null, reason: 'Renewed' });
    const renewals = await auditRows(db, { action: 'device_ban.create', targetType: BAN_TARGET, targetId: ban!.id });
    expect(renewals.map((a) => a.detail?.['renewed'])).toEqual([false, true, true, true, true]);
    expect(JSON.stringify(renewals)).not.toContain(number.slice(3));

    expect(issue(await as('admin', '/v1/admin/device-bans', { from: 'phone', phone: '12', reason: 'x' }))).toMatchObject({ pointer: '/phone', code: 'phone_invalid' });
    expect(issue(await as('admin', '/v1/admin/device-bans', { from: 'phone', phone: number, expiresAt: new Date(Date.now() - DAY).toISOString(), reason: 'x' }))).toMatchObject({
      pointer: '/expiresAt',
      code: 'ends_in_past',
    });

    expect((await as('admin', `/v1/admin/device-bans/${ban!.id}`, undefined, 'DELETE')).statusCode).toBe(400);
    const removed = await as('admin', `/v1/admin/device-bans/${ban!.id}`, { reason: 'Entered by mistake.' }, 'DELETE');
    expect(removed.statusCode).toBe(204);
    expect(statements(removed)).toBe(2);
    expect((await auditRows(db, { action: 'device_ban.delete', targetType: BAN_TARGET, targetId: ban!.id })).map((a) => a.detail)).toEqual([
      { before: { kind: 'phone', store: null, expiresAt: null, reason: 'Renewed' }, reason: 'Entered by mistake.' },
    ]);
    await resendGap();
    expect((await signInWithPhone(auth, number)).statusCode).toBe(200);
    expect((await as('admin', `/v1/admin/device-bans/${ban!.id}`, { reason: 'Again.' }, 'DELETE')).statusCode).toBe(404);
  });

  it('finds the bans of a number, in one statement, at most 30 lookups an hour per admin, and refuses when the limiter is down', async () => {
    const number = phone('ir');
    await as('admin', '/v1/admin/device-bans', { from: 'phone', phone: number, reason: 'Lookup' });
    const user = await seedUser(h, { name: 'Phone Holder' });
    await seedPhone(h, user.id, number);
    const found = await as('moderator', '/v1/admin/device-bans/search', { phone: ` ${number.replace('+98', '0098')} ` });
    expect(found.statusCode, found.body).toBe(200);
    expect(statements(found)).toBe(1);
    expect(found.headers['cache-control']).toBe('no-store');
    expect(adminDeviceBanListSchema.parse(found.json()).items.map((b) => [b.kind, b.reason])).toEqual([['phone', 'Lookup']]);
    expect(adminDeviceBanListSchema.parse((await as('moderator', '/v1/admin/device-bans/search', { phone: phone('ir') })).json()).items).toEqual([]);
    expect(issue(await as('moderator', '/v1/admin/device-bans/search', { phone: 'not a number' }))).toMatchObject({ pointer: '/phone', code: 'phone_invalid' });
    for (let i = 3; i < 30; i += 1) expect((await as('moderator', '/v1/admin/device-bans/search', { phone: number })).statusCode).toBe(200);
    const limited = await as('moderator', '/v1/admin/device-bans/search', { phone: number });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    // Another admin's hour is their own.
    expect((await as('admin', '/v1/admin/device-bans/search', { phone: number })).statusCode).toBe(200);
    vi.spyOn(h.app.limits, 'take').mockRejectedValueOnce(new Error('valkey down'));
    expect((await as('admin', '/v1/admin/device-bans/search', { phone: number })).statusCode).toBe(503);
    expect((await as('support', '/v1/admin/device-bans/search', { phone: number })).statusCode).toBe(403);
  });

  it('lists newest first, by kind, with a cursor, in one statement', async () => {
    const user = await seedUser(h, { name: 'Lister' });
    await seedPhone(h, user.id, phone('ir'));
    await as('admin', '/v1/admin/device-bans', { from: 'user', user: user.publicUid, kinds: ['device', 'phone'], reason: 'List me' });
    const all = await as('analyst', '/v1/admin/device-bans');
    expect(all.statusCode).toBe(403);
    const res = await as('moderator', '/v1/admin/device-bans?limit=1&kind=phone');
    expect(res.statusCode).toBe(200);
    expect(statements(res)).toBe(1);
    const page = adminDeviceBanPageSchema.parse(res.json());
    expect(page.items.map((b) => [b.kind, b.reason, b.user?.id])).toEqual([['phone', 'List me', user.publicUid]]);
    const next = adminDeviceBanPageSchema.parse((await as('moderator', `/v1/admin/device-bans?limit=100&kind=phone&cursor=${page.nextCursor}`)).json());
    expect(next.items.every((b) => b.kind === 'phone' && BigInt(b.id) < BigInt(page.items[0]!.id))).toBe(true);
    const devices = adminDeviceBanPageSchema.parse((await as('moderator', '/v1/admin/device-bans?kind=device&limit=100')).json());
    expect(devices.items.length).toBeGreaterThan(0);
    expect(devices.items.every((b) => b.kind === 'device' && b.store !== null)).toBe(true);
    const ids = adminDeviceBanPageSchema.parse((await as('moderator', '/v1/admin/device-bans?limit=100')).json()).items.map((b) => BigInt(b.id));
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)));
    expect((await as('moderator', '/v1/admin/device-bans?cursor=bm9wZQ')).statusCode).toBe(400);
  });

  it('rolls a ban and a removal back with a refused audit row', async () => {
    const user = await seedUser(h, { name: 'Refused Ban' });
    await refuseAudit(db, 'device_ban.create');
    expect((await as('admin', '/v1/admin/device-bans', { from: 'user', user: user.publicUid, kinds: ['device'], reason: 'x' })).statusCode).toBe(500);
    expect((await row<{ n: number }>(db, `SELECT count(*)::integer AS n FROM moderation_actions WHERE user_id = $1`, [user.id])).n).toBe(0);
    expect((await row<{ n: number }>(db, `SELECT count(*)::integer AS n FROM device_bans WHERE reason = 'x' AND kind = 1 AND store = 2 AND created_at > now() - interval '1 minute'`)).n).toBe(0);
    await refuseAudit(db);
    const ban = adminDeviceBanListSchema.parse((await as('admin', '/v1/admin/device-bans', { from: 'user', user: user.publicUid, kinds: ['device'], reason: 'kept' })).json()).items[0]!;
    await refuseAudit(db, 'device_ban.delete');
    expect((await as('admin', `/v1/admin/device-bans/${ban.id}`, { reason: 'Mistake.' }, 'DELETE')).statusCode).toBe(500);
    expect((await row<{ n: number }>(db, `SELECT count(*)::integer AS n FROM device_bans WHERE id = $1`, [ban.id])).n).toBe(1);
  });

  it('ties the bans to a standing ban (forAction): the banned person still reads why and appeals; a lift removes them', async () => {
    const person = await signedUp();
    await db.sql.query(`UPDATE users SET status = 3, birth_date = '1994-05-17', gender = 1 WHERE id = $1`, [person.userId]);
    const ban = await as('moderator', `/v1/admin/users/${person.publicUid}/ban`, { reason: 'harassment', reasonText: 'You harassed other members.' }, 'POST');
    expect(ban.statusCode, ban.body).toBe(200);
    const actionId = ban.json<{ action: { id: string } }>().action.id;
    // Only a standing suspension or ban of this person.
    const stranger = await seedUser(h, { name: 'Someone Else' });
    expect(issue(await as('moderator', '/v1/admin/device-bans', { from: 'user', user: stranger.publicUid, kinds: ['device'], reason: 'x', forAction: actionId }))).toMatchObject({
      pointer: '/forAction',
      code: 'unknown_action',
    });
    const res = await as('moderator', '/v1/admin/device-bans', { from: 'user', user: person.publicUid, kinds: ['device', 'phone', 'google'], reason: 'Harassment', forAction: actionId });
    expect(res.statusCode, res.body).toBe(201);
    const { items } = adminDeviceBanListSchema.parse(res.json());
    expect(items.map((b) => [b.kind, b.actionId])).toEqual([
      ['device', actionId],
      ['phone', actionId],
    ]);
    // No kind-9 record: the ban itself names them.
    expect((await row<{ n: number }>(db, `SELECT count(*)::integer AS n FROM moderation_actions WHERE user_id = $1 AND kind = 9`, [person.userId])).n).toBe(0);
    await as('moderator', `/v1/admin/users/${person.publicUid}/revoke-sessions`, {}, 'POST');

    // Signed out everywhere: the same number on the same device still reaches the restricted session (the reason, the appeal) ...
    await resendGap();
    const back = await signInWithPhone(auth, person.number, person.dev);
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json()).toMatchObject({ user: { id: person.publicUid, status: 'banned' } });
    // ... while a new account on that device, or from that number's device ban, is refused.
    const other = await signInWithPhone(auth, phone('ir'), person.dev);
    expect(other.statusCode).toBe(403);
    expect(other.json()).toMatchObject({ code: 'device_banned' });

    // Lifting the ban removes its device and phone bans, each with its row; the person and new accounts sign in again.
    const lift = await as('moderator', `/v1/admin/users/${person.publicUid}/lift`, { actionId }, 'POST');
    expect(lift.statusCode, lift.body).toBe(200);
    expect(lift.json()).toMatchObject({ user: { status: 'active' }, deviceBansRemoved: 2 });
    expect((await row<{ n: number }>(db, `SELECT count(*)::integer AS n FROM device_bans WHERE action_id = $1`, [actionId])).n).toBe(0);
    const removed = await auditRows(db, { action: 'device_ban.delete', targetType: BAN_TARGET });
    expect(removed.filter((a) => items.some((b) => b.id === a.target_id)).map((a) => a.detail?.['cause'])).toEqual(['lift', 'lift']);
    await resendGap();
    expect((await signInWithPhone(auth, person.number, person.dev)).json()).toMatchObject({ user: { status: 'active' } });
    expect((await signInWithPhone(auth, phone('ir'), person.dev)).statusCode).toBe(200);
  });

  it('removes only with a reason, and the automatic under-age bans only for the owner', async () => {
    const number = phone('ir');
    const hash = h.app.secrets.hasher.hash(hashDomains.phone, number).hash;
    const { id } = await row<{ id: string }>(
      db,
      `INSERT INTO device_bans (id, expires_at, kind, value_hash, reason) VALUES (id_next(), now() + interval '365 days', 2, $1, 'Under 18') RETURNING id::text`,
      [hash],
    );
    expect((await as('admin', `/v1/admin/device-bans/${id}`, { reason: '' }, 'DELETE')).statusCode).toBe(400);
    const refused = await as('admin', `/v1/admin/device-bans/${id}`, { reason: 'They are 18 now.' }, 'DELETE');
    expect(refused.statusCode).toBe(403);
    expect((await row<{ n: number }>(db, `SELECT count(*)::integer AS n FROM device_bans WHERE id = $1`, [id])).n).toBe(1);
    const owner = await adminAs(h, 'superadmin');
    const removed = await admin(h, `/v1/admin/device-bans/${id}`, { reason: 'They are 18 now.' }, { token: owner.accessToken, method: 'DELETE' });
    expect(removed.statusCode, removed.body).toBe(204);
    expect((await auditRows(db, { action: 'device_ban.delete', targetType: BAN_TARGET, targetId: id })).map((a) => a.detail?.['reason'])).toEqual(['They are 18 now.']);
  });

  it('bans a number or a device the server already refuses in a row of its own: the automatic ban keeps its author and stays the owner\'s to remove', async () => {
    const person = await signedUp();
    const number = phone('ir');
    const hasher = h.app.secrets.hasher;
    const automatic = async (kind: number, store: number | null, hash: Buffer) =>
      (
        await row<{ id: string }>(
          db,
          `INSERT INTO device_bans (id, expires_at, kind, store, value_hash, reason) VALUES (id_next(), now() + interval '365 days', $1, $2, $3, 'Under 18') RETURNING id::text`,
          [kind, store, hash],
        )
      ).id;
    const autoPhone = await automatic(2, null, hasher.hash(hashDomains.phone, number).hash);
    const autoDevice = await automatic(1, 1, hasher.hash(hashDomains.device, person.dev.deviceKey).hash);
    const moderator = String(admins.get('moderator')!.account.id);

    const typed = await as('moderator', '/v1/admin/device-bans', { from: 'phone', phone: number, reason: 'Abuse reports' });
    expect(typed.statusCode, typed.body).toBe(201);
    const fromUser = await as('moderator', '/v1/admin/device-bans', { from: 'user', user: person.publicUid, kinds: ['device'], reason: 'Same phone' });
    expect(fromUser.statusCode, fromUser.body).toBe(201);
    const [phoneBan] = adminDeviceBanListSchema.parse(typed.json()).items;
    const [deviceBan] = adminDeviceBanListSchema.parse(fromUser.json()).items;
    expect(phoneBan).toMatchObject({ kind: 'phone', expiresAt: null, reason: 'Abuse reports', createdBy: { id: moderator }, actionId: null });
    expect(deviceBan).toMatchObject({ kind: 'device', store: 'play', reason: 'Same phone', createdBy: { id: moderator }, user: { id: person.publicUid } });
    expect([phoneBan!.id, deviceBan!.id]).not.toContain(autoPhone);
    expect([phoneBan!.id, deviceBan!.id]).not.toContain(autoDevice);
    const created = await auditRows(db, { action: 'device_ban.create', targetType: BAN_TARGET });
    expect(created.filter((a) => a.target_id === phoneBan!.id || a.target_id === deviceBan!.id).map((a) => a.detail?.['renewed'])).toEqual([false, false]);
    // The server's own rows are as they were: no author, no record, their reason and their year.
    const own = await rows<{ id: string; created_by: number | null; action_id: string | null; reason: string; year: boolean }>(
      db,
      `SELECT id::text, created_by, action_id::text, reason, expires_at BETWEEN now() + interval '364 days' AND now() + interval '366 days' AS year
         FROM device_bans WHERE id = ANY($1::bigint[]) ORDER BY kind`,
      [[autoDevice, autoPhone]],
    );
    expect(own).toEqual([
      { id: autoDevice, created_by: null, action_id: null, reason: 'Under 18', year: true },
      { id: autoPhone, created_by: null, action_id: null, reason: 'Under 18', year: true },
    ]);

    // Still automatic: the moderator cannot remove them, only their own rows.
    for (const id of [autoPhone, autoDevice]) {
      expect((await as('moderator', `/v1/admin/device-bans/${id}`, { reason: 'Banned it myself.' }, 'DELETE')).statusCode).toBe(403);
    }
    for (const id of [phoneBan!.id, deviceBan!.id]) {
      expect((await as('moderator', `/v1/admin/device-bans/${id}`, { reason: 'Not needed.' }, 'DELETE')).statusCode).toBe(204);
    }
    expect((await rows(db, `SELECT 1 FROM device_bans WHERE id = ANY($1::bigint[])`, [[autoPhone, autoDevice]])).length).toBe(2);
    // The number is still refused by the server's own ban.
    const refused = await signInWithPhone(auth, number);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'phone_banned' });
  });

  it('keeps the bans of two records on one device apart: lifting either leaves the other\'s, and a typed number stays until it is removed', async () => {
    const dev = device();
    const first = await signedUp(dev);
    const second = await signedUp(dev);
    const banOf = async (person: { userId: string; publicUid: string }) => {
      await db.sql.query(`UPDATE users SET status = 3, birth_date = '1994-05-17', gender = 1 WHERE id = $1`, [person.userId]);
      const res = await as('moderator', `/v1/admin/users/${person.publicUid}/ban`, { reason: 'harassment', reasonText: 'You harassed other members.' }, 'POST');
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ action: { id: string } }>().action.id;
    };
    const [actionA, actionB] = [await banOf(first), await banOf(second)];
    const ban = async (role: string, body: Record<string, unknown>) => {
      const res = await as(role, '/v1/admin/device-bans', body);
      expect(res.statusCode, res.body).toBe(201);
      return adminDeviceBanListSchema.parse(res.json()).items;
    };
    const renewedOf = async (id: string) => (await auditRows(db, { action: 'device_ban.create', targetType: BAN_TARGET, targetId: id })).map((a) => a.detail?.['renewed']);

    const [deviceA, phoneA] = await ban('moderator', { from: 'user', user: first.publicUid, kinds: ['device', 'phone'], reason: 'First', forAction: actionA });
    const [deviceB] = await ban('moderator', { from: 'user', user: second.publicUid, kinds: ['device'], reason: 'Second', forAction: actionB });
    expect(deviceB).toMatchObject({ kind: 'device', actionId: actionB, user: { id: second.publicUid }, reason: 'Second' });
    expect(deviceB!.id).not.toBe(deviceA!.id);
    expect(await renewedOf(deviceB!.id)).toEqual([false]);
    // The same record again renews its own row.
    const [again] = await ban('admin', { from: 'user', user: first.publicUid, kinds: ['device'], reason: 'First again', forAction: actionA });
    expect(again).toMatchObject({ id: deviceA!.id, actionId: actionA, reason: 'First again', createdBy: { id: String(admins.get('admin')!.account.id) } });
    expect(await renewedOf(deviceA!.id)).toEqual([false, true]);
    // A typed number of the first person: a row of its own; the record's row keeps its record.
    const [typed] = await ban('admin', { from: 'phone', phone: first.number, reason: 'Typed' });
    expect(typed).toMatchObject({ kind: 'phone', actionId: null, user: null });
    expect(typed!.id).not.toBe(phoneA!.id);
    const recordOf = async (id: string) => (await row<{ a: string | null }>(db, `SELECT action_id::text AS a FROM device_bans WHERE id = $1`, [id])).a;
    expect([await recordOf(deviceA!.id), await recordOf(phoneA!.id), await recordOf(deviceB!.id)]).toEqual([actionA, actionA, actionB]);

    // Lifting the second's ban removes its row only: the device stays banned for the first's.
    const liftB = await as('moderator', `/v1/admin/users/${second.publicUid}/lift`, { actionId: actionB }, 'POST');
    expect(liftB.statusCode, liftB.body).toBe(200);
    expect(liftB.json()).toMatchObject({ user: { status: 'active' }, deviceBansRemoved: 1 });
    expect(await rows(db, `SELECT 1 FROM device_bans WHERE id = $1`, [deviceB!.id])).toEqual([]);
    expect(await recordOf(deviceA!.id)).toBe(actionA);
    const stillBanned = await signInWithPhone(auth, phone('ir'), dev);
    expect(stillBanned.statusCode).toBe(403);
    expect(stillBanned.json()).toMatchObject({ code: 'device_banned' });

    // Lifting the first's removes its two rows: the device is free; the typed number is its own cause and stays.
    const liftA = await as('moderator', `/v1/admin/users/${first.publicUid}/lift`, { actionId: actionA }, 'POST');
    expect(liftA.statusCode, liftA.body).toBe(200);
    expect(liftA.json()).toMatchObject({ user: { status: 'active' }, deviceBansRemoved: 2 });
    expect((await signInWithPhone(auth, phone('ir'), dev)).statusCode).toBe(200);
    await resendGap();
    const typedHolds = await signInWithPhone(auth, first.number, dev);
    expect(typedHolds.statusCode).toBe(403);
    expect(typedHolds.json()).toMatchObject({ code: 'phone_banned' });
    expect((await as('admin', `/v1/admin/device-bans/${typed!.id}`, { reason: 'Lifted with the ban.' }, 'DELETE')).statusCode).toBe(204);
    await resendGap();
    expect((await signInWithPhone(auth, first.number, dev)).json()).toMatchObject({ user: { id: first.publicUid, status: 'active' } });
  });
});
