import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, type MigrationLog } from '../src/index.js';
import { createTempDatabase, hasDatabase, requireSetup, type TempDatabase } from './support.js';

/**
 * Migration 0035: the dashboard's statistics functions on seeded rows (test
 * accounts left out everywhere, a day run twice changes nothing; an older day
 * run again never shortens a closed cohort window), the places suppression (a
 * place under 10 and a cell under 5 go to Other, and nothing published, nor a
 * country minus its cities, nor Other minus ZZ, counts 1 to 4 people), the
 * statistics that keep the test-account filter hashed, moderator decisions,
 * conversion, the live counts, the grants, discovery_sync's sign-up-day
 * fallback and the one-time backfill of users.last_active_on. Migration
 * 0037: a match or a call is out when either side is a test account.
 */

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const quiet: MigrationLog = { info: () => undefined, warn: () => undefined };
const GROUP_ROLES = ['app_rw', 'app_ro', 'app_maint'] as const;
const CELL = '608692970769612799';
const POINT = "ST_SetSRID(ST_MakePoint(-122.42, 37.77), 4326)::geography";
const DAY_MS = 86_400_000;

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

/** `YYYY-MM-DD` of today − `back` days (UTC). */
function dayBack(back: number): string {
  return new Date(Date.now() - back * DAY_MS).toISOString().slice(0, 10);
}

function plusDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

interface Fixture {
  client: pg.Client;
  seq: number;
}

/** A fresh id at `time` (ISO): id_floor(time) plus a counter, so ids of one instant stay distinct. */
async function idAt(f: Fixture, time: string): Promise<string> {
  f.seq += 1;
  const { rows } = await f.client.query<{ id: string }>(`SELECT (id_floor($1::timestamptz) + $2::bigint)::text AS id`, [time, f.seq]);
  return rows[0]!.id;
}

interface UserOptions {
  status?: number;
  step?: number;
  flags?: number;
  refused?: boolean;
}

async function user(f: Fixture, time: string, options: UserOptions = {}): Promise<string> {
  const id = await idAt(f, time);
  const status = options.refused ? 8 : (options.status ?? 3);
  const profile = status !== 1 && status < 7;
  await f.client.query(
    `INSERT INTO users (id, status, birth_date, gender, onboarding_step, flags, country, deleted_at, deleted_via)
     VALUES ($1, $2::smallint, CASE WHEN $3 THEN DATE '1995-03-01' END, CASE WHEN $3 THEN 1 END, $4, $5, CASE WHEN $3 THEN 'TR' END,
             CASE WHEN $2::smallint IN (7, 8) THEN now() END, CASE WHEN $6 THEN 4 END)`,
    [id, status, profile, options.step ?? 30, options.flags ?? 0, options.refused ?? false],
  );
  return id;
}

async function rowsOf(client: pg.Client, metrics: string[], day?: string): Promise<Record<string, number>> {
  const { rows } = await client.query<{ k: string; v: string }>(
    `SELECT metric || '|' || day::text || '|' || dim AS k, value::text AS v FROM stats_daily
      WHERE metric = ANY ($1) AND ($2::date IS NULL OR day = $2) ORDER BY 1`,
    [metrics, day ?? null],
  );
  return Object.fromEntries(rows.map((r) => [r.k, Number(r.v)]));
}

async function json<T>(client: pg.Client, text: string, values: unknown[] = []): Promise<T> {
  const { rows } = await client.query<{ v: T }>(text, values);
  return rows[0]!.v;
}

