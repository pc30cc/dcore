import {
  adminEvidenceSchema,
  adminHoldAndFileSchema,
  adminReportCloseSchema,
  adminReportDetailSchema,
  adminReportPageSchema,
  adminReportSummarySchema,
  problemSchemaFor,
} from '@app/shared';
import { CdnUrlSigner, FakeObjectStorage, FakeRealtimePublisher, type MediaStore } from '@app/shared/server';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { VIEW_CHAT_PER_HOUR } from '../src/routes/adminReports.js';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { json, migratedDatabase, row, seedUser, setAppConfig, statements, type SeededUser, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, auditRows, installAuditFailure, refuseAudit, startAdminHarness, type AdminHarness, type AdminSession } from './adminSupport.js';
import { seedAction, seedEvidenceReport, seedMatch, seedPhoto, seedReport } from './moderationSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * Reports in the admin panel, on PostgreSQL and Valkey: the four views and
 * their cursors (each from its index), a report's page (its filings, the
 * photos they name as they are now, holds, filing, actions, other reports,
 * history), the chat evidence (audited; the sender as a role; nothing
 * audited when nothing is shown), assignment races, closing with and
 * without an action, and filing with an authority (with the holds it
 * places).
 */

const ADMIN_IP = '93.184.216.34';
const REPORT_TARGET = 3;
const HOLD_TARGET = 16;

