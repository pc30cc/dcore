import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, type MigrationLog } from '../src/index.js';
import { createTempDatabase, hasDatabase, requireSetup, type TempDatabase } from './support.js';

/**
 * Migration 0030 on a database that already holds lifts (0001-0029 applied):
 * the lift records written for shadowbans (by an admin and automatic) go,
 * the one of a ban stays with its text, and the lifted shadowbans keep their
 * revoked_at and revoked_by. After it, lifting a shadowban writes no record,
 * lifting it again answers `already`, and a suspension's lift still writes
 * exactly one record with the suspension's reason code.
 */

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const FILE = '0030_admin_lift_records.sql';
const quiet: MigrationLog = { info: () => undefined, warn: () => undefined };

describe.skipIf(!hasDatabase)('migration 0030: lift records of suspensions and bans only', () => {
  let db: TempDatabase;
  let client: pg.Client;
  let ready = false;
  let adminId = 0;
  const people: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'mig-0030-'));

  async function value<T>(text: string, values: unknown[] = []): Promise<T> {
    const { rows } = await client.query(text, values);
    if (rows[0] === undefined) throw new Error(`no row: ${text}`);
    return Object.values(rows[0] as Record<string, T>)[0] as T;
  }

  async function apply(user: string, kind: 2 | 3 | 4, admin: number | null, code = 3): Promise<string> {
    const id = await value<string>(`SELECT id_next()::text`);
    const ends = kind === 2 ? new Date(Date.now() + 86_400_000).toISOString() : null;
    await client.query(`SELECT moderation_apply($1, $2, $3::smallint, $4::smallint, 'Reason.', $5::timestamptz, $6, NULL, NULL)`, [id, user, kind, code, ends, admin]);
    return id;
  }

  async function revoke(action: string, admin: number | null, text: string | null): Promise<{ outcome: string; kind: number; already: boolean }> {
    return value(`SELECT moderation_revoke($1, $2, id_next(), $3) AS out`, [action, admin, text]);
  }

  const lifts = (user: string) =>
    client.query<{ reason_code: number; reason_text: string; admin_id: number | null }>(`SELECT reason_code, reason_text, admin_id FROM moderation_actions WHERE user_id = $1 AND kind = 5 ORDER BY id`, [user]);

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
    for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n < FILE)) copyFileSync(join(MIGRATIONS, name), join(dir, name));
    await runMigrations({ connectionString: db.url, directory: dir, log: quiet });
    adminId = await value<number>(`INSERT INTO admin_users (email, display_name, password_hash) VALUES ('l@example.com', 'Lale', '$argon2id$x') RETURNING id`);
    for (let i = 0; i < 2; i += 1) {
      people.push(await value<string>(`INSERT INTO users (id, birth_date, status, gender, onboarding_step, country) VALUES (id_next(), '1994-01-01', 3, 2, 30, 'IR') RETURNING id::text`));
    }
  }, 90_000);

  afterAll(async () => {
    await client?.end();
    await db?.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes the lift records of shadowbans written before it, and keeps a ban’s', async (ctx) => {
    if (!ready) ctx.skip();
    const [a, b] = people as [string, string];
    const byAdmin = await apply(a, 4, adminId, 3);
    const ban = await apply(a, 3, adminId, 3);
    const automatic = await apply(b, 4, null, 5);
    // Each lift in its own statement (its own transaction), as every product path does it.
    await revoke(byAdmin, adminId, 'Checked.');
    await revoke(ban, adminId, 'Reporter withdrew.');
    await revoke(automatic, null, null);
    expect((await lifts(a)).rows).toHaveLength(2);
    expect((await lifts(b)).rows).toHaveLength(1);
    const revokedBefore = (await client.query(`SELECT id::text, revoked_at, revoked_by FROM moderation_actions WHERE kind = 4 ORDER BY id`)).rows;

    copyFileSync(join(MIGRATIONS, FILE), join(dir, FILE));
    const run = await runMigrations({ connectionString: db.url, directory: dir, log: quiet });
    expect(run.applied.map((f) => f.name)).toEqual([FILE]);

    expect((await lifts(a)).rows).toEqual([{ reason_code: 3, reason_text: 'Reporter withdrew.', admin_id: adminId }]);
    expect((await lifts(b)).rows).toEqual([]);
    // The shadowbans keep who lifted them and when.
    expect((await client.query(`SELECT id::text, revoked_at, revoked_by FROM moderation_actions WHERE kind = 4 ORDER BY id`)).rows).toEqual(revokedBefore);
    expect(revokedBefore.every((r: { revoked_at: Date | null }) => r.revoked_at !== null)).toBe(true);
    const again = await runMigrations({ connectionString: db.url, directory: dir, log: quiet });
    expect(again.applied).toEqual([]);
  });

  it('lifts a shadowban without a record afterwards; a suspension still gets exactly one', async (ctx) => {
    if (!ready) ctx.skip();
    const [, b] = people as [string, string];
    const shadow = await apply(b, 4, adminId, 4);
    expect(await revoke(shadow, adminId, 'Looked again.')).toMatchObject({ outcome: 'revoked', kind: 4, already: false });
    expect((await lifts(b)).rows).toEqual([]);
    expect(await revoke(shadow, adminId, null)).toMatchObject({ outcome: 'revoked', already: true });
    expect((await lifts(b)).rows).toEqual([]);
    expect(await value<string | null>(`SELECT revoked_at::text FROM moderation_actions WHERE id = $1`, [shadow])).not.toBeNull();

    const suspension = await apply(b, 2, adminId, 6);
    expect(await revoke(suspension, adminId, 'Too long.')).toMatchObject({ outcome: 'revoked', kind: 2, already: false });
    expect((await lifts(b)).rows).toEqual([{ reason_code: 6, reason_text: 'Too long.', admin_id: adminId }]);
  });
});
