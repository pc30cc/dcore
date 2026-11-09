import { randomUUID } from 'node:crypto';
import { callAcceptanceSchema, callBodySchema, conversationsPageSchema, messagesPageSchema, sentMessageSchema, type Call, type Message } from '@app/shared';
import { FakePresence, FakeRealtimePublisher, callIdentities, readCall } from '@app/shared/server';
import { reportEvidenceJob } from '@app/worker';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WRITE_LAG_HEADER } from '../src/routes/chat.js';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, json, migratedDatabase, row, rows, seedUser, startHarness, statements, type Harness, type SeededUser, type TestDatabase } from './accountSupport.js';
import { FakeLiveKit, IDENTITY_SECRET, LIVEKIT_ENV, TestClock, lastCallEvent, signedWebhook, startCallWorker, type CallWorker } from './callsSupport.js';
import { eventsOf, fakeJob, matchOf, startChatPipeline, until, type ChatPipeline } from './chatSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * The chat, the calls and the jobs around them on one API, with the worker's
 * halves in the same process on the same database and Valkey prefix: the
 * `wb:msg` writer, the `calls` jobs (ring, room, finalize, ring and stop)
 * and the report evidence job. What one track's code hands the other is
 * exercised here: the call line the finalize writes directly beside the
 * messages the writer stores, the conversation list both keep, the cursor
 * the history hands out, the evidence of a report, and a conversation that
 * ends while its call lives.
 */

