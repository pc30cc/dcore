import { randomUUID } from 'node:crypto';
import {
  adminGrantListSchema,
  adminGrantResultSchema,
  adminUserWalletSchema,
  adminWalletAdjustResultSchema,
  adminWalletAdjustmentListSchema,
} from '@app/shared';
import { FakeRealtimePublisher, FakeStoreVerifier, IdGeneratorUnavailableError } from '@app/shared/server';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, migratedDatabase, row, seedUser, statements, type SeededUser, type TestDatabase } from './accountSupport.js';
import { admin, adminAs, installAuditFailure, lastAudit, refuseAudit, startAdminHarness, type AdminHarness, type AdminSession } from './adminSupport.js';
import { seedPurchase } from './revenueSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * Plan days and wallet rows given in the panel, end to end: who may give
 * and correct, the dialog's request id, the store-0 subscription and its
 * `sub-end` jobs, the event the person's app hears, ending a grant early,
 * a balance that never goes below zero, the lists and their budgets.
 */

const DAY = 86_400_000;

describe.skipIf(!hasInfrastructure)('admin: grants and the wallet', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  const jobs = new MemoryJobProducer();
  const realtime = new FakeRealtimePublisher();
  const play = new FakeStoreVerifier('play');
  const bazaar = new FakeStoreVerifier('bazaar');
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
    // An archived plan to refuse.
    expect((await send(superadmin, 'POST', '/v1/admin/plans', { key: 'oldgift', names: { en: 'Old' } })).statusCode).toBe(201);
    expect((await send(superadmin, 'POST', '/v1/admin/plans/oldgift/archive', {})).statusCode).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await db?.drop();
  });

  beforeEach(async () => {
    realtime.published.splice(0);
    await refuseAudit(db);
  });

  const send = (session: AdminSession, method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown) =>
    admin(h, url, body, { token: session.accessToken, method });
  const person = (store: 1 | 2 = 1): Promise<SeededUser> => seedUser(h, { store, name: 'Receiver' });
  const give = (session: AdminSession, body: Record<string, unknown>) => send(session, 'POST', '/v1/admin/grants', { requestId: randomUUID(), reason: 'Support gesture', ...body });
  const adjust = (session: AdminSession, user: SeededUser, body: Record<string, unknown>) =>
    send(session, 'POST', `/v1/admin/users/${user.publicUid}/wallet-adjust`, { requestId: randomUUID(), note: 'Goodwill', ...body });
  const grantRow = (res: LightMyRequestResponse) => adminGrantResultSchema.parse(res.json()).grant;
  const storeZero = async (userId: string) => (await db.sql.query<{ plan: string; expires: Date }>('SELECT pl.key AS plan, s.expires_at AS expires FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id WHERE s.user_id = $1 AND s.store = 0', [userId])).rows[0] ?? null;
  const published = (u: SeededUser) => realtime.published.filter((p) => p.envelope.t === 'entitlement' && p.channels.some((c) => c.endsWith(u.publicUid)));
  /** The person's Play build read its entitlements (so a change is told to that build). */
  const opened = async (u: SeededUser) => expect((await call(h, '/v1/me/entitlements', { token: u.token, client: 'play/120' })).statusCode).toBe(200);
  const balance = async (userId: string, item: number, store: number) =>
    (await db.sql.query<{ balance: number }>('SELECT balance FROM wallet_balances WHERE user_id = $1 AND item = $2 AND store = $3', [userId, item, store])).rows[0]?.balance ?? 0;

  describe('plan days', () => {
    it('gives days from now: the store-0 plan, the event the app hears and the job at the end; 4 statements (+1 own)', async () => {
      const u = await person();
      await opened(u);
      const res = await give(finance, { user: u.publicUid, plan: 'plus', days: 7 });
      expect(res.statusCode, res.body).toBe(201);
      expect(statements(res)).toBeLessThanOrEqual(5);
      const out = adminGrantResultSchema.parse(res.json());
      expect(out.sideEffects).toBe('done');
      expect(out.grant).toMatchObject({ user: { id: u.publicUid }, plan: 'plus', state: 'active', reason: 'Support gesture', grantedBy: { id: String(finance.account.id) }, revokedAt: null });
      expect(Date.parse(out.grant.endsAt) - Date.parse(out.grant.startsAt)).toBe(7 * DAY);
      expect(await storeZero(u.id)).toMatchObject({ plan: 'plus' });
      expect(published(u)).toHaveLength(1);
      expect(published(u)[0]!.envelope.d).toMatchObject({ plan: 'plus', source: 'grant', store: 'play' });
      const endJob = jobs.jobs.find((j) => j.name === 'sub-end' && j.data['userId'] === u.id);
      expect(endJob?.data).toEqual({ userId: u.id, store: 0, atMs: Date.parse(out.grant.endsAt) + 1_000 });
      expect(endJob?.options.delayMs).toBeGreaterThan(7 * DAY - 60_000);
      const audit = await lastAudit(db, { action: 'grant.create', targetType: 1, targetId: u.id });
      expect(audit?.detail).toMatchObject({ grantId: out.grant.id, plan: 'plus', days: 7, reason: 'Support gesture' });
      // The app's own read shows the plan as a grant.
      const ent = (await call(h, '/v1/me/entitlements', { token: u.token, client: 'play/120' })).json<{ plan: string; source: string }>();
      expect(ent).toMatchObject({ plan: 'plus', source: 'grant' });
    });

    it('gives days from a later start: nothing yet, a job at the start and one at the end; nothing told to a person with no build open', async () => {
      const u = await person();
      const start = Date.now() + 3 * DAY;
      const res = await give(finance, { user: u.publicUid, plan: 'premium', days: 30, startsAt: new Date(start).toISOString() });
      expect(res.statusCode, res.body).toBe(201);
      expect(grantRow(res)).toMatchObject({ state: 'scheduled' });
      expect(await storeZero(u.id)).toBeNull();
      const mine = jobs.jobs.filter((j) => j.name === 'sub-end' && j.data['userId'] === u.id).map((j) => j.data['atMs']);
      expect(mine.sort()).toEqual([start, start + 30 * DAY + 1_000].sort());
      expect(published(u)).toHaveLength(0);
    });

    it('keeps an overlapping paid plan and the better of the two counts', async () => {
      const u = await person();
      await seedPurchase(h, { user: u, fakes: { play } });
      await opened(u);
      const res = await give(finance, { user: u.publicUid, plan: 'plus', days: 1 });
      expect(res.statusCode).toBe(201);
      expect((await db.sql.query('SELECT 1 FROM subscriptions WHERE user_id = $1 AND store = 1', [u.id])).rowCount).toBe(1);
      const ent = (await call(h, '/v1/me/entitlements', { token: u.token, client: 'play/120' })).json<{ plan: string; source: string }>();
      expect(ent.plan).toBe('plus');
    });

    it('refuses an unknown, free or archived plan, a start in the past or too far, out-of-range days and an unknown or deleted person', async () => {
      const u = await person();
      const gone = await seedUser(h, { status: 8 });
      const code = async (body: Record<string, unknown>) => {
        const res = await give(finance, { user: u.publicUid, plan: 'plus', days: 3, ...body });
        return [res.statusCode, res.json<{ errors?: { code: string; pointer: string }[] }>().errors?.[0]?.code ?? null];
      };
      expect(await code({ plan: 'nosuchplan' })).toEqual([422, 'unknown_plan']);
      expect(await code({ plan: 'free' })).toEqual([422, 'free_plan']);
      expect(await code({ plan: 'oldgift' })).toEqual([422, 'archived_plan']);
      expect(await code({ startsAt: new Date(Date.now() - DAY).toISOString() })).toEqual([422, 'starts_in_past']);
      expect(await code({ startsAt: new Date(Date.now() + 400 * DAY).toISOString() })).toEqual([422, 'starts_too_far']);
      expect((await give(finance, { user: u.publicUid, plan: 'plus', days: 0 })).statusCode).toBe(400);
      expect((await give(finance, { user: u.publicUid, plan: 'plus', days: 367 })).statusCode).toBe(400);
      expect((await give(finance, { user: u.publicUid, plan: 'plus', days: 3, extra: true })).statusCode).toBe(400);
      expect(await code({ user: gone.publicUid })).toEqual([422, 'unknown_user']);
      expect((await db.sql.query('SELECT 1 FROM entitlement_grants WHERE user_id IN ($1, $2)', [u.id, gone.id])).rowCount).toBe(0);
    });

    it('lets finance, the superadmin and the admin role give; support cannot; a request id counts once, a failed one is free again', async () => {
      const u = await person();
      expect((await give(superadmin, { user: u.publicUid, plan: 'plus', days: 1 })).statusCode).toBe(201);
      expect((await give(adminRole, { user: u.publicUid, plan: 'plus', days: 1 })).statusCode).toBe(201);
      const refused = await give(support, { user: u.publicUid, plan: 'plus', days: 1 });
      expect(refused.statusCode).toBe(403);
      const requestId = randomUUID();
      const gone = await seedUser(h, { status: 8 });
      expect((await give(finance, { requestId, user: gone.publicUid, plan: 'plus', days: 1 })).statusCode).toBe(422);
      expect((await give(finance, { requestId, user: u.publicUid, plan: 'plus', days: 1 })).statusCode).toBe(201);
      const twice = await give(finance, { requestId, user: u.publicUid, plan: 'plus', days: 1 });
      expect(twice.statusCode).toBe(409);
      expect(twice.json()).toMatchObject({ reason: 'duplicate_request' });
      expect((await row<{ n: number }>(db, 'SELECT count(*)::int AS n FROM entitlement_grants WHERE user_id = $1', [u.id])).n).toBe(3);
    });

    it('frees the request id when the write fails before its commit (the id lease lost a moment): the retry gives the days once', async () => {
      const u = await person();
      const requestId = randomUUID();
      const lost = vi.spyOn(h.app.ids, 'nextId').mockImplementationOnce(() => {
        throw new IdGeneratorUnavailableError('lease_stale');
      });
      try {
        const first = await give(finance, { requestId, user: u.publicUid, plan: 'plus', days: 30 });
        expect(first.statusCode, first.body).toBe(503);
        expect(first.json()).toMatchObject({ code: 'service_unavailable' });
      } finally {
        lost.mockRestore();
      }
      const retry = await give(finance, { requestId, user: u.publicUid, plan: 'plus', days: 30 });
      expect(retry.statusCode, retry.body).toBe(201);
      expect((await row<{ n: number }>(db, 'SELECT count(*)::int AS n FROM entitlement_grants WHERE user_id = $1', [u.id])).n).toBe(1);
      expect(await storeZero(u.id)).toMatchObject({ plan: 'plus' });
    });

    it('fails closed when Valkey cannot hold the request id: 503 and nothing given', async () => {
      const u = await person();
      const down = vi.spyOn(h.app.redis, 'set').mockRejectedValueOnce(new Error('valkey down'));
      try {
        const res = await give(finance, { user: u.publicUid, plan: 'plus', days: 3 });
        expect(res.statusCode, res.body).toBe(503);
        expect(res.json()).toMatchObject({ code: 'service_unavailable' });
      } finally {
        down.mockRestore();
      }
      expect((await row<{ n: number }>(db, 'SELECT count(*)::int AS n FROM entitlement_grants WHERE user_id = $1', [u.id])).n).toBe(0);
      expect(await lastAudit(db, { action: 'grant.create', targetType: 1, targetId: u.id })).toBeNull();
    });

    it('ends a grant now (who and why kept), keeps another that overlaps; ended twice is 409, unknown 404; only billing.grant', async () => {
      const u = await person();
      await opened(u);
      const premium = grantRow(await give(finance, { user: u.publicUid, plan: 'premium', days: 5 }));
      const plus = grantRow(await give(finance, { user: u.publicUid, plan: 'plus', days: 10 }));
      expect(await storeZero(u.id)).toMatchObject({ plan: 'premium' });
      expect((await send(adminRole, 'DELETE', `/v1/admin/grants/${premium.id}`, { reason: 'x' })).statusCode).toBe(403);
      realtime.published.splice(0);
      const res = await send(finance, 'DELETE', `/v1/admin/grants/${premium.id}`, { reason: 'Given by mistake' });
      expect(res.statusCode, res.body).toBe(200);
      expect(statements(res)).toBeLessThanOrEqual(5);
      expect(grantRow(res)).toMatchObject({ id: premium.id, state: 'revoked', revokedBy: { id: String(finance.account.id) }, revokeReason: 'Given by mistake' });
      expect(await storeZero(u.id)).toMatchObject({ plan: 'plus' });
      expect(published(u)).toHaveLength(1);
      expect((await lastAudit(db, { action: 'grant.revoke', targetType: 1, targetId: u.id }))?.detail).toMatchObject({ grantId: premium.id, plan: 'premium', reason: 'Given by mistake' });
      const again = await send(finance, 'DELETE', `/v1/admin/grants/${premium.id}`, { reason: 'again' });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ reason: 'grant_ended' });
      expect((await send(finance, 'DELETE', '/v1/admin/grants/999999999', { reason: 'x' })).statusCode).toBe(404);
      // End now returns the person to free.
      expect((await send(finance, 'DELETE', `/v1/admin/grants/${plus.id}`, { reason: 'Done' })).statusCode).toBe(200);
      expect(await storeZero(u.id)).toBeNull();
      const ent = (await call(h, '/v1/me/entitlements', { token: u.token, client: 'play/120' })).json<{ plan: string }>();
      expect(ent.plan).toBe('free');
    });

    it('lists grants newest first, the active ones by end, one person’s; 1 statement each', async () => {
      const u = await person();
      const a = grantRow(await give(finance, { user: u.publicUid, plan: 'plus', days: 9 }));
      const b = grantRow(await give(finance, { user: u.publicUid, plan: 'plus', days: 2 }));
      const c = grantRow(await give(finance, { user: u.publicUid, plan: 'plus', days: 5 }));
      await send(finance, 'DELETE', `/v1/admin/grants/${c.id}`, { reason: 'x' });
      const mine = await send(adminRole, 'GET', `/v1/admin/grants?user=${u.publicUid}`);
      expect(statements(mine)).toBe(1);
      expect(adminGrantListSchema.parse(mine.json()).items.map((g) => g.id)).toEqual([c.id, b.id, a.id]);
      const active = adminGrantListSchema.parse((await send(finance, 'GET', `/v1/admin/grants?user=${u.publicUid}&state=active&limit=1`)).json());
      expect(active.items.map((g) => g.id)).toEqual([b.id]);
      const next = adminGrantListSchema.parse((await send(finance, 'GET', `/v1/admin/grants?user=${u.publicUid}&state=active&limit=1&cursor=${active.nextCursor}`)).json());
      expect(next.items.map((g) => g.id)).toEqual([a.id]);
      const all = await send(finance, 'GET', '/v1/admin/grants?limit=2');
      expect(statements(all)).toBe(1);
      expect(adminGrantListSchema.parse(all.json()).items[0]!.id).toBe(c.id);
      expect((await send(finance, 'GET', '/v1/admin/grants?state=active')).statusCode).toBe(200);
      expect((await send(finance, 'GET', '/v1/admin/grants?user=notapublicid')).statusCode).toBe(400);
      expect((await send(support, 'GET', '/v1/admin/grants')).statusCode).toBe(403);
    });
  });

  describe('the wallet', () => {
    it('gifts to the gifts balance and tells the app; corrections move any balance, never below zero; 3 statements (+1 own)', async () => {
      const u = await person();
      await opened(u);
      const gift = await adjust(adminRole, u, { kind: 'gift', item: 'superlike', quantity: 5, note: 'Sorry for the outage' });
      expect(gift.statusCode, gift.body).toBe(201);
      expect(statements(gift)).toBeLessThanOrEqual(4);
      const entry = adminWalletAdjustResultSchema.parse(gift.json()).entry;
      expect(entry).toMatchObject({ user: { id: u.publicUid }, item: 'superlike', store: null, delta: 5, balanceAfter: 5, reason: 'gift', note: 'Sorry for the outage', admin: { id: String(adminRole.account.id) } });
      expect(await balance(u.id, 1, 0)).toBe(5);
      expect(published(u)).toHaveLength(1);
      expect((await lastAudit(db, { action: 'wallet.gift', targetType: 1, targetId: u.id }))?.detail).toEqual({
        ledgerId: entry.id,
        item: 'superlike',
        balance: 'gifts',
        delta: 5,
        balanceAfter: 5,
        note: 'Sorry for the outage',
      });
      // The admin role gives, but corrects nothing.
      expect((await adjust(adminRole, u, { kind: 'correction', item: 'superlike', delta: -1 })).statusCode).toBe(403);
      expect((await adjust(support, u, { kind: 'gift', item: 'superlike', quantity: 1 })).statusCode).toBe(403);
      const plus = adminWalletAdjustResultSchema.parse((await adjust(finance, u, { kind: 'correction', item: 'boost', balance: 'play', delta: 2 })).json()).entry;
      expect(plus).toMatchObject({ store: 'play', delta: 2, balanceAfter: 2, reason: 'correction' });
      const minus = await adjust(finance, u, { kind: 'correction', item: 'boost', balance: 'play', delta: -2 });
      expect(adminWalletAdjustResultSchema.parse(minus.json()).entry).toMatchObject({ delta: -2, balanceAfter: 0 });
      const before = (await row<{ n: number }>(db, 'SELECT count(*)::int AS n FROM wallet_ledger WHERE user_id = $1', [u.id])).n;
      const short = await adjust(finance, u, { kind: 'correction', item: 'superlike', delta: -6 });
      expect(short.statusCode).toBe(422);
      expect(short.json()).toMatchObject({ errors: [{ pointer: '/delta', code: 'insufficient_balance' }] });
      expect(await balance(u.id, 1, 0)).toBe(5);
      expect((await row<{ n: number }>(db, 'SELECT count(*)::int AS n FROM wallet_ledger WHERE user_id = $1', [u.id])).n).toBe(before);
      // A Bazaar balance with nothing in it cannot be corrected down.
      expect((await adjust(finance, u, { kind: 'correction', item: 'dm', balance: 'bazaar', delta: -3 })).statusCode).toBe(422);
      expect((await adjust(finance, u, { kind: 'correction', item: 'dm', delta: 0 })).statusCode).toBe(400);
      expect((await adjust(finance, u, { kind: 'gift', item: 'dm', quantity: 1001 })).statusCode).toBe(400);
    });

    it('lists every admin gift and correction newest first with notes, and the person’s wallet tab shows the note', async () => {
      const u = await person();
      const first = adminWalletAdjustResultSchema.parse((await adjust(finance, u, { kind: 'gift', item: 'boost', quantity: 1, note: 'First' })).json()).entry;
      const second = adminWalletAdjustResultSchema.parse((await adjust(finance, u, { kind: 'correction', item: 'boost', delta: -1, note: 'Second' })).json()).entry;
      // A purchase credit is not an admin row.
      await seedPurchase(h, { user: u, kind: 'consumable', fakes: { play } });
      const res = await send(adminRole, 'GET', '/v1/admin/wallet-adjustments?limit=2');
      expect(statements(res)).toBe(1);
      const list = adminWalletAdjustmentListSchema.parse(res.json());
      expect(list.items.map((i) => [i.id, i.note])).toEqual([
        [second.id, 'Second'],
        [first.id, 'First'],
      ]);
      const tab = adminUserWalletSchema.parse((await send(finance, 'GET', `/v1/admin/users/${u.publicUid}/wallet`)).json());
      expect(tab.ledger.items.find((l) => l.id === first.id)?.note).toBe('First');
      expect(tab.ledger.items.find((l) => l.reason === 'purchase')?.note).toBeNull();
      expect((await send(support, 'GET', '/v1/admin/wallet-adjustments')).statusCode).toBe(403);
    });

    it('shows an admin’s note to billing and moderation readers only: support reads the wallet tab without it', async () => {
      const u = await person();
      const text = 'Credits taken back: suspected refund abuse';
      const gift = adminWalletAdjustResultSchema.parse((await adjust(finance, u, { kind: 'gift', item: 'boost', quantity: 1, note: text })).json()).entry;
      const tab = async (session: AdminSession) => {
        const res = await send(session, 'GET', `/v1/admin/users/${u.publicUid}/wallet`);
        expect(res.statusCode, res.body).toBe(200);
        return { body: res.body, note: adminUserWalletSchema.parse(res.json()).ledger.items.find((l) => l.id === gift.id)?.note };
      };
      const bySupport = await tab(support);
      expect(bySupport.note).toBeNull();
      expect(bySupport.body).not.toContain('refund abuse');
      expect((await tab(finance)).note).toBe(text);
      expect((await tab(adminRole)).note).toBe(text);
      expect((await tab(superadmin)).note).toBe(text);
    });

    it('rolls a correction back when its audit row is refused: the balance and the ledger stay as they were', async () => {
      const u = await person();
      expect((await adjust(finance, u, { kind: 'gift', item: 'boost', quantity: 3 })).statusCode).toBe(201);
      const ledger = async () => (await row<{ n: number }>(db, 'SELECT count(*)::int AS n FROM wallet_ledger WHERE user_id = $1', [u.id])).n;
      const before = await ledger();
      await refuseAudit(db, 'wallet.correct');
      const requestId = randomUUID();
      expect((await adjust(finance, u, { requestId, kind: 'correction', item: 'boost', delta: -2 })).statusCode).toBe(500);
      expect(await balance(u.id, 2, 0)).toBe(3);
      expect(await ledger()).toBe(before);
      // The request id was freed: once the row can be written, the same dialog's correction goes through.
      await refuseAudit(db);
      const retry = await adjust(finance, u, { requestId, kind: 'correction', item: 'boost', delta: -2 });
      expect(retry.statusCode, retry.body).toBe(201);
      expect(await balance(u.id, 2, 0)).toBe(1);
    });

    it('frees the request id when an id cannot be minted, so the gift goes through on the retry', async () => {
      const u = await person();
      const requestId = randomUUID();
      const lost = vi.spyOn(h.app.ids, 'nextId').mockImplementationOnce(() => {
        throw new IdGeneratorUnavailableError('no_lease');
      });
      try {
        expect((await adjust(finance, u, { requestId, kind: 'gift', item: 'superlike', quantity: 2 })).statusCode).toBe(503);
      } finally {
        lost.mockRestore();
      }
      expect((await adjust(finance, u, { requestId, kind: 'gift', item: 'superlike', quantity: 2 })).statusCode).toBe(201);
      expect(await balance(u.id, 1, 0)).toBe(2);
    });

    it('refuses a deleted or unknown person and a request id used before', async () => {
      const gone = await seedUser(h, { status: 8 });
      expect((await adjust(finance, gone, { kind: 'gift', item: 'boost', quantity: 1 })).statusCode).toBe(404);
      expect((await send(finance, 'POST', '/v1/admin/users/notapublicid/wallet-adjust', { kind: 'gift', requestId: randomUUID(), item: 'boost', quantity: 1, note: 'x' })).statusCode).toBe(400);
      const u = await person();
      const requestId = randomUUID();
      expect((await adjust(finance, u, { requestId, kind: 'gift', item: 'boost', quantity: 1 })).statusCode).toBe(201);
      const twice = await adjust(finance, u, { requestId, kind: 'gift', item: 'boost', quantity: 1 });
      expect(twice.statusCode).toBe(409);
      expect(twice.json()).toMatchObject({ reason: 'duplicate_request' });
      expect(await balance(u.id, 2, 0)).toBe(1);
    });
  });
});
