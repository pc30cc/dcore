import {
  adminActionPageSchema,
  adminActionResultSchema,
  adminAppealDecisionSchema,
  adminAppealPageSchema,
  adminPhotoDecisionSchema,
  adminUserDetailSchema,
  conversationsPageSchema,
  deckPageSchema,
  likesPageSchema,
  meSchema,
  moderationHistorySchema,
  realtimePayloads,
  swipesResponseSchema,
  userChannel,
} from '@app/shared';
import { CdnUrlSigner, FakeObjectStorage, FakeRealtimePublisher, cellCentre, homeCell, writeDeck, type MediaStore } from '@app/shared/server';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, json, migratedDatabase, row, seedUser, type SeededUser, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, auditRows, startAdminHarness, type AdminHarness } from './adminSupport.js';
import { refreshTokenFor, seedPhoto } from './moderationSupport.js';
import { authApp, device, phone, settingsWith, signInWithPhone, type AuthHarness } from './authSupport.js';
import { hasInfrastructure, testSecret } from './support.js';

/**
 * W7 acceptance criterion 3, end to end on one API, PostgreSQL and Valkey:
 * what an admin's moderation does in the app.
 *
 * 1. A photo rejected in the queue: the person's app hears it with the
 *    reason in their language, their own view shows it (a new answer, not
 *    the cached one), the card is rebuilt; the record and the audit row are
 *    there; an approval is heard the same way.
 * 2. A ban, an appeal and its overturn: the banned person's tokens stop at
 *    once and their socket closes, they hear the ban with the message, the
 *    peer's conversation ends; their refresh gives a restricted session that
 *    shows the ban and takes an appeal; the admin finds the appeal with the
 *    action and history and overturns it: the person hears the decision,
 *    the restricted session ends and the refresh gives a full one; the
 *    conversation the ban ended stays ended.
 * 4. A ban with the "also ban phone, devices and Google account" box: the
 *    person, signed out everywhere, still signs in on their own phone and
 *    device to a restricted session that shows the ban and takes an appeal,
 *    while a new account there is refused; the overturn removes those bans,
 *    and both sign in again.
 * 3. A shadowban through the panel: the people around the person stop
 *    seeing them on their next request (the matched peer's list and profile
 *    read, the deck and the likes of someone who could see them), while the
 *    person notices nothing at all: their own view is byte for byte the
 *    same, no event reaches them, their refresh gives a full session, their
 *    own lists work, and no answer they get says "shadow". The admin sees it.
 */

const CDN_KEY = 'w7-acceptance-cdn-signing-key-0123456';
const CELL = homeCell({ lat: 41.03, lng: 28.98 });
const NEAR = homeCell({ lat: 41.05, lng: 29.02 });

type Person = SeededUser & { version: number };

