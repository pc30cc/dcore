import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPool,
  deleteAccount,
  deletionAccountOf,
  deletionFanoutTarget,
  deletionSweep,
  instrumentPool,
  purgeAccount,
  purgePhotos,
  renewingSubscription,
  restoreAccount,
  runMigrations,
  statementCounter,
  type Pool,
} from '../src/index.js';
import { createTempDatabase, hasDatabase, type TempDatabase } from './support.js';

/**
 * Migration 0012 and the deletion queries on the real migrations: a
 * deletion (status 7, sessions, conversations, discovery), a restore, and
 * the purge at the end of the grace (the tombstone), with legal holds.
 */

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const CELL = '608692970769612799';
const POINT = 'ST_SetSRID(ST_MakePoint(-122.42, 37.77), 4326)::geography';
const DAY_MS = 86_400_000;

describe.skipIf(!hasDatabase)('account deletion (migration 0012)', () => {
  let db: TempDatabase;
  let client: pg.Client;
  let pool: Pool;
  let fieldId: number;
  let promptId: number;

  beforeAll(async () => {
    db = await createTempDatabase();
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await runMigrations({ connectionString: db.url, directory: MIGRATIONS, log: { info: () => undefined, warn: () => undefined } });
    pool = instrumentPool(createPool({ connectionString: db.url, applicationName: 'db-test', max: 3 }));
    fieldId = (await client.query<{ id: number }>(`INSERT INTO profile_field_defs (type, key, options) VALUES (1, 'pets', '[{"id": 1, "i18n": {}}]') RETURNING id`)).rows[0]!.id;
    promptId = (await client.query<{ id: number }>(`INSERT INTO prompt_defs (i18n) VALUES ('{}') RETURNING id`)).rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await client?.end();
    await db?.drop();
  });

  async function one<T>(text: string, values: unknown[] = []): Promise<T> {
    const { rows } = await client.query(text, values);
    if (rows[0] === undefined) throw new Error(`no row: ${text}`);
    return rows[0] as T;
  }

  async function value<T>(text: string, values: unknown[] = []): Promise<T> {
    return Object.values(await one<Record<string, T>>(text, values))[0] as T;
  }

  async function newUser(status = 3, extra: { birthDate?: string | null } = {}): Promise<string> {
    const birth = extra.birthDate === undefined ? (status === 1 ? null : '1995-03-01') : extra.birthDate;
    return value<string>(
      `INSERT INTO users (id, birth_date, status, gender, onboarding_step, country)
       VALUES (id_next(), $2::date, $1::smallint, CASE WHEN $2::date IS NULL THEN NULL ELSE 2 END, 30, 'IR') RETURNING id::text`,
      [status, birth],
    );
  }

  async function match(a: string, b: string): Promise<string> {
    const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
    return value<string>(`INSERT INTO matches (id, user_lo, user_hi, source, flags) VALUES (id_next(), $1, $2, 1, 3) RETURNING id::text`, [lo, hi]);
  }

  async function message(matchId: string, sender: string, body: string): Promise<void> {
    await client.query(`INSERT INTO messages (match_id, id, sender_id, kind, body) VALUES ($1, id_next(), $2, 1, $3)`, [matchId, sender, body]);
  }

  /** A complete, discoverable account with everything a person leaves behind. */
  async function fullAccount(): Promise<{ id: string; photos: string[]; hash: Buffer; sessionId: string; deviceId: string }> {
    const id = await newUser(3);
    await client.query(`INSERT INTO profiles (user_id, display_name, about, completeness) VALUES ($1, 'Sam', 'About me', 80)`, [id]);
    await client.query(`INSERT INTO preferences (user_id, interested_in) VALUES ($1, 2)`, [id]);
    await client.query(`INSERT INTO user_locations (user_id, home_h3, home_city_id, source, country, home_geo) VALUES ($1, $2, 1, 1, 'IR', ${POINT})`, [id, CELL]);
    const photos = (
      await client.query<{ id: string }>(
        `INSERT INTO photos (id, user_id, position, status, width, height, blob_ver)
         VALUES (id_next(), $1, 0, 3, 1080, 1350, 1), (id_next(), $1, 1, 3, 1080, 1350, 2) RETURNING id::text`,
        [id],
      )
    ).rows.map((r) => r.id);
    await client.query(`INSERT INTO profile_prompts (user_id, position, prompt_id, answer, status) VALUES ($1, 0, $2, 'yes', 2)`, [id, promptId]);
    await client.query(`INSERT INTO profile_field_values (user_id, field_id, opt) VALUES ($1, $2, 1)`, [id, fieldId]);
    await client.query(`INSERT INTO verifications (id, user_id, photo_id, status, decided_at) VALUES (id_next(), $1, $2, 3, now())`, [id, photos[0]]);
    await client.query(`UPDATE users SET is_verified = true, last_active_on = current_date WHERE id = $1`, [id]);
    const deviceId = await value<string>(
      `INSERT INTO devices (id, user_id, app_version, platform, store, push_token, push_token_hash, fingerprint_hash)
       VALUES (id_next(), $1, 100, 1, 2, $3, sha256(convert_to($3, 'UTF8')), $2) RETURNING id::text`,
      [id, randomBytes(32), `push-${randomBytes(8).toString('hex')}`],
    );
    const sessionId = await value<string>(
      `INSERT INTO sessions (id, user_id, device_id, expires_at, store, refresh_hash) VALUES (id_next(), $1, $2, now() + interval '30 days', 2, $3) RETURNING id::text`,
      [id, deviceId, randomBytes(32)],
    );
    const hash = randomBytes(32);
    await client.query(`INSERT INTO auth_identities (id, user_id, provider, subject_hash, subject_enc) VALUES (id_next(), $1, 1, $2, $3)`, [id, hash, randomBytes(40)]);
    await client.query(`INSERT INTO user_consents (user_id, kind, version, store) VALUES ($1, 1, 1, 2), ($1, 2, 1, 2)`, [id]);
    await client.query(`INSERT INTO moderation_actions (id, user_id, kind, reason_code, reason_text) VALUES (id_next(), $1, 1, 1, 'A warning')`, [id]);
    await client.query(`INSERT INTO support_tickets (id, user_id, subject) VALUES (id_next(), $1, 'help')`, [id]);
    await client.query(`INSERT INTO wallet_ledger (id, user_id, delta, balance_after, item, reason) VALUES (id_next(), $1, 5, 5, 1, 4)`, [id]);
    return { id, photos, hash, sessionId, deviceId };
  }

  async function discovered(id: string): Promise<boolean> {
    return value<boolean>(`SELECT EXISTS (SELECT 1 FROM discovery WHERE user_id = $1)`, [id]);
  }

  it('deletes in one statement: status 7, sessions revoked, conversations ended, discovery row gone', async () => {
    const a = await fullAccount();
    const b = await newUser();
    const c = await newUser();
    const d = await newUser();
    const ab = await match(a.id, b);
    const ca = await match(c, a.id);
    const old = await match(a.id, d);
    await client.query(`UPDATE matches SET state = 2, ended_at = now(), ended_by = 1 WHERE id = $1`, [old]);
    await client.query(`INSERT INTO message_requests (id, from_id, to_id, body) VALUES (id_next(), $1, $2, 'hi'), (id_next(), $2, $1, 'hello')`, [a.id, d]);
    expect(await discovered(a.id)).toBe(true);

    const { result, tally } = await statementCounter.measure(() => deleteAccount(pool, { userId: a.id }, 1));
    expect(tally.statements).toBe(1);
    expect(result.kind).toBe('deleted');
    if (result.kind !== 'deleted') return;
    expect(result.userId).toBe(a.id);
    expect(result.purgeAtMs - result.deletedAtMs).toBe(30 * DAY_MS);
    expect(result.sessionIds).toEqual([a.sessionId]);
    expect(result.ended.map((e) => [e.matchId, e.peerId]).sort()).toEqual([[ab, b], [ca, c]].sort());

    const user = await one<{ status: number; deleted_via: number; restore_status: number; deleted_at: Date }>(
      `SELECT status, deleted_via, restore_status, deleted_at FROM users WHERE id = $1`,
      [a.id],
    );
    expect(user).toMatchObject({ status: 7, deleted_via: 1, restore_status: 3 });
    expect(user.deleted_at.getTime()).toBe(result.deletedAtMs);
    expect(await discovered(a.id)).toBe(false);
    expect(await one(`SELECT revoked_at IS NOT NULL AS revoked, revoke_reason FROM sessions WHERE id = $1`, [a.sessionId])).toEqual({ revoked: true, revoke_reason: 6 });
    const states = (await client.query<{ id: string; state: number; ended_by: number }>(`SELECT id::text, state, ended_by FROM matches WHERE id = ANY($1::bigint[]) ORDER BY id`, [[ab, ca, old]])).rows;
    expect(Object.fromEntries(states.map((s) => [s.id, [s.state, s.ended_by]]))).toEqual({ [ab]: [4, 3], [ca]: [4, 3], [old]: [2, 1] });
    // The person's own pending request is withdrawn; the one they received waits to expire.
    const requests = (await client.query<{ from_id: string; status: number }>(`SELECT from_id::text, status FROM message_requests WHERE from_id = $1 OR to_id = $1 ORDER BY from_id = $1 DESC`, [a.id])).rows;
    expect(requests.map((r) => r.status)).toEqual([5, 1]);

    // Again: nothing changes, the same purge time (one more read to tell it apart).
    const again = await statementCounter.measure(() => deleteAccount(pool, { userId: a.id }, 2));
    expect(again.tally.statements).toBe(2);
    expect(again.result).toEqual({ kind: 'already', userId: a.id, deletedAtMs: result.deletedAtMs, purgeAtMs: result.purgeAtMs });
    expect(await value<number>(`SELECT deleted_via FROM users WHERE id = $1`, [a.id])).toBe(1);

    // The fan-out's read: the two conversations this deletion ended, not the earlier unmatch.
    const fanout = await statementCounter.measure(() => deletionFanoutTarget(pool, a.id, result.deletedAtMs));
    expect(fanout.tally.statements).toBe(1);
    expect(fanout.result?.status).toBe(7);
    expect(fanout.result?.ended.map((e) => e.matchId).sort()).toEqual([ab, ca].sort());
    expect(fanout.result?.profileVersion).toBeGreaterThan(0);
  });

  it('finds the account of a sign-in identity, and deletes through it', async () => {
    const a = await fullAccount();
    const other = randomBytes(32);
    const { result, tally } = await statementCounter.measure(() => deletionAccountOf(pool, 1, [other, a.hash]));
    expect(tally.statements).toBe(1);
    expect(result).toEqual({ userId: a.id, status: 3 });
    expect(await deletionAccountOf(pool, 1, [other])).toBeNull();
    expect(await deletionAccountOf(pool, 2, [a.hash])).toBeNull();

    expect(await deleteAccount(pool, { provider: 1, subjectHashes: [randomBytes(32)] }, 2)).toEqual({ kind: 'none' });
    const deleted = await deleteAccount(pool, { provider: 1, subjectHashes: [a.hash] }, 2);
    expect(deleted.kind).toBe('deleted');
    expect(await value<number>(`SELECT deleted_via FROM users WHERE id = $1`, [a.id])).toBe(2);
    expect(await deletionAccountOf(pool, 1, [a.hash])).toEqual({ userId: a.id, status: 7 });
  });

  it('restores within the grace to the status the account had, never past a review or a ban', async () => {
    const a = await fullAccount();
    await deleteAccount(pool, { userId: a.id }, 1);
    const restored = await statementCounter.measure(() => restoreAccount(pool, a.id));
    expect(restored.tally.statements).toBe(1);
    expect(restored.result).toEqual({ kind: 'restored', status: 3, onboardingStep: 30 });
    expect(await one(`SELECT status, deleted_at, deleted_via, restore_status FROM users WHERE id = $1`, [a.id])).toEqual({
      status: 3,
      deleted_at: null,
      deleted_via: null,
      restore_status: null,
    });
    expect(await discovered(a.id)).toBe(true);
    // A retried restore answers the account as it is.
    expect(await restoreAccount(pool, a.id)).toEqual({ kind: 'not_deleted', status: 3, onboardingStep: 30 });

    const pending = await newUser(2);
    await deleteAccount(pool, { userId: pending }, 1);
    expect(await restoreAccount(pool, pending)).toMatchObject({ kind: 'restored', status: 2 });

    const snoozed = await newUser(4);
    await deleteAccount(pool, { userId: snoozed }, 1);
    expect(await restoreAccount(pool, snoozed)).toMatchObject({ kind: 'restored', status: 4 });

    const onboarding = await newUser(1);
    await deleteAccount(pool, { userId: onboarding }, 1);
    expect(await restoreAccount(pool, onboarding)).toMatchObject({ kind: 'restored', status: 1 });

    // Banned, deleted, restored: banned again.
    const banned = await newUser(6);
    await client.query(`INSERT INTO moderation_actions (id, user_id, kind, reason_code, reason_text) VALUES (id_next(), $1, 3, 1, 'Ban')`, [banned]);
    await deleteAccount(pool, { userId: banned }, 1);
    expect(await value<number>(`SELECT restore_status FROM users WHERE id = $1`, [banned])).toBe(6);
    expect(await restoreAccount(pool, banned)).toMatchObject({ kind: 'restored', status: 6 });

    // A suspension that ended during the grace gives an active account; one still running stays.
    const lapsed = await newUser(5);
    await client.query(
      `INSERT INTO moderation_actions (id, user_id, kind, reason_code, reason_text, starts_at, ends_at) VALUES (id_next(), $1, 2, 1, 'Pause', now() - interval '3 days', now() - interval '1 day')`,
      [lapsed],
    );
    await deleteAccount(pool, { userId: lapsed }, 1);
    expect(await restoreAccount(pool, lapsed)).toMatchObject({ kind: 'restored', status: 3 });
    const running = await newUser(3);
    await deleteAccount(pool, { userId: running }, 1);
    await client.query(
      `INSERT INTO moderation_actions (id, user_id, kind, reason_code, reason_text, ends_at) VALUES (id_next(), $1, 2, 1, 'Pause', now() + interval '2 days')`,
      [running],
    );
    expect(await restoreAccount(pool, running)).toMatchObject({ kind: 'restored', status: 5 });

    // After the purge time: refused; purged or unknown: gone.
    const late = await newUser(3);
    await deleteAccount(pool, { userId: late }, 1);
    await client.query(`UPDATE users SET deleted_at = now() - interval '31 days' WHERE id = $1`, [late]);
    const expired = await restoreAccount(pool, late);
    expect(expired.kind).toBe('expired');
    expect(await value<number>(`SELECT status FROM users WHERE id = $1`, [late])).toBe(7);
    expect(await restoreAccount(pool, '999999999999')).toEqual({ kind: 'gone' });
  });

  it('purges at the end of the grace into the tombstone, keeping the records and what a hold names', async () => {
    const a = await fullAccount();
    const b = await newUser();
    const c = await newUser();
    const e = await newUser();
    const ab = await match(a.id, b);
    const ac = await match(a.id, c);
    await message(ab, a.id, 'hello b');
    await message(ab, b, 'hi a');
    await message(ac, c, 'evidence');
    await client.query(`INSERT INTO calls (id, match_id, caller_id, callee_id, ended_at, kind, outcome, ended_by, end_reason) VALUES (id_next(), $1, $2, $3, now(), 1, 4, 3, 4)`, [ab, a.id, b]);
    const report = await value<string>(`INSERT INTO reports (id, target_id, reporter_id, match_id, context, reason) VALUES (id_next(), $1, $2, $3, 2, 2) RETURNING id::text`, [c, a.id, ac]);
    const hold = await value<string>(`INSERT INTO legal_holds (id, match_id, report_id, kind) VALUES (id_next(), $1, $2, 2) RETURNING id::text`, [ac, report]);
    await client.query(`INSERT INTO likes (target_id, actor_id, id, kind) VALUES ($1, $2, id_next(), 1), ($2, $1, id_next(), 1)`, [a.id, e]);
    await client.query(`INSERT INTO message_requests (id, from_id, to_id, body) VALUES (id_next(), $1, $2, 'hey'), (id_next(), $2, $1, 'yo')`, [a.id, e]);
    const [lo, hi] = BigInt(a.id) < BigInt(e) ? [a.id, e] : [e, a.id];
    await client.query(`INSERT INTO blocks (user_lo, user_hi, blocked_by) VALUES ($1, $2, 1)`, [lo, hi]);
    const { id: product, product_id: productId } = await one<{ id: number; product_id: string }>(
      `SELECT id, product_id FROM store_products WHERE store = 1 AND kind = 1 ORDER BY id LIMIT 1`,
    );
    const purchase = await value<string>(
      `INSERT INTO store_purchases (id, user_id, purchased_at, expires_at, product_ref, store, kind, state, token_hash, token)
       VALUES (id_next(), $1, now(), now() + interval '30 days', $2, 1, 1, 2, sha256(convert_to($3, 'UTF8')), $3) RETURNING id::text`,
      [a.id, product, `token-${randomBytes(8).toString('hex')}`],
    );
    await client.query(`INSERT INTO store_events (id, purchase_id, user_id, occurred_at, store, event, source, state_to) VALUES (id_next(), $1, $2, now(), 1, 1, 1, 2)`, [purchase, a.id]);
    await client.query(`INSERT INTO subscriptions (user_id, started_at, expires_at, purchase_id, plan_id, store, status) VALUES ($1, now(), now() + interval '30 days', $2, 2, 1, 1)`, [a.id, purchase]);
    // A renewing store subscription: what the preflight warns about.
    expect(await renewingSubscription(pool, a.id, 2)).toEqual({ store: 1, productId });

    const deleted = await deleteAccount(pool, { userId: a.id }, 1);
    if (deleted.kind !== 'deleted') throw new Error('not deleted');

    // Before the grace is over: nothing happens.
    const early = await purgeAccount(pool, a.id, deleted.deletedAtMs + 29 * DAY_MS);
    expect(early).toEqual({ outcome: 'not_due', purgeAtMs: deleted.purgeAtMs });
    expect(await value<number>(`SELECT status FROM users WHERE id = $1`, [a.id])).toBe(7);

    // The sweep sees it as due once the clock passes the purge time, and as recent right after the deletion.
    const sweepLater = await statementCounter.measure(() =>
      deletionSweep(pool, { nowMs: deleted.purgeAtMs + 1_000, recentSinceMs: deleted.purgeAtMs, limit: 1_000 }),
    );
    expect(sweepLater.tally.statements).toBe(1);
    expect(sweepLater.result.find((r) => r.userId === a.id)).toEqual({ userId: a.id, deletedAtMs: deleted.deletedAtMs, purgeAtMs: deleted.purgeAtMs, due: true });
    const sweepNow = await deletionSweep(pool, { nowMs: deleted.deletedAtMs + 60_000, recentSinceMs: deleted.deletedAtMs - 60_000, limit: 1_000 });
    expect(sweepNow.find((r) => r.userId === a.id)?.due).toBe(false);
    const sweepNeither = await deletionSweep(pool, { nowMs: deleted.deletedAtMs + DAY_MS, recentSinceMs: deleted.deletedAtMs + 60_000, limit: 1_000 });
    expect(sweepNeither.find((r) => r.userId === a.id)).toBeUndefined();

    // The fake clock 31 days on: the tombstone.
    const later = deleted.deletedAtMs + 31 * DAY_MS;
    const { result, tally } = await statementCounter.measure(() => purgeAccount(pool, a.id, later));
    expect(tally.statements).toBe(1);
    expect(result.outcome).toBe('purged');
    if (result.outcome !== 'purged') return;
    expect(result.matchIds).toEqual([ab]);
    expect(result.heldMatchIds).toEqual([ac]);
    expect(result.deviceIds).toEqual([a.deviceId]);
    expect(result.sessionIds).toEqual([a.sessionId]);
    expect(result.photos).toEqual([
      { id: a.photos[0], blobVer: 1 },
      { id: a.photos[1], blobVer: 2 },
    ]);

    const tomb = await one<Record<string, unknown>>(
      `SELECT status, birth_date, gender, country, last_active_on, is_verified, restore_status, deleted_at IS NOT NULL AS has_deleted_at, deleted_via FROM users WHERE id = $1`,
      [a.id],
    );
    expect(tomb).toEqual({ status: 8, birth_date: null, gender: null, country: null, last_active_on: null, is_verified: false, restore_status: null, has_deleted_at: true, deleted_via: 1 });

    const count = (table: string, where: string) => value<string>(`SELECT count(*)::text FROM ${table} WHERE ${where}`, [a.id]);
    // Gone.
    for (const [table, where] of [
      ['profiles', 'user_id = $1'],
      ['profile_prompts', 'user_id = $1'],
      ['profile_field_values', 'user_id = $1'],
      ['preferences', 'user_id = $1'],
      ['user_locations', 'user_id = $1'],
      ['verifications', 'user_id = $1'],
      ['discovery', 'user_id = $1'],
      ['devices', 'user_id = $1'],
      ['sessions', 'user_id = $1'],
      ['auth_identities', 'user_id = $1'],
      ['likes', 'target_id = $1'],
      ['message_requests', 'from_id = $1 OR to_id = $1'],
      ['blocks', 'user_lo = $1 OR user_hi = $1'],
    ] as const) {
      expect(await count(table, where), table).toBe('0');
    }
    expect(await value<string>(`SELECT count(*)::text FROM matches WHERE id = $1`, [ab])).toBe('0');
    expect(await value<string>(`SELECT count(*)::text FROM messages WHERE match_id = $1`, [ab])).toBe('0');
    expect(await value<string>(`SELECT count(*)::text FROM calls WHERE match_id = $1`, [ab])).toBe('0');
    // Kept: the records, and the held conversation whole.
    for (const [table, where] of [
      ['user_consents', 'user_id = $1'],
      ['moderation_actions', 'user_id = $1'],
      ['support_tickets', 'user_id = $1'],
      ['wallet_ledger', 'user_id = $1'],
      ['store_purchases', 'user_id = $1'],
      ['store_events', 'user_id = $1'],
      ['reports', 'reporter_id = $1'],
      ['photos', 'user_id = $1'],
    ] as const) {
      expect(Number(await count(table, where)), table).toBeGreaterThan(0);
    }
    // Likes the person gave stay until their partition is dropped (no actor index).
    expect(await value<string>(`SELECT count(*)::text FROM likes WHERE actor_id = $1`, [a.id])).toBe('1');
    expect(await value<string>(`SELECT count(*)::text FROM messages WHERE match_id = $1`, [ac])).toBe('1');
    expect(await value<number>(`SELECT state FROM matches WHERE id = $1`, [ac])).toBe(4);
    expect(await value<string | null>(`SELECT match_id::text FROM reports WHERE id = $1`, [report])).toBe(ac);

    // The photo rows go once their blobs are gone; a live account's never.
    expect(await purgePhotos(pool, b, a.photos)).toBe(0);
    expect(await purgePhotos(pool, a.id, a.photos)).toBe(2);

    // Running it again changes nothing; once the hold is released, the conversation goes too.
    const again = await purgeAccount(pool, a.id, later);
    expect(again).toMatchObject({ outcome: 'purged', matchIds: [], heldMatchIds: [ac], photos: [] });
    await client.query(`UPDATE legal_holds SET released_at = now() WHERE id = $1`, [hold]);
    const released = await purgeAccount(pool, a.id, later);
    expect(released).toMatchObject({ outcome: 'purged', matchIds: [ac], heldMatchIds: [] });
    expect(await value<string>(`SELECT count(*)::text FROM messages WHERE match_id = $1`, [ac])).toBe('0');
    expect(await value<string | null>(`SELECT match_id::text FROM legal_holds WHERE id = $1`, [hold])).toBeNull();
    expect(await value<string | null>(`SELECT match_id::text FROM reports WHERE id = $1`, [report])).toBeNull();
    // The peers' accounts are untouched.
    expect(await value<number>(`SELECT status FROM users WHERE id = $1`, [b])).toBe(3);
  });

  it('skips an account under a legal hold, and live or unknown accounts', async () => {
    const a = await fullAccount();
    const deleted = await deleteAccount(pool, { userId: a.id }, 1);
    if (deleted.kind !== 'deleted') throw new Error('not deleted');
    const hold = await value<string>(`INSERT INTO legal_holds (id, user_id, kind) VALUES (id_next(), $1, 1) RETURNING id::text`, [a.id]);
    const later = deleted.deletedAtMs + 31 * DAY_MS;
    expect(await purgeAccount(pool, a.id, later)).toEqual({ outcome: 'held', purgeAtMs: deleted.purgeAtMs });
    expect(await value<string>(`SELECT count(*)::text FROM profiles WHERE user_id = $1`, [a.id])).toBe('1');
    expect(await value<number>(`SELECT status FROM users WHERE id = $1`, [a.id])).toBe(7);
    await client.query(`UPDATE legal_holds SET released_at = now() WHERE id = $1`, [hold]);
    expect((await purgeAccount(pool, a.id, later)).outcome).toBe('purged');

    const live = await newUser(3);
    expect(await purgeAccount(pool, live, later)).toEqual({ outcome: 'not_deleted' });
    expect(await purgeAccount(pool, '999999999999', later)).toEqual({ outcome: 'missing' });
    // The database's own clock: a fresh deletion is not due.
    const fresh = await newUser(3);
    await deleteAccount(pool, { userId: fresh }, 1);
    expect((await purgeAccount(pool, fresh, null)).outcome).toBe('not_due');
  });

  it('refuses a held conversation even when the purge did not see the hold (the guard trigger)', async () => {
    const a = await newUser(3);
    const b = await newUser(3);
    const ab = await match(a, b);
    await client.query(`INSERT INTO legal_holds (id, match_id, kind) VALUES (id_next(), $1, 1)`, [ab]);
    await expect(client.query(`DELETE FROM matches WHERE id = $1`, [ab])).rejects.toMatchObject({ code: '23001' });
  });
});
