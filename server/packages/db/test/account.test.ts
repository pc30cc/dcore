import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountView, createPool, instrumentPool, runMigrations, statementCounter, type Pool } from '../src/index.js';
import { createTempDatabase, hasDatabase, requireSetup, type TempDatabase } from './support.js';

/** Migration 0010: users.notify_flags and account_view(), on the real migrations. */

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const CELL = '608692970769612799';
const POINT = 'ST_SetSRID(ST_MakePoint(-122.42, 37.77), 4326)::geography';

describe.skipIf(!hasDatabase)('account view (migration 0010)', () => {
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
    pool = instrumentPool(createPool({ connectionString: db.url, applicationName: 'db-test', max: 2 }));
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await client?.end();
    await db?.drop();
  });

  async function newUser(status = 3): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO users (id, birth_date, status, gender, onboarding_step, country, deleted_at)
       VALUES (id_next(), CASE WHEN $1::smallint = 8 THEN NULL ELSE DATE '1995-03-01' END, $1::smallint, CASE WHEN $1::smallint = 8 THEN NULL ELSE 2 END, 9, CASE WHEN $1::smallint = 8 THEN NULL ELSE 'IR' END, CASE WHEN $1::smallint IN (7, 8) THEN now() END) RETURNING id::text`,
      [status],
    );
    return rows[0]!.id;
  }

  it('gives notify_flags its default and range', async (ctx) => {
    if (!ready) ctx.skip();
    const id = await newUser();
    const { rows } = await client.query<{ notify_flags: number }>('SELECT notify_flags FROM users WHERE id = $1', [id]);
    expect(rows[0]!.notify_flags).toBe(15);
    await expect(client.query('UPDATE users SET notify_flags = 64 WHERE id = $1', [id])).rejects.toMatchObject({ code: '23514' });
  });

  it('builds the whole view in one statement, ids as text, nothing private', async (ctx) => {
    if (!ready) ctx.skip();
    const id = await newUser();
    await client.query(`INSERT INTO profiles (user_id, display_name, about, completeness, intention) VALUES ($1, 'Sam', 'Hi', 70, 2)`, [id]);
    await client.query(`INSERT INTO preferences (user_id, interested_in, intents) VALUES ($1, 10, 2)`, [id]);
    await client.query(`INSERT INTO user_locations (user_id, home_h3, home_city_id, source, country, home_geo) VALUES ($1, $2, 112931, 1, 'IR', ${POINT})`, [id, CELL]);
    await client.query(
      `INSERT INTO photos (id, user_id, position, status, width, height, blurhash, reject_reason)
       VALUES (id_next(), $1, 0, 3, 1080, 1350, 'LEHV', NULL), (id_next(), $1, 1, 4, 800, 1000, 'x', 2), (id_next(), $1, 2, 1, NULL, NULL, NULL, NULL)`,
      [id],
    );
    await client.query(`INSERT INTO user_consents (user_id, kind, version, store) VALUES ($1, 1, 1, 2), ($1, 2, 1, 2), ($1, 6, 1, 2)`, [id]);
    await client.query(`UPDATE user_consents SET withdrawn_at = now() WHERE user_id = $1 AND kind = 6`, [id]);
    const { rows: actions } = await client.query<{ id: string }>(
      `INSERT INTO moderation_actions (id, user_id, kind, reason_code, reason_text, ends_at, note)
       VALUES (id_next(), $1, 2, 1, 'Harassment', now() + interval '2 days', 'internal note') RETURNING id::text`,
      [id],
    );
    await client.query(`INSERT INTO moderation_actions (id, user_id, kind, reason_code, reason_text) VALUES (id_next(), $1, 4, 1, 'shadow'), (id_next(), $1, 1, 1, 'a warning')`, [id]);
    await client.query(`INSERT INTO moderation_actions (id, user_id, kind, reason_code, reason_text, starts_at, ends_at) VALUES (id_next(), $1, 2, 1, 'old', now() - interval '9 days', now() - interval '2 days')`, [id]);
    await client.query(`INSERT INTO appeals (id, user_id, action_id, body) VALUES (id_next(), $1, $2, 'please')`, [id, actions[0]!.id]);

    const { result, tally } = await statementCounter.measure(() => accountView(pool, id));
    expect(tally.statements).toBe(1);
    expect(accountView.info.statements).toBe(1);
    expect(result.kind).toBe('account');
    if (result.kind !== 'account') return;
    const view = result.view;
    expect(view).toMatchObject({ status: 3, onboardingStep: 9, gender: 2, birthDate: '1995-03-01', notifyFlags: 15, verified: false });
    expect(view.profile).toMatchObject({ name: 'Sam', about: 'Hi', intention: 2, textState: 1, modeMatch: true, acceptCalls: true });
    expect(view.photos.map((p) => [p.position, p.status, p.rejectReason])).toEqual([[0, 3, undefined], [1, 4, 2], [2, 1, undefined]]);
    expect(view.photos[0]!.id).toMatch(/^[0-9]{17,19}$/);
    expect(view.preferences).toMatchObject({ interestedIn: 10, intents: 2, ageMin: 18 });
    expect(view.location).toEqual({ cityId: 112931, country: 'IR', source: 1 });
    // Only the running suspension; the shadowban, the warning and the ended one stay out.
    expect(view.moderation).toHaveLength(1);
    expect(view.moderation[0]).toMatchObject({ id: actions[0]!.id, kind: 2, reasonText: 'Harassment', appeal: { status: 1 } });
    expect(view.consents).toEqual({ 1: 1, 2: 1 });
    expect(view.consentsDue).toEqual([3]);
    const text = JSON.stringify(view);
    for (const forbidden of [CELL, 'internal note', 'shadow', 'geo', 'h3', 'Shadowban', 'is_shadowbanned']) expect(text).not.toContain(forbidden);
  });

  it('asks for the consents again when legal.versions is raised', async (ctx) => {
    if (!ready) ctx.skip();
    const id = await newUser(1);
    await client.query(`INSERT INTO user_consents (user_id, kind, version) VALUES ($1, 1, 1), ($1, 2, 1), ($1, 3, 1)`, [id]);
    const before = await accountView(pool, id);
    expect(before.kind === 'account' && before.view.consentsDue).toEqual([]);
    await client.query(`UPDATE public.app_config SET value = '{"terms": 2, "privacy": 1, "guidelines": 1}' WHERE key = 'legal.versions'`);
    try {
      const after = await accountView(pool, id);
      expect(after.kind === 'account' && after.view.consentsDue).toEqual([1]);
      await client.query(`INSERT INTO user_consents (user_id, kind, version) VALUES ($1, 1, 2)`, [id]);
      const accepted = await accountView(pool, id);
      expect(accepted.kind === 'account' && accepted.view).toMatchObject({ consentsDue: [], consents: { 1: 2 } });
    } finally {
      await client.query(`UPDATE public.app_config SET value = '{"terms": 1, "privacy": 1, "guidelines": 1}' WHERE key = 'legal.versions'`);
    }
  });

  it('answers a deleted account minimally, a purged one with its status, an unknown id with nothing', async (ctx) => {
    if (!ready) ctx.skip();
    const deleted = await newUser(7);
    const result = await accountView(pool, deleted);
    expect(result.kind).toBe('deleted');
    if (result.kind === 'deleted') expect(result.purgeAtMs - result.deletedAtMs).toBe(30 * 86_400_000);
    const { rows } = await client.query<{ id: string }>(`INSERT INTO users (id, status, deleted_at, deleted_via) VALUES (id_next(), 8, now(), 4) RETURNING id::text`);
    expect(await accountView(pool, rows[0]!.id)).toEqual({ kind: 'purged' });
    expect(await accountView(pool, '1')).toEqual({ kind: 'missing' });
  });
});
