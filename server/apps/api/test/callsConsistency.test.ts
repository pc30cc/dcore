import { randomUUID } from 'node:crypto';
import { callBodySchema, messagesPageSchema, type Call, type Message } from '@app/shared';
import { CALL_RING_MS, FakeRealtimePublisher, callKeys, chatKeys } from '@app/shared/server';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, migratedDatabase, rows, seedUser, startHarness, statements, type Harness, type SeededUser, type TestDatabase } from './accountSupport.js';
import { FakeLiveKit, LIVEKIT_ENV, TestClock, eventsOf, startCallWorker, type CallWorker } from './callsSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * Calls against the failures around them: PostgreSQL away while the ring
 * and the finalize run, a finalize that runs long after its conversation
 * ended, and what a placement reads and leaves of the conversation's cached
 * state.
 */

describe.skipIf(!hasInfrastructure)('calls consistency (PostgreSQL, Valkey)', () => {
  let db: TestDatabase;
  let h: Harness;
  let worker: CallWorker;
  const jobs = new MemoryJobProducer();
  const realtime = new FakeRealtimePublisher();
  const livekit = new FakeLiveKit();
  const clock = new TestClock();

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startHarness(db, { ...LIVEKIT_ENV }, { jobs, realtime, calls: { livekit: livekit.client(), now: clock.now, random: () => 0.5 } });
    worker = await startCallWorker(h, realtime, jobs, livekit, clock);
  }, 90_000);
  afterAll(async () => {
    await worker?.stop();
    await h?.close();
    await db?.drop();
  });

  let tokens = 0;
  async function pushToken(user: SeededUser): Promise<string> {
    tokens += 1;
    const token = `fcm-token-${tokens}-${user.id.slice(-4)}`;
    await db.sql.query(`UPDATE devices SET push_token = $2, push_token_hash = sha256(convert_to($2, 'UTF8')) WHERE id = $1`, [user.deviceId, token]);
    return token;
  }

  async function pair(names: [string, string]): Promise<{ a: SeededUser; b: SeededUser; matchId: string; lo: string }> {
    const a = await seedUser(h, { name: names[0] });
    const b = await seedUser(h, { name: names[1] });
    const matchId = h.app.ids.nextId();
    const [lo, hi] = BigInt(a.id) < BigInt(b.id) ? [a.id, b.id] : [b.id, a.id];
    await db.sql.query(`INSERT INTO matches (id, user_lo, user_hi, source, flags) VALUES ($1, $2, $3, 1, 3)`, [matchId, lo, hi]);
    await pushToken(a);
    await pushToken(b);
    return { a, b, matchId, lo };
  }

  const post = (url: string, token: string, body?: unknown): Promise<LightMyRequestResponse> =>
    call(h, url, { method: 'POST', token, ...(body === undefined ? {} : { body }) });
  const place = (caller: SeededUser, matchId: string) => post('/v1/calls', caller.token, { conversationId: matchId, kind: 'audio' });
  const callOf = (response: LightMyRequestResponse): Call => callBodySchema.parse(response.json()).call;

  /** The worker's next `count` queries fail as with PostgreSQL gone (then it is back). */
  function refuseQueries(count: number, marker?: string): { refused: () => number; restore: () => void } {
    const pool = worker.pool as unknown as { query: (...args: unknown[]) => Promise<unknown> };
    const query = pool.query;
    let refused = 0;
    pool.query = async (...args: unknown[]) => {
      const text = (args[0] as { text?: unknown } | string | undefined);
      const sql = typeof text === 'string' ? text : typeof text?.text === 'string' ? text.text : '';
      if (refused < count && (marker === undefined || sql.includes(marker))) {
        refused += 1;
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
      }
      return query.apply(pool, args);
    };
    return { refused: () => refused, restore: () => (pool.query = query) };
  }

  /** Every `connect` of the worker's pool fails `count` times (a transaction cannot begin). */
  function refuseConnects(count: number): () => void {
    const connect = worker.pool.connect;
    let left = count;
    worker.pool.connect = (async (...args: unknown[]) => {
      if (left > 0) {
        left -= 1;
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
      }
      return (connect as (...a: unknown[]) => Promise<unknown>).apply(worker.pool, args);
    }) as typeof connect;
    return () => (worker.pool.connect = connect);
  }

  it('rings the callee on the retry when the first try could not read their devices', async () => {
    const { a, b, matchId } = await pair(['Ring', 'Retry']);
    const placed = await place(a, matchId);
    expect(placed.statusCode, placed.body).toBe(201);
    const id = callOf(placed).id;
    const [job] = worker.pending('ring-push', id);
    expect(job).toBeDefined();
    const refusal = refuseQueries(1, 'FROM devices d');
    try {
      await expect(worker.run(job!)).rejects.toThrow('ECONNREFUSED');
    } finally {
      refusal.restore();
    }
    expect(refusal.refused()).toBe(1);
    // BullMQ's retry, half a second later and well inside the ring: the phone rings.
    const retry = await worker.run(job!, { attemptsMade: 1 });
    expect(retry.result).toEqual({ outcome: 'rung', devices: 1 });
    expect(worker.push.sent.filter((s) => s.payload.type === 'call_incoming' && s.payload.data['callId'] === id)).toHaveLength(1);
    await post(`/v1/calls/${id}/cancel`, a.token);
    void b;
  });

  it('waits out a PostgreSQL outage longer than all its attempts, then writes the call once and tells both', async () => {
    const { a, b, matchId } = await pair(['Long', 'Outage']);
    const id = callOf(await place(a, matchId)).id;
    clock.advance(CALL_RING_MS + 1);
    await worker.runAll('ring', id);
    const [job] = worker.pending('finalize', id);
    expect(job).toBeDefined();
    const attempts = job!.options.attempts ?? 0;
    expect(attempts).toBeGreaterThan(0);
    // More tries than the job has attempts, each refused: every one waits, none fails the job.
    const restore = refuseConnects(attempts + 2);
    try {
      for (let i = 0; i < attempts + 2; i += 1) expect((await worker.run(job!)).delayed).toBe(true);
    } finally {
      restore();
    }
    expect(await rows(db, `SELECT 1 FROM calls WHERE id = $1`, [id])).toEqual([]);
    // Back: the rows go in once, then the line and the missed-call push; PostgreSQL away for the push waits too.
    const refusal = refuseQueries(1, 'FROM devices d');
    try {
      expect((await worker.run(job!, { attemptsMade: 1 })).delayed).toBe(true);
    } finally {
      refusal.restore();
    }
    expect(await rows(db, `SELECT 1 FROM calls WHERE id = $1`, [id])).toHaveLength(1);
    expect((await worker.run(job!, { attemptsMade: 1 })).result).toEqual({ outcome: 'finalized', rows: true, replay: false });
    expect(await rows(db, `SELECT 1 FROM messages WHERE match_id = $1 AND kind = 5 AND ref_id = $2`, [matchId, id])).toHaveLength(1);
    expect(eventsOf(realtime, b.publicUid, 'message').filter((e) => (e.d as { refId?: string }).refId === id)).toHaveLength(1);
    expect(worker.push.sent.filter((s) => s.payload.type === 'call_missed' && s.payload.data['callId'] === id)).toHaveLength(1);
  });

  it('publishes the line with the time it is stored under, however late the finalize ran', async () => {
    const { a, b, matchId } = await pair(['Line', 'Time']);
    const id = callOf(await place(a, matchId)).id;
    expect((await post(`/v1/calls/${id}/cancel`, a.token)).statusCode).toBe(200);
    // The clock of the call's decisions is far from the moment the finalize stores the line.
    clock.advance(10 * 60_000);
    await worker.runAll('finalize', id);
    const event = eventsOf(realtime, b.publicUid, 'message').find((e) => (e.d as { refId?: string }).refId === id);
    expect(event).toBeDefined();
    const live = event!.d as Message;
    const history = messagesPageSchema.parse((await call(h, `/v1/conversations/${matchId}/messages`, { token: b.token })).json());
    const stored = history.items.find((m) => m.id === live.id);
    expect(stored?.at).toBe(live.at);
    expect(event!.at).toBe(live.at);
  });

  it('tells nobody of a call whose conversation ended, even once the end’s tombstone is gone', async () => {
    const { a, b, matchId, lo } = await pair(['Late', 'Finalize']);
    const placed = await place(a, matchId);
    const id = callOf(placed).id;
    // b blocks a while it rings: the call ends with the conversation.
    expect((await post('/v1/blocks', b.token, { target: a.publicUid })).statusCode).toBeLessThan(300);
    const [job] = worker.pending('finalize', id);
    expect(job).toBeDefined();
    // The finalize runs more than an hour later (an outage, a backlog): the tombstone has run out.
    await h.redis.del(h.app.keys.matchEnded(matchId));
    const told = () => [a, b].map((u) => eventsOf(realtime, u.publicUid, 'message').filter((e) => (e.d as { refId?: string }).refId === id).length);
    expect((await worker.run(job!)).result).toEqual({ outcome: 'finalized', rows: true, replay: false });
    // The rows stay for reports.
    expect(await rows(db, `SELECT 1 FROM calls WHERE id = $1`, [id])).toHaveLength(1);
    expect(told()).toEqual([0, 0]);
    expect(worker.push.sent.some((s) => s.payload.type === 'call_missed' && s.payload.data['callId'] === id)).toBe(false);
    for (const u of [a, b]) expect(await h.redis.zscore(h.app.keys.conversationList(u.id), matchId)).toBeNull();
    expect(await h.redis.hget(chatKeys(h.app.keys).unread(b.id), matchId)).toBeNull();
    void lo;
  });

  it('places a call in a conversation the chat keeps warm without a statement, and never shortens its cached state', async () => {
    const { a, b, matchId } = await pair(['Warm', 'Pair']);
    // The list reads the conversation: its state is cached for an hour (without the visibility).
    expect((await call(h, '/v1/conversations', { token: a.token })).statusCode).toBe(200);
    const ttl = () => h.redis.pttl(h.app.keys.matchState(matchId));
    expect(await ttl()).toBeGreaterThan(3_000_000);
    const first = await place(a, matchId);
    expect(first.statusCode, first.body).toBe(201);
    // The pair from PostgreSQL (and the caller's account view, cached from now on).
    expect(statements(first)).toBe(2);
    // The call's own read caches nothing shorter over the hour.
    expect(await ttl()).toBeGreaterThan(3_000_000);
    expect((await post(`/v1/calls/${callOf(first).id}/cancel`, a.token)).statusCode).toBe(200);
    // A chat request keeps the visibility with the state; a call later on reads nothing.
    expect((await post(`/v1/conversations/${matchId}/messages`, a.token, { clientId: randomUUID(), kind: 'text', body: 'calling you' })).statusCode).toBe(201);
    await h.redis.del(callKeys(h.app.keys).eligibility(matchId));
    const second = await place(a, matchId);
    expect(second.statusCode, second.body).toBe(201);
    expect(statements(second)).toBe(0);
    expect(await ttl()).toBeGreaterThan(3_000_000);
    await post(`/v1/calls/${callOf(second).id}/cancel`, a.token);
    void b;
  });
});
