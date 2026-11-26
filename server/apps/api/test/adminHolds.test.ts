import { adminHoldPageSchema, adminHoldSchema, problemSchemaFor } from '@app/shared';
import { FakeRealtimePublisher } from '@app/shared/server';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { json, migratedDatabase, row, seedUser, statements, type SeededUser, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, auditRows, installAuditFailure, refuseAudit, startAdminHarness, type AdminHarness, type AdminSession } from './adminSupport.js';
import { seedMatch, seedReport } from './moderationSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * Legal holds in the admin panel: the active and released lists, a hold
 * placed by hand (on an account, a conversation, for a report) with the
 * checks of what it names, its release with a reason (released, never
 * deleted; twice is the same hold), each write with its audit row. A hold
 * changes nothing the person sees.
 */

const ADMIN_IP = '93.184.216.34';
const HOLD_TARGET = 16;

describe.skipIf(!hasInfrastructure)('admin: legal holds', () => {
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
    await refuseAudit(db);
  });

  async function person(name: string, status?: number): Promise<SeededUser> {
    const user = await seedUser(h, { name, ...(status ? { status } : {}) });
    rawIds.push(user.id);
    return user;
  }

  async function call(url: string, body?: unknown, role = 'moderator'): Promise<LightMyRequestResponse> {
    const response = await admin(h, url, body, { token: admins.get(role)!.accessToken, ip: ADMIN_IP, ...(body === undefined ? {} : { method: 'POST' as const }) });
    bodies.push(response.body);
    return response;
  }

  const errorOf = (res: LightMyRequestResponse): unknown => {
    problemSchemaFor('field_invalid').parse(res.json());
    return (json(res)['errors'] as unknown[])[0];
  };

  it('places a hold on an account and a conversation for a report: two statements, 201, the audit row', async () => {
    const a = await person('Held A');
    const b = await person('Held B');
    const matchId = await seedMatch(h, a.id, b.id);
    const report = await seedReport(h, { targetId: a.id, reporterId: b.id });
    const res = await call('/v1/admin/holds', { user: a.publicUid, conversationId: matchId, reportId: report, kind: 'authority', authorityRef: 'REQ-42' });
    expect(res.statusCode, res.body).toBe(201);
    expect(statements(res)).toBe(2);
    const hold = adminHoldSchema.parse(res.json());
    expect(hold).toMatchObject({ kind: 'authority', user: { id: a.publicUid }, conversationId: matchId, reportId: report, authorityRef: 'REQ-42', releasedAt: null, filing: null });
    expect(hold.createdBy?.id).toBe(String(admins.get('moderator')!.account.id));
    const audits = await auditRows(db, { action: 'hold.create', targetType: HOLD_TARGET, targetId: hold.id });
    expect(audits.map((x) => x.detail)).toEqual([{ kind: 'authority', user: a.publicUid, conversationId: matchId, reportId: report, authorityRef: 'REQ-42' }]);
    expect(JSON.stringify(audits[0]?.detail)).not.toContain(a.id);
    // The account is kept: its purge waits.
    expect((await row<{ v: boolean }>(db, `SELECT legal_hold_active($1, NULL) AS v`, [a.id])).v).toBe(true);
  });

  it('checks what a hold names: someone or a conversation, each of them there', async () => {
    const purged = await person('Purged', 8);
    expect(errorOf(await call('/v1/admin/holds', { kind: 'threat' }))).toMatchObject({ code: 'no_target' });
    expect(errorOf(await call('/v1/admin/holds', { user: 'aaaaaaaaaaaaa', kind: 'threat' }))).toMatchObject({ pointer: '/user', code: 'unknown_user' });
    expect(errorOf(await call('/v1/admin/holds', { user: purged.publicUid, kind: 'threat' }))).toMatchObject({ pointer: '/user', code: 'unknown_user' });
    expect(errorOf(await call('/v1/admin/holds', { conversationId: '99999999999', kind: 'threat' }))).toMatchObject({ pointer: '/conversationId', code: 'unknown_conversation' });
    const live = await person('Live');
    expect(errorOf(await call('/v1/admin/holds', { user: live.publicUid, reportId: '99999999999', kind: 'threat' }))).toMatchObject({ pointer: '/reportId', code: 'unknown_report' });
    expect(await auditRows(db, { action: 'hold.create', targetType: HOLD_TARGET })).toHaveLength(1);
    expect((await call('/v1/admin/holds', { user: live.publicUid, kind: 'threat' }, 'support')).statusCode).toBe(403);
    expect((await call('/v1/admin/holds', { user: live.publicUid, kind: 'threat' }, 'analyst')).statusCode).toBe(403);
  });

  it('releases with a reason, once; lists active and released holds newest first', async () => {
    const u = await person('To Release');
    const first = adminHoldSchema.parse((await call('/v1/admin/holds', { user: u.publicUid, kind: 'child_safety' })).json());
    const second = adminHoldSchema.parse((await call('/v1/admin/holds', { user: u.publicUid, kind: 'threat' })).json());
    const released = await call(`/v1/admin/holds/${first.id}/release`, { reason: 'The authority closed the case.' });
    expect(released.statusCode, released.body).toBe(200);
    expect(statements(released)).toBe(2);
    expect(adminHoldSchema.parse(released.json())).toMatchObject({ id: first.id, releasedReason: 'The authority closed the case.', releasedBy: { id: String(admins.get('moderator')!.account.id) } });
    const again = await call(`/v1/admin/holds/${first.id}/release`, { reason: 'Again.' });
    expect(again.statusCode).toBe(200);
    expect(statements(again)).toBe(1);
    expect(adminHoldSchema.parse(again.json()).releasedReason).toBe('The authority closed the case.');
    expect((await auditRows(db, { action: 'hold.release', targetType: HOLD_TARGET, targetId: first.id })).map((a) => a.detail)).toEqual([{ reason: 'The authority closed the case.' }]);

    const active = await call('/v1/admin/holds?limit=1');
    expect(statements(active)).toBe(1);
    const activePage = adminHoldPageSchema.parse(active.json());
    expect(activePage.items.map((x) => x.id)).toEqual([second.id]);
    const more = adminHoldPageSchema.parse((await call(`/v1/admin/holds?limit=1&cursor=${activePage.nextCursor}`)).json());
    expect(more.items.map((x) => x.id)).not.toContain(first.id);
    const releasedPage = adminHoldPageSchema.parse((await call('/v1/admin/holds?state=released')).json());
    expect(releasedPage.items.map((x) => x.id)).toContain(first.id);
    expect(releasedPage.items.map((x) => x.id)).not.toContain(second.id);
    expect((await call('/v1/admin/holds/99999999999/release', { reason: 'x' })).statusCode).toBe(404);
    expect((await call('/v1/admin/holds', undefined, 'support')).statusCode).toBe(403);
  });

  it('rolls back with a refused audit row: no hold, and a release leaves it active', async () => {
    const u = await person('Hold Refused');
    await refuseAudit(db, 'hold.create');
    expect((await call('/v1/admin/holds', { user: u.publicUid, kind: 'threat' })).statusCode).toBe(500);
    expect((await row<{ n: number }>(db, `SELECT count(*)::integer AS n FROM legal_holds WHERE user_id = $1`, [u.id])).n).toBe(0);
    await refuseAudit(db);
    const hold = adminHoldSchema.parse((await call('/v1/admin/holds', { user: u.publicUid, kind: 'threat' })).json());
    await refuseAudit(db, 'hold.release');
    expect((await call(`/v1/admin/holds/${hold.id}/release`, { reason: 'Closed.' })).statusCode).toBe(500);
    expect((await row<{ released: boolean }>(db, `SELECT released_at IS NOT NULL AS released FROM legal_holds WHERE id = $1`, [hold.id])).released).toBe(false);
  });
});
