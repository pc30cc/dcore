import { randomUUID } from 'node:crypto';
import { createPool, runMigrations } from '@app/db';
import { messagesPageSchema, sentMessageSchema, userChannel, type Message } from '@app/shared';
import { chatKeys, FakePresence, FakeRealtimePublisher, readWatermark } from '@app/shared/server';
import { reportEvidenceJob, reportFileJob } from '@app/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WRITE_LAG_HEADER } from '../src/routes/chat.js';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, MIGRATIONS, seedUser, startHarness, statements, type Harness, type SeededUser, type TestDatabase } from './accountSupport.js';
import { fakeJob, matchOf, startChatPipeline, until, type ChatPipeline } from './chatSupport.js';
import { PG_BIN, startPgServer, type PgServer } from './pgServer.js';
import { hasInfrastructure } from './support.js';

/**
 * PostgreSQL stopped for two minutes, for real (a server of this suite's
 * own, stopped with `pg_ctl stop -m fast` and started again):
 *
 * - every send answers 201 and reaches the other person in realtime;
 * - the `wb:msg` writer waits the outage out (nothing dead-lettered, its
 *   entries pending), and after the restart the stream drains with no loss
 *   and no duplicate;
 * - history reads report the write-behind lag (`X-Write-Lag-Ms`), and a
 *   client that reconnected during the outage and follows `syncCursor` gets
 *   every message;
 * - a report filed during the outage is accepted, filed once PostgreSQL is
 *   back, and its evidence holds the messages sent just before it.
 */

const OUTAGE_MS = Number(process.env['CHAT_OUTAGE_MS'] ?? 120_000);

