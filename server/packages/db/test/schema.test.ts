import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, type MigrationLog } from '../src/index.js';
import { createTempDatabase, hasDatabase, requireSetup, type TempDatabase } from './support.js';

/**
 * The real migrations on an empty database, then checks of the schema's
 * rules: partition privileges, column grants of the analytics role, the deck
 * query's exclusions, the photo and verification rules, and retention.
 *
 * PostGIS must be creatable in a fresh database (a superuser test URL, as on
 * the native development cluster); without it the suite is skipped. The
 * group roles are created when the test role may create roles; the grant
 * checks are skipped when they do not exist.
 */

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const FILE_COUNT = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).length;
const GROUP_ROLES = ['app_rw', 'app_ro', 'app_maint'] as const;
const quiet: MigrationLog = { info: () => undefined, warn: () => undefined };

// A resolution-7 H3 cell and a point near its centre.
const CELL = '608692970769612799';
const POINT = "ST_SetSRID(ST_MakePoint(-122.42, 37.77), 4326)::geography";

async function ensureRoles(client: pg.Client): Promise<boolean> {
  for (const role of GROUP_ROLES) {
    const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (rowCount) continue;
    try {
      await client.query(`CREATE ROLE ${role} NOLOGIN`);
    } catch {
      return false;
    }
  }
  return true;
}

async function scalar<T>(client: pg.Client, text: string, values: unknown[] = []): Promise<T> {
  const { rows } = await client.query<{ v: T }>(text, values);
  return rows[0]?.v as T;
}

async function newId(client: pg.Client): Promise<string> {
  return scalar<string>(client, 'SELECT id_next()::text AS v');
}

interface PersonOptions {
  gender: 1 | 2 | 3;
  interestedIn: number;
  flags?: number;
  photos?: number;
}

/** An active person with a profile, preferences, a location and approved photos. */
async function person(client: pg.Client, options: PersonOptions): Promise<string> {
  const id = await newId(client);
  await client.query(
    `INSERT INTO users (id, birth_date, status, gender, onboarding_step, flags, country)
     VALUES ($1, DATE '1995-03-01', 3, $2, 50, $3, 'TR')`,
    [id, options.gender, options.flags ?? 0],
  );
  await client.query(`INSERT INTO profiles (user_id, display_name, completeness) VALUES ($1, 'p', 80)`, [id]);
  await client.query(`INSERT INTO preferences (user_id, interested_in) VALUES ($1, $2)`, [id, options.interestedIn]);
  await client.query(
    `INSERT INTO user_locations (user_id, home_h3, source, country, home_geo) VALUES ($1, $2, 1, 'TR', ${POINT})`,
    [id, CELL],
  );
  for (let position = 0; position < (options.photos ?? 2); position += 1) {
    await client.query(`INSERT INTO photos (id, user_id, position, status) VALUES (id_next(), $1, $2, 3)`, [id, position]);
  }
  return id;
}

