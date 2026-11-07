import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { deletionPreflightSchema, deletionScheduledSchema, meSchema, publicDeletionChallengeSchema, restoredAccountSchema } from '@app/shared';
import { FakeGoogleIdTokenVerifier, FakeSmsSender, accountJobIds, hashDomains } from '@app/shared/server';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthSettingsHolder, DEFAULT_AUTH_SETTINGS } from '../src/auth/settings.js';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { hasInfrastructure } from './support.js';
import { call, migratedDatabase, problemExt, row, seedUser, setAppConfig, startHarness, statements, type Harness, type SeededUser, type TestDatabase } from './accountSupport.js';

/**
 * Account deletion against PostgreSQL and Valkey: in the app (preflight,
 * deletion, restore) and on the website without signing in (by phone and
 * by Google, as JSON and as plain form posts), with their statement
 * budgets and their limits.
 */

const SITE = 'https://site.test.invalid';
const GOOGLE_CLIENT = 'deletion-web-client.apps.example';
const CELL = '608692970769612799';
const POINT = 'ST_SetSRID(ST_MakePoint(-122.42, 37.77), 4326)::geography';
const DAY_MS = 86_400_000;
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

let phoneSeq = 0;
function mobileNumber(): string {
  phoneSeq += 1;
  return `+98912${String(Date.now() % 10_000).padStart(4, '0')}${String(phoneSeq).padStart(3, '0')}`;
}

/** Persian digits, as a person types them on a Persian keyboard. */
function persian(digits: string): string {
  return digits.replace(/[0-9]/g, (d) => String.fromCharCode(0x06f0 + Number(d)));
}