describe.skipIf(!hasInfrastructure)('W7 acceptance (admin moderation in the app)', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  const realtime = new FakeRealtimePublisher();
  const media: MediaStore = {
    storage: new FakeObjectStorage(),
    privateBucket: 'uploads',
    mediaBucket: 'media',
    urls: new CdnUrlSigner({ baseUrl: 'https://cdn.test.invalid', signingKey: CDN_KEY, scheme: 'hmac' }),
  };
  let moderator: string;
  let auth: AuthHarness;
  // Sign-in is a second app on the same database with the same peppers (the bans are keyed hashes).
  const shared = { HASH_PEPPERS: JSON.stringify({ 1: testSecret() }), ID_PUBLIC_KEY: testSecret() };

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startAdminHarness(db, shared, { jobs: new MemoryJobProducer(), realtime, media });
    auth = await authApp(db, { env: shared, settings: settingsWith({ caps: { resend_seconds: 1, phone_daily: 100, ip_hourly: 100, install_daily: 100 } }) });
    await h.redis.set(h.app.keys.likesReady(), '1');
    moderator = (await adminAs(h, 'moderator')).accessToken;
  }, 120_000);

  afterAll(async () => {
    await auth?.close();
    await h?.close();
    await db?.drop();
  });

  /** An active person in discovery: a profile, preferences, a location and two approved photos. */
  async function person(name: string, options: { gender?: number; interestedIn?: number; cell?: string } = {}): Promise<Person> {
    const user = await seedUser(h, { name, gender: options.gender ?? 1, interestedIn: options.interestedIn ?? 4, country: 'TR' });
    const centre = cellCentre(options.cell ?? NEAR);
    await db.sql.query(`UPDATE profiles SET text_state = 2, about = 'Hello' WHERE user_id = $1`, [user.id]);
    await db.sql.query(
      `INSERT INTO user_locations (user_id, home_h3, source, country, home_geo) VALUES ($1, $2, 1, 'TR', ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography)`,
      [user.id, options.cell ?? NEAR, centre.lng, centre.lat],
    );
    for (let position = 0; position < 2; position += 1) {
      await db.sql.query(
        `INSERT INTO photos (id, user_id, position, status, width, height, blurhash, blob_ver) VALUES ($1, $2, $3, 3, 1080, 1350, 'L6PZfSi_.AyE', 1)`,
        [h.app.ids.nextId(), user.id, position],
      );
    }
    const { version } = await row<{ version: number }>(db, `SELECT version FROM profiles WHERE user_id = $1`, [user.id]);
    return { ...user, version };
  }

  const viewer = (name: string) => person(name, { gender: 2, interestedIn: 2, cell: CELL });

  async function swipe(user: SeededUser, target: SeededUser, action: 'like' | 'superlike') {
    const response = await call(h, '/v1/swipes', { method: 'POST', token: user.token, body: { swipes: [{ target: target.publicUid, action }] } });
    expect(response.statusCode, response.body).toBe(200);
    return swipesResponseSchema.parse(response.json()).results[0]!;
  }

  async function peers(user: SeededUser, etag?: string): Promise<{ status: number; ids: string[]; etag: string; body: string }> {
    const response = await call(h, '/v1/conversations', { token: user.token, ...(etag ? { headers: { 'if-none-match': etag } } : {}) });
    const ids = response.statusCode === 200 ? conversationsPageSchema.parse(response.json()).items.map((c) => c.peer.id) : [];
    return { status: response.statusCode, ids, etag: String(response.headers['etag']), body: response.body };
  }

  const deckIds = async (user: SeededUser) => deckPageSchema.parse((await call(h, '/v1/deck?limit=20', { token: user.token })).json()).cards.map((c) => c.id);
  const likers = async (user: SeededUser) => likesPageSchema.parse((await call(h, '/v1/likes', { token: user.token })).json()).items.flatMap((i) => (i.liker ? [i.liker.id] : []));

  it('1. a photo rejected with a reason: the person hears it in their language and sees it in their profile', async () => {
    const a = await person('Photo Owner');
    await db.sql.query(`UPDATE users SET locale = 'fa' WHERE id = $1`, [a.id]);
    const waiting = await seedPhoto(h, a.id, { position: 2, status: 2 });
    const other = await seedPhoto(h, a.id, { position: 3, status: 2 });
    // The app asks in the person's language (its Accept-Language).
    const fa = { 'accept-language': 'fa' };
    const before = await call(h, '/v1/me', { token: a.token, headers: fa });
    expect(before.statusCode).toBe(200);
    await h.redis.zrem(h.app.keys.profilesChanged(), a.id);

    const res = await admin(h, `/v1/admin/moderation/photos/${waiting}/reject`, { reason: 'nudity' }, { token: moderator, method: 'POST' });
    expect(res.statusCode, res.body).toBe(200);
    expect(adminPhotoDecisionSchema.parse(res.json())).toEqual({ photo: { id: waiting, status: 'rejected', rejectReason: 'nudity' }, sideEffects: 'done' });
    const text = 'برهنگی یا محتوای جنسی مجاز نیست.';
    const heard = realtime.on(userChannel(a.publicUid)).filter((e) => e.t === 'profile');
    expect(realtimePayloads.profile.parse(heard.at(-1)?.d)).toEqual({ photo: { id: waiting, status: 'rejected', rejectReason: text } });
    const after = await call(h, '/v1/me', { token: a.token, headers: { ...fa, 'if-none-match': String(before.headers['etag']) } });
    expect(after.statusCode).toBe(200);
    expect(meSchema.parse(after.json()).profile?.photos.find((p) => p.id === waiting)).toMatchObject({ status: 'rejected', rejectReason: text });
    expect(await h.redis.zscore(h.app.keys.profilesChanged(), a.id)).not.toBeNull();
    expect(await row<{ kind: number; reason_code: number }>(db, `SELECT kind, reason_code FROM moderation_actions WHERE user_id = $1`, [a.id])).toEqual({ kind: 6, reason_code: 2 });
    expect(await auditRows(db, { action: 'photo.reject', targetType: 1, targetId: a.id })).toHaveLength(1);

    const approved = await admin(h, `/v1/admin/moderation/photos/${other}/approve`, {}, { token: moderator, method: 'POST' });
    expect(approved.statusCode).toBe(200);
    const last = realtime.on(userChannel(a.publicUid)).filter((e) => e.t === 'profile').at(-1);
    expect(realtimePayloads.profile.parse(last?.d)).toEqual({ photo: { id: other, status: 'approved' } });
  });

  it('2. a ban: the person is out at once and restricted with the reason; their appeal is overturned and they are back', async () => {
    const a = await person('Banned Person');
    const b = await viewer('Their Match');
    await swipe(b, a, 'like');
    expect((await swipe(a, b, 'like')).result).toBe('matched');
    const conversation = (await peers(a)).ids;
    expect(conversation).toEqual([b.publicUid]);
    const refreshToken = await refreshTokenFor(h, a);

    const ban = await admin(h, `/v1/admin/users/${a.publicUid}/ban`, { reason: 'harassment', reasonText: 'You harassed other members.' }, { token: moderator, method: 'POST' });
    expect(ban.statusCode, ban.body).toBe(200);
    const banned = adminActionResultSchema.parse(ban.json());
    expect((await call(h, '/v1/me', { token: a.token })).statusCode).toBe(401);
    expect(realtime.disconnected).toContain(a.publicUid);
    const told = realtime.on(userChannel(a.publicUid)).filter((e) => e.t === 'account').at(-1);
    expect(realtimePayloads.account.parse(told?.d)).toMatchObject({ status: 'banned', moderation: { kind: 'ban', reasonText: 'You harassed other members.' } });
    expect(realtime.on(userChannel(b.publicUid)).some((e) => e.t === 'conversation_end')).toBe(true);

    // Tokens issued in the second of the revocation count as before it.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const refused = await call(h, '/v1/auth/refresh', { method: 'POST', body: { refreshToken } });
    expect(refused.statusCode, refused.body).toBe(403);
    const problem = json(refused);
    expect(problem).toMatchObject({ code: 'account_banned', reasonText: 'You harassed other members.', actionId: banned.action.id, appealable: true });
    const restricted = String(problem['accessToken']);
    const history = moderationHistorySchema.parse((await call(h, '/v1/me/moderation', { token: restricted })).json());
    expect(history.active.map((x) => [x.kind, x.reasonText])).toEqual([['ban', 'You harassed other members.']]);
    expect((await call(h, '/v1/deck?limit=20', { token: restricted })).statusCode).toBe(403);
    const filed = await call(h, '/v1/appeals', { method: 'POST', token: restricted, body: { actionId: banned.action.id, body: 'I did not do this.' } });
    expect(filed.statusCode, filed.body).toBe(201);

    const queue = adminAppealPageSchema.parse((await admin(h, '/v1/admin/appeals', undefined, { token: moderator })).json());
    const appeal = queue.items.find((x) => x.user.id === a.publicUid);
    expect(appeal).toMatchObject({ status: 'open', body: 'I did not do this.', action: { id: banned.action.id, kind: 'ban', reasonText: 'You harassed other members.' } });
    const overturn = await admin(h, `/v1/admin/appeals/${appeal!.id}/overturn`, { text: 'We looked again: you were right.' }, { token: moderator, method: 'POST' });
    expect(overturn.statusCode, overturn.body).toBe(200);
    expect(adminAppealDecisionSchema.parse(overturn.json())).toMatchObject({ appeal: { status: 'overturned', user: { status: 'active' } }, sideEffects: 'done' });
    const back = realtime.on(userChannel(a.publicUid)).filter((e) => e.t === 'account').at(-1);
    expect(realtimePayloads.account.parse(back?.d)).toMatchObject({ status: 'active', moderation: { appeal: { status: 'overturned', decisionText: 'We looked again: you were right.' } } });

    // The restricted session's scope is older than the account now: a full route refuses it and the app refreshes.
    expect((await call(h, '/v1/deck?limit=20', { token: restricted })).statusCode).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const full = await call(h, '/v1/auth/refresh', { method: 'POST', body: { refreshToken: String(problem['refreshToken']) } });
    expect(full.statusCode, full.body).toBe(200);
    const fresh = full.json<{ accessToken: string }>().accessToken;
    expect((await call(h, '/v1/me', { token: fresh })).statusCode).toBe(200);
    // The conversation the ban ended stays ended.
    expect((await peers({ ...a, token: fresh })).ids).toEqual([]);
  });

  it('4. a ban that also bans the phone and device: the person still reads why and appeals; the overturn lets them back', async () => {
    const number = phone('ir');
    const dev = device();
    const first = await signInWithPhone(auth, number, dev);
    expect(first.statusCode, first.body).toBe(200);
    const publicUid = first.json<{ user: { id: string } }>().user.id;
    const userId = h.app.publicIds.user.decodeId(publicUid)!;
    await db.sql.query(`UPDATE users SET status = 3, birth_date = '1994-05-17', gender = 1 WHERE id = $1`, [userId]);

    // The panel's ban dialog with "also ban": the ban, then its device and phone bans for it.
    const ban = await admin(h, `/v1/admin/users/${publicUid}/ban`, { reason: 'harassment', reasonText: 'You harassed other members.' }, { token: moderator, method: 'POST' });
    expect(ban.statusCode, ban.body).toBe(200);
    const actionId = adminActionResultSchema.parse(ban.json()).action.id;
    const also = await admin(h, '/v1/admin/device-bans', { from: 'user', user: publicUid, kinds: ['device', 'phone', 'google'], reason: 'Harassment', forAction: actionId }, { token: moderator, method: 'POST' });
    expect(also.statusCode, also.body).toBe(201);
    expect((await admin(h, `/v1/admin/users/${publicUid}/revoke-sessions`, {}, { token: moderator, method: 'POST' })).statusCode).toBe(200);

    // Signed out everywhere, they sign in with the same number on the same phone: restricted, with the reason and the appeal.
    const gap = () => new Promise((resolve) => setTimeout(resolve, 1_050));
    await gap();
    const back = await signInWithPhone(auth, number, dev);
    expect(back.statusCode, back.body).toBe(200);
    const restricted = back.json<{ accessToken: string; user: { status: string } }>();
    expect(restricted.user.status).toBe('banned');
    // The session is the sign-in app's (its own token keys): the app reads the ban and appeals there.
    const own = (url: string, body?: Record<string, unknown>): Promise<LightMyRequestResponse> =>
      auth.app.inject({ method: body ? 'POST' : 'GET', url, ...(body ? { payload: body } : {}), headers: { 'x-client': 'play/120', authorization: `Bearer ${restricted.accessToken}` } });
    const history = moderationHistorySchema.parse((await own('/v1/me/moderation')).json());
    expect(history.active.map((x) => [x.kind, x.reasonText])).toEqual([['ban', 'You harassed other members.']]);
    const filed = await own('/v1/appeals', { actionId, body: 'It was not me.' });
    expect(filed.statusCode, filed.body).toBe(201);
    // A new account on that phone is refused.
    const newcomer = await signInWithPhone(auth, phone('ir'), dev);
    expect(newcomer.statusCode).toBe(403);
    expect(newcomer.json()).toMatchObject({ code: 'device_banned' });

    // The overturn lifts the ban and removes its device and phone bans; both sign in again.
    const queue = adminAppealPageSchema.parse((await admin(h, '/v1/admin/appeals', undefined, { token: moderator })).json());
    const appeal = queue.items.find((x) => x.action.id === actionId)!;
    const overturn = await admin(h, `/v1/admin/appeals/${appeal.id}/overturn`, { text: 'We looked again.' }, { token: moderator, method: 'POST' });
    expect(overturn.statusCode, overturn.body).toBe(200);
    expect(adminAppealDecisionSchema.parse(overturn.json())).toMatchObject({ appeal: { status: 'overturned', user: { status: 'active' } }, deviceBansRemoved: 2 });
    expect(await row<{ n: number }>(db, `SELECT count(*)::integer AS n FROM device_bans WHERE action_id = $1`, [actionId])).toEqual({ n: 0 });
    expect((await auditRows(db, { action: 'device_ban.delete', targetType: 18 })).map((a) => a.detail?.['cause'])).toEqual(['appeal', 'appeal']);
    await gap();
    const full = await signInWithPhone(auth, number, dev);
    expect(full.statusCode, full.body).toBe(200);
    expect(full.json()).toMatchObject({ user: { id: publicUid, status: 'active' } });
    expect((await signInWithPhone(auth, phone('ir'), dev)).statusCode).toBe(200);
  });

  it('3. a shadowban: the others stop seeing the person, who notices nothing; the admin sees it', async () => {
    const a = await person('Ayla');
    const b = await viewer('Matched peer');
    const c = await viewer('Could see them');
    // C has A queued in the deck and among the likers (a super like is always shown open).
    await writeDeck(h.app.cache, h.app.keys, c.id, { kept: [], front: [], back: [{ userId: a.id, version: a.version, km: 3, flags: 0 }], builtAt: Date.now() - 5_000, cursor: null, exhaustedAt: null });
    expect((await swipe(a, c, 'superlike')).result).toBe('liked');
    await swipe(b, a, 'like');
    expect((await swipe(a, b, 'like')).result).toBe('matched');
    expect(await deckIds(c)).toEqual([a.publicUid]);
    expect(await likers(c)).toEqual([a.publicUid]);
    const listOfB = await peers(b);
    expect(listOfB.ids).toEqual([a.publicUid]);
    expect((await peers(b, listOfB.etag)).status).toBe(304);
    expect((await call(h, `/v1/profiles/${a.publicUid}`, { token: b.token })).statusCode).toBe(200);

    // What A sees before.
    const meBefore = await call(h, '/v1/me', { token: a.token });
    const moderationBefore = await call(h, '/v1/me/moderation', { token: a.token });
    const ownList = await peers(a);
    expect(ownList.ids).toEqual([b.publicUid]);
    const heardBefore = realtime.on(userChannel(a.publicUid)).length;

    const shadowban = await admin(h, `/v1/admin/users/${a.publicUid}/shadowban`, { reason: 'spam', note: 'reported by several members' }, { token: moderator, method: 'POST' });
    expect(shadowban.statusCode, shadowban.body).toBe(200);
    const result = adminActionResultSchema.parse(shadowban.json());
    expect(result.sideEffects).toBe('done');

    // The others: B's list no longer has A (a new answer, not 304), A's profile is gone for B; C's deck and likes leave A out.
    const after = await peers(b, listOfB.etag);
    expect(after.status).toBe(200);
    expect(after.ids).toEqual([]);
    expect((await call(h, `/v1/profiles/${a.publicUid}`, { token: b.token })).statusCode).toBe(404);
    expect(await deckIds(c)).toEqual([]);
    expect(await likers(c)).toEqual([]);

    // A: the same view (same ETag, same bytes), the same history, no event, a full session on refresh, the own lists as before.
    const meAfter = await call(h, '/v1/me', { token: a.token, headers: { 'if-none-match': String(meBefore.headers['etag']) } });
    expect(meAfter.statusCode).toBe(304);
    const meAgain = await call(h, '/v1/me', { token: a.token });
    expect(meAgain.body).toBe(meBefore.body);
    expect(meAgain.headers['etag']).toBe(meBefore.headers['etag']);
    const moderationAfter = await call(h, '/v1/me/moderation', { token: a.token });
    expect(moderationAfter.body).toBe(moderationBefore.body);
    expect(realtime.on(userChannel(a.publicUid)).length).toBe(heardBefore);
    const refreshed = await call(h, '/v1/auth/refresh', { method: 'POST', body: { refreshToken: await refreshTokenFor(h, a) } });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    const fresh = refreshed.json<{ accessToken: string }>().accessToken;
    const ownAfter = await peers({ ...a, token: fresh });
    expect(ownAfter.ids).toEqual([b.publicUid]);
    const answers: LightMyRequestResponse[] = [meAfter, meAgain, moderationAfter, refreshed];
    answers.push(await call(h, '/v1/deck?limit=20', { token: fresh }), await call(h, '/v1/likes', { token: fresh }));
    for (const answer of [...answers.map((r) => r.body), ownAfter.body]) expect(answer.toLowerCase()).not.toContain('shadow');

    // The admin sees it, and the record.
    const page = await admin(h, `/v1/admin/users/${a.publicUid}`, undefined, { token: moderator });
    expect(adminUserDetailSchema.parse(page.json())).toMatchObject({ shadowbanned: true, status: 'active', standing: [{ kind: 'shadowban', reason: 'spam' }] });
    const records = adminActionPageSchema.parse((await admin(h, `/v1/admin/users/${a.publicUid}/moderation`, undefined, { token: moderator })).json());
    expect(records.items.map((r) => [r.kind, r.note])).toEqual([['shadowban', 'reported by several members']]);
  });
});
