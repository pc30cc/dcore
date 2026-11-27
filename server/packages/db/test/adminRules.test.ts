import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuditSearchStatement, adminBanFromUser, adminBanPhone, adminUpdateBannedTerm, createPool, runMigrations, sql, withTransaction, type Pool } from '../src/index.js';
import { createTempDatabase, hasDatabase, requireSetup, type TempDatabase } from './support.js';

/**
 * Migration 0028 on the real migrations: the audit search reads the index
 * its filter names (on every partition), a term's change is one statement
 * that keeps the key unique, a ban's renewal keeps the longer expiry, and
 * each cause of a ban keeps a row of its own.
 */

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

describe.skipIf(!hasDatabase)('admin rules (migration 0028)', () => {
  let db: TempDatabase;
  let client: pg.Client;
  let pool: Pool;
  let ready = false;
  let adminId = 0;

  beforeAll(async () => {
    db = await createTempDatabase();
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS postgis');
      ready = true;
    } catch {
      requireSetup(false, 'PostGIS cannot be created in a new database');
      return;
    }
    await runMigrations({ connectionString: db.url, directory: MIGRATIONS, log: { info: () => undefined, warn: () => undefined } });
    pool = createPool({ connectionString: db.url, applicationName: 'db-test', max: 2 });
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO admin_users (email, display_name, password_hash) VALUES ('r@example.com', 'Rana', '$argon2id$x') RETURNING id`,
    );
    adminId = rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await client?.end();
    await db?.drop();
  });

  async function plan(fragment: ReturnType<typeof sql>): Promise<string> {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL enable_seqscan = off');
      const query = fragment.toQuery();
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${query.text}`, query.values);
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    } finally {
      await client.query('ROLLBACK');
    }
  }

  it('reads the audit log from the index each filter names, never a scan of a partition', async (ctx) => {
    if (!ready) ctx.skip();
    const now = Date.now();
    const cases: [Parameters<typeof adminAuditSearchStatement>[0], RegExp][] = [
      [{ action: 'user.ban', limit: 21, withShadowbans: true }, /action_id_idx/],
      [{ adminId: 3, limit: 21, withShadowbans: true }, /admin_id_id_idx/],
      [{ targetType: 1, targetId: '12345', limit: 21, withShadowbans: true }, /target_type_target_id_id_idx/],
      [{ targetType: 17, limit: 21, withShadowbans: true }, /target_type_id_idx/],
      [{ fromMs: now - 86_400_000, toMs: now, limit: 21, withShadowbans: true }, /_pkey/],
      // Without shadowbans: the same index, the rows it leaves out filtered on it.
      [{ targetType: 1, targetId: '12345', limit: 21, withShadowbans: false }, /target_type_target_id_id_idx/],
      [{ action: 'user.lift', limit: 21, withShadowbans: false }, /action_id_idx/],
    ];
    for (const [search, index] of cases) {
      const text = await plan(adminAuditSearchStatement(search));
      expect(text, JSON.stringify(search)).toMatch(index);
      expect(text, JSON.stringify(search)).not.toMatch(/Seq Scan/);
    }
    // A time range prunes the partitions outside it.
    const ranged = await plan(adminAuditSearchStatement({ action: 'user.ban', fromMs: now - 3_600_000, toMs: now, limit: 21, withShadowbans: true }));
    expect(ranged).toMatch(/Subplans Removed|One-Time Filter|action_id_idx/);
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::integer AS n FROM pg_indexes WHERE tablename LIKE 'audit_log_p%' AND indexdef LIKE '%(action, id)%'`,
    );
    expect(rows[0]!.n).toBeGreaterThanOrEqual(4);
  });

  it('lists the bans of one kind from device_bans_kind_idx, a value\'s rows from device_bans_value_idx, a record\'s from device_bans_action_key', async (ctx) => {
    if (!ready) ctx.skip();
    const text = await plan(sql`SELECT id FROM device_bans b WHERE b.kind = 2 AND b.id < 999999999999 ORDER BY b.id DESC LIMIT 21`);
    expect(text).toContain('device_bans_kind_idx');
    const value = await plan(sql`SELECT 1 FROM device_bans b WHERE b.kind = 2 AND b.value_hash = ANY(${[Buffer.alloc(32, 1)]}::bytea[])`);
    expect(value).toContain('device_bans_value_idx');
    const record = await plan(sql`DELETE FROM device_bans b WHERE b.action_id = 12345`);
    expect(record).toContain('device_bans_action_key');
  });

  it('changes a term in one statement: unchanged, changed, and refused onto another term of the same key', async (ctx) => {
    if (!ready) ctx.skip();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO banned_terms (match_kind, severity, scope, term) VALUES (1, 1, 2, 'alpha'), (1, 1, 2, 'beta') RETURNING id::text`,
    );
    const [alpha, beta] = rows.map((r) => r.id);
    await withTransaction(pool, async (tx) => {
      expect((await adminUpdateBannedTerm(tx, alpha!, { severity: 1 })).outcome).toBe('unchanged');
      const changed = await adminUpdateBannedTerm(tx, alpha!, { severity: 3, locale: 'fa' });
      expect(changed.outcome).toBe('updated');
      if (changed.outcome === 'updated') expect([changed.before.severity, changed.after.severity, changed.after.locale]).toEqual([1, 3, 'fa']);
      expect((await adminUpdateBannedTerm(tx, beta!, { locale: 'fa', term: 'alpha' })).outcome).toBe('conflict');
      expect((await adminUpdateBannedTerm(tx, beta!, { locale: null })).outcome).toBe('unchanged');
      expect((await adminUpdateBannedTerm(tx, '99999999', { severity: 2 })).outcome).toBe('missing');
    });
  });

  it('renews a phone ban: the longer expiry wins, a permanent one stays permanent', async (ctx) => {
    if (!ready) ctx.skip();
    const hash = Buffer.alloc(32, 7);
    const at = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
    const ban = (expiresAt: string | null) => withTransaction(pool, (tx) => adminBanPhone(tx, { hash, expiresAt, reason: 'r', adminId }));
    const first = await ban(at(10));
    expect(first.renewed).toBe(false);
    expect((await ban(at(20))).ban.expiresAtMs).toBeGreaterThan(Date.now() + 19 * 86_400_000);
    expect((await ban(at(5))).ban.expiresAtMs).toBeGreaterThan(Date.now() + 19 * 86_400_000);
    const permanent = await ban(null);
    expect([permanent.renewed, permanent.ban.expiresAtMs, permanent.ban.id]).toEqual([true, null, first.ban.id]);
    expect((await ban(at(30))).ban.expiresAtMs).toBeNull();
  });

  it('keeps a row per cause of a value: a typed number and a record never take over the server\'s own row or each other\'s', async (ctx) => {
    if (!ready) ctx.skip();
    const phoneHash = Buffer.alloc(32, 9);
    const deviceHash = Buffer.alloc(32, 10);
    const { rows: people } = await client.query<{ id: string }>(
      `INSERT INTO users (id, status, birth_date, gender) VALUES (id_next(), 3, '1990-01-01', 1), (id_next(), 3, '1991-01-01', 2) RETURNING id::text`,
    );
    const [a, b] = people.map((p) => p.id) as [string, string];
    for (const person of [a, b]) {
      await client.query(`INSERT INTO devices (id, user_id, app_version, platform, store, fingerprint_hash) VALUES (id_next(), $1, 1, 1, 1, $2)`, [person, deviceHash]);
    }
    await client.query(`INSERT INTO auth_identities (id, user_id, provider, subject_hash) VALUES (id_next(), $1, 1, $2)`, [a, phoneHash]);
    // The server's own year of the number (an under-age sign-up on it earlier).
    await client.query(`INSERT INTO device_bans (id, expires_at, kind, value_hash, reason) VALUES (id_next(), now() + interval '1 year', 2, $1, 'under_age')`, [phoneHash]);
    const banOf = async (person: string) =>
      (await client.query<{ id: string }>(`INSERT INTO moderation_actions (id, user_id, admin_id, kind, reason_code, reason_text) VALUES (id_next(), $1, $2, 3, 2, 'x') RETURNING id::text`, [person, adminId])).rows[0]!.id;
    const [actionA, actionB] = [await banOf(a), await banOf(b)];
    const fresh = async () => (await client.query<{ id: string }>('SELECT id_next()::text AS id')).rows[0]!.id;
    const fromUser = async (userId: string, kinds: number[], forAction: string, expiresAt: string | null = null) => {
      const actionId = await fresh();
      return withTransaction(pool, (tx) => adminBanFromUser(tx, { userId, kinds, expiresAt, reason: `for ${forAction}`, adminId, actionId, forAction }));
    };

    const typed = await withTransaction(pool, (tx) => adminBanPhone(tx, { hash: phoneHash, expiresAt: null, reason: 'typed', adminId }));
    const tiedA = await fromUser(a, [1, 2], actionA);
    const tiedB = await fromUser(b, [1], actionB);
    const again = await fromUser(a, [1], actionA, new Date(Date.now() + 86_400_000).toISOString());
    expect([typed.renewed, tiedA.outcome, tiedB.outcome, again.outcome]).toEqual([false, 'banned', 'banned', 'banned']);
    if (tiedA.outcome !== 'banned' || again.outcome !== 'banned') throw new Error('not banned');
    // The same record again renews its own row; a permanent one stays permanent.
    expect(again.bans.map((x) => [x.renewed, x.ban.id, x.ban.expiresAtMs])).toEqual([[true, tiedA.bans[0]!.ban.id, null]]);

    const causes = async () =>
      (
        await client.query<{ kind: number; by_admin: boolean; action: string | null; reason: string }>(
          `SELECT kind, created_by IS NOT NULL AS by_admin, action_id::text AS action, reason FROM device_bans
            WHERE value_hash = ANY($1::bytea[]) ORDER BY kind, action_id NULLS FIRST, created_by NULLS FIRST`,
          [[phoneHash, deviceHash]],
        )
      ).rows;
    expect(await causes()).toEqual([
      { kind: 1, by_admin: true, action: actionA, reason: `for ${actionA}` },
      { kind: 1, by_admin: true, action: actionB, reason: `for ${actionB}` },
      { kind: 2, by_admin: false, action: null, reason: 'under_age' },
      { kind: 2, by_admin: true, action: null, reason: 'typed' },
      { kind: 2, by_admin: true, action: actionA, reason: `for ${actionA}` },
    ]);
    // A lift removes its record's rows only.
    await client.query(`SELECT moderation_revoke($1, $2, id_next(), 'Lifted.')`, [actionB, adminId]);
    expect((await causes()).map((r) => [r.kind, r.action])).toEqual([
      [1, actionA],
      [2, null],
      [2, null],
      [2, actionA],
    ]);
    await client.query(`SELECT moderation_revoke($1, $2, id_next(), 'Lifted.')`, [actionA, adminId]);
    expect((await causes()).map((r) => [r.kind, r.by_admin, r.reason])).toEqual([
      [2, false, 'under_age'],
      [2, true, 'typed'],
    ]);
  });
});
