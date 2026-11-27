import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminAssignReport,
  adminCloseReports,
  adminCloseReportsStatement,
  adminCreateHold,
  adminDecideAppeal,
  adminDecidePhoto,
  adminHoldAndFile,
  adminPhotoQueueStatement,
  adminReleaseHold,
  adminReportListStatement,
  adminTextQueue,
  adminTextQueueStatement,
  createPool,
  runMigrations,
  sweepReportEvidence,
  sweepReportEvidenceStatement,
  type Pool,
  type SqlFragment,
} from '../src/index.js';
import { createTempDatabase, hasDatabase, requireSetup, type TempDatabase } from './support.js';

/**
 * Migration 0027 on the real migrations: photo_decide() from every state,
 * the one-statement report, hold and appeal writes, the evidence sweep, and
 * the plans of the queues and lists (each from its index, never a scan of
 * photos, profiles or reports).
 */

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

describe.skipIf(!hasDatabase)('admin moderation (migration 0027)', () => {
  let db: TempDatabase;
  let client: pg.Client;
  let pool: Pool;
  let ready = false;
  let adminId = 0;

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
    adminId = await scalar<number>(`INSERT INTO admin_users (email, display_name, password_hash) VALUES ('m@example.com', 'Mina', '$argon2id$x') RETURNING id AS v`);
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

  const newId = () => scalar<string>(`SELECT id_next()::text AS v`);

  async function person(status = 3): Promise<string> {
    const id = await scalar<string>(`INSERT INTO users (id, status, birth_date, gender, deleted_at) VALUES (id_next(), $1::smallint, '1990-01-01', 1, CASE WHEN $1::smallint IN (7, 8) THEN now() END) RETURNING id::text AS v`, [status]);
    await client.query(`INSERT INTO profiles (user_id, display_name) VALUES ($1, 'Person')`, [id]);
    return id;
  }

  async function photo(userId: string, status: number, position = 0, reason: number | null = null): Promise<string> {
    return scalar<string>(
      `INSERT INTO photos (id, user_id, position, status, reject_reason, width, height, blob_ver) VALUES (id_next(), $1, $2, $3, $4, 1080, 1350, 1) RETURNING id::text AS v`,
      [userId, position, status, status === 4 ? (reason ?? 1) : null],
    );
  }

  async function report(targetId: string, options: { reporterId?: string | null; reason?: number; status?: number; priority?: number; matchId?: string | null } = {}): Promise<string> {
    const status = options.status ?? 1;
    return scalar<string>(
      `INSERT INTO reports (id, target_id, reporter_id, match_id, context, reason, status, priority, resolved_at, evidence_at)
       VALUES (id_next(), $1, $2, $3, 1, $4, $5::smallint, $6, CASE WHEN $5::smallint IN (3, 4, 5) THEN now() END, now()) RETURNING id::text AS v`,
      [targetId, options.reporterId ?? null, options.matchId ?? null, options.reason ?? 2, status, options.priority ?? 40],
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

  /** The plan as run (inside a transaction rolled back), without costs or timings. */
  async function analyze(fragment: SqlFragment): Promise<string> {
    await client.query('BEGIN');
    try {
      const query = fragment.toQuery();
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF, BUFFERS OFF) ${query.text}`, query.values);
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    } finally {
      await client.query('ROLLBACK');
    }
  }

  /** Waits until `waiting` sessions of this database wait on a lock. */
  async function lockWaits(waiting: number): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const n = await scalar<number>(`SELECT (SELECT array_length(array_agg(pid), 1) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock')::integer AS v`);
      if ((n ?? 0) >= waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`no ${waiting} lock waits`);
  }

  it('decides a photo from each state; a rejection writes its record, the same reason twice changes nothing', async (ctx) => {
    if (!ready) ctx.skip();
    const u = await person();
    const waiting = await photo(u, 2);
    const decide = async (photoId: string, approve: boolean, reason: number | null = null) =>
      adminDecidePhoto(pool, { photoId, adminId, approve, reasonCode: reason, actionId: await newId(), reasonText: reason ? 'Nudity or sexual content is not allowed.' : null, expect: null });

    const rejected = await decide(waiting, false, 2);
    expect(rejected).toMatchObject({ outcome: 'decided', userId: u, before: { status: 2 }, after: { status: 4, rejectReason: 2 } });
    if (rejected.outcome !== 'decided') throw new Error('not decided');
    expect(rejected.actionId).not.toBeNull();
    expect(await scalar<string>(`SELECT note AS v FROM moderation_actions WHERE id = $1 AND kind = 6 AND reason_code = 2`, [rejected.actionId])).toBe(`photo ${waiting}`);
    expect(await decide(waiting, false, 2)).toMatchObject({ outcome: 'unchanged', status: 4, rejectReason: 2 });
    expect(await decide(waiting, false, 3)).toMatchObject({ outcome: 'decided', before: { status: 4, rejectReason: 2 }, after: { status: 4, rejectReason: 3 } });
    expect(await decide(waiting, true)).toMatchObject({ outcome: 'decided', after: { status: 3 }, actionId: null });
    expect(await scalar<number | null>(`SELECT reject_reason AS v FROM photos WHERE id = $1`, [waiting])).toBeNull();
    expect(await decide(waiting, true)).toMatchObject({ outcome: 'unchanged', status: 3 });
    expect(await decide(await photo(u, 1, 1), true)).toEqual({ outcome: 'processing' });
    expect(await decide('99999999999', true)).toEqual({ outcome: 'missing' });
  });

  it('refuses a decision on a photo another admin decided since it was seen, and keeps theirs', async (ctx) => {
    if (!ready) ctx.skip();
    const u = await person();
    const waiting = await photo(u, 2);
    const reject = async (expect: number | null) =>
      adminDecidePhoto(pool, { photoId: waiting, adminId, approve: false, reasonCode: 2, actionId: await newId(), reasonText: 'x', expect });
    const approve = async (expect: number | null) => adminDecidePhoto(pool, { photoId: waiting, adminId, approve: true, reasonCode: null, actionId: null, reasonText: null, expect });

    // A holds the photo's lock with its rejection; B approves from the same queue page and waits on it.
    const a = await pool.connect();
    try {
      await a.query('BEGIN');
      const first = await adminDecidePhoto(a, { photoId: waiting, adminId, approve: false, reasonCode: 2, actionId: await newId(), reasonText: 'x', expect: 2 });
      expect(first).toMatchObject({ outcome: 'decided', after: { status: 4, rejectReason: 2 } });
      const second = approve(2);
      await lockWaits(1);
      await a.query('COMMIT');
      // B finds the photo rejected, not waiting: nothing is written and A's rejection stands.
      expect(await second).toMatchObject({ outcome: 'decided_elsewhere', status: 4, rejectReason: 2 });
    } finally {
      a.release();
    }
    expect(await scalar<number>(`SELECT status AS v FROM photos WHERE id = $1`, [waiting])).toBe(4);
    expect(await scalar<number>(`SELECT count(*)::integer AS v FROM moderation_actions WHERE user_id = $1 AND kind = 6`, [u])).toBe(1);
    // The same decision again (a retry) is unchanged whatever status was seen; another reason from "waiting" is refused.
    expect(await reject(2)).toMatchObject({ outcome: 'unchanged', status: 4, rejectReason: 2 });
    expect(
      await adminDecidePhoto(pool, { photoId: waiting, adminId, approve: false, reasonCode: 6, actionId: await newId(), reasonText: 'x', expect: 2 }),
    ).toMatchObject({ outcome: 'decided_elsewhere', status: 4 });
    // Seen as rejected (the user page), it can be approved; no status seen decides whatever it is.
    expect(await approve(4)).toMatchObject({ outcome: 'decided', after: { status: 3 } });
    expect(await reject(null)).toMatchObject({ outcome: 'decided', after: { status: 4 } });
  });

  it('lapses a verification when the reference photo is rejected', async (ctx) => {
    if (!ready) ctx.skip();
    const u = await person();
    const main = await photo(u, 3, 0);
    await client.query(`INSERT INTO verifications (id, user_id, method, status, photo_id, decided_at) VALUES (id_next(), $1, 1, 3, $2, now())`, [u, main]);
    await client.query(`UPDATE users SET is_verified = true WHERE id = $1`, [u]);
    await adminDecidePhoto(pool, { photoId: main, adminId, approve: false, reasonCode: 5, actionId: await newId(), reasonText: 'x', expect: null });
    expect(await scalar<boolean>(`SELECT is_verified AS v FROM users WHERE id = $1`, [u])).toBe(false);
    expect(await scalar<number>(`SELECT status AS v FROM verifications WHERE user_id = $1`, [u])).toBe(6);
  });

  it('lists texts waiting: profile only, prompts only, both; a name-only profile is not there', async (ctx) => {
    if (!ready) ctx.skip();
    await client.query(`UPDATE profiles SET text_state = 2`);
    const prompt = await scalar<number>(`INSERT INTO prompt_defs (i18n) VALUES ('{"en": "Q"}') RETURNING id AS v`);
    const second = await scalar<number>(`INSERT INTO prompt_defs (i18n) VALUES ('{"en": "Q2"}') RETURNING id AS v`);
    const profileOnly = await person();
    await client.query(`UPDATE profiles SET about = 'Hi', text_state = 1 WHERE user_id = $1`, [profileOnly]);
    const promptOnly = await person();
    await client.query(`UPDATE profiles SET text_state = 2 WHERE user_id = $1`, [promptOnly]);
    await client.query(`INSERT INTO profile_prompts (user_id, position, prompt_id, answer, status) VALUES ($1, 0, $2, 'Tea', 1)`, [promptOnly, prompt]);
    const both = await person();
    await client.query(`UPDATE profiles SET job_title = 'Pilot', text_state = 1 WHERE user_id = $1`, [both]);
    await client.query(`INSERT INTO profile_prompts (user_id, position, prompt_id, answer, status) VALUES ($1, 0, $2, 'Sea', 1), ($1, 1, $3, 'Sky', 1)`, [both, prompt, second]);
    const nameOnly = await person();
    await client.query(`UPDATE profiles SET text_state = 1 WHERE user_id = $1`, [nameOnly]);
    const deleted = await person(7);
    await client.query(`UPDATE profiles SET about = 'Gone', text_state = 1 WHERE user_id = $1`, [deleted]);

    const page = await adminTextQueue(pool, { limit: 10 });
    expect(page.map((r) => r.userId)).toEqual([profileOnly, promptOnly, both]);
    expect(page[2]?.texts).toMatchObject({ job: 'Pilot', textState: 1, prompts: [{ position: 0, status: 1 }, { position: 1, status: 1 }] });
    const next = await adminTextQueue(pool, { afterUserId: profileOnly, limit: 1 });
    expect(next.map((r) => r.userId)).toEqual([promptOnly]);
    const text = await plan(adminTextQueueStatement({ afterUserId: '1', limit: 21 }));
    expect(text).toContain('profiles_text_review_idx');
    expect(text).toContain('profile_prompts_review_idx');
  });

  it('serves the queues and lists from their indexes', async (ctx) => {
    if (!ready) ctx.skip();
    const photoQueue = await plan(adminPhotoQueueStatement({ afterId: '1', limit: 25 }));
    expect(photoQueue).toContain('photos_review_queue_idx');
    expect(photoQueue).not.toMatch(/Seq Scan on photos/);
    const expected = { queue: 'reports_queue_idx', unassigned: 'reports_queue_idx', mine: 'reports_assignee_idx', resolved: 'reports_resolved_idx' } as const;
    for (const [view, index] of Object.entries(expected)) {
      const cursor = view === 'resolved' ? { at: '2026-11-26T10:00:00.000000Z', id: '99999999999' } : { p: 60, id: '1' };
      const text = await plan(adminReportListStatement({ view: view as keyof typeof expected, adminId, cursor, limit: 21 }));
      expect(text, view).toContain(index);
      expect(text, view).not.toMatch(/Seq Scan on reports/);
    }
  });

  it('assigns once: the one who saw it unassigned wins, the other finds it taken', async (ctx) => {
    if (!ready) ctx.skip();
    const target = await person();
    const r = await report(target);
    const other = await scalar<number>(`INSERT INTO admin_users (email, display_name, password_hash) VALUES ('o@example.com', 'Omid', '$argon2id$x') RETURNING id AS v`);
    const a = await adminAssignReport(pool, { reportId: r, to: adminId, from: null });
    expect(a).toMatchObject({ outcome: 'assigned', before: { status: 1, assignee: null }, report: { status: 2, assignee: { id: String(adminId) } } });
    expect(await adminAssignReport(pool, { reportId: r, to: other, from: null })).toEqual({ outcome: 'taken', assignee: adminId });
    expect(await adminAssignReport(pool, { reportId: r, to: adminId, from: adminId })).toMatchObject({ outcome: 'unchanged' });
    await client.query(`UPDATE admin_users SET disabled_at = now() WHERE id = $1`, [other]);
    expect(await adminAssignReport(pool, { reportId: r, to: other, from: adminId })).toEqual({ outcome: 'unknown_admin' });
    expect(await adminAssignReport(pool, { reportId: r, to: null, from: adminId })).toMatchObject({ outcome: 'assigned', report: { status: 1, assignee: null } });
    expect(await adminAssignReport(pool, { reportId: '99999999999', to: adminId, from: null })).toEqual({ outcome: 'missing' });
  });

  it('closes a report and, asked, the person’s other open ones; the evidence is emptied after the retention', async (ctx) => {
    if (!ready) ctx.skip();
    const target = await person();
    const one = await report(target);
    const two = await report(target);
    const old = await report(target, { status: 4 });
    // Never swept along: another reason, a higher priority, a threat or a child-safety report (each reviewed on its own).
    const spam = await report(target, { reason: 7 });
    const urgent = await report(target, { priority: 90 });
    const threat = await report(target, { reason: 6 });
    const child = await report(target, { reason: 8, priority: 100 });
    const closed = await adminCloseReports(pool, { reportId: one, status: 3, resolution: 2, adminId, sameTarget: true, retentionDays: 365 });
    if (closed.outcome !== 'closed') throw new Error(closed.outcome);
    expect(closed.reports.map((r) => r.id)).toEqual([one, two]);
    for (const open of [spam, urgent, threat, child]) expect(await scalar<number>(`SELECT status AS v FROM reports WHERE id = $1`, [open])).toBe(1);
    // A threat report closes alone, whatever the box says.
    const threatClosed = await adminCloseReports(pool, { reportId: threat, status: 4, resolution: 11, adminId, sameTarget: true, retentionDays: 365 });
    expect(threatClosed).toMatchObject({ outcome: 'closed', reports: [{ id: threat }] });
    if (threatClosed.outcome === 'closed') expect(threatClosed.reports).toHaveLength(1);
    expect(closed.reports.every((r) => r.status === 3 && r.resolution === 2)).toBe(true);
    const days = await scalar<number>(`SELECT round(extract(epoch FROM evidence_purge_at - resolved_at) / 86400)::integer AS v FROM reports WHERE id = $1`, [two]);
    expect(days).toBe(365);
    expect(await adminCloseReports(pool, { reportId: one, status: 4, resolution: 11, adminId, sameTarget: false, retentionDays: 365 })).toEqual({ outcome: 'closed_already' });
    expect(await scalar<number>(`SELECT status AS v FROM reports WHERE id = $1`, [old])).toBe(4);
  });

  it('changes only the reports a close names, by key, however long the open queue is', async (ctx) => {
    if (!ready) ctx.skip();
    const target = await person();
    const asked = await report(target);
    const sibling = await report(target);
    // A backlog of open reports on other people (a report wave).
    await client.query(
      `INSERT INTO reports (id, target_id, context, reason, status, priority, evidence_at)
       SELECT id_next(), $1, 1, 7, 1, 40, now() FROM generate_series(1, 400)`,
      [await person()],
    );
    await client.query('ANALYZE reports');
    for (const sameTarget of [false, true]) {
      const text = await analyze(adminCloseReportsStatement({ reportId: asked, status: 4, resolution: 11, adminId, sameTarget, retentionDays: 30 }));
      // Never the open queue's index, never a scan of reports: the locked ids, each by its key.
      expect(text, text).not.toContain('reports_queue_idx');
      expect(text, text).not.toMatch(/Seq Scan on reports/);
      expect(text, text).toMatch(/Index Scan using reports_pkey on reports x/);
      const scanned = [...text.matchAll(/on reports \w+ \(actual rows=(\d+)/g)].map((m) => Number(m[1]));
      expect(Math.max(...scanned), text).toBeLessThanOrEqual(sameTarget ? 2 : 1);
    }
    expect(await scalar<number>(`SELECT status AS v FROM reports WHERE id = $1`, [sibling])).toBe(1);
  });

  it('closes a person’s reports from two admins at once: one closes both, the other finds them closed (no deadlock)', async (ctx) => {
    if (!ready) ctx.skip();
    const target = await person();
    const first = await report(target);
    const second = await report(target);
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      // A third session holds the first report, so both closes queue behind it.
      await client.query('BEGIN');
      await client.query(`SELECT id FROM reports WHERE id = $1 FOR UPDATE`, [first]);
      const one = adminCloseReports(a, { reportId: first, status: 3, resolution: 2, adminId, sameTarget: true, retentionDays: 30 });
      await lockWaits(1);
      const two = adminCloseReports(b, { reportId: second, status: 4, resolution: 11, adminId, sameTarget: true, retentionDays: 30 });
      await lockWaits(2);
      await client.query('COMMIT');
      const outcomes = await Promise.all([one, two]);
      expect(outcomes[0]).toMatchObject({ outcome: 'closed', reports: [{ id: first, status: 3 }, { id: second, status: 3 }] });
      expect(outcomes[1]).toEqual({ outcome: 'closed_already' });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
  });

  it('files once and holds the account and the conversation; holds are created and released by hand', async (ctx) => {
    if (!ready) ctx.skip();
    const target = await person();
    const reporter = await person();
    const [lo, hi] = BigInt(target) < BigInt(reporter) ? [target, reporter] : [reporter, target];
    const matchId = await scalar<string>(`INSERT INTO matches (id, user_lo, user_hi, source) VALUES (id_next(), $1, $2, 1) RETURNING id::text AS v`, [lo, hi]);
    const r = await report(target, { reporterId: reporter, reason: 6, matchId });
    const filed = await adminHoldAndFile(pool, { reportId: r, adminId, authority: 3, externalRef: 'CASE-7', userHoldId: await newId(), matchHoldId: await newId() });
    if (filed.outcome !== 'filed') throw new Error(filed.outcome);
    expect(filed.created.map((h) => [h.kind, h.user?.id ?? null, h.conversationId])).toEqual(
      expect.arrayContaining([
        [2, target, null],
        [2, null, matchId],
      ]),
    );
    expect(filed.created.every((h) => h.filing?.authority === 3 && h.authorityRef === 'CASE-7')).toBe(true);
    expect(await adminHoldAndFile(pool, { reportId: r, adminId, authority: 3, externalRef: null, userHoldId: await newId(), matchHoldId: await newId() })).toEqual({ outcome: 'filed_already' });

    expect(await adminCreateHold(pool, { id: await newId(), userId: '99999999999', matchId: null, reportId: null, kind: 3, adminId, authorityRef: null })).toEqual({ outcome: 'unknown_user' });
    expect(await adminCreateHold(pool, { id: await newId(), userId: null, matchId: '99999999999', reportId: null, kind: 3, adminId, authorityRef: null })).toEqual({ outcome: 'unknown_conversation' });
    expect(await adminCreateHold(pool, { id: await newId(), userId: target, matchId: null, reportId: '99999999999', kind: 3, adminId, authorityRef: null })).toEqual({ outcome: 'unknown_report' });
    const made = await adminCreateHold(pool, { id: await newId(), userId: target, matchId: null, reportId: r, kind: 3, adminId, authorityRef: 'REQ-1' });
    if (made.outcome !== 'created') throw new Error(made.outcome);
    expect(made.hold).toMatchObject({ kind: 3, user: { id: target }, reportId: r, createdBy: { displayName: 'Mina' }, filing: { authority: 3 } });
    const released = await adminReleaseHold(pool, { holdId: made.hold.id, adminId, reason: 'The case is closed.' });
    expect(released).toMatchObject({ outcome: 'released', hold: { releasedReason: 'The case is closed.', releasedBy: { id: String(adminId) } } });
    expect(await adminReleaseHold(pool, { holdId: made.hold.id, adminId, reason: 'Again.' })).toMatchObject({ outcome: 'unchanged', hold: { releasedReason: 'The case is closed.' } });
    expect(await adminReleaseHold(pool, { holdId: '99999999999', adminId, reason: 'x' })).toEqual({ outcome: 'missing' });
    // A hold placed while the account purge holds the row is judged on the purged row.
    const purged = await person();
    const h = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [purged]);
      await client.query(`UPDATE users SET status = 8, deleted_at = now(), birth_date = NULL, gender = NULL, country = NULL WHERE id = $1`, [purged]);
      const placing = adminCreateHold(h, { id: await newId(), userId: purged, matchId: null, reportId: null, kind: 3, adminId, authorityRef: null });
      await lockWaits(1);
      await client.query('COMMIT');
      expect(await placing).toEqual({ outcome: 'unknown_user' });
      expect(await scalar<string | null>(`SELECT (SELECT id::text FROM legal_holds WHERE user_id = $1) AS v`, [purged])).toBeNull();
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      h.release();
    }

    // A reason only with a release, never deleted.
    await expect(client.query(`UPDATE legal_holds SET released_reason = 'x' WHERE released_at IS NULL`)).rejects.toThrow(/legal_holds_released_reason/);
  });

  it('decides an appeal and answers it as it is after the decision', async (ctx) => {
    if (!ready) ctx.skip();
    const u = await person();
    const ban = await newId();
    await client.query(`SELECT moderation_apply($1, $2, 3::smallint, 2::smallint, 'Harassment.', NULL, $3, NULL, NULL)`, [ban, u, adminId]);
    const appealId = await scalar<string>(`INSERT INTO appeals (id, user_id, action_id, body) VALUES (id_next(), $1, $2, 'Not me.') RETURNING id::text AS v`, [u, ban]);
    const decided = await adminDecideAppeal(pool, { appealId, overturn: true, adminId, text: 'You were right.', liftId: await newId(), withShadowbans: true });
    expect(decided.outcome).toMatchObject({ outcome: 'overturned', after: { status: 3 } });
    expect(decided.appeal).toMatchObject({ status: 3, decisionText: 'You were right.', decidedBy: { displayName: 'Mina' }, action: { id: ban } });
    expect(decided.appeal?.action.revokedAtMs).not.toBeNull();
    expect(decided.appeal?.history.map((a) => a.kind)).toEqual([5]);
    expect((await adminDecideAppeal(pool, { appealId, overturn: false, adminId, text: 'x', liftId: await newId(), withShadowbans: true })).outcome).toEqual({ outcome: 'decided' });
  });

  it('sweeps due evidence, skips a held report until its hold is released, keeps the report’s metadata', async (ctx) => {
    if (!ready) ctx.skip();
    const target = await person();
    const due = await report(target, { status: 3 });
    const held = await report(target, { status: 4 });
    const later = await report(target, { status: 4 });
    await client.query(`UPDATE reports SET evidence = '{"v": 1, "items": [{"details": "x"}]}', details = 'words', resolution = 2, evidence_purge_at = now() - interval '1 day' WHERE id IN ($1, $2)`, [due, held]);
    await client.query(`UPDATE reports SET evidence_purge_at = now() + interval '1 day' WHERE id = $1`, [later]);
    // A hold that names the report (on someone else's account: the report's own people are not held).
    const hold = await scalar<string>(`INSERT INTO legal_holds (id, user_id, report_id, kind) VALUES (id_next(), $1, $2, 1) RETURNING id::text AS v`, [await person(), held]);
    expect(await sweepReportEvidence(pool, 500)).toEqual([due]);
    const { rows } = await client.query(`SELECT evidence, details, evidence_purge_at, status, resolution, reason FROM reports WHERE id = $1`, [due]);
    expect(rows[0]).toMatchObject({ evidence: {}, details: null, evidence_purge_at: null, status: 3, resolution: 2, reason: 2 });
    expect(await sweepReportEvidence(pool, 500)).toEqual([]);
    await client.query(`UPDATE legal_holds SET released_at = now() WHERE id = $1`, [hold]);
    expect(await sweepReportEvidence(pool, 500)).toEqual([held]);
  });

  it('keeps the evidence while a hold keeps the reported account, the reporter’s or the conversation, whatever report the hold names', async (ctx) => {
    if (!ready) ctx.skip();
    const held = await person();
    const reporter = await person();
    const other = await person();
    const [lo, hi] = BigInt(other) < BigInt(reporter) ? [other, reporter] : [reporter, other];
    const matchId = await scalar<string>(`INSERT INTO matches (id, user_lo, user_hi, source) VALUES (id_next(), $1, $2, 1) RETURNING id::text AS v`, [lo, hi]);
    const onAccount = await report(held, { status: 3 });
    const onAccountToo = await report(held, { status: 4 });
    const byReporter = await report(other, { reporterId: reporter, status: 4 });
    const inConversation = await report(other, { matchId, status: 4 });
    const free = await report(other, { status: 4 });
    const due = [onAccount, onAccountToo, byReporter, inConversation, free];
    await client.query(`UPDATE reports SET evidence = '{"v": 1, "items": [{"details": "x"}]}', details = 'words', evidence_purge_at = now() - interval '1 day' WHERE id = ANY($1::bigint[])`, [due]);
    // An authority's hold on the account alone (no report), a hold that names the first report (and so the account),
    // one on the reporter's account, one on the conversation alone.
    const holds = [
      await scalar<string>(`INSERT INTO legal_holds (id, user_id, kind) VALUES (id_next(), $1, 3) RETURNING id::text AS v`, [held]),
      await scalar<string>(`INSERT INTO legal_holds (id, user_id, report_id, kind) VALUES (id_next(), $1, $2, 2) RETURNING id::text AS v`, [held, onAccount]),
      await scalar<string>(`INSERT INTO legal_holds (id, user_id, kind) VALUES (id_next(), $1, 3) RETURNING id::text AS v`, [reporter]),
      await scalar<string>(`INSERT INTO legal_holds (id, match_id, kind) VALUES (id_next(), $1, 3) RETURNING id::text AS v`, [matchId]),
    ];
    expect(await sweepReportEvidence(pool, 500)).toEqual([free]);
    // From the purge index; the holds are asked per due report (legal_hold_active(): partial-index probes).
    const plan = await analyze(sweepReportEvidenceStatement(500));
    expect(plan).toContain('reports_evidence_purge_idx');
    expect(plan).toContain('legal_hold_active(target_id, match_id)');
    // The account's two holds: both must go before its reports are emptied.
    await client.query(`UPDATE legal_holds SET released_at = now() WHERE id = $1`, [holds[0]]);
    expect(await sweepReportEvidence(pool, 500)).toEqual([]);
    await client.query(`UPDATE legal_holds SET released_at = now() WHERE id = $1`, [holds[1]]);
    expect((await sweepReportEvidence(pool, 500)).sort()).toEqual([onAccount, onAccountToo].sort());
    await client.query(`UPDATE legal_holds SET released_at = now() WHERE id = ANY($1::bigint[])`, [[holds[2], holds[3]]]);
    expect((await sweepReportEvidence(pool, 500)).sort()).toEqual([byReporter, inConversation].sort());
  });
});
