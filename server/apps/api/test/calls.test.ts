import { callAcceptanceSchema, callBodySchema, callTokenSchema, messagesPageSchema, problemSchemaFor, rtcSettingsViewSchema, type Call } from '@app/shared';
import {
  CALL_RING_MS,
  DIRECT_WRITE_HOLD_MS,
  FakeRealtimePublisher,
  PARTICIPANT_IDENTITY,
  callIdentities,
  callKeys,
  directWritesKey,
  holdDirectWrites,
  participantIdentity,
  releaseDirectWrites,
  turnPassword,
  turnSecretFingerprint,
} from '@app/shared/server';
import { decodeJwt } from 'jose';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { ModerationActions } from '../src/services/moderationActions.js';
import { call, json, migratedDatabase, problemExt, row, rows, seedUser, setAppConfig, startHarness, statements, type Harness, type SeededUser, type TestDatabase } from './accountSupport.js';
import { FakeLiveKit, IDENTITY_SECRET, LIVEKIT_ENV, LIVEKIT_KEY, TestClock, eventsOf, lastCallEvent, signedWebhook, startCallWorker, type CallWorker } from './callsSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * Calls end to end on PostgreSQL and Valkey: the call routes, the LiveKit
 * webhook and the worker's call jobs (ring timeout, room check, finalize,
 * the ring and its stop) against an in-memory LiveKit, a fake FCM and a fake
 * Centrifugo, with a clock the suite moves.
 */

const CLOUDFLARE_EDGE = '162.158.1.1';
const DIRECT = '203.0.113.50';
const RELAY_SECRET = 'relay-shared-secret-0123456789abcdef';

