import { randomBytes } from 'node:crypto';
import {
  accountView,
  applyModeration,
  blockUser,
  blockedPeople,
  createPool,
  decideAppeal,
  dueModeration,
  fileAppeal,
  fileReport,
  instrumentPool,
  ownModeration,
  restoreAccount,
  revokeModeration,
  setReportStatus,
  settleModeration,
  statementCounter,
  unblockUser,
  type Pool,
} from '@app/db';
import { userChannel } from '@app/shared';
import {
  FakeRealtimePublisher,
  IdGenerator,
  createKeys,
  createPublicIds,
  queuePrefix,
  safetyJobIds,
  type ModerationEndData,
} from '@app/shared/server';
import { Queue, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type JobContext } from '../src/index.js';
import { FakePhotoModerator } from '../src/photos/moderation.js';
import { blockDeckJob, moderationEndJob, moderationSweepJob } from '../src/queues/safety.js';
import type { WorkerServices } from '../src/services.js';
import { ensureGroupRoles, hasDatabase, loginRole, migratedDatabase, type TestDatabase } from './db.js';
import { TEST_REDIS_URL, baseEnv, connect, hasRedis } from './support.js';

/**
 * The safety writes of migration 0016 as the application's own role runs
 * them (app_rw: the grants are part of what is checked), one statement
 * each: blocks and the block list, reports (merging, evidence, priority,
 * the child-safety hold, the block inside a report), moderation actions
 * and how overlapping penalties unwind, appeals; then the `safety` queue's
 * jobs against Valkey.
 */

type FakeJob<T> = Job<T> & { delayedUntil?: number };

function fakeJob<T>(name: string, data: T): FakeJob<T> {
  const job = {
    name,
    data,
    id: `${name}.test`,
    async updateData(next: T) {
      job.data = next;
    },
  } as unknown as FakeJob<T>;
  return job;
}

