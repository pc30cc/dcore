import {
  adminActionResultSchema,
  adminDeleteUserResultSchema,
  adminRevealPhoneSchema,
  adminRevokeSessionsResultSchema,
  adminTextDecisionSchema,
  adminUserChangeSchema,
  meSchema,
  moderationHistorySchema,
  problemSchemaFor,
  realtimePayloads,
  userChannel,
  type RealtimeEnvelope,
} from '@app/shared';
import { CdnUrlSigner, FakeObjectStorage, FakeRealtimePublisher, IdGeneratorUnavailableError, accountJobNames, type MediaStore } from '@app/shared/server';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, json, migratedDatabase, row, rows, seedUser, statements, type SeededUser, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, auditRows, installAuditFailure, refuseAudit, startAdminHarness, type AdminHarness, type AuditRowView } from './adminSupport.js';
import { profileVersion, refreshTokenFor, reloadConfig, seedPhone, seedPrompts, seedReport, seedTexts } from './moderationSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * The admin panel's writes on a person, on PostgreSQL and Valkey: every
 * route's audit row in the same transaction (a refused row leaves the
 * database exactly as before and sends nothing), the exact statement
 * counts, the errors each route lists, and what the person sees: the
 * reason of a warning, suspension or ban in their app with an appeal, a
 * restricted session on refresh, never a word of a shadowban; a sign-out
 * everywhere; a deletion they can restore; the text reasons in their
 * language. The after-commit side can fail without undoing the write.
 */

const PHONE = '+989129876543';
/** A public address (private ones are not recorded as a client address). */
const ADMIN_IP = '93.184.216.34';
const DAY = 86_400_000;
const USER_TARGET = 1;

