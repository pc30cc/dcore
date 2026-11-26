import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminAuditAdminsSchema, auditActions, auditPageSchema, problemSchemaFor, type AuditEntry } from '@app/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { csvCell } from '../src/routes/adminAudit.js';
import { json, migratedDatabase, row, seedUser, statements, type SeededUser, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, auditRows, installAuditFailure, refuseAudit, seedAdmin, signIn, startAdminHarness, type AdminHarness, type AdminSession } from './adminSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * The audit log in the admin panel: its search by admin, target, action
 * and time (each alone and combined, a time range read as an id range), the
 * admins it filters by, and the CSV export (quoting, the formula guard, the
 * 10,000-row bound, its own audit row and its hourly limit). And the list of
 * actions the panel names (`auditActions`) against what the API writes.
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('the audit actions', () => {
  it('names every action the API writes, and nothing it does not', () => {
    const written = new Set<string>();
    const everywhere = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/'([a-z_]+\.[a-z_]+)'/g)) everywhere.add(m[1]!);
      // An action is written as `action: '…'` (a choice of two: `action: x ? '…' : '…'`), or passed to a helper next to its trail.
      for (const m of text.matchAll(/\baction: ([^,\n}]*)/g)) for (const lit of m[1]!.matchAll(/'([a-z_]+\.[a-z_]+)'/g)) written.add(lit[1]!);
      for (const m of text.matchAll(/\btrail, '([a-z_]+\.[a-z_]+)'/g)) written.add(m[1]!);
      // Or kept in a table typed with the action type (`… satisfies Record<…, AuditAction>`).
      for (const line of text.split('\n').filter((l) => l.includes('AuditAction>'))) for (const lit of line.matchAll(/'([a-z_]+\.[a-z_]+)'/g)) written.add(lit[1]!);
      // No action is put together from parts: each is a literal the type checks.
      expect(text, file).not.toMatch(/action: `/);
    }
    // The settings saves write theirs in SQL (packages/db: config.update).
    written.add('config.update');
    expect([...written].sort()).toEqual([...auditActions].sort());
    for (const action of auditActions) expect(everywhere.has(action) || action === 'config.update', action).toBe(true);
  });
});

describe('csvCell', () => {
  it.each([
    ['plain', 'plain'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['two\nlines', '"two\nlines"'],
    ['=SUM(A1)', "'=SUM(A1)"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@cmd', "'@cmd"],
    ['\tx', "'\tx"],
    ['=a,b', '"\'=a,b"'],
    ['', ''],
  ])('%j → %j', (value, cell) => {
    expect(csvCell(value)).toBe(cell);
  });
});

describe.skipIf(!hasInfrastructure)('admin: the audit log', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  const admins = new Map<string, AdminSession>();
  let person: SeededUser;
  /** The first instant of the month after this one: rows seeded there sort before everything the suite writes now. */
  let base: number;

  beforeAll(async () => {
    db = await migratedDatabase();
    await installAuditFailure(db);
    h = await startAdminHarness(db);
    for (const role of ['superadmin', 'admin', 'moderator', 'analyst']) admins.set(role, await adminAs(h, role));
    person = await seedUser(h, { name: 'Audited Person' });
    const now = new Date();
    base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    const a = admins.get('admin')!.account.id;
    const m = admins.get('moderator')!.account.id;
    // Day 1 (next month): two by the admin; day 2: one by the moderator; day 3: the system, and a term change.
    await seed(0, { admin: a, action: 'user.ban', targetType: 1, targetId: person.id, detail: { reason: 'spam' } });
    await seed(1, { admin: a, action: 'user.warn', targetType: 1, targetId: person.id, detail: { note: 'a "quoted", note' } });
    await seed(26, { admin: m, action: 'user.ban', targetType: 1, targetId: '1234567', detail: null, ip: '203.0.113.9' });
    await seed(50, { admin: null, action: 'hold.create', targetType: 16, targetId: '777', detail: { kind: 'threat' } });
    await seed(51, { admin: m, action: 'banned_term.update', targetType: 17, targetId: '12', detail: { changed: ['severity'] } });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await db?.drop();
  });

  beforeEach(async () => {
    await refuseAudit(db);
  });

  /** An audit row at `hours` after `base` (its id carries the time). */
  async function seed(hours: number, entry: { admin: number | null; action: string; targetType: number; targetId: string | null; detail: Record<string, unknown> | null; ip?: string }): Promise<void> {
    await db.sql.query(
      `INSERT INTO audit_log (id, admin_id, target_type, target_id, action, ip, detail)
       VALUES (id_floor(to_timestamp($1::bigint / 1000.0)) + (nextval('id_seq') % 4096), $2, $3, $4, $5, $6, $7)`,
      [base + hours * 3_600_000, entry.admin, entry.targetType, entry.targetId, entry.action, entry.ip ?? '198.51.100.7', entry.detail],
    );
  }

  async function as(role: string, url: string, body?: unknown, token?: string): Promise<LightMyRequestResponse> {
    return admin(h, url, body, { token: token ?? admins.get(role)!.accessToken });
  }

  const day = (offset: number) => new Date(base + offset * 86_400_000).toISOString().slice(0, 10);
  const search = async (query: string): Promise<AuditEntry[]> => {
    const res = await as('admin', `/v1/admin/audit?limit=100&${query}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(statements(res)).toBe(1);
    return auditPageSchema.parse(res.json()).items;
  };
  const actions = (entries: AuditEntry[]) => entries.map((e) => e.action);

  it('lists newest first in one statement, a person by public id only', async () => {
    const items = await search(`from=${day(0)}`);
    expect(actions(items)).toEqual(['banned_term.update', 'hold.create', 'user.ban', 'user.warn', 'user.ban']);
    const ban = items.at(-1)!;
    expect(ban).toMatchObject({ targetType: 'user', targetRef: null, user: person.publicUid, admin: { id: String(admins.get('admin')!.account.id) }, ip: '198.51.100.7', detail: { reason: 'spam' } });
    expect(items.find((e) => e.action === 'hold.create')).toMatchObject({ admin: null, targetType: 'legal_hold', targetRef: '777' });
    expect(JSON.stringify(items)).not.toContain(person.id);
  });

  it('filters by admin, action, target and time, each alone and combined, with a cursor', async () => {
    const a = admins.get('admin')!.account.id;
    const m = admins.get('moderator')!.account.id;
    expect(actions(await search(`from=${day(0)}&admin=${a}`))).toEqual(['user.warn', 'user.ban']);
    expect(actions(await search(`from=${day(0)}&action=user.ban`))).toEqual(['user.ban', 'user.ban']);
    expect(actions(await search(`targetType=user&target=${person.publicUid}`))).toEqual(['user.warn', 'user.ban']);
    expect(actions(await search(`targetType=banned_term`))).toEqual(['banned_term.update']);
    expect(actions(await search(`targetType=legal_hold&target=777`))).toEqual(['hold.create']);
    expect(actions(await search(`from=${day(1)}&to=${day(1)}`))).toEqual(['user.ban']);
    expect(actions(await search(`from=${day(2)}`))).toEqual(['banned_term.update', 'hold.create']);
    expect(actions(await search(`from=${day(0)}&to=${day(0)}`))).toEqual(['user.warn', 'user.ban']);
    // An instant bound is exclusive at the end.
    expect(actions(await search(`from=${new Date(base).toISOString()}&to=${new Date(base + 3_600_000).toISOString()}`))).toEqual(['user.ban']);
    expect(actions(await search(`admin=${m}&action=user.ban&from=${day(0)}`))).toEqual(['user.ban']);
    expect(actions(await search(`admin=${a}&action=user.ban&targetType=user&target=${person.publicUid}`))).toEqual(['user.ban']);
    // The public id of nobody matches nothing (one read); a well-formed id that decodes to no account answers the
    // same empty page without reading (whether a given string decodes depends on the key).
    expect(await search(`targetType=user&target=${h.app.publicIds.user.encode(987_654_321_987n)}`)).toEqual([]);
    for (const target of ['aaaaaaaaaaaaa', 'zzzzzzzzzzzzz', '2222222222222']) {
      const res = await as('admin', `/v1/admin/audit?targetType=user&target=${target}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBeLessThanOrEqual(1);
      expect(auditPageSchema.parse(res.json()).items).toEqual([]);
    }

    const first = auditPageSchema.parse((await as('admin', `/v1/admin/audit?from=${day(0)}&limit=2`)).json());
    expect(actions(first.items)).toEqual(['banned_term.update', 'hold.create']);
    const second = auditPageSchema.parse((await as('admin', `/v1/admin/audit?from=${day(0)}&limit=2&cursor=${first.nextCursor}`)).json());
    expect(actions(second.items)).toEqual(['user.ban', 'user.warn']);

    for (const bad of ['target=12', 'targetType=user&target=12', 'targetType=report&target=abc', 'action=user.nope', `from=${day(2)}&to=${day(0)}`, 'cursor=bm9wZQ', 'admin=0']) {
      const res = await as('admin', `/v1/admin/audit?${bad}`);
      expect(res.statusCode, bad).toBe(400);
      problemSchemaFor('validation_failed').parse(res.json());
    }
  });

  it('is for audit.read only; lists the admins to filter by, disabled ones marked', async () => {
    expect((await as('moderator', '/v1/admin/audit')).statusCode).toBe(403);
    expect((await as('analyst', '/v1/admin/audit')).statusCode).toBe(403);
    expect((await admin(h, '/v1/admin/audit')).statusCode).toBe(401);
    expect((await as('moderator', '/v1/admin/audit/admins')).statusCode).toBe(403);
    expect((await as('moderator', '/v1/admin/audit/export', {})).statusCode).toBe(403);
    const gone = await seedAdmin(h, { roles: ['support'] });
    await db.sql.query('UPDATE admin_users SET disabled_at = now() WHERE id = $1', [gone.id]);
    const res = await as('admin', '/v1/admin/audit/admins');
    expect(res.statusCode).toBe(200);
    expect(statements(res)).toBe(1);
    const { items } = adminAuditAdminsSchema.parse(res.json());
    expect(items.find((x) => x.id === String(gone.id))).toMatchObject({ disabled: true });
    expect(items.find((x) => x.id === String(admins.get('admin')!.account.id))).toMatchObject({ disabled: false });
    expect(JSON.stringify(items)).not.toContain('@');
  });

  it('exports the rows of a filter as CSV, audits the export, and guards cells a spreadsheet would run', async () => {
    const formula = await seedAdmin(h, { roles: ['admin'] });
    await db.sql.query(`UPDATE admin_users SET display_name = '=HYPERLINK("x")' WHERE id = $1`, [formula.id]);
    await seed(60, { admin: formula.id, action: 'plan.update', targetType: 15, targetId: '3', detail: { name: '+plan, "gold"' } });
    const session = await signIn(h, formula);
    const res = await as('admin', '/v1/admin/audit/export', { from: day(0) }, session.accessToken);
    expect(res.statusCode, res.body).toBe(200);
    expect(statements(res)).toBe(2);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="audit-${day(0)}.csv"`);
    expect(res.headers['cache-control']).toBe('no-store');
    const lines = res.body.replace(/^\uFEFF/, '').split('\r\n');
    expect(lines[0]).toBe('time,admin_id,admin,action,target_type,target,ip,detail');
    expect(lines.at(-1)).toBe('');
    expect(lines).toHaveLength(1 + 6 + 1);
    expect(lines[1]).toBe(`${new Date(base + 60 * 3_600_000).toISOString()},${formula.id},"'=HYPERLINK(""x"")",plan.update,plan,3,198.51.100.7,"{""name"":""+plan, \\""gold\\""""}"`);
    expect(lines.some((l) => l.includes(`,user.ban,user,${person.publicUid},`))).toBe(true);
    expect(res.body).not.toContain(person.id);
    const exported = await auditRows(db, { action: 'audit.export', targetType: 0 });
    expect(exported.at(-1)).toMatchObject({ admin_id: formula.id, target_id: null, detail: { filters: { from: day(0) }, rows: 6 } });
  });

  it('refuses more than 10,000 rows, writes nothing for it, and allows 10 exports an hour per admin', async () => {
    const bulk = await adminAs(h, 'admin');
    await db.sql.query(
      `INSERT INTO audit_log (id, admin_id, target_type, action, detail)
       SELECT id_floor(to_timestamp($1::bigint / 1000.0)) + g, $2, 0, 'config.update', NULL FROM generate_series(1, 10001) g`,
      [base + 70 * 3_600_000, bulk.account.id],
    );
    const before = (await auditRows(db, { action: 'audit.export', targetType: 0 })).length;
    const tooMany = await as('admin', '/v1/admin/audit/export', { admin: String(bulk.account.id) }, bulk.accessToken);
    expect(tooMany.statusCode).toBe(422);
    expect((json(tooMany)['errors'] as { code: string }[])[0]?.code).toBe('too_many_rows');
    expect(await auditRows(db, { action: 'audit.export', targetType: 0 })).toHaveLength(before);
    // The refused one did not count: ten more go through, the eleventh waits.
    for (let i = 0; i < 10; i += 1) expect((await as('admin', '/v1/admin/audit/export', { action: 'user.warn' }, bulk.accessToken)).statusCode).toBe(200);
    const limited = await as('admin', '/v1/admin/audit/export', { action: 'user.warn' }, bulk.accessToken);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    vi.spyOn(h.app.limits, 'take').mockRejectedValueOnce(new Error('valkey down'));
    expect((await as('admin', '/v1/admin/audit/export', { action: 'user.warn' })).statusCode).toBe(503);
    expect((await as('admin', '/v1/admin/audit/export', { target: '5' })).statusCode).toBe(400);
  });

  it('sends no file when its audit row is refused', async () => {
    await refuseAudit(db, 'audit.export');
    const res = await as('superadmin', '/v1/admin/audit/export', { action: 'user.ban' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('user.ban,');
    expect((await row<{ n: number }>(db, `SELECT count(*)::integer AS n FROM audit_log WHERE action = 'audit.export' AND admin_id = $1`, [admins.get('superadmin')!.account.id])).n).toBe(0);
  });

  it("shows an admin row's e-mail, roles and two-factor state to admins.read (the owner) only, on the page and in the file", async () => {
    const detail = {
      before: { displayName: 'Ops Lead', roles: ['support'], disabled: false, totpEnabled: false },
      after: { displayName: 'Ops Lead', roles: ['admin'], disabled: false, totpEnabled: true },
      email: 'ops.lead@example.org',
      signedOutSessions: 2,
    };
    await seed(90, { admin: null, action: 'admin.update', targetType: 7, targetId: '424242', detail });
    const query = 'targetType=admin&target=424242';
    const read = async (role: string) => {
      const res = await as(role, `/v1/admin/audit?${query}`);
      expect(res.statusCode, res.body).toBe(200);
      return auditPageSchema.parse(res.json()).items;
    };
    // The seeded admin role reads the audit log but not the admin list.
    expect((await as('admin', '/v1/admin/admins')).statusCode).toBe(403);
    const [redacted] = await read('admin');
    expect(redacted?.detail).toEqual({ before: { displayName: 'Ops Lead', disabled: false }, after: { displayName: 'Ops Lead', disabled: false }, signedOutSessions: 2 });
    const [full] = await read('superadmin');
    expect(full?.detail).toEqual(detail);

    const file = await as('admin', '/v1/admin/audit/export', { targetType: 'admin', target: '424242' });
    expect(file.statusCode, file.body).toBe(200);
    expect(file.body).toContain('Ops Lead');
    expect(file.body).not.toContain('ops.lead@example.org');
    expect(file.body).not.toContain('totpEnabled');
    expect(file.body).not.toContain('roles');
    const ownerFile = await as('superadmin', '/v1/admin/audit/export', { targetType: 'admin', target: '424242' });
    expect(ownerFile.body).toContain('ops.lead@example.org');
  });
});