describe.skipIf(!hasInfrastructure)('W4 across the tracks (PostgreSQL, Valkey)', () => {
  let db: TestDatabase;
  let h: Harness;
  let pipeline: ChatPipeline;
  let worker: CallWorker;
  const jobs = new MemoryJobProducer();
  const realtime = new FakeRealtimePublisher();
  const presence = new FakePresence();
  const livekit = new FakeLiveKit();
  const clock = new TestClock();

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startHarness(db, { ...LIVEKIT_ENV }, { jobs, realtime, chat: { presence }, calls: { livekit: livekit.client(), now: clock.now, random: () => 0.5 } });
    pipeline = await startChatPipeline(h, realtime, { claimIdleMs: 3_000 });
    worker = await startCallWorker(h, realtime, jobs, livekit, clock);
  }, 90_000);

  afterAll(async () => {
    await worker?.stop();
    await pipeline?.stop();
    await h?.close();
    await db?.drop();
  });

  async function pair(names: [string, string]): Promise<{ a: SeededUser; b: SeededUser; id: string }> {
    const a = await seedUser(h, { name: names[0] });
    const b = await seedUser(h, { name: names[1] });
    const m = await matchOf(h, a.id, b.id);
    return { a, b, id: m.id };
  }

  const post = (url: string, user: SeededUser, body?: unknown) => call(h, url, { method: 'POST', token: user.token, ...(body === undefined ? {} : { body }) });
  const send = (user: SeededUser, conversationId: string, text: string) =>
    post(`/v1/conversations/${conversationId}/messages`, user, { clientId: randomUUID(), kind: 'text', body: text });
  const sentId = (response: LightMyRequestResponse): string => sentMessageSchema.parse(response.json()).message.id;
  const callOf = (response: LightMyRequestResponse): Call => callBodySchema.parse(response.json()).call;

  async function history(user: SeededUser, conversationId: string, after?: string): Promise<{ response: LightMyRequestResponse; items: Message[]; cursor: string }> {
    const response = await call(h, `/v1/conversations/${conversationId}/messages${after ? `?after=${after}&limit=200` : ''}`, { token: user.token });
    expect(response.statusCode, response.body).toBe(200);
    const page = messagesPageSchema.parse(response.json());
    return { response, items: page.items, cursor: page.syncCursor };
  }

  async function durable(conversationId: string, n: number): Promise<void> {
    await until(async () => Number((await row<{ n: string }>(db, `SELECT count(*)::text AS n FROM messages WHERE match_id = $1`, [conversationId])).n) >= n);
  }

  async function webhook(event: Record<string, unknown>): Promise<void> {
    const signed = await signedWebhook(event);
    const response = await h.app.inject({
      method: 'POST',
      url: '/v1/webhooks/livekit',
      headers: { 'content-type': 'application/webhook+json', authorization: signed.authorization },
      payload: signed.body,
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  let eventSeq = 0;
  const joined = (callId: string, identity: string) => ({ event: 'participant_joined', id: `EV_w4_${(eventSeq += 1)}`, room: { name: `c_${callId}` }, participant: { identity } });

  it('carries one conversation through messages, a push, a call and its line, the list, a report and a block', async () => {
    const { a, b, id } = await pair(['Ava', 'Ben']);

    // Messages: after the first send (the conversation's state is read once), each costs no statement and reaches Ben at once.
    const first = await send(a, id, 'hello');
    expect(first.statusCode, first.body).toBe(201);
    const sent = [sentId(first)];
    for (const text of ['how are you', 'call you in a minute?', 'ok?']) {
      const response = await send(a, id, text);
      expect(response.statusCode).toBe(201);
      expect(statements(response)).toBe(0);
      sent.push(sentId(response));
    }
    expect(eventsOf(realtime, b.publicUid, 'message').map((e) => e.id)).toEqual(sent);
    // One push for the burst (criterion 8), queued for the person written to.
    expect(jobs.jobs.filter((j) => j.queue === 'push' && j.data['type'] === 'message' && j.data['conversationId'] === id)).toHaveLength(1);
    await durable(id, 4);
    const before = await history(b, id);
    expect(before.items.map((m) => m.id)).toEqual(sent);
    expect(before.response.headers[WRITE_LAG_HEADER]).toBeDefined();
    const read = await post(`/v1/conversations/${id}/receipts`, b, { readUpTo: sent.at(-1) });
    expect(read.statusCode).toBe(204);
    expect(statements(read)).toBe(0);

    // A video call: nothing written from the ring to the hang-up.
    const placed = await post('/v1/calls', a, { conversationId: id, kind: 'video' });
    expect(placed.statusCode, placed.body).toBe(201);
    const callId = callOf(placed).id;
    expect(worker.pending('ring-push', callId)).toHaveLength(1);
    const moves = [
      await post(`/v1/calls/${callId}/rang`, b),
      await post(`/v1/calls/${callId}/accept`, b),
      await post(`/v1/calls/${callId}/token`, a),
    ];
    expect(moves.map((r) => r.statusCode)).toEqual([204, 200, 200]);
    expect(callAcceptanceSchema.parse(moves[1]!.json()).call.state).toBe('connecting');
    const ids = callIdentities(IDENTITY_SECRET, { id: callId, callerId: a.id, calleeId: b.id });
    await webhook(joined(callId, ids.caller));
    await webhook(joined(callId, ids.callee));
    expect(lastCallEvent(realtime, b.publicUid, callId)).toMatchObject({ state: 'active' });
    clock.advance(65_000);
    const ended = await post(`/v1/calls/${callId}/end`, a);
    expect(callOf(ended)).toMatchObject({ state: 'ended', outcome: 'completed', durationSeconds: 65 });
    // Place, rang, accept, token, end: the callee's account view (read once, then cached) only; the pair comes from the
    // conversation's state the chat cached, its visibility included.
    expect([placed, ...moves, ended].map(statements)).toEqual([0, 1, 0, 0, 0]);
    const [finalize] = await worker.runAll('finalize', callId);
    expect(finalize?.statements).toBe(2);

    // The line the finalize wrote sits after the messages the writer stored, and a client following its cursor gets it.
    const after = await history(b, id, before.cursor);
    const line = after.items.find((m) => m.kind === 'call');
    expect(line).toMatchObject({ refId: callId, senderId: a.publicUid, call: { callId, kind: 'video', outcome: 'completed', durationSeconds: 65 } });
    expect(BigInt(line!.id) > BigInt(sent.at(-1)!)).toBe(true);
    expect(eventsOf(realtime, b.publicUid, 'message').map((e) => e.id)).toContain(line!.id);
    // The list shows the line as the newest message, with no statement once warm; a completed call counts as nothing unread.
    await call(h, '/v1/conversations', { token: b.token });
    const list = await call(h, '/v1/conversations', { token: b.token });
    expect(statements(list)).toBe(0);
    expect(conversationsPageSchema.parse(list.json()).items.find((c) => c.id === id)).toMatchObject({ unread: 0, lastMessage: { id: line!.id, kind: 'call' } });

    // A report from the chat: its evidence holds the messages and the call line before it, once they are durable.
    const filed = await post('/v1/reports', b, { target: a.publicUid, context: 'chat', reason: 'harassment', conversationId: id, messageIds: [sent[2]] });
    expect(filed.statusCode, filed.body).toBe(202);
    const reportId = String(json(filed)['reportId']);
    const evidenceJob = jobs.jobs.find((j) => j.queue === 'safety' && j.name === 'report-evidence' && j.data['reportId'] === reportId);
    expect(evidenceJob).toBeDefined();
    await until(async () => {
      const wm = await h.redis.get(h.app.keys.streamWatermark('msg'));
      return wm !== null && BigInt(wm) > BigInt(String(evidenceJob!.data['filingId']));
    });
    expect(await reportEvidenceJob(fakeJob('report-evidence', evidenceJob!.data), pipeline.context)).toMatchObject({ outcome: 'copied', messages: 5 });
    const evidence = await row<{ evidence: { chat: { messages: { id: string; kind: number; body?: string }[] }[] } }>(db, `SELECT evidence FROM reports WHERE id = $1`, [reportId]);
    expect(evidence.evidence.chat[0]!.messages.map((m) => m.id)).toEqual([...sent, line!.id]);

    // A second call rings; Ben blocks Ava: the call ends with the conversation, at once, and the conversation is closed for both.
    const again = callOf(await post('/v1/calls', a, { conversationId: id, kind: 'audio' })).id;
    const block = await post('/v1/blocks', b, { target: a.publicUid });
    expect(block.statusCode, block.body).toBe(204);
    expect(lastCallEvent(realtime, a.publicUid, again)).toMatchObject({ state: 'cancelled' });
    expect(worker.pending('ring-stop', again)).toHaveLength(1);
    for (const person of [a, b]) expect(eventsOf(realtime, person.publicUid, 'conversation_end').map((e) => (e.d as { conversationId: string }).conversationId)).toContain(id);
    expect((await call(h, `/v1/conversations/${id}/messages`, { token: a.token })).statusCode).toBe(410);
    expect((await send(a, id, 'still there?')).statusCode).toBe(404);
    expect((await call(h, `/v1/calls/${again}`, { token: a.token })).statusCode).toBe(404);
    expect(conversationsPageSchema.parse((await call(h, '/v1/conversations', { token: a.token })).json()).items.map((c) => c.id)).not.toContain(id);
    // The ended call is still finalized for the report, and nobody is told of its line.
    const told = eventsOf(realtime, a.publicUid, 'message').length;
    await worker.runAll('finalize', again);
    expect(await rows(db, `SELECT 1 FROM calls WHERE id = $1`, [again])).toHaveLength(1);
    expect(eventsOf(realtime, a.publicUid, 'message').length).toBe(told);
  });

  it('still hands a call line to a client whose sync cursor passed the call’s end before the finalize wrote it', async () => {
    const { a, b, id } = await pair(['Late', 'Line']);
    const opening = sentId(await send(a, id, 'before the call'));
    await durable(id, 1);
    const placed = callOf(await post('/v1/calls', a, { conversationId: id, kind: 'audio' })).id;
    await post(`/v1/calls/${placed}/accept`, b);
    clock.advance(30_000);
    await post(`/v1/calls/${placed}/end`, a);
    const ended = await readCall(h.app.redis, h.app.keys, placed);
    expect(ended?.state).toBe('ended');

    // The finalize waits (LiveKit slow to delete the room, a busy worker, PostgreSQL down) while the writer moves the
    // watermark past the call's end, and Ben's phone catches up meanwhile.
    await pipeline.pause();
    try {
      await h.redis.set(h.app.keys.streamWatermark('msg'), h.app.ids.nextId());
      const caughtUp = await history(b, id, opening);
      expect(caughtUp.items).toEqual([]);
      // An id minted when the call ended is below the cursor Ben now holds: a line under it would never be fetched.
      expect(BigInt(caughtUp.cursor) > BigInt(ended!.lineId!)).toBe(true);

      const [finalize] = await worker.runAll('finalize', placed);
      expect(finalize?.result).toEqual({ outcome: 'finalized', rows: true, replay: false });
      const next = await history(b, id, caughtUp.cursor);
      expect(next.items.map((m) => [m.kind, m.refId])).toEqual([['call', placed]]);
      // The realtime copy and the stored row are the same message.
      expect(eventsOf(realtime, b.publicUid, 'message').map((e) => e.id)).toContain(next.items[0]!.id);
    } finally {
      pipeline.resume();
    }
  });
});
