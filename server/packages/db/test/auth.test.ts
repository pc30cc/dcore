import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accountRestriction,
  closeUnderAge,
  createPool,
  instrumentPool,
  refreshSession,
  revokeSessions,
  runMigrations,
  statementCounter,
  withTransaction,
  type Pool,
} from '../src/index.js';
import { createTempDatabase, hasDatabase, type TempDatabase } from './support.js';

/** The sign-in queries on the real migrations: refresh outcomes, the under-18 closure and its ban renewals. */

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const sha = (value: string) => createHash('sha256').update(value).digest();
const hash32 = () => randomBytes(32);

describe.skipIf(!hasDatabase)('sign-in queries', () => {
  let db: TempDatabase;
  let client: pg.Client;
  let pool: Pool;

  beforeAll(async () => {
    db = await createTempDatabase();
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await runMigrations({ connectionString: db.url, directory: MIGRATIONS, log: { info: () => undefined, warn: () => undefined } });
    pool = instrumentPool(createPool({ connectionString: db.url, applicationName: 'db-auth-test', max: 2 }));
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await client?.end();
    await db?.drop();
  });

  async function account(): Promise<{ userId: string; deviceId: string; sessionId: string; phoneHash: Buffer; deviceHash: Buffer }> {
    const phoneHash = hash32();
    const deviceHash = hash32();
    const { rows } = await client.query<{ u: string; d: string; s: string }>(
      `WITH u AS (INSERT INTO users (id) VALUES (id_next()) RETURNING id),
            i AS (INSERT INTO auth_identities (id, user_id, provider, subject_hash) SELECT id_next(), id, 1, $1 FROM u),
            d AS (INSERT INTO devices (id, user_id, app_version, platform, store, fingerprint_hash) SELECT id_next(), id, 10, 1, 2, $2 FROM u RETURNING id, user_id),
            s AS (INSERT INTO sessions (id, user_id, device_id, expires_at, store, refresh_hash)
                  SELECT id_next(), d.user_id, d.id, now() + interval '90 days', 2, $3 FROM d RETURNING id)
       SELECT (SELECT id::text FROM u) AS u, (SELECT id::text FROM d) AS d, (SELECT id::text FROM s) AS s`,
      [phoneHash, deviceHash, sha('rt1.first')],
    );
    const row = rows[0]!;
    return { userId: row.u, deviceId: row.d, sessionId: row.s, phoneHash, deviceHash };
  }

  it('rotates, refuses a token it does not know, and revokes a reused one after the grace', async () => {
    const a = await account();
    const input = (old: string, next: string) => ({ sessionId: a.sessionId, oldHash: sha(old), newHash: sha(next), idleDays: 90, graceSeconds: 30, appVersion: 11 });
    const { result, tally } = await statementCounter.measure(() => refreshSession(pool, input('rt1.first', 'rt1.second')));
    expect(tally.statements).toBe(1);
    expect(result).toMatchObject({ outcome: 'rotated', userId: a.userId, deviceId: a.deviceId, store: 2, state: { status: 1, onboardingStep: 0, flags: 0 } });
    expect(await refreshSession(pool, input('rt1.unknown', 'rt1.x'))).toEqual({ outcome: 'invalid' });
    // Used again inside the grace: nothing happens (the caller's Valkey grace answers it).
    expect(await refreshSession(pool, input('rt1.first', 'rt1.y'))).toEqual({ outcome: 'invalid' });
    await client.query(`UPDATE sessions SET refreshed_at = now() - interval '31 seconds' WHERE id = $1`, [a.sessionId]);
    expect(await refreshSession(pool, input('rt1.first', 'rt1.z'))).toEqual({ outcome: 'reused', userId: a.userId });
    const { rows } = await client.query<{ revoke_reason: number }>('SELECT revoke_reason FROM sessions WHERE id = $1', [a.sessionId]);
    expect(rows[0]?.revoke_reason).toBe(3);
    // Revoked: the current token is refused too.
    expect(await refreshSession(pool, input('rt1.second', 'rt1.w'))).toEqual({ outcome: 'invalid' });
    expect(await revokeSessions(pool, { userId: a.userId }, 2)).toEqual([]);
  });

  it('reads a restriction with its reason, its end and whether it can be appealed', async () => {
    const a = await account();
    await client.query(`UPDATE users SET status = 5, birth_date = DATE '1990-01-01', gender = 2 WHERE id = $1`, [a.userId]);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO moderation_actions (id, user_id, kind, reason_code, reason_text, ends_at) VALUES (id_next(), $1, 2, 1, 'Wait a day.', now() + interval '1 day') RETURNING id::text`,
      [a.userId],
    );
    const state = await accountRestriction(pool, a.userId);
    expect(state).toMatchObject({ status: 5, restriction: { actionId: rows[0]?.id, kind: 2, reasonText: 'Wait a day.', appealable: true } });
    expect(state?.restriction?.endsAtMs).toBeGreaterThan(Date.now());
    await client.query(`INSERT INTO appeals (id, user_id, action_id, body) VALUES (id_next(), $1, $2, 'please')`, [a.userId, rows[0]?.id]);
    expect((await accountRestriction(pool, a.userId))?.restriction?.appealable).toBe(false);
    expect(await accountRestriction(pool, '999999999999999999')).toBeNull();
  });

  it('closes an under-age account in 4 statements, renews expired bans and never shortens a permanent one', async () => {
    const a = await account();
    // The device key was banned before and that ban ran out; the number is banned for good.
    await client.query(`INSERT INTO device_bans (id, kind, store, value_hash, reason, expires_at) VALUES (id_next(), 1, 2, $1, 'old', now() - interval '1 day')`, [a.deviceHash]);
    await client.query(`INSERT INTO device_bans (id, kind, value_hash, reason) VALUES (id_next(), 2, $1, 'admin')`, [a.phoneHash]);
    const ids = (await client.query<{ id: string }>('SELECT id_next()::text AS id FROM generate_series(1, 3)')).rows.map((r) => r.id);
    const { result, tally } = await statementCounter.measure(() =>
      withTransaction(pool, (tx) => closeUnderAge(tx, { userId: a.userId, deviceId: a.deviceId, banIds: ids, reason: 'under_age' })),
    );
    expect(tally.statements).toBe(4);
    expect(result.closed).toBe(true);
    expect(result.sessionIds).toEqual([a.sessionId]);
    expect(result.phoneHashes.map((h) => h.toString('hex'))).toEqual([a.phoneHash.toString('hex')]);
    expect(result.deviceHashes.map((h) => h.toString('hex'))).toEqual([a.deviceHash.toString('hex')]);
    const bans = (
      await client.query<{ kind: number; reason: string; permanent: boolean; year: boolean }>(
        `SELECT kind, reason, expires_at IS NULL AS permanent, coalesce(expires_at > now() + interval '364 days', false) AS year
           FROM device_bans WHERE value_hash = ANY($1::bytea[]) ORDER BY kind`,
        [[a.deviceHash, a.phoneHash]],
      )
    ).rows;
    expect(bans).toEqual([
      { kind: 1, reason: 'under_age', permanent: false, year: true },
      { kind: 2, reason: 'admin', permanent: true, year: false },
    ]);
    const user = (await client.query('SELECT status, deleted_via FROM users WHERE id = $1', [a.userId])).rows[0] as { status: number; deleted_via: number };
    expect(user).toEqual({ status: 8, deleted_via: 4 });
    // Only an account still in onboarding is closed this way.
    const again = await withTransaction(pool, (tx) => closeUnderAge(tx, { userId: a.userId, deviceId: null, banIds: ids, reason: 'under_age' }));
    expect(again.closed).toBe(false);
  });
});
