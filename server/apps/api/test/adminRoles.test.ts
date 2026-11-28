import { adminRoleHoldersSchema, adminRoleListSchema, adminRoleUpdatedSchema, problemSchemaFor, type AdminRoleUpdated } from '@app/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { statements, migratedDatabase, row, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, lastAudit, seedAdmin, signIn, startAdminHarness, type AdminHarness, type AdminSession } from './adminSupport.js';
import { hasInfrastructure } from './support.js';
import { grantPastRules, waitUntil } from './systemSupport.js';

/**
 * The role editor (`PUT /v1/admin/roles/:key/permissions`,
 * `GET /v1/admin/roles/holders`): the owner edits a role's grants within the
 * rules, every API process takes the change through `cfg:changed`, taking
 * access away signs the role's holders out at once, and every refusal is
 * worded by its reason; the owner role, '*', users.chats off the admin role
 * and the analyst beyond dashboards are refused to everyone; a delegated
 * manager stays within its own access.
 */

describe.skipIf(!hasInfrastructure)('admin: the role editor', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  let owner: AdminSession;
  let roleId = 70;

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startAdminHarness(db);
    owner = await adminAs(h, 'superadmin');
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await db?.drop();
  });

  const put = (key: string, body: unknown, session: { accessToken: string } = owner) => admin(h, `/v1/admin/roles/${key}/permissions`, body, { token: session.accessToken, method: 'PUT' });
  const roles = async () => adminRoleListSchema.parse((await admin(h, '/v1/admin/roles', undefined, { token: owner.accessToken })).json()).items;
  const grantsOf = async (key: string) => (await roles()).find((r) => r.key === key)!.grants;
  const stored = async (key: string) =>
    (await row<{ grants: string[] }>(db, `SELECT ARRAY(SELECT p.permission FROM admin_role_permissions p JOIN admin_roles r ON r.id = p.role_id WHERE r.key = $1 ORDER BY 1) AS grants`, [key])).grants;
  const reason = (res: LightMyRequestResponse) => res.json<{ reason?: string }>().reason;
  const fieldCode = (res: LightMyRequestResponse) => res.json<{ errors?: { pointer: string; code: string }[] }>().errors?.[0];

  /** A role of the test's own (rules apply as to any role). */
  async function customRole(key: string, grants: readonly string[]): Promise<string> {
    roleId += 1;
    await db.sql.query(`INSERT INTO admin_roles (id, key, names) VALUES ($1, $2, '{"en": "Custom"}')`, [roleId, key]);
    for (const grant of grants) await db.sql.query(`INSERT INTO admin_role_permissions (role_id, permission) VALUES ($1, $2)`, [roleId, grant]);
    await h.app.adminAuth.roles.reload();
    return key;
  }

  it('widens a role: the answer, the audit row, every process after the announcement, nobody signed out', async () => {
    const holder = await adminAs(h, 'support');
    const before = await grantsOf('support');
    expect(before).toEqual(['dashboard.read', 'support.*', 'users.read']);
    const res = await put('support', { grants: [...before, 'campaigns.read'], base: before });
    expect(res.statusCode, res.body).toBe(200);
    expect(statements(res)).toBeLessThanOrEqual(5);
    const body: AdminRoleUpdated = adminRoleUpdatedSchema.parse(res.json());
    expect(body).toMatchObject({ role: { key: 'support', grants: ['campaigns.read', 'dashboard.read', 'support.*', 'users.read'] }, signedOut: { admins: 0, sessions: 0 }, announced: true, sideEffects: 'done' });
    expect(body.role.permissions).toContain('campaigns.read');
    expect(await stored('support')).toEqual(['campaigns.read', 'dashboard.read', 'support.*', 'users.read']);
    const audit = await lastAudit(db, { action: 'role.update' });
    expect(audit).toMatchObject({ target_type: 6, target_id: null, admin_id: owner.account.id });
    expect(audit!.detail).toMatchObject({ role: 'support', added: ['campaigns.read'], removed: [], permissionsRemoved: [], signedOutAdmins: 0, signedOutSessions: 0 });
    // The process reloads its roles through cfg:changed; its report carries the version they were loaded for.
    await waitUntil(async () => (await grantsOf('support')).includes('campaigns.read'));
    await waitUntil(() => h.app.adminAuth.roles.state().version === h.app.cfg.peek()?.version);
    await waitUntil(async () => {
      const report = JSON.parse((await h.redis.hget(h.app.keys.providersApplied(), h.app.providers.processName)) ?? '{}') as { proc?: { rolesVersion?: number; cfgVersion?: number } };
      return report.proc?.rolesVersion === h.app.cfg.peek()?.version && report.proc?.cfgVersion === h.app.cfg.peek()?.version;
    });
    // Widening signs nobody out.
    expect((await admin(h, '/v1/admin/me', undefined, { token: holder.accessToken })).statusCode).toBe(200);
    // The same set again: nothing written, nothing announced.
    const version = h.app.cfg.peek()?.version;
    const again = await put('support', { grants: body.role.grants, base: body.role.grants });
    expect(again.statusCode).toBe(200);
    expect(adminRoleUpdatedSchema.parse(again.json())).toMatchObject({ announced: false, signedOut: { admins: 0, sessions: 0 } });
    expect((await lastAudit(db, { action: 'role.update' }))!.id).toBe(audit!.id);
    expect(h.app.cfg.peek()?.version).toBe(version);
  });

  it('narrows a role: every holder is signed out at once, the caller and other roles are not', async () => {
    const holders = [await adminAs(h, 'support'), await adminAs(h, 'support')];
    const bystander = await adminAs(h, 'moderator');
    const base = await grantsOf('support');
    const res = await put('support', { grants: ['campaigns.read', 'dashboard.read', 'support.read', 'users.read'], base });
    expect(res.statusCode, res.body).toBe(200);
    const body = adminRoleUpdatedSchema.parse(res.json());
    // The two holders here and the one of the test before.
    expect(body.signedOut.admins).toBeGreaterThanOrEqual(2);
    expect(body.signedOut.sessions).toBe(body.signedOut.admins);
    for (const holder of holders) {
      expect((await admin(h, '/v1/admin/me', undefined, { token: holder.accessToken })).statusCode).toBe(401);
      expect(await h.redis.exists(h.app.keys.denySession(holder.sessionId))).toBe(1);
    }
    expect((await admin(h, '/v1/admin/me', undefined, { token: bystander.accessToken })).statusCode).toBe(200);
    expect((await admin(h, '/v1/admin/me', undefined, { token: owner.accessToken })).statusCode).toBe(200);
    expect((await lastAudit(db, { action: 'role.update' }))!.detail).toMatchObject({ permissionsRemoved: ['support.write'], removed: ['support.*'], added: ['support.read'] });
    // Put the seeded grants back.
    const restore = await put('support', { grants: ['dashboard.read', 'support.*', 'users.read'], base: await grantsOf('support') });
    expect(restore.statusCode, restore.body).toBe(200);
    expect(await stored('support')).toEqual(['dashboard.read', 'support.*', 'users.read']);
  });

  it('never changes the owner role, nor a role holding * by hand', async () => {
    const owners = await put('superadmin', { grants: ['users.read'], base: ['*'] });
    expect(owners.statusCode).toBe(403);
    expect(reason(owners)).toBe('owner_role');
    const key = await customRole('all_hands', ['users.read']);
    const id = (await row<{ id: number }>(db, `SELECT id FROM admin_roles WHERE key = $1`, [key])).id;
    await grantPastRules(db, id, ['*']);
    await h.app.adminAuth.roles.reload();
    const res = await put(key, { grants: ['users.read'], base: ['*', 'users.read'] });
    expect(res.statusCode).toBe(403);
    expect(reason(res)).toBe('owner_role');
    await grantPastRules(db, id, ['*'], true);
    await h.app.adminAuth.roles.reload();
  });

  it("refuses '*', unknown grants, users.chats off the admin role and the analyst beyond dashboards, for the owner too", async () => {
    const base = await grantsOf('moderator');
    for (const [grants, code, pointer] of [
      [[...base, '*'], 'owner_grant', `/grants/${base.length}`],
      [['users.fly'], 'unknown_permission', '/grants/0'],
      [['zzz.*'], 'unknown_permission', '/grants/0'],
      [[...base, 'users.chats'], 'chats_admin_only', `/grants/${base.length}`],
    ] as const) {
      const res = await put('moderator', { grants, base });
      expect(res.statusCode, `${code} ${res.body}`).toBe(422);
      problemSchemaFor('field_invalid').parse(res.json());
      expect(fieldCode(res)).toMatchObject({ code, pointer });
    }
    const analyst = await grantsOf('analyst');
    expect(analyst).toEqual(['dashboard.read', 'dashboard.revenue']);
    const beyond = await put('analyst', { grants: [...analyst, 'users.read'], base: analyst });
    expect(beyond.statusCode).toBe(422);
    expect(fieldCode(beyond)).toMatchObject({ code: 'analyst_dashboards_only', pointer: '/grants/2' });
    expect(await stored('moderator')).toEqual([...base].sort());
    // Dashboards stay the analyst's to have: dashboard.* is fine, and so is the way back.
    const wide = await put('analyst', { grants: ['dashboard.*'], base: analyst });
    expect(wide.statusCode, wide.body).toBe(200);
    expect((await put('analyst', { grants: analyst, base: ['dashboard.*'] })).statusCode).toBe(200);
    expect(await stored('analyst')).toEqual(analyst);
  });

  it('refuses a stale save, and a role the caller holds', async () => {
    const before = await stored('marketing');
    const stale = await put('marketing', { grants: [...before, 'users.read'], base: ['campaigns.*'] });
    expect(stale.statusCode).toBe(409);
    expect(reason(stale)).toBe('role_changed');
    expect(await stored('marketing')).toEqual(before);
    const both = await seedAdmin(h, { roles: ['superadmin', 'marketing'] });
    const session = await signIn(h, both);
    const own = await put('marketing', { grants: before, base: before }, session);
    expect(own.statusCode).toBe(409);
    expect(reason(own)).toBe('own_role');
    expect((await put('nobody_here', { grants: [], base: [] })).statusCode).toBe(404);
  });

  it('keeps a delegated manager within its own access', async () => {
    const manager = await customRole('team_lead', ['admins.manage', 'admins.read', 'dashboard.read', 'support.*', 'users.read']);
    const lead = await adminAs(h, manager);
    const helpers = await customRole('helpers', ['dashboard.read']);
    // Within its access: a permission it holds, a wildcard it holds.
    const ok = await put(helpers, { grants: ['dashboard.read', 'support.*', 'users.read'], base: ['dashboard.read'] }, lead);
    expect(ok.statusCode, ok.body).toBe(200);
    // Beyond it: a permission, a wildcard it does not hold itself (the base is the answer's: this process may still be reloading).
    const now = adminRoleUpdatedSchema.parse(ok.json()).role.grants;
    const more = await put(helpers, { grants: [...now, 'campaigns.read'], base: now }, lead);
    expect(more.statusCode).toBe(403);
    expect(more.json()).toMatchObject({ reason: 'beyond_grants', permissions: ['campaigns.read'] });
    const wildcard = await put(helpers, { grants: [...now, 'users.*'], base: now }, lead);
    expect(wildcard.statusCode).toBe(403);
    expect(reason(wildcard)).toBe('beyond_grants');
    // A role with more than it holds, and restricted permissions (given or taken with '*' only).
    const adminRole = await grantsOf('admin');
    const bigger = await put('admin', { grants: adminRole, base: adminRole }, lead);
    expect(bigger.statusCode).toBe(403);
    expect(reason(bigger)).toBe('beyond_role');
    const restricted = await put(helpers, { grants: [...now, 'admins.read'], base: now }, lead);
    expect(restricted.statusCode).toBe(403);
    expect(restricted.json()).toMatchObject({ reason: 'restricted_permission', permissions: ['admins.read'] });
    // Without admins.manage: refused by the permission check.
    const reader = await adminAs(h, 'support');
    expect((await put(helpers, { grants: now, base: now }, reader)).statusCode).toBe(403);
  });

  it('checks a save that waited for the role against what the save before it committed', async () => {
    const lockAndChange = async (key: string, change: string) => {
      const other = await db.sql.connect();
      await other.query('BEGIN');
      await other.query(`SELECT id FROM admin_roles WHERE key = $1 FOR UPDATE`, [key]);
      await other.query(change);
      return other;
    };
    const waitForLockWait = () =>
      waitUntil(async () => (await row<{ n: number }>(db, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).n > 0);

    // A save waits while another transaction (here by hand) takes content.read away; its base was read before that.
    const base = await grantsOf('marketing');
    const first = await lockAndChange('marketing', `DELETE FROM admin_role_permissions WHERE role_id = 6 AND permission = 'content.read'`);
    try {
      const second = put('marketing', { grants: [...base, 'reports.read'], base });
      await waitForLockWait();
      await first.query('COMMIT');
      const res = await second;
      expect(res.statusCode, res.body).toBe(409);
      expect(reason(res)).toBe('role_changed');
      expect(await stored('marketing')).toEqual(['campaigns.*', 'dashboard.read']);
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      first.release();
    }
    await db.sql.query(`INSERT INTO admin_role_permissions (role_id, permission) VALUES (6, 'content.read') ON CONFLICT DO NOTHING`);

    // A delegated manager's save does not undo a restricted grant written meanwhile by a superadmin.
    const desk = await customRole('night_desk', ['dashboard.read']);
    const lead = await adminAs(h, await customRole('desk_lead', ['admins.manage', 'admins.read', 'dashboard.read', 'users.read']));
    const deskId = (await row<{ id: number }>(db, `SELECT id FROM admin_roles WHERE key = $1`, [desk])).id;
    const owners = await lockAndChange(desk, `INSERT INTO admin_role_permissions (role_id, permission) VALUES (${Number(deskId)}, 'admins.read')`);
    try {
      const managers = put(desk, { grants: ['dashboard.read', 'users.read'], base: ['dashboard.read'] }, lead);
      await waitForLockWait();
      await owners.query('COMMIT');
      const res = await managers;
      expect(res.statusCode, res.body).toBe(409);
      expect(reason(res)).toBe('role_changed');
      expect(await stored(desk)).toEqual(['admins.read', 'dashboard.read']);
    } finally {
      await owners.query('ROLLBACK').catch(() => undefined);
      owners.release();
    }
  });

  it('refuses a delegated manager taking access from a role whose holders have more than it', async () => {
    const manager = await customRole('floor_lead', [
      'admins.manage',
      'admins.read',
      'appeals.*',
      'campaigns.read',
      'dashboard.read',
      'moderation.*',
      'reports.*',
      'users.ban',
      'users.lift',
      'users.read',
      'users.revoke_sessions',
      'users.shadowban',
      'users.suspend',
      'users.warn',
    ]);
    const lead = await adminAs(h, manager);
    const base = await grantsOf('moderator');
    const narrower = base.filter((grant) => grant !== 'users.ban');
    // A moderator who also holds finance (billing, beyond the manager).
    const wide = await signIn(h, await seedAdmin(h, { roles: ['moderator', 'finance'] }));
    const plain = await adminAs(h, 'moderator');
    const refused = await put('moderator', { grants: narrower, base }, lead);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(reason(refused)).toBe('beyond_holders');
    expect(await stored('moderator')).toEqual([...base].sort());
    for (const session of [wide, plain]) expect((await admin(h, '/v1/admin/me', undefined, { token: session.accessToken })).statusCode).toBe(200);
    // Giving more stays open to it (nobody loses access), and the owner may take it away.
    const widened = await put('moderator', { grants: [...base, 'campaigns.read'], base }, lead);
    expect(widened.statusCode, widened.body).toBe(200);
    const now = adminRoleUpdatedSchema.parse(widened.json()).role.grants;
    expect(now).toContain('campaigns.read');
    const byOwner = await put('moderator', { grants: base, base: now });
    expect(byOwner.statusCode, byOwner.body).toBe(200);
    // A role whose holders are all within the manager's access: narrowed, holders signed out.
    const desk = await customRole('quiet_desk', ['reports.read', 'users.read']);
    const holder = await adminAs(h, desk);
    const narrowed = await put(desk, { grants: ['users.read'], base: ['reports.read', 'users.read'] }, lead);
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(adminRoleUpdatedSchema.parse(narrowed.json()).signedOut.admins).toBe(1);
    expect((await admin(h, '/v1/admin/me', undefined, { token: holder.accessToken })).statusCode).toBe(401);
  });

  it('answers sideEffects failed when the holders could not be signed out at once', async () => {
    const desk = await customRole('late_desk', ['reports.read', 'users.read']);
    await adminAs(h, desk);
    const spy = vi.spyOn(h.app.denyList, 'revokeSession').mockRejectedValue(new Error('Command timed out'));
    try {
      const res = await put(desk, { grants: ['users.read'], base: ['reports.read', 'users.read'] });
      expect(res.statusCode, res.body).toBe(200);
      expect(adminRoleUpdatedSchema.parse(res.json())).toMatchObject({ signedOut: { admins: 1, sessions: 1 }, sideEffects: 'failed' });
    } finally {
      spy.mockRestore();
    }
    // The change itself is committed (its sessions are revoked in the database).
    expect(await stored(desk)).toEqual(['users.read']);
  });

  it('keeps grants this build does not know, untouched by an edit', async () => {
    const key = await customRole('from_later', ['users.read', 'zzz.read']);
    expect(await grantsOf(key)).toEqual(['users.read']);
    const res = await put(key, { grants: ['reports.read', 'users.read'], base: ['users.read'] });
    expect(res.statusCode, res.body).toBe(200);
    expect(adminRoleUpdatedSchema.parse(res.json()).role.grants).toEqual(['reports.read', 'users.read']);
    expect(await stored(key)).toEqual(['reports.read', 'users.read', 'zzz.read']);
  });

  it('counts the enabled holders of each role, in one statement', async () => {
    const res = await admin(h, '/v1/admin/roles/holders', undefined, { token: owner.accessToken });
    expect(res.statusCode).toBe(200);
    expect(statements(res)).toBe(1);
    expect(res.headers['cache-control']).toBe('no-store');
    const items = adminRoleHoldersSchema.parse(res.json()).items;
    const count = async (key: string) =>
      (await row<{ n: number }>(db, `SELECT count(u.id)::int AS n FROM admin_users u JOIN admin_user_roles ur ON ur.admin_id = u.id JOIN admin_roles r ON r.id = ur.role_id WHERE r.key = $1 AND u.disabled_at IS NULL`, [key])).n;
    expect(items.find((i) => i.key === 'support')!.admins).toBe(await count('support'));
    const off = await seedAdmin(h, { roles: ['finance'] });
    const finance = items.find((i) => i.key === 'finance')!.admins;
    await db.sql.query(`UPDATE admin_users SET disabled_at = now() WHERE id = $1`, [off.id]);
    const after = adminRoleHoldersSchema.parse((await admin(h, '/v1/admin/roles/holders', undefined, { token: owner.accessToken })).json()).items;
    expect(after.find((i) => i.key === 'finance')!.admins).toBe(finance);
    const moderator = await adminAs(h, 'moderator');
    expect((await admin(h, '/v1/admin/roles/holders', undefined, { token: moderator.accessToken })).statusCode).toBe(403);
  });

  it('reaches a second API process through cfg:changed', async () => {
    const other = await startAdminHarness(db, { REDIS_KEY_PREFIX: h.prefix }, { providers: { processName: 'api:second-process' } });
    try {
      const base = await grantsOf('finance');
      expect(other.app.adminAuth.roles.current()?.get('finance')?.grants).toEqual(base);
      const res = await put('finance', { grants: [...base, 'campaigns.read'], base });
      expect(res.statusCode, res.body).toBe(200);
      await waitUntil(() => other.app.adminAuth.roles.current()?.get('finance')?.grants.includes('campaigns.read') === true);
      await waitUntil(async () => {
        const report = JSON.parse((await h.redis.hget(h.app.keys.providersApplied(), 'api:second-process')) ?? '{}') as { proc?: { rolesVersion?: number } };
        return report.proc?.rolesVersion === other.app.cfg.peek()?.version;
      });
      const restore = await put('finance', { grants: base, base: await grantsOf('finance') });
      expect(restore.statusCode).toBe(200);
    } finally {
      await other.app.close();
      await other.redis.quit();
    }
    // A process that closes takes its report with it.
    expect(await h.redis.hexists(h.app.keys.providersApplied(), 'api:second-process')).toBe(0);
  });

  it('asks for the second factor on its writes while one is required', () => {
    const routes = h.app.routesRequiringMfa();
    for (const route of [
      'PUT /v1/admin/roles/:key/permissions',
      'POST /v1/admin/system/dead-letters/delete',
      'POST /v1/admin/system/jobs/retry',
      'POST /v1/admin/system/jobs/remove',
      'POST /v1/admin/system/tasks/run',
    ]) {
      expect(routes, route).toContain(route);
    }
    expect(routes).not.toContain('GET /v1/admin/roles/holders');
    expect(routes.filter((route) => route.startsWith('GET /v1/admin/system/'))).toEqual([]);
  });
});

