import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountView, adminDecideTexts, adminUserListStatement, createPool, runMigrations, sql, type Pool } from '../src/index.js';
import { createTempDatabase, hasDatabase, requireSetup, type TempDatabase } from './support.js';

/**
 * Migration 0026 on the real migrations: profile_text_decide() in every
 * case, the reject codes in account_view(), and the plans of the user list's
 * filters and the name search (each from its index, never a scan of users).
 */

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

describe.skipIf(!hasDatabase)('admin users (migration 0026)', () => {
  let db: TempDatabase;
  let client: pg.Client;
  let pool: Pool;
  let ready = false;

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
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await client?.end();
    await db?.drop();
  });

  async function scalar<T>(text: string, values: unknown[] = []): Promise<T> {
    const { rows } = await client.query<{ v: T }>(text, values);
    return rows[0]?.v as T;
  }

  /** A person with a profile: about and job waiting (state 1) unless given, and prompt answers. */
  async function person(options: { about?: string | null; job?: string | null; state?: number; prompts?: [number, string | null, number][]; name?: string } = {}): Promise<string> {
    const id = await scalar<string>(`INSERT INTO users (id, status, birth_date, gender) VALUES (id_next(), 3, '1990-01-01', 1) RETURNING id::text AS v`);
    await client.query(`INSERT INTO profiles (user_id, display_name, about, job_title, text_state) VALUES ($1, $2, $3, $4, $5)`, [
      id,
      options.name ?? 'Person',
      options.about === undefined ? 'About' : options.about,
      options.job === undefined ? null : options.job,
      options.state ?? 1,
    ]);
    for (const [position, answer, status] of options.prompts ?? []) {
      const prompt = await scalar<number>(`INSERT INTO prompt_defs (i18n) VALUES ('{"en": "Q"}') RETURNING id AS v`);
      await client.query(`INSERT INTO profile_prompts (user_id, position, prompt_id, answer, audio_ms, status) VALUES ($1, $2, $3, $4, $5, $6)`, [
        id,
        position,
        prompt,
        answer,
        answer === null ? 5_000 : null,
        status,
      ]);
    }
    return id;
  }

  const version = (userId: string) => scalar<number>(`SELECT version AS v FROM profiles WHERE user_id = $1`, [userId]);
  const newId = () => scalar<string>(`SELECT id_next()::text AS v`);

  async function decide(userId: string, input: { version?: number; rejectProfile?: boolean | null; rejectPrompts?: number[] | null; reason?: number | null }) {
    return adminDecideTexts(pool, {
      userId,
      version: input.version ?? (await version(userId)),
      adminId: null,
      rejectProfile: input.rejectProfile === undefined ? false : input.rejectProfile,
      rejectPrompts: input.rejectPrompts === undefined ? [] : input.rejectPrompts,
      reasonCode: input.reason ?? null,
      actionId: await newId(),
      reasonText: input.reason ? 'Rejected.' : null,
    });
  }

  it('approves what waits, the name-only profile included, and records nothing', async (ctx) => {
    if (!ready) ctx.skip();
    const a = await person({ job: 'Job', prompts: [[0, 'One', 1], [1, 'Two', 2]] });
    const { outcome, texts } = await decide(a, {});
    expect(outcome).toMatchObject({ outcome: 'decided', before: { textState: 1 }, after: { textState: 2, prompts: [{ position: 0, status: 2 }, { position: 1, status: 2 }] }, actionId: null, rejected: { profile: false, prompts: [] } });
    expect(texts).toMatchObject({ about: 'About', job: 'Job', textState: 2 });
    expect(await scalar<number>(`SELECT count(*)::integer AS v FROM moderation_actions WHERE user_id = $1`, [a])).toBe(0);
    expect((await decide(a, {})).outcome).toMatchObject({ outcome: 'unchanged' });
    const nameOnly = await person({ about: null });
    expect((await decide(nameOnly, {})).outcome).toMatchObject({ outcome: 'decided', after: { textState: 2 } });
  });

  it('rejects named parts with the code and approves the rest; NULLs reject every part that waits', async (ctx) => {
    if (!ready) ctx.skip();
    const a = await person({ prompts: [[0, 'One', 1], [1, 'Two', 1], [2, null, 1]] });
    const one = await decide(a, { rejectPrompts: [1], reason: 3 });
    expect(one.outcome).toMatchObject({ outcome: 'decided', after: { textState: 2, prompts: [{ status: 2 }, { status: 3, rejectReason: 3 }, { status: 2 }] } });
    expect(await scalar<string>(`SELECT note AS v FROM moderation_actions WHERE user_id = $1 AND kind = 7`, [a])).toBe('prompt 2');
    const b = await person({ job: 'Shop link', prompts: [[0, 'Number', 1], [1, 'Fine', 2]] });
    const all = await decide(b, { rejectProfile: null, rejectPrompts: null, reason: 1 });
    expect(all.outcome).toMatchObject({ outcome: 'decided', after: { textState: 3, textRejectReason: 1, prompts: [{ status: 3, rejectReason: 1 }, { status: 2 }] }, rejected: { profile: true, prompts: [0] } });
    expect(await scalar<string>(`SELECT note AS v FROM moderation_actions WHERE user_id = $1 AND kind = 7`, [b])).toBe('about/job, prompt 1');
    // An approved part may be rejected too (from a report).
    const again = await decide(b, { rejectPrompts: [1], reason: 2 });
    expect(again.outcome).toMatchObject({ outcome: 'decided', after: { prompts: [{ status: 3 }, { status: 3, rejectReason: 2 }] } });
  });

  it('writes nothing for a repeated decision: the version stays, no record, no discovery resync', async (ctx) => {
    if (!ready) ctx.skip();
    const a = await person({ job: 'Shop link', prompts: [[0, 'Call me', 1], [1, 'Fine', 1]] });
    expect((await decide(a, { rejectProfile: true, rejectPrompts: [0], reason: 2 })).outcome).toMatchObject({ outcome: 'decided' });
    const after = await version(a);
    const records = () => scalar<number>(`SELECT count(*)::integer AS v FROM moderation_actions WHERE user_id = $1`, [a]);
    expect(await records()).toBe(1);
    // The identical rejection again, and an approval with nothing waiting: unchanged, and nothing at all written.
    expect((await decide(a, { rejectProfile: true, rejectPrompts: [0], reason: 2 })).outcome).toMatchObject({ outcome: 'unchanged', version: after, locale: 'en' });
    expect((await decide(a, {})).outcome).toMatchObject({ outcome: 'unchanged', version: after });
    expect(await version(a)).toBe(after);
    expect(await records()).toBe(1);
  });

  it('answers missing, stale and invalid parts, and refuses a rejection without a reason', async (ctx) => {
    if (!ready) ctx.skip();
    expect((await decide('4242424242', { version: 1 })).outcome).toEqual({ outcome: 'missing' });
    const a = await person({ about: null, prompts: [[0, null, 1]] });
    expect((await decide(a, { version: (await version(a)) + 1 })).outcome).toMatchObject({ outcome: 'stale' });
    expect((await decide(a, { rejectProfile: true, reason: 1 })).outcome).toEqual({ outcome: 'invalid_part', part: 'profile' });
    expect((await decide(a, { rejectPrompts: [0, 2], reason: 1 })).outcome).toEqual({ outcome: 'invalid_part', part: 'prompts', positions: [0, 2] });
    const b = await person();
    await expect(decide(b, { rejectProfile: true, reason: null })).rejects.toThrow(/needs a reason/);
  });

  it('shows the reject codes in account_view only while rejected', async (ctx) => {
    if (!ready) ctx.skip();
    const a = await person({ prompts: [[0, 'One', 1], [1, 'Two', 1]] });
    await decide(a, { rejectProfile: true, rejectPrompts: [0], reason: 2 });
    let view = await accountView(pool, a);
    if (view.kind !== 'account') throw new Error('no view');
    expect(view.view.profile).toMatchObject({ textState: 3, textRejectReason: 2 });
    expect(view.view.prompts.map((p) => [p.status, p.rejectReason])).toEqual([[3, 2], [2, undefined]]);
    // An edit that moves the state leaves the old code unread.
    await client.query(`UPDATE profiles SET text_state = 1 WHERE user_id = $1`, [a]);
    view = await accountView(pool, a);
    if (view.kind !== 'account') throw new Error('no view');
    expect(view.view.profile?.textRejectReason).toBeUndefined();
  });

  it('serves each filter of the user list from its index, and names from the trigram index', async (ctx) => {
    if (!ready) ctx.skip();
    await person({ name: 'Sara Ahmadi' });
    await person({ name: 'علی رضایی' });
    const plan = async (fragment: ReturnType<typeof sql>): Promise<string> => {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL enable_seqscan = off');
        const query = fragment.toQuery();
        const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${query.text}`, query.values);
        return rows.map((r) => r['QUERY PLAN']).join('\n');
      } finally {
        await client.query('ROLLBACK');
      }
    };
    const expected = { pending_review: 'users_attention_idx', suspended: 'users_attention_idx', banned: 'users_attention_idx', shadowbanned: 'users_shadowbanned_idx', test: 'users_test_idx' } as const;
    for (const [filter, index] of Object.entries(expected)) {
      const text = await plan(adminUserListStatement({ filter: filter as keyof typeof expected, beforeId: '99999999999999999', limit: 21 }));
      expect(text, filter).toContain(index);
      expect(text, filter).not.toMatch(/Seq Scan on users/);
    }
    expect(await plan(adminUserListStatement({ limit: 21 }))).toContain('users_pkey');
    // The name search's own statement (admin_name_search: the threshold is set on the function) reads the GIN index.
    const names = await plan(sql`SELECT p.user_id FROM profiles p WHERE ${'رضا'}::text <<% p.display_name ORDER BY ${'رضا'}::text <<-> p.display_name LIMIT 50`);
    expect(names).toContain('profiles_name_trgm_idx');
    // Persian letters make trigrams under this cluster's locale: the name is found by part of a word.
    const near = await scalar<string>(`SELECT (SELECT p.display_name FROM admin_name_search('رضایی', 1) n JOIN profiles p USING (user_id)) AS v`);
    expect(near).toBe('علی رضایی');
    expect(await scalar<string>(`SELECT (SELECT p.display_name FROM admin_name_search('sara', 5) n JOIN profiles p USING (user_id)) AS v`)).toBe('Sara Ahmadi');
    expect(await scalar<number>(`SELECT word_similarity('رضا', 'علی رضایی') AS v`)).toBeGreaterThan(0.3);
  });
  it('finds names from the GIN trigram index; a text close to no name reads a few pages among many names', async (ctx) => {
    if (!ready) ctx.skip();
    // 50,000 names from common parts, each with its own number (as many people share a first and last name).
    await client.query(`WITH n AS (
        SELECT i, (ARRAY['Sara','Ali','Reza','Mina','Zahra','Omid','Ayse','Mehmet','Elif','Can','Leyla','Hamid','Nasrin','Kaveh','Deniz','Emre','Parisa','Babak','Selin','Arash'])[1 + i % 20]
                  || ' ' || (ARRAY['Ahmadi','Karimi','Yilmaz','Kaya','Hosseini','Rahimi','Demir','Sahin','Moradi','Celik','Jafari','Ozturk','Rezaei','Aydin','Ghasemi'])[1 + (i / 20) % 15]
                  || ' ' || i AS name
          FROM generate_series(1, 50000) i),
      u AS (INSERT INTO users (id, status, birth_date, gender) SELECT id_next(), 3, '1990-01-01', 1 FROM n RETURNING id),
      pairs AS (SELECT u.id, row_number() OVER (ORDER BY u.id) AS k FROM u)
      INSERT INTO profiles (user_id, display_name) SELECT p.id, n.name FROM pairs p JOIN n ON n.i = p.k`);
    // The pending entries of a bulk insert are merged into the index (as autovacuum does), then read like production.
    await client.query(`SELECT gin_clean_pending_list('profiles_name_trgm_idx'::regclass)`);
    await client.query('ANALYZE profiles');
    const buffers = async (q: string): Promise<{ hit: number; plan: string }> => {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL pg_trgm.strict_word_similarity_threshold = 0.3`);
        const { rows } = await client.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT p.user_id FROM profiles p WHERE $1::text <<% p.display_name ORDER BY $1::text <<-> p.display_name LIMIT 50`,
          [q],
        );
        const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
        const total = [...plan.matchAll(/Buffers: shared (?:hit=(\d+))?\s*(?:read=(\d+))?/g)].reduce((max, m) => Math.max(max, Number(m[1] ?? 0) + Number(m[2] ?? 0)), 0);
        return { hit: total, plan };
      } finally {
        await client.query('ROLLBACK');
      }
    };
    const none = await buffers('Xavier Quinto');
    expect(none.plan).toContain('profiles_name_trgm_idx');
    expect(none.hit, none.plan).toBeLessThan(100);
    expect(await scalar<number>(`SELECT count(*)::integer AS v FROM admin_name_search('Xavier Quinto', 50)`)).toBe(0);
    // A near name is found, nearest first.
    expect(await scalar<string>(`SELECT (SELECT p.display_name FROM admin_name_search('Elif Sahin 4648', 1) n JOIN profiles p USING (user_id)) AS v`)).toBe('Elif Sahin 4648');
  });
});