async function deck(client: pg.Client, viewer: string): Promise<string[]> {
  const { rows } = await client.query<{ user_id: string }>(
    `SELECT user_id::text FROM deck_candidates($1, 5, ARRAY[h3_parent($2::bigint, 5)], 'TR', ${POINT}, 10000,
                                               '{}', 45, 42, NULL, NULL, 600)`,
    [viewer, CELL],
  );
  return rows.map((row) => row.user_id);
}

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe.skipIf(!hasDatabase)('schema: the real migrations', () => {
  let db: TempDatabase;
  let client: pg.Client;
  let ready = false;
  let roles = false;

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
    roles = await ensureRoles(client);
    requireSetup(roles, 'the group roles cannot be created');
    await runMigrations({ connectionString: db.url, directory: MIGRATIONS, log: quiet });
  }, 60_000);

  afterAll(async () => {
    await client?.end();
    await db?.drop();
  });

  it('applies every file once; a second run applies nothing', async (ctx) => {
    if (!ready) ctx.skip();
    const again = await runMigrations({ connectionString: db.url, directory: MIGRATIONS, log: quiet });
    expect(again.applied).toHaveLength(0);
    expect(again.alreadyApplied).toBe(FILE_COUNT);
  });

  it('keeps partitions in schema part, out of reach of every application role', async (ctx) => {
    if (!ready || !roles) ctx.skip();
    const { rows } = await client.query<{ schema: string; partition: string }>(
      `SELECT n.nspname AS schema, c.relname AS partition
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relispartition AND c.relkind = 'r'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.schema))).toEqual(new Set(['part']));
    const leaks = await scalar<string>(
      client,
      `SELECT count(*)::text AS v
         FROM pg_class c CROSS JOIN unnest($1::text[]) AS r(role)
        WHERE c.relispartition AND c.relkind = 'r'
          AND (has_table_privilege(r.role, c.oid, 'SELECT') OR has_table_privilege(r.role, c.oid, 'INSERT')
               OR has_table_privilege(r.role, c.oid, 'UPDATE') OR has_table_privilege(r.role, c.oid, 'DELETE'))`,
      [GROUP_ROLES],
    );
    expect(leaks).toBe('0');
    for (const role of GROUP_ROLES) {
      expect(await scalar<boolean>(client, `SELECT has_schema_privilege($1, 'part', 'USAGE') AS v`, [role])).toBe(false);
    }
  });

  it('keeps the ledgers append-only and partition maintenance away from the API group', async (ctx) => {
    if (!ready || !roles) ctx.skip();
    const privilege = (role: string, table: string, what: string) =>
      scalar<boolean>(client, 'SELECT has_table_privilege($1, $2, $3) AS v', [role, table, what]);
    for (const table of ['store_events', 'wallet_ledger', 'audit_log']) {
      expect(await privilege('app_rw', table, 'INSERT')).toBe(true);
      expect(await privilege('app_rw', table, 'UPDATE')).toBe(false);
      expect(await privilege('app_rw', table, 'DELETE')).toBe(false);
    }
    expect(await privilege('app_rw', 'legal_holds', 'DELETE')).toBe(false);
    const execute = (role: string, fn: string) =>
      scalar<boolean>(client, `SELECT has_function_privilege($1, $2, 'EXECUTE') AS v`, [role, fn]);
    for (const fn of ['partitions_maintain(text)', 'partition_drop_expired(text)']) {
      expect(await execute('app_rw', fn)).toBe(false);
      expect(await execute('app_maint', fn)).toBe(true);
    }
  });

  it('gives the analytics role no content, secrets, locations or special categories', async (ctx) => {
    if (!ready || !roles) ctx.skip();
    const column = (table: string, name: string) =>
      scalar<boolean>(client, `SELECT has_column_privilege('app_ro', $1, $2, 'SELECT') AS v`, [table, name]);
    const denied: [string, string][] = [
      ['messages', 'body'], ['message_requests', 'body'], ['likes', 'comment'], ['reports', 'evidence'],
      ['profiles', 'about'], ['profiles', 'display_name'], ['profile_prompts', 'answer'], ['appeals', 'body'],
      ['moderation_actions', 'note'], ['support_tickets', 'subject'], ['audit_log', 'detail'],
      ['preferences', 'interested_in'], ['discovery', 'h3_r7'], ['discovery', 'geo'], ['discovery', 'attrs'],
      ['user_locations', 'home_h3'], ['user_locations', 'home_geo'], ['device_bans', 'value_hash'],
      ['auth_identities', 'subject_enc'], ['store_purchases', 'token'], ['blocks', 'user_lo'],
      ['admin_users', 'password_hash'], ['admin_users', 'totp_secret_enc'], ['admin_users', 'totp_last_step'],
    ];
    for (const [table, name] of denied) expect(await column(table, name), `${table}.${name}`).toBe(false);
    for (const table of ['profile_field_values', 'legal_holds', 'report_filings', 'admin_sessions']) {
      expect(await scalar<boolean>(client, `SELECT has_table_privilege('app_ro', $1, 'SELECT') AS v`, [table])).toBe(false);
    }
    const allowed: [string, string][] = [
      ['messages', 'kind'], ['users', 'status'], ['user_locations', 'country'], ['discovery', 'gender'],
      ['field_values_ro', 'opt'], ['user_consents', 'kind'],
    ];
    for (const [table, name] of allowed) expect(await column(table, name), `${table}.${name}`).toBe(true);
  });

  it('refuses an account younger than 18 at sign-up', async (ctx) => {
    if (!ready) ctx.skip();
    const insert = (years: number) =>
      client.query(
        `INSERT INTO users (id, birth_date, status, gender) VALUES (id_next(), (current_date - make_interval(years => $1))::date, 2, 1)`,
        [years],
      );
    expect(await sqlState(insert(17))).toBe('23514');
    expect(await sqlState(insert(19))).toBeUndefined();
  });

  it('builds the deck from people with two approved photos, apart from test accounts and hidden peers', async (ctx) => {
    if (!ready) ctx.skip();
    const viewer = await person(client, { gender: 2, interestedIn: 2 });
    const one = await person(client, { gender: 1, interestedIn: 4, photos: 1 });
    const regular = await person(client, { gender: 1, interestedIn: 4 });
    const tester = await person(client, { gender: 1, interestedIn: 4, flags: 1 });
    const matched = await person(client, { gender: 1, interestedIn: 4 });

    let ids = await deck(client, viewer);
    expect(ids).toContain(regular);
    expect(ids).toContain(matched);
    expect(ids).not.toContain(one);
    expect(ids).not.toContain(tester);
    expect(await scalar<boolean>(client, 'SELECT can_see($1, $2, 1) AS v', [viewer, tester])).toBe(false);

    await client.query(`INSERT INTO photos (id, user_id, position, status) VALUES (id_next(), $1, 1, 3)`, [one]);
    await client.query(
      `INSERT INTO matches (id, user_lo, user_hi, source)
       VALUES (id_next(), least($1::bigint, $2::bigint), greatest($1::bigint, $2::bigint), 1)`,
      [viewer, matched],
    );
    ids = await deck(client, viewer);
    expect(ids).toContain(one);
    expect(ids).not.toContain(matched);

    const testViewer = await person(client, { gender: 2, interestedIn: 2, flags: 1 });
    expect(await deck(client, testViewer)).toEqual([tester]);
  });

  it('lets a verification lapse when its photo leaves the main position, and carries hide_distance', async (ctx) => {
    if (!ready) ctx.skip();
    const id = await person(client, { gender: 1, interestedIn: 4 });
    const main = await scalar<string>(client, 'SELECT id::text AS v FROM photos WHERE user_id = $1 AND position = 0', [id]);
    await client.query(
      `INSERT INTO verifications (id, user_id, photo_id, status, decided_at) VALUES (id_next(), $1, $2, 3, now())`,
      [id, main],
    );
    await client.query('UPDATE users SET is_verified = true WHERE id = $1', [id]);
    expect(await scalar<number>(client, 'SELECT flags::int AS v FROM discovery WHERE user_id = $1', [id]) & 1).toBe(1);

    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS photos_user_position_key DEFERRED');
    await client.query('UPDATE photos SET position = CASE position WHEN 0 THEN 1 ELSE 0 END WHERE user_id = $1', [id]);
    await client.query('COMMIT');
    expect(await scalar<boolean>(client, 'SELECT is_verified AS v FROM users WHERE id = $1', [id])).toBe(false);
    expect(await scalar<number>(client, 'SELECT status::int AS v FROM verifications WHERE user_id = $1', [id])).toBe(6);
    expect(await scalar<number>(client, 'SELECT flags::int AS v FROM discovery WHERE user_id = $1', [id]) & 1).toBe(0);

    const before = await scalar<number>(client, 'SELECT version AS v FROM profiles WHERE user_id = $1', [id]);
    await client.query('UPDATE profiles SET hide_distance = true WHERE user_id = $1', [id]);
    expect(await scalar<number>(client, 'SELECT version AS v FROM profiles WHERE user_id = $1', [id])).toBe(before + 1);
    expect(await scalar<number>(client, 'SELECT flags::int AS v FROM discovery WHERE user_id = $1', [id]) & 4).toBe(4);
    expect(await scalar<boolean>(client, `SELECT (profile_card($1) ->> 'hd')::boolean AS v`, [id])).toBe(true);

    // A plain text edit: the version bumped by the BEFORE trigger reaches discovery.
    await client.query(`UPDATE profiles SET about = 'new text' WHERE user_id = $1`, [id]);
    expect(
      await scalar<boolean>(
        client,
        'SELECT d.profile_ver = p.version AS v FROM discovery d JOIN profiles p USING (user_id) WHERE user_id = $1',
        [id],
      ),
    ).toBe(true);
  });

  it('allows one pending request and one open report per pair, and finds near-duplicate photos', async (ctx) => {
    if (!ready) ctx.skip();
    const a = await person(client, { gender: 1, interestedIn: 4 });
    const b = await person(client, { gender: 2, interestedIn: 2 });
    const request = () =>
      client.query(`INSERT INTO message_requests (id, from_id, to_id, body) VALUES (id_next(), $1, $2, 'hi')`, [a, b]);
    expect(await sqlState(request())).toBeUndefined();
    expect(await sqlState(request())).toBe('23505');
    await client.query(`UPDATE message_requests SET status = 4, decided_at = now() WHERE from_id = $1`, [a]);
    expect(await sqlState(request())).toBeUndefined();

    const report = () =>
      client.query(`INSERT INTO reports (id, target_id, reporter_id, context, reason) VALUES (id_next(), $1, $2, 1, 2)`, [b, a]);
    expect(await sqlState(report())).toBeUndefined();
    expect(await sqlState(report())).toBe('23505');

    const hash = '1234567890123456789';
    await client.query('UPDATE photos SET phash = $2 WHERE user_id = $1 AND position = 0', [a, hash]);
    const found = await scalar<string>(
      client,
      `SELECT count(*)::text AS v FROM photos
        WHERE phash IS NOT NULL AND phash_bands(phash) && phash_bands($1::bigint # 5)
          AND bit_count(int8send(phash # ($1::bigint # 5))) <= 3`,
      [hash],
    );
    expect(found).toBe('1');
  });

  it('clears an unsent body only with the unsend flag', async (ctx) => {
    if (!ready) ctx.skip();
    const match = await newId(client);
    const message = await newId(client);
    await client.query(`INSERT INTO messages (match_id, id, sender_id, kind, body) VALUES ($1, $2, 1, 1, 'x')`, [match, message]);
    expect(await sqlState(client.query('UPDATE messages SET body = NULL WHERE id = $1', [message]))).toBe('23514');
    expect(await sqlState(client.query('UPDATE messages SET body = NULL, flags = flags | 8 WHERE id = $1', [message]))).toBeUndefined();
  });

  it('keeps an expired messages partition while a legal hold still needs its rows', async (ctx) => {
    if (!ready) ctx.skip();
    const a = await person(client, { gender: 1, interestedIn: 4 });
    const b = await person(client, { gender: 2, interestedIn: 2 });
    const match = await newId(client);
    await client.query(
      `INSERT INTO matches (id, user_lo, user_hi, source) VALUES ($1, least($2::bigint, $3::bigint), greatest($2::bigint, $3::bigint), 1)`,
      [match, a, b],
    );
    const old = await scalar<string>(client, `SELECT partition_create('messages', now() - interval '14 months') AS v`);
    await client.query(
      `INSERT INTO messages (match_id, id, sender_id, kind, body) VALUES ($1, id_floor(now() - interval '14 months') + 1, $2, 1, 'x')`,
      [match, a],
    );
    const hold = await newId(client);
    await client.query(`INSERT INTO legal_holds (id, match_id, kind) VALUES ($1, $2, 1)`, [hold, match]);

    const drop = async () => {
      const { rows } = await client.query<{ action: string; partition_name: string }>(
        `SELECT action, partition_name FROM partition_drop_expired('messages')`,
      );
      return rows;
    };
    expect(await drop()).toEqual([{ action: 'drop_held', partition_name: old }]);
    await client.query('UPDATE legal_holds SET evidence_copied_at = now() WHERE id = $1', [hold]);
    expect(await drop()).toEqual([{ action: 'dropped', partition_name: old }]);
    expect(await drop()).toEqual([]);

    // The held match cannot be deleted; once the hold is released the purge may delete it.
    expect(await sqlState(client.query('DELETE FROM matches WHERE id = $1', [match]))).toBe('23001');
    await client.query('UPDATE legal_holds SET released_at = now() WHERE id = $1', [hold]);
    expect(await sqlState(client.query('DELETE FROM matches WHERE id = $1', [match]))).toBeUndefined();
    expect(await scalar<string | null>(client, 'SELECT match_id::text AS v FROM legal_holds WHERE id = $1', [hold])).toBeNull();
  });

  it('keeps one subscription row per store', async (ctx) => {
    if (!ready) ctx.skip();
    const id = await person(client, { gender: 1, interestedIn: 4 });
    const product = await scalar<number>(client, `SELECT id AS v FROM store_products WHERE store = 1 AND kind = 1 LIMIT 1`);
    for (const store of [1, 2]) {
      const purchase = await newId(client);
      await client.query(
        `INSERT INTO store_purchases (id, user_id, purchased_at, expires_at, product_ref, store, kind, state, token_hash, token)
         VALUES ($1, $2, now(), now() + interval '30 days', $3, $4, 1, 2, sha256(convert_to($5, 'UTF8')), $5)`,
        [purchase, id, product, store, `token-${purchase}`],
      );
      await client.query(
        `INSERT INTO subscriptions (user_id, started_at, expires_at, purchase_id, plan_id, store, status)
         VALUES ($1, now(), now() + interval '30 days', $2, 2, $3, 1)`,
        [id, purchase, store],
      );
    }
    expect(await scalar<string>(client, 'SELECT count(*)::text AS v FROM subscriptions WHERE user_id = $1', [id])).toBe('2');
  });
});