describe.skipIf(!hasDatabase || !hasRedis)('safety writes (PostgreSQL as app_rw, Valkey)', () => {
  let db: TestDatabase;
  let pg: Pool;
  let redis: Redis;
  let ids: IdGenerator;
  let realtime: FakeRealtimePublisher;
  let context: JobContext;
  let role: Awaited<ReturnType<typeof loginRole>>;
  const prefix = `t${randomBytes(4).toString('hex')}:`;
  const keys = createKeys(prefix);
  const env = baseEnv();
  const publicIds = createPublicIds(env['ID_PUBLIC_KEY']!, env['ID_BILLING_KEY']!);

  beforeAll(async () => {
    await ensureGroupRoles();
    role = await loginRole(['app_rw']);
    db = await migratedDatabase();
    pg = instrumentPool(createPool({ connectionString: db.urlFor(role.name, role.password), applicationName: 'safety-test', max: 4 }), statementCounter);
    redis = connect();
    ids = new IdGenerator({ redis, keyPrefix: prefix });
    await ids.start();
    realtime = new FakeRealtimePublisher();
    const services: WorkerServices = { pg, cache: redis, ids, keys, publicIds, realtime, media: null, photoModerator: new FakePhotoModerator({ autoApprove: false }) };
    const config = loadConfig({ ...env, DATABASE_URL: db.url, REDIS_URL: TEST_REDIS_URL ?? '', REDIS_KEY_PREFIX: prefix, WORKER_ID: 'safety-test' });
    context = { config, redis, log: pino({ level: 'silent' }), services, token: 'test-token' };
  }, 90_000);

  afterAll(async () => {
    await ids?.stop();
    await pg?.end();
    const left = await redis.keys(`${prefix}*`);
    if (left.length > 0) await redis.del(...left);
    await redis?.quit();
    await db?.drop();
    await role?.drop();
  });

  async function value<T>(text: string, values: unknown[] = []): Promise<T> {
    const { rows } = await db.admin.query(text, values);
    return Object.values(rows[0] as Record<string, T>)[0] as T;
  }

  async function person(options: { status?: number; name?: string | null; basics?: boolean } = {}): Promise<string> {
    const id = ids.nextId();
    const status = options.status ?? 3;
    const basics = options.basics ?? status !== 8;
    await db.admin.query(
      `INSERT INTO users (id, status, birth_date, gender, country, deleted_at) VALUES ($1, $2, $3, $4, $5, CASE WHEN $2::smallint IN (7, 8) THEN now() END)`,
      [id, status, basics ? '1992-03-04' : null, basics ? 1 : null, status === 8 ? null : 'TR'],
    );
    if (options.name !== null && status !== 8) {
      await db.admin.query(`INSERT INTO profiles (user_id, display_name, about) VALUES ($1, $2, 'About me')`, [id, options.name ?? 'Sam']);
    }
    return id;
  }

  async function match(a: string, b: string): Promise<string> {
    const id = ids.nextId();
    await db.admin.query(`INSERT INTO matches (id, user_lo, user_hi, source) VALUES ($1, least($2::bigint, $3::bigint), greatest($2::bigint, $3::bigint), 1)`, [id, a, b]);
    return id;
  }

  async function matchState(id: string): Promise<number> {
    return Number(await value<number>(`SELECT state FROM matches WHERE id = $1`, [id]));
  }

  async function status(id: string): Promise<{ status: number; shadowbanned: boolean }> {
    const { rows } = await db.admin.query<{ status: number; shadowbanned: boolean }>(`SELECT status, is_shadowbanned AS shadowbanned FROM users WHERE id = $1`, [id]);
    return { status: Number(rows[0]!.status), shadowbanned: rows[0]!.shadowbanned };
  }

  async function one<T>(fn: () => Promise<T>): Promise<T> {
    const { result, tally } = await statementCounter.measure(fn);
    expect(tally.statements).toBe(1);
    return result;
  }

  describe('blocks', () => {
    it('blocks in one statement: each side keeps its own time, the conversation ends as a block, repeats change nothing', async () => {
      const a = await person({ name: 'Ann' });
      const b = await person({ name: 'Bob' });
      const m = await match(a, b);
      const first = await one(() => blockUser(pg, a, b));
      expect(first).toMatchObject({ found: true, already: false, endedNow: true, match: { matchId: m, state: 3 } });
      expect(await matchState(m)).toBe(3);
      const side = BigInt(a) < BigInt(b) ? 1 : 2;
      expect(Number(await value(`SELECT ended_by FROM matches WHERE id = $1`, [m]))).toBe(side);
      const again = await one(() => blockUser(pg, a, b));
      expect(again).toMatchObject({ found: true, already: true, endedNow: false, match: { matchId: m, state: 3 } });
      // The other side blocks too: both bits, the first side's time unchanged.
      const before = await value<Date>(`SELECT CASE WHEN user_lo = $1 THEN lo_at ELSE hi_at END FROM blocks WHERE user_lo = least($1::bigint, $2::bigint) AND user_hi = greatest($1::bigint, $2::bigint)`, [a, b]);
      await blockUser(pg, b, a);
      expect(Number(await value(`SELECT blocked_by FROM blocks WHERE user_lo = least($1::bigint, $2::bigint)`, [a, b]))).toBe(3);
      const after = await value<Date>(`SELECT CASE WHEN user_lo = $1 THEN lo_at ELSE hi_at END FROM blocks WHERE user_lo = least($1::bigint, $2::bigint) AND user_hi = greatest($1::bigint, $2::bigint)`, [a, b]);
      expect(after.getTime()).toBe(before.getTime());
      // Unblocking removes only one's own bit; the pair stays apart through its match row.
      expect(await one(() => unblockUser(pg, a, b))).toBe(true);
      expect(Number(await value(`SELECT blocked_by FROM blocks WHERE user_lo = least($1::bigint, $2::bigint)`, [a, b]))).toBe(side === 1 ? 2 : 1);
      expect(await unblockUser(pg, a, b)).toBe(false);
      expect(await unblockUser(pg, b, a)).toBe(true);
      expect(await value<string>(`SELECT count(*)::text FROM blocks WHERE user_lo = least($1::bigint, $2::bigint) AND user_hi = greatest($1::bigint, $2::bigint)`, [a, b])).toBe('0');
      expect(await matchState(m)).toBe(3);
    });

    it('refuses the caller, unknown and purged people without writing anything', async () => {
      const a = await person();
      const purged = await person({ status: 8 });
      expect(await blockUser(pg, a, a)).toEqual({ found: false });
      expect(await blockUser(pg, a, ids.nextId())).toEqual({ found: false });
      expect(await blockUser(pg, a, purged)).toEqual({ found: false });
      expect(await value<string>(`SELECT count(*)::text FROM blocks WHERE user_lo = $1 OR user_hi = $1`, [a])).toBe('0');
    });

    it('lists only the people this account blocked, newest first, paged, every state but deleted', async () => {
      const me = await person({ name: 'Me' });
      const people: string[] = [];
      for (const state of [3, 4, 5, 6, 3]) people.push(await person({ status: state, name: `P${people.length}` }));
      const shadow = await person({ name: 'Shade' });
      await db.admin.query(`UPDATE users SET is_shadowbanned = true WHERE id = $1`, [shadow]);
      const gone = await person({ name: 'Gone' });
      const blockedMe = await person({ name: 'Other' });
      for (const p of [...people, shadow, gone]) {
        await blockUser(pg, me, p);
        await new Promise((resolve) => setTimeout(resolve, 3));
      }
      await blockUser(pg, blockedMe, me);
      await db.admin.query(`UPDATE users SET status = 7, deleted_at = now() WHERE id = $1`, [gone]);

      const all = await one(() => blockedPeople(pg, me, 50));
      expect(all.map((p) => p.userId)).toEqual([shadow, ...[...people].reverse()]);
      expect(all.find((p) => p.userId === shadow)?.name).toBe('Shade');
      const page = await blockedPeople(pg, me, 3);
      expect(page).toHaveLength(4);
      const rest = await blockedPeople(pg, me, 10, { atUs: page[2]!.atUs, userId: page[2]!.userId });
      expect([...page.slice(0, 3), ...rest].map((p) => p.userId)).toEqual(all.map((p) => p.userId));
    });
  });

  describe('reports', () => {
    it('files a profile report with a snapshot of the profile, complete at once', async () => {
      const reporter = await person({ name: 'Rita' });
      const target = await person({ name: 'Tom' });
      const reportId = ids.nextId();
      const out = await one(() => fileReport(pg, { reportId, reporterId: reporter, targetId: target, context: 1, reason: 1, details: 'Not a real person' }));
      expect(out).toEqual({ outcome: 'filed', reportId, merged: false, block: null, holds: 0 });
      const { rows } = await db.admin.query<{ evidence: { v: number; items: Record<string, unknown>[] }; evidence_at: Date | null; priority: number; status: number }>(
        `SELECT evidence, evidence_at, priority, status FROM reports WHERE id = $1`,
        [reportId],
      );
      expect(rows[0]!.status).toBe(1);
      expect(rows[0]!.evidence_at).not.toBeNull();
      expect(rows[0]!.priority).toBe(40);
      expect(rows[0]!.evidence.items).toHaveLength(1);
      expect(rows[0]!.evidence.items[0]).toMatchObject({ reportId, context: 1, reason: 1, details: 'Not a real person', profile: { name: 'Tom', about: 'About me' } });
    });

    it('adds a second report of the same person to the open one; the more urgent reason wins; chat evidence waits for its job', async () => {
      const reporter = await person();
      const target = await person();
      const conversation = await match(reporter, target);
      const first = ids.nextId();
      await fileReport(pg, { reportId: first, reporterId: reporter, targetId: target, context: 1, reason: 7 });
      const second = await fileReport(pg, {
        reportId: ids.nextId(),
        reporterId: reporter,
        targetId: target,
        context: 2,
        reason: 2,
        conversationId: conversation,
        messageIds: ['1287390234923417600', '1287390234923417601'],
      });
      expect(second).toMatchObject({ outcome: 'filed', reportId: first, merged: true });
      const { rows } = await db.admin.query<{ reason: number; match_id: string; evidence_at: Date | null; items: number; ids: string[] }>(
        `SELECT reason, match_id::text, evidence_at, jsonb_array_length(evidence -> 'items') AS items,
                ARRAY(SELECT jsonb_array_elements_text(evidence -> 'items' -> 1 -> 'messageIds')) AS ids
           FROM reports WHERE id = $1`,
        [first],
      );
      expect(rows[0]).toMatchObject({ reason: 2, match_id: conversation, evidence_at: null, items: 2, ids: ['1287390234923417600', '1287390234923417601'] });
      expect(await value<string>(`SELECT count(*)::text FROM reports WHERE target_id = $1`, [target])).toBe('1');
    });

    it('refuses what is not the reported person’s: themselves, nobody, another conversation, another’s photo, another pair’s call', async () => {
      const reporter = await person();
      const target = await person();
      const other = await person();
      const theirs = await match(target, other);
      const photo = ids.nextId();
      await db.admin.query(`INSERT INTO photos (id, user_id, position, status, width, height, blob_ver) VALUES ($1, $2, 0, 3, 10, 10, 1)`, [photo, other]);
      const call = ids.nextId();
      await db.admin.query(
        `INSERT INTO calls (id, match_id, caller_id, callee_id, ended_at, kind, outcome, ended_by, end_reason) VALUES ($1, $2, $3, $4, now(), 1, 4, 3, 4)`,
        [call, theirs, target, other],
      );
      const base = { reporterId: reporter, targetId: target, reason: 2 };
      expect(await fileReport(pg, { ...base, reportId: ids.nextId(), targetId: reporter, context: 1 })).toEqual({ outcome: 'not_found' });
      expect(await fileReport(pg, { ...base, reportId: ids.nextId(), targetId: ids.nextId(), context: 1 })).toEqual({ outcome: 'not_found' });
      expect(await fileReport(pg, { ...base, reportId: ids.nextId(), context: 2, conversationId: theirs })).toEqual({ outcome: 'not_found' });
      expect(await fileReport(pg, { ...base, reportId: ids.nextId(), context: 3, photoId: photo })).toEqual({ outcome: 'not_found' });
      expect(await fileReport(pg, { ...base, reportId: ids.nextId(), context: 4, callId: call })).toEqual({ outcome: 'not_found' });
      expect(await value<string>(`SELECT count(*)::text FROM reports WHERE reporter_id = $1`, [reporter])).toBe('0');
      // The target's own photo and a call that is still live (no row yet) are taken.
      const own = ids.nextId();
      await db.admin.query(`INSERT INTO photos (id, user_id, position, status, width, height, blob_ver) VALUES ($1, $2, 0, 3, 10, 10, 2)`, [own, target]);
      const photoReport = await fileReport(pg, { ...base, reportId: ids.nextId(), context: 3, photoId: own });
      expect(photoReport.outcome).toBe('filed');
      const live = await fileReport(pg, { ...base, reportId: ids.nextId(), context: 4, callId: ids.nextId() });
      expect(live).toMatchObject({ outcome: 'filed', merged: true });
      const items = await value<{ photo?: { id: string; blobVer: number }; callId?: string }[]>(`SELECT evidence -> 'items' FROM reports WHERE reporter_id = $1`, [reporter]);
      expect(items[0]!.photo).toMatchObject({ id: own, blobVer: 2 });
      expect(items[1]!.callId).toBeDefined();
    });

    it('raises the priority of every open report on a person with each further reporter and with earlier actioned reports', async () => {
      const target = await person();
      const reports: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const id = ids.nextId();
        reports.push(id);
        await fileReport(pg, { reportId: id, reporterId: await person(), targetId: target, context: 1, reason: 1 });
      }
      const priorities = async () => (await db.admin.query<{ p: number }>(`SELECT priority AS p FROM reports WHERE id = ANY ($1::bigint[]) ORDER BY id`, [reports])).rows.map((r) => r.p);
      expect(await priorities()).toEqual([50, 50, 50]);
      await setReportStatus(pg, reports[0]!, 3);
      await fileReport(pg, { reportId: ids.nextId(), reporterId: await person(), targetId: target, context: 1, reason: 1 });
      // Three open reporters (+10) and one actioned report (+5).
      expect((await priorities()).slice(1)).toEqual([55, 55]);
    });

    it('puts a child-safety report’s person and conversation under a legal hold at once, once per report', async () => {
      const reporter = await person();
      const target = await person();
      const m = await match(reporter, target);
      const reportId = ids.nextId();
      const out = await fileReport(pg, { reportId, reporterId: reporter, targetId: target, context: 2, reason: 8, conversationId: m, block: true });
      expect(out).toMatchObject({ outcome: 'filed', holds: 2, block: { found: true, endedNow: true, match: { matchId: m, state: 3 } } });
      expect(Number(await value(`SELECT priority FROM reports WHERE id = $1`, [reportId]))).toBe(100);
      const holds = (await db.admin.query<{ user_id: string | null; match_id: string | null; kind: number; created_by: number | null }>(
        `SELECT user_id::text, match_id::text, kind, created_by FROM legal_holds WHERE report_id = $1 ORDER BY id`,
        [reportId],
      )).rows;
      expect(holds).toEqual([
        { user_id: target, match_id: null, kind: 1, created_by: null },
        { user_id: null, match_id: m, kind: 1, created_by: null },
      ]);
      const again = await fileReport(pg, { reportId: ids.nextId(), reporterId: reporter, targetId: target, context: 1, reason: 8 });
      expect(again).toMatchObject({ outcome: 'filed', reportId, merged: true, holds: 0 });
      expect(await matchState(m)).toBe(3);
    });
  });

  describe('moderation actions', () => {
    async function apply(userId: string, kind: 1 | 2 | 3 | 4, endsAt?: Date) {
      return one(() => applyModeration(pg, { actionId: ids.nextId(), userId, kind, reasonCode: 2, reasonText: `Reason ${kind}`, endsAt }));
    }

    it('writes a warning without changing the account; the person reads it with its reason', async () => {
      const u = await person();
      const out = await apply(u, 1);
      expect(out).toMatchObject({ outcome: 'applied', kind: 1, before: { status: 3 }, after: { status: 3, shadowbanned: false }, ended: [], action: { kind: 1, reasonText: 'Reason 1' } });
      expect((await ownModeration(pg, u)).map((a) => a.kind)).toEqual([1]);
    });

    it('bans: status 6, every active conversation ends for good, pending requests are withdrawn; a lift returns the status it began from', async () => {
      const u = await person({ status: 4 });
      const peers = [await person(), await person()];
      const ms = [await match(u, peers[0]!), await match(u, peers[1]!)];
      const request = ids.nextId();
      const other = await person();
      await db.admin.query(`INSERT INTO message_requests (id, from_id, to_id, body) VALUES ($1, $2, $3, 'hello')`, [request, u, other]);
      const ban = await apply(u, 3);
      if (ban.outcome !== 'applied') throw new Error('not applied');
      expect(ban.before).toEqual({ status: 4, shadowbanned: false });
      expect(ban.after).toEqual({ status: 6, shadowbanned: false });
      expect(ban.ended.map((e) => e.matchId).sort()).toEqual([...ms].sort());
      expect(ban.ended.map((e) => e.peerId).sort()).toEqual([...peers].sort());
      expect(ban.peers).toEqual([]);
      for (const m of ms) expect(await matchState(m)).toBe(4);
      expect(Number(await value(`SELECT status FROM message_requests WHERE id = $1`, [request]))).toBe(5);
      expect(Number(await value(`SELECT prior_status FROM moderation_actions WHERE id = $1`, [ban.actionId]))).toBe(4);
      // The account view names the ban with its reason.
      const view = await accountView(pg, u);
      if (view.kind !== 'account') throw new Error('no account view');
      expect(view.view.moderation.map((a) => a.id)).toEqual([ban.actionId]);

      const lifted = await one(() => revokeModeration(pg, ban.actionId, ids.nextId(), { reasonText: 'Reviewed again.' }));
      expect(lifted).toMatchObject({ outcome: 'revoked', already: false, kind: 3, before: { status: 6 }, after: { status: 4 } });
      for (const m of ms) expect(await matchState(m)).toBe(4);
      expect(Number(await value(`SELECT count(*) FROM moderation_actions WHERE user_id = $1 AND kind = 5`, [u]))).toBe(1);
      expect(await revokeModeration(pg, ban.actionId, ids.nextId())).toMatchObject({ outcome: 'revoked', already: true, after: { status: 4 } });
    });

    it('unwinds overlapping penalties in any order: a ban over a suspension, the ban lifted, then the suspension ends', async () => {
      const u = await person();
      const peer = await person();
      const m = await match(u, peer);
      const suspension = await apply(u, 2, new Date(Date.now() + 3_600_000));
      expect(suspension).toMatchObject({ after: { status: 5 }, ended: [], peers: [peer] });
      expect(await matchState(m)).toBe(1);
      const ban = await apply(u, 3);
      if (ban.outcome !== 'applied' || suspension.outcome !== 'applied') throw new Error('not applied');
      expect(ban.after.status).toBe(6);
      expect(await revokeModeration(pg, ban.actionId, ids.nextId())).toMatchObject({ after: { status: 5 } });
      // The suspension's period ends: settle brings back the status it began from.
      await db.admin.query(`UPDATE moderation_actions SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 second' WHERE id = $1`, [suspension.actionId]);
      expect(await one(() => dueModeration(pg, 100))).toContainEqual(expect.objectContaining({ actionId: suspension.actionId, userId: u }));
      const settled = await one(() => settleModeration(pg, u));
      expect(settled).toMatchObject({ outcome: 'settled', before: { status: 5 }, after: { status: 3 }, peers: [] });
      expect(await settleModeration(pg, u)).toMatchObject({ before: { status: 3 }, after: { status: 3 } });
      expect((await dueModeration(pg, 100)).some((d) => d.userId === u)).toBe(false);
    });

    it('shadowbans silently and lifts it; a person in onboarding can be banned and returns to onboarding', async () => {
      const u = await person();
      const shadow = await apply(u, 4);
      expect(shadow).toMatchObject({ after: { status: 3, shadowbanned: true }, action: null });
      expect(await status(u)).toEqual({ status: 3, shadowbanned: true });
      expect(await ownModeration(pg, u)).toEqual([]);
      if (shadow.outcome !== 'applied') throw new Error('not applied');
      expect(await revokeModeration(pg, shadow.actionId, ids.nextId())).toMatchObject({ after: { status: 3, shadowbanned: false } });
      expect(await status(u)).toEqual({ status: 3, shadowbanned: false });

      const newcomer = await person({ status: 1, name: null, basics: false });
      const ban = await apply(newcomer, 3);
      if (ban.outcome !== 'applied') throw new Error('not applied');
      expect(ban.after.status).toBe(6);
      expect(await revokeModeration(pg, ban.actionId, ids.nextId())).toMatchObject({ after: { status: 1 } });
    });

    it('keeps a deleted account deleted; a restore applies the ban that stands; a purged account is missing', async () => {
      const u = await person();
      await db.admin.query(`UPDATE users SET status = 7, deleted_at = now(), restore_status = 3 WHERE id = $1`, [u]);
      const ban = await apply(u, 3);
      expect(ban).toMatchObject({ before: { status: 7 }, after: { status: 7 } });
      expect(await restoreAccount(pg, u)).toMatchObject({ kind: 'restored', status: 6 });
      const purged = await person({ status: 8 });
      expect(await applyModeration(pg, { actionId: ids.nextId(), userId: purged, kind: 3, reasonCode: 1, reasonText: 'x' })).toEqual({ outcome: 'missing' });
      expect(await applyModeration(pg, { actionId: ids.nextId(), userId: ids.nextId(), kind: 1, reasonCode: 1, reasonText: 'x' })).toEqual({ outcome: 'missing' });
    });

    it('decides appeals: upheld keeps the action, overturned lifts it in the same statement, a second decision is refused', async () => {
      const u = await person();
      const first = await apply(u, 2, new Date(Date.now() + 86_400_000));
      if (first.outcome !== 'applied') throw new Error('not applied');
      const appeal = ids.nextId();
      expect(await fileAppeal(pg, u, first.actionId, appeal, 'It was not me.')).toEqual({ kind: 'filed', appealId: appeal });
      const upheld = await one(() => decideAppeal(pg, appeal, false, ids.nextId(), { text: 'The reports stand.' }));
      expect(upheld).toMatchObject({ outcome: 'upheld', appealId: appeal, actionId: first.actionId, userId: u, action: { appeal: { status: 2, decisionText: 'The reports stand.' } } });
      expect(await status(u)).toEqual({ status: 5, shadowbanned: false });
      expect(await decideAppeal(pg, appeal, true, ids.nextId())).toEqual({ outcome: 'decided' });

      const ban = await apply(u, 3);
      if (ban.outcome !== 'applied') throw new Error('not applied');
      const second = ids.nextId();
      await fileAppeal(pg, u, ban.actionId, second, 'Please look again.');
      const overturned = await one(() => decideAppeal(pg, second, true, ids.nextId(), { text: 'We got it wrong.' }));
      expect(overturned).toMatchObject({ outcome: 'overturned', before: { status: 6 }, after: { status: 5 }, action: { appeal: { status: 3 } } });
      expect(await decideAppeal(pg, ids.nextId(), true, ids.nextId())).toEqual({ outcome: 'missing' });
    });
  });

  describe('the safety queue', () => {
    it('settles an account whose suspension ended, tells the person once (retries publish under the same ids), and does nothing when already settled', async () => {
      const u = await person();
      const peer = await person();
      await match(u, peer);
      const suspension = await applyModeration(pg, { actionId: ids.nextId(), userId: u, kind: 2, reasonCode: 2, reasonText: 'Cool down.', endsAt: new Date(Date.now() + 60_000) });
      if (suspension.outcome !== 'applied') throw new Error('not applied');
      await db.admin.query(`UPDATE moderation_actions SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 second' WHERE id = $1`, [suspension.actionId]);
      await redis.hset(keys.conversationListChecked(peer), u, `${Date.now()}:0`);
      const job = fakeJob<ModerationEndData>('moderation-end', { actionId: suspension.actionId, userId: u });
      const { result, tally } = await statementCounter.measure(() => moderationEndJob(job, context));
      expect(result).toEqual({ outcome: 'settled', changed: true, published: 1 });
      expect(tally.statements).toBe(1);
      expect(await status(u)).toEqual({ status: 3, shadowbanned: false });
      const events = realtime.on(userChannel(publicIds.user.encode(u)));
      expect(events.map((e) => [e.t, (e.d as { status: string }).status])).toEqual([['account', 'active']]);
      expect(job.data.eventIds?.['account']).toBe(events[0]!.id);
      // The peer's list checks the person again on its next read.
      expect(await redis.exists(keys.conversationListChecked(peer))).toBe(0);
      expect(await moderationEndJob(job, context)).toEqual({ outcome: 'settled', changed: false, published: 0 });
      expect(realtime.on(userChannel(publicIds.user.encode(u)))).toHaveLength(1);
    });

    it('queues the end of a period whose job was lost, once per lease', async () => {
      const u = await person();
      const out = await applyModeration(pg, { actionId: ids.nextId(), userId: u, kind: 2, reasonCode: 2, reasonText: 'Cool down.', endsAt: new Date(Date.now() + 60_000) });
      if (out.outcome !== 'applied') throw new Error('not applied');
      await db.admin.query(`UPDATE moderation_actions SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 second' WHERE id = $1`, [out.actionId]);
      const swept = await moderationSweepJob(context);
      expect(swept.leased).toBe(true);
      expect(swept.queued).toBeGreaterThanOrEqual(1);
      expect(await moderationSweepJob(context)).toEqual({ leased: false, queued: 0 });
      const queue = new Queue('safety', { connection: redis, prefix: queuePrefix(prefix) });
      try {
        const job = await queue.getJob(safetyJobIds.moderationEnd(out.actionId));
        expect(job?.data).toEqual({ actionId: out.actionId, userId: u });
      } finally {
        await queue.close();
      }
    });

    it('drops a blocked pair from each other’s deck queue again after a refill that was running', async () => {
      const a = ids.nextId();
      const b = ids.nextId();
      await redis.rpush(keys.deckQueue(a), b, ids.nextId());
      await redis.rpush(keys.deckQueue(b), a);
      await redis.set(keys.deckLock(a), 'x', 'PX', 30_000);
      const out = await blockDeckJob(fakeJob('block-deck', { a, b }), context);
      expect(out.refilling).toBe(true);
      expect(await redis.lrange(keys.deckQueue(a), 0, -1)).not.toContain(b);
      expect(await redis.lrange(keys.deckQueue(b), 0, -1)).toEqual([]);
    });
  });
});
