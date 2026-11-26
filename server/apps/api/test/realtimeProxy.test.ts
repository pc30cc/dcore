import { randomBytes } from 'node:crypto';
import { statementCounter } from '@app/db';
import { realtimeTokenSchema, userChannel } from '@app/shared';
import { DenyList, FakeRealtimePublisher, accountJobNames, type DenyVerdict } from '@app/shared/server';
import type { LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SUBSCRIBE_PROXY_KEY_HEADER, SUBSCRIBE_PROXY_PATH, buildSubscribeProxy, type SubscribeProxy } from '../src/realtime/subscribeProxy.js';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, migratedDatabase, seedUser, type SeededUser, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, startAdminHarness, type AdminHarness } from './adminSupport.js';
import { refreshTokenFor } from './moderationSupport.js';
import { TEST_REDIS_URL, hasInfrastructure } from './support.js';

/**
 * The subscribe check Centrifugo calls for every subscription, against the
 * real routes that revoke access: a connection token minted before a
 * sign-out (this session or every one), a refresh-token reuse, a sign-out by
 * an admin, a suspension, a ban, a deletion (by the admin or in the app) or
 * an under-age closure is refused with disconnect 4501, while a token minted
 * after a new sign-in, or after a lift and a renewal, subscribes. A
 * shadowban changes nothing anyone can see. The check reads Valkey only (no
 * statement), fails closed and never answers `{}`.
 */

const KEY = 'proxy-test-key-0123456789abcdefghijklmnop';
const DAY_MS = 86_400_000;
const ADMIN_IP = '93.184.216.34';

interface Meta {
  sid: string;
  ati: number;
}