describe.skipIf(!hasInfrastructure || !PG_BIN)('chat while PostgreSQL is stopped for two minutes', () => {
  let server: PgServer;
  let db: TestDatabase;
  let h: Harness;
  let realtime: FakeRealtimePublisher;
  let jobs: MemoryJobProducer;
  let pipeline: ChatPipeline;

  beforeAll(async () => {
    server = await startPgServer();
    const admin = createPool({ connectionString: server.url, applicationName: 'outage-admin', max: 1 });
    await admin.query('CREATE DATABASE outage');
    await admin.end();
    const url = server.urlOf('outage');
    const seedPool = createPool({ connectionString: url, applicationName: 'outage-seed', max: 1 });
    await seedPool.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await seedPool.end();
    await runMigrations({ connectionString: url, directory: MIGRATIONS, log: { info: () => undefined, warn: () => undefined } });
    const sql = createPool({ connectionString: url, applicationName: 'outage-test', max: 3, connectTimeoutMs: 1_000 });
    sql.on('error', () => undefined);
    db = {
      url,
      sql,
      async drop() {
        await sql.end().catch(() => undefined);
      },
    };
    realtime = new FakeRealtimePublisher();
    jobs = new MemoryJobProducer();
    h = await startHarness(db, { DATABASE_CONNECT_TIMEOUT_MS: '500' }, { realtime, jobs, chat: { presence: new FakePresence() } });
    h.app.pg.on('error', () => undefined);
    pipeline = await startChatPipeline(h, realtime, { databaseUrl: url });
    pipeline.pool.on('error', () => undefined);
  }, 120_000);

  afterAll(async () => {
    await pipeline?.stop();
    await h?.close();
    await db?.drop();
    await server?.destroy();
  });

  function send(user: SeededUser, conversationId: string, body: string, clientId = randomUUID()) {
    return call(h, `/v1/conversations/${conversationId}/messages`, { method: 'POST', token: user.token, body: { clientId, kind: 'text', body } });
  }

  async function count(text: string, values: unknown[]): Promise<number> {
    return Number(((await db.sql.query(text, values)).rows[0] as { n: string }).n);
  }

  it(
    'keeps chat working, loses nothing and repeats nothing, and reports carry their evidence',
    async () => {
      const a = await seedUser(h, { name: 'Ava' });
      const b = await seedUser(h, { name: 'Ben' });
      const m = await matchOf(h, a.id, b.id);
      const id = m.id;
      // Everyone warm, as on any day: the conversation's state, both accounts' views and plans.
      const before = sentMessageSchema.parse((await send(a, id, 'before the outage')).json()).message;
      const still = sentMessageSchema.parse((await send(b, id, 'still before')).json()).message;
      await call(h, '/v1/conversations', { token: a.token });
      await call(h, '/v1/conversations', { token: b.token });
      await until(async () => (await count(`SELECT count(*)::text AS n FROM messages WHERE match_id = $1`, [id])) === 2);
      // Ben's phone reads the thread and keeps its sync cursor.
      const kept = messagesPageSchema.parse((await call(h, `/v1/conversations/${id}/messages`, { token: b.token })).json());
      const cursor = kept.syncCursor;

      // ─── The outage ────────────────────────────────────────────────────
      const stoppedAt = Date.now();
      await server.stop();
      const sent: Message[] = [];
      const steps = 6;
      for (let step = 0; step < steps; step += 1) {
        for (const [who, text] of [
          [a, `outage ${step} from Ava`],
          [b, `outage ${step} from Ben`],
        ] as const) {
          const clientId = randomUUID();
          const answer = await send(who, id, text, clientId);
          expect(answer.statusCode, answer.body).toBe(201);
          expect(statements(answer)).toBe(0);
          const message = sentMessageSchema.parse(answer.json()).message;
          sent.push(message);
          // The other person has it at once, over realtime.
          const peer = who === a ? b : a;
          expect(realtime.on(userChannel(peer.publicUid)).some((e) => e.t === 'message' && e.id === message.id)).toBe(true);
          // The outbox resends one of them: the same message.
          if (step === 2) {
            const retry = await send(who, id, text, clientId);
            expect(retry.statusCode).toBe(200);
            expect(sentMessageSchema.parse(retry.json()).message.id).toBe(message.id);
          }
        }
        // Receipts work too (Valkey only).
        const read = await call(h, `/v1/conversations/${id}/receipts`, { method: 'POST', token: b.token, body: { readUpTo: sent.at(-2)!.id } });
        expect([204, 429]).toContain(read.statusCode);
        if (step === steps - 2) {
          // Ben reports Ava from the chat: accepted now, filed when the database is back.
          const report = await call(h, '/v1/reports', { method: 'POST', token: b.token, body: { target: a.publicUid, context: 'chat', reason: 'harassment', conversationId: id } });
          expect(report.statusCode, report.body).toBe(202);
        }
        // A phone that lost its socket tries to catch up: the database is down, so it is told to come back.
        if (step === 1) {
          const down = await call(h, `/v1/conversations/${id}/messages?after=${cursor}`, { token: b.token });
          expect(down.statusCode).toBe(503);
        }
        const target = stoppedAt + ((step + 1) * OUTAGE_MS) / steps - 2_000;
        while (Date.now() < target) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const reportedAfter = sent.filter((x) => BigInt(x.id) < BigInt(String(jobs.jobs.find((j) => j.name === 'report-file')!.data['filingId'])));
      expect(reportedAfter.length).toBeGreaterThan(0);
      // Nothing is written meanwhile, nothing is given up: the entries wait in the stream.
      expect(await h.redis.xlen(h.app.keys.stream('msg'))).toBeGreaterThanOrEqual(sent.length);
      expect(await h.redis.xlen(h.app.keys.streamDead('msg'))).toBe(0);
      const frozen = await readWatermark(h.redis, h.app.keys, 'msg');
      expect(frozen !== null && frozen < BigInt(sent[0]!.id)).toBe(true);
      expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(OUTAGE_MS - 3_000);

      // ─── PostgreSQL is back ────────────────────────────────────────────
      // The writer is held for a moment, so the lag shows in a read made before it drains.
      await pipeline.pause();
      await server.start();
      const early = await call(h, `/v1/conversations/${id}/messages?after=${cursor}`, { token: b.token });
      expect(early.statusCode, early.body).toBe(200);
      expect(Number(early.headers[WRITE_LAG_HEADER])).toBeGreaterThanOrEqual(OUTAGE_MS - 10_000);
      const earlyPage = messagesPageSchema.parse(early.json());
      // Not durable yet: the cursor stays below the outage's messages.
      expect(BigInt(earlyPage.syncCursor) < BigInt(sent[0]!.id)).toBe(true);
      pipeline.resume();
      await until(async () => (await count(`SELECT count(*)::text AS n FROM messages WHERE match_id = $1`, [id])) === 2 + sent.length, 30_000);
      await until(async () => (await h.redis.xlen(h.app.keys.stream('msg'))) === 0, 15_000);
      // No loss, no duplicate: exactly the messages sent, each once.
      const stored = (await db.sql.query(`SELECT id::text AS id, body FROM messages WHERE match_id = $1 ORDER BY id`, [id])).rows as { id: string; body: string }[];
      const expected = [before.id, still.id, ...sent.map((x) => x.id)].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1));
      expect(stored.map((r) => r.id)).toEqual(expected);
      expect(new Set(stored.map((r) => r.id)).size).toBe(stored.length);
      expect(await h.redis.xlen(h.app.keys.streamDead('msg'))).toBe(0);

      // The phone follows its sync cursor: every message of the outage, in order.
      await until(async () => {
        const wm = await readWatermark(h.redis, h.app.keys, 'msg');
        return wm !== null && wm > BigInt(sent.at(-1)!.id);
      }, 20_000);
      let after = cursor;
      const got = new Map<string, string>();
      for (let i = 0; i < 5; i += 1) {
        const page = await call(h, `/v1/conversations/${id}/messages?after=${after}`, { token: b.token });
        expect(page.headers[WRITE_LAG_HEADER]).toBeDefined();
        const body = messagesPageSchema.parse(page.json());
        for (const item of body.items) got.set(item.id, item.body ?? '');
        after = body.syncCursor;
        if (!body.hasMore) break;
      }
      for (const message of sent) expect(got.get(message.id)).toBe(message.body);
      expect(BigInt(after) >= BigInt(sent.at(-1)!.id)).toBe(true);

      // ─── The report filed during the outage ────────────────────────────
      const deferred = jobs.jobs.find((j) => j.queue === 'safety' && j.name === 'report-file')!;
      const filed = await reportFileJob(fakeJob('report-file', deferred.data), pipeline.context);
      expect(filed.outcome).toBe('filed');
      const reportId = filed.reportId!;
      const evidence = await reportEvidenceJob(
        fakeJob('report-evidence', {
          reportId,
          filingId: String(deferred.data['filingId']),
          reporterId: b.id,
          targetId: a.id,
          conversationId: id,
          messageIds: [],
          queuedAtMs: Number(deferred.data['queuedAtMs']),
        }),
        pipeline.context,
      );
      expect(evidence.outcome).toBe('copied');
      const report = (await db.sql.query(`SELECT target_id::text AS target, reporter_id::text AS reporter, context, evidence FROM reports WHERE id = $1`, [reportId])).rows[0] as {
        target: string;
        reporter: string;
        context: number;
        evidence: { chat: { messages: { id: string; body: string }[] }[] };
      };
      expect(report).toMatchObject({ target: a.id, reporter: b.id, context: 2 });
      const copied = report.evidence.chat[0]!.messages.map((x) => x.id);
      // The messages sent just before it, the outage's included, and nothing after it.
      for (const message of reportedAfter) expect(copied).toContain(message.id);
      expect(copied.every((x) => BigInt(x) < BigInt(String(deferred.data['filingId'])))).toBe(true);
      // Ava's unread count kept counting through the outage: Ben's message before it and his six during it.
      expect(await h.redis.hget(chatKeys(h.app.keys).unread(a.id), id)).toBe(String(1 + steps));
    },
    OUTAGE_MS + 180_000,
  );
});