describe.skipIf(!hasInfrastructure)('admin: actions on people', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  const realtime = new FakeRealtimePublisher();
  const jobs = new MemoryJobProducer();
  const media: MediaStore = {
    storage: new FakeObjectStorage(),
    privateBucket: 'uploads',
    mediaBucket: 'media',
    urls: new CdnUrlSigner({ baseUrl: 'https://cdn.test.invalid', signingKey: 'admin-actions-cdn-signing-key-0123456', scheme: 'hmac' }),
  };
  const tokens = new Map<string, string>();
  const sessions = new Map<string, string>();
  const rawIds: string[] = [];
  const bodies: string[] = [];

  beforeAll(async () => {
    db = await migratedDatabase();
    await installAuditFailure(db);
    h = await startAdminHarness(db, {}, { jobs, realtime, media });
    for (const role of ['superadmin', 'admin', 'moderator', 'support', 'finance', 'analyst']) {
      const signed = await adminAs(h, role);
      tokens.set(role, signed.accessToken);
      sessions.set(role, signed.sessionId);
    }
  }, 120_000);

  afterAll(async () => {
    for (const id of rawIds) for (const body of bodies) expect(body.includes(id), `raw id ${id} in a response`).toBe(false);
    await h?.close();
    await db?.drop();
  });

  beforeEach(async () => {
    jobs.jobs.length = 0;
    realtime.failWith = null;
    await refuseAudit(db);
    vi.restoreAllMocks();
  });

  async function person(name: string, options: { status?: number; locale?: string } = {}): Promise<SeededUser> {
    const user = await seedUser(h, { name, ...(options.status ? { status: options.status } : {}) });
    rawIds.push(user.id);
    if (options.locale) await db.sql.query(`UPDATE users SET locale = $2 WHERE id = $1`, [user.id, options.locale]);
    return user;
  }

  async function send(method: 'POST' | 'PATCH', url: string, body: unknown, role = 'admin'): Promise<LightMyRequestResponse> {
    const response = await admin(h, url, body, { token: tokens.get(role)!, method, ip: ADMIN_IP });
    bodies.push(response.body);
    return response;
  }

  function events(user: SeededUser, type?: RealtimeEnvelope['t']): RealtimeEnvelope[] {
    return realtime.on(userChannel(user.publicUid)).filter((e) => type === undefined || e.t === type);
  }

  async function snapshot(userId: string): Promise<unknown> {
    return row(
      db,
      `SELECT u.status, u.is_shadowbanned, u.flags, u.deleted_at,
              (SELECT jsonb_agg(m.* ORDER BY m.id) FROM moderation_actions m WHERE m.user_id = u.id) AS actions,
              (SELECT jsonb_agg(jsonb_build_object('id', s.id, 'revoked', s.revoked_at) ORDER BY s.id) FROM sessions s WHERE s.user_id = u.id) AS sessions,
              (SELECT jsonb_build_object('name', p.display_name, 'state', p.text_state, 'version', p.version) FROM profiles p WHERE p.user_id = u.id) AS profile,
              (SELECT jsonb_agg(jsonb_build_object('pos', pp.position, 'status', pp.status) ORDER BY pp.position) FROM profile_prompts pp WHERE pp.user_id = u.id) AS prompts
         FROM users u WHERE u.id = $1`,
      [userId],
    );
  }

  async function denyEntry(userId: string): Promise<string | null> {
    return h.redis.get(h.app.keys.denyUser(userId));
  }

  /** A refused audit row: 500, the database exactly as before, nothing sent, denied or queued. */
  async function refusedLeavesNothing(action: string, user: SeededUser, request: () => Promise<LightMyRequestResponse>): Promise<LightMyRequestResponse> {
    await refuseAudit(db, action);
    const before = await snapshot(user.id);
    const published = realtime.published.length;
    const disconnected = realtime.disconnected.length;
    const deny = await denyEntry(user.id);
    const response = await request();
    expect(response.statusCode, response.body).toBe(500);
    expect(await snapshot(user.id)).toEqual(before);
    expect(realtime.published.length).toBe(published);
    expect(realtime.disconnected.length).toBe(disconnected);
    expect(await denyEntry(user.id)).toBe(deny);
    expect(jobs.jobs).toEqual([]);
    expect(await auditRows(db, { action, targetType: USER_TARGET, targetId: user.id })).toEqual([]);
    await refuseAudit(db);
    return response;
  }

  /** The row the request wrote: one, signed by the admin's session from this address, about the person. */
  async function audited(action: string, user: SeededUser, role = 'admin'): Promise<AuditRowView> {
    const found = await auditRows(db, { action, targetType: USER_TARGET, targetId: user.id });
    expect(found).toHaveLength(1);
    const audit = found[0]!;
    expect(audit).toMatchObject({ target_type: USER_TARGET, target_id: user.id, action, session_id: sessions.get(role), ip: ADMIN_IP });
    expect(audit.admin_id).not.toBeNull();
    const text = JSON.stringify(audit.detail);
    expect(text).not.toContain(PHONE.slice(4));
    return audit;
  }

  // ─── Reveal the phone ─────────────────────────────────────────────────

  describe('reveal phone', () => {
    it('answers the number once audited, uncached, in two statements', async () => {
      const u = await person('Phone Owner');
      await seedPhone(h, u.id, PHONE);
      const res = await send('POST', `/v1/admin/users/${u.publicUid}/reveal-phone`, undefined);
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBe(2);
      expect(adminRevealPhoneSchema.parse(res.json())).toEqual({ phone: PHONE });
      expect(res.headers['cache-control']).toBe('no-store');
      expect((await audited('user.view_phone', u)).detail).toEqual({});
    });

    it('never reveals when the audit row is refused, and answers 404 without a number on file', async () => {
      const u = await person('Phone Refused');
      await seedPhone(h, u.id, '+989129876544');
      const res = await refusedLeavesNothing('user.view_phone', u, () => send('POST', `/v1/admin/users/${u.publicUid}/reveal-phone`, undefined));
      expect(res.body).not.toContain('9129876544');
      const none = await person('No Phone');
      const missing = await send('POST', `/v1/admin/users/${none.publicUid}/reveal-phone`, undefined);
      expect(missing.statusCode).toBe(404);
      expect(await auditRows(db, { action: 'user.view_phone', targetId: none.id })).toEqual([]);
    });

    it('is for the roles holding users.view_phone, 20 an hour per admin, and fails closed', async () => {
      const u = await person('Phone Limited');
      await seedPhone(h, u.id, '+989129876545');
      expect((await send('POST', `/v1/admin/users/${u.publicUid}/reveal-phone`, undefined, 'moderator')).statusCode).toBe(403);
      const busy = await adminAs(h, 'admin');
      for (let i = 0; i < 20; i += 1) {
        expect((await admin(h, `/v1/admin/users/${u.publicUid}/reveal-phone`, undefined, { token: busy.accessToken, method: 'POST' })).statusCode).toBe(200);
      }
      const limited = await admin(h, `/v1/admin/users/${u.publicUid}/reveal-phone`, undefined, { token: busy.accessToken, method: 'POST' });
      expect(limited.statusCode).toBe(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      vi.spyOn(h.app.limits, 'take').mockRejectedValueOnce(new Error('valkey down'));
      expect((await send('POST', `/v1/admin/users/${u.publicUid}/reveal-phone`, undefined)).statusCode).toBe(503);
    });
  });

  // ─── Test accounts ────────────────────────────────────────────────────

  describe('test account', () => {
    it('is the owner’s: the person leaves every deck and their own deck is built again; unchanged twice', async () => {
      const u = await person('Store Reviewer');
      await h.app.cache.set(h.app.keys.deckQueue(u.id), 'x');
      expect((await send('POST', `/v1/admin/users/${u.publicUid}/test-account`, { test: true }, 'admin')).statusCode).toBe(403);
      const res = await send('POST', `/v1/admin/users/${u.publicUid}/test-account`, { test: true }, 'superadmin');
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBe(2);
      expect(adminUserChangeSchema.parse(res.json())).toMatchObject({ user: { id: u.publicUid, test: true }, sideEffects: 'done' });
      expect((await audited('user.test_account', u, 'superadmin')).detail).toEqual({ before: { test: false }, after: { test: true } });
      expect(await h.app.cache.exists(h.app.keys.deckQueue(u.id))).toBe(0);
      expect(await h.redis.zscore(h.app.keys.accountsHidden(), u.id)).not.toBeNull();
      expect((await row<{ flags: number }>(db, `SELECT flags FROM users WHERE id = $1`, [u.id])).flags).toBe(1);
      const again = await send('POST', `/v1/admin/users/${u.publicUid}/test-account`, { test: true }, 'superadmin');
      expect(statements(again)).toBe(1);
      expect(await auditRows(db, { action: 'user.test_account', targetId: u.id })).toHaveLength(1);
      const back = await send('POST', `/v1/admin/users/${u.publicUid}/test-account`, { test: false }, 'superadmin');
      expect(adminUserChangeSchema.parse(back.json()).user.test).toBe(false);
    });

    it('rolls back with a refused audit row, and answers 404 for no one', async () => {
      const u = await person('Test Refused');
      await h.app.cache.set(h.app.keys.deckQueue(u.id), 'x');
      await refusedLeavesNothing('user.test_account', u, () => send('POST', `/v1/admin/users/${u.publicUid}/test-account`, { test: true }, 'superadmin'));
      expect(await h.app.cache.exists(h.app.keys.deckQueue(u.id))).toBe(1);
      const unknown = h.app.publicIds.user.encode('88888888888888');
      expect((await send('POST', `/v1/admin/users/${unknown}/test-account`, { test: true }, 'superadmin')).statusCode).toBe(404);
    });
  });

  // ─── Penalties ────────────────────────────────────────────────────────

  describe('penalties', () => {
    it('warns: the person hears it with the message, sees it in their history and may appeal; two statements', async () => {
      const u = await person('To Warn');
      const res = await send('POST', `/v1/admin/users/${u.publicUid}/warn`, { reason: 'spam', reasonText: 'Please do not send links.', note: 'first time' }, 'moderator');
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBe(2);
      const body = adminActionResultSchema.parse(res.json());
      expect(body.action).toMatchObject({ kind: 'warning', reason: 'spam', reasonText: 'Please do not send links.', note: 'first time', standing: true, endsAt: null });
      expect(body.user.standing.map((a) => a.id)).toEqual([body.action.id]);
      expect(body.sideEffects).toBe('done');
      const audit = await audited('user.warn', u, 'moderator');
      expect(audit.detail).toEqual({
        actionId: body.action.id,
        reason: 'spam',
        reasonText: 'Please do not send links.',
        note: 'first time',
        endsAt: null,
        reportId: null,
        before: { status: 'active', shadowbanned: false },
        after: { status: 'active', shadowbanned: false },
        ended: 0,
      });
      const heard = realtimePayloads.account.parse(events(u, 'account').at(-1)!.d);
      expect(heard).toMatchObject({ status: 'active', moderation: { kind: 'warning', reasonText: 'Please do not send links.' } });
      expect(heard.moderation).not.toHaveProperty('revokedAt');
      const history = moderationHistorySchema.parse((await call(h, '/v1/me/moderation', { token: u.token })).json());
      expect([...history.active, ...history.history].map((i) => [i.kind, i.reasonText])).toEqual([['warning', 'Please do not send links.']]);
    });

    it('suspends until a time: the end job is queued with the right delay', async () => {
      const u = await person('To Suspend');
      const endsAt = new Date(Date.now() + 3 * DAY);
      const res = await send('POST', `/v1/admin/users/${u.publicUid}/suspend`, { reason: 'harassment', reasonText: 'You harassed members.', endsAt: endsAt.toISOString() });
      expect(res.statusCode, res.body).toBe(200);
      const body = adminActionResultSchema.parse(res.json());
      expect(body.user.status).toBe('suspended');
      expect(body.action.endsAt).toBe(endsAt.toISOString());
      const end = jobs.jobs.find((j) => j.name === 'moderation-end');
      expect(end).toMatchObject({ queue: 'safety', id: `moderation-end.${body.action.id}`, data: { actionId: body.action.id, userId: u.id } });
      expect(Math.abs((end?.options.delayMs ?? 0) - 3 * DAY)).toBeLessThan(10_000);
      expect((await call(h, '/v1/me', { token: u.token })).statusCode).toBe(401);
    });

    it('bans against a report: three statements; tokens stop, the conversation ends for the peer, the refresh is restricted with the reason, the person appeals', async () => {
      const a = await person('To Ban');
      const b = await person('Their Peer');
      const [lo, hi] = BigInt(a.id) < BigInt(b.id) ? [a.id, b.id] : [b.id, a.id];
      const matchId = h.app.ids.nextId();
      await db.sql.query(`INSERT INTO matches (id, user_lo, user_hi, source) VALUES ($1, $2, $3, 1)`, [matchId, lo, hi]);
      const report = await seedReport(h, { targetId: a.id, reporterId: b.id, reason: 2 });
      const refreshToken = await refreshTokenFor(h, a);
      const res = await send('POST', `/v1/admin/users/${a.publicUid}/ban`, { reason: 'harassment', reasonText: 'Repeated harassment reports.', reportId: report });
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBe(3);
      const body = adminActionResultSchema.parse(res.json());
      expect(body).toMatchObject({ user: { status: 'banned' }, action: { kind: 'ban', reportId: report, endsAt: null }, sideEffects: 'done' });
      expect((await audited('user.ban', a)).detail).toMatchObject({ reportId: report, before: { status: 'active' }, after: { status: 'banned' }, ended: 1 });
      expect((await call(h, '/v1/me', { token: a.token })).statusCode).toBe(401);
      expect(realtime.disconnected).toContain(a.publicUid);
      expect(realtimePayloads.account.parse(events(a, 'account').at(-1)!.d)).toMatchObject({ status: 'banned', moderation: { kind: 'ban', reasonText: 'Repeated harassment reports.' } });
      expect(events(b, 'conversation_end').map((e) => (e.d as { conversationId: string }).conversationId)).toContain(matchId);
      expect((await row<{ state: number }>(db, `SELECT state FROM matches WHERE id = $1`, [matchId])).state).toBe(4);

      // Tokens issued in the second of the revocation count as before it.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const refreshed = await call(h, '/v1/auth/refresh', { method: 'POST', body: { refreshToken } });
      expect(refreshed.statusCode, refreshed.body).toBe(403);
      const problem = json(refreshed);
      expect(problem).toMatchObject({ code: 'account_banned', reasonText: 'Repeated harassment reports.', actionId: body.action.id, appealable: true });
      const restricted = String(problem['accessToken']);
      const history = moderationHistorySchema.parse((await call(h, '/v1/me/moderation', { token: restricted })).json());
      expect(history.active.map((x) => [x.kind, x.reasonText])).toEqual([['ban', 'Repeated harassment reports.']]);
      const appeal = await call(h, '/v1/appeals', { method: 'POST', token: restricted, body: { actionId: body.action.id, body: 'It was a misunderstanding.' } });
      expect(appeal.statusCode, appeal.body).toBe(201);
    });

    it('shadowbans silently: the person hears nothing and their own view does not move', async () => {
      const u = await person('To Shadow');
      const before = await call(h, '/v1/me', { token: u.token });
      const res = await send('POST', `/v1/admin/users/${u.publicUid}/shadowban`, { reason: 'spam', note: 'link farm' });
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBe(2);
      const body = adminActionResultSchema.parse(res.json());
      expect(body.user).toMatchObject({ status: 'active', shadowbanned: true });
      expect(body.action).toMatchObject({ kind: 'shadowban', reason: 'spam', reasonText: 'Your account sent spam or unwanted promotion.' });
      const audit = await audited('user.shadowban', u);
      expect(audit.detail).not.toHaveProperty('reasonText');
      expect(events(u)).toEqual([]);
      const after = await call(h, '/v1/me', { token: u.token, headers: { 'if-none-match': String(before.headers['etag']) } });
      expect(after.statusCode).toBe(304);
    });

    it('refuses bodies the kind does not take, ends out of range and reports about someone else', async () => {
      const u = await person('Refusals');
      const other = await person('Someone Else');
      const url = (kind: string) => `/v1/admin/users/${u.publicUid}/${kind}`;
      expect((await send('POST', url('suspend'), { reason: 'spam', reasonText: 'x' })).statusCode).toBe(400);
      expect((await send('POST', url('warn'), { reason: 'spam', reasonText: 'x', endsAt: new Date(Date.now() + DAY).toISOString() })).statusCode).toBe(400);
      expect((await send('POST', url('shadowban'), { reason: 'spam', reasonText: 'x' })).statusCode).toBe(400);
      expect((await send('POST', url('ban'), { reason: 'nonsense', reasonText: 'x' })).statusCode).toBe(400);
      const codeOf = (res: LightMyRequestResponse): unknown => {
        problemSchemaFor('field_invalid').parse(res.json());
        return (json(res)['errors'] as unknown[] | undefined)?.[0];
      };
      expect(codeOf(await send('POST', url('suspend'), { reason: 'spam', reasonText: 'x', endsAt: new Date(Date.now() - DAY).toISOString() }))).toMatchObject({ pointer: '/endsAt', code: 'ends_in_past' });
      expect(codeOf(await send('POST', url('ban'), { reason: 'spam', reasonText: 'x', endsAt: new Date(Date.now() + 3_700 * DAY).toISOString() }))).toMatchObject({ pointer: '/endsAt', code: 'ends_too_far' });
      expect(codeOf(await send('POST', url('warn'), { reason: 'spam', reasonText: 'x', reportId: '123456789' }))).toMatchObject({ pointer: '/reportId', code: 'unknown_report' });
      const elsewhere = await seedReport(h, { targetId: other.id });
      const notThis = await send('POST', url('warn'), { reason: 'spam', reasonText: 'x', reportId: elsewhere });
      expect(statements(notThis)).toBe(1);
      expect(codeOf(notThis)).toMatchObject({ pointer: '/reportId', code: 'not_this_user' });
      const nobody = h.app.publicIds.user.encode('77777777777777');
      expect((await send('POST', `/v1/admin/users/${nobody}/warn`, { reason: 'spam', reasonText: 'x' })).statusCode).toBe(404);
      expect((await send('POST', url('warn'), { reason: 'spam', reasonText: 'x' }, 'support')).statusCode).toBe(403);
      expect((await send('POST', url('ban'), { reason: 'spam', reasonText: 'x' }, 'analyst')).statusCode).toBe(403);
      expect((await admin(h, url('ban'), { reason: 'spam', reasonText: 'x' })).statusCode).toBe(401);
      expect(await auditRows(db, { action: 'user.warn', targetId: u.id })).toEqual([]);
    });

    it.each(['warn', 'suspend', 'ban', 'shadowban'] as const)('%s rolls back with a refused audit row', async (kind) => {
      const u = await person(`Refused ${kind}`);
      const body = {
        reason: 'fake',
        ...(kind === 'shadowban' ? {} : { reasonText: 'Not a real person.' }),
        ...(kind === 'suspend' ? { endsAt: new Date(Date.now() + DAY).toISOString() } : {}),
      };
      await refusedLeavesNothing(`user.${kind}`, u, () => send('POST', `/v1/admin/users/${u.publicUid}/${kind}`, body));
    });

    it('answers 200 with sideEffects failed when the realtime side fails, the action committed', async () => {
      const u = await person('Side Fails');
      realtime.failWith = new Error('centrifugo down');
      const res = await send('POST', `/v1/admin/users/${u.publicUid}/warn`, { reason: 'spam', reasonText: 'Stop.' });
      expect(res.statusCode, res.body).toBe(200);
      expect(adminActionResultSchema.parse(res.json()).sideEffects).toBe('failed');
      expect((await rows(db, `SELECT 1 FROM moderation_actions WHERE user_id = $1 AND kind = 1`, [u.id])).length).toBe(1);
      expect(h.logs.some((line) => line.includes('after-commit side failed'))).toBe(true);
    });

    it('stops a banned person’s tokens and socket even when a deck or list step fails, and says the side failed', async () => {
      const u = await person('Ban Side Fails');
      // The deck step (vis:out) fails: the token revocation and the disconnect still run.
      const multi = h.app.redis.multi.bind(h.app.redis);
      vi.spyOn(h.app.redis, 'multi').mockImplementationOnce(() => {
        const tx = multi();
        tx.exec = () => Promise.reject(new Error('valkey timeout'));
        return tx;
      });
      const res = await send('POST', `/v1/admin/users/${u.publicUid}/ban`, { reason: 'scam', reasonText: 'Scam.' });
      expect(res.statusCode, res.body).toBe(200);
      expect(adminActionResultSchema.parse(res.json()).sideEffects).toBe('failed');
      expect((await call(h, '/v1/me', { token: u.token })).statusCode).toBe(401);
      expect(realtime.disconnected).toContain(u.publicUid);
    });

    it('answers 503 without an id lease, and writes nothing', async () => {
      const u = await person('No Lease');
      vi.spyOn(h.app.ids, 'nextId').mockImplementationOnce(() => {
        throw new IdGeneratorUnavailableError('no_lease');
      });
      const res = await send('POST', `/v1/admin/users/${u.publicUid}/warn`, { reason: 'spam', reasonText: 'Stop.' });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('2');
      expect(await rows(db, `SELECT 1 FROM moderation_actions WHERE user_id = $1`, [u.id])).toEqual([]);
    });
  });

  // ─── Lift ─────────────────────────────────────────────────────────────

  describe('lift', () => {
    it('lifts a ban: a lift record, the account active again and told; again is unchanged', async () => {
      const u = await person('To Lift');
      const ban = adminActionResultSchema.parse((await send('POST', `/v1/admin/users/${u.publicUid}/ban`, { reason: 'scam', reasonText: 'Scam.' })).json()).action;
      const res = await send('POST', `/v1/admin/users/${u.publicUid}/lift`, { actionId: ban.id, reasonText: 'We looked again.' }, 'moderator');
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBe(2);
      const body = adminActionResultSchema.parse(res.json());
      expect(body).toMatchObject({ user: { status: 'active', standing: [] }, action: { id: ban.id, standing: false }, sideEffects: 'done' });
      expect(body.action.revokedAt).not.toBeNull();
      expect(body.action.revokedBy?.id).toBeDefined();
      const lift = await row<{ kind: number; reason_text: string }>(db, `SELECT kind, reason_text FROM moderation_actions WHERE user_id = $1 AND kind = 5`, [u.id]);
      expect(lift).toEqual({ kind: 5, reason_text: 'We looked again.' });
      expect((await audited('user.lift', u, 'moderator')).detail).toMatchObject({ actionId: ban.id, kind: 'ban', reasonText: 'We looked again.', before: { status: 'banned' }, after: { status: 'active' } });
      // The person reads the ban as lifted, not as standing.
      expect(realtimePayloads.account.parse(events(u, 'account').at(-1)!.d)).toMatchObject({ status: 'active', moderation: { id: ban.id, kind: 'ban', revokedAt: body.action.revokedAt } });
      const again = await send('POST', `/v1/admin/users/${u.publicUid}/lift`, { actionId: ban.id }, 'moderator');
      expect(again.statusCode).toBe(200);
      expect(statements(again)).toBe(1);
      expect(await auditRows(db, { action: 'user.lift', targetId: u.id })).toHaveLength(1);
    });

    it('lifts a warning without telling the person, refuses another person’s action and rolls back with a refused row', async () => {
      const u = await person('Warned Lift');
      const other = await person('Other Lift');
      const warning = adminActionResultSchema.parse((await send('POST', `/v1/admin/users/${u.publicUid}/warn`, { reason: 'spam', reasonText: 'Stop.' })).json()).action;
      const own = async () => moderationHistorySchema.strict().parse((await call(h, '/v1/me/moderation', { token: u.token })).json());
      const standing = (await own()).history.find((item) => item.id === warning.id);
      expect(standing).toBeDefined();
      expect(standing).not.toHaveProperty('revokedAt');
      const heard = events(u).length;
      const res = await send('POST', `/v1/admin/users/${u.publicUid}/lift`, { actionId: warning.id });
      const lifted = adminActionResultSchema.parse(res.json()).action;
      expect(lifted.revokedAt).not.toBeNull();
      expect(events(u).length).toBe(heard);
      // Still in the history, now with the time it was lifted; nothing is in force.
      const after = await own();
      expect(after.active).toEqual([]);
      expect(after.history.find((item) => item.id === warning.id)).toMatchObject({ kind: 'warning', reasonText: 'Stop.', revokedAt: lifted.revokedAt });
      // A lifted warning takes no appeal.
      const appeal = await call(h, '/v1/appeals', { method: 'POST', token: u.token, body: { actionId: warning.id, body: 'It was fine.' } });
      expect(appeal.statusCode, appeal.body).toBe(422);
      expect(appeal.json()).toMatchObject({ code: 'not_appealable' });
      expect(statements(appeal)).toBe(1);
      // No lift record for a warning: its lift is its revoked_at and revoked_by.
      expect(await rows(db, `SELECT 1 FROM moderation_actions WHERE user_id = $1 AND kind = 5`, [u.id])).toEqual([]);
      expect((await audited('user.lift', u)).detail).toMatchObject({ actionId: warning.id, kind: 'warning', liftId: null });
      expect((await send('POST', `/v1/admin/users/${other.publicUid}/lift`, { actionId: warning.id })).statusCode).toBe(404);
      const suspension = adminActionResultSchema.parse(
        (await send('POST', `/v1/admin/users/${other.publicUid}/suspend`, { reason: 'spam', reasonText: 'Pause.', endsAt: new Date(Date.now() + DAY).toISOString() })).json(),
      ).action;
      jobs.jobs.length = 0;
      await refusedLeavesNothing('user.lift', other, () => send('POST', `/v1/admin/users/${other.publicUid}/lift`, { actionId: suspension.id }));
    });

    it('lifts a shadowban without a lift record; support and finance read nothing of it', async () => {
      const u = await person('Shadow Lift');
      const shadowban = adminActionResultSchema.parse((await send('POST', `/v1/admin/users/${u.publicUid}/shadowban`, { reason: 'spam', note: 'ring' }, 'moderator')).json()).action;
      const res = await send('POST', `/v1/admin/users/${u.publicUid}/lift`, { actionId: shadowban.id, reasonText: 'Checked.' }, 'moderator');
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBe(2);
      const body = adminActionResultSchema.parse(res.json());
      expect(body.action).toMatchObject({ id: shadowban.id, kind: 'shadowban', standing: false });
      expect(body.action.revokedAt).not.toBeNull();
      expect(body.user.shadowbanned).toBe(false);
      expect(await rows(db, `SELECT 1 FROM moderation_actions WHERE user_id = $1 AND kind = 5`, [u.id])).toEqual([]);
      expect((await audited('user.lift', u, 'moderator')).detail).toMatchObject({ kind: 'shadowban', liftId: null, reasonText: 'Checked.' });
      const tab = async (role: string) => {
        const response = await admin(h, `/v1/admin/users/${u.publicUid}/moderation`, undefined, { token: tokens.get(role)! });
        bodies.push(response.body);
        expect(response.statusCode, response.body).toBe(200);
        return response.json<{ items: { id: string; kind: string; revokedAt: string | null; revokedBy: { id: string } | null }[] }>().items;
      };
      for (const role of ['support', 'finance']) {
        const items = await tab(role);
        expect(items.filter((item) => item.kind === 'shadowban' || item.kind === 'lift'), role).toEqual([]);
      }
      const seen = (await tab('moderator')).find((item) => item.id === shadowban.id);
      expect(seen).toMatchObject({ kind: 'shadowban', revokedAt: body.action.revokedAt });
      expect(seen?.revokedBy?.id).toBeDefined();
    });

    it('answers 404 to a role that may lift but not see shadowbans, and writes nothing', async () => {
      const u = await person('Shadow Hidden');
      const shadowban = adminActionResultSchema.parse((await send('POST', `/v1/admin/users/${u.publicUid}/shadowban`, { reason: 'spam' })).json()).action;
      // A custom role: it may lift, but it may not see shadowbans (no users.shadowban, no moderation.read).
      await db.sql.query(`INSERT INTO admin_roles (id, key, names) VALUES (40, 'lifter', '{"en": "Lifter"}') ON CONFLICT (key) DO NOTHING`);
      await db.sql.query(`INSERT INTO admin_role_permissions (role_id, permission) VALUES (40, 'users.read'), (40, 'users.lift') ON CONFLICT DO NOTHING`);
      await h.app.adminAuth.roles.reload();
      const lifter = await adminAs(h, 'lifter');
      const before = await snapshot(u.id);
      const res = await admin(h, `/v1/admin/users/${u.publicUid}/lift`, { actionId: shadowban.id }, { token: lifter.accessToken, ip: ADMIN_IP });
      bodies.push(res.body);
      expect(res.statusCode, res.body).toBe(404);
      expect(res.body).not.toContain('shadowban');
      expect(await snapshot(u.id)).toEqual(before);
      expect(await auditRows(db, { action: 'user.lift', targetType: USER_TARGET, targetId: u.id })).toEqual([]);
    });
  });

  // ─── Sign out everywhere ──────────────────────────────────────────────

  describe('revoke sessions', () => {
    it('signs the person out on every device at once', async () => {
      const u = await person('Sign Out');
      const refreshToken = await refreshTokenFor(h, u);
      const res = await send('POST', `/v1/admin/users/${u.publicUid}/revoke-sessions`, { note: 'lost phone' }, 'moderator');
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBe(2);
      expect(adminRevokeSessionsResultSchema.parse(res.json())).toEqual({ sessions: 1, sideEffects: 'done' });
      expect(await row(db, `SELECT revoke_reason FROM sessions WHERE id = $1`, [u.sessionId])).toEqual({ revoke_reason: 4 });
      expect((await call(h, '/v1/me', { token: u.token })).statusCode).toBe(401);
      expect(realtime.disconnected).toContain(u.publicUid);
      // The cutoff outlives a connection token minted just before it (access TTL, skew, margin, realtime TTL, close delay).
      expect(await h.redis.pttl(`${h.prefix}deny:uid:${u.id}`)).toBeGreaterThan((900 + 30 + 30 + 3_600 + 25 - 10) * 1_000);
      expect((await call(h, '/v1/auth/refresh', { method: 'POST', body: { refreshToken } })).statusCode).toBe(401);
      const record = await row<{ kind: number; reason_code: number; note: string }>(db, `SELECT kind, reason_code, note FROM moderation_actions WHERE user_id = $1`, [u.id]);
      expect(record).toEqual({ kind: 10, reason_code: 99, note: 'lost phone' });
      expect((await audited('user.revoke_sessions', u, 'moderator')).detail).toMatchObject({ sessions: 1, note: 'lost phone' });
    });

    it('queues the realtime kick for the worker when Centrifugo cannot take it, and says the side failed only when that fails too', async () => {
      const u = await person('Sign Out Kick');
      realtime.failWith = new Error('centrifugo down');
      const res = await send('POST', `/v1/admin/users/${u.publicUid}/revoke-sessions`, {}, 'moderator');
      expect(res.statusCode, res.body).toBe(200);
      expect(adminRevokeSessionsResultSchema.parse(res.json()).sideEffects).toBe('done');
      expect(jobs.jobs.filter((j) => j.name === accountJobNames.realtimeEnd).map((j) => j.data['userId'])).toEqual([u.id]);
      jobs.failWith = new Error('valkey down');
      try {
        const other = await person('Sign Out Kick Lost');
        const lost = await send('POST', `/v1/admin/users/${other.publicUid}/revoke-sessions`, {}, 'moderator');
        expect(adminRevokeSessionsResultSchema.parse(lost.json()).sideEffects).toBe('failed');
      } finally {
        jobs.failWith = null;
      }
    });

    it('rolls back with a refused row and answers 404 for no one', async () => {
      const u = await person('Sign Out Refused');
      await refusedLeavesNothing('user.revoke_sessions', u, () => send('POST', `/v1/admin/users/${u.publicUid}/revoke-sessions`, {}));
      expect((await call(h, '/v1/me', { token: u.token })).statusCode).toBe(200);
      const nobody = h.app.publicIds.user.encode('66666666666666');
      expect((await send('POST', `/v1/admin/users/${nobody}/revoke-sessions`, {})).statusCode).toBe(404);
    });
  });

  // ─── Delete ───────────────────────────────────────────────────────────

  describe('delete', () => {
    it('deletes as an app deletion: restorable in the grace, jobs queued; again is unchanged; a held account’s purge waits', async () => {
      const u = await person('To Delete');
      const refreshToken = await refreshTokenFor(h, u);
      expect((await send('POST', `/v1/admin/users/${u.publicUid}/delete`, {}, 'moderator')).statusCode).toBe(403);
      const res = await send('POST', `/v1/admin/users/${u.publicUid}/delete`, { note: 'asked by email' });
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBe(3);
      const body = adminDeleteUserResultSchema.parse(res.json());
      expect(body.user).toMatchObject({ status: 'deleted', deletedVia: 'admin', restoreStatus: 'active' });
      expect(Date.parse(body.purgeAt)).toBeGreaterThan(Date.now() + 20 * DAY);
      expect(body.sideEffects).toBe('done');
      expect(jobs.jobs.map((j) => j.name).sort()).toEqual([accountJobNames.fanout, accountJobNames.purge].sort());
      expect(jobs.jobs.map((j) => j.queue)).toEqual(['account', 'account']);
      expect((await audited('user.delete', u)).detail).toMatchObject({ before: { status: 'active' }, after: { status: 'deleted' }, purgeAt: body.purgeAt, note: 'asked by email' });
      expect((await call(h, '/v1/me', { token: u.token })).statusCode).toBe(401);
      const refreshed = await call(h, '/v1/auth/refresh', { method: 'POST', body: { refreshToken } });
      expect(refreshed.statusCode).toBe(401);
      const again = await send('POST', `/v1/admin/users/${u.publicUid}/delete`, {});
      expect(again.statusCode).toBe(200);
      expect(statements(again)).toBe(3);
      expect(await auditRows(db, { action: 'user.delete', targetId: u.id })).toHaveLength(1);
      await db.sql.query(`INSERT INTO legal_holds (id, user_id, kind) VALUES ($1, $2, 1)`, [h.app.ids.nextId(), u.id]);
      expect((await row<{ out: { outcome: string } }>(db, `SELECT account_purge($1, now() + interval '400 days') AS out`, [u.id])).out.outcome).toBe('held');
    });

    it('rolls back with a refused row', async () => {
      const u = await person('Delete Refused');
      await refusedLeavesNothing('user.delete', u, () => send('POST', `/v1/admin/users/${u.publicUid}/delete`, {}));
    });
  });

  // ─── Rename ───────────────────────────────────────────────────────────

  describe('rename', () => {
    it('replaces the name with a reason; stale 409, refused name 422, same name unchanged', async () => {
      const u = await person('B4dW0rd Person');
      const version = await profileVersion(h, u.id);
      await db.sql.query(`INSERT INTO banned_terms (match_kind, severity, scope, term) VALUES (1, 2, 1, 'forbiddenname')`);
      await reloadConfig(h);
      const refused = await send('PATCH', `/v1/admin/users/${u.publicUid}/profile`, { displayName: 'ForbiddenName', reason: 'offensive', version });
      expect(refused.statusCode).toBe(422);
      expect(problemSchemaFor('field_invalid').parse(refused.json()).errors).toEqual(expect.arrayContaining([expect.objectContaining({ pointer: '/displayName', code: 'name_refused' })]));
      expect((await send('PATCH', `/v1/admin/users/${u.publicUid}/profile`, { displayName: 'Person', reason: 'offensive', version: version + 7 })).statusCode).toBe(409);
      const res = await send('PATCH', `/v1/admin/users/${u.publicUid}/profile`, { displayName: 'Person', reason: 'offensive', version });
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBe(2);
      const body = adminUserChangeSchema.parse(res.json());
      expect(body.user).toMatchObject({ name: 'Person', profile: { name: 'Person', version: version + 1 } });
      expect((await row<{ display_name: string }>(db, `SELECT display_name FROM profiles WHERE user_id = $1`, [u.id])).display_name).toBe('Person');
      expect(await row(db, `SELECT kind, reason_code, note FROM moderation_actions WHERE user_id = $1`, [u.id])).toEqual({ kind: 7, reason_code: 2, note: 'name' });
      // The audit row outlives the account: never the names, only the old one's length.
      const renameRow = await audited('user.rename', u);
      expect(renameRow.detail).toMatchObject({ before: { length: 14 }, reason: 'offensive' });
      expect(JSON.stringify(renameRow.detail)).not.toMatch(/B4dW0rd|Person/);
      // The person reads the new name with its reason, in the event and in their own view, until they choose a name.
      const told = realtime.on(userChannel(u.publicUid)).filter((e) => e.t === 'profile').at(-1);
      expect(realtimePayloads.profile.parse(told?.d)).toEqual({ name: 'Person', nameRejectReason: expect.any(String) as string });
      const own = meSchema.parse((await call(h, '/v1/me', { token: u.token })).json());
      expect(own.profile?.nameRejectReason).toBe((told?.d as { nameRejectReason: string }).nameRejectReason);
      const same = await send('PATCH', `/v1/admin/users/${u.publicUid}/profile`, { displayName: 'Person', reason: 'offensive', version: version + 1 });
      expect(same.statusCode).toBe(200);
      expect(await auditRows(db, { action: 'user.rename', targetId: u.id })).toHaveLength(1);
      expect((await call(h, '/v1/me/profile', { method: 'PATCH', token: u.token, body: { displayName: 'My Own' } })).statusCode).toBe(200);
      expect(meSchema.parse((await call(h, '/v1/me', { token: u.token })).json()).profile?.nameRejectReason).toBeUndefined();
      expect((await send('PATCH', `/v1/admin/users/${u.publicUid}/profile`, { displayName: 'P', reason: 'offensive', version }, 'moderator')).statusCode).toBe(403);
    });

    it("checks a term of one language against the person's language, leaving nothing behind when it refuses", async () => {
      await db.sql.query(`INSERT INTO banned_terms (match_kind, severity, scope, term, locale) VALUES (1, 3, 1, 'trkonly', 'tr')`);
      await reloadConfig(h);
      const fa = await person('Persian Speaker', { locale: 'fa' });
      const tr = await person('Turkish Speaker', { locale: 'tr' });
      const faVersion = await profileVersion(h, fa.id);
      const ok = await send('PATCH', `/v1/admin/users/${fa.publicUid}/profile`, { displayName: 'Trkonly Name', reason: 'offensive', version: faVersion });
      expect(ok.statusCode, ok.body).toBe(200);
      const trVersion = await profileVersion(h, tr.id);
      const refused = await send('PATCH', `/v1/admin/users/${tr.publicUid}/profile`, { displayName: 'Trkonly Name', reason: 'offensive', version: trVersion });
      expect(refused.statusCode).toBe(422);
      expect(problemSchemaFor('field_invalid').parse(refused.json()).errors).toEqual([expect.objectContaining({ pointer: '/displayName', code: 'name_refused' })]);
      expect(await row(db, `SELECT display_name, version FROM profiles WHERE user_id = $1`, [tr.id])).toEqual({ display_name: 'Turkish Speaker', version: trVersion });
      expect((await row<{ n: number }>(db, `SELECT count(*)::integer AS n FROM moderation_actions WHERE user_id = $1`, [tr.id])).n).toBe(0);
      expect(await auditRows(db, { action: 'user.rename', targetId: tr.id })).toEqual([]);
    });

    it('rolls back with a refused row', async () => {
      const u = await person('Rename Refused');
      const version = await profileVersion(h, u.id);
      await refusedLeavesNothing('user.rename', u, () => send('PATCH', `/v1/admin/users/${u.publicUid}/profile`, { displayName: 'Other', reason: 'other', version }));
    });
  });

  // ─── Text decisions ───────────────────────────────────────────────────

  describe('text decisions', () => {
    it('approves every waiting part: the person hears the states, nothing is recorded as a rejection', async () => {
      const u = await person('Approve Me', { locale: 'fa' });
      const version = await seedTexts(h, u.id, { about: 'Hello there', job: 'Teacher', textState: 1 });
      await seedPrompts(h, u.id, [{ position: 0, answer: 'Mountains' }, { position: 1, answer: 'Tea' }]);
      const v = await profileVersion(h, u.id);
      expect(v).toBeGreaterThanOrEqual(version);
      const res = await send('POST', `/v1/admin/moderation/texts/${u.publicUid}/approve`, { version: v }, 'moderator');
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBe(2);
      const body = adminTextDecisionSchema.parse(res.json());
      expect(body.texts).toMatchObject({ about: { text: 'Hello there', state: 'approved' }, job: { text: 'Teacher', state: 'approved' } });
      expect(body.texts.prompts.map((p) => p.status)).toEqual(['approved', 'approved']);
      expect(realtimePayloads.profile.parse(events(u, 'profile').at(-1)!.d)).toEqual({ textState: 'approved', prompts: [{ position: 0, status: 'approved' }, { position: 1, status: 'approved' }] });
      const audit = await audited('text.approve', u, 'moderator');
      expect(audit.detail).toMatchObject({ reason: null, actionId: null, before: { textState: 1 }, after: { textState: 2 } });
      expect(JSON.stringify(audit.detail)).not.toContain('Hello there');
      expect(await rows(db, `SELECT 1 FROM moderation_actions WHERE user_id = $1`, [u.id])).toEqual([]);
    });

    it('rejects every waiting part when none is named: the reason in the person’s language in /v1/me and the event', async () => {
      const u = await person('Reject All', { locale: 'fa' });
      await seedTexts(h, u.id, { about: 'Call me at five', job: null, textState: 1 });
      await seedPrompts(h, u.id, [{ position: 0, answer: 'insta: @me' }, { position: 2, answer: 'Fine one', status: 2 }]);
      const version = await profileVersion(h, u.id);
      const res = await send('POST', `/v1/admin/moderation/texts/${u.publicUid}/reject`, { version, reason: 'contact_details' });
      expect(res.statusCode, res.body).toBe(200);
      const body = adminTextDecisionSchema.parse(res.json());
      expect(body.texts).toMatchObject({ about: { state: 'rejected' }, textRejectReason: 'contact_details' });
      expect(body.texts.prompts.map((p) => [p.position, p.status, p.rejectReason ?? null])).toEqual([[0, 'rejected', 'contact_details'], [2, 'approved', null]]);
      const fa = 'راه تماس، پیوند و نام کاربری شبکه‌های اجتماعی در پروفایل مجاز نیست.';
      expect(realtimePayloads.profile.parse(events(u, 'profile').at(-1)!.d)).toEqual({
        textState: 'rejected',
        textRejectReason: fa,
        prompts: [{ position: 0, status: 'rejected', rejectReason: fa }, { position: 2, status: 'approved' }],
      });
      const me = meSchema.parse((await call(h, '/v1/me', { token: u.token, headers: { 'accept-language': 'fa' } })).json());
      expect(me.profile?.textRejectReason).toBe(fa);
      expect(me.profile?.prompts.find((p) => p.position === 0)?.rejectReason).toBe(fa);
      expect(me.profile?.prompts.find((p) => p.position === 2)?.rejectReason).toBeUndefined();
      expect(await row(db, `SELECT kind, reason_code, note FROM moderation_actions WHERE user_id = $1`, [u.id])).toEqual({ kind: 7, reason_code: 1, note: 'about/job, prompt 1' });
      expect((await audited('text.reject', u)).detail).toMatchObject({ reason: 'contact_details', parts: { profile: true, prompts: [0] } });
    });

    it('rejects one prompt and approves the rest; refuses a part that is not there and a stale version', async () => {
      const u = await person('Reject One');
      await seedTexts(h, u.id, { about: 'About me', textState: 1 });
      await seedPrompts(h, u.id, [{ position: 0, answer: 'One' }, { position: 1, answer: 'Two' }]);
      const version = await profileVersion(h, u.id);
      const stale = await send('POST', `/v1/admin/moderation/texts/${u.publicUid}/reject`, { version: version - 1, reason: 'sexual', prompts: [1] });
      expect(stale.statusCode).toBe(409);
      const absent = await send('POST', `/v1/admin/moderation/texts/${u.publicUid}/reject`, { version, reason: 'sexual', prompts: [1, 2] });
      expect(absent.statusCode).toBe(422);
      expect(problemSchemaFor('field_invalid').parse(absent.json()).errors).toEqual(expect.arrayContaining([expect.objectContaining({ pointer: '/prompts/1', code: 'not_a_part' })]));
      const res = await send('POST', `/v1/admin/moderation/texts/${u.publicUid}/reject`, { version, reason: 'sexual', prompts: [1] });
      expect(res.statusCode, res.body).toBe(200);
      const body = adminTextDecisionSchema.parse(res.json());
      expect(body.texts.about?.state).toBe('approved');
      expect(body.texts.prompts.map((p) => p.status)).toEqual(['approved', 'rejected']);
      const nameOnly = await person('Name Only');
      const noText = await send('POST', `/v1/admin/moderation/texts/${nameOnly.publicUid}/reject`, { version: await profileVersion(h, nameOnly.id), reason: 'other', profile: true });
      expect(problemSchemaFor('field_invalid').parse(noText.json()).errors).toEqual(expect.arrayContaining([expect.objectContaining({ pointer: '/profile', code: 'not_a_part' })]));
      // A profile made with a name only waits at state 1 with no text: an approve clears it.
      const cleared = await send('POST', `/v1/admin/moderation/texts/${nameOnly.publicUid}/approve`, { version: await profileVersion(h, nameOnly.id) });
      expect(cleared.statusCode).toBe(200);
      expect((await row<{ text_state: number }>(db, `SELECT text_state FROM profiles WHERE user_id = $1`, [nameOnly.id])).text_state).toBe(2);
      expect((await send('POST', `/v1/admin/moderation/texts/${u.publicUid}/approve`, { version }, 'support')).statusCode).toBe(403);
    });

    it('rolls back with a refused row', async () => {
      const u = await person('Text Refused');
      await seedTexts(h, u.id, { about: 'Wait', textState: 1 });
      const version = await profileVersion(h, u.id);
      await refusedLeavesNothing('text.reject', u, () => send('POST', `/v1/admin/moderation/texts/${u.publicUid}/reject`, { version, reason: 'other' }));
      await refusedLeavesNothing('text.approve', u, () => send('POST', `/v1/admin/moderation/texts/${u.publicUid}/approve`, { version }));
    });
  });
});
