import {
  adminPurchaseActionResultSchema,
  adminPurchaseDetailSchema,
  adminPurchaseEventPageSchema,
  adminPurchaseListSchema,
  adminPurchaseSearchResultSchema,
  type AdminPurchaseDetail,
} from '@app/shared';
import {
  BAZAAR_ADMIN_ACTIONS,
  BAZAAR_DOCUMENTED_ADMIN_ACTIONS,
  FakeRealtimePublisher,
  FakeStoreVerifier,
  StoreError,
  tokenHash,
} from '@app/shared/server';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { migratedDatabase, row, seedUser, statements, type SeededUser, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, auditRows, installAuditFailure, lastAudit, refuseAudit, startAdminHarness, type AdminHarness, type AdminSession } from './adminSupport.js';
import { seedPurchase, type SeededPurchase } from './revenueSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * The purchases of the admin panel end to end on PostgreSQL and Valkey,
 * with fake stores behind `StoreVerifier`: the list per store, the search
 * (never in an address, audited when it links a purchase to a person), the
 * purchase page (no token material), and the admin actions with their
 * order (audit row before the store call), their locks and refusals, the
 * store's capabilities and the statement budgets.
 */

const DAY = 86_400_000;

describe.skipIf(!hasInfrastructure)('admin: purchases', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  const jobs = new MemoryJobProducer();
  const realtime = new FakeRealtimePublisher();
  const play = new FakeStoreVerifier('play');
  const bazaar = new FakeStoreVerifier('bazaar');
  const fakes = { play, bazaar };
  let superadmin: AdminSession;
  let finance: AdminSession;
  let adminRole: AdminSession;
  let support: AdminSession;

  beforeAll(async () => {
    db = await migratedDatabase();
    await installAuditFailure(db);
    h = await startAdminHarness(db, {}, { jobs, realtime, store: { verifiers: { play, bazaar } } });
    superadmin = await adminAs(h, 'superadmin');
    finance = await adminAs(h, 'finance');
    adminRole = await adminAs(h, 'admin');
    support = await adminAs(h, 'support');
  }, 120_000);

  afterAll(async () => {
    // No answer ever carried a purchase token or one of its hashes.
    for (const body of h?.bodies ?? []) expect(body).not.toMatch(/revenue-(play|bazaar)-\w+-\d+-\d+-token/);
    await h?.close();
    await db?.drop();
  });

  beforeEach(async () => {
    for (const fake of [play, bazaar]) {
      fake.calls.length = 0;
      fake.failures.length = 0;
    }
    play.adminActions = { subscription: ['cancel', 'refund', 'refund_prorated'], consumable: ['refund'] };
    bazaar.adminActions = BAZAAR_DOCUMENTED_ADMIN_ACTIONS;
    await refuseAudit(db);
  });

  const as = (session: AdminSession) => ({
    get: (url: string) => admin(h, url, undefined, { token: session.accessToken }),
    post: (url: string, body: unknown = {}) => admin(h, url, body, { token: session.accessToken }),
  });
  const detail = (res: LightMyRequestResponse): AdminPurchaseDetail => adminPurchaseDetailSchema.parse(res.json());
  const result = (res: LightMyRequestResponse) => adminPurchaseActionResultSchema.parse(res.json());
  const person = (store: 1 | 2 = 1): Promise<SeededUser> => seedUser(h, { store, name: 'Buyer' });
  const buy = (options: Parameters<typeof seedPurchase>[1]): Promise<SeededPurchase> => seedPurchase(h, { fakes, ...options });
  const stateOf = async (id: string) => (await row<{ state: number; auto_renew: boolean | null }>(db, 'SELECT state, auto_renew FROM store_purchases WHERE id = $1', [id]));
  const events = async (id: string) =>
    (await db.sql.query<{ event: number; source: number; state_to: number; minted_at: Date }>('SELECT event, source, state_to, id_time(id) AS minted_at FROM store_events WHERE purchase_id = $1 ORDER BY id', [id])).rows;
  const balance = async (userId: string, item = 2, store = 1) =>
    (await db.sql.query<{ balance: number }>('SELECT balance FROM wallet_balances WHERE user_id = $1 AND item = $2 AND store = $3', [userId, item, store])).rows[0]?.balance ?? 0;
  const subscriptionRow = async (userId: string, store = 1) =>
    (await db.sql.query<{ purchase_id: string }>('SELECT purchase_id::text FROM subscriptions WHERE user_id = $1 AND store = $2', [userId, store])).rows[0] ?? null;

  describe('the list, the search and the page', () => {
    it('lists one store newest first, by state, in pages, with the connection state; 1 statement', async () => {
      const u = await person();
      const a = await buy({ user: u });
      const b = await buy({ user: u, kind: 'consumable' });
      const c = await buy({ user: u, state: 'expired', expiresAtMs: Date.now() - DAY, autoRenew: false });
      const z = await buy({ user: await person(2), store: 'bazaar' });
      const res = await as(finance).get('/v1/admin/purchases?store=play&limit=2');
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBe(1);
      const page = adminPurchaseListSchema.parse(res.json());
      expect(page.connected).toBe(true);
      expect(page.items.map((p) => p.id)).toEqual([c.id, b.id]);
      expect(page.items[0]).toMatchObject({ store: 'play', productId: 'sub.plus', basePlanId: 'm1', kind: 'subscription', plan: 'plus', state: 'expired', user: { id: u.publicUid } });
      expect(page.items[1]).toMatchObject({ kind: 'consumable', item: 'boost', grantQuantity: 1, plan: null });
      // The list pairs no order id with a person: that is the page's (one purchase) and the metered search's.
      expect(page.items.every((item) => !('orderId' in item))).toBe(true);
      expect(res.body).not.toContain(a.orderId!);
      expect(detail(await as(finance).get(`/v1/admin/purchases/${a.id}`)).orderId).toBe(a.orderId);
      const next = adminPurchaseListSchema.parse((await as(finance).get(`/v1/admin/purchases?store=play&limit=2&cursor=${page.nextCursor}`)).json());
      expect(next.items.map((p) => p.id)).toContain(a.id);
      expect(next.items.map((p) => p.id)).not.toContain(z.id);
      const expired = adminPurchaseListSchema.parse((await as(finance).get('/v1/admin/purchases?store=play&state=expired')).json());
      expect(expired.items.every((p) => p.state === 'expired')).toBe(true);
      expect(expired.items.map((p) => p.id)).toContain(c.id);
      // The store's connection is read on every call: one taken away reads as "not connected".
      const verifiers = h.app.store.verifiers;
      delete verifiers.bazaar;
      try {
        const off = adminPurchaseListSchema.parse((await as(finance).get('/v1/admin/purchases?store=bazaar')).json());
        expect(off.connected).toBe(false);
        expect(off.items.map((p) => p.id)).toContain(z.id);
        const page = detail(await as(superadmin).get(`/v1/admin/purchases/${z.id}`));
        expect(page.connected).toBe(false);
        expect(page.available).toEqual(['revoke']);
      } finally {
        verifiers.bazaar = bazaar;
      }
      expect((await as(finance).get('/v1/admin/purchases?store=play&cursor=bm90LWEtY3Vyc29y')).statusCode).toBe(400);
      expect((await as(finance).get('/v1/admin/purchases?store=app_store')).statusCode).toBe(400);
    });

    it('is closed to roles without billing.read', async () => {
      const marketing = await adminAs(h, 'marketing');
      for (const session of [support, marketing]) {
        expect((await as(session).get('/v1/admin/purchases?store=play')).statusCode).toBe(403);
        expect((await as(session).post('/v1/admin/purchases/search', { q: '12345' })).statusCode).toBe(403);
      }
      expect((await as(adminRole).get('/v1/admin/purchases?store=play')).statusCode).toBe(200);
    });

    it('finds by id, person, order id and token; only an order or token hit is audited (never the text) and metered', async () => {
      const u = await person();
      const p = await buy({ user: u, orderId: 'GPA.1111-2222-3333-44444' });
      const unclaimed = await buy({ user: null, orderId: 'GPA.9999-8888-7777-66666' });
      const search = (q: string, session = finance) => as(session).post('/v1/admin/purchases/search', { q });
      const byId = await search(p.id);
      expect(statements(byId)).toBe(1);
      expect(adminPurchaseSearchResultSchema.parse(byId.json())).toMatchObject({ matchedBy: 'id', items: [{ id: p.id }] });
      const byPerson = adminPurchaseSearchResultSchema.parse((await search(u.publicUid)).json());
      expect(byPerson.matchedBy).toBe('person');
      expect(byPerson.items.map((i) => i.id)).toEqual([p.id]);
      const audited = (await auditRows(db, { action: 'purchase.search' })).length;
      expect(audited).toBe(0);
      const byOrder = await search('GPA.9999-8888-7777-66666');
      expect(statements(byOrder)).toBe(2);
      expect(adminPurchaseSearchResultSchema.parse(byOrder.json())).toMatchObject({ matchedBy: 'order', items: [{ id: unclaimed.id, user: null, state: 'unclaimed' }] });
      const byToken = adminPurchaseSearchResultSchema.parse((await search(p.token)).json());
      expect(byToken).toMatchObject({ matchedBy: 'token', items: [{ id: p.id }] });
      const rows = await auditRows(db, { action: 'purchase.search' });
      expect(rows.map((r) => r.detail)).toEqual([{ by: 'order', hits: 1 }, { by: 'token', hits: 1 }]);
      expect(rows.every((r) => r.target_type === 0 && r.target_id === null)).toBe(true);
      const audit = (await db.sql.query<{ detail: unknown }>('SELECT detail FROM audit_log')).rows.map((r) => JSON.stringify(r.detail)).join('\n');
      expect(audit).not.toContain(p.token);
      expect(audit).not.toContain('GPA.9999');
      expect(audit).not.toContain(tokenHash(p.token));
      // Neither the text nor the token ever reaches a log line.
      expect(h.logs.join('\n')).not.toContain(p.token);
      expect(h.logs.join('\n')).not.toContain('GPA.9999-8888');
      const none = adminPurchaseSearchResultSchema.parse((await search('no-such-thing-at-all')).json());
      expect(none).toEqual({ items: [], matchedBy: null });
      // A spent lookup budget answers 429 and shows nothing.
      await h.redis.set(h.app.keys.signInIpLimit('purchase-lookup', String(finance.account.id)), '120', 'PX', 60_000);
      expect((await search('GPA.9999-8888-7777-66666')).statusCode).toBe(429);
      expect((await search(p.id)).statusCode).toBe(200);
      await h.redis.del(h.app.keys.signInIpLimit('purchase-lookup', String(finance.account.id)));
    });

    it('shows every field without token material, the events, the history and what the caller may do; 1 statement', async () => {
      const u = await person();
      const old = await buy({ user: u });
      const sub = await buy({ user: u, linkedPurchaseToken: old.token });
      const res = await as(finance).get(`/v1/admin/purchases/${sub.id}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBe(1);
      expect(res.body).not.toContain(sub.token);
      expect(res.body).not.toContain(tokenHash(sub.token));
      expect(res.body).not.toContain(tokenHash(old.token));
      const page = detail(res);
      expect(page).toMatchObject({ id: sub.id, state: 'active', counts: true, replaces: old.id, replacedBy: null, connected: true, wallet: null, period: 'P1M' });
      expect(page.available).toEqual(['recheck', 'cancel', 'refund', 'refund_prorated', 'revoke']);
      expect(page.events.items[0]).toMatchObject({ event: 'verified', source: 'app', stateTo: 'active' });
      expect(detail(await as(finance).get(`/v1/admin/purchases/${old.id}`))).toMatchObject({ state: 'replaced', replacedBy: sub.id, counts: false, available: ['recheck'] });
      // The admin role reads it, and may do nothing with it.
      expect(detail(await as(adminRole).get(`/v1/admin/purchases/${sub.id}`)).available).toEqual([]);
      expect((await as(finance).get('/v1/admin/purchases/999999999')).statusCode).toBe(404);
      expect((await as(finance).get('/v1/admin/purchases/999999999/events')).statusCode).toBe(404);
    });

    it('pages a long timeline by keyset', async () => {
      const u = await person();
      const sub = await buy({ user: u });
      for (let i = 1; i <= 55; i += 1) {
        await db.sql.query(
          `INSERT INTO store_events (id, purchase_id, user_id, occurred_at, store, event, source, state_to) VALUES ($1, $2, $3, now(), 1, 2, 3, 2)`,
          [h.app.ids.nextId(), sub.id, u.id],
        );
      }
      const page = detail(await as(finance).get(`/v1/admin/purchases/${sub.id}`));
      expect(page.events.items).toHaveLength(50);
      expect(page.events.nextCursor).not.toBeNull();
      const older = await as(finance).get(`/v1/admin/purchases/${sub.id}/events?cursor=${page.events.nextCursor}&limit=50`);
      expect(statements(older)).toBe(1);
      const rest = adminPurchaseEventPageSchema.parse(older.json());
      expect(rest.items).toHaveLength(6);
      expect(rest.nextCursor).toBeNull();
      expect(rest.items.at(-1)).toMatchObject({ event: 'verified' });
    });
  });

  describe('re-check', () => {
    it('applies what the store says now in the audit row’s transaction (source admin); unchanged writes the row only; 4 statements', async () => {
      const u = await person();
      const sub = await buy({ user: u });
      play.purchases.get(sub.token)!.state = 'canceled';
      play.purchases.get(sub.token)!.autoRenew = false;
      play.purchases.get(sub.token)!.eventMs = Date.now();
      const res = await as(finance).post(`/v1/admin/purchases/${sub.id}/recheck`, { note: 'The person says renewal is off' });
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBeLessThanOrEqual(4);
      expect(play.count('recheck')).toBe(1);
      const out = result(res);
      expect(out.outcome).toBe('done');
      expect(out.purchase.state).toBe('canceled');
      expect((await events(sub.id)).at(-1)).toMatchObject({ event: 3, source: 5, state_to: 3 });
      expect((await lastAudit(db, { action: 'purchase.recheck', targetType: 5, targetId: sub.id }))?.detail).toEqual({
        store: 'play',
        from: 'active',
        to: 'canceled',
        outcome: 'applied',
        note: 'The person says renewal is off',
      });
      expect(out.purchase.history[0]).toMatchObject({ action: 'purchase.recheck', note: 'The person says renewal is off', error: null, admin: { id: String(finance.account.id) } });
      const before = (await events(sub.id)).length;
      play.purchases.get(sub.token)!.eventMs = Date.now();
      const again = result(await as(finance).post(`/v1/admin/purchases/${sub.id}/recheck`));
      expect(again.outcome).toBe('unchanged');
      expect((await events(sub.id)).length).toBe(before);
      expect((await auditRows(db, { action: 'purchase.recheck', targetType: 5, targetId: sub.id })).length).toBe(2);
    });

    it('records a store naming no account of ours, then queues its refund and revoke at the store (409 foreign_account)', async () => {
      const revokes = (token: string) => jobs.jobs.filter((j) => j.queue === 'iap' && j.name === 'revoke' && j.data['tokenHash'] === tokenHash(token));
      // The reference does not decode at all (answered before any statement).
      const odd = await buy({ user: null });
      play.purchases.get(odd.token)!.accountRef = 'not-a-billing-reference';
      play.purchases.get(odd.token)!.eventMs = Date.now();
      await refuseAudit(db, 'purchase.recheck');
      const refused = await as(finance).post(`/v1/admin/purchases/${odd.id}/recheck`, { note: 'Who bought this?' });
      expect(refused.statusCode).toBe(500);
      expect(revokes(odd.token)).toHaveLength(0);
      await refuseAudit(db);
      const first = await as(finance).post(`/v1/admin/purchases/${odd.id}/recheck`, { note: 'Who bought this?' });
      expect(first.statusCode, first.body).toBe(409);
      expect(first.json()).toMatchObject({ reason: 'foreign_account' });
      expect((await lastAudit(db, { action: 'purchase.recheck', targetType: 5, targetId: odd.id }))?.detail).toEqual({
        store: 'play',
        from: 'unclaimed',
        outcome: 'foreign_account',
        revoke: 'queued',
        note: 'Who bought this?',
      });
      expect(revokes(odd.token)).toHaveLength(1);
      // The reference decodes to no account (the statement refuses it): the same row in its transaction, then the job.
      const gone = await buy({ user: null });
      play.purchases.get(gone.token)!.accountRef = h.app.publicIds.billing.encode('987654321012345');
      play.purchases.get(gone.token)!.eventMs = Date.now();
      await refuseAudit(db, 'purchase.recheck');
      expect((await as(finance).post(`/v1/admin/purchases/${gone.id}/recheck`)).statusCode).toBe(500);
      expect(revokes(gone.token)).toHaveLength(0);
      await refuseAudit(db);
      const second = await as(finance).post(`/v1/admin/purchases/${gone.id}/recheck`);
      expect(second.statusCode, second.body).toBe(409);
      expect(second.json()).toMatchObject({ reason: 'foreign_account' });
      expect((await lastAudit(db, { action: 'purchase.recheck', targetType: 5, targetId: gone.id }))?.detail).toEqual({ store: 'play', from: 'unclaimed', outcome: 'foreign_account', revoke: 'queued' });
      expect(revokes(gone.token)).toHaveLength(1);
      expect((await stateOf(gone.id)).state).toBe(11);
    });

    it('writes nothing when the store refuses or cannot be reached; Bazaar is asked urgently', async () => {
      const u = await person();
      const sub = await buy({ user: u });
      play.failures.push(new StoreError('invalid', 'unknown token'));
      const refused = await as(finance).post(`/v1/admin/purchases/${sub.id}/recheck`);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ reason: 'store_refused' });
      play.failures.push(new StoreError('unavailable', 'down', { retryAfterSeconds: 40 }));
      const down = await as(finance).post(`/v1/admin/purchases/${sub.id}/recheck`);
      expect(down.statusCode).toBe(503);
      expect(down.json()).toMatchObject({ code: 'store_unavailable' });
      expect(down.headers['retry-after']).toBe('40');
      expect(await auditRows(db, { action: 'purchase.recheck', targetType: 5, targetId: sub.id })).toEqual([]);
      const b = await buy({ user: await person(2), store: 'bazaar' });
      expect((await as(finance).post(`/v1/admin/purchases/${b.id}/recheck`)).statusCode).toBe(200);
      expect(bazaar.calls.find((c) => c.method === 'recheck')).toMatchObject({ urgent: true });
      // The admin role may not ask the store (no billing.write).
      expect((await as(adminRole).post(`/v1/admin/purchases/${sub.id}/recheck`)).statusCode).toBe(403);
    });
  });

  describe('refund', () => {
    it('refunds a Play subscription in full or for its unused time: access ends now, one event, the person told; 5 statements', async () => {
      for (const prorated of [false, true]) {
        const u = await person();
        const sub = await buy({ user: u });
        realtime.published.splice(0);
        const res = await as(finance).post(`/v1/admin/purchases/${sub.id}/refund`, { from: 'active', prorated, note: 'Charged twice' });
        expect(res.statusCode, res.body).toBe(200);
        expect(statements(res)).toBeLessThanOrEqual(5);
        expect(play.calls.filter((c) => c.method === 'refund').at(-1)).toMatchObject({ token: sub.token, prorated });
        const out = result(res);
        expect(out).toMatchObject({ outcome: 'done', sideEffects: 'done', purchase: { state: 'revoked', counts: false } });
        expect(await subscriptionRow(u.id)).toBeNull();
        const last = (await events(sub.id)).at(-1)!;
        expect(last).toMatchObject({ event: 10, source: 5, state_to: 8 });
        // The refund's event id is minted today, and the revenue rollup reads events by id day: no rolled-up day
        // (and no cached revenue answer, keyed by the newest rolled-up day) changes.
        expect(last.minted_at.toISOString().slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
        expect(realtime.published.filter((p) => p.channels.some((c) => c.endsWith(u.publicUid)) && p.envelope.t === 'entitlement').length).toBe(1);
        const audit = await lastAudit(db, { action: 'purchase.refund', targetType: 5, targetId: sub.id });
        expect(audit?.detail).toEqual({ store: 'play', from: 'active', prorated, note: 'Charged twice' });
        // A refunded purchase offers nothing more but a re-check.
        expect(out.purchase.available).toEqual(['recheck']);
      }
    });

    it('takes back what is left of a refunded consumable, never below zero', async () => {
      const u = await person();
      const pack = await buy({ user: u, kind: 'consumable' });
      expect(await balance(u.id)).toBe(1);
      await db.sql.query('UPDATE wallet_balances SET balance = 0 WHERE user_id = $1', [u.id]);
      const res = await as(finance).post(`/v1/admin/purchases/${pack.id}/refund`, { from: 'purchased', note: 'Bought by mistake' });
      expect(res.statusCode, res.body).toBe(200);
      const out = result(res).purchase;
      expect(out).toMatchObject({ state: 'revoked', wallet: { credited: 1, takenBack: 0 } });
      expect(await balance(u.id)).toBe(0);
      expect(play.calls.filter((c) => c.method === 'refund').at(-1)).toMatchObject({ prorated: false });
    });

    it('offers only what each store documents and this build confirmed (Bazaar: nothing by default)', async () => {
      const u = await person(2);
      const sub = await buy({ user: u, store: 'bazaar' });
      const pack = await buy({ user: u, store: 'bazaar', kind: 'consumable' });
      bazaar.adminActions = BAZAAR_ADMIN_ACTIONS;
      expect(detail(await as(finance).get(`/v1/admin/purchases/${sub.id}`)).available).toEqual(['recheck', 'revoke']);
      expect(detail(await as(finance).get(`/v1/admin/purchases/${pack.id}`)).available).toEqual(['recheck', 'revoke']);
      const hidden = await as(finance).post(`/v1/admin/purchases/${pack.id}/refund`, { from: 'purchased', note: 'x' });
      expect(hidden.statusCode).toBe(409);
      expect(hidden.json()).toMatchObject({ reason: 'action_not_available' });
      bazaar.adminActions = BAZAAR_DOCUMENTED_ADMIN_ACTIONS;
      expect(detail(await as(finance).get(`/v1/admin/purchases/${sub.id}`)).available).toEqual(['recheck', 'cancel', 'revoke']);
      // No refund of a Bazaar subscription is documented.
      const sublRefund = await as(finance).post(`/v1/admin/purchases/${sub.id}/refund`, { from: 'active', note: 'x' });
      expect(sublRefund.json()).toMatchObject({ reason: 'action_not_available' });
      expect(bazaar.count('refund')).toBe(0);
      const ok = await as(finance).post(`/v1/admin/purchases/${pack.id}/refund`, { from: 'purchased', note: 'Refund asked' });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(bazaar.count('refund')).toBe(1);
      expect(result(ok).purchase.state).toBe('revoked');
      // A one-time product has no prorated refund.
      const pack2 = await buy({ user: await person(), kind: 'consumable' });
      expect((await as(finance).post(`/v1/admin/purchases/${pack2.id}/refund`, { from: 'purchased', prorated: true, note: 'x' })).json()).toMatchObject({ reason: 'action_not_available' });
    });

    it('refuses a state the admin did not see, a busy purchase and other roles, asking the store nothing', async () => {
      const u = await person();
      const sub = await buy({ user: u });
      const stale = await as(finance).post(`/v1/admin/purchases/${sub.id}/refund`, { from: 'canceled', note: 'x' });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ reason: 'purchase_changed' });
      await h.redis.set(h.app.keys.adminPurchaseLock(sub.id), 'someone else', 'EX', 60);
      const busy = await as(finance).post(`/v1/admin/purchases/${sub.id}/refund`, { from: 'active', note: 'x' });
      expect(busy.statusCode).toBe(409);
      expect(busy.json()).toMatchObject({ reason: 'purchase_busy' });
      await h.redis.del(h.app.keys.adminPurchaseLock(sub.id));
      expect((await as(adminRole).post(`/v1/admin/purchases/${sub.id}/refund`, { from: 'active', note: 'x' })).statusCode).toBe(403);
      expect(play.count('refund')).toBe(0);
      expect(await auditRows(db, { action: 'purchase.refund', targetType: 5, targetId: sub.id })).toEqual([]);
      // Two at once: one runs, the other finds it busy.
      const [a, b] = await Promise.all([
        as(finance).post(`/v1/admin/purchases/${sub.id}/refund`, { from: 'active', note: 'one' }),
        as(finance).post(`/v1/admin/purchases/${sub.id}/refund`, { from: 'active', note: 'two' }),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
      expect(play.count('refund')).toBe(1);
    });

    it('records a refusal or an outage after its own row, and a retry the store had done is "already"', async () => {
      const u = await person();
      const sub = await buy({ user: u });
      play.failures.push(new StoreError('invalid', 'not refundable'));
      const refused = await as(finance).post(`/v1/admin/purchases/${sub.id}/refund`, { from: 'active', note: 'x' });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ reason: 'store_refused' });
      expect((await stateOf(sub.id)).state).toBe(2);
      expect((await auditRows(db, { action: 'purchase.refund', targetType: 5, targetId: sub.id })).length).toBe(1);
      expect((await lastAudit(db, { action: 'purchase.action_failed', targetType: 5, targetId: sub.id }))?.detail).toEqual({ store: 'play', action: 'refund', error: 'refused' });
      play.failures.push(new StoreError('unavailable', 'timeout'));
      const down = await as(finance).post(`/v1/admin/purchases/${sub.id}/refund`, { from: 'active', note: 'x' });
      expect(down.statusCode).toBe(503);
      expect((await lastAudit(db, { action: 'purchase.action_failed', targetType: 5, targetId: sub.id }))?.detail).toMatchObject({ error: 'unavailable' });
      const history = detail(await as(finance).get(`/v1/admin/purchases/${sub.id}`)).history;
      expect(history.filter((r) => r.action === 'purchase.action_failed').map((r) => [r.error, r.failed])).toEqual([
        ['unavailable', 'refund'],
        ['refused', 'refund'],
      ]);
      // The store will not refund a subscription that is over there (Google shows a refunded one and one that simply
      // ran out alike): its own state is applied and no refund is assumed.
      play.refunded.add(sub.token);
      Object.assign(play.purchases.get(sub.token)!, { state: 'expired', autoRenew: false, expiresAtMs: Date.now() - 60_000, eventMs: Date.now() });
      const retry = await as(finance).post(`/v1/admin/purchases/${sub.id}/refund`, { from: 'active', note: 'x' });
      expect(retry.statusCode, retry.body).toBe(200);
      expect(result(retry)).toMatchObject({ outcome: 'already', purchase: { state: 'expired' } });
      expect((await events(sub.id)).filter((e) => e.event === 10)).toEqual([]);
      expect((await events(sub.id)).at(-1)).toMatchObject({ source: 5, state_to: 7 });
    });

    it('a consumable the store says it refunded before is refunded here (its credit taken back once)', async () => {
      const u = await person();
      const pack = await buy({ user: u, kind: 'consumable' });
      play.refunded.add(pack.token);
      const res = await as(finance).post(`/v1/admin/purchases/${pack.id}/refund`, { from: 'purchased', note: 'Refunded twice?' });
      expect(res.statusCode, res.body).toBe(200);
      expect(result(res)).toMatchObject({ outcome: 'already', purchase: { state: 'revoked', wallet: { credited: 1, takenBack: 1 } } });
      expect((await events(pack.id)).filter((e) => e.event === 10)).toHaveLength(1);
    });

    it('answers "pending" and queues a re-check when the store refunded but the state could not be written here', async () => {
      const u = await person();
      const sub = await buy({ user: u });
      const core = h.app.store.core;
      const apply = core.apply.bind(core);
      core.apply = () => Promise.reject(new Error('database gone'));
      try {
        const res = await as(finance).post(`/v1/admin/purchases/${sub.id}/refund`, { from: 'active', note: 'x' });
        expect(res.statusCode, res.body).toBe(200);
        expect(result(res)).toMatchObject({ outcome: 'pending', sideEffects: 'failed', purchase: { state: 'active' } });
      } finally {
        core.apply = apply;
      }
      // The worker applies the refund from the stored row (a read would show the refunded subscription as expired).
      const queued = jobs.jobs.filter((j) => j.queue === 'iap' && j.name === 'recheck' && j.id.startsWith(`recheck.${sub.id}.`));
      expect(queued).toHaveLength(1);
      expect(queued[0]!.data).toMatchObject({ purchaseId: sub.id, store: 'play', refunded: true });
    });

    it('fails closed when Valkey cannot take the purchase lock: 503, the store asked nothing, no row written', async () => {
      const u = await person();
      const sub = await buy({ user: u });
      const down = vi.spyOn(h.app.redis, 'set').mockRejectedValueOnce(new Error('valkey down'));
      try {
        const res = await as(finance).post(`/v1/admin/purchases/${sub.id}/refund`, { from: 'active', note: 'x' });
        expect(res.statusCode, res.body).toBe(503);
        expect(res.json()).toMatchObject({ code: 'service_unavailable' });
      } finally {
        down.mockRestore();
      }
      expect(play.count('refund')).toBe(0);
      expect(await auditRows(db, { action: 'purchase.refund', targetType: 5, targetId: sub.id })).toEqual([]);
      expect((await stateOf(sub.id)).state).toBe(2);
    });

    it('asks the store nothing when its audit row is refused', async () => {
      const u = await person();
      const sub = await buy({ user: u });
      await refuseAudit(db, 'purchase.refund', 'purchase.cancel');
      expect((await as(finance).post(`/v1/admin/purchases/${sub.id}/refund`, { from: 'active', note: 'x' })).statusCode).toBe(500);
      expect((await as(finance).post(`/v1/admin/purchases/${sub.id}/cancel`, { from: 'active', note: 'x' })).statusCode).toBe(500);
      expect(play.count('refund') + play.count('cancel')).toBe(0);
      expect((await stateOf(sub.id)).state).toBe(2);
    });
  });

  describe('stop renewal', () => {
    it('stops a renewal at the store, reads it again and keeps access until the expiry', async () => {
      const u = await person();
      const sub = await buy({ user: u });
      const res = await as(finance).post(`/v1/admin/purchases/${sub.id}/cancel`, { from: 'active', note: 'Asked by the person' });
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBeLessThanOrEqual(5);
      expect(play.calls.map((c) => c.method)).toEqual(['cancel', 'recheck']);
      expect(result(res)).toMatchObject({ outcome: 'done', purchase: { state: 'canceled', autoRenew: false, counts: true } });
      expect(await subscriptionRow(u.id)).toEqual({ purchase_id: sub.id });
      expect((await events(sub.id)).at(-1)).toMatchObject({ event: 3, source: 5 });
      // Nothing to stop any more; a consumable has no renewal.
      expect((await as(finance).post(`/v1/admin/purchases/${sub.id}/cancel`, { from: 'canceled', note: 'x' })).json()).toMatchObject({ reason: 'action_not_available' });
      const pack = await buy({ user: u, kind: 'consumable' });
      expect((await as(finance).post(`/v1/admin/purchases/${pack.id}/cancel`, { from: 'purchased', note: 'x' })).json()).toMatchObject({ reason: 'action_not_available' });
    });

    it('answers "pending" and queues a re-check when the store cannot be read after it', async () => {
      const b = await buy({ user: await person(2), store: 'bazaar' });
      // The store stopped the renewal; reading it again fails.
      const recheck = bazaar.recheck.bind(bazaar);
      bazaar.recheck = () => Promise.reject(new StoreError('unavailable', 'quota'));
      try {
        const res = await as(finance).post(`/v1/admin/purchases/${b.id}/cancel`, { from: 'active', note: 'x' });
        expect(res.statusCode, res.body).toBe(200);
        expect(result(res)).toMatchObject({ outcome: 'pending', purchase: { state: 'active' } });
      } finally {
        bazaar.recheck = recheck;
      }
      expect(bazaar.count('cancel')).toBe(1);
      expect(jobs.jobs.some((j) => j.name === 'recheck' && j.id.startsWith(`recheck.${b.id}.`) && j.data['store'] === 'bazaar' && j.data['refunded'] === undefined)).toBe(true);
    });
  });

  describe('mark refunded', () => {
    it('ends access with no store call, works without a connection, takes back credits once; 4 statements', async () => {
      const u = await person();
      const pack = await buy({ user: u, kind: 'consumable' });
      await db.sql.query(`INSERT INTO wallet_balances (user_id, item, store, balance) VALUES ($1, 2, 1, 0) ON CONFLICT (user_id, item, store) DO UPDATE SET balance = 0`, [u.id]);
      const verifiers = h.app.store.verifiers;
      delete verifiers.play;
      let res: LightMyRequestResponse;
      try {
        res = await as(finance).post(`/v1/admin/purchases/${pack.id}/revoke`, { from: 'purchased', note: 'Refunded in the console' });
      } finally {
        verifiers.play = play;
      }
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBeLessThanOrEqual(4);
      expect(play.calls).toEqual([]);
      expect(result(res).purchase).toMatchObject({ state: 'revoked', wallet: { credited: 1, takenBack: 0 } });
      expect((await lastAudit(db, { action: 'purchase.revoke', targetType: 5, targetId: pack.id }))?.detail).toEqual({
        store: 'play',
        from: 'purchased',
        note: 'Refunded in the console',
        debited: 0,
        shortfall: 1,
      });
      const twice = await as(finance).post(`/v1/admin/purchases/${pack.id}/revoke`, { from: 'revoked', note: 'again' });
      expect(twice.json()).toMatchObject({ reason: 'action_not_available' });
      const sub = await buy({ user: u });
      const ended = result(await as(finance).post(`/v1/admin/purchases/${sub.id}/revoke`, { from: 'active', note: 'Chargeback' }));
      expect(ended.purchase).toMatchObject({ state: 'revoked', counts: false });
      expect(await subscriptionRow(u.id)).toBeNull();
      expect((await events(sub.id)).at(-1)).toMatchObject({ event: 10, source: 5, state_to: 8 });
    });

    it('refuses a state the purchase is no longer in, and acts on a deleted account’s purchase', async () => {
      const u = await person();
      const sub = await buy({ user: u });
      await db.sql.query('UPDATE store_purchases SET state = 3 WHERE id = $1', [sub.id]);
      const changed = await as(finance).post(`/v1/admin/purchases/${sub.id}/revoke`, { from: 'active', note: 'x' });
      expect(changed.json()).toMatchObject({ reason: 'purchase_changed' });
      // A purged account's purchase stays listed, and a refund made with the deletion is recorded.
      const gone = await seedUser(h, { store: 1, status: 8 });
      const theirs = await buy({ user: gone });
      const page = detail(await as(finance).get(`/v1/admin/purchases/${theirs.id}`));
      expect(page.user).toMatchObject({ id: gone.publicUid, status: 'purged' });
      expect((await as(finance).post(`/v1/admin/purchases/${theirs.id}/revoke`, { from: 'active', note: 'Deletion with refund' })).statusCode).toBe(200);
    });
  });
});
