import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminRevokeRoleHolderSessions,
  adminRoleForUpdate,
  adminRoleHolders,
  adminRoleSetGrants,
  createPool,
  instrumentPool,
  partitionsOverview,
  runMigrations,
  statementCounter,
  withTransaction,
  type Pool,
} from '../src/index.js';
import { createTempDatabase, hasDatabase, type TempDatabase } from './support.js';

/**
 * Migration 0039: the partitions overview reads every partition of the
 * three parents from the catalog (bounds, drop times, estimates, xid age),
 * is executable by the API's group only; the role rules refuse every change
 * of the owner role, '*' elsewhere, users.chats off the admin role, a
 * non-dashboard grant on the analyst role and a move of the keys they name;
 * the role editor's queries take one statement each.
 */

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const GROUP_ROLES = ['app_rw', 'app_ro', 'app_maint'] as const;
const DAY_MS = 86_400_000;

describe.skipIf(!hasDatabase)('admin system (migration 0039)', () => {
  let db: TempDatabase;
  let client: pg.Client;
  let pool: Pool;
  let roles = false;

  beforeAll(async () => {
    db = await createTempDatabase();
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis');
    roles = true;
    for (const role of GROUP_ROLES) {
      if ((await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount) continue;
      try {
        await client.query(`CREATE ROLE ${role} NOLOGIN`);
      } catch {
        roles = false;
      }
    }
    await runMigrations({ connectionString: db.url, directory: MIGRATIONS, log: { info: () => undefined, warn: () => undefined } });
    pool = instrumentPool(createPool({ connectionString: db.url, applicationName: 'db-test', max: 2 }));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await client?.end();
    await db?.drop();
  });

  async function scalar<T>(text: string, values: unknown[] = []): Promise<T> {
    const { rows } = await client.query(text, values);
    return Object.values(rows[0] as Record<string, T>)[0] as T;
  }

  async function refusal(text: string, values: unknown[] = []): Promise<{ code: string | undefined; hint: string | undefined } | null> {
    try {
      await client.query(text, values);
      return null;
    } catch (error) {
      const e = error as { code?: string; hint?: string };
      return { code: e.code, hint: e.hint };
    }
  }

  async function counted<T>(fn: () => Promise<T>): Promise<{ value: T; statements: number }> {
    const { result, tally } = await statementCounter.measure(fn);
    return { value: result, statements: tally.statements };
  }

  describe('partitions_overview()', () => {
    it('lists every partition of the three parents with its bounds, drop time and estimates', async () => {
      const { value: rows, statements } = await counted(() => partitionsOverview(pool));
      expect(statements).toBe(1);
      const parents = [...new Set(rows.map((r) => r.parent))].sort();
      expect(parents).toEqual(['audit_log', 'likes', 'messages']);
      const now = Date.now();
      for (const row of rows) {
        expect(row.name.startsWith(`${row.parent}_p`), row.name).toBe(true);
        // The name carries the first day of the period (UTC), which is the lower bound.
        const day = row.name.slice(-8);
        expect(row.fromMs, row.name).toBe(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8))));
        expect(row.toMs!, row.name).toBeGreaterThan(row.fromMs!);
        expect(row.bytesEstimate).toBeGreaterThanOrEqual(0);
        expect(row.xidAge).toBeGreaterThanOrEqual(0);
      }
      const likes = rows.filter((r) => r.parent === 'likes');
      expect(likes[0]).toMatchObject({ period: 'week', premake: 4, retention: { months: 0, days: 37 } });
      for (const row of likes) {
        expect(row.toMs! - row.fromMs!).toBe(7 * DAY_MS);
        expect(row.dropAfterMs).toBe(row.toMs! + 37 * DAY_MS);
      }
      // The current period and premake ahead of it.
      expect(likes.filter((r) => r.fromMs! > now)).toHaveLength(4);
      expect(likes.filter((r) => r.fromMs! <= now && now < r.toMs!)).toHaveLength(1);
      const messages = rows.filter((r) => r.parent === 'messages');
      expect(messages[0]).toMatchObject({ period: 'month', premake: 3, retention: { months: 12, days: 0 } });
      for (const row of messages) {
        const to = new Date(row.toMs!);
        expect(row.dropAfterMs).toBe(Date.UTC(to.getUTCFullYear() + 1, to.getUTCMonth(), to.getUTCDate()));
      }
      expect(rows.find((r) => r.parent === 'audit_log')?.retention).toEqual({ months: 24, days: 0 });
    });

    it('reads the row estimate only after ANALYZE', async () => {
      const before = await partitionsOverview(pool);
      const current = before.find((r) => r.parent === 'audit_log' && r.fromMs! <= Date.now() && Date.now() < r.toMs!)!;
      expect(current.rowsEstimate).toBeNull();
      await client.query(`INSERT INTO audit_log (id, action, target_type) SELECT id_next(), 'admin.login', 0 FROM generate_series(1, 25)`);
      await client.query(`ANALYZE audit_log`);
      const after = (await partitionsOverview(pool)).find((r) => r.name === current.name)!;
      expect(after.rowsEstimate).toBe(25);
      expect(after.bytesEstimate).toBeGreaterThan(0);
    });

    it('is executable by the API group only, and so are the id helpers it calls', async (ctx) => {
      if (!roles) ctx.skip();
      const execute = (role: string, fn: string) => scalar<boolean>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS v`, [role, fn]);
      expect(await execute('app_rw', 'partitions_overview()')).toBe(true);
      expect(await execute('app_ro', 'partitions_overview()')).toBe(false);
      expect(await scalar<boolean>(`SELECT has_function_privilege('public', 'partitions_overview()', 'EXECUTE') AS v`)).toBe(false);
      for (const fn of ['id_ms(bigint)', 'id_time(bigint)']) expect(await execute('app_rw', fn), fn).toBe(true);
    });

    it('never waits behind a lock on a partition or a parent (DDL or VACUUM FULL run by hand)', async () => {
      const [first] = await partitionsOverview(pool);
      const holder = new pg.Client({ connectionString: db.url });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`LOCK TABLE part.${first!.name} IN ACCESS EXCLUSIVE MODE`);
        await holder.query(`LOCK TABLE public.${first!.parent} IN ACCESS EXCLUSIVE MODE`);
        const rows = await withTransaction(pool, async (tx) => {
          await tx.query(`SET LOCAL lock_timeout = '1s'`);
          return partitionsOverview(tx);
        });
        expect(rows.find((r) => r.name === first!.name)).toMatchObject({ fromMs: first!.fromMs, toMs: first!.toMs });
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
      }
    });
  });

  describe('the role rules', () => {
    const refused = (hint: string) => ({ code: '23514', hint });

    it('keeps the owner role as it is: no grant added, changed or removed, never renamed or deleted', async () => {
      expect(await refusal(`INSERT INTO admin_role_permissions (role_id, permission) VALUES (1, 'users.read')`)).toEqual(refused('owner_role'));
      expect(await refusal(`DELETE FROM admin_role_permissions WHERE role_id = 1`)).toEqual(refused('owner_role'));
      expect(await refusal(`UPDATE admin_role_permissions SET permission = 'users.*' WHERE role_id = 1`)).toEqual(refused('owner_role'));
      expect(await refusal(`UPDATE admin_role_permissions SET role_id = 1 WHERE role_id = 7`)).toEqual(refused('owner_role'));
      expect(await refusal(`UPDATE admin_roles SET key = 'boss' WHERE id = 1`)).toEqual(refused('owner_role'));
      expect(await refusal(`DELETE FROM admin_roles WHERE id = 1`)).toEqual(refused('owner_role'));
      expect(await scalar<string[]>(`SELECT array_agg(permission) AS v FROM admin_role_permissions WHERE role_id = 1`)).toEqual(['*']);
    });

    it("gives '*' to no other role, users.chats to the admin role only, the analyst dashboards only", async () => {
      expect(await refusal(`INSERT INTO admin_role_permissions (role_id, permission) VALUES (4, '*')`)).toEqual(refused('owner_grant'));
      expect(await refusal(`INSERT INTO admin_role_permissions (role_id, permission) VALUES (2, '*')`)).toEqual(refused('owner_grant'));
      for (const role of [3, 4, 5, 6, 7]) {
        expect(await refusal(`INSERT INTO admin_role_permissions (role_id, permission) VALUES ($1, 'users.chats')`, [role]), String(role)).toEqual(refused('chats_admin_only'));
      }
      expect(await refusal(`UPDATE admin_role_permissions SET permission = 'users.chats' WHERE role_id = 4 AND permission = 'users.read'`)).toEqual(refused('chats_admin_only'));
      for (const grant of ['users.read', 'config.read', 'audit.read', 'dashboardx.read']) {
        expect(await refusal(`INSERT INTO admin_role_permissions (role_id, permission) VALUES (7, $1)`, [grant]), grant).toEqual(refused('analyst_dashboards_only'));
      }
      // Allowed: dashboards on the analyst, users.chats on the admin role (already there: the insert is a no-op), any other grant elsewhere.
      expect(await refusal(`INSERT INTO admin_role_permissions (role_id, permission) VALUES (7, 'dashboard.*')`)).toBeNull();
      expect(await refusal(`DELETE FROM admin_role_permissions WHERE role_id = 7 AND permission = 'dashboard.*'`)).toBeNull();
      expect(await refusal(`INSERT INTO admin_role_permissions (role_id, permission) VALUES (2, 'users.chats') ON CONFLICT DO NOTHING`)).toBeNull();
      expect(await refusal(`INSERT INTO admin_role_permissions (role_id, permission) VALUES (4, 'campaigns.read')`)).toBeNull();
      expect(await refusal(`DELETE FROM admin_role_permissions WHERE role_id = 4 AND permission = 'campaigns.read'`)).toBeNull();
      // Taking users.chats from the admin role is allowed (and put back).
      expect(await refusal(`DELETE FROM admin_role_permissions WHERE role_id = 2 AND permission = 'users.chats'`)).toBeNull();
      expect(await refusal(`INSERT INTO admin_role_permissions (role_id, permission) VALUES (2, 'users.chats')`)).toBeNull();
    });

    it('applies the rules to a new role too, and keeps the keys they name in place', async () => {
      await client.query(`INSERT INTO admin_roles (id, key, names) VALUES (60, 'night_shift', '{}')`);
      expect(await refusal(`INSERT INTO admin_role_permissions (role_id, permission) VALUES (60, 'users.chats')`)).toEqual(refused('chats_admin_only'));
      expect(await refusal(`INSERT INTO admin_role_permissions (role_id, permission) VALUES (60, '*')`)).toEqual(refused('owner_grant'));
      expect(await refusal(`INSERT INTO admin_role_permissions (role_id, permission) VALUES (60, 'reports.read')`)).toBeNull();
      for (const key of ['admin', 'analyst', 'superadmin']) {
        expect(await refusal(`UPDATE admin_roles SET key = $1 WHERE id = 60`, [key]), key).toEqual(refused('role_key'));
      }
      expect(await refusal(`UPDATE admin_roles SET key = 'chat_admin' WHERE id = 2`)).toEqual(refused('role_key'));
      expect(await refusal(`UPDATE admin_roles SET key = 'readers' WHERE id = 7`)).toEqual(refused('role_key'));
      expect(await refusal(`UPDATE admin_roles SET key = 'evening_shift', names = '{"en": "Evening"}' WHERE id = 60`)).toBeNull();
      expect(await refusal(`UPDATE admin_roles SET names = '{"en": "Owner"}' WHERE id = 1`)).toBeNull();
      expect(await refusal(`DELETE FROM admin_roles WHERE id = 60`)).toBeNull();
      await client.query(`UPDATE admin_roles SET names = '{"en": "Super admin", "fa": "مدیر ارشد", "tr": "Süper yönetici"}' WHERE id = 1`);
    });

    it('runs again as a no-op', async () => {
      const before = await scalar<string>(`SELECT string_agg(role_id || ':' || permission, ',' ORDER BY role_id, permission) AS v FROM admin_role_permissions`);
      await client.query(readFileSync(join(MIGRATIONS, '0039_admin_system.sql'), 'utf8'));
      expect(await scalar<string>(`SELECT string_agg(role_id || ':' || permission, ',' ORDER BY role_id, permission) AS v FROM admin_role_permissions`)).toBe(before);
      expect(await scalar<number>(`SELECT count(*)::int AS v FROM pg_trigger WHERE tgname IN ('admin_role_permissions_rules', 'admin_roles_rules')`)).toBe(2);
    });
  });

  describe('the role editor queries', () => {
    it('locks a role (then reads its grants and holders), sets them exactly, signs its live holders out and counts them', async () => {
      const admins: number[] = [];
      for (const [i, disabled] of [[1, false], [2, false], [3, true]] as const) {
        const { rows } = await client.query<{ id: number }>(
          `INSERT INTO admin_users (email, display_name, password_hash, disabled_at) VALUES ($1, 'Support', NULL, CASE WHEN $2 THEN now() END) RETURNING id`,
          [`support-${i}@example.com`, disabled],
        );
        admins.push(Number(rows[0]!.id));
        await client.query(`INSERT INTO admin_user_roles (admin_id, role_id) VALUES ($1, 4)`, [rows[0]!.id]);
        await client.query(
          `INSERT INTO admin_sessions (id, admin_id, expires_at, refresh_hash) VALUES (id_next(), $1, now() + interval '1 day', decode(repeat('ab', 32), 'hex'))`,
          [rows[0]!.id],
        );
      }
      // A session that has expired (never refreshed again) is left as it is.
      await client.query(
        `INSERT INTO admin_sessions (id, admin_id, expires_at, refresh_hash) VALUES (id_next(), $1, now() - interval '1 day', decode(repeat('cd', 32), 'hex'))`,
        [admins[1]],
      );
      const other = (await client.query<{ id: number }>(`INSERT INTO admin_users (email, display_name, password_hash) VALUES ('support-4@example.com', 'Both', NULL) RETURNING id`)).rows[0]!.id;
      await client.query(`INSERT INTO admin_user_roles (admin_id, role_id) VALUES ($1, 4), ($1, 5)`, [other]);
      await withTransaction(pool, async (tx) => {
        const locked = await counted(() => adminRoleForUpdate(tx, 'support'));
        expect(locked.statements).toBe(2);
        expect(locked.value).toMatchObject({ id: 4, key: 'support', grants: ['dashboard.read', 'support.*', 'users.read'] });
        // Every holder's roles, disabled ones too (here: three support-only holders and one with finance as well).
        expect(locked.value!.holders.map((roles) => roles.join('+')).sort()).toEqual(['finance+support', 'support', 'support', 'support']);
        expect(locked.value!.names['en']).toBe('Support');
        expect(await adminRoleForUpdate(tx, 'nobody')).toBeNull();

        const set = await counted(() => adminRoleSetGrants(tx, 4, ['campaigns.read', 'dashboard.read', 'support.*']));
        expect(set.statements).toBe(1);
        expect(set.value).toEqual({ added: ['campaigns.read'], removed: ['users.read'] });
        expect((await adminRoleSetGrants(tx, 4, ['campaigns.read', 'dashboard.read', 'support.*']))).toEqual({ added: [], removed: [] });

        const out = await counted(() => adminRevokeRoleHolderSessions(tx, 4, 4, admins[0]!));
        expect(out.statements).toBe(1);
        expect(out.value.admins).toBe(2);
        expect(out.value.sessionIds).toHaveLength(2);
        const { rows } = await tx.query<{ admin_id: number; reason: number | null; live: boolean }>(
          `SELECT admin_id, revoke_reason AS reason, expires_at > now() AS live FROM admin_sessions WHERE admin_id = ANY($1::int[]) ORDER BY admin_id, expires_at DESC`,
          [admins],
        );
        expect(rows.map((r) => [Number(r.admin_id), r.live, r.reason])).toEqual([
          [admins[0], true, null],
          [admins[1], true, 4],
          [admins[1], false, null],
          [admins[2], true, 4],
        ]);

        const holders = await counted(() => adminRoleHolders(tx));
        expect(holders.statements).toBe(1);
        expect(holders.value.find((h) => h.key === 'support')).toEqual({ key: 'support', admins: 3 });
        expect(holders.value.map((h) => h.key).slice(0, 7)).toEqual(['superadmin', 'admin', 'moderator', 'support', 'finance', 'marketing', 'analyst']);
        // Undone: the suite's database keeps its seeds.
        throw new Error('rollback');
      }).catch((error: unknown) => {
        if ((error as Error).message !== 'rollback') throw error;
      });
      expect(await scalar<string[]>(`SELECT array_agg(permission ORDER BY permission) AS v FROM admin_role_permissions WHERE role_id = 4`)).toEqual(['dashboard.read', 'support.*', 'users.read']);
    });

    it('reads the grants after the lock: a save that waited sees what the one before it committed', async () => {
      const first = new pg.Client({ connectionString: db.url });
      await first.connect();
      try {
        await first.query('BEGIN');
        await first.query(`SELECT id FROM admin_roles WHERE key = 'marketing' FOR UPDATE`);
        await first.query(`DELETE FROM admin_role_permissions WHERE role_id = 6 AND permission = 'content.read'`);
        const second = withTransaction(pool, async (tx) => {
          const locked = await adminRoleForUpdate(tx, 'marketing');
          throw Object.assign(new Error('rollback'), { locked });
        }).catch((error: unknown) => (error as { locked?: { grants: string[] } }).locked);
        // The second one waits for the row lock, then the first one commits.
        for (let i = 0; i < 100; i += 1) {
          const waiting = await scalar<number>(`SELECT count(*)::int AS v FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
          if (waiting > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await first.query('COMMIT');
        expect((await second)?.grants).toEqual(['campaigns.*', 'dashboard.read']);
      } finally {
        await first.query('ROLLBACK').catch(() => undefined);
        await first.end();
        await client.query(`INSERT INTO admin_role_permissions (role_id, permission) VALUES (6, 'content.read') ON CONFLICT DO NOTHING`);
      }
    });

    it('lets the trigger refuse what the editor writes when it breaks a rule', async () => {
      const error = await withTransaction(pool, (tx) => adminRoleSetGrants(tx, 7, ['dashboard.read', 'users.read'])).catch((e: unknown) => e as { code?: string; hint?: string });
      expect(error).toMatchObject({ code: '23514', hint: 'analyst_dashboards_only' });
    });
  });
});