describe.skipIf(!hasDatabase)('migration 0035: statistics', () => {
  let db: TempDatabase;
  let client: pg.Client;
  let ready = false;
  let roles = false;
  const f = { seq: 0 } as Fixture;
  const D = dayBack(5);

  beforeAll(async () => {
    db = await createTempDatabase();
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
    f.client = client;
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
    // The days the suite writes may be in a month before the partitions made at migration time.
    for (const back of [12, 5, 3, 0]) {
      await client.query(`SELECT partition_create('messages', $1::timestamptz)`, [`${dayBack(back)}T12:00:00Z`]);
      await client.query(`SELECT partition_create('audit_log', $1::timestamptz)`, [`${dayBack(back)}T12:00:00Z`]);
    }
  }, 90_000);

  afterAll(async () => {
    await client?.end();
    await db?.drop();
  });

  it('counts sign-up cohorts by stored step, refusals apart, test accounts out; a run again changes nothing', async (ctx) => {
    if (!ready) ctx.skip();
    await user(f, `${D}T10:00:00Z`, { status: 1, step: 0 });
    const moving = await user(f, `${D}T11:00:00Z`, { status: 1, step: 12 });
    await user(f, `${D}T12:00:00Z`, { step: 30 });
    await user(f, `${D}T13:00:00Z`, { refused: true, step: 4 });
    await user(f, `${D}T14:00:00Z`, { step: 30, flags: 1 });
    await user(f, `${plusDays(D, -1)}T23:59:00Z`, { step: 30 });

    await client.query(`SELECT stats_rollup_people($1::date)`, [D]);
    const first = await rowsOf(client, ['signups', 'signup_step', 'signup_refused']);
    expect(first).toEqual({
      [`signup_refused|${D}|`]: 1,
      [`signup_step|${plusDays(D, -1)}|30`]: 1,
      [`signup_step|${D}|0`]: 1,
      [`signup_step|${D}|12`]: 1,
      [`signup_step|${D}|30`]: 1,
      [`signup_step|${D}|4`]: 1,
      [`signups|${plusDays(D, -1)}|`]: 1,
      [`signups|${D}|`]: 4,
    });
    await client.query(`SELECT stats_rollup_people($1::date)`, [D]);
    expect(await rowsOf(client, ['signups', 'signup_step', 'signup_refused'])).toEqual(first);

    await client.query(`UPDATE users SET onboarding_step = 30 WHERE id = $1`, [moving]);
    await client.query(`SELECT stats_rollup_people($1::date)`, [D]);
    const moved = await rowsOf(client, ['signup_step'], D);
    expect(moved[`signup_step|${D}|12`]).toBeUndefined();
    expect(moved[`signup_step|${D}|30`]).toBe(2);
  });

  it('counts matches, conversations, calls and reports of the day, test accounts out', async (ctx) => {
    if (!ready) ctx.skip();
    const old = `${plusDays(D, -10)}T08:00:00Z`;
    const [a, b, c] = [await user(f, old), await user(f, old), await user(f, old)];
    const [t1, t2] = [await user(f, old, { flags: 1 }), await user(f, old, { flags: 1 })];
    const match = async (x: string, y: string, time: string, source: number) => {
      const id = await idAt(f, time);
      await client.query(`INSERT INTO matches (id, user_lo, user_hi, source) VALUES ($1, least($2::bigint, $3::bigint), greatest($2::bigint, $3::bigint), $4)`, [id, x, y, source]);
      return id;
    };
    const message = async (matchId: string, sender: string, time: string, kind = 1) => {
      await client.query(`INSERT INTO messages (match_id, id, sender_id, kind, body) VALUES ($1, $2, $3, $4, 'x')`, [matchId, await idAt(f, time), sender, kind]);
    };
    const m1 = await match(a, b, `${D}T09:00:00Z`, 1);
    const m2 = await match(t1, t2, `${D}T09:30:00Z`, 1);
    const m3 = await match(a, c, `${D}T10:00:00Z`, 2);
    await message(m1, a, `${D}T09:05:00Z`);
    await message(m1, b, `${D}T09:10:00Z`);
    await message(m2, t1, `${D}T09:35:00Z`);
    await message(m2, t2, `${D}T09:36:00Z`);
    await message(m3, c, `${D}T10:01:00Z`, 6);
    await message(m3, a, `${plusDays(D, 2)}T10:00:00Z`);
    // A match of D - 6: its window ends with D; a reply on D + 1 is too late.
    const m4 = await match(b, c, `${plusDays(D, -6)}T09:00:00Z`, 1);
    await message(m4, b, `${plusDays(D, -6)}T10:00:00Z`);
    await message(m4, c, `${plusDays(D, 1)}T10:00:00Z`);

    const call = async (matchId: string, caller: string, callee: string, time: string, kind: number, answeredS: number | null, endedAt: string, duration: number) => {
      const id = await idAt(f, time);
      await client.query(
        `INSERT INTO calls (id, match_id, caller_id, callee_id, answered_at, ended_at, duration_s, kind, outcome, ended_by, end_reason)
         VALUES ($1, $2, $3, $4, CASE WHEN $5::integer IS NULL THEN NULL ELSE $6::timestamptz + make_interval(secs => $5::integer) END,
                 $7::timestamptz, $8, $9, CASE WHEN $5::integer IS NULL THEN 4 ELSE 1 END, CASE WHEN $5::integer IS NULL THEN 3 ELSE 1 END,
                 CASE WHEN $5::integer IS NULL THEN 4 ELSE 1 END)`,
        [id, matchId, caller, callee, answeredS, time, endedAt, duration, kind],
      );
    };
    await call(m1, a, b, `${D}T23:59:50Z`, 1, 5, `${plusDays(D, 1)}T00:02:00Z`, 120);
    await call(m1, b, a, `${D}T15:00:00Z`, 2, null, `${D}T15:00:30Z`, 0);
    await call(m2, t1, t2, `${D}T16:00:00Z`, 1, 2, `${D}T16:05:00Z`, 298);

    const report = async (reporter: string | null, target: string, reason: number, time: string) => {
      await client.query(`INSERT INTO reports (id, reporter_id, target_id, context, reason) VALUES ($1, $2, $3, 1, $4)`, [await idAt(f, time), reporter, target, reason]);
    };
    await report(a, b, 2, `${D}T12:00:00Z`);
    await report(null, c, 4, `${D}T12:30:00Z`);
    await report(t1, t2, 2, `${D}T12:40:00Z`);
    await report(null, t2, 4, `${D}T12:50:00Z`);

    await client.query(`SELECT stats_rollup_social($1::date)`, [D]);
    const metrics = ['matches', 'conversations', 'replied', 'calls', 'calls_answered', 'call_minutes', 'reports', 'reports_auto'];
    const got = await rowsOf(client, metrics, D);
    expect(got).toEqual({
      [`call_minutes|${D}|1`]: 2,
      [`calls_answered|${D}|1`]: 1,
      [`calls|${D}|1`]: 1,
      [`calls|${D}|2`]: 1,
      // m1, and m3 by a's message two days later (within its 7 days, before today).
      [`conversations|${D}|`]: 2,
      [`matches|${D}|1`]: 1,
      [`matches|${D}|2`]: 1,
      [`replied|${D}|`]: 1,
      [`reports_auto|${D}|4`]: 1,
      [`reports|${D}|2`]: 1,
    });
    expect(await rowsOf(client, ['conversations', 'replied'], plusDays(D, -6))).toEqual({ [`conversations|${plusDays(D, -6)}|`]: 1 });
    await client.query(`SELECT stats_rollup_social($1::date)`, [D]);
    expect(await rowsOf(client, metrics, D)).toEqual(got);
  });

  it('builds the revenue cube, ends, renewals turned off, conversion and the MRR snapshot', async (ctx) => {
    if (!ready) ctx.skip();
    const product = async (store: number, productId: string, basePlan: string | null = null) =>
      (
        await client.query<{ id: number; plan: number | null }>(
          `SELECT id, plan_id AS plan FROM store_products WHERE store = $1 AND product_id = $2 AND base_plan_id IS NOT DISTINCT FROM $3`,
          [store, productId, basePlan],
        )
      ).rows[0]!;
    const plus1m = await product(1, 'sub.plus', 'm1');
    const plus1w = await product(1, 'sub.plus', 'w1');
    const premium3m = await product(2, 'sub.premium.3m');
    const superlike = await product(1, 'cons.superlike.5');
    const at = (back: number, hm: string) => `${plusDays(D, back)}T${hm}:00Z`;
    const [ua, ub, uc] = [await user(f, at(-10, '08:00')), await user(f, at(-10, '08:00')), await user(f, at(-10, '08:00'))];
    const ue = await user(f, at(-2, '08:00'));
    const uf = await user(f, at(-20, '08:00'));
    const ut = await user(f, at(-10, '08:00'), { flags: 1 });
    let tokens = 0;
    const purchase = async (owner: string, p: { id: number }, store: number, kind: number, options: { test?: boolean; region?: string } = {}) => {
      tokens += 1;
      const id = await idAt(f, at(-1, '00:00'));
      await client.query(
        `INSERT INTO store_purchases (id, user_id, purchased_at, expires_at, product_ref, store, kind, state, is_test, region, token_hash, token)
         VALUES ($1, $2, now(), now() + interval '30 days', $3, $4, $5, 2, $6, $7, sha256($8::bytea), $8)`,
        [id, owner, p.id, store, kind, options.test ?? false, options.region ?? 'TR', `token-${tokens}-${id}`],
      );
      return id;
    };
    const event = async (purchaseId: string, owner: string, store: number, code: number, time: string, amount?: { micros: string; currency: string; estimated?: boolean }) => {
      await client.query(
        `INSERT INTO store_events (id, purchase_id, user_id, occurred_at, amount_micros, store, event, source, state_to, amount_estimated, currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 2, $8, $9)`,
        [await idAt(f, time), purchaseId, owner, time, amount?.micros ?? null, store, code, amount?.estimated ?? false, amount?.currency ?? null],
      );
    };
    const usd = (micros: string) => ({ micros, currency: 'USD' });
    const p1 = await purchase(ua, plus1m, 1, 1);
    await event(p1, ua, 1, 1, at(0, '10:00'), usd('5000000'));
    await event(p1, ua, 1, 10, at(0, '13:00'), usd('5000000'));
    const p2 = await purchase(ub, premium3m, 2, 1, { region: 'IR' });
    await event(p2, ub, 2, 1, at(0, '11:00'), { micros: '300000000000', currency: 'IRR', estimated: true });
    const p3 = await purchase(ua, superlike, 1, 2);
    await event(p3, ua, 1, 1, at(0, '12:00'), usd('1000000'));
    const p4 = await purchase(ua, plus1m, 1, 1, { test: true });
    await event(p4, ua, 1, 1, at(0, '12:10'), usd('5000000'));
    const p5 = await purchase(ut, plus1m, 1, 1);
    await event(p5, ut, 1, 1, at(0, '12:20'), usd('5000000'));
    const p6 = await purchase(uc, plus1w, 1, 1);
    await event(p6, uc, 1, 3, at(0, '14:00'));
    await event(p6, uc, 1, 9, at(0, '15:00'));
    await event(p6, uc, 1, 11, at(0, '15:30'));
    const p7 = await purchase(ue, plus1m, 1, 1);
    await event(p7, ue, 1, 1, at(0, '16:00'), usd('5000000'));
    const p8 = await purchase(uf, plus1w, 1, 1);
    await event(p8, uf, 1, 2, at(-1, '09:00'), usd('1000000'));
    const sub = async (owner: string, store: number, purchaseId: string, plan: number, status: number) =>
      client.query(
        `INSERT INTO subscriptions (user_id, started_at, expires_at, purchase_id, plan_id, store, status) VALUES ($1, now(), now() + interval '20 days', $2, $3, $4, $5)`,
        [owner, purchaseId, plan, store, status],
      );
    await sub(ue, 1, p7, plus1m.plan!, 1);
    await sub(uf, 1, p8, plus1w.plan!, 1);
    await sub(ub, 2, p2, premium3m.plan!, 3);
    await sub(ut, 1, p5, plus1m.plan!, 1);

    await client.query(`SELECT stats_rollup_money($1::date, true)`, [D]);
    const cube = (
      await client.query(
        `SELECT store, product_ref, region, currency, gross_micros::text AS gross, refund_micros::text AS refund, payments, refunds, new_subs, estimated
           FROM stats_revenue_daily WHERE day = $1 ORDER BY store, product_ref`,
        [D],
      )
    ).rows;
    expect(cube).toEqual([
      { store: 1, product_ref: plus1m.id, region: 'TR', currency: 'USD', gross: '10000000', refund: '5000000', payments: 2, refunds: 1, new_subs: 2, estimated: false },
      { store: 1, product_ref: superlike.id, region: 'TR', currency: 'USD', gross: '1000000', refund: '0', payments: 1, refunds: 0, new_subs: 0, estimated: false },
      { store: 2, product_ref: premium3m.id, region: 'IR', currency: 'IRR', gross: '300000000000', refund: '0', payments: 1, refunds: 0, new_subs: 1, estimated: true },
    ].sort((x, y) => x.store - y.store || x.product_ref - y.product_ref));

    const money = await rowsOf(client, ['churn', 'cancels', 'subs', 'subs_renewing', 'mrr'], D);
    const plus = plus1m.plan!;
    expect(plus1w.plan).toBe(plus);
    expect(money).toEqual({
      [`cancels|${D}|1:${plus}`]: 1,
      [`churn|${D}|1:${plus}`]: 2,
      [`mrr|${D}|1:USD`]: Math.round(5_000_000 + 1_000_000 / ((7 / 30.4375))),
      [`mrr|${D}|2:IRR`]: 100_000_000_000,
      [`subs_renewing|${D}|1:${plus}`]: 2,
      [`subs_renewing|${D}|2:${premium3m.plan!}`]: 1,
      [`subs|${D}|1:${plus}`]: 2,
      [`subs|${D}|2:${premium3m.plan!}`]: 1,
    });

    const conversion = await rowsOf(client, ['conv_d7', 'conv_d30']);
    expect(conversion).toEqual({
      [`conv_d30|${plusDays(D, -10)}|1`]: 1,
      [`conv_d30|${plusDays(D, -10)}|2`]: 1,
      [`conv_d30|${plusDays(D, -20)}|1`]: 1,
      [`conv_d30|${plusDays(D, -2)}|1`]: 1,
      [`conv_d7|${plusDays(D, -2)}|1`]: 1,
    });

    // A day again: the same rows; without the snapshot the subscriptions stay as they were.
    await client.query(`SELECT stats_rollup_money($1::date, false)`, [D]);
    expect(await rowsOf(client, ['churn', 'cancels', 'subs', 'subs_renewing', 'mrr'], D)).toEqual(money);
    expect((await client.query<{ n: number }>(`SELECT count(*)::integer AS n FROM stats_revenue_daily WHERE day = $1`, [D])).rows[0]!.n).toBe(3);
  });

  it('never shortens a closed cohort window when an older day is run again', async (ctx) => {
    if (!ready) ctx.skip();
    const [cohort, wrote] = [dayBack(4), dayBack(2)];
    const old = `${plusDays(D, -10)}T08:00:00Z`;
    const [x, y] = [await user(f, old), await user(f, old)];
    const matchId = await idAt(f, `${cohort}T09:00:00Z`);
    await client.query(`INSERT INTO matches (id, user_lo, user_hi, source) VALUES ($1, least($2::bigint, $3::bigint), greatest($2::bigint, $3::bigint), 1)`, [matchId, x, y]);
    for (const [sender, hm] of [[x, '09:00'], [y, '10:00']] as const) {
      await client.query(`INSERT INTO messages (match_id, id, sender_id, kind, body) VALUES ($1, $2, $3, 1, 'x')`, [matchId, await idAt(f, `${wrote}T${hm}:00Z`), sender]);
    }
    // A sign-up of day - 10 paying on day - 2 (within 30 days, not 7).
    const payer = await user(f, `${dayBack(10)}T08:00:00Z`);
    const product = (await client.query<{ id: number }>(`SELECT id FROM store_products WHERE store = 1 AND product_id = 'sub.plus' AND base_plan_id = 'm1'`)).rows[0]!;
    const purchaseId = await idAt(f, `${wrote}T10:00:00Z`);
    await client.query(
      `INSERT INTO store_purchases (id, user_id, purchased_at, expires_at, product_ref, store, kind, state, is_test, region, token_hash, token)
       VALUES ($1, $2, now(), now() + interval '30 days', $3, 1, 1, 2, false, 'TR', sha256($4::bytea), $4)`,
      [purchaseId, payer, product.id, `token-window-${purchaseId}`],
    );
    await client.query(
      `INSERT INTO store_events (id, purchase_id, user_id, occurred_at, amount_micros, store, event, source, state_to, amount_estimated, currency)
       VALUES ($1, $2, $3, $4, 5000000, 1, 1, 1, 2, false, 'USD')`,
      [await idAt(f, `${wrote}T10:00:01Z`), purchaseId, payer, `${wrote}T10:00:01Z`],
    );
    // The nightly runs up to yesterday.
    for (let back = 4; back >= 1; back -= 1) {
      await client.query(`SELECT stats_rollup_social($1::date)`, [dayBack(back)]);
      await client.query(`SELECT stats_rollup_money($1::date, false)`, [dayBack(back)]);
    }
    const figures = async () => ({
      ...(await rowsOf(client, ['conversations', 'replied'], cohort)),
      ...(await rowsOf(client, ['conv_d7', 'conv_d30'], dayBack(10))),
    });
    const nightly = await figures();
    expect(nightly).toEqual({
      [`conversations|${cohort}|`]: 1,
      [`replied|${cohort}|`]: 1,
      [`conv_d30|${dayBack(10)}|1`]: 1,
    });
    // An older day again (a recompute): what had happened by today stays counted.
    await client.query(`SELECT stats_rollup_social($1::date)`, [dayBack(3)]);
    await client.query(`SELECT stats_rollup_money($1::date, false)`, [dayBack(4)]);
    expect(await figures()).toEqual(nightly);
  });

  /** `count` matchable people of `city` (country `country`) and `gender`, active `activeBack` days before D. */
  const placed = async (city: number | null, gender: number, count: number, options: { country?: string; flags?: number; activeBack?: number } = {}) => {
    for (let i = 0; i < count; i += 1) {
      const id = await user(f, `${plusDays(D, -30)}T08:00:00Z`);
      await client.query(
        `INSERT INTO discovery (user_id, h3_r7, birth_date, active_on, profile_ver, city_id, gender, interested_in, age_min, age_max, intents,
                                flags, completeness, country, geo)
         VALUES ($1, $2, DATE '1995-03-01', $3::date, 1, $4, $5, 7, 18, 60, 15, $6, 80, $7, ${POINT})`,
        [id, CELL, plusDays(D, -(options.activeBack ?? 1)), city, gender, options.flags ?? 0, options.country ?? 'TR'],
      );
    }
  };

  /**
   * The places of D, and what an outsider can work out from them: every
   * published cell, each country cell minus its published city cells (the
   * city's country given), and Other minus ZZ per gender.
   */
  async function placesOf(countryOfCity: Record<string, string>) {
    const city = await rowsOf(client, ['active_city'], D);
    const country = await rowsOf(client, ['active_country'], D);
    const strip = (rows: Record<string, number>) => Object.fromEntries(Object.entries(rows).map(([k, v]) => [k.split('|')[2]!, v]));
    const cities = strip(city);
    const countries = strip(country);
    const derived: number[] = [];
    for (const [cell, value] of Object.entries(countries)) {
      const [code, gender] = cell.split(':');
      if (code === 'ZZ') continue;
      const listed = Object.entries(cities)
        .filter(([key]) => key.split(':')[1] === gender && countryOfCity[key.split(':')[0]!] === code)
        .reduce((sum, [, v]) => sum + v, 0);
      derived.push(value - listed);
    }
    for (const gender of ['1', '2', '3']) {
      const other = cities[`0:${gender}`];
      const zz = countries[`ZZ:${gender}`];
      if (other !== undefined && zz !== undefined) derived.push(other - zz);
    }
    return { cities, countries, published: [...Object.values(cities), ...Object.values(countries)], derived };
  }

  const small = (n: number) => n >= 1 && n <= 4;

  it('publishes places of at least 10 people and cells of at least 5, the rest under Other', async (ctx) => {
    if (!ready) ctx.skip();
    await client.query('DELETE FROM discovery');
    await placed(101, 1, 7);
    await placed(101, 2, 6);
    await placed(101, 3, 1);
    await placed(101, 1, 3, { flags: 8 });
    await placed(101, 2, 2, { activeBack: 10 });
    await placed(102, 1, 9);
    await placed(103, 1, 4);
    await placed(103, 2, 4);
    await placed(103, 3, 3);

    await client.query(`SELECT stats_rollup_places($1::date)`, [D]);
    const got = await placesOf({ 101: 'TR', 102: 'TR', 103: 'TR' });
    // TR men 10 minus city 101's 6 would tell city 103's 4 men, so 101's men are withheld as well.
    expect(got.cities).toEqual({ '101:1': 7, '0:1': 13, '0:2': 10 });
    expect(got.countries).toEqual({ 'TR:1': 20, 'TR:2': 10 });
    expect(got.published.filter(small)).toEqual([]);
    expect(got.derived.filter(small)).toEqual([]);
  });

  it('never lets Other or a country minus its cities give back a small group (one country)', async (ctx) => {
    if (!ready) ctx.skip();
    await client.query('DELETE FROM discovery');
    // One country: Tehran 100 women, 100 men, 1 non-binary; Shiraz 50 and 50; Yasuj 2 women and 10 men.
    await placed(1, 1, 100, { country: 'IR' });
    await placed(1, 2, 100, { country: 'IR' });
    await placed(1, 3, 1, { country: 'IR' });
    await placed(2, 1, 50, { country: 'IR' });
    await placed(2, 2, 50, { country: 'IR' });
    await placed(3, 1, 2, { country: 'IR' });
    await placed(3, 2, 10, { country: 'IR' });

    await client.query(`SELECT stats_rollup_places($1::date)`, [D]);
    const got = await placesOf({ 1: 'IR', 2: 'IR', 3: 'IR' });
    expect(got.published.filter(small)).toEqual([]);
    expect(got.derived.filter(small)).toEqual([]);
    // The single non-binary person is in no published figure.
    expect(Object.keys(got.cities).filter((k) => k.endsWith(':3'))).toEqual([]);
    expect(Object.keys(got.countries).filter((k) => k.endsWith(':3'))).toEqual([]);
    // IR women 152 minus Tehran and Shiraz (150) would be Yasuj's 2: the smallest city cell (Shiraz) is withheld too.
    expect(got.cities).toEqual({ '1:1': 100, '1:2': 100, '2:2': 50, '3:2': 10, '0:1': 52 });
    expect(got.countries).toEqual({ 'IR:1': 152, 'IR:2': 160 });
  });

  it('withholds a city cell that the country view would give back (Tehran and Karaj)', async (ctx) => {
    if (!ready) ctx.skip();
    await client.query('DELETE FROM discovery');
    await placed(1, 1, 30, { country: 'IR' });
    await placed(1, 2, 20, { country: 'IR' });
    await placed(2, 1, 3, { country: 'IR' });
    await placed(2, 2, 9, { country: 'IR' });
    // A second country with a few people of its own, and someone without a city.
    await placed(9, 1, 3, { country: 'TR' });
    await placed(null, 2, 1, { country: 'IR' });

    await client.query(`SELECT stats_rollup_places($1::date)`, [D]);
    const got = await placesOf({ 1: 'IR', 2: 'IR', 9: 'TR' });
    expect(got.published.filter(small)).toEqual([]);
    expect(got.derived.filter(small)).toEqual([]);
    // IR women 33 minus Tehran's 30 would be Karaj's 3; IR men 30 minus 29 the one without a city.
    expect(got.cities['1:1']).toBeUndefined();
    expect(got.cities['2:1']).toBeUndefined();
    expect(got.countries['IR:1']).toBe(33);
    // ZZ women are TR's 3: withheld, and so is Other's women (Other minus ZZ is told by the published figures).
    expect(got.countries['ZZ:1']).toBeUndefined();
    expect(got.cities['0:1']).toBeUndefined();
  });

  it('keeps the test-account filter a hashed SubPlan (statistics on flags & 1)', async (ctx) => {
    if (!ready) ctx.skip();
    const { rowCount } = await client.query(`SELECT 1 FROM pg_statistic_ext WHERE stxname = 'users_test_flag_stats' AND stxrelid = 'users'::regclass`);
    expect(rowCount).toBe(1);
    const plan = async () => {
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT count(*) FROM matches m WHERE m.id >= 0 AND m.user_lo NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)
                                                               AND m.user_hi NOT IN (SELECT t.id FROM users t WHERE (t.flags & 1) <> 0)`,
      );
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    };
    await client.query('BEGIN');
    try {
      // Enough ordinary accounts that an estimate of "almost all of them" no longer fits a small hash_mem.
      await client.query(`INSERT INTO users (id, status, onboarding_step, flags)
                          SELECT id_floor(TIMESTAMPTZ '2021-01-01 00:00:00+00') + g, 1, 0, 0 FROM generate_series(1, 5000) g`);
      await client.query(`INSERT INTO users (id, status, onboarding_step, flags)
                          SELECT id_floor(TIMESTAMPTZ '2021-01-02 00:00:00+00') + g, 1, 0, 1 FROM generate_series(1, 3) g`);
      await client.query(`SET LOCAL work_mem = '64kB'`);
      await client.query(`SET LOCAL hash_mem_multiplier = 1`);
      await client.query('ANALYZE users');
      const kept = await plan();
      // Both sides of a pair (0037), each its own hashed SubPlan.
      expect(kept.match(/hashed SubPlan/g)).toHaveLength(2);
      // Without the statistics the same filter runs once per outer row: the reason they exist.
      await client.query('DROP STATISTICS users_test_flag_stats');
      await client.query('ANALYZE users');
      const without = await plan();
      expect(without).toMatch(/SubPlan/);
      expect(without).not.toMatch(/hashed SubPlan/);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('counts queue decisions per admin with their median wait and the overturns of their actions', async (ctx) => {
    if (!ready) ctx.skip();
    const admin = async (name: string) =>
      (await client.query<{ id: number }>(`INSERT INTO admin_users (email, display_name) VALUES ($1, $2) RETURNING id`, [`${name}@example.com`, name])).rows[0]!.id;
    const m1 = await admin('mod-one');
    const m2 = await admin('mod-two');
    const old = `${plusDays(D, -10)}T08:00:00Z`;
    const [a, b, c] = [await user(f, old), await user(f, old), await user(f, old)];
    const t = await user(f, old, { flags: 1 });
    const audit = async (adminId: number | null, action: string, targetType: number, targetId: string | null, time: string, detail?: object) =>
      client.query(`INSERT INTO audit_log (id, admin_id, action, target_type, target_id, detail) VALUES ($1, $2, $3, $4, $5, $6)`, [
        await idAt(f, time),
        adminId,
        action,
        targetType,
        targetId,
        detail === undefined ? null : JSON.stringify(detail),
      ]);
    const photo = await idAt(f, `${D}T08:00:00Z`);
    await client.query(`INSERT INTO photos (id, user_id, position, status) VALUES ($1, $2, 0, 3)`, [photo, a]);
    await audit(m1, 'photo.approve', 1, a, `${D}T09:00:00Z`, { photoId: photo });
    const report = await idAt(f, `${D}T06:00:00Z`);
    await client.query(`INSERT INTO reports (id, reporter_id, target_id, context, reason, status, resolved_at) VALUES ($1, $2, $3, 1, 2, 3, now())`, [report, b, a]);
    await audit(m1, 'report.resolve', 3, report, `${D}T08:00:00Z`);
    const testReport = await idAt(f, `${D}T06:30:00Z`);
    await client.query(`INSERT INTO reports (id, reporter_id, target_id, context, reason, status, resolved_at) VALUES ($1, $2, $3, 1, 2, 4, now())`, [testReport, a, t]);
    await audit(m1, 'report.dismiss', 3, testReport, `${D}T08:30:00Z`);
    await audit(m2, 'text.approve', 1, b, `${D}T10:00:00Z`);
    const action = await idAt(f, `${plusDays(D, -2)}T10:00:00Z`);
    await client.query(`INSERT INTO moderation_actions (id, user_id, admin_id, kind, reason_code, reason_text) VALUES ($1, $2, $3, 1, 1, 'r')`, [action, c, m2]);
    const appeal = await idAt(f, `${D}T07:00:00Z`);
    await client.query(`INSERT INTO appeals (id, user_id, action_id, status, body, decided_at, decided_by) VALUES ($1, $2, $3, 3, 'b', now(), $4)`, [appeal, c, action, m1]);
    await audit(m1, 'appeal.overturn', 4, appeal, `${D}T11:00:00Z`);
    await audit(null, 'photo.reject', 1, a, `${D}T11:30:00Z`, { photoId: photo });
    await audit(m1, 'report.view_chat', 3, report, `${D}T11:40:00Z`);

    await client.query(`SELECT stats_rollup_moderation($1::date)`, [D]);
    const { rows } = await client.query(
      `SELECT admin_id, decisions, photos, texts, reports, appeals, timed, response_p50_s, overturned FROM stats_moderation_daily WHERE day = $1 ORDER BY admin_id`,
      [D],
    );
    expect(rows).toEqual([
      { admin_id: m1, decisions: 3, photos: 1, texts: 0, reports: 1, appeals: 1, timed: 3, response_p50_s: 7200, overturned: 0 },
      { admin_id: m2, decisions: 1, photos: 0, texts: 1, reports: 0, appeals: 0, timed: 0, response_p50_s: null, overturned: 1 },
    ]);
    await client.query(`SELECT stats_rollup_moderation($1::date)`, [D]);
    expect((await client.query<{ n: number }>(`SELECT count(*)::integer AS n FROM stats_moderation_daily WHERE day = $1`, [D])).rows[0]!.n).toBe(2);
  });

  it('counts today and the review queues up to the cap', async (ctx) => {
    if (!ready) ctx.skip();
    const now = new Date().toISOString();
    const a = await user(f, now);
    const b = await user(f, now);
    const t = await user(f, now, { flags: 1 });
    for (const position of [1, 2]) await client.query(`INSERT INTO photos (id, user_id, position, status) VALUES (id_next(), $1, $2, 2)`, [a, position]);
    await client.query(`INSERT INTO reports (id, reporter_id, target_id, context, reason) VALUES ($1, $2, $3, 1, 8)`, [await idAt(f, now), a, b]);
    await client.query(`INSERT INTO reports (id, reporter_id, target_id, context, reason) VALUES ($1, $2, $3, 1, 8)`, [await idAt(f, now), t, b]);
    await client.query(`INSERT INTO support_tickets (id, user_id, status) VALUES (id_next(), $1, 1), (id_next(), $1, 2)`, [a]);
    const live = await json<Record<string, unknown>>(client, `SELECT stats_live(1) AS v`);
    expect(live).toMatchObject({ day: dayBack(0), signups: 2, photos: 2, reportsOpen: 2, reportsUrgent: 2, reports: 1, tickets: 1, revenue: [] });
    const roomy = await json<Record<string, unknown>>(client, `SELECT stats_live(10000) AS v`);
    expect(roomy).toMatchObject({ photos: 2, tickets: 1 });
  });

  it('leaves out a match or a call when either side is a test account, live and in the rollup (0037)', async (ctx) => {
    if (!ready) ctx.skip();
    const old = `${plusDays(D, -10)}T08:00:00Z`;
    // Ids grow with the counter: the ordinary person is each pair's user_lo and the caller, the test account user_hi
    // and the callee (a pair only a flip of the flag can make).
    const [a, b, c, d] = [await user(f, old), await user(f, old), await user(f, old), await user(f, old)];
    const [t, u] = [await user(f, old, { flags: 1 }), await user(f, old, { flags: 1 })];
    const day = dayBack(3);
    const match = async (x: string, y: string, time: string) => {
      const id = await idAt(f, time);
      await client.query(`INSERT INTO matches (id, user_lo, user_hi, source) VALUES ($1, $2, $3, 1)`, [id, x, y]);
      return id;
    };
    const missedCall = async (matchId: string, caller: string, callee: string, time: string) => {
      await client.query(
        `INSERT INTO calls (id, match_id, caller_id, callee_id, ended_at, duration_s, kind, outcome, ended_by, end_reason)
         VALUES ($1, $2, $3, $4, $5::timestamptz + interval '30 seconds', 0, 1, 4, 3, 4)`,
        [await idAt(f, time), matchId, caller, callee, time],
      );
    };
    const live = () => json<Record<string, number>>(client, `SELECT stats_live(10000) AS v`);
    const social = async () => {
      await client.query(`SELECT stats_rollup_social($1::date)`, [day]);
      const sums: Record<string, number> = { matches: 0, conversations: 0, calls: 0 };
      for (const [key, value] of Object.entries(await rowsOf(client, Object.keys(sums), day))) sums[key.split('|')[0]!]! += value;
      return sums;
    };
    const liveBefore = await live();
    const socialBefore = await social();

    const now = new Date().toISOString();
    for (const other of [t, b]) await missedCall(await match(a, other, now), a, other, now);
    for (const other of [u, d]) {
      const id = await match(c, other, `${day}T09:00:00Z`);
      await client.query(`INSERT INTO messages (match_id, id, sender_id, kind, body) VALUES ($1, $2, $3, 1, 'x')`, [id, await idAt(f, `${day}T09:05:00Z`), c]);
      await missedCall(id, c, other, `${day}T10:00:00Z`);
    }

    // Only the pair of two ordinary people counts.
    const liveAfter = await live();
    expect([liveAfter.matches! - liveBefore.matches!, liveAfter.calls! - liveBefore.calls!]).toEqual([1, 1]);
    const socialAfter = await social();
    expect({
      matches: socialAfter.matches! - socialBefore.matches!,
      conversations: socialAfter.conversations! - socialBefore.conversations!,
      calls: socialAfter.calls! - socialBefore.calls!,
    }).toEqual({ matches: 1, conversations: 1, calls: 1 });
  });

  it('upserts rows, writing only changed values; converts store periods to months', async (ctx) => {
    if (!ready) ctx.skip();
    const put = (rows: object[]) => json<number>(client, `SELECT stats_put($1::jsonb) AS v`, [JSON.stringify(rows)]);
    expect(await put([{ metric: 'dau', day: D, value: 3 }, { metric: 'likes', day: D, value: 9 }])).toBe(2);
    expect(await put([{ metric: 'dau', day: D, value: 3 }, { metric: 'likes', day: D, value: 10 }])).toBe(1);
    expect(await rowsOf(client, ['dau', 'likes'], D)).toEqual({ [`dau|${D}|`]: 3, [`likes|${D}|`]: 10 });
    const months = await client.query<{ w: string; m: string; y: string; d: string; x: string | null }>(
      `SELECT round(stats_period_months('P1W'), 4)::text AS w, stats_period_months('P3M')::text AS m, stats_period_months('P1Y')::text AS y,
              round(stats_period_months('P30D'), 4)::text AS d, stats_period_months('1M')::text AS x`,
    );
    expect(months.rows[0]).toEqual({ w: '0.2300', m: '3', y: '12', d: '0.9856', x: null });
  });

  it('keeps the money and moderation figures to their roles', async (ctx) => {
    if (!ready || !roles) ctx.skip();
    const select = (role: string, table: string) => json<boolean>(client, `SELECT has_table_privilege($1, $2, 'SELECT') AS v`, [role, table]);
    expect(await select('app_ro', 'stats_daily')).toBe(true);
    expect(await select('app_ro', 'stats_revenue_daily')).toBe(true);
    expect(await select('app_ro', 'stats_moderation_daily')).toBe(false);
    expect(await json<boolean>(client, `SELECT has_table_privilege('app_ro', 'stats_daily', 'INSERT') AS v`)).toBe(false);
    const execute = (role: string, fn: string) => json<boolean>(client, `SELECT has_function_privilege($1, $2, 'EXECUTE') AS v`, [role, fn]);
    for (const fn of ['stats_put(jsonb)', 'stats_live(integer)', 'stats_rollup_people(date)', 'stats_rollup_social(date)', 'stats_rollup_money(date,boolean)', 'stats_rollup_places(date)', 'stats_rollup_moderation(date)']) {
      expect(await execute('app_maint', fn), fn).toBe(true);
      expect(await execute('app_rw', fn), fn).toBe(false);
      expect(await execute('app_ro', fn), fn).toBe(false);
    }
    const holders = (
      await client.query<{ key: string }>(
        `SELECT r.key FROM admin_role_permissions p JOIN admin_roles r ON r.id = p.role_id WHERE p.permission = 'dashboard.revenue' ORDER BY r.key`,
      )
    ).rows.map((r) => r.key);
    expect(holders).toEqual(['admin', 'analyst', 'finance']);
  });

  it('gives a resynced profile without a known last active day its sign-up day, never today', async (ctx) => {
    if (!ready) ctx.skip();
    const id = await idAt(f, new Date(Date.now() - 60 * DAY_MS).toISOString());
    await client.query(`INSERT INTO users (id, birth_date, status, gender, onboarding_step, country) VALUES ($1, DATE '1995-03-01', 3, 1, 30, 'TR')`, [id]);
    await client.query(`INSERT INTO profiles (user_id, display_name, completeness) VALUES ($1, 'p', 80)`, [id]);
    await client.query(`INSERT INTO preferences (user_id, interested_in) VALUES ($1, 2)`, [id]);
    await client.query(`INSERT INTO user_locations (user_id, home_h3, source, country, home_geo) VALUES ($1, $2, 1, 'TR', ${POINT})`, [id, CELL]);
    for (const position of [0, 1]) await client.query(`INSERT INTO photos (id, user_id, position, status) VALUES (id_next(), $1, $2, 3)`, [id, position]);
    await client.query(`UPDATE profiles SET display_name = 'q' WHERE user_id = $1`, [id]);
    const day = await json<string>(client, `SELECT active_on::text AS v FROM discovery WHERE user_id = $1`, [id]);
    expect(day).toBe(dayBack(60));
    // A known day wins once the row is written again (a profile edit; the daily drain moves it on its own).
    await client.query(`UPDATE users SET last_active_on = current_date - 3 WHERE id = $1`, [id]);
    await client.query(`UPDATE profiles SET display_name = 'r' WHERE user_id = $1`, [id]);
    expect(await json<string>(client, `SELECT active_on::text AS v FROM discovery WHERE user_id = $1`, [id])).toBe(dayBack(3));
  });
});

describe.skipIf(!hasDatabase)('migration 0035: the last active day backfill', () => {
  let db: TempDatabase;
  let client: pg.Client;
  let ready = false;
  const dir = mkdtempSync(join(tmpdir(), 'mig-0035-'));

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
    for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n < '0035')) copyFileSync(join(MIGRATIONS, name), join(dir, name));
    await runMigrations({ connectionString: db.url, directory: dir, log: quiet });
  }, 90_000);

  afterAll(async () => {
    await client?.end();
    await db?.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('sets last_active_on from discovery, else the sign-up day, for statuses 1-6 only', async (ctx) => {
    if (!ready) ctx.skip();
    const f: Fixture = { client, seq: 0 };
    const listed = await idAt(f, new Date(Date.now() - 40 * DAY_MS).toISOString());
    await client.query(`INSERT INTO users (id, birth_date, status, gender, onboarding_step, country) VALUES ($1, DATE '1995-03-01', 3, 1, 30, 'TR')`, [listed]);
    await client.query(
      `INSERT INTO discovery (user_id, h3_r7, birth_date, active_on, profile_ver, gender, interested_in, age_min, age_max, intents, flags, completeness, country, geo)
       VALUES ($1, $2, DATE '1995-03-01', current_date - 12, 1, 1, 2, 18, 60, 15, 0, 80, 'TR', ${POINT})`,
      [listed, CELL],
    );
    const unlisted = await idAt(f, new Date(Date.now() - 20 * DAY_MS).toISOString());
    await client.query(`INSERT INTO users (id, status, onboarding_step) VALUES ($1, 1, 4)`, [unlisted]);
    const known = await idAt(f, new Date(Date.now() - 20 * DAY_MS).toISOString());
    await client.query(`INSERT INTO users (id, birth_date, status, gender, onboarding_step, country, last_active_on) VALUES ($1, DATE '1995-03-01', 3, 1, 30, 'TR', current_date - 2)`, [known]);
    const deleted = await idAt(f, new Date(Date.now() - 20 * DAY_MS).toISOString());
    await client.query(`INSERT INTO users (id, status, onboarding_step, deleted_at) VALUES ($1, 7, 4, now())`, [deleted]);

    copyFileSync(join(MIGRATIONS, '0035_stats.sql'), join(dir, '0035_stats.sql'));
    const applied = await runMigrations({ connectionString: db.url, directory: dir, log: quiet });
    expect(applied.applied.map((m) => m.name)).toEqual(['0035_stats.sql']);
    const { rows } = await client.query<{ id: string; day: string | null }>(`SELECT id::text, last_active_on::text AS day FROM users WHERE id = ANY ($1::bigint[])`, [
      [listed, unlisted, known, deleted],
    ]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.day]));
    expect(byId).toEqual({ [listed]: dayBack(12), [unlisted]: dayBack(20), [known]: dayBack(2), [deleted]: null });
  });
});
