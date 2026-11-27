import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, type MigrationLog } from '../src/index.js';
import { createTempDatabase, hasDatabase, requireSetup, type TempDatabase } from './support.js';

/**
 * Migration 0031 on a database where 0030 ran while a shadowban lift of the
 * 0028 body was still open: that lift's record survived 0030's cleanup and
 * goes with 0031, a ban's lift record stays. Then the appeal view of 0031:
 * without shadowbans, the person's ten other records are ten even when a
 * shadowban is among the ten newest; with them, as 0027's view.
 */

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const FILE_0030 = '0030_admin_lift_records.sql';
const FILE = '0031_shadowban_records.sql';
const quiet: MigrationLog = { info: () => undefined, warn: () => undefined };

describe.skipIf(!hasDatabase)('migration 0031: shadowban records', () => {
  let db: TempDatabase;
  let client: pg.Client;
  let ready = false;
  let adminId = 0;
  const dir = mkdtempSync(join(tmpdir(), 'mig-0031-'));

  async function value<T>(text: string, values: unknown[] = [], on: pg.Client = client): Promise<T> {
    const { rows } = await on.query(text, values);
    if (rows[0] === undefined) throw new Error(`no row: ${text}`);
    return Object.values(rows[0] as Record<string, T>)[0] as T;
  }

  async function person(): Promise<string> {
    return value<string>(`INSERT INTO users (id, birth_date, status, gender, onboarding_step, country) VALUES (id_next(), '1994-01-01', 3, 2, 30, 'IR') RETURNING id::text`);
  }

  async function apply(user: string, kind: 1 | 3 | 4, code = 3): Promise<string> {
    const id = await value<string>(`SELECT id_next()::text`);
    await client.query(`SELECT moderation_apply($1, $2, $3::smallint, $4::smallint, 'Reason.', NULL, $5, NULL, NULL)`, [id, user, kind, code, adminId]);
    return id;
  }

  const lifts = async (user: string) => (await client.query<{ reason_text: string }>(`SELECT reason_text FROM moderation_actions WHERE user_id = $1 AND kind = 5 ORDER BY id`, [user])).rows;
  const revocation = async (action: string) =>
    (await client.query<{ revoked_at: Date | null; revoked_by: number | null }>(`SELECT revoked_at, revoked_by FROM moderation_actions WHERE id = $1`, [action])).rows[0];

  const copy = (name: string) => copyFileSync(join(MIGRATIONS, name), join(dir, name));

  beforeAll(async () => {
    db = await createTempDatabase();
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS postgis');
      ready = true;
    } catch {
      ready = false;
    }
    requireSetup(ready, 'PostGIS cannot be created in a new database');
    if (!ready) return;
    for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n < FILE_0030)) copy(name);
    await runMigrations({ connectionString: db.url, directory: dir, log: quiet });
    adminId = await value<number>(`INSERT INTO admin_users (email, display_name, password_hash) VALUES ('s@example.com', 'Sara', '$argon2id$x') RETURNING id`);
  }, 90_000);

  afterAll(async () => {
    await client?.end();
    await db?.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes the lift record of a shadowban lifted with the old body while 0030 was applied', async (ctx) => {
    if (!ready) ctx.skip();
    const user = await person();
    const shadow = await apply(user, 4);
    // A lift in its own transaction, started before 0030 and still open while 0030 runs and commits.
    const lifter = new pg.Client({ connectionString: db.url });
    await lifter.connect();
    try {
      await lifter.query('BEGIN');
      await lifter.query(`SELECT moderation_revoke($1, $2, id_next(), 'Checked.')`, [shadow, adminId]);
      copy(FILE_0030);
      expect((await runMigrations({ connectionString: db.url, directory: dir, log: quiet })).applied.map((f) => f.name)).toEqual([FILE_0030]);
      await lifter.query('COMMIT');
    } finally {
      await lifter.end();
    }
    // 0030's cleanup did not see it.
    expect(await lifts(user)).toEqual([{ reason_text: 'Checked.' }]);
    const revoked = await revocation(shadow);
    expect(revoked?.revoked_at).not.toBeNull();

    // A ban lifted with the new body keeps its record.
    const other = await person();
    const ban = await apply(other, 3);
    await client.query(`SELECT moderation_revoke($1, $2, id_next(), 'Withdrawn.')`, [ban, adminId]);

    copy(FILE);
    expect((await runMigrations({ connectionString: db.url, directory: dir, log: quiet })).applied.map((f) => f.name)).toEqual([FILE]);
    expect(await lifts(user)).toEqual([]);
    expect(await lifts(other)).toEqual([{ reason_text: 'Withdrawn.' }]);
    expect(await revocation(shadow)).toEqual(revoked);
  });

  it('leaves shadowbans out of an appeal history inside its limit, for the API role too', async (ctx) => {
    if (!ready) ctx.skip();
    const user = await person();
    const oldest = await apply(user, 1);
    const ban = await apply(user, 3);
    const shadow = await apply(user, 4);
    const recent: string[] = [];
    for (let i = 0; i < 9; i += 1) recent.unshift(await apply(user, 1));
    const appeal = await value<string>(`INSERT INTO appeals (id, user_id, action_id, body) VALUES (id_next(), $1, $2, 'Please.') RETURNING id::text`, [user, ban]);
    const history = async (call: string) =>
      ((await value<{ history: { id: string }[] }>(`SELECT ${call} AS v`, [appeal])).history).map((a) => a.id);
    expect(await history(`(SELECT admin_appeal_json(ap, false) FROM appeals ap WHERE ap.id = $1)`)).toEqual([...recent, oldest]);
    expect(await history(`(SELECT admin_appeal_json(ap, true) FROM appeals ap WHERE ap.id = $1)`)).toEqual([...recent, shadow]);
    expect(await history(`(SELECT admin_appeal_json(ap) FROM appeals ap WHERE ap.id = $1)`)).toEqual([...recent, shadow]);
    expect(await history(`admin_appeal_view($1::bigint, false)`)).toEqual([...recent, oldest]);
    const roles = await value<boolean>(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw')`);
    if (roles) {
      for (const fn of ['admin_appeal_json(appeals, boolean)', 'admin_appeal_view(bigint, boolean)']) {
        expect(await value<boolean>(`SELECT has_function_privilege('app_rw', $1, 'EXECUTE')`, [fn]), fn).toBe(true);
        expect(await value<boolean>(`SELECT has_function_privilege('public', $1, 'EXECUTE')`, [fn]), fn).toBe(false);
      }
    }
  });
});
