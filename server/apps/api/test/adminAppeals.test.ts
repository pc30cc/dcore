import { adminAppealDecisionSchema, adminAppealPageSchema, moderationHistorySchema, problemSchemaFor, realtimePayloads, userChannel } from '@app/shared';
import { FakeRealtimePublisher } from '@app/shared/server';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, json, migratedDatabase, row, seedUser, statements, type SeededUser, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, auditRows, installAuditFailure, refuseAudit, startAdminHarness, type AdminHarness, type AdminSession } from './adminSupport.js';
import { seedAction, seedAppeal } from './moderationSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * Appeals in the admin panel: the open queue (oldest first) and the decided
 * list, each with the action and the person's other records; an uphold
 * (the action stays, the person reads the decision) and an overturn (the
 * action is lifted at once, after the commit the account moves back); a
 * decided appeal is not decided again; a refused audit row changes nothing.
 */

const ADMIN_IP = '93.184.216.34';
const APPEAL_TARGET = 4;

describe.skipIf(!hasInfrastructure)('admin: appeals', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  const realtime = new FakeRealtimePublisher();
  const admins = new Map<string, AdminSession>();
  const rawIds: string[] = [];
  const bodies: string[] = [];

  beforeAll(async () => {
    db = await migratedDatabase();
    await installAuditFailure(db);
    h = await startAdminHarness(db, {}, { jobs: new MemoryJobProducer(), realtime });
    for (const role of ['admin', 'moderator', 'support', 'analyst']) admins.set(role, await adminAs(h, role));
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

  async function person(name: string): Promise<SeededUser> {
    const user = await seedUser(h, { name });
    rawIds.push(user.id);
    return user;
  }

  async function send(url: string, body?: unknown, role = 'moderator'): Promise<LightMyRequestResponse> {
    const response = await admin(h, url, body, { token: admins.get(role)!.accessToken, ip: ADMIN_IP, ...(body === undefined ? {} : { method: 'POST' as const }) });
    bodies.push(response.body);
    return response;
  }

  const status = async (userId: string) => (await row<{ status: number }>(db, `SELECT status FROM users WHERE id = $1`, [userId])).status;

  it('lists open appeals oldest first with the action and the person’s other records; decided ones newest first', async () => {
    await db.sql.query(`UPDATE public.appeals SET status = 2, decided_at = now() WHERE status = 1`);
    const a = await person('Appealer A');
    const warning = await seedAction(h, a.id, 1, 'Please be kind.');
    const ban = await seedAction(h, a.id, 3, 'You harassed members.');
    const first = await seedAppeal(h, a.id, ban, 'It was not me.');
    const b = await person('Appealer B');
    const second = await seedAppeal(h, b.id, await seedAction(h, b.id, 2, 'A week off.'), 'Too long.');

    const res = await send('/v1/admin/appeals?limit=1');
    expect(res.statusCode, res.body).toBe(200);
    expect(statements(res)).toBe(1);
    const page = adminAppealPageSchema.parse(res.json());
    expect(page.items.map((x) => x.id)).toEqual([first]);
    expect(page.items[0]).toMatchObject({
      status: 'open',
      body: 'It was not me.',
      user: { id: a.publicUid, status: 'banned' },
      action: { id: ban, kind: 'ban', reasonText: 'You harassed members.', standing: true, appeal: { id: first, status: 'open' } },
      history: [{ id: warning, kind: 'warning' }],
    });
    const next = adminAppealPageSchema.parse((await send(`/v1/admin/appeals?limit=1&cursor=${page.nextCursor}`)).json());
    expect(next.items.map((x) => x.id)).toEqual([second]);
    await send(`/v1/admin/appeals/${second}/uphold`, { text: 'The suspension stays.' });
    const decided = adminAppealPageSchema.parse((await send('/v1/admin/appeals?status=decided')).json());
    expect(decided.items[0]).toMatchObject({ id: second, status: 'upheld', decisionText: 'The suspension stays.' });
    expect((await send('/v1/admin/appeals', undefined, 'support')).statusCode).toBe(403);
    expect((await send('/v1/admin/appeals', undefined, 'analyst')).statusCode).toBe(403);
    expect((await admin(h, '/v1/admin/appeals')).statusCode).toBe(401);
  });

  it('upholds: the action stays, the person reads the decision in the app and their history; decided once', async () => {
    const u = await person('Upheld');
    const ban = await seedAction(h, u.id, 3, 'Spam links.');
    const appeal = await seedAppeal(h, u.id, ban);
    const res = await send(`/v1/admin/appeals/${appeal}/uphold`, { text: 'We checked again: the ban stays.' });
    expect(res.statusCode, res.body).toBe(200);
    expect(statements(res)).toBe(2);
    const body = adminAppealDecisionSchema.parse(res.json());
    expect(body).toMatchObject({ appeal: { status: 'upheld', decisionText: 'We checked again: the ban stays.', action: { standing: true } }, sideEffects: 'done' });
    expect(await status(u.id)).toBe(6);
    const event = realtime.on(userChannel(u.publicUid)).filter((e) => e.t === 'account').at(-1);
    expect(realtimePayloads.account.parse(event?.d)).toMatchObject({ status: 'banned', moderation: { kind: 'ban', appeal: { status: 'upheld', decisionText: 'We checked again: the ban stays.' } } });
    const audits = await auditRows(db, { action: 'appeal.uphold', targetType: APPEAL_TARGET, targetId: appeal });
    expect(audits.map((a) => a.detail)).toEqual([{ actionId: ban, text: 'We checked again: the ban stays.', before: { status: 'open' }, after: { status: 'upheld' } }]);
    const again = await send(`/v1/admin/appeals/${appeal}/overturn`, { text: 'Changed my mind.' });
    expect(again.statusCode).toBe(409);
    expect(json(again)['detail']).toBe('Already decided.');
    expect((await send('/v1/admin/appeals/99999999999/uphold', { text: 'x' })).statusCode).toBe(404);
    expect((await send(`/v1/admin/appeals/${appeal}/uphold`, { text: 'x' }, 'support')).statusCode).toBe(403);
    problemSchemaFor('forbidden').parse((await send(`/v1/admin/appeals/${appeal}/uphold`, { text: 'x' }, 'analyst')).json());
  });

  it('overturns: the action is lifted, the person is active again and reads the decision; the effects run after the commit', async () => {
    const u = await person('Overturned');
    const suspension = await seedAction(h, u.id, 2, 'A week off.');
    const appeal = await seedAppeal(h, u.id, suspension);
    const res = await send(`/v1/admin/appeals/${appeal}/overturn`, { text: 'You were right, sorry.' });
    expect(res.statusCode, res.body).toBe(200);
    expect(statements(res)).toBe(2);
    const body = adminAppealDecisionSchema.parse(res.json());
    expect(body.appeal).toMatchObject({ status: 'overturned', user: { status: 'active' }, action: { standing: false } });
    expect(body.appeal.action.revokedAt).not.toBeNull();
    expect(body.appeal.history.map((x) => x.kind)).toEqual(['lift']);
    expect(await status(u.id)).toBe(3);
    const event = realtime.on(userChannel(u.publicUid)).filter((e) => e.t === 'account').at(-1);
    expect(realtimePayloads.account.parse(event?.d)).toMatchObject({
      status: 'active',
      moderation: { id: suspension, revokedAt: body.appeal.action.revokedAt, appeal: { status: 'overturned', decisionText: 'You were right, sorry.' } },
    });
    const audits = await auditRows(db, { action: 'appeal.overturn', targetType: APPEAL_TARGET, targetId: appeal });
    expect(audits[0]?.detail).toEqual({
      actionId: suspension,
      text: 'You were right, sorry.',
      before: { status: 'open' },
      after: { status: 'overturned' },
      account: { before: { status: 'suspended', shadowbanned: false }, after: { status: 'active', shadowbanned: false } },
      deviceBansRemoved: 0,
    });
    const history = moderationHistorySchema.parse((await call(h, '/v1/me/moderation', { token: (await seedUserToken(u)).token })).json());
    const item = [...history.active, ...history.history].find((x) => x.id === suspension);
    expect(item?.appeal).toMatchObject({ status: 'overturned', decisionText: 'You were right, sorry.' });
    expect(history.history.map((x) => x.id)).toContain(suspension);
    expect(item?.revokedAt).toBeDefined();
  });

  it('decides the appeal of an account the purge emptied since: an overturn lifts the action on the record, nothing to send', async () => {
    const u = await person('Purged Appellant');
    const ban = await seedAction(h, u.id, 3, 'Spam.');
    const appeal = await seedAppeal(h, u.id, ban);
    await db.sql.query(`UPDATE users SET status = 7, deleted_at = now() - interval '60 days', deleted_via = 1 WHERE id = $1`, [u.id]);
    expect((await row<{ out: { outcome: string } }>(db, `SELECT account_purge($1, now() + interval '400 days') AS out`, [u.id])).out.outcome).toBe('purged');
    expect(await status(u.id)).toBe(8);
    const published = realtime.published.length;
    const res = await send(`/v1/admin/appeals/${appeal}/overturn`, { text: 'We looked again.' });
    expect(res.statusCode, res.body).toBe(200);
    expect(statements(res)).toBe(2);
    const body = adminAppealDecisionSchema.parse(res.json());
    expect(body).toMatchObject({ appeal: { status: 'overturned', decisionText: 'We looked again.', user: { status: 'purged' }, action: { standing: false } }, sideEffects: 'done' });
    expect(realtime.published.length).toBe(published);
    const audits = await auditRows(db, { action: 'appeal.overturn', targetType: APPEAL_TARGET, targetId: appeal });
    expect(audits[0]?.detail).toEqual({ actionId: ban, text: 'We looked again.', before: { status: 'open' }, after: { status: 'overturned' }, account: null, deviceBansRemoved: 0 });
    expect((await send(`/v1/admin/appeals/${appeal}/overturn`, { text: 'Again.' })).statusCode).toBe(409);
  });

  it('closes the appeal of an action lifted from the user page, and refuses to uphold a lifted action', async () => {
    const u = await person('Lifted Appellant');
    const ban = await seedAction(h, u.id, 3, 'Spam.');
    const appeal = await seedAppeal(h, u.id, ban);
    const lift = await send(`/v1/admin/users/${u.publicUid}/lift`, { actionId: ban, reasonText: 'Internal: wrong person.' });
    expect(lift.statusCode, lift.body).toBe(200);
    // The lift decided the open appeal (overturned), without the lift's internal note as its text.
    const decided = await row<{ status: number; decision_text: string | null }>(db, `SELECT status, decision_text FROM appeals WHERE id = $1`, [appeal]);
    expect(decided).toEqual({ status: 3, decision_text: null });
    const heard = realtime.on(userChannel(u.publicUid)).filter((e) => e.t === 'account').at(-1);
    const heardPayload = realtimePayloads.account.parse(heard?.d);
    expect(heardPayload).toMatchObject({ status: 'active', moderation: { appeal: { status: 'overturned' } } });
    expect(heardPayload.moderation?.revokedAt).toEqual(expect.any(String));
    expect(JSON.stringify(heard)).not.toContain('Internal');
    expect((await send(`/v1/admin/appeals/${appeal}/uphold`, { text: 'It stands.' })).statusCode).toBe(409);

    // An appeal left open on a lifted action (before this rule): an uphold is refused, nothing changes.
    const other = await seedAction(h, u.id, 2, 'Rude.');
    const stale = await seedAppeal(h, u.id, other);
    await db.sql.query(`UPDATE moderation_actions SET revoked_at = now() WHERE id = $1`, [other]);
    const refused = await send(`/v1/admin/appeals/${stale}/uphold`, { text: 'It stands.' });
    expect(refused.statusCode).toBe(409);
    expect(json(refused)['detail']).toBe('The action was lifted.');
    expect((await row<{ status: number }>(db, `SELECT status FROM appeals WHERE id = $1`, [stale])).status).toBe(1);
  });

  it('shows a role that reads appeals but not moderation no shadowban and no internal note', async () => {
    const u = await person('Appeal Reader');
    const ban = await seedAction(h, u.id, 3, 'Spam links.');
    const shadow = await seedAction(h, u.id, 4, 'Your account sent spam or unwanted promotion.');
    await db.sql.query(`UPDATE moderation_actions SET note = 'internal ring' WHERE id = $1`, [ban]);
    const appeal = await seedAppeal(h, u.id, ban, 'Please.');
    await db.sql.query(`INSERT INTO admin_roles (id, key, names) VALUES (41, 'appeal_reader', '{"en": "Appeal reader"}') ON CONFLICT (key) DO NOTHING`);
    await db.sql.query(`INSERT INTO admin_role_permissions (role_id, permission) VALUES (41, 'appeals.read') ON CONFLICT DO NOTHING`);
    await h.app.adminAuth.roles.reload();
    admins.set('appeal_reader', await adminAs(h, 'appeal_reader'));
    const read = async (role: string) => {
      const page = adminAppealPageSchema.parse((await send('/v1/admin/appeals?limit=100', undefined, role)).json());
      return page.items.find((x) => x.id === appeal)!;
    };
    const limited = await read('appeal_reader');
    expect(limited.action).toMatchObject({ id: ban, note: null });
    expect(limited.history.map((x) => x.id)).not.toContain(shadow);
    expect(limited.history.every((x) => x.note === null)).toBe(true);
    const full = await read('moderator');
    expect(full.action.note).toBe('internal ring');
    expect(full.history.map((x) => x.id)).toContain(shadow);
  });

  it('fills the history of a role that may not see shadowbans with ten other records, in the list and in the decision', async () => {
    const u = await person('Full History');
    // Oldest first: a warning, the appealed ban, a shadowban, nine warnings.
    const oldest = await seedAction(h, u.id, 1, 'The first one.');
    const ban = await seedAction(h, u.id, 3, 'Spam links.');
    const shadow = await seedAction(h, u.id, 4, 'Your account sent spam or unwanted promotion.');
    const recent: string[] = [];
    for (let i = 1; i <= 9; i += 1) recent.unshift(await seedAction(h, u.id, 1, `Warning ${i}.`));
    const appeal = await seedAppeal(h, u.id, ban, 'Please.');
    await db.sql.query(`INSERT INTO admin_roles (id, key, names) VALUES (43, 'appeal_decider', '{"en": "Appeal decider"}') ON CONFLICT (key) DO NOTHING`);
    await db.sql.query(`INSERT INTO admin_role_permissions (role_id, permission) VALUES (43, 'appeals.read'), (43, 'appeals.decide') ON CONFLICT DO NOTHING`);
    await h.app.adminAuth.roles.reload();
    admins.set('appeal_decider', await adminAs(h, 'appeal_decider'));
    const listed = async (role: string) => adminAppealPageSchema.parse((await send('/v1/admin/appeals?limit=100', undefined, role)).json()).items.find((x) => x.id === appeal)!;
    expect((await listed('appeal_decider')).history.map((x) => x.id)).toEqual([...recent, oldest]);
    expect((await listed('moderator')).history.map((x) => x.id)).toEqual([...recent, shadow]);
    const res = await send(`/v1/admin/appeals/${appeal}/uphold`, { text: 'The ban stays.' }, 'appeal_decider');
    expect(res.statusCode, res.body).toBe(200);
    expect(statements(res)).toBe(2);
    expect(adminAppealDecisionSchema.parse(res.json()).appeal.history.map((x) => x.id)).toEqual([...recent, oldest]);
    expect(res.body).not.toContain('shadowban');
  });

  it('rolls back with a refused audit row: the appeal open, the action standing, nothing sent', async () => {
    const u = await person('Appeal Refused');
    const ban = await seedAction(h, u.id, 3, 'No.');
    const appeal = await seedAppeal(h, u.id, ban);
    const published = realtime.published.length;
    for (const [action, kind] of [['appeal.overturn', 'overturn'], ['appeal.uphold', 'uphold']] as const) {
      await refuseAudit(db, action);
      expect((await send(`/v1/admin/appeals/${appeal}/${kind}`, { text: 'Yes.' })).statusCode).toBe(500);
      expect((await row<{ status: number }>(db, `SELECT status FROM appeals WHERE id = $1`, [appeal])).status).toBe(1);
      expect(await status(u.id)).toBe(6);
    }
    expect((await row<{ n: number }>(db, `SELECT count(*)::integer AS n FROM moderation_actions WHERE user_id = $1 AND kind = 5`, [u.id])).n).toBe(0);
    expect(realtime.published.length).toBe(published);
  });

  it('answers the decision when the app side fails after the commit', async () => {
    const u = await person('Appeal Late');
    const appeal = await seedAppeal(h, u.id, await seedAction(h, u.id, 1, 'Be kind.'));
    realtime.failWith = new Error('centrifugo down');
    const res = await send(`/v1/admin/appeals/${appeal}/overturn`, { text: 'Fine.' });
    expect(res.statusCode).toBe(200);
    expect(adminAppealDecisionSchema.parse(res.json()).sideEffects).toBe('failed');
  });

  /** A fresh full token for the seeded person (their session after an overturn). */
  async function seedUserToken(user: SeededUser): Promise<{ token: string }> {
    const { token } = await h.app.tokens.issue({ kind: 'app', subject: user.publicUid, sessionId: user.sessionId, deviceId: user.deviceId, storeCode: 2, scope: 'full' });
    return { token };
  }
});