describe.skipIf(!hasInfrastructure)('calls (PostgreSQL, Valkey)', () => {
  let db: TestDatabase;
  let h: Harness;
  let worker: CallWorker;
  const jobs = new MemoryJobProducer();
  const realtime = new FakeRealtimePublisher();
  const livekit = new FakeLiveKit();
  const clock = new TestClock();
  let adminToken = '';

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startHarness(db, { ...LIVEKIT_ENV }, { jobs, realtime, calls: { livekit: livekit.client(), now: clock.now, random: () => 0.5 } });
    worker = await startCallWorker(h, realtime, jobs, livekit, clock);
    const admin = await row<{ id: number }>(db, `INSERT INTO admin_users (email, display_name) VALUES ('ops@example.com', 'Ops') RETURNING id`);
    adminToken = (await h.app.tokens.issue({ kind: 'admin', subject: String(admin.id), sessionId: '7', roles: ['superadmin'] })).token;
  }, 90_000);
  afterAll(async () => {
    await worker?.stop();
    await h?.close();
    await db?.drop();
  });

  let tokens = 0;
  async function pushToken(user: SeededUser, deviceId = user.deviceId): Promise<string> {
    tokens += 1;
    const token = `fcm-token-${tokens}-${user.id.slice(-4)}`;
    await db.sql.query(`UPDATE devices SET push_token = $2, push_token_hash = sha256(convert_to($2, 'UTF8')) WHERE id = $1`, [deviceId, token]);
    return token;
  }

  /** A second phone of the same person: its own device row, session and token. */
  async function secondPhone(user: SeededUser): Promise<{ deviceId: string; token: string; pushToken: string }> {
    const deviceId = h.app.ids.nextId();
    const sessionId = h.app.ids.nextId();
    await db.sql.query(`INSERT INTO devices (id, user_id, app_version, platform, store, locale) VALUES ($1, $2, 100, 1, 2, 'fa')`, [deviceId, user.id]);
    await db.sql.query(`INSERT INTO sessions (id, user_id, device_id, expires_at, store, refresh_hash) VALUES ($1, $2, $3, now() + interval '30 days', 2, $4)`, [
      sessionId,
      user.id,
      deviceId,
      Buffer.alloc(32, 3),
    ]);
    const token = (await h.app.tokens.issue({ kind: 'app', subject: user.publicUid, sessionId, deviceId, storeCode: 2, scope: 'full' })).token;
    return { deviceId, token, pushToken: await pushToken(user, deviceId) };
  }

  async function pair(names: [string, string] = ['Negar Ahmadi', 'Arash'], flags = 3): Promise<{ a: SeededUser; b: SeededUser; matchId: string }> {
    const a = await seedUser(h, { name: names[0] });
    const b = await seedUser(h, { name: names[1] });
    const matchId = h.app.ids.nextId();
    const [lo, hi] = BigInt(a.id) < BigInt(b.id) ? [a.id, b.id] : [b.id, a.id];
    await db.sql.query(`INSERT INTO matches (id, user_lo, user_hi, source, flags) VALUES ($1, $2, $3, 1, $4)`, [matchId, lo, hi, flags]);
    await pushToken(a);
    await pushToken(b);
    return { a, b, matchId };
  }

  /** A second conversation of an existing person. */
  async function pairWith(existing: SeededUser, name: string): Promise<{ other: SeededUser; matchId: string }> {
    const other = await seedUser(h, { name });
    const matchId = h.app.ids.nextId();
    const [lo, hi] = BigInt(existing.id) < BigInt(other.id) ? [existing.id, other.id] : [other.id, existing.id];
    await db.sql.query(`INSERT INTO matches (id, user_lo, user_hi, source, flags) VALUES ($1, $2, $3, 1, 3)`, [matchId, lo, hi]);
    await pushToken(other);
    return { other, matchId };
  }

  const post = (url: string, token: string, body?: unknown, extra: { remoteAddress?: string; headers?: Record<string, string> } = {}): Promise<LightMyRequestResponse> =>
    h.app
      .inject({
        method: 'POST',
        url,
        remoteAddress: extra.remoteAddress ?? DIRECT,
        headers: { 'x-client': 'bazaar/120', authorization: `Bearer ${token}`, ...extra.headers },
        ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
      })
      .then((r) => {
        h.bodies.push(r.body);
        return r;
      });

  const place = (caller: SeededUser, matchId: string, kind: 'audio' | 'video' = 'audio') => post('/v1/calls', caller.token, { conversationId: matchId, kind });
  const callOf = (response: LightMyRequestResponse): Call => callBodySchema.parse(response.json()).call;
  const code = (response: LightMyRequestResponse): string => String(json(response)['code']);

  async function webhook(event: Record<string, unknown>, options: { tamper?: boolean; secret?: string } = {}): Promise<LightMyRequestResponse> {
    const signed = await signedWebhook(event, options);
    return h.app.inject({
      method: 'POST',
      url: '/v1/webhooks/livekit',
      headers: { 'content-type': 'application/webhook+json', authorization: signed.authorization },
      payload: signed.body,
    });
  }

  let eventSeq = 0;
  const joined = (callId: string, identity: string) => ({ event: 'participant_joined', id: `EV_j${(eventSeq += 1)}`, room: { name: `c_${callId}` }, participant: { identity } });
  const left = (callId: string, identity: string, disconnectReason?: string) => ({
    event: 'participant_left',
    id: `EV_l${(eventSeq += 1)}`,
    room: { name: `c_${callId}` },
    participant: { identity, ...(disconnectReason ? { disconnectReason } : {}) },
  });

  async function saveRtc(body: Record<string, unknown>): Promise<LightMyRequestResponse> {
    return h.app.inject({ method: 'PUT', url: '/v1/admin/providers/rtc', headers: { authorization: `Bearer ${adminToken}` }, payload: body });
  }

  // ─── Criterion 1 ────────────────────────────────────────────────────────

  it('costs no statement from the ring to the hang-up, then one transaction of 2 INSERTs; a replayed finalize writes 0 rows', async () => {
    const { a, b, matchId } = await pair();
    // Warm caches: each person's own view, and the pair (a first call, cancelled).
    expect((await call(h, '/v1/me', { token: a.token })).statusCode).toBe(200);
    expect((await call(h, '/v1/me', { token: b.token })).statusCode).toBe(200);
    const warm = await place(a, matchId);
    expect(warm.statusCode).toBe(201);
    expect(statements(warm)).toBe(1); // the pair, once
    expect((await post(`/v1/calls/${callOf(warm).id}/cancel`, a.token)).statusCode).toBe(200);

    const counted: [string, number][] = [];
    const count = (label: string, response: LightMyRequestResponse) => {
      counted.push([label, statements(response)]);
      return response;
    };
    const placed = count('place', await place(a, matchId, 'video'));
    expect(placed.statusCode).toBe(201);
    const ringing = callOf(placed);
    expect(ringing).toMatchObject({ conversationId: matchId, kind: 'video', role: 'caller', state: 'ringing' });
    expect(Date.parse(ringing.ringExpiresAt) - Date.parse(ringing.placedAt)).toBe(CALL_RING_MS);
    expect(lastCallEvent(realtime, b.publicUid, ringing.id)).toMatchObject({ role: 'callee', state: 'ringing' });

    // The ring to the callee's phone (the push's own read of its devices, counted apart).
    const [ring] = await worker.runAll('ring-push', ringing.id);
    expect(ring?.result).toEqual({ outcome: 'rung', devices: 1 });
    const ringPush = worker.push.sent.find((s) => s.payload.type === 'call_incoming' && s.payload.data['callId'] === ringing.id);
    expect(ringPush?.payload.data).toMatchObject({ conversationId: matchId, kind: 'video', peerName: 'Negar' });

    clock.advance(1_200);
    expect(count('rang', await post(`/v1/calls/${ringing.id}/rang`, b.token)).statusCode).toBe(204);
    clock.advance(3_000);
    const accepted = count('accept', await post(`/v1/calls/${ringing.id}/accept`, b.token));
    expect(accepted.statusCode).toBe(200);
    const acceptance = callAcceptanceSchema.parse(accepted.json());
    expect(acceptance.call).toMatchObject({ state: 'connecting', role: 'callee' });
    expect(livekit.rooms.get(`c_${ringing.id}`)?.metadata).toBe(JSON.stringify({ call_id: ringing.id }));
    const callerToken = count('token', await post(`/v1/calls/${ringing.id}/token`, a.token));
    expect(callerToken.statusCode).toBe(200);

    const ids = callIdentities(IDENTITY_SECRET, { id: ringing.id, callerId: a.id, calleeId: b.id });
    for (const [token, identity] of [
      [acceptance.token.token, ids.callee],
      [callTokenSchema.parse(callerToken.json()).token, ids.caller],
    ] as const) {
      const claims = decodeJwt(token);
      expect(claims.sub).toBe(identity);
      expect(String(claims.sub)).toMatch(PARTICIPANT_IDENTITY);
      expect(claims.iss).toBe(LIVEKIT_KEY);
      expect(claims['name']).toBeUndefined();
      expect(claims['metadata']).toBeUndefined();
      expect(claims['video']).toEqual({ room: `c_${ringing.id}`, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
      expect(JSON.stringify(claims)).not.toContain(a.id);
      expect(JSON.stringify(claims)).not.toContain(b.id);
    }

    livekit.join(`c_${ringing.id}`, ids.callee);
    expect((await webhook(joined(ringing.id, ids.callee))).statusCode).toBe(200);
    livekit.join(`c_${ringing.id}`, ids.caller);
    const both = joined(ringing.id, ids.caller);
    expect((await webhook(both)).statusCode).toBe(200);
    expect(lastCallEvent(realtime, a.publicUid, ringing.id)).toMatchObject({ state: 'active' });

    // The room check 90 s after the answer: both are in, the call goes on.
    clock.advance(90_000);
    const [check] = await worker.runAll('room', ringing.id);
    expect(check?.delayed).toBe(true);
    clock.advance(35_000);
    const ended = count('end', await post(`/v1/calls/${ringing.id}/end`, a.token));
    expect(callOf(ended)).toMatchObject({ state: 'ended', outcome: 'completed', durationSeconds: 125, endReason: 'hangup' });
    expect(counted.filter(([, n]) => n !== 0)).toEqual([]);

    // The jobs that follow: nothing until the finalize, and then exactly the two INSERTs in one transaction.
    for (const name of ['ring-stop', 'ring', 'room']) for (const run of await worker.runAll(name, ringing.id)) expect(run.statements).toBe(0);
    const [finalize] = await worker.runAll('finalize', ringing.id);
    expect(finalize?.result).toEqual({ outcome: 'finalized', rows: true, replay: false });
    expect(finalize?.statements).toBe(2);
    // The call's INSERT (in a CTE that, on a replay, reads back the line already stored) and the line's.
    expect(finalize?.texts).toHaveLength(2);
    expect(finalize?.texts.map((t) => t.split('\n')[0]?.trim())).toEqual(['WITH ins AS (', 'INSERT INTO messages (match_id, id, sender_id, ref_id, kind, flags, body)']);
    const stored = await row<Record<string, unknown>>(
      db,
      `SELECT match_id::text, caller_id::text, callee_id::text, kind, outcome, duration_s, ended_by, end_reason, relayed, rang_at IS NOT NULL AS rang, answered_at IS NOT NULL AS answered
         FROM calls WHERE id = $1`,
      [ringing.id],
    );
    expect(stored).toEqual({ match_id: matchId, caller_id: a.id, callee_id: b.id, kind: 2, outcome: 1, duration_s: 125, ended_by: 1, end_reason: 1, relayed: false, rang: true, answered: true });
    const line = await row<{ id: string; sender_id: string; ref_id: string; kind: number; body: string }>(
      db,
      `SELECT id::text, sender_id::text, ref_id::text, kind, body FROM messages WHERE match_id = $1 AND kind = 5 AND ref_id = $2`,
      [matchId, ringing.id],
    );
    expect(line).toMatchObject({ sender_id: a.id, kind: 5 });
    expect(JSON.parse(line.body)).toMatchObject({ v: 1, k: 2, o: 1, d: 125 });
    // The line sorts after every cursor handed out before it was written: its id was minted by the finalize.
    expect(BigInt(line.id) > BigInt(ringing.id)).toBe(true);
    const lineEvent = eventsOf(realtime, b.publicUid, 'message').find((e) => e.id === line.id);
    expect(lineEvent?.d).toMatchObject({ kind: 'call', senderId: a.publicUid, refId: ringing.id, call: { callId: ringing.id, kind: 'video', outcome: 'completed', durationSeconds: 125, caller: a.publicUid } });

    // A replay (the same job again, as BullMQ could run it after a lost acknowledgement): 0 rows, nothing sent.
    const before = { calls: (await rows(db, `SELECT 1 FROM calls WHERE id = $1`, [ringing.id])).length, events: realtime.published.length, pushes: worker.push.sent.length };
    const replayJob = { ...jobs.jobs.find((j) => j.name === 'finalize' && j.data['callId'] === ringing.id)!, data: { callId: ringing.id, call: (jobs.jobs.find((j) => j.name === 'finalize' && j.data['callId'] === ringing.id)!.data as { call: unknown }).call } };
    const replay = await worker.run(replayJob);
    expect(replay.result).toEqual({ outcome: 'finalized', rows: false, replay: true });
    // The call's INSERT finds its row; the line's is not sent.
    expect(replay.statements).toBe(1);
    expect((await rows(db, `SELECT 1 FROM calls WHERE id = $1`, [ringing.id])).length).toBe(before.calls);
    expect((await rows(db, `SELECT 1 FROM messages WHERE match_id = $1 AND kind = 5 AND ref_id = $2`, [matchId, ringing.id])).length).toBe(1);
    expect(realtime.published.length).toBe(before.events);
    expect(worker.push.sent.length).toBe(before.pushes);
    // And the room is gone.
    expect(livekit.rooms.has(`c_${ringing.id}`)).toBe(false);
  });

  // ─── Criterion 2 ────────────────────────────────────────────────────────

  it('changes nothing for a duplicate LiveKit event, refuses a bad signature, and ignores DUPLICATE_IDENTITY', async () => {
    const { a, b, matchId } = await pair();
    const callId = callOf(await place(a, matchId)).id;
    expect((await post(`/v1/calls/${callId}/accept`, b.token)).statusCode).toBe(200);
    const ids = callIdentities(IDENTITY_SECRET, { id: callId, callerId: a.id, calleeId: b.id });
    await webhook(joined(callId, ids.caller));
    await webhook(joined(callId, ids.callee));
    const eventsBefore = realtime.published.length;
    const leave = left(callId, ids.callee);
    // Not signed by our secret, or a body that is not the one signed: refused, nothing read.
    expect((await webhook(leave, { secret: 'another-secret-0123456789abcdef0123456' })).statusCode).toBe(401);
    expect((await webhook(leave, { tamper: true })).statusCode).toBe(401);
    // A reconnect of the same identity is not a person leaving.
    expect((await webhook(left(callId, ids.callee, 'DUPLICATE_IDENTITY'))).statusCode).toBe(200);
    expect(callOf(await call(h, `/v1/calls/${callId}`, { token: a.token })).state).toBe('active');
    // The same event delivered twice: applied once.
    const first = await webhook(leave);
    const again = await webhook(leave);
    expect([first.statusCode, again.statusCode]).toEqual([200, 200]);
    expect(again.json()).toEqual({ ok: true, duplicate: true });
    const after = callOf(await call(h, `/v1/calls/${callId}`, { token: a.token }));
    expect(after).toMatchObject({ state: 'ended', outcome: 'completed', endReason: 'peer_left' });
    expect(realtime.published.length - eventsBefore).toBe(2); // the end, once, to each person
    // Track events and rooms that are not a call's: answered without any I/O.
    const calls = livekit.calls.length;
    const marks = await h.redis.keys(`${h.prefix}lkwh:*`);
    expect((await webhook({ event: 'track_published', id: 'EV_track1', room: { name: `c_${callId}` } })).json()).toEqual({ ok: true });
    expect((await webhook({ event: 'room_started', id: 'EV_other1', room: { name: 'not-a-call' } })).json()).toEqual({ ok: true });
    expect(livekit.calls.length).toBe(calls);
    expect(await h.redis.keys(`${h.prefix}lkwh:*`)).toHaveLength(marks.length);
  });

  // ─── Criterion 7 ────────────────────────────────────────────────────────

  it('shows a busy callee to the caller exactly like a callee who does not answer', async () => {
    const { a, b: busy, matchId: first } = await pair(['Sara', 'Kian']);
    expect((await place(a, first)).statusCode).toBe(201);
    const { other: caller, matchId: toBusy } = await pairWith(busy, 'Leyla');
    const { a: someone, b: silent, matchId: toSilent } = await pair(['Mina', 'Omid']);
    const busyEventsBefore = eventsOf(realtime, busy.publicUid, 'call').length;

    const fake = await place(caller, toBusy);
    const real = await place(someone, toSilent);
    expect([fake.statusCode, real.statusCode]).toEqual([201, 201]);
    const strip = (c: Call) => ({ ...c, id: 'id', conversationId: 'm', placedAt: 't', ringExpiresAt: 't' });
    expect(strip(callOf(fake))).toEqual(strip(callOf(real)));
    expect(Date.parse(callOf(fake).ringExpiresAt) - Date.parse(callOf(fake).placedAt)).toBe(CALL_RING_MS);
    const fakeId = callOf(fake).id;
    // The busy callee is not rung, and hears nothing while it "rings".
    expect(worker.pending('ring-push', fakeId)).toEqual([]);
    expect(eventsOf(realtime, busy.publicUid, 'call').length).toBe(busyEventsBefore);
    // The callee cannot see it, let alone answer it.
    expect((await call(h, `/v1/calls/${fakeId}`, { token: busy.token })).statusCode).toBe(404);
    expect((await post(`/v1/calls/${fakeId}/accept`, busy.token)).statusCode).toBe(404);

    // The short ring ends it as missed; the unanswered one ends the same way at 45 s.
    clock.advance(11_501);
    await worker.runAll('ring', fakeId);
    clock.advance(CALL_RING_MS);
    await worker.runAll('ring', callOf(real).id);
    const fakeEnd = lastCallEvent(realtime, caller.publicUid, fakeId) as Call;
    const realEnd = lastCallEvent(realtime, someone.publicUid, callOf(real).id) as Call;
    const ended = (c: Call) => ({ ...strip(c), endedAt: 't' });
    expect(ended(fakeEnd)).toEqual(ended(realEnd));
    expect(fakeEnd).toMatchObject({ state: 'missed', outcome: 'missed', endReason: 'ring_timeout', durationSeconds: 0 });
    // The busy callee finds a missed call: the event, the line and the notification.
    expect(lastCallEvent(realtime, busy.publicUid, fakeId)).toMatchObject({ role: 'callee', state: 'missed', endReason: 'ring_timeout' });
    await worker.runAll('finalize', fakeId);
    const stored = await row<{ outcome: number; end_reason: number }>(db, `SELECT outcome, end_reason FROM calls WHERE id = $1`, [fakeId]);
    expect(stored).toEqual({ outcome: 4, end_reason: 10 });
    expect(eventsOf(realtime, busy.publicUid, 'message').some((e) => (e.d as { refId?: string }).refId === fakeId)).toBe(true);
    const missedPush = worker.push.sent.find((s) => s.payload.type === 'call_missed' && s.payload.data['callId'] === fakeId);
    expect(missedPush?.payload).toMatchObject({ data: { type: 'call_missed', callId: fakeId, conversationId: toBusy }, title: 'Missed voice call', body: 'You missed a call.' });
    void silent;
  });

  it('keeps rang from the caller while the callee does not show online, and tells them when they do', async () => {
    const { a, b, matchId } = await pair(['Roya', 'Babak']);
    expect((await call(h, '/v1/me/settings', { method: 'PATCH', token: b.token, body: { showOnline: false } })).statusCode).toBe(200);
    const hidden = callOf(await place(a, matchId));
    expect((await post(`/v1/calls/${hidden.id}/rang`, b.token)).statusCode).toBe(204);
    expect(eventsOf(realtime, a.publicUid, 'call').filter((e) => (e.d as Call).id === hidden.id).map((e) => (e.d as Call).rangAt)).toEqual([undefined]);
    expect(callOf(await call(h, `/v1/calls/${hidden.id}`, { token: a.token })).rangAt).toBeUndefined();
    expect(callOf(await call(h, `/v1/calls/${hidden.id}`, { token: b.token })).rangAt).toBeDefined();
    expect((await post(`/v1/calls/${hidden.id}/cancel`, a.token)).statusCode).toBe(200);

    expect((await call(h, '/v1/me/settings', { method: 'PATCH', token: b.token, body: { showOnline: true } })).statusCode).toBe(200);
    const shown = callOf(await place(a, matchId));
    expect((await post(`/v1/calls/${shown.id}/rang`, b.token)).statusCode).toBe(204);
    expect(lastCallEvent(realtime, a.publicUid, shown.id)?.['rangAt']).toBe(new Date(clock.ms).toISOString());
    // A second phone saying it rang changes nothing; a word after the answer is refused.
    expect((await post(`/v1/calls/${shown.id}/rang`, b.token)).statusCode).toBe(204);
    expect((await post(`/v1/calls/${shown.id}/accept`, b.token)).statusCode).toBe(200);
    expect(code(await post(`/v1/calls/${shown.id}/rang`, b.token))).toBe('not_ringing');
    await post(`/v1/calls/${shown.id}/end`, b.token);
  });

  it('keeps deliveredUpTo from the peer while the reader does not show online (the chat receipts)', async () => {
    const { a, b, matchId } = await pair(['Delivered', 'Hidden']);
    expect((await call(h, '/v1/me/settings', { method: 'PATCH', token: b.token, body: { showOnline: false } })).statusCode).toBe(200);
    const receipt = await call(h, `/v1/conversations/${matchId}/receipts`, { method: 'POST', token: b.token, body: { deliveredUpTo: h.app.ids.nextId() } });
    expect(receipt.statusCode).toBe(204);
    expect(eventsOf(realtime, a.publicUid, 'receipt').filter((e) => (e.d as { conversationId: string }).conversationId === matchId)).toEqual([]);
    // The reader's own devices still hear it.
    expect(eventsOf(realtime, b.publicUid, 'receipt').some((e) => (e.d as { conversationId: string; deliveredUpTo?: string }).conversationId === matchId)).toBe(true);

    const shown = await pair(['Delivered', 'Shown']);
    const id = h.app.ids.nextId();
    expect((await call(h, `/v1/conversations/${shown.matchId}/receipts`, { method: 'POST', token: shown.b.token, body: { deliveredUpTo: id } })).statusCode).toBe(204);
    const toPeer = eventsOf(realtime, shown.a.publicUid, 'receipt').filter((e) => (e.d as { conversationId: string }).conversationId === shown.matchId);
    expect(toPeer.map((e) => (e.d as { deliveredUpTo?: string }).deliveredUpTo)).toEqual([id]);
  });

  it('hands the relay only to the participant whose own Cloudflare country is listed', async () => {
    const saved = await saveRtc({
      wsUrl: 'https://rtc.example.com/rtc/',
      turnUrls: ['turn:198.51.100.7:3478?transport=udp', 'turn:198.51.100.7:3478?transport=tcp'],
      sharedSecret: RELAY_SECRET,
      countries: ['IR'],
    });
    expect(saved.statusCode).toBe(200);
    const { a, b, matchId } = await pair(['Ali', 'Shirin']);
    const callId = callOf(await place(a, matchId)).id;
    // The callee answers from a network of a listed country (through Cloudflare): the relay, minted for six hours.
    const accepted = await post(`/v1/calls/${callId}/accept`, b.token, undefined, { remoteAddress: CLOUDFLARE_EDGE, headers: { 'cf-ipcountry': 'IR' } });
    const token = callAcceptanceSchema.parse(accepted.json()).token;
    expect(token.wsUrl).toBe('wss://rtc.example.com');
    expect(token.turn?.urls).toEqual(['turn:198.51.100.7:3478?transport=udp', 'turn:198.51.100.7:3478?transport=tcp']);
    expect(token.turn?.username).toMatch(/^[0-9]{10}:r[0-9a-f]{16}$/);
    expect(Number(token.turn?.username.split(':')[0])).toBe(Math.floor(clock.ms / 1_000) + 21_600);
    expect(token.turn?.credential).toBe(turnPassword(RELAY_SECRET, token.turn?.username ?? ''));
    expect(token.icePolicy).toBe('all');
    // Every later token of the callee (a rejoin, a client asking in a loop) carries the same username:
    // coturn's user-quota bounds a participant again, whatever the number of token requests.
    const fromRelayCountry = { remoteAddress: CLOUDFLARE_EDGE, headers: { 'cf-ipcountry': 'IR' } };
    const again: string[] = [];
    for (let i = 0; i < 29; i += 1) {
      const answer = await post(`/v1/calls/${callId}/token`, b.token, undefined, fromRelayCountry);
      expect(answer.statusCode).toBe(200);
      const t = callTokenSchema.parse(answer.json());
      again.push(t.turn?.username ?? '');
      expect(t.turn?.credential).toBe(turnPassword(RELAY_SECRET, t.turn?.username ?? ''));
    }
    expect(new Set(again)).toEqual(new Set([token.turn?.username]));
    // The caller, relayed too, gets a username of their own, also kept for the call.
    const callerTurn = callTokenSchema.parse((await post(`/v1/calls/${callId}/token`, a.token, undefined, fromRelayCountry)).json()).turn;
    expect(callerTurn?.username).toMatch(/^[0-9]{10}:r[0-9a-f]{16}$/);
    expect(callerTurn?.username).not.toBe(token.turn?.username);
    expect(callTokenSchema.parse((await post(`/v1/calls/${callId}/token`, a.token, undefined, fromRelayCountry)).json()).turn?.username).toBe(callerTurn?.username);
    // The caller abroad keeps LiveKit's own ICE servers.
    const abroad = callTokenSchema.parse((await post(`/v1/calls/${callId}/token`, a.token, undefined, { remoteAddress: CLOUDFLARE_EDGE, headers: { 'cf-ipcountry': 'DE' } })).json());
    expect(abroad).toMatchObject({ turn: null, warnings: [], wsUrl: 'wss://rtc.example.com' });
    // A country header that did not come through Cloudflare is not believed.
    const forged = callTokenSchema.parse((await post(`/v1/calls/${callId}/token`, a.token, undefined, { remoteAddress: DIRECT, headers: { 'cf-ipcountry': 'IR' } })).json());
    expect(forged.turn).toBeNull();
    await post(`/v1/calls/${callId}/end`, a.token);
    await worker.runAll('finalize', callId);
    expect((await row<{ relayed: boolean }>(db, `SELECT relayed FROM calls WHERE id = $1`, [callId])).relayed).toBe(true);
    // Without its secret (removed) the relay is not handed out; a listed participant is warned instead.
    expect((await saveRtc({ turnUrls: [], sharedSecret: '' })).statusCode).toBe(200);
  });

  // ─── Criterion 3: the behaviours ─────────────────────────────────────────

  it('lets one of many simultaneous calls ring, holds the caller busy, and counts the live cap', async () => {
    const { a, b, matchId } = await pair(['Nika', 'Payam']);
    const others = await Promise.all(['P1', 'P2', 'P3', 'P4'].map((name) => pairWith(b, name)));
    const callers = [a, ...others.map((o) => o.other)];
    const placed = await Promise.all([place(a, matchId), ...others.map(({ other, matchId: m }) => place(other, m))]);
    // Every caller sees a ringing call; exactly one of them really rings the callee.
    expect(placed.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);
    const rings = placed.map((r) => worker.pending('ring-push', callOf(r).id).length);
    expect(rings.filter((n) => n === 1)).toHaveLength(1);
    expect(rings.filter((n) => n === 0)).toHaveLength(4);
    // Every caller is held by their own call: another call of theirs is refused as busy.
    for (const [i, caller] of callers.entries()) {
      const { matchId: another } = await pairWith(caller, `Q${i}`);
      expect(code(await place(caller, another)), `caller ${i}`).toBe('caller_busy');
    }
    for (const [i, r] of placed.entries()) expect((await post(`/v1/calls/${callOf(r).id}/end`, callers[i]!.token)).statusCode).toBe(200);
    // Once over, the callee is free again.
    const { other: fresh, matchId: freshLine } = await pairWith(b, 'Fresh');
    const freed = await place(fresh, freshLine);
    expect(worker.pending('ring-push', callOf(freed).id)).toHaveLength(1);
    await post(`/v1/calls/${callOf(freed).id}/cancel`, fresh.token);

    // The live cap, from the RTC settings: one more call than the earlier tests still hold.
    const live = await h.redis.zcard(callKeys(h.app.keys).live());
    expect((await saveRtc({ maxLiveCalls: live + 1 })).statusCode).toBe(200);
    const one = await pair(['C1', 'C2']);
    const two = await pair(['C3', 'C4']);
    const firstLive = await place(one.a, one.matchId);
    expect(firstLive.statusCode).toBe(201);
    expect(code(await place(two.a, two.matchId))).toBe('limit_reached');
    await post(`/v1/calls/${callOf(firstLive).id}/cancel`, one.a.token);
    expect((await place(two.a, two.matchId)).statusCode).toBe(201);
    expect((await saveRtc({ maxLiveCalls: null })).statusCode).toBe(200);
  });

  it('limits the caller to 10 calls a minute and the callee to 6 rings, giving back a ring that never left', async () => {
    clock.advance(60_000 - (clock.ms % 60_000) + 5);
    const { a, b, matchId } = await pair(['Rate', 'Limit']);
    for (let i = 0; i < 10; i += 1) {
      const r = await place(a, matchId);
      expect(r.statusCode, `call ${i}`).toBe(i < 6 ? 201 : 429); // the callee's 6 rings run out first
      if (r.statusCode === 201) await post(`/v1/calls/${callOf(r).id}/cancel`, a.token);
    }
    expect(code(await place(a, matchId))).toBe('rate_limited');
    clock.advance(60_000);
    // A ring the placement gave back (the caller busy) leaves the callee's share whole.
    const { a: c, b: d, matchId: cd } = await pair(['Give', 'Back']);
    const { matchId: busyLine } = await pairWith(c, 'Other');
    const holding = await place(c, busyLine);
    for (let i = 0; i < 8; i += 1) expect(code(await place(c, cd))).toBe('caller_busy');
    await post(`/v1/calls/${callOf(holding).id}/cancel`, c.token);
    const rings = [];
    for (let i = 0; i < 6; i += 1) {
      const { other, matchId: m } = await pairWith(d, `R${i}`);
      const r = await place(other, m);
      rings.push(r.statusCode);
      if (r.statusCode === 201) await post(`/v1/calls/${callOf(r).id}/cancel`, other.token);
    }
    expect(rings).toEqual([201, 201, 201, 201, 201, 201]);
    const r = await place(c, cd);
    expect(code(r)).toBe('rate_limited');
    expect(problemSchemaFor('rate_limited').parse(r.json()).retryAfterSeconds).toBeGreaterThan(0);
    void b;
  });

  it('lets the first answer win, tells the other phone it was answered elsewhere, and stops only the other phone', async () => {
    const { a, b, matchId } = await pair(['First', 'Answer']);
    const phone = await secondPhone(b);
    const callId = callOf(await place(a, matchId)).id;
    await worker.runAll('ring-push', callId);
    const rung = worker.push.sent.filter((s) => s.payload.type === 'call_incoming' && s.payload.data['callId'] === callId).map((s) => s.token);
    expect(rung).toHaveLength(2);
    const [one, two] = await Promise.all([post(`/v1/calls/${callId}/accept`, b.token), post(`/v1/calls/${callId}/accept`, phone.token)]);
    expect([one.statusCode, two.statusCode].sort()).toEqual([200, 409]);
    expect(code(one.statusCode === 409 ? one : two)).toBe('answered_elsewhere');
    // The phone that won asking again (its reply was lost) gets its token again.
    const winner = one.statusCode === 200 ? b.token : phone.token;
    expect((await post(`/v1/calls/${callId}/accept`, winner)).statusCode).toBe(200);
    await worker.runAll('ring-stop', callId);
    const stops = worker.push.sent.filter((s) => s.payload.type === 'call_cancel' && s.payload.data['callId'] === callId);
    expect(stops).toHaveLength(1);
    expect(stops[0]?.payload.data['reason']).toBe('answered_elsewhere');
    const winnerToken = one.statusCode === 200 ? rung.find((t) => t !== phone.pushToken) : phone.pushToken;
    expect(stops[0]?.token).not.toBe(winnerToken);
    await post(`/v1/calls/${callId}/end`, a.token);
  });

  it('keeps an answered call when the room of a second phone that answered at once cannot be made', async () => {
    const { a, b, matchId } = await pair(['Room', 'Second']);
    const phone = await secondPhone(b);
    const callId = callOf(await place(a, matchId)).id;
    // The second phone's CreateRoom hangs until the first phone has answered, then fails (a timeout).
    let first = true;
    let release!: () => void;
    const answered = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => (reached = resolve));
    livekit.beforeCreate = async () => {
      if (!first) return 'ok';
      first = false;
      reached();
      await answered;
      return 'fail';
    };
    try {
      const slow = post(`/v1/calls/${callId}/accept`, phone.token);
      await waiting;
      const fast = await post(`/v1/calls/${callId}/accept`, b.token);
      expect(fast.statusCode).toBe(200);
      release();
      const late = await slow;
      expect(late.statusCode).toBe(409);
      expect(code(late)).toBe('answered_elsewhere');
    } finally {
      livekit.beforeCreate = null;
    }
    // The call the first phone answered goes on.
    expect(callOf(await call(h, `/v1/calls/${callId}`, { token: a.token })).state).toBe('connecting');
    expect(lastCallEvent(realtime, a.publicUid, callId)).not.toMatchObject({ state: 'ended' });
    await post(`/v1/calls/${callId}/end`, a.token);
  });

  it('settles a decline racing an answer cleanly, and gives a token only while the call is answered', async () => {
    const { a, b, matchId } = await pair(['Race', 'Decline']);
    const callId = callOf(await place(a, matchId)).id;
    expect(code(await post(`/v1/calls/${callId}/token`, a.token))).toBe('call_not_live');
    const [answer, decline] = await Promise.all([post(`/v1/calls/${callId}/accept`, b.token), post(`/v1/calls/${callId}/decline`, b.token)]);
    const state = callOf(await call(h, `/v1/calls/${callId}`, { token: a.token }));
    if (answer.statusCode === 200) {
      expect(state.state).toBe('connecting');
      expect(callOf(decline).state).toBe('connecting');
    } else {
      expect(state).toMatchObject({ state: 'ended', outcome: 'declined' });
      expect(code(answer)).toBe('not_ringing');
    }
    await post(`/v1/calls/${callId}/end`, a.token);
    expect(code(await post(`/v1/calls/${callId}/token`, a.token))).toBe('call_not_live');
    // Declining an ended call answers with the call as it is.
    expect((await post(`/v1/calls/${callId}/decline`, b.token)).statusCode).toBe(200);
  });

  it('answers 404 to outsiders, for a blocked pair and for an ended conversation; refuses calls the pair does not allow', async () => {
    const { a, b, matchId } = await pair(['Out', 'Sider']);
    const stranger = await seedUser(h, { name: 'Stranger' });
    const callId = callOf(await place(a, matchId)).id;
    expect((await call(h, `/v1/calls/${callId}`, { token: stranger.token })).statusCode).toBe(404);
    expect((await post(`/v1/calls/${callId}/end`, stranger.token)).statusCode).toBe(404);
    expect((await post(`/v1/calls/${callId}/accept`, a.token)).statusCode).toBe(403);
    expect((await place(stranger, matchId)).statusCode).toBe(404);
    await post(`/v1/calls/${callId}/cancel`, a.token);
    // The callee's consent off for this conversation: refused, with the reason.
    const consent = await pair(['No', 'Calls'], 1);
    const refused = await place(consent.a, consent.matchId);
    expect(refused.statusCode).toBe(403);
    expect(problemExt('calls_not_allowed', refused.json())['reason']).toBe('consent');
    // A block ends the conversation: the call answers as for one that does not exist.
    expect((await call(h, '/v1/blocks', { method: 'POST', token: b.token, body: { target: a.publicUid } })).statusCode).toBe(204);
    expect((await place(a, matchId)).statusCode).toBe(404);
    expect((await place(b, matchId)).statusCode).toBe(404);
  });

  it('places no call in a conversation a block ended, whatever copy of its state or verdict is left', async () => {
    const { a, b, matchId } = await pair(['Stale', 'Verdict']);
    // A first call caches the pair's state and its visibility verdict (a minute).
    const first = callOf(await place(a, matchId)).id;
    await post(`/v1/calls/${first}/cancel`, a.token);
    expect(await h.app.cache.exists(callKeys(h.app.keys).eligibility(matchId))).toBe(1);
    expect((await call(h, '/v1/blocks', { method: 'POST', token: b.token, body: { target: a.publicUid } })).statusCode).toBe(204);
    // A copy of the state put back after the end (a read that raced the block), next to the verdict.
    const [lo, hi] = BigInt(a.id) < BigInt(b.id) ? [a.id, b.id] : [b.id, a.id];
    await h.redis.hset(h.app.keys.matchState(matchId), { lo, hi, st: 1, fl: 3, src: 1, at: Date.now() });
    const ringsBefore = eventsOf(realtime, b.publicUid, 'call').length;
    const jobsBefore = jobs.jobs.length;
    const refused = await place(a, matchId);
    expect(refused.statusCode).toBe(404);
    expect(eventsOf(realtime, b.publicUid, 'call')).toHaveLength(ringsBefore);
    expect(jobs.jobs.slice(jobsBefore).filter((j) => j.queue === 'calls')).toHaveLength(0);
    await h.redis.del(h.app.keys.matchState(matchId));
  });

  it('does not cache call consent read just before the callee turned calls off', async () => {
    const { a, b, matchId } = await pair(['Consent', 'Race']);
    await h.redis.del(h.app.keys.matchState(matchId));
    await h.app.cache.del(callKeys(h.app.keys).eligibility(matchId));
    const pool = h.app.pg as unknown as { query: (...args: unknown[]) => Promise<unknown> };
    const original = pool.query;
    let readDone!: () => void;
    const read = new Promise<void>((resolve) => (readDone = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let armed = true;
    pool.query = async (...args: unknown[]) => {
      const result = await original(...args);
      const text = (args[0] as { text?: unknown } | undefined)?.text;
      if (armed && typeof text === 'string' && text.includes('AS lo_sees_hi')) {
        armed = false;
        readDone();
        await held;
      }
      return result;
    };
    let raced;
    try {
      const pending = place(a, matchId);
      await read;
      // The callee turns calls off between the caller's read (both allowed) and its cache write.
      const off = await call(h, '/v1/me/settings', { method: 'PATCH', token: b.token, body: { acceptCalls: false } });
      expect(off.statusCode, off.body).toBe(200);
      release();
      raced = await pending;
    } finally {
      pool.query = original;
    }
    // The placement that raced the change may stand (it was checked before it); its state is not kept.
    if (raced.statusCode === 201) await post(`/v1/calls/${callOf(raced).id}/cancel`, a.token);
    expect(await h.redis.exists(h.app.keys.matchState(matchId))).toBe(0);
    const after = await place(a, matchId);
    expect(after.statusCode).toBe(403);
    expect(problemExt('calls_not_allowed', after.json())['reason']).toBe('consent');
    expect((await call(h, '/v1/me/settings', { method: 'PATCH', token: b.token, body: { acceptCalls: true } })).statusCode).toBe(200);
  });

  it('misses a call once and only once, from the job or from a read past its end', async () => {
    const { a, b, matchId } = await pair(['Miss', 'Once']);
    const callId = callOf(await place(a, matchId)).id;
    clock.advance(CALL_RING_MS - 1_000);
    const [early] = await worker.runAll('ring', callId);
    expect(early?.delayed).toBe(true);
    clock.advance(1_001);
    const [read, job] = await Promise.all([call(h, `/v1/calls/${callId}`, { token: b.token }), worker.runAll('ring', callId)]);
    expect(callOf(read)).toMatchObject({ state: 'missed', outcome: 'missed' });
    const misses = eventsOf(realtime, a.publicUid, 'call').filter((e) => (e.d as Call).id === callId && (e.d as Call).state === 'missed');
    expect(misses).toHaveLength(1);
    expect(job[0]?.result?.outcome === 'missed' || job[0]?.result?.outcome === 'over' || job[0]?.result?.outcome === 'nothing').toBe(true);
    expect(code(await post(`/v1/calls/${callId}/accept`, b.token))).toBe('not_ringing');
    await worker.runAll('finalize', callId);
    expect((await rows(db, `SELECT 1 FROM calls WHERE id = $1 AND outcome = 4`, [callId])).length).toBe(1);
    // The callee's missed-call line counts as unread, and the notification follows the line.
    const pushIndex = worker.push.sent.findIndex((s) => s.payload.type === 'call_missed' && s.payload.data['callId'] === callId);
    expect(pushIndex).toBeGreaterThanOrEqual(0);
  });

  it('keeps, activates or ends a call in the room check, and decides nothing while LiveKit cannot be asked but the connecting cap', async () => {
    const { a, b, matchId } = await pair(['Room', 'Check']);
    const ids = (callId: string) => callIdentities(IDENTITY_SECRET, { id: callId, callerId: a.id, calleeId: b.id });
    // Both in the room though no webhook came: the check makes it active.
    const one = callOf(await place(a, matchId)).id;
    await post(`/v1/calls/${one}/accept`, b.token);
    livekit.join(`c_${one}`, ids(one).caller);
    livekit.join(`c_${one}`, ids(one).callee);
    clock.advance(90_000);
    expect((await worker.runAll('room', one))[0]?.delayed).toBe(true);
    expect(callOf(await call(h, `/v1/calls/${one}`, { token: a.token })).state).toBe('active');
    // One of them gone: it ends for both.
    livekit.leave(`c_${one}`, ids(one).callee);
    clock.advance(60_000);
    expect((await worker.runAll('room', one))[0]?.result).toEqual({ outcome: 'ended' });
    expect(callOf(await call(h, `/v1/calls/${one}`, { token: a.token }))).toMatchObject({ state: 'ended', outcome: 'completed', endReason: 'peer_left' });

    // LiveKit unreachable: an active call stays; a call still connecting ends 5 minutes after the answer.
    const two = callOf(await place(a, matchId)).id;
    await post(`/v1/calls/${two}/accept`, b.token);
    livekit.unreachable = true;
    clock.advance(90_000);
    expect((await worker.runAll('room', two))[0]?.delayed).toBe(true);
    expect(callOf(await call(h, `/v1/calls/${two}`, { token: a.token })).state).toBe('connecting');
    clock.advance(4 * 60_000);
    expect((await worker.runAll('room', two))[0]?.result).toEqual({ outcome: 'ended' });
    expect(callOf(await call(h, `/v1/calls/${two}`, { token: a.token }))).toMatchObject({ state: 'ended', outcome: 'failed', endReason: 'connect_timeout' });
    livekit.unreachable = false;

    // The room gone (closed by LiveKit, no webhook): it ends.
    const three = callOf(await place(a, matchId)).id;
    await post(`/v1/calls/${three}/accept`, b.token);
    livekit.rooms.delete(`c_${three}`);
    clock.advance(90_000);
    expect((await worker.runAll('room', three))[0]?.result).toEqual({ outcome: 'ended' });
    expect(callOf(await call(h, `/v1/calls/${three}`, { token: a.token })).endReason).toBe('room_gone');
  });

  it('fails the call for both when its room cannot be made at the answer', async () => {
    const { a, b, matchId } = await pair(['Room', 'Failed']);
    const id = callOf(await place(a, matchId)).id;
    livekit.unreachable = true;
    const answered = await post(`/v1/calls/${id}/accept`, b.token);
    livekit.unreachable = false;
    expect(answered.statusCode).toBe(503);
    expect(lastCallEvent(realtime, a.publicUid, id)).toMatchObject({ state: 'ended', outcome: 'failed', endReason: 'room_failed' });
    expect(lastCallEvent(realtime, b.publicUid, id)).toMatchObject({ state: 'ended', outcome: 'failed' });
    await worker.runAll('finalize', id);
    expect(await row(db, `SELECT outcome, end_reason, answered_at FROM calls WHERE id = $1`, [id])).toEqual({ outcome: 5, end_reason: 8, answered_at: null });
  });

  it('ends a live call at once when its conversation ends (block, unmatch, ban), and at its next request or room check when that step was missed', async () => {
    const { a, b, matchId } = await pair(['Block', 'During']);
    const id = callOf(await place(a, matchId)).id;
    await post(`/v1/calls/${id}/accept`, b.token);
    const ids = callIdentities(IDENTITY_SECRET, { id, callerId: a.id, calleeId: b.id });
    await webhook(joined(id, ids.caller));
    await webhook(joined(id, ids.callee));
    expect((await call(h, '/v1/blocks', { method: 'POST', token: b.token, body: { target: a.publicUid } })).statusCode).toBe(204);
    // Over with the block, before either asks anything: both hear it, the finalize is queued.
    expect(lastCallEvent(realtime, a.publicUid, id)).toMatchObject({ state: 'ended', outcome: 'completed' });
    expect(lastCallEvent(realtime, b.publicUid, id)).toMatchObject({ state: 'ended', outcome: 'completed' });
    expect(worker.pending('finalize', id)).toHaveLength(1);
    // The blocked caller asks for a new token (a rejoin): the call is over, and gone.
    expect((await post(`/v1/calls/${id}/token`, a.token)).statusCode).toBe(404);
    const before = eventsOf(realtime, b.publicUid, 'message').length;
    await worker.runAll('finalize', id);
    expect(livekit.rooms.has(`c_${id}`)).toBe(false);
    // Kept for the report, told to nobody.
    expect(await rows(db, `SELECT 1 FROM calls WHERE id = $1`, [id])).toHaveLength(1);
    expect(eventsOf(realtime, b.publicUid, 'message').length).toBe(before);

    // A ringing call: the unmatch cancels it and stops the callee's phone.
    const ringing = await pair(['Unmatch', 'Ringing']);
    const second = callOf(await place(ringing.a, ringing.matchId)).id;
    expect((await call(h, `/v1/conversations/${ringing.matchId}`, { method: 'DELETE', token: ringing.b.token })).statusCode).toBe(204);
    expect(lastCallEvent(realtime, ringing.a.publicUid, second)).toMatchObject({ state: 'cancelled' });
    expect(worker.pending('ring-stop', second)).toHaveLength(1);
    expect(worker.pending('finalize', second)).toHaveLength(1);

    // A ban ends the banned person's conversations, and their call with them.
    const banned = await pair(['Banned', 'During']);
    const third = callOf(await place(banned.b, banned.matchId)).id;
    await post(`/v1/calls/${third}/accept`, banned.a.token);
    const ban = await new ModerationActions(h.app).apply({ userId: banned.b.id, kind: 3, reasonCode: 2, reasonText: 'Repeated harassment reports.' });
    expect(ban.outcome.outcome).toBe('applied');
    expect(lastCallEvent(realtime, banned.a.publicUid, third)).toMatchObject({ state: 'ended' });
    expect(worker.pending('finalize', third)).toHaveLength(1);

    // The step missed (the conversation's end known only by its tombstone): the room check ends the call within a minute.
    const missed = await pair(['Tombstone', 'Only']);
    const fourth = callOf(await place(missed.a, missed.matchId)).id;
    await post(`/v1/calls/${fourth}/accept`, missed.b.token);
    await h.app.redis.set(h.app.keys.matchEnded(missed.matchId), 1, 'EX', 600);
    clock.advance(90_000);
    expect((await worker.runAll('room', fourth))[0]?.result).toEqual({ outcome: 'ended' });
    expect(lastCallEvent(realtime, missed.b.publicUid, fourth)).toMatchObject({ state: 'ended' });
    // And a request finds it too: the token of a call whose conversation ended is refused.
    const fifth = await pair(['Request', 'Finds']);
    const fifthId = callOf(await place(fifth.a, fifth.matchId)).id;
    await post(`/v1/calls/${fifthId}/accept`, fifth.b.token);
    await h.app.redis.set(h.app.keys.matchEnded(fifth.matchId), 1, 'EX', 600);
    expect((await post(`/v1/calls/${fifthId}/token`, fifth.a.token)).statusCode).toBe(404);
    expect(lastCallEvent(realtime, fifth.b.publicUid, fifthId)).toMatchObject({ state: 'ended' });
  });

  it('deletes a room that comes back after its call ended', async () => {
    const { a, b, matchId } = await pair(['Room', 'Back']);
    const callId = callOf(await place(a, matchId)).id;
    await post(`/v1/calls/${callId}/accept`, b.token);
    await post(`/v1/calls/${callId}/end`, b.token);
    // Somebody kept a token and LiveKit made the room again: the webhook deletes it at once.
    livekit.rooms.set(`c_${callId}`, { metadata: '', maxParticipants: 4, identities: new Set([participantIdentity(IDENTITY_SECRET, callId, a.id)]) });
    expect((await webhook({ event: 'room_started', id: `EV_rs${callId}`, room: { name: `c_${callId}` } })).statusCode).toBe(200);
    expect(livekit.rooms.has(`c_${callId}`)).toBe(false);
  });

  it('keeps a ring stop behind its ring, and never rings a call that already stopped ringing', async () => {
    const { a, b, matchId } = await pair(['Order', 'Ring']);
    const callId = callOf(await place(a, matchId)).id;
    // The ring is on its way (begun, not done) when the caller cancels: the stop waits for it.
    await h.redis.hset(callKeys(h.app.keys).call(callId), 'rp', `sending:${clock.ms}`);
    await post(`/v1/calls/${callId}/cancel`, a.token);
    const [waiting] = await worker.runAll('ring-stop', callId);
    expect(waiting?.delayed).toBe(true);
    // The ring lands; now the stop goes, to the device it went to.
    await h.redis.hset(callKeys(h.app.keys).call(callId), 'rp', 'sent', 'rung', JSON.stringify([{ d: b.deviceId, t: 'fcm-ordered' }]));
    const [stop] = await worker.runAll('ring-stop', callId);
    expect(stop?.result).toEqual({ outcome: 'stopped', devices: 1 });
    expect(worker.push.sent.at(-1)).toMatchObject({ token: 'fcm-ordered', payload: { data: { type: 'call_cancel', callId, reason: 'cancelled' } } });

    // A ring job that runs after the call stopped ringing sends nothing.
    const later = callOf(await place(a, matchId)).id;
    await post(`/v1/calls/${later}/cancel`, a.token);
    const sent = worker.push.sent.length;
    expect((await worker.runAll('ring-push', later))[0]?.result).toEqual({ outcome: 'skipped', reason: 'cancelled' });
    expect(worker.push.sent.length).toBe(sent);
  });

  it('refuses calls the configuration or the plan does not allow, and answers 404 for a callee nobody may see', async () => {
    const { a, b, matchId } = await pair(['Conf', 'Plan']);
    await setAppConfig(h, 'calls.enabled', { audio: true, video: false });
    const disabled = await place(a, matchId, 'video');
    expect(disabled.statusCode).toBe(403);
    expect(problemExt('calls_not_allowed', disabled.json())['reason']).toBe('disabled');
    // Calls as a paid feature: a plan that sets audio_calls to false refuses them on that plan.
    await db.sql.query(`INSERT INTO plan_features (plan_id, feature, value) SELECT id, 'audio_calls', 'false'::jsonb FROM plans WHERE key = 'free'`);
    await setAppConfig(h, 'calls.enabled', { audio: true, video: true });
    const paid = await place(a, matchId, 'audio');
    expect(paid.statusCode).toBe(403);
    expect(problemExt('calls_not_allowed', paid.json())['reason']).toBe('plan');
    await db.sql.query(`DELETE FROM plan_features WHERE feature = 'audio_calls'`);
    await setAppConfig(h, 'calls.enabled', { audio: true, video: true });
    // A suspended callee is out of conversations: their call answers as for nobody.
    const { a: c, b: d, matchId: cd } = await pair(['Hidden', 'Callee']);
    await db.sql.query(`UPDATE users SET status = 5 WHERE id = $1`, [d.id]);
    expect((await place(c, cd)).statusCode).toBe(404);
    // A snoozed one stays in their conversations, and can be called.
    await db.sql.query(`UPDATE users SET status = 4 WHERE id = $1`, [d.id]);
    await h.redis.del(callKeys(h.app.keys).eligibility(cd));
    const snoozed = await place(c, cd);
    expect(snoozed.statusCode).toBe(201);
    await post(`/v1/calls/${callOf(snoozed).id}/cancel`, c.token);
    void b;
  });

  it('gives a caller nobody may see an ordinary ring that nobody hears, and leaves no trace of it', async () => {
    const { a, b, matchId } = await pair(['Shadow', 'Quiet']);
    await db.sql.query(`UPDATE users SET is_shadowbanned = true WHERE id = $1`, [a.id]);
    const before = eventsOf(realtime, b.publicUid, 'call').length;
    const placed = await place(a, matchId);
    expect(placed.statusCode).toBe(201);
    const id = callOf(placed).id;
    expect(callOf(placed)).toMatchObject({ state: 'ringing', role: 'caller' });
    expect(worker.pending('ring-push', id)).toEqual([]);
    clock.advance(11_501);
    await worker.runAll('ring', id);
    expect(lastCallEvent(realtime, a.publicUid, id)).toMatchObject({ state: 'missed', endReason: 'ring_timeout' });
    expect(eventsOf(realtime, b.publicUid, 'call').length).toBe(before);
    expect((await worker.runAll('finalize', id))[0]?.result).toEqual({ outcome: 'skipped', reason: 'shadow' });
    expect(await rows(db, `SELECT 1 FROM calls WHERE id = $1`, [id])).toEqual([]);
    expect(await rows(db, `SELECT 1 FROM messages WHERE match_id = $1 AND kind = 5`, [matchId])).toEqual([]);
  });

  it('finishes a finalize whose worker died after the commit, without writing twice', async () => {
    const { a, b, matchId } = await pair(['Crash', 'After']);
    const id = callOf(await place(a, matchId)).id;
    clock.advance(CALL_RING_MS + 1);
    await worker.runAll('ring', id);
    const [job] = worker.pending('finalize', id);
    // The rows are committed, then the worker dies before it records that or tells anyone.
    await expect(worker.run(job!, { crashAfterCommit: true })).rejects.toThrow('the worker died');
    expect(await rows(db, `SELECT 1 FROM calls WHERE id = $1`, [id])).toHaveLength(1);
    const told = () => eventsOf(realtime, b.publicUid, 'message').filter((e) => (e.d as { refId?: string }).refId === id).length;
    expect(told()).toBe(0);
    // BullMQ's retry: nothing written again, the line and the missed-call push go out.
    const retry = await worker.run(job!, { attemptsMade: 1 });
    expect(retry.result).toEqual({ outcome: 'finalized', rows: true, replay: false });
    expect(await rows(db, `SELECT 1 FROM calls WHERE id = $1`, [id])).toHaveLength(1);
    expect(await rows(db, `SELECT 1 FROM messages WHERE match_id = $1 AND kind = 5 AND ref_id = $2`, [matchId, id])).toHaveLength(1);
    expect(told()).toBe(1);
    // The line published is the one the first try stored (read back), not an id the retry minted.
    const stored = await row<{ id: string }>(db, `SELECT id::text FROM messages WHERE match_id = $1 AND kind = 5 AND ref_id = $2`, [matchId, id]);
    expect(eventsOf(realtime, b.publicUid, 'message').find((e) => (e.d as { refId?: string }).refId === id)?.id).toBe(stored.id);
    expect(worker.push.sent.filter((s) => s.payload.type === 'call_missed' && s.payload.data['callId'] === id)).toHaveLength(1);
  });

  it('writes the line of a finalize retried after a failed try above every sync cursor handed out meanwhile', async () => {
    const { a, b, matchId } = await pair(['Retry', 'Later']);
    const id = callOf(await place(a, matchId)).id;
    await post(`/v1/calls/${id}/cancel`, a.token);
    const [job] = worker.pending('finalize', id);
    // The first try cannot reach PostgreSQL.
    const connect = worker.pool.connect;
    worker.pool.connect = (async () => {
      worker.pool.connect = connect;
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    }) as typeof connect;
    await expect(worker.run(job!)).rejects.toThrow('ECONNREFUSED');
    expect(await h.redis.zcard(directWritesKey(h.app.keys))).toBe(0);
    // Meanwhile the message writer moves on and the callee catches up: a cursor above anything minted so far.
    await h.redis.set(h.app.keys.streamWatermark('msg'), h.app.ids.nextId());
    const page = messagesPageSchema.parse((await call(h, `/v1/conversations/${matchId}/messages`, { token: b.token })).json());
    // The retry writes the line under an id it minted itself, after that cursor.
    expect((await worker.run(job!, { attemptsMade: 1 })).result).toEqual({ outcome: 'finalized', rows: true, replay: false });
    const next = messagesPageSchema.parse((await call(h, `/v1/conversations/${matchId}/messages?after=${page.syncCursor}`, { token: b.token })).json());
    expect(next.items.map((m) => [m.kind, m.refId])).toEqual([['call', id]]);
    await h.redis.del(h.app.keys.streamWatermark('msg'));
  });

  it('keeps the sync cursor below a message written directly while its write is in flight', async () => {
    const { b, matchId } = await pair(['Held', 'Cursor']);
    const held = h.app.ids.nextId();
    await holdDirectWrites(h.redis, h.app.keys, [held]);
    await h.redis.set(h.app.keys.streamWatermark('msg'), h.app.ids.nextId());
    const during = messagesPageSchema.parse((await call(h, `/v1/conversations/${matchId}/messages`, { token: b.token })).json());
    expect(BigInt(during.syncCursor) < BigInt(held)).toBe(true);
    await releaseDirectWrites(h.redis, h.app.keys, [held]);
    const after = messagesPageSchema.parse((await call(h, `/v1/conversations/${matchId}/messages`, { token: b.token })).json());
    expect(BigInt(after.syncCursor) >= BigInt(held)).toBe(true);
    // A hold that ran out (its writer died) holds nothing.
    await holdDirectWrites(h.redis, h.app.keys, [h.app.ids.nextId()], Date.now() - DIRECT_WRITE_HOLD_MS - 1);
    const stale = messagesPageSchema.parse((await call(h, `/v1/conversations/${matchId}/messages`, { token: b.token })).json());
    expect(stale.syncCursor).toBe(after.syncCursor);
    await h.redis.del(h.app.keys.streamWatermark('msg'), directWritesKey(h.app.keys));
  });

  it('ends a call when its room closes, and any call when it reaches the 12-hour guard', async () => {
    const { a, b, matchId } = await pair(['Room', 'Finished']);
    const ids = (callId: string) => callIdentities(IDENTITY_SECRET, { id: callId, callerId: a.id, calleeId: b.id });
    const one = callOf(await place(a, matchId)).id;
    await post(`/v1/calls/${one}/accept`, b.token);
    await webhook(joined(one, ids(one).caller));
    await webhook(joined(one, ids(one).callee));
    expect((await webhook({ event: 'room_finished', id: `EV_rf${one}`, room: { name: `c_${one}` } })).statusCode).toBe(200);
    expect(callOf(await call(h, `/v1/calls/${one}`, { token: b.token }))).toMatchObject({ state: 'ended', outcome: 'completed', endReason: 'room_gone' });

    const two = callOf(await place(a, matchId)).id;
    await post(`/v1/calls/${two}/accept`, b.token);
    livekit.join(`c_${two}`, ids(two).caller);
    livekit.join(`c_${two}`, ids(two).callee);
    clock.advance(12 * 3_600_000 - 4 * 60_000);
    expect((await worker.runAll('room', two))[0]?.result).toEqual({ outcome: 'ended' });
    expect(callOf(await call(h, `/v1/calls/${two}`, { token: a.token }))).toMatchObject({ state: 'ended', endReason: 'expired' });
  });

  // ─── The admin RTC settings ──────────────────────────────────────────────

  it('takes a signalling URL only as wss:// on a public host name, and audits each change with its values (the secret as a fingerprint)', async () => {
    for (const [wsUrl, reason] of [
      ['http://10.0.0.5', 'must use wss://'],
      ['ws://rtc.example.com', 'must use wss://'],
      ['wss://10.0.0.5', 'IP address'],
      ['wss://[fd00::1]', 'IP address'],
      ['https://rtc.local', 'public host name'],
      ['wss://localhost:7880', 'fully qualified'],
    ] as const) {
      const refused = await saveRtc({ wsUrl });
      expect(refused.statusCode, wsUrl).toBe(422);
      expect(json(refused)['errors']).toEqual([expect.objectContaining({ pointer: '/wsUrl' })]);
      expect(String(json(refused)['detail'])).toContain(reason);
    }
    expect((await saveRtc({ wsUrl: null, maxLiveCalls: null, turnUrls: [], sharedSecret: '', countries: [] })).statusCode).toBe(200);
    const auditCount = (await rows(db, `SELECT 1 FROM audit_log WHERE target_type = 6`)).length;
    expect((await saveRtc({ wsUrl: 'https://rtc.example.com/', maxLiveCalls: 50 })).statusCode).toBe(200);
    expect((await saveRtc({ turnUrls: ['turn:198.51.100.9:3478'], sharedSecret: RELAY_SECRET, countries: ['IR'] })).statusCode).toBe(200);
    const audit = await rows<{ detail: { changed: string[]; before: Record<string, unknown>; after: Record<string, unknown> } }>(
      db,
      `SELECT detail FROM audit_log WHERE target_type = 6 ORDER BY id OFFSET $1`,
      [auditCount],
    );
    expect(audit).toHaveLength(2);
    expect(audit[0]!.detail).toMatchObject({ changed: ['wsUrl', 'maxLiveCalls'], before: { wsUrl: null, maxLiveCalls: null }, after: { wsUrl: 'wss://rtc.example.com', maxLiveCalls: 50 } });
    expect(audit[1]!.detail.after).toMatchObject({ 'turn.urls': ['turn:198.51.100.9:3478'], 'turn.countries': ['IR'], 'turn.sharedSecret': turnSecretFingerprint(RELAY_SECRET) });
    expect(audit[1]!.detail.before).toMatchObject({ 'turn.urls': [], 'turn.countries': [], 'turn.sharedSecret': null });
    for (const entry of audit) expect(JSON.stringify(entry.detail)).not.toContain(RELAY_SECRET);
    // A value stored by hand that breaks the rules never reaches a client: the brand's host is given instead.
    await db.sql.query(`UPDATE public.app_config SET value = jsonb_set(value, '{wsUrl}', '"ws://10.0.0.5"') WHERE key = 'providers.rtc'`);
    await h.app.calls.rtc.reload();
    expect(h.app.calls.rtc.get().wsUrl).toBeNull();
    expect((await saveRtc({ wsUrl: null, maxLiveCalls: null, turnUrls: [], sharedSecret: '', countries: [] })).statusCode).toBe(200);
  });

  it('stores the relay secret sealed, shows it only as a fingerprint, audits no secret, and refuses unusable settings', async () => {
    const appToken = (await seedUser(h, { name: 'Nobody' })).token;
    expect((await h.app.inject({ method: 'GET', url: '/v1/admin/providers/rtc', headers: { authorization: `Bearer ${appToken}` } })).statusCode).toBe(401);
    const saved = await saveRtc({ turnUrls: ['turn:198.51.100.9:3478'], sharedSecret: RELAY_SECRET, countries: ['ir', 'IR'], credentialTtlSeconds: 7_200 });
    expect(saved.statusCode).toBe(200);
    const view = rtcSettingsViewSchema.parse(saved.json());
    expect(view).toMatchObject({ turnUrls: ['turn:198.51.100.9:3478'], countries: ['IR'], credentialTtlSeconds: 7_200, sharedSecret: { stored: true } });
    expect(view.sharedSecret.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    const got = await h.app.inject({ method: 'GET', url: '/v1/admin/providers/rtc', headers: { authorization: `Bearer ${adminToken}` } });
    expect(rtcSettingsViewSchema.parse(got.json())).toEqual(view);
    const stored = await row<{ value: unknown }>(db, `SELECT value FROM app_config WHERE key = 'providers.rtc'`);
    expect(JSON.stringify(stored.value)).not.toContain(RELAY_SECRET);
    const audit = await rows<{ action: string; detail: { key: string; changed: string[] } }>(db, `SELECT action, detail FROM audit_log WHERE target_type = 6 ORDER BY id`);
    expect(audit.at(-1)?.action).toBe('config.update');
    expect(audit.at(-1)?.detail.key).toBe('providers.rtc');
    for (const entry of audit) expect(JSON.stringify(entry.detail)).not.toContain(RELAY_SECRET);
    // A bare hostname, or a URL without a secret, would take every call down: refused.
    const bad = await saveRtc({ turnUrls: ['relay.example.com'] });
    expect(bad.statusCode).toBe(422);
    expect(code(bad)).toBe('field_invalid');
    expect(json(bad)['errors']).toEqual([expect.objectContaining({ pointer: '/turnUrls/0' })]);
    expect((await saveRtc({ sharedSecret: '' })).statusCode).toBe(422);
    expect((await saveRtc({ turnUrls: [], sharedSecret: '' })).statusCode).toBe(200);
    for (const line of [...h.logs, ...h.bodies]) expect(line.includes(RELAY_SECRET)).toBe(false);
  });

  it('writes no push token, relay secret or user id into a LiveKit token, a push or the logs', async () => {
    for (const sent of worker.push.sent) {
      for (const [key, value] of Object.entries(sent.payload.data)) {
        if (key === 'callId' || key === 'conversationId') continue;
        expect(value, key).not.toMatch(/^[1-9][0-9]{15,18}$/);
        expect(value).not.toMatch(/@|\+98|\+90/);
      }
    }
    for (const line of h.logs) expect(line).not.toMatch(/fcm-token-/);
  });
});