describe.skipIf(!hasInfrastructure)('admin: the role editor with the second factor off (a test stack)', () => {
  let db: TestDatabase;
  let h: AdminHarness;

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startAdminHarness(db, { ADMIN_TOTP_REQUIRED: 'false' });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await db?.drop();
  });

  it('lets a password-only owner session edit a role and start a task', async () => {
    const account = await seedAdmin(h, { roles: ['superadmin'] });
    const login = await admin(h, '/v1/admin/auth/login', { email: account.email, password: account.password });
    expect(login.statusCode, login.body).toBe(200);
    const token = login.json<{ session: { accessToken: string } }>().session.accessToken;
    const base = ['dashboard.read', 'dashboard.revenue'];
    const res = await admin(h, '/v1/admin/roles/analyst/permissions', { grants: ['dashboard.*'], base }, { token, method: 'PUT' });
    expect(res.statusCode, res.body).toBe(200);
    const back = await admin(h, '/v1/admin/roles/analyst/permissions', { grants: base, base: ['dashboard.*'] }, { token, method: 'PUT' });
    expect(back.statusCode, back.body).toBe(200);
    const run = await admin(h, '/v1/admin/system/tasks/run', { queue: 'stats', name: 'rollup' }, { token });
    expect(run.statusCode, run.body).toBe(200);
  });
});
