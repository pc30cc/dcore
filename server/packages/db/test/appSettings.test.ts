import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  configValueForUpdate,
  configValueSave,
  configValues,
  createPool,
  instrumentPool,
  profileReviewDecide,
  profileReviewQueue,
  profileReviewQueueStatement,
  profileReviewResubmit,
  runMigrations,
  withTransaction,
  type Pool,
  type Queryable,
} from '../src/index.js';
import { createTempDatabase, hasDatabase, type TempDatabase } from './support.js';

/**
 * Migration 0038: the review rows follow the account's status (trigger),
 * the queue is an index range of profile_reviews oldest first, the decision
 * and the resubmission write one row each, the seeds parse, the migration
 * runs again as a no-op, and the analytics role reads none of it.
 */

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const FILE = '0038_app_settings.sql';

describe.skipIf(!hasDatabase)('app settings and the new-profile review (migration 0038)', () => {
  let db: TempDatabase;
  let client: pg.Client;
  let pool: Pool;

  beforeAll(async () => {
    db = await createTempDatabase();
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await runMigrations({ connectionString: db.url, directory: MIGRATIONS, log: { info: () => undefined, warn: () => undefined } });
    pool = instrumentPool(createPool({ connectionString: db.url, applicationName: 'db-test', max: 4 }));
    // Many active accounts, a few waiting: the queue must not walk the others.
    await client.query(`INSERT INTO users (id, birth_date, status, gender, onboarding_step, country)
                        SELECT id_next(), '1994-01-01', CASE WHEN g % 100 = 0 THEN 2 ELSE 3 END, 2, 30, 'IR' FROM generate_series(1, 3000) g`);
    await client.query('ANALYZE users, profile_reviews');
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await client?.end();
    await db?.drop();
  });

  async function value<T>(text: string, values: unknown[] = []): Promise<T> {
    const { rows } = await client.query(text, values);
    return Object.values(rows[0] as Record<string, T>)[0] as T;
  }

  async function planOf(run: (db: Queryable) => Promise<unknown>): Promise<string> {
    const plans: string[] = [];
    const explaining: Queryable = {
      async query(config) {
        await client.query('SET enable_seqscan = off');
        try {
          const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${config.text}`, config.values);
          plans.push(rows.map((r) => r['QUERY PLAN']).join('\n'));
          return await client.query(config);
        } finally {
          await client.query('SET enable_seqscan = on');
        }
      },
    };
    await run(explaining);
    return plans.join('\n---\n');
  }

  it('keeps one review row per waiting account and serves the queue from its index, oldest first', async () => {
    expect(await value<number>('SELECT count(*)::int FROM profile_reviews')).toBe(30);
    const plan = await planOf((q) => profileReviewQueue(q, { state: 1, limit: 11 }));
    expect(plan).toContain('profile_reviews_state_idx');
    const page = await profileReviewQueue(pool, { state: 1, limit: 11 });
    expect(page).toHaveLength(11);
    const ids = page.map((row) => BigInt(row.user.id));
    expect([...ids].sort((a, b) => (a < b ? -1 : 1))).toEqual(ids);
    const next = await profileReviewQueue(pool, { state: 1, afterId: page[10]!.user.id, limit: 50 });
    expect(next).toHaveLength(19);
  });

  it('writes a decision and a resubmission as one statement each', async () => {
    const user = await value<string>('SELECT user_id::text FROM profile_reviews WHERE listed ORDER BY user_id LIMIT 1');
    await withTransaction(pool, (tx) => profileReviewDecide(tx, { userId: user, state: 2, reasonText: 'Add a face photo.', adminId: null }));
    const decided = await client.query<{ state: number; rounds: number; reason_text: string; last_decision: number }>(
      'SELECT state, rounds, reason_text, last_decision FROM profile_reviews WHERE user_id = $1',
      [user],
    );
    expect(decided.rows[0]).toEqual({ state: 2, rounds: 1, reason_text: 'Add a face photo.', last_decision: 2 });
    expect(await profileReviewResubmit(pool, user)).toEqual({ state: 1, resubmitted: true, status: 2 });
    // Waiting again, the earlier request is named as what it was.
    const waiting = (await profileReviewQueue(pool, { state: 1, limit: 50 })).find((row) => row.user.id === user);
    expect(waiting?.decision).toMatchObject({ kind: 2, reasonText: 'Add a face photo.' });
    expect(await profileReviewResubmit(pool, user)).toEqual({ state: 1, resubmitted: false, status: 2 });
    const view = await value<{ review?: { state: number; message?: string } }>('SELECT account_view($1::bigint)', [user]);
    expect(view.review).toEqual({ state: 1 });
    await withTransaction(pool, (tx) => profileReviewDecide(tx, { userId: user, state: 3, reasonText: 'Not accepted.', adminId: null }));
    const rejected = await value<{ review?: { state: number; message?: string } }>('SELECT account_view($1::bigint)', [user]);
    expect(rejected.review).toMatchObject({ state: 3, message: 'Not accepted.' });
    // An active account's view carries no review.
    const active = await value<string>('SELECT id::text FROM users WHERE status = 3 LIMIT 1');
    expect((await value<Record<string, unknown>>('SELECT account_view($1::bigint)', [active]))['review']).toBeUndefined();
  });

  it('reads and writes settings rows by key', async () => {
    const rows = await configValues(pool, ['signup.countries', 'limits.rates', 'not.there']);
    expect(rows.map((r) => r.key).sort()).toEqual(['limits.rates', 'signup.countries']);
    expect(rows.find((r) => r.key === 'limits.rates')?.value).toEqual({ swipes_per_hour: 600, messages_per_minute: 60, messages_per_conversation: 20, reports_per_day: 10 });
    await withTransaction(pool, async (tx) => {
      expect(await configValueForUpdate(tx, 'providers.kavenegar')).toEqual({ exists: false, value: null });
      const saved = await configValueSave(tx, 'providers.kavenegar', { v: 1, enabled: false, settings: {}, secrets: null }, null, false);
      expect(saved?.value).toEqual({ v: 1, enabled: false, settings: {}, secrets: null });
    });
    expect((await configValues(pool, ['providers.kavenegar']))[0]?.updatedAtMs).toBeGreaterThan(0);
  });

  it('lets only one of two first saves of a key write: the second waits and writes nothing', async () => {
    const a = new pg.Client({ connectionString: db.url });
    const b = new pg.Client({ connectionString: db.url });
    await a.connect();
    await b.connect();
    const on = (c: pg.Client): Queryable => ({ query: (config) => c.query(config) });
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      // Both locked reads find no row (FOR UPDATE locks nothing then).
      expect(await configValueForUpdate(on(a), 'providers.smsir')).toEqual({ exists: false, value: null });
      expect(await configValueForUpdate(on(b), 'providers.smsir')).toEqual({ exists: false, value: null });
      expect(await configValueSave(on(a), 'providers.smsir', { first: true }, null, false)).not.toBeNull();
      // B's insert waits for A's; once A commits it is a conflict, and nothing of B's is written.
      const second = configValueSave(on(b), 'providers.smsir', { second: true }, null, false);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await a.query('COMMIT');
      expect(await second).toBeNull();
      await b.query('COMMIT');
      expect((await configValues(pool, ['providers.smsir']))[0]?.value).toEqual({ first: true });
      // A row the locked read found is updated as before.
      await withTransaction(pool, async (tx) => {
        expect((await configValueForUpdate(tx, 'providers.smsir')).exists).toBe(true);
        expect((await configValueSave(tx, 'providers.smsir', { third: true }, null, true))?.value).toEqual({ third: true });
      });
    } finally {
      await a.end();
      await b.end();
      await client.query(`DELETE FROM app_config WHERE key = 'providers.smsir'`);
    }
  });

  it('keeps banned, suspended and deleted waiting accounts off the queue\'s index, and brings them back on a lift', async () => {
    const min = await value<string>('SELECT min(id)::text FROM users');
    // A wave of waiting accounts older than every other one, then banned while waiting.
    await client.query(`INSERT INTO users (id, birth_date, status, gender, onboarding_step, country)
                        SELECT $1::bigint - 2000 + g, '1994-01-01', 2, 2, 30, 'IR' FROM generate_series(1, 1000) g`, [min]);
    expect(await value<number>(`SELECT count(*)::int FROM profile_reviews WHERE user_id < $1::bigint AND listed`, [min])).toBe(1000);
    await client.query(`UPDATE users SET status = 6 WHERE id < $1::bigint`, [min]);
    expect(await value<number>(`SELECT count(*)::int FROM profile_reviews WHERE user_id < $1::bigint AND NOT listed`, [min])).toBe(1000);
    await client.query('ANALYZE users, profile_reviews');
    try {
      // The first page reads about a page of the index, never the banned wave.
      // As at scale (the table is small here): an index walk, never a scan of the table.
      const statement = profileReviewQueueStatement({ state: 1, limit: 11 }).toQuery();
      await client.query('SET enable_seqscan = off');
      await client.query('SET enable_bitmapscan = off');
      const { rows } = await client
        .query<{ 'QUERY PLAN': unknown }>({ text: `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`, values: statement.values })
        .finally(() => client.query('RESET enable_seqscan; RESET enable_bitmapscan'));
      const scans: { 'Index Name'?: string; 'Actual Rows'?: number; 'Rows Removed by Filter'?: number }[] = [];
      const walk = (node: Record<string, unknown>) => {
        if (node['Relation Name'] === 'profile_reviews') scans.push(node);
        for (const child of (node['Plans'] as Record<string, unknown>[] | undefined) ?? []) walk(child);
      };
      walk(((rows[0]!['QUERY PLAN'] as { Plan: Record<string, unknown> }[])[0]!).Plan);
      expect(scans.length).toBeGreaterThan(0);
      for (const scan of scans) {
        expect(scan['Index Name']).toBe('profile_reviews_state_idx');
        expect(scan['Actual Rows']).toBeLessThanOrEqual(11);
        expect(scan['Rows Removed by Filter'] ?? 0).toBe(0);
      }
      const page = await profileReviewQueue(pool, { state: 1, limit: 11 });
      expect(page.every((row) => BigInt(row.user.id) > BigInt(min))).toBe(true);
      // A lift back to waiting puts the account on the queue again, first in line.
      const lifted = await value<string>(`SELECT (min(id))::text FROM users WHERE id < $1::bigint`, [min]);
      await client.query(`UPDATE users SET status = 2 WHERE id = $1::bigint`, [lifted]);
      expect((await profileReviewQueue(pool, { state: 1, limit: 1 }))[0]?.user.id).toBe(lifted);
      // Suspended while waiting: kept, off the queue; a row lost meanwhile is made again on the way back.
      await client.query(`UPDATE users SET status = 5 WHERE id = $1::bigint`, [lifted]);
      expect(await value<boolean>(`SELECT listed FROM profile_reviews WHERE user_id = $1::bigint`, [lifted])).toBe(false);
      await client.query(`DELETE FROM profile_reviews WHERE user_id = $1::bigint`, [lifted]);
      await client.query(`UPDATE users SET status = 2 WHERE id = $1::bigint`, [lifted]);
      expect(await value<boolean>(`SELECT listed FROM profile_reviews WHERE user_id = $1::bigint`, [lifted])).toBe(true);
      // Approved: the row goes.
      await client.query(`UPDATE users SET status = 3 WHERE id = $1::bigint`, [lifted]);
      expect(await value<number>(`SELECT count(*)::int FROM profile_reviews WHERE user_id = $1::bigint`, [lifted])).toBe(0);
    } finally {
      await client.query(`DELETE FROM users WHERE id < $1::bigint`, [min]);
      await client.query('ANALYZE users, profile_reviews');
    }
  });

  it('runs again as a no-op, and keeps the review rows from the analytics role', async () => {
    await client.query(readFileSync(new URL(`../migrations/${FILE}`, import.meta.url), 'utf8'));
    expect(await value<number>('SELECT count(*)::int FROM profile_reviews')).toBe(30);
    const roles = await value<boolean>(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ro')`);
    if (!roles) return;
    expect(await value<boolean>(`SELECT has_table_privilege('app_ro', 'profile_reviews', 'SELECT')`)).toBe(false);
  });
});