describe.skipIf(!hasInfrastructure)('account deletion', () => {
  let db: TestDatabase;
  let h: Harness;
  const jobs = new MemoryJobProducer();
  const sms = { kavenegar: new FakeSmsSender('kavenegar'), smsir: new FakeSmsSender('smsir'), telnyx: new FakeSmsSender('telnyx') };
  const google = new FakeGoogleIdTokenVerifier();
  const settings = new AuthSettingsHolder({ ...DEFAULT_AUTH_SETTINGS, caps: { ...DEFAULT_AUTH_SETTINGS.caps, verify_ip_hourly: 1_000 } });
  let ip = 0;
  const rawIds: string[] = [];

  beforeAll(async () => {
    db = await migratedDatabase();
    h = await startHarness(
      db,
      { SITE_ORIGIN: SITE, GOOGLE_WEB_CLIENT_ID: GOOGLE_CLIENT },
      { jobs, authServices: { smsSenders: Object.values(sms), google, authSettings: settings } },
    );
    // The config loader sets the seeded sign-in settings on every load; this suite's caps win.
    settings.set({ ...DEFAULT_AUTH_SETTINGS, caps: { ...DEFAULT_AUTH_SETTINGS.caps, verify_ip_hourly: 1_000 } });
  }, 60_000);
  afterAll(async () => {
    // No response named a person by their raw id; no log line carries a phone number.
    for (const id of rawIds) for (const body of h?.bodies ?? []) expect(body.includes(id), `raw id ${id} in a response`).toBe(false);
    expect((h?.logs ?? []).join('\n')).not.toMatch(/\+98912\d{7}|0912\d{7}/);
    await h?.close();
    await db?.drop();
  });

  const seed = async (options: Parameters<typeof seedUser>[1] = {}) => {
    const user = await seedUser(h, options);
    rawIds.push(user.id);
    return user;
  };

  /** A distinct client address per test, so the per-IP limits of one test do not reach the next. */
  function nextIp(): string {
    ip += 1;
    return `198.51.100.${ip}`;
  }

  async function post(url: string, body: unknown, options: { form?: boolean; ip?: string; headers?: Record<string, string> } = {}): Promise<LightMyRequestResponse> {
    const payload = options.form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body);
    const response = await h.app.inject({
      method: 'POST',
      url,
      payload,
      remoteAddress: options.ip ?? '203.0.113.9',
      headers: { 'content-type': options.form ? FORM['content-type'] : 'application/json', ...options.headers },
    });
    h.bodies.push(response.body);
    return response;
  }

  async function value<T>(text: string, values: unknown[] = []): Promise<T> {
    return Object.values(await row<Record<string, T>>(db, text, values))[0] as T;
  }

  /** A complete, discoverable account (so its discovery row can be seen to go). */
  async function discoverable(user: SeededUser): Promise<void> {
    await db.sql.query(`INSERT INTO preferences (user_id, interested_in) VALUES ($1, 2) ON CONFLICT DO NOTHING`, [user.id]);
    await db.sql.query(`INSERT INTO user_locations (user_id, home_h3, source, country, home_geo) VALUES ($1, $2, 1, 'IR', ${POINT})`, [user.id, CELL]);
    await db.sql.query(`INSERT INTO photos (id, user_id, position, status, width, height) VALUES ($2, $1, 0, 3, 10, 10), ($3, $1, 1, 3, 10, 10)`, [
      user.id,
      h.app.ids.nextId(),
      h.app.ids.nextId(),
    ]);
  }

  async function discovered(userId: string): Promise<boolean> {
    return value<boolean>(`SELECT EXISTS (SELECT 1 FROM discovery WHERE user_id = $1)`, [userId]);
  }

  async function withPhone(user: SeededUser, e164: string): Promise<void> {
    const subject = h.app.secrets.hasher.hashAll(hashDomains.phone, e164)[0]!;
    await db.sql.query(`INSERT INTO auth_identities (id, user_id, provider, hash_kid, subject_hash) VALUES ($1, $2, 1, $3, $4)`, [h.app.ids.nextId(), user.id, subject.kid, subject.hash]);
  }

  async function withGoogle(user: SeededUser, sub: string): Promise<void> {
    const subject = h.app.secrets.hasher.hashAll(hashDomains.google, sub)[0]!;
    await db.sql.query(`INSERT INTO auth_identities (id, user_id, provider, hash_kid, subject_hash) VALUES ($1, $2, 2, $3, $4)`, [h.app.ids.nextId(), user.id, subject.kid, subject.hash]);
  }

  async function match(a: string, b: string): Promise<string> {
    const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
    const id = h.app.ids.nextId();
    await db.sql.query(`INSERT INTO matches (id, user_lo, user_hi, source) VALUES ($1, $2, $3, 1)`, [id, lo, hi]);
    return id;
  }

  /** The code the fake provider sent to `e164`, once the background send has run. */
  async function codeFor(e164: string): Promise<string> {
    for (let i = 0; i < 100; i += 1) {
      const code = sms.kavenegar.codeFor(e164);
      if (code) return code;
      await sleep(10);
    }
    throw new Error('no code was sent');
  }

  function jobsFor(userId: string) {
    return jobs.jobs.filter((job) => job.data['userId'] === userId);
  }

  // ─── In the app ──────────────────────────────────────────────────────────

  describe('in the app', () => {
    it('warns about a renewing store subscription before deleting, in one read', async () => {
      const user = await seed({ name: 'Ada' });
      const none = await call(h, '/v1/me/deletion/preflight', { token: user.token });
      expect(none.statusCode).toBe(200);
      expect(statements(none)).toBe(1);
      expect(deletionPreflightSchema.strict().parse(none.json())).toEqual({});

      const product = await row<{ id: number; product_id: string }>(db, `SELECT id, product_id FROM store_products WHERE store = 1 AND kind = 1 ORDER BY id LIMIT 1`);
      const purchase = h.app.ids.nextId();
      const token = `token-${randomBytes(8).toString('hex')}`;
      await db.sql.query(
        `INSERT INTO store_purchases (id, user_id, purchased_at, expires_at, product_ref, store, kind, state, token_hash, token)
         VALUES ($1, $2, now(), now() + interval '20 days', $3, 1, 1, 2, sha256(convert_to($4, 'UTF8')), $4)`,
        [purchase, user.id, product.id, token],
      );
      await db.sql.query(`INSERT INTO subscriptions (user_id, started_at, expires_at, purchase_id, plan_id, store, status) VALUES ($1, now(), now() + interval '20 days', $2, 2, 1, 1)`, [
        user.id,
        purchase,
      ]);
      const renewing = await call(h, '/v1/me/deletion/preflight', { token: user.token });
      const body = deletionPreflightSchema.parse(renewing.json());
      expect(body.subscription).toMatchObject({ store: 'play', active: true });
      const url = new URL(body.subscription?.manageUrl ?? '');
      expect(url.origin + url.pathname).toBe('https://play.google.com/store/account/subscriptions');
      expect(url.searchParams.get('sku')).toBe(product.product_id);
      expect(url.searchParams.get('package')).toBe('com.example.app');
    });

    it('deletes in one statement: status 7, sessions revoked, conversations ended, discovery row gone, jobs queued', async () => {
      const user = await seed({ name: 'Bea', interestedIn: 2 });
      await discoverable(user);
      expect(await discovered(user.id)).toBe(true);
      const peer = await seed({ name: 'Cem' });
      const conversation = await match(user.id, peer.id);

      const response = await call(h, '/v1/me/deletion', { method: 'POST', token: user.token, body: { reason: 'break' } });
      expect(response.statusCode).toBe(202);
      expect(statements(response)).toBe(1);
      const { purgeAt } = deletionScheduledSchema.strict().parse(response.json());

      const state = await row<{ status: number; deleted_via: number; restore_status: number; deleted_ms: string }>(
        db,
        `SELECT status, deleted_via, restore_status, floor(extract(epoch FROM deleted_at) * 1000)::bigint::text AS deleted_ms FROM users WHERE id = $1`,
        [user.id],
      );
      expect(state).toMatchObject({ status: 7, deleted_via: 1, restore_status: 3 });
      const deletedAtMs = Number(state.deleted_ms);
      expect(Date.parse(purgeAt) - deletedAtMs).toBe(30 * DAY_MS);
      expect(await discovered(user.id)).toBe(false);
      expect(await row(db, `SELECT revoke_reason FROM sessions WHERE id = $1`, [user.sessionId])).toEqual({ revoke_reason: 6 });
      expect(await row(db, `SELECT state, ended_by FROM matches WHERE id = $1`, [conversation])).toEqual({ state: 4, ended_by: 3 });

      // The fan-out at once, the purge at the purge time.
      const queued = jobsFor(user.id);
      expect(queued.map((j) => [j.queue, j.name, j.id])).toEqual([
        ['account', 'deletion-fanout', accountJobIds.fanout(user.id, deletedAtMs)],
        ['account', 'purge', accountJobIds.purge(user.id, deletedAtMs)],
      ]);
      expect(queued[1]!.options.delayMs).toBeGreaterThan(30 * DAY_MS - 60_000);
      expect(queued[1]!.data).toEqual({ userId: user.id, deletedAtMs, purgeAtMs: Date.parse(purgeAt) });
      // The reason is counted under its key; nothing else is kept of it.
      const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
      expect(await h.redis.get(`${h.prefix}ev:deletion.break:${day}`)).toBe('1');

      // Every access token issued before the deletion stops at once.
      const after = await call(h, '/v1/me', { token: user.token });
      expect(after.statusCode).toBe(401);

      // A session that signs in again is a restore session: it sees the deleted form.
      await sleep(1_100);
      const later = (await h.app.tokens.issue({ kind: 'app', subject: user.publicUid, sessionId: h.app.ids.nextId(), storeCode: 2, scope: 'restore' })).token;
      const me = await call(h, '/v1/me', { token: later });
      expect(me.statusCode).toBe(200);
      expect(meSchema.parse(me.json())).toEqual({ id: user.publicUid, status: 'deleted', deletion: { purgeAt } });
    });

    it('answers a second deletion with the same purge time, changing nothing', async () => {
      const user = await seed({ name: 'Dan' });
      const first = await call(h, '/v1/me/deletion', { method: 'POST', token: user.token, body: {} });
      expect(first.statusCode).toBe(202);
      await sleep(1_100);
      // A token issued after the cutoff (as if the first answer's steps had to be sent again).
      const again = (await h.app.tokens.issue({ kind: 'app', subject: user.publicUid, sessionId: user.sessionId, storeCode: 2, scope: 'full' })).token;
      const second = await call(h, '/v1/me/deletion', { method: 'POST', token: again });
      expect(second.statusCode, second.body).toBe(202);
      expect(statements(second)).toBe(2);
      expect(second.json()).toEqual(first.json());
      expect(jobsFor(user.id)).toHaveLength(2);
    });

    it('lets a banned account delete itself, and restores it banned', async () => {
      const user = await seed({ status: 6, scope: 'restricted', name: 'Eda' });
      await db.sql.query(`INSERT INTO moderation_actions (id, user_id, kind, reason_code, reason_text) VALUES ($1, $2, 3, 1, 'Ban')`, [h.app.ids.nextId(), user.id]);
      await h.app.account.changed(user.id);
      const deleted = await call(h, '/v1/me/deletion', { method: 'POST', token: user.token, body: {} });
      expect(deleted.statusCode).toBe(202);
      await sleep(1_100);
      const restore = (await h.app.tokens.issue({ kind: 'app', subject: user.publicUid, sessionId: h.app.ids.nextId(), storeCode: 2, scope: 'restore' })).token;
      const restored = await call(h, '/v1/me/restore', { method: 'POST', token: restore });
      expect(restored.statusCode).toBe(200);
      expect(restoredAccountSchema.parse(restored.json()).user.status).toBe('banned');
    });

    it('restores within the grace in one statement, to the status it had, and refuses after it', async () => {
      const user = await seed({ name: 'Fay', interestedIn: 2 });
      await discoverable(user);
      await call(h, '/v1/me/deletion', { method: 'POST', token: user.token, body: {} });
      expect(await discovered(user.id)).toBe(false);
      await sleep(1_100);
      const restore = (await h.app.tokens.issue({ kind: 'app', subject: user.publicUid, sessionId: h.app.ids.nextId(), storeCode: 2, scope: 'restore' })).token;
      // A restore session reaches nothing else.
      const other = await call(h, '/v1/me/deletion/preflight', { token: restore });
      expect(other.statusCode).toBe(403);
      expect(problemExt('account_deleted', other.json()).restorableUntil).toEqual(expect.any(String));

      const restored = await call(h, '/v1/me/restore', { method: 'POST', token: restore });
      expect(restored.statusCode).toBe(200);
      expect(statements(restored)).toBe(1);
      expect(restoredAccountSchema.strict().parse(restored.json())).toEqual({ user: { id: user.publicUid, status: 'active', onboardingStep: 0 } });
      expect(await row(db, `SELECT status, deleted_at, restore_status FROM users WHERE id = $1`, [user.id])).toEqual({ status: 3, deleted_at: null, restore_status: null });
      expect(await discovered(user.id)).toBe(true);
      // The view moved: the restore session now reads the account as active (a refresh brings the full scope).
      const me = await call(h, '/v1/me', { token: restore });
      expect(me.statusCode).toBe(200);
      expect(meSchema.parse(me.json()).status).toBe('active');
      // A retried restore answers the account as it is.
      const again = await call(h, '/v1/me/restore', { method: 'POST', token: restore });
      expect(again.statusCode).toBe(200);
      expect(statements(again)).toBe(2);

      const late = await seed({ name: 'Gul' });
      await call(h, '/v1/me/deletion', { method: 'POST', token: late.token, body: {} });
      await db.sql.query(`UPDATE users SET deleted_at = now() - interval '31 days' WHERE id = $1`, [late.id]);
      await h.app.account.changed(late.id);
      await sleep(1_100);
      const lateRestore = (await h.app.tokens.issue({ kind: 'app', subject: late.publicUid, sessionId: h.app.ids.nextId(), storeCode: 2, scope: 'restore' })).token;
      const refused = await call(h, '/v1/me/restore', { method: 'POST', token: lateRestore });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'conflict' });
    });

    it('answers old builds too (deletion always works), and follows a lengthened grace', async () => {
      await setAppConfig(h, 'app.min_version', { cafe_bazaar: { required: 500, recommended: 500 }, google_play: { required: 500, recommended: 500 } });
      try {
        const user = await seed({ name: 'Hal' });
        const old = await call(h, '/v1/me/deletion', { method: 'POST', token: user.token, body: {}, client: 'bazaar/120' });
        expect(old.statusCode).toBe(202);
      } finally {
        await setAppConfig(h, 'app.min_version', { cafe_bazaar: { required: 1, recommended: 1 }, google_play: { required: 1, recommended: 1 } });
      }
      await setAppConfig(h, 'retention.deleted_account_days', 45);
      try {
        const user = await seed({ name: 'Ilk' });
        const response = await call(h, '/v1/me/deletion', { method: 'POST', token: user.token, body: {} });
        const deletedMs = Number(await value<string>(`SELECT floor(extract(epoch FROM deleted_at) * 1000)::bigint::text FROM users WHERE id = $1`, [user.id]));
        expect(Date.parse(deletionScheduledSchema.parse(response.json()).purgeAt) - deletedMs).toBe(45 * DAY_MS);
      } finally {
        await setAppConfig(h, 'retention.deleted_account_days', 30);
      }
    });
  });

  // ─── On the website, by phone ────────────────────────────────────────────

  describe('on the website by phone', () => {
    it('answers the start identically for an unknown number, and sends no code to it', async () => {
      const known = await seed({ name: 'Jan' });
      const knownNumber = mobileNumber();
      await withPhone(known, knownNumber);
      const unknownNumber = mobileNumber();

      const a = await post('/v1/public/account-deletion/start', { phone: knownNumber, locale: 'fa' }, { ip: nextIp() });
      const b = await post('/v1/public/account-deletion/start', { phone: unknownNumber, locale: 'fa' }, { ip: nextIp() });
      for (const response of [a, b]) {
        expect(response.statusCode).toBe(202);
        expect(statements(response)).toBe(1);
        expect(publicDeletionChallengeSchema.strict().parse(response.json()).codeLength).toBe(6);
        expect(response.headers['cache-control']).toBe('no-store');
      }
      const strip = (r: LightMyRequestResponse) => {
        const { 'x-request-id': _id, date: _date, 'content-length': _length, ...rest } = r.headers;
        return rest;
      };
      expect(strip(a)).toEqual(strip(b));
      expect(Object.keys(a.json())).toEqual(Object.keys(b.json()));
      expect(await codeFor(knownNumber)).toMatch(/^[0-9]{6}$/);
      await sleep(50);
      expect(sms.kavenegar.sent.some((m) => m.phone === unknownNumber)).toBe(false);
      expect(sms.smsir.sent.some((m) => m.phone === unknownNumber)).toBe(false);
      // No code in Valkey in clear, no number either.
      const keys = await h.redis.keys(`${h.prefix}*`);
      for (const key of keys) expect(key).not.toContain(knownNumber.slice(1));
    });

    it('deletes with the code (JSON), with the web page as its reason, and the same sessions and discovery rules', async () => {
      const user = await seed({ name: 'Kai', interestedIn: 2 });
      await discoverable(user);
      const number = mobileNumber();
      await withPhone(user, number);
      const address = nextIp();
      const start = await post('/v1/public/account-deletion/start', { phone: number, locale: 'en' }, { ip: address });
      const { requestToken } = publicDeletionChallengeSchema.parse(start.json());
      const code = await codeFor(number);
      const wrongCode = code === '000000' ? '111111' : '000000';

      const wrong = await post('/v1/public/account-deletion/confirm', { requestToken, code: wrongCode }, { ip: address });
      expect(wrong.statusCode).toBe(400);
      expect(problemExt('otp_invalid', wrong.json()).attemptsLeft).toBe(4);
      expect(statements(wrong)).toBe(0);

      const right = await post('/v1/public/account-deletion/confirm', { requestToken, code }, { ip: address });
      expect(right.statusCode).toBe(202);
      expect(statements(right)).toBe(1);
      deletionScheduledSchema.strict().parse(right.json());
      expect(await row(db, `SELECT status, deleted_via FROM users WHERE id = $1`, [user.id])).toEqual({ status: 7, deleted_via: 2 });
      expect(await row(db, `SELECT revoke_reason FROM sessions WHERE id = $1`, [user.sessionId])).toEqual({ revoke_reason: 6 });
      expect(await discovered(user.id)).toBe(false);
      expect(jobsFor(user.id).map((j) => j.name)).toEqual(['deletion-fanout', 'purge']);
      // The code works once.
      const replay = await post('/v1/public/account-deletion/confirm', { requestToken, code }, { ip: address });
      expect(replay.statusCode).toBe(410);
      expect(replay.json()).toMatchObject({ code: 'otp_expired' });
      expect((await call(h, '/v1/me', { token: user.token })).statusCode).toBe(401);
    });

    it('works as plain form posts: 303 to the website, the code form by phone, Persian digits', async () => {
      const user = await seed({ name: 'Lea' });
      const number = mobileNumber();
      await withPhone(user, number);
      const address = nextIp();
      const typed = persian(`0${number.slice(3, 6)} ${number.slice(6, 9)} ${number.slice(9)}`).replace(/^۰/, '+۹۸');

      const start = await post('/v1/public/account-deletion/start', { phone: typed, locale: 'fa' }, { form: true, ip: address });
      expect(start.statusCode).toBe(303);
      const verify = new URL(String(start.headers.location));
      expect(verify.origin).toBe(SITE);
      expect(verify.pathname).toBe('/fa/delete-account/verify/');
      expect(verify.searchParams.get('r')).toMatch(/^[A-Za-z0-9_-]{32}$/);
      const code = await codeFor(number);

      const wrong = await post('/v1/public/account-deletion/confirm', { phone: typed, code: persian(code === '000000' ? '111111' : '000000'), locale: 'fa' }, { form: true, ip: address });
      expect(wrong.statusCode).toBe(303);
      expect(wrong.headers.location).toBe(`${SITE}/fa/delete-account/verify/?e=otp_invalid#e-otp_invalid`);

      const right = await post('/v1/public/account-deletion/confirm', { phone: typed, code: persian(code), locale: 'fa' }, { form: true, ip: address });
      expect(right.statusCode).toBe(303);
      expect(right.headers.location).toBe(`${SITE}/fa/delete-account/done/`);
      expect(await row(db, `SELECT status, deleted_via FROM users WHERE id = $1`, [user.id])).toEqual({ status: 7, deleted_via: 2 });

      const invalid = await post('/v1/public/account-deletion/start', { phone: 'not a number', locale: 'tr' }, { form: true, ip: nextIp() });
      expect(invalid.headers.location).toBe(`${SITE}/tr/delete-account/?e=phone_invalid#e-phone_invalid`);
    });

    it('answers a number with no request like wrong codes, five to a number, and an unknown number never deletes', async () => {
      const address = nextIp();
      const nobody = mobileNumber();
      const attempts: unknown[] = [];
      for (let i = 0; i < 6; i += 1) {
        const response = await post('/v1/public/account-deletion/confirm', { phone: nobody, code: '123456', locale: 'en' }, { ip: address });
        attempts.push([response.statusCode, response.json<{ code: string; attemptsLeft?: number }>().code, response.json<{ attemptsLeft?: number }>().attemptsLeft]);
      }
      expect(attempts).toEqual([
        [400, 'otp_invalid', 4],
        [400, 'otp_invalid', 3],
        [400, 'otp_invalid', 2],
        [400, 'otp_invalid', 1],
        [429, 'otp_locked', undefined],
        [429, 'otp_locked', undefined],
      ]);

      // A real request with wrong codes reads the same.
      const user = await seed({ name: 'Mo' });
      const number = mobileNumber();
      await withPhone(user, number);
      const realAddress = nextIp();
      await post('/v1/public/account-deletion/start', { phone: number, locale: 'en' }, { ip: realAddress });
      const code = await codeFor(number);
      const wrongCode = code === '000000' ? '111111' : '000000';
      const real: unknown[] = [];
      for (let i = 0; i < 6; i += 1) {
        const response = await post('/v1/public/account-deletion/confirm', { phone: number, code: wrongCode, locale: 'en' }, { ip: realAddress });
        real.push([response.statusCode, response.json<{ code: string }>().code, response.json<{ attemptsLeft?: number }>().attemptsLeft]);
      }
      expect(real).toEqual(attempts);
      expect(await value<number>(`SELECT status FROM users WHERE id = $1`, [user.id])).toBe(3);

      // An unknown number's challenge is real but its code was never sent: even a right guess deletes nothing.
      const unknown = mobileNumber();
      await post('/v1/public/account-deletion/start', { phone: unknown, locale: 'en' }, { ip: nextIp() });
      const guess = await post('/v1/public/account-deletion/confirm', { phone: unknown, code: '123456', locale: 'en' }, { ip: nextIp() });
      expect(guess.statusCode).toBe(400);
      expect(guess.json()).toMatchObject({ code: 'otp_invalid' });
    });

    it('holds its limits: one start a minute per number, three an hour per address, failing closed', async () => {
      const address = nextIp();
      const number = mobileNumber();
      expect((await post('/v1/public/account-deletion/start', { phone: number, locale: 'en' }, { ip: address })).statusCode).toBe(202);
      const again = await post('/v1/public/account-deletion/start', { phone: number, locale: 'en' }, { ip: address });
      expect(again.statusCode).toBe(429);
      expect(statements(again)).toBe(0);
      expect(problemExt('rate_limited', again.json()).retryAfterSeconds).toBeGreaterThan(0);
      // A refused start counts nowhere: two more numbers make three from this address.
      expect((await post('/v1/public/account-deletion/start', { phone: mobileNumber(), locale: 'en' }, { ip: address })).statusCode).toBe(202);
      expect((await post('/v1/public/account-deletion/start', { phone: mobileNumber(), locale: 'en' }, { ip: address })).statusCode).toBe(202);
      expect((await post('/v1/public/account-deletion/start', { phone: mobileNumber(), locale: 'en' }, { ip: address })).statusCode).toBe(429);
      const form = await post('/v1/public/account-deletion/start', { phone: mobileNumber(), locale: 'en' }, { ip: address, form: true });
      expect(form.headers.location).toBe(`${SITE}/en/delete-account/?e=rate_limited#e-rate_limited`);
    });

    it('allows the website origin only (CORS), and needs no X-Client', async () => {
      const preflight = await h.app.inject({
        method: 'OPTIONS',
        url: '/v1/public/account-deletion/start',
        headers: { origin: SITE, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
      });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe(SITE);
      expect(preflight.headers['access-control-allow-methods']).toBe('POST');
      expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
      const other = await h.app.inject({
        method: 'OPTIONS',
        url: '/v1/public/account-deletion/confirm',
        headers: { origin: 'https://elsewhere.invalid', 'access-control-request-method': 'POST' },
      });
      expect(other.headers['access-control-allow-origin']).toBeUndefined();
      const posted = await post('/v1/public/account-deletion/start', { phone: mobileNumber(), locale: 'en' }, { ip: nextIp(), headers: { origin: SITE } });
      expect(posted.statusCode).toBe(202);
      expect(posted.headers['access-control-allow-origin']).toBe(SITE);
      // The app's own routes stay closed to the website's origin.
      const own = await h.app.inject({
        method: 'OPTIONS',
        url: '/v1/me/deletion',
        headers: { origin: SITE, 'access-control-request-method': 'POST' },
      });
      expect(own.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('refuses every start when Valkey is down, sending nothing', async () => {
      const down = await startHarness(
        db,
        { SITE_ORIGIN: SITE },
        { jobs: new MemoryJobProducer(), authServices: { smsSenders: Object.values(sms), google, authSettings: new AuthSettingsHolder() } },
      );
      try {
        const sent = sms.kavenegar.sent.length;
        down.app.redis.disconnect();
        const json = await down.app.inject({
          method: 'POST',
          url: '/v1/public/account-deletion/start',
          payload: { phone: mobileNumber(), locale: 'en' },
        });
        expect(json.statusCode).toBe(503);
        expect(json.json()).toMatchObject({ code: 'sms_unavailable' });
        expect(statements(json)).toBe(0);
        const form = await down.app.inject({
          method: 'POST',
          url: '/v1/public/account-deletion/start',
          payload: new URLSearchParams({ phone: mobileNumber(), locale: 'fa' }).toString(),
          headers: FORM,
        });
        expect(form.headers.location).toBe(`${SITE}/fa/delete-account/?e=sms_unavailable#e-sms_unavailable`);
        const confirm = await down.app.inject({
          method: 'POST',
          url: '/v1/public/account-deletion/confirm',
          payload: { requestToken: 'a'.repeat(32), code: '123456' },
        });
        expect(confirm.statusCode).toBe(503);
        await sleep(50);
        expect(sms.kavenegar.sent.length).toBe(sent);
      } finally {
        await down.close();
      }
    });
  });

  // ─── On the website, with Google ─────────────────────────────────────────

  describe('on the website with Google', () => {
    it('deletes the account of a recent ID token for the web client, as JSON and as a form', async () => {
      const user = await seed({ name: 'Nur' });
      const sub = `g-${randomBytes(6).toString('hex')}`;
      await withGoogle(user, sub);
      const response = await post('/v1/public/account-deletion/google', { idToken: google.mint({ sub, audience: GOOGLE_CLIENT }) }, { ip: nextIp() });
      expect(response.statusCode).toBe(202);
      expect(statements(response)).toBe(1);
      deletionScheduledSchema.strict().parse(response.json());
      expect(await row(db, `SELECT status, deleted_via FROM users WHERE id = $1`, [user.id])).toEqual({ status: 7, deleted_via: 2 });

      const other = await seed({ name: 'Oz' });
      const otherSub = `g-${randomBytes(6).toString('hex')}`;
      await withGoogle(other, otherSub);
      const form = await post('/v1/public/account-deletion/google', { idToken: google.mint({ sub: otherSub, audience: GOOGLE_CLIENT }), locale: 'tr' }, { form: true, ip: nextIp() });
      expect(form.statusCode).toBe(303);
      expect(form.headers.location).toBe(`${SITE}/tr/delete-account/done/`);
      expect(await value<number>(`SELECT status FROM users WHERE id = $1`, [other.id])).toBe(7);
    });

    it('refuses another audience, an old token and an unknown account', async () => {
      const user = await seed({ name: 'Pia' });
      const sub = `g-${randomBytes(6).toString('hex')}`;
      await withGoogle(user, sub);
      const wrongAudience = await post('/v1/public/account-deletion/google', { idToken: google.mint({ sub, audience: 'someone-else.apps.example' }) }, { ip: nextIp() });
      expect(wrongAudience.statusCode).toBe(400);
      expect(wrongAudience.json()).toMatchObject({ code: 'google_token_invalid' });
      const old = google.mint({ sub, audience: GOOGLE_CLIENT, issuedAt: new Date(Date.now() - 11 * 60_000) });
      const tooOld = await post('/v1/public/account-deletion/google', { idToken: old, locale: 'en' }, { form: true, ip: nextIp() });
      expect(tooOld.headers.location).toBe(`${SITE}/en/delete-account/?e=google_token_invalid#e-google_token_invalid`);
      const nobody = await post('/v1/public/account-deletion/google', { idToken: google.mint({ sub: 'g-nobody', audience: GOOGLE_CLIENT }) }, { ip: nextIp() });
      expect(nobody.statusCode).toBe(404);
      expect(await value<number>(`SELECT status FROM users WHERE id = $1`, [user.id])).toBe(3);
    });
  });
});