describe.skipIf(!hasInfrastructure)('the realtime subscribe check', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  let proxy: SubscribeProxy;
  let checks = 0;
  const realtime = new FakeRealtimePublisher();
  const jobs = new MemoryJobProducer();
  const answers: unknown[] = [];
  let adminToken = '';

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startAdminHarness(db, { CENTRIFUGO_PROXY_KEY: KEY }, { realtime, jobs });
    adminToken = (await adminAs(h, 'admin')).accessToken;
    const denyList = h.app.denyList;
    proxy = await buildSubscribeProxy({
      denyList: {
        check: (sid: string, uid: string | null, at: Date): Promise<DenyVerdict> => {
          checks += 1;
          return denyList.check(sid, uid, at);
        },
      },
      publicIds: h.app.publicIds,
      key: KEY,
      logger: pino({ level: 'silent' }),
    });
  }, 120_000);

  afterAll(async () => {
    // Whatever was asked, the check never allowed by an empty answer.
    for (const body of answers) expect(body).not.toEqual({});
    await proxy?.close();
    await h?.close();
    await db?.drop();
  });

  beforeEach(() => {
    realtime.failWith = null;
    jobs.jobs.length = 0;
  });

  /** The connection token's meta, as Centrifugo hands it to the check. */
  async function mint(token: string): Promise<{ token: string; meta: Meta }> {
    const res = await call(h, '/v1/realtime/token', { method: 'POST', token });
    expect(res.statusCode, res.body).toBe(200);
    const body = realtimeTokenSchema.parse(res.json());
    const payload = JSON.parse(Buffer.from(body.token.split('.')[1]!, 'base64url').toString('utf8')) as { meta: Meta };
    return { token: body.token, meta: payload.meta };
  }

  async function ask(body: unknown, headers: Record<string, string> = { [SUBSCRIBE_PROXY_KEY_HEADER]: KEY }, target: SubscribeProxy = proxy): Promise<LightMyRequestResponse> {
    const res = await target.inject({ method: 'POST', url: SUBSCRIBE_PROXY_PATH, headers, payload: body as Record<string, unknown> });
    if (res.statusCode === 200) answers.push(res.json());
    return res;
  }

  /** What Centrifugo sends for a subscription of `user` to `channel`. */
  function request(user: string, meta: unknown, channel = userChannel(user)) {
    return { client: randomBytes(8).toString('hex'), transport: 'websocket', protocol: 'json', encoding: 'json', user, channel, ...(meta === undefined ? {} : { meta }) };
  }

  async function verdict(user: SeededUser, meta: Meta): Promise<unknown> {
    const res = await ask(request(user.publicUid, meta));
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  const ALLOWED = { result: {} };
  const REVOKED = { disconnect: { code: 4501, reason: 'revoked' } };

  /** A second session of the same person (another phone), with its own access token. */
  async function secondSession(user: SeededUser): Promise<string> {
    const sessionId = h.app.ids.nextId();
    await db.sql.query(
      `INSERT INTO sessions (id, user_id, device_id, expires_at, store, refresh_hash) VALUES ($1, $2, $3, now() + interval '30 days', 2, $4)`,
      [sessionId, user.id, user.deviceId, randomBytes(32)],
    );
    return (await h.app.tokens.issue({ kind: 'app', subject: user.publicUid, sessionId, deviceId: user.deviceId, storeCode: 2, scope: 'full' })).token;
  }

  /** A later sign-in: a new session whose tokens are issued after the revocation's cutoff (whole seconds). */
  async function laterSignIn(user: SeededUser): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    return secondSession(user);
  }

  async function penalty(user: SeededUser, kind: 'suspend' | 'ban' | 'shadowban', body: Record<string, unknown>) {
    const res = await admin(h, `/v1/admin/users/${user.publicUid}/${kind}`, body, { token: adminToken, ip: ADMIN_IP });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ action: { id: string }; sideEffects: string }>();
  }

  async function longDenyKey(key: string): Promise<void> {
    // Access TTL 900 + skew 30 + margin 30 + the connection token's 3600 + Centrifugo's close delay 25.
    expect(await h.redis.pttl(`${h.prefix}${key}`)).toBeGreaterThan((900 + 30 + 30 + 3_600 + 25 - 10) * 1_000);
  }

  // ─── The check itself ──────────────────────────────────────────────────

  it('answers only Centrifugo: no key or a wrong one is 401 with an empty body', async () => {
    const user = await seedUser(h, { name: 'Key' });
    const { meta } = await mint(user.token);
    for (const headers of [{}, { [SUBSCRIBE_PROXY_KEY_HEADER]: 'wrong' }, { [SUBSCRIBE_PROXY_KEY_HEADER]: `${KEY}x` }]) {
      const res = await ask(request(user.publicUid, meta), headers);
      expect(res.statusCode).toBe(401);
      expect(res.body).toBe('');
    }
  });

  it('lets the person subscribe to their own channel from Valkey alone: no statement, one deny-list read', async () => {
    const user = await seedUser(h, { name: 'Own' });
    const { meta } = await mint(user.token);
    const before = checks;
    const { result, tally } = await statementCounter.measure(() => ask(request(user.publicUid, meta)));
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual(ALLOWED);
    expect(tally.statements).toBe(0);
    expect(checks - before).toBe(1);
  });

  it("refuses someone else's channel, a malformed user and a channel outside the personal namespace", async () => {
    const user = await seedUser(h, { name: 'Self' });
    const other = await seedUser(h, { name: 'Other' });
    const { meta } = await mint(user.token);
    const denied = { error: { code: 403, message: 'permission denied' } };
    for (const body of [
      request(user.publicUid, meta, userChannel(other.publicUid)),
      request('NOT-A-PUBLIC-ID', meta, 'user:#NOT-A-PUBLIC-ID'),
      request(user.publicUid, meta, user.publicUid),
      request(user.publicUid, meta, `other:#${user.publicUid}`),
      { user: user.publicUid },
    ]) {
      const res = await ask(body);
      expect(res.statusCode).toBe(200);
      expect(res.json(), JSON.stringify(body)).toEqual(denied);
    }
  });

  it('closes a connection whose token carries no meta, or a malformed one', async () => {
    const user = await seedUser(h, { name: 'Meta' });
    for (const meta of [undefined, null, {}, { sid: 'x', ati: 1 }, { sid: user.sessionId, ati: 'now' }, { sid: user.sessionId, ati: -1 }, 'meta']) {
      const res = await ask(request(user.publicUid, meta));
      expect(res.json(), JSON.stringify(meta)).toEqual(REVOKED);
    }
  });

  it('fails closed with a temporary error when Valkey cannot be read', async () => {
    const dead = new Redis(TEST_REDIS_URL ?? '', { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0 });
    const blind = await buildSubscribeProxy({
      denyList: new DenyList({ redis: dead, keys: h.app.keys, accessTokenTtlSeconds: 900, clockSkewSeconds: 30, realtimeTokenTtlSeconds: 3_600 }),
      publicIds: h.app.publicIds,
      key: KEY,
      logger: pino({ level: 'silent' }),
    });
    try {
      const user = await seedUser(h, { name: 'Blind' });
      const { meta } = await mint(user.token);
      const res = await ask(request(user.publicUid, meta), { [SUBSCRIBE_PROXY_KEY_HEADER]: KEY }, blind);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ error: { code: 503, message: 'try again', temporary: true } });
    } finally {
      await blind.close();
      dead.disconnect();
    }
  });

  it('is no route of the public API', async () => {
    const res = await h.app.inject({ method: 'POST', url: SUBSCRIBE_PROXY_PATH, headers: { [SUBSCRIBE_PROXY_KEY_HEADER]: KEY }, payload: {} });
    expect(res.statusCode).toBe(404);
  });

  // ─── Every revocation ends the tokens minted before it ─────────────────

  it('signing out here refuses this session only; the other phone still subscribes', async () => {
    const user = await seedUser(h, { name: 'Two Phones' });
    const other = await secondSession(user);
    const here = (await mint(user.token)).meta;
    const there = (await mint(other)).meta;
    expect((await call(h, '/v1/auth/logout', { method: 'POST', token: user.token, body: {} })).statusCode).toBe(204);
    expect(await verdict(user, here)).toEqual(REVOKED);
    expect(await verdict(user, there)).toEqual(ALLOWED);
    expect(realtime.disconnected).toContain(user.publicUid);
    await longDenyKey(`deny:sid:${user.sessionId}`);
  });

  it('signing out everywhere refuses every session; a later sign-in subscribes', async () => {
    const user = await seedUser(h, { name: 'Everywhere' });
    const other = await secondSession(user);
    const metas = [(await mint(user.token)).meta, (await mint(other)).meta];
    const kicked = realtime.disconnected.length;
    expect((await call(h, '/v1/auth/logout', { method: 'POST', token: user.token, body: { all: true } })).statusCode).toBe(204);
    for (const meta of metas) expect(await verdict(user, meta)).toEqual(REVOKED);
    expect(realtime.disconnected.slice(kicked)).toEqual([user.publicUid]);
    await longDenyKey(`deny:uid:${user.id}`);
    const fresh = (await mint(await laterSignIn(user))).meta;
    expect(await verdict(user, fresh)).toEqual(ALLOWED);
  });

  it('a reused refresh token revokes its session for realtime too', async () => {
    const user = await seedUser(h, { name: 'Reuse' });
    const before = (await mint(user.token)).meta;
    const refreshToken = await refreshTokenFor(h, user);
    const first = await call(h, '/v1/auth/refresh', { method: 'POST', body: { refreshToken } });
    expect(first.statusCode, first.body).toBe(200);
    const renewed = (await mint(first.json<{ accessToken: string }>().accessToken)).meta;
    expect(await verdict(user, renewed)).toEqual(ALLOWED);
    // Past the refresh grace (the harness's 300 ms, the database's whole second).
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const again = await call(h, '/v1/auth/refresh', { method: 'POST', body: { refreshToken } });
    expect(again.json()).toMatchObject({ code: 'refresh_reused' });
    for (const meta of [before, renewed]) expect(await verdict(user, meta)).toEqual(REVOKED);
    expect(realtime.disconnected).toContain(user.publicUid);
  });

  it('a sign-out by an admin, a suspension, a ban and a deletion by an admin refuse the tokens minted before them', async () => {
    const actions: [string, (user: SeededUser) => Promise<void>][] = [
      ['revoke-sessions', async (user) => void expect((await admin(h, `/v1/admin/users/${user.publicUid}/revoke-sessions`, {}, { token: adminToken, ip: ADMIN_IP })).statusCode).toBe(200)],
      ['suspend', async (user) => void (await penalty(user, 'suspend', { reason: 'spam', reasonText: 'A pause.', endsAt: new Date(Date.now() + DAY_MS).toISOString() }))],
      ['ban', async (user) => void (await penalty(user, 'ban', { reason: 'scam', reasonText: 'Scam.' }))],
      ['delete', async (user) => void expect((await admin(h, `/v1/admin/users/${user.publicUid}/delete`, {}, { token: adminToken, ip: ADMIN_IP })).statusCode).toBe(200)],
    ];
    for (const [name, act] of actions) {
      const user = await seedUser(h, { name: `Admin ${name}` });
      const { meta } = await mint(user.token);
      expect(await verdict(user, meta), name).toEqual(ALLOWED);
      await act(user);
      expect(await verdict(user, meta), name).toEqual(REVOKED);
      expect(realtime.disconnected, name).toContain(user.publicUid);
      await longDenyKey(`deny:uid:${user.id}`);
    }
  });

  it('a suspension lifted and renewed subscribes again; the token from before stays refused', async () => {
    const user = await seedUser(h, { name: 'Lifted' });
    const before = (await mint(user.token)).meta;
    const refreshToken = await refreshTokenFor(h, user);
    const suspension = await penalty(user, 'suspend', { reason: 'spam', reasonText: 'A pause.', endsAt: new Date(Date.now() + DAY_MS).toISOString() });
    expect((await admin(h, `/v1/admin/users/${user.publicUid}/lift`, { actionId: suspension.action.id }, { token: adminToken, ip: ADMIN_IP })).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const renewed = await call(h, '/v1/auth/refresh', { method: 'POST', body: { refreshToken } });
    expect(renewed.statusCode, renewed.body).toBe(200);
    const after = (await mint(renewed.json<{ accessToken: string }>().accessToken)).meta;
    expect(await verdict(user, after)).toEqual(ALLOWED);
    expect(await verdict(user, before)).toEqual(REVOKED);
  });

  it('a deletion in the app and an under-age closure refuse the tokens minted before them', async () => {
    const deleting = await seedUser(h, { name: 'Leaving' });
    const kept = (await mint(deleting.token)).meta;
    expect((await call(h, '/v1/me/deletion', { method: 'POST', token: deleting.token, body: {} })).statusCode).toBe(202);
    expect(await verdict(deleting, kept)).toEqual(REVOKED);
    expect(realtime.disconnected).toContain(deleting.publicUid);

    const kid = await seedUser(h, { status: 1, name: 'Kid' });
    const minted = (await mint(kid.token)).meta;
    const young = new Date();
    young.setUTCFullYear(young.getUTCFullYear() - 17);
    const closed = await call(h, '/v1/me/basics', { method: 'PUT', token: kid.token, body: { birthDate: young.toISOString().slice(0, 10), gender: 'woman', consents: { terms: 1, privacy: 1 } } });
    expect(closed.json()).toMatchObject({ code: 'under_age' });
    expect(await verdict(kid, minted)).toEqual(REVOKED);
    expect(realtime.disconnected).toContain(kid.publicUid);
  });

  it('a shadowban changes nothing the person or the check shows: same answer, no kick', async () => {
    const user = await seedUser(h, { name: 'Shadowed' });
    const { meta } = await mint(user.token);
    const before = await ask(request(user.publicUid, meta));
    const kicked = realtime.disconnected.length;
    await penalty(user, 'shadowban', { reason: 'spam' });
    const after = await ask(request(user.publicUid, meta));
    expect(after.body).toBe(before.body);
    expect(after.headers['content-type']).toBe(before.headers['content-type']);
    expect(realtime.disconnected.length).toBe(kicked);
    expect(await h.redis.exists(`${h.prefix}deny:uid:${user.id}`)).toBe(0);
  });

  it('never fails the request when the kick fails: the worker gets a realtime-end job', async () => {
    const user = await seedUser(h, { name: 'Kick Failed' });
    const { meta } = await mint(user.token);
    realtime.failWith = new Error('centrifugo unreachable');
    expect((await call(h, '/v1/auth/logout', { method: 'POST', token: user.token, body: { all: true } })).statusCode).toBe(204);
    expect(await verdict(user, meta)).toEqual(REVOKED);
    expect(jobs.jobs.filter((j) => j.name === accountJobNames.realtimeEnd).map((j) => j.data['userId'])).toEqual([user.id]);

    // A ban whose realtime side failed is queued as well (its answer says so).
    const banned = await seedUser(h, { name: 'Ban Kick Failed' });
    jobs.jobs.length = 0;
    const result = await penalty(banned, 'ban', { reason: 'scam', reasonText: 'Scam.' });
    expect(result.sideEffects).toBe('failed');
    expect(jobs.jobs.filter((j) => j.name === accountJobNames.realtimeEnd).map((j) => j.data['userId'])).toEqual([banned.id]);
  });
});
