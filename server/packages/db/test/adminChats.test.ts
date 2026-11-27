import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminUserChatPage,
  adminUserChatPageStatement,
  adminUserChatRequests,
  adminUserChatRequestsStatement,
  adminUserChats,
  adminUserChatsStatement,
  createPool,
  instrumentPool,
  runMigrations,
  statementCounter,
  type Pool,
  type SqlFragment,
} from '../src/index.js';
import { createTempDatabase, hasDatabase, requireSetup, type TempDatabase } from './support.js';

/**
 * Migration 0033 (users.chats for the admin role, by name) and the two
 * reads of a person's conversations on the real migrations: every state,
 * both sides of a match, the keyset pages, the bounded count, holds,
 * visibility, unsends, shadowban records, one statement each, and plans
 * that read the person's match indexes and the messages primary keys.
 */

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const FILE = '0033_admin_user_chats.sql';
const DAY_MS = 86_400_000;

describe.skipIf(!hasDatabase)("admin: a person's conversations (migration 0033)", () => {
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

  async function scalar<T>(text: string, values: unknown[] = []): Promise<T> {
    const { rows } = await client.query<{ v: T }>(text, values);
    return rows[0]?.v as T;
  }

  async function person(options: { status?: number; name?: string | null; shadowbanned?: boolean; test?: boolean } = {}): Promise<string> {
    const status = options.status ?? 3;
    const id = await scalar<string>(
      `INSERT INTO users (id, status, birth_date, gender, deleted_at, is_shadowbanned, flags)
       VALUES (id_next(), $1::smallint, CASE WHEN $1::smallint <> 8 THEN '1990-01-01'::date END, CASE WHEN $1::smallint <> 8 THEN 1 END,
               CASE WHEN $1::smallint IN (7, 8) THEN now() END, $2, $3) RETURNING id::text AS v`,
      [status, options.shadowbanned ?? false, options.test ? 1 : 0],
    );
    if (options.name !== null) await client.query(`INSERT INTO profiles (user_id, display_name) VALUES ($1, $2)`, [id, options.name ?? 'Person']);
    return id;
  }

  /** A match of the two; ended (state 2-5) `endedDaysAgo` days ago by `endedBy` (1 lo, 2 hi, 3 system). */
  async function match(a: string, b: string, options: { state?: number; endedBy?: number; endedDaysAgo?: number; source?: number } = {}): Promise<string> {
    const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
    const state = options.state ?? 1;
    return scalar<string>(
      `INSERT INTO matches (id, user_lo, user_hi, source, state, ended_at, ended_by)
       VALUES (id_next(), $1, $2, $3, $4::smallint, CASE WHEN $4::smallint > 1 THEN now() - make_interval(days => $5) END, CASE WHEN $4::smallint > 1 THEN $6::smallint END)
       RETURNING id::text AS v`,
      [lo, hi, options.source ?? 1, state, options.endedDaysAgo ?? 0, options.endedBy ?? 3],
    );
  }

  async function message(matchId: string, sender: string, options: { kind?: number; body?: string | null; ref?: string | null; flags?: number } = {}): Promise<string> {
    const kind = options.kind ?? 1;
    return scalar<string>(
      `INSERT INTO messages (match_id, id, sender_id, ref_id, kind, flags, body) VALUES ($1, id_next(), $2, $3, $4, $5, $6) RETURNING id::text AS v`,
      [matchId, sender, options.ref ?? null, kind, options.flags ?? 0, options.body === undefined ? (kind === 8 ? null : 'hello') : options.body],
    );
  }

  async function plan(fragment: SqlFragment): Promise<string> {
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

  it('grants users.chats to the admin role by name, to no other role, and re-runs as a no-op', async (ctx) => {
    if (!ready) ctx.skip();
    const holders = async () =>
      (await client.query<{ key: string }>(`SELECT r.key FROM admin_role_permissions p JOIN admin_roles r ON r.id = p.role_id WHERE p.permission = 'users.chats' ORDER BY r.key`)).rows.map(
        (r) => r.key,
      );
    expect(await holders()).toEqual(['admin']);
    const before = await scalar<string>(`SELECT count(*)::text AS v FROM admin_role_permissions`);
    await client.query(readFileSync(new URL(`../migrations/${FILE}`, import.meta.url), 'utf8'));
    expect(await holders()).toEqual(['admin']);
    expect(await scalar<string>(`SELECT count(*)::text AS v FROM admin_role_permissions`)).toBe(before);
    // superadmin keeps '*' (which covers it) and nothing by name.
    expect(await scalar<string[]>(`SELECT array_agg(p.permission ORDER BY p.permission) AS v FROM admin_role_permissions p JOIN admin_roles r ON r.id = p.role_id WHERE r.key = 'superadmin'`)).toEqual(['*']);
  });

  it('lists every conversation of the person, on either side, newest first, in pages, in one statement', async (ctx) => {
    if (!ready) ctx.skip();
    const before = await person({ name: 'Lower' });
    const subject = await person({ name: 'Subject' });
    const after = await person({ name: 'Higher' });
    const third = await person({ name: 'Third' });
    // The subject is user_hi here, user_lo in the next two.
    const asHi = await match(before, subject);
    const asLo = await match(subject, after, { state: 2, endedBy: 1 });
    const blocked = await match(subject, third, { state: 3, endedBy: 2 });
    // Someone else's conversation is never listed.
    await match(before, after);

    const { result, tally } = await statementCounter.measure(() => adminUserChats(pool, subject, { beforeId: null, limit: 10 }));
    expect(tally.statements).toBe(1);
    expect(result.found).toBe(true);
    expect(result.value.map((r) => r.id)).toEqual([blocked, asLo, asHi]);
    const [b, l, h] = result.value as [NonNullable<(typeof result.value)[0]>, NonNullable<(typeof result.value)[0]>, NonNullable<(typeof result.value)[0]>];
    expect(h).toMatchObject({ side: 2, state: 1, source: 1, endedAtMs: null, endedBy: null, lastId: null, count: 0, held: false });
    expect(h.other).toMatchObject({ id: before, name: 'Lower', status: 3 });
    expect(l).toMatchObject({ side: 1, state: 2, endedBy: 1 });
    expect(l.other.id).toBe(after);
    expect(l.endedAtMs).toBeGreaterThan(Date.now() - 60_000);
    expect(b).toMatchObject({ side: 1, state: 3, endedBy: 2 });

    // Keyset pages: two, then the rest.
    const first = await adminUserChats(pool, subject, { beforeId: null, limit: 2 });
    expect(first.value.map((r) => r.id)).toEqual([blocked, asLo]);
    const second = await adminUserChats(pool, subject, { beforeId: asLo, limit: 2 });
    expect(second.value.map((r) => r.id)).toEqual([asHi]);
  });

  it('reads every state, the newest message of any kind and a count bounded at 101 without reactions and unsends', async (ctx) => {
    if (!ready) ctx.skip();
    const subject = await person();
    const others = [];
    for (let i = 0; i < 4; i += 1) others.push(await person());
    const states = [];
    for (const [i, state] of [2, 3, 4, 5].entries()) states.push(await match(subject, others[i]!, { state, endedBy: state === 4 ? 3 : 1 }));
    const busy = await match(subject, await person());
    await client.query(
      `INSERT INTO messages (match_id, id, sender_id, kind, body) SELECT $1, id_next(), $2, 1, 'm' || g FROM generate_series(1, 150) g`,
      [busy, subject],
    );
    const quiet = await match(subject, await person());
    const text = await message(quiet, subject);
    await message(quiet, subject, { kind: 8, ref: text });
    const reaction = await message(quiet, subject, { kind: 7, ref: text, body: '❤' });
    const { value } = await adminUserChats(pool, subject, { beforeId: null, limit: 20 });
    const by = new Map(value.map((r) => [r.id, r]));
    expect(states.map((id) => by.get(id)?.state)).toEqual([2, 3, 4, 5]);
    expect(by.get(states[2]!)?.endedBy).toBe(3);
    expect(by.get(busy)?.count).toBe(101);
    expect(by.get(quiet)).toMatchObject({ count: 1, lastId: reaction, storedSince: [] });
    // With the oldest id read from the stream: the counted stored ids at or above it, newest first, at most 101.
    const since = await adminUserChats(pool, subject, { beforeId: null, limit: 20, since: text });
    const read = new Map(since.value.map((r) => [r.id, r]));
    expect(read.get(quiet)?.storedSince).toEqual([text]);
    expect(read.get(busy)?.storedSince).toEqual([]);
    const all = await adminUserChats(pool, subject, { beforeId: null, limit: 20, since: '1' });
    expect(new Map(all.value.map((r) => [r.id, r])).get(busy)?.storedSince).toHaveLength(101);
  });

  it('answers found false for an unknown account and for a tombstone', async (ctx) => {
    if (!ready) ctx.skip();
    const tombstone = await person({ status: 8, name: null });
    expect(await adminUserChats(pool, tombstone, { beforeId: null, limit: 5 })).toEqual({ found: false, value: [] });
    expect(await adminUserChats(pool, '999999999999999999', { beforeId: null, limit: 5 })).toEqual({ found: false, value: [] });
    const page = await adminUserChatPage(pool, { userId: tombstone, conversationId: '1', beforeId: null, limit: 5 });
    expect(page).toMatchObject({ found: false, matched: false, conversation: null, rows: [] });
  });

  it('marks holds on the match or either person, and reads the visibility rule each way', async (ctx) => {
    if (!ready) ctx.skip();
    const subject = await person();
    const a = await person();
    const b = await person();
    const c = await person({ shadowbanned: true });
    const d = await person({ test: true });
    const held = await match(subject, a);
    const otherHeld = await match(subject, b);
    const shadowed = await match(subject, c);
    const tester = await match(subject, d);
    const hold = await scalar<string>(`INSERT INTO legal_holds (id, match_id, kind) VALUES (id_next(), $1, 2) RETURNING id::text AS v`, [held]);
    await client.query(`INSERT INTO legal_holds (id, user_id, kind) VALUES (id_next(), $1, 3)`, [b]);
    const read = async () => new Map((await adminUserChats(pool, subject, { beforeId: null, limit: 10 })).value.map((r) => [r.id, r]));
    let by = await read();
    expect(by.get(held)?.held).toBe(true);
    expect(by.get(otherHeld)?.held).toBe(true);
    expect(by.get(shadowed)).toMatchObject({ held: false, subjectSeesOther: false, otherSeesSubject: true });
    expect(by.get(tester)).toMatchObject({ subjectSeesOther: false, otherSeesSubject: false });
    expect(by.get(held)).toMatchObject({ subjectSeesOther: true, otherSeesSubject: true });
    await client.query(`UPDATE legal_holds SET released_at = now() WHERE id = $1`, [hold]);
    by = await read();
    expect(by.get(held)?.held).toBe(false);
    // A hold on the subject holds every conversation of theirs.
    await client.query(`INSERT INTO legal_holds (id, user_id, kind) VALUES (id_next(), $1, 1)`, [subject]);
    by = await read();
    expect([...by.values()].every((r) => r.held)).toBe(true);
  });

  it('names a purged other person with no name, and keeps the held conversation listed', async (ctx) => {
    if (!ready) ctx.skip();
    const subject = await person();
    const gone = await person({ status: 8, name: null });
    const kept = await match(subject, gone, { state: 4, endedBy: 3, endedDaysAgo: 40 });
    await client.query(`INSERT INTO legal_holds (id, match_id, kind) VALUES (id_next(), $1, 1)`, [kept]);
    const { value } = await adminUserChats(pool, subject, { beforeId: null, limit: 5 });
    expect(value).toHaveLength(1);
    expect(value[0]).toMatchObject({ id: kept, state: 4, held: true, other: { id: gone, status: 8, name: null, photo: null } });
  });

  it('reads a page of messages newest first, ascending, with the unsend of the same sender only, in one statement', async (ctx) => {
    if (!ready) ctx.skip();
    const subject = await person();
    const other = await person();
    const m = await match(subject, other);
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) ids.push(await message(m, i % 2 === 0 ? subject : other, { body: `line ${i}` }));
    // The subject takes back their first message; the other person's "unsend" of it does not count.
    const fake = await message(m, other, { kind: 8, ref: ids[2]! });
    const unsend = await message(m, subject, { kind: 8, ref: ids[0]! });

    const { result, tally } = await statementCounter.measure(() => adminUserChatPage(pool, { userId: subject, conversationId: m, beforeId: null, limit: 4 }));
    expect(tally.statements).toBe(1);
    expect(result.found).toBe(true);
    expect(result.conversation).toMatchObject({ id: m, side: 1, lastId: unsend, count: 7, storedSince: [] });
    expect(result.matched).toBe(true);
    expect(result.rows.map((r) => r.id)).toEqual([ids[5], ids[6], fake, unsend]);
    // An older page: the rows only, no summary.
    const older = await adminUserChatPage(pool, { userId: subject, conversationId: m, beforeId: ids[5]!, limit: 10 });
    expect(older).toMatchObject({ found: true, matched: true, conversation: null });
    expect(older.rows.map((r) => r.id)).toEqual(ids.slice(0, 5));
    // Which stored messages (of those counted) are at or above the oldest one read from the stream.
    const since = await adminUserChatPage(pool, { userId: subject, conversationId: m, beforeId: null, limit: 4, since: ids[4]! });
    expect(since.conversation?.storedSince).toEqual([ids[6], ids[5], ids[4]]);
    expect(older.rows[0]).toMatchObject({ senderId: subject, body: 'line 0', unsendId: unsend });
    expect(older.rows[2]).toMatchObject({ senderId: subject, unsendId: null });
    // An unsend row names its target and has no unsend of its own.
    expect(result.rows[2]).toMatchObject({ kind: 8, refId: ids[2], unsendId: null });
  });

  it("answers no conversation for a match of two other people, and reads both people's shadowban records", async (ctx) => {
    if (!ready) ctx.skip();
    const subject = await person();
    const other = await person();
    const x = await person();
    const y = await person();
    const theirs = await match(x, y);
    const notMine = await adminUserChatPage(pool, { userId: subject, conversationId: theirs, beforeId: null, limit: 5 });
    expect(notMine).toMatchObject({ found: true, matched: false, conversation: null, rows: [], shadows: [] });
    await message(theirs, x);
    expect((await adminUserChatPage(pool, { userId: subject, conversationId: theirs, beforeId: null, limit: 5 })).rows).toEqual([]);

    const m = await match(subject, other);
    const now = Date.now();
    // Standing, lifted, and one that ran out; and a warning, which is no shadowban.
    await client.query(
      `INSERT INTO moderation_actions (id, user_id, kind, reason_code, reason_text, starts_at, ends_at, revoked_at) VALUES
         (id_next(), $1, 4, 1, 'x', now() - interval '3 days', NULL, NULL),
         (id_next(), $2, 4, 1, 'x', now() - interval '5 days', NULL, now() - interval '4 days'),
         (id_next(), $2, 4, 1, 'x', now() - interval '10 days', now() - interval '9 days', NULL),
         (id_next(), $2, 1, 1, 'x', now() - interval '1 day', NULL, NULL)`,
      [subject, other],
    );
    const page = await adminUserChatPage(pool, { userId: subject, conversationId: m, beforeId: null, limit: 5 });
    expect(page.shadows).toHaveLength(3);
    const [standing, lifted, ran] = page.shadows as [NonNullable<(typeof page.shadows)[0]>, NonNullable<(typeof page.shadows)[0]>, NonNullable<(typeof page.shadows)[0]>];
    expect(standing).toMatchObject({ userId: subject, endsAtMs: null });
    expect(Math.abs(standing.startsAtMs - (now - 3 * DAY_MS))).toBeLessThan(60_000);
    expect(lifted.userId).toBe(other);
    expect(Math.abs(lifted.endsAtMs! - (now - 4 * DAY_MS))).toBeLessThan(60_000);
    expect(Math.abs(ran.endsAtMs! - (now - 9 * DAY_MS))).toBeLessThan(60_000);
  });

  it("plans the list on the person's match indexes and the page on the messages keys, without a sequential scan", async (ctx) => {
    if (!ready) ctx.skip();
    const subject = await person();
    const other = await person();
    const m = await match(subject, other);
    await message(m, subject);
    const list = await plan(adminUserChatsStatement(subject, { beforeId: '999999999999999999', limit: 21 }));
    expect(list).toContain('matches_pair_key');
    expect(list).toContain('matches_hi_idx');
    expect(list).not.toMatch(/Seq Scan/);
    expect(await plan(adminUserChatsStatement(subject, { beforeId: null, limit: 21, since: '1' }))).not.toMatch(/Seq Scan/);
    const page = await plan(adminUserChatPageStatement({ userId: subject, conversationId: m, beforeId: null, limit: 51, since: '1' }));
    expect(page).toContain('matches_pkey');
    // The range and, on these few rows, the unsend probe too (messages_unsent_ref_idx once a partition holds more).
    expect(page).toMatch(/messages_\w+_pkey/);
    expect(page).toContain('moderation_actions_user_idx');
    expect(page).not.toMatch(/Seq Scan/);
  });

  it('reads the message requests both ways on their sender and recipient indexes, newest first, in one statement', async (ctx) => {
    if (!ready) ctx.skip();
    const subject = await person();
    const [a, b] = [await person(), await person()];
    const insert = async (from: string, to: string, status: number) =>
      (
        await client.query<{ id: string }>(
          `INSERT INTO message_requests (id, from_id, to_id, status, decided_at, body) VALUES (id_next(), $1, $2, $3, CASE WHEN $3::smallint = 1 THEN NULL ELSE now() END, 'hi') RETURNING id::text`,
          [from, to, status],
        )
      ).rows[0]!.id;
    const sent = await insert(subject, a, 3);
    const received = await insert(b, subject, 1);
    await insert(a, b, 1);
    const all = await adminUserChatRequests(client, subject, { beforeId: null, limit: 10 });
    expect(all.found).toBe(true);
    expect(all.value.map((r) => [r.id, r.direction, r.status])).toEqual([
      [received, 2, 1],
      [sent, 1, 3],
    ]);
    expect((await adminUserChatRequests(client, subject, { beforeId: received, limit: 10 })).value.map((r) => r.id)).toEqual([sent]);
    const planned = await plan(adminUserChatRequestsStatement(subject, { beforeId: '999999999999999999', limit: 21 }));
    expect(planned).toContain('message_requests_from_idx');
    expect(planned).toMatch(/message_requests_(to|inbox)_idx/);
    expect(planned).not.toMatch(/Seq Scan/);
  });
});