describe.skipIf(!hasInfrastructure)('admin: reports', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  const realtime = new FakeRealtimePublisher();
  const media: MediaStore = {
    storage: new FakeObjectStorage(),
    privateBucket: 'uploads',
    mediaBucket: 'media',
    urls: new CdnUrlSigner({ baseUrl: 'https://cdn.test.invalid', signingKey: 'admin-reports-cdn-signing-key-012345', scheme: 'hmac' }),
  };
  const admins = new Map<string, AdminSession>();
  const rawIds: string[] = [];
  const bodies: string[] = [];

  beforeAll(async () => {
    db = await migratedDatabase();
    await installAuditFailure(db);
    h = await startAdminHarness(db, {}, { jobs: new MemoryJobProducer(), realtime, media });
    for (const role of ['superadmin', 'admin', 'moderator', 'support', 'analyst']) admins.set(role, await adminAs(h, role));
    admins.set('moderator2', await adminAs(h, 'moderator'));
  }, 120_000);

  afterAll(async () => {
    for (const id of rawIds) for (const body of bodies) expect(body.includes(id), `raw id ${id} in a response`).toBe(false);
    await h?.close();
    await db?.drop();
  });

  beforeEach(async () => {
    await refuseAudit(db);
  });

  async function person(name: string): Promise<SeededUser> {
    const user = await seedUser(h, { name });
    rawIds.push(user.id);
    return user;
  }

  const tokenOf = (role: string) => admins.get(role)!.accessToken;
  const idOf = (role: string) => String(admins.get(role)!.account.id);

  async function get(url: string, role = 'moderator'): Promise<LightMyRequestResponse> {
    const response = await admin(h, url, undefined, { token: tokenOf(role), ip: ADMIN_IP });
    bodies.push(response.body);
    return response;
  }

  async function post(url: string, body: unknown = {}, role = 'moderator'): Promise<LightMyRequestResponse> {
    const response = await admin(h, url, body, { token: tokenOf(role), method: 'POST', ip: ADMIN_IP });
    bodies.push(response.body);
    return response;
  }

  const errorOf = (res: LightMyRequestResponse): unknown => {
    problemSchemaFor('field_invalid').parse(res.json());
    return (json(res)['errors'] as unknown[])[0];
  };

  const reportRow = (id: string) =>
    row<{ status: number; resolution: number | null; assigned_to: number | null; resolved_by: number | null; purge_days: number | null }>(
      db,
      `SELECT status, resolution, assigned_to, resolved_by, round(extract(epoch FROM evidence_purge_at - resolved_at) / 86400)::integer AS purge_days FROM reports WHERE id = $1`,
      [id],
    );

  // ─── Lists ────────────────────────────────────────────────────────────

  describe('lists', () => {
    it('shows the queue most urgent first, paged by (priority, id); mine and unassigned; closed newest first', async () => {
      await db.sql.query(`UPDATE reports SET status = 4, resolved_at = now() - interval '10 days' WHERE status IN (1, 2)`);
      const target = await person('Listed');
      const reporter = await person('Lister');
      const urgent = await seedReport(h, { targetId: target.id, reason: 8, priority: 100 });
      const middle = await seedReport(h, { targetId: target.id, reporterId: reporter.id, priority: 60 });
      const middleToo = await seedReport(h, { targetId: target.id, priority: 60 });
      const low = await seedReport(h, { targetId: target.id, priority: 20 });

      const first = await get('/v1/admin/reports?limit=2');
      expect(first.statusCode, first.body).toBe(200);
      expect(statements(first)).toBe(1);
      const page = adminReportPageSchema.parse(first.json());
      expect(page.items.map((r) => r.id)).toEqual([urgent, middle]);
      expect(page.items[0]).toMatchObject({ reason: 'child_safety', reported: { id: target.publicUid }, reporter: null, assignee: null, evidence: 'complete', filed: false });
      expect(page.items[1]?.reporter?.id).toBe(reporter.publicUid);
      const second = adminReportPageSchema.parse((await get(`/v1/admin/reports?limit=2&cursor=${page.nextCursor}`)).json());
      expect(second.items.map((r) => r.id)).toEqual([middleToo, low]);

      expect((await post(`/v1/admin/reports/${middle}/assign`, { to: idOf('moderator'), from: null })).statusCode).toBe(200);
      expect(adminReportPageSchema.parse((await get('/v1/admin/reports?view=mine')).json()).items.map((r) => r.id)).toEqual([middle]);
      expect(adminReportPageSchema.parse((await get('/v1/admin/reports?view=mine', 'admin')).json()).items).toEqual([]);
      expect(adminReportPageSchema.parse((await get('/v1/admin/reports?view=unassigned')).json()).items.map((r) => r.id)).toEqual([urgent, middleToo, low]);

      await post(`/v1/admin/reports/${low}/dismiss`, { resolution: 'no_violation' });
      await post(`/v1/admin/reports/${urgent}/resolve`, { resolution: 'content_removed' });
      const closed = adminReportPageSchema.parse((await get('/v1/admin/reports?view=resolved&limit=1')).json());
      expect(closed.items.map((r) => [r.id, r.status, r.resolution])).toEqual([[urgent, 'actioned', 'content_removed']]);
      const older = adminReportPageSchema.parse((await get(`/v1/admin/reports?view=resolved&limit=1&cursor=${closed.nextCursor}`)).json());
      expect(older.items.map((r) => [r.id, r.status, r.resolution])).toEqual([[low, 'dismissed', 'no_violation']]);
      // A cursor of the open views is not one of the closed view.
      expect((await get(`/v1/admin/reports?view=resolved&cursor=${page.nextCursor}`)).statusCode).toBe(400);
    });

    it('is for the roles holding reports.read', async () => {
      expect((await get('/v1/admin/reports', 'admin')).statusCode).toBe(200);
      const refused = await get('/v1/admin/reports', 'support');
      expect(refused.statusCode).toBe(403);
      problemSchemaFor('forbidden').parse(refused.json());
      expect((await get('/v1/admin/reports', 'analyst')).statusCode).toBe(403);
      expect((await admin(h, '/v1/admin/reports')).statusCode).toBe(401);
    });
  });

  // ─── A report's page and its evidence ─────────────────────────────────

  describe('report page', () => {
    async function chatReport() {
      const reported = await person('Reported Person');
      const reporter = await person('Reporter Person');
      const matchId = await seedMatch(h, reported.id, reporter.id);
      const photo = await seedPhoto(h, reported.id, { status: 3 });
      const prompt = Number((await row<{ id: number }>(db, `INSERT INTO prompt_defs (kind, i18n) VALUES (1, '{"en": "A good day", "fa": "یک روز خوب"}') RETURNING id`)).id);
      const filingId = h.app.ids.nextId();
      const nowMs = Date.now();
      const reportId = await seedEvidenceReport(h, {
        targetId: reported.id,
        reporterId: reporter.id,
        matchId,
        context: 2,
        reason: 2,
        details: 'They kept writing after I asked them to stop.',
        evidence: {
          v: 1,
          items: [
            {
              reportId: filingId,
              atMs: nowMs - 60_000,
              context: 2,
              reason: 2,
              details: 'They kept writing after I asked them to stop.',
              conversationId: matchId,
              messageIds: ['1001', '1002'],
              profile: { name: 'Reported Person', about: 'Hi', textState: 2, prompts: [{ promptId: prompt, answer: 'Tea', status: 2 }], photos: [photo, '999999999999'] },
            },
          ],
          chat: [
            {
              filingId,
              conversationId: matchId,
              takenAtMs: nowMs - 30_000,
              messages: [
                { id: '1001', senderId: reported.id, kind: 1, flags: 1, body: 'Answer me', atMs: nowMs - 120_000 },
                { id: '1002', senderId: reporter.id, kind: 1, flags: 0, body: 'Please stop', atMs: nowMs - 110_000 },
                { id: '1003', senderId: reported.id, kind: 2, flags: 0, atMs: nowMs - 100_000, fromStream: true },
              ],
            },
          ],
        },
      });
      return { reported, reporter, matchId, photo, prompt, filingId, reportId };
    }

    it('shows the filings with the profile as it was and the photos as they are, without the chat; two statements', async () => {
      const r = await chatReport();
      const other = await seedReport(h, { targetId: r.reported.id, reason: 7 });
      const res = await get(`/v1/admin/reports/${r.reportId}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBe(2);
      const detail = adminReportDetailSchema.parse(res.json());
      expect(detail).toMatchObject({
        id: r.reportId,
        reason: 'harassment',
        context: 'chat',
        details: 'They kept writing after I asked them to stop.',
        conversationId: r.matchId,
        holds: [],
        filing: null,
        actions: [],
        otherOpen: [{ id: other }],
        history: [],
      });
      expect(detail.childSafetyContact).toBeUndefined();
      expect(detail.filings).toHaveLength(1);
      expect(detail.filings[0]).toMatchObject({ id: r.filingId, context: 'chat', reason: 'harassment', messages: 2, conversationId: r.matchId });
      expect(detail.filings[0]?.profile).toMatchObject({
        name: 'Reported Person',
        about: 'Hi',
        textState: 'approved',
        prompts: [{ promptId: r.prompt, answer: 'Tea', status: 'approved' }],
        photos: [{ id: r.photo, status: 'approved' }, { id: '999999999999' }],
      });
      expect(detail.filings[0]?.profile?.photos[0]?.thumbUrl).toMatch(/^https:\/\/cdn\.test\.invalid\//);
      // No message of the chat is on the page.
      expect(res.body).not.toContain('Answer me');
      expect(res.body).not.toContain('Please stop');
      // A report naming no photo is one statement.
      const plain = await seedReport(h, { targetId: r.reported.id });
      expect(statements(await get(`/v1/admin/reports/${plain}`))).toBe(1);
      expect((await get('/v1/admin/reports/99999999999')).statusCode).toBe(404);
    });

    it('names whom to contact for a child-safety report, when set', async () => {
      const target = await person('Child Safety Target');
      const report = await seedReport(h, { targetId: target.id, reason: 8 });
      expect(adminReportDetailSchema.parse((await get(`/v1/admin/reports/${report}`)).json()).childSafetyContact).toBeUndefined();
      await setAppConfig(h, 'safety.child_safety_contact', { name: 'Safety Desk', email: 'safety@example.com' });
      expect(adminReportDetailSchema.parse((await get(`/v1/admin/reports/${report}`)).json()).childSafetyContact).toEqual({ name: 'Safety Desk', email: 'safety@example.com' });
      await setAppConfig(h, 'safety.child_safety_contact', { name: null, email: null });
    });

    it('shows the chat only through the audited evidence view, the senders as roles', async () => {
      const r = await chatReport();
      const res = await post(`/v1/admin/reports/${r.reportId}/evidence`);
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBe(2);
      expect(res.headers['cache-control']).toBe('no-store');
      const evidence = adminEvidenceSchema.parse(res.json());
      expect(evidence.chat).toHaveLength(1);
      // The filing named 1001 and 1002.
      expect(evidence.chat[0]?.messages.map((m) => [m.from, m.kind, m.body, m.flags, m.late, m.named])).toEqual([
        ['reported', 'text', 'Answer me', ['risky'], false, true],
        ['reporter', 'text', 'Please stop', [], false, true],
        ['reported', 'image', null, [], true, false],
      ]);
      expect(res.body).not.toContain(r.reported.id);
      expect(res.body).not.toContain(r.reporter.id);
      const audits = await auditRows(db, { action: 'report.view_chat', targetType: REPORT_TARGET, targetId: r.reportId });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ ip: ADMIN_IP, session_id: admins.get('moderator')!.sessionId, detail: { snapshots: 1, messages: 3 } });
      expect(JSON.stringify(audits[0]?.detail)).not.toContain('Answer me');
    });

    it('writes nothing when there is no chat to show, and shows nothing when the audit row is refused', async () => {
      const target = await person('No Chat');
      const plain = await seedReport(h, { targetId: target.id });
      const none = await post(`/v1/admin/reports/${plain}/evidence`);
      expect(adminEvidenceSchema.parse(none.json()).chat).toEqual([]);
      expect(statements(none)).toBe(1);
      expect(await auditRows(db, { action: 'report.view_chat', targetId: plain })).toEqual([]);

      const r = await chatReport();
      await refuseAudit(db, 'report.view_chat');
      const refused = await post(`/v1/admin/reports/${r.reportId}/evidence`);
      expect(refused.statusCode).toBe(500);
      expect(refused.body).not.toContain('Answer me');
      expect(await auditRows(db, { action: 'report.view_chat', targetId: r.reportId })).toEqual([]);
      expect((await post(`/v1/admin/reports/${r.reportId}/evidence`, {}, 'support')).statusCode).toBe(403);
      expect((await post('/v1/admin/reports/99999999999/evidence')).statusCode).toBe(404);
    });

    it('reads at most 60 chats an hour per admin, counting only the views it shows; fails closed', async () => {
      const r = await chatReport();
      const plain = await seedReport(h, { targetId: r.reported.id });
      const busy = await adminAs(h, 'moderator');
      const view = (reportId: string) => admin(h, `/v1/admin/reports/${reportId}/evidence`, {}, { token: busy.accessToken, method: 'POST', ip: ADMIN_IP });
      // Nothing shown (no chat, no such report) counts nothing.
      for (let i = 0; i < 5; i += 1) {
        expect((await view(plain)).statusCode).toBe(200);
        expect((await view('99999999999')).statusCode).toBe(404);
      }
      for (let i = 0; i < VIEW_CHAT_PER_HOUR; i += 1) expect((await view(r.reportId)).statusCode).toBe(200);
      const limited = await view(r.reportId);
      expect(limited.statusCode).toBe(429);
      problemSchemaFor('rate_limited').parse(limited.json());
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(limited.body).not.toContain('Answer me');
      expect((await auditRows(db, { action: 'report.view_chat', targetId: r.reportId })).filter((a) => a.admin_id === busy.account.id)).toHaveLength(VIEW_CHAT_PER_HOUR);
      // Another admin has their own count; Valkey down refuses the view.
      expect((await post(`/v1/admin/reports/${r.reportId}/evidence`)).statusCode).toBe(200);
      vi.spyOn(h.app.limits, 'take').mockRejectedValueOnce(new Error('valkey down'));
      expect((await post(`/v1/admin/reports/${r.reportId}/evidence`)).statusCode).toBe(503);
    });

    it('lists who did what when in its history, never an address or an audit detail', async () => {
      const r = await chatReport();
      expect((await post(`/v1/admin/reports/${r.reportId}/evidence`)).statusCode).toBe(200);
      expect((await post(`/v1/admin/reports/${r.reportId}/assign`, { to: idOf('moderator'), from: null })).statusCode).toBe(200);
      const res = await get(`/v1/admin/reports/${r.reportId}`);
      const detail = adminReportDetailSchema.parse(res.json());
      expect(detail.history.map((e) => e.action)).toEqual(['report.assign', 'report.view_chat']);
      for (const entry of json(res)['history'] as Record<string, unknown>[]) expect(Object.keys(entry).sort()).toEqual(['action', 'admin', 'at', 'id']);
      expect(res.body).not.toContain(ADMIN_IP);
      expect(res.body).not.toContain('"snapshots"');
    });
  });

  // ─── Assignment ───────────────────────────────────────────────────────

  describe('assign', () => {
    it('takes a report once: two admins at the same time, one wins, the other is told someone else took it', async () => {
      const target = await person('Race Target');
      const report = await seedReport(h, { targetId: target.id });
      const [a, b] = await Promise.all([
        post(`/v1/admin/reports/${report}/assign`, { to: idOf('moderator'), from: null }),
        post(`/v1/admin/reports/${report}/assign`, { to: idOf('moderator2'), from: null }, 'moderator2'),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
      const winner = a.statusCode === 200 ? a : b;
      expect(statements(winner)).toBe(2);
      const summary = adminReportSummarySchema.parse(winner.json());
      expect(summary.status).toBe('in_review');
      const loser = a.statusCode === 409 ? a : b;
      expect(json(loser)['detail']).toBe('Someone else took it.');
      expect(await auditRows(db, { action: 'report.assign', targetType: REPORT_TARGET, targetId: report })).toHaveLength(1);
    });

    it('gives back, refuses a disabled admin (422) and a closed report (409); the same assignment twice changes nothing', async () => {
      const target = await person('Assign Target');
      const report = await seedReport(h, { targetId: target.id });
      await post(`/v1/admin/reports/${report}/assign`, { to: idOf('moderator'), from: null });
      const same = await post(`/v1/admin/reports/${report}/assign`, { to: idOf('moderator'), from: idOf('moderator') });
      expect(same.statusCode).toBe(200);
      expect(statements(same)).toBe(1);
      const disabled = await adminAs(h, 'moderator');
      await db.sql.query(`UPDATE admin_users SET disabled_at = now() WHERE id = $1`, [disabled.account.id]);
      expect(errorOf(await post(`/v1/admin/reports/${report}/assign`, { to: String(disabled.account.id), from: idOf('moderator') }))).toMatchObject({ pointer: '/to', code: 'unknown_admin' });
      const back = await post(`/v1/admin/reports/${report}/assign`, { to: null, from: idOf('moderator') });
      expect(adminReportSummarySchema.parse(back.json())).toMatchObject({ status: 'open', assignee: null });
      expect((await auditRows(db, { action: 'report.assign', targetId: report })).map((r) => r.detail)).toEqual([
        { before: { assignee: null, status: 'open' }, after: { assignee: idOf('moderator'), status: 'in_review' } },
        { before: { assignee: idOf('moderator'), status: 'in_review' }, after: { assignee: null, status: 'open' } },
      ]);
      await post(`/v1/admin/reports/${report}/dismiss`, { resolution: 'duplicate' });
      expect((await post(`/v1/admin/reports/${report}/assign`, { to: idOf('moderator'), from: null })).statusCode).toBe(409);
      expect((await post(`/v1/admin/reports/${report}/assign`, { to: idOf('moderator'), from: null }, 'support')).statusCode).toBe(403);
    });
  });

  // ─── Closing ──────────────────────────────────────────────────────────

  describe('resolve and dismiss', () => {
    it('closes with an action, the person’s other open reports too when asked; the evidence is emptied after the retention', async () => {
      const target = await person('Close Target');
      const one = await seedReport(h, { targetId: target.id });
      const two = await seedReport(h, { targetId: target.id });
      // Never swept along: a threat report and one of another reason.
      const threat = await seedReport(h, { targetId: target.id, reason: 6 });
      const spam = await seedReport(h, { targetId: target.id, reason: 7 });
      // "Closed with a suspension" needs the suspension: none taken yet is a 422 that closes nothing.
      const early = await post(`/v1/admin/reports/${one}/resolve`, { resolution: 'suspension', sameTarget: true });
      expect(errorOf(early)).toMatchObject({ pointer: '/resolution', code: 'wrong_resolution' });
      expect((await reportRow(one)).status).toBe(1);
      await seedAction(h, target.id, 2, 'Suspended for a week.', { reportId: one });
      const res = await post(`/v1/admin/reports/${one}/resolve`, { resolution: 'suspension', note: 'Suspended for a week.', sameTarget: true });
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBe(2);
      const body = adminReportCloseSchema.parse(res.json());
      expect(body.items.map((r) => [r.id, r.status, r.resolution])).toEqual([
        [one, 'actioned', 'suspension'],
        [two, 'actioned', 'suspension'],
      ]);
      for (const open of [threat, spam]) expect((await reportRow(open)).status).toBe(1);
      expect(await reportRow(one)).toMatchObject({ status: 3, resolution: 2, resolved_by: Number(idOf('moderator')), purge_days: 365 });
      for (const id of [one, two]) {
        const audits = await auditRows(db, { action: 'report.resolve', targetType: REPORT_TARGET, targetId: id });
        expect(audits.map((a) => a.detail)).toEqual([{ status: 'actioned', resolution: 'suspension', note: 'Suspended for a week.', sameTarget: true }]);
      }
      expect(json(await post(`/v1/admin/reports/${one}/dismiss`, { resolution: 'no_violation' }))['detail']).toBe('Already closed.');
    });

    it('closes a person’s reports from two admins at the same time: one closes them all, the other is told they are closed', async () => {
      for (let round = 0; round < 5; round += 1) {
        const target = await person(`Close Race ${round}`);
        const first = await seedReport(h, { targetId: target.id });
        const second = await seedReport(h, { targetId: target.id });
        const third = await seedReport(h, { targetId: target.id });
        const [a, b] = await Promise.all([
          post(`/v1/admin/reports/${first}/resolve`, { resolution: 'other_action', sameTarget: true }),
          post(`/v1/admin/reports/${third}/dismiss`, { resolution: 'no_violation', sameTarget: true }, 'moderator2'),
        ]);
        expect([a.statusCode, b.statusCode].sort(), `${a.body} ${b.body}`).toEqual([200, 409]);
        const loser = a.statusCode === 409 ? a : b;
        expect(json(loser)['detail']).toBe('Already closed.');
        const winner = adminReportCloseSchema.parse((a.statusCode === 200 ? a : b).json());
        expect(winner.items.map((r) => r.id).sort()).toEqual([first, second, third].sort());
        const statuses = await Promise.all([first, second, third].map(async (id) => (await reportRow(id)).status));
        expect(new Set(statuses).size).toBe(1);
      }
    });

    it('closes without an action (a duplicate is its own status); a resolution of the other group is refused', async () => {
      const target = await person('Dismiss Target');
      const dup = await seedReport(h, { targetId: target.id });
      const keep = await seedReport(h, { targetId: target.id });
      expect(errorOf(await post(`/v1/admin/reports/${dup}/dismiss`, { resolution: 'ban' }))).toMatchObject({ pointer: '/resolution', code: 'wrong_resolution' });
      expect(errorOf(await post(`/v1/admin/reports/${dup}/resolve`, { resolution: 'no_violation' }))).toMatchObject({ pointer: '/resolution', code: 'wrong_resolution' });
      const res = await post(`/v1/admin/reports/${dup}/dismiss`, { resolution: 'duplicate' });
      expect(adminReportCloseSchema.parse(res.json()).items.map((r) => [r.id, r.status])).toEqual([[dup, 'duplicate']]);
      expect((await reportRow(keep)).status).toBe(1);
      expect((await post('/v1/admin/reports/99999999999/dismiss', { resolution: 'other' })).statusCode).toBe(404);
      expect((await post(`/v1/admin/reports/${keep}/dismiss`, { resolution: 'other' }, 'support')).statusCode).toBe(403);
    });

    it('shows a role that reads and closes reports but may not see shadowbans no shadowban resolution, and answers its shadowban close alike either way', async () => {
      await db.sql.query(`INSERT INTO admin_roles (id, key, names) VALUES (42, 'report_closer', '{"en": "Report closer"}') ON CONFLICT (key) DO NOTHING`);
      await db.sql.query(`INSERT INTO admin_role_permissions (role_id, permission) VALUES (42, 'users.read'), (42, 'reports.read'), (42, 'reports.resolve') ON CONFLICT DO NOTHING`);
      await h.app.adminAuth.roles.reload();
      admins.set('report_closer', await adminAs(h, 'report_closer'));

      const hidden = await person('Quietly Hidden');
      const closed = await seedReport(h, { targetId: hidden.id });
      const stillOpen = await seedReport(h, { targetId: hidden.id, reason: 7 });
      await seedAction(h, hidden.id, 4, 'Spam.', { reportId: closed });
      expect((await post(`/v1/admin/reports/${closed}/resolve`, { resolution: 'shadowban' })).statusCode).toBe(200);
      const plain = await person('Not Hidden');
      const plainReport = await seedReport(h, { targetId: plain.id });

      // The moderator reads the resolution as it is.
      expect(adminReportDetailSchema.parse((await get(`/v1/admin/reports/${closed}`)).json()).resolution).toBe('shadowban');

      const detail = await get(`/v1/admin/reports/${closed}`, 'report_closer');
      expect(detail.statusCode, detail.body).toBe(200);
      const page = adminReportDetailSchema.parse(detail.json());
      expect(page).toMatchObject({ resolution: 'other_action', reported: { id: hidden.publicUid } });
      expect(page.actions.map((a) => a.kind)).not.toContain('shadowban');
      expect(detail.body).not.toContain('shadowban');
      const resolved = await get('/v1/admin/reports?view=resolved&limit=100', 'report_closer');
      expect(adminReportPageSchema.parse(resolved.json()).items.find((r) => r.id === closed)?.resolution).toBe('other_action');
      expect(resolved.body).not.toContain('shadowban');
      const tab = await get(`/v1/admin/users/${hidden.publicUid}/reports?side=received`, 'report_closer');
      expect(tab.statusCode, tab.body).toBe(200);
      expect(adminReportPageSchema.parse(tab.json()).items.find((r) => r.id === closed)?.resolution).toBe('other_action');
      expect(tab.body).not.toContain('shadowban');

      // Closing as "shadowban" is refused before anything is read: the same answer for a shadowbanned person and for one who is not.
      const onHidden = await post(`/v1/admin/reports/${stillOpen}/resolve`, { resolution: 'shadowban' }, 'report_closer');
      const onPlain = await post(`/v1/admin/reports/${plainReport}/resolve`, { resolution: 'shadowban' }, 'report_closer');
      expect([onHidden.statusCode, onPlain.statusCode]).toEqual([422, 422]);
      expect(errorOf(onHidden)).toEqual(errorOf(onPlain));
      expect(errorOf(onHidden)).toMatchObject({ pointer: '/resolution', code: 'wrong_resolution' });
      expect(statements(onHidden)).toBe(0);
      for (const id of [stillOpen, plainReport]) expect((await reportRow(id)).status).toBe(1);

      // Another action closes as usual, and its answer names no shadowban either.
      const other = await post(`/v1/admin/reports/${stillOpen}/resolve`, { resolution: 'other_action' }, 'report_closer');
      expect(other.statusCode, other.body).toBe(200);
      expect(adminReportCloseSchema.parse(other.json()).items.map((r) => [r.id, r.resolution])).toEqual([[stillOpen, 'other_action']]);
    });

    it('rolls back with a refused audit row', async () => {
      const target = await person('Close Refused');
      const report = await seedReport(h, { targetId: target.id });
      await refuseAudit(db, 'report.dismiss');
      expect((await post(`/v1/admin/reports/${report}/dismiss`, { resolution: 'other' })).statusCode).toBe(500);
      expect(await reportRow(report)).toMatchObject({ status: 1, resolution: null, resolved_by: null, purge_days: null });
      await refuseAudit(db, 'report.resolve');
      expect((await post(`/v1/admin/reports/${report}/resolve`, { resolution: 'content_removed', sameTarget: true })).statusCode).toBe(500);
      expect(await reportRow(report)).toMatchObject({ status: 1, resolution: null });
      await refuseAudit(db, 'report.assign');
      expect((await post(`/v1/admin/reports/${report}/assign`, { to: idOf('moderator'), from: null })).statusCode).toBe(500);
      expect(await reportRow(report)).toMatchObject({ status: 1, assigned_to: null });
    });
  });

  // ─── Filing ───────────────────────────────────────────────────────────

  describe('hold and file', () => {
    it('files once and holds the account and the conversation; the hold’s kind follows the report', async () => {
      const reported = await person('Filed Target');
      const reporter = await person('Filed Reporter');
      const matchId = await seedMatch(h, reported.id, reporter.id);
      const report = await seedEvidenceReport(h, { targetId: reported.id, reporterId: reporter.id, matchId, reason: 6 });
      const res = await post(`/v1/admin/reports/${report}/hold-and-file`, { authority: 'police', externalRef: 'CASE-2026-77' });
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBe(2);
      const body = adminHoldAndFileSchema.parse(res.json());
      expect(body.filing).toMatchObject({ authority: 'police', externalRef: 'CASE-2026-77', filedBy: { id: idOf('moderator') } });
      expect(body.holds.map((h) => [h.kind, h.user?.id ?? null, h.conversationId]).sort()).toEqual(
        [
          ['threat', null, matchId],
          ['threat', reported.publicUid, null],
        ].sort(),
      );
      expect(body.holds.every((h) => h.filing?.authority === 'police' && h.reportId === report)).toBe(true);
      const filed = await auditRows(db, { action: 'report.file', targetType: REPORT_TARGET, targetId: report });
      expect(filed).toHaveLength(1);
      expect(filed[0]?.detail).toMatchObject({ authority: 'police', externalRef: 'CASE-2026-77' });
      expect([...((filed[0]?.detail?.['holds'] as string[] | undefined) ?? [])].sort()).toEqual(body.holds.map((x) => x.id).sort());
      for (const hold of body.holds) {
        const created = await auditRows(db, { action: 'hold.create', targetType: HOLD_TARGET, targetId: hold.id });
        expect(created).toHaveLength(1);
        expect(JSON.stringify(created[0]?.detail)).not.toContain(reported.id);
      }
      const again = await post(`/v1/admin/reports/${report}/hold-and-file`, { authority: 'police' });
      expect(again.statusCode).toBe(409);
      expect(json(again)['detail']).toBe('Already filed.');
      const page = adminReportDetailSchema.parse((await get(`/v1/admin/reports/${report}`)).json());
      expect(page.filing?.authority).toBe('police');
      expect(page.holds).toHaveLength(2);
      expect(page.filed).toBe(true);
      expect(page.history.map((e) => e.action)).toEqual(['report.file']);
    });

    it('keeps the automatic child-safety holds and adds none twice', async () => {
      const reported = await person('Child Safety Filed');
      const report = await seedEvidenceReport(h, { targetId: reported.id, reason: 8 });
      await db.sql.query(`INSERT INTO legal_holds (id, user_id, report_id, kind) VALUES ($1, $2, $3, 1)`, [h.app.ids.nextId(), reported.id, report]);
      const body = adminHoldAndFileSchema.parse((await post(`/v1/admin/reports/${report}/hold-and-file`, { authority: 'ncmec' })).json());
      expect(body.holds.map((h) => [h.kind, h.createdBy])).toEqual([['child_safety', null]]);
      const created = (await auditRows(db, { action: 'hold.create', targetType: HOLD_TARGET })).filter((a) => a.detail?.['reportId'] === report);
      expect(created).toEqual([]);
    });

    it('rolls back with a refused audit row: no filing, no hold', async () => {
      const reported = await person('Filing Refused');
      const report = await seedReport(h, { targetId: reported.id });
      for (const action of ['hold.create', 'report.file']) {
        await refuseAudit(db, action);
        expect((await post(`/v1/admin/reports/${report}/hold-and-file`, { authority: 'other' })).statusCode).toBe(500);
      }
      expect((await row<{ n: number }>(db, `SELECT ((SELECT count(*) FROM report_filings WHERE report_id = $1) + (SELECT count(*) FROM legal_holds WHERE report_id = $1))::integer AS n`, [report])).n).toBe(0);
      expect((await post(`/v1/admin/reports/${report}/hold-and-file`, { authority: 'other' }, 'support')).statusCode).toBe(403);
      expect((await post('/v1/admin/reports/99999999999/hold-and-file', { authority: 'other' })).statusCode).toBe(404);
    });
  });

  it('keeps an evidence purge time a day apart per retention day', async () => {
    await setAppConfig(h, 'retention.report_evidence_days', 30);
    const target = await person('Short Retention');
    const report = await seedReport(h, { targetId: target.id });
    await post(`/v1/admin/reports/${report}/dismiss`, { resolution: 'not_enough_evidence' });
    expect((await reportRow(report)).purge_days).toBe(30);
    await setAppConfig(h, 'retention.report_evidence_days', 365);
  });
});
