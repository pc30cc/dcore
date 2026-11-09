import {
  adminPlanListSchema,
  adminPlanSchema,
  adminProductListSchema,
  adminProductSchema,
  configSchema,
  entitlementsSchema,
  problemSchemaFor,
  purchaseResultSchema,
  storeProductsSchema,
  type AdminPlan,
  type AdminProduct,
  type StoreProducts,
} from '@app/shared';
import { FakeRealtimePublisher, FakeStoreVerifier } from '@app/shared/server';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryJobProducer } from '../src/services/jobs.js';
import { call, migratedDatabase, row, seedUser, startHarness, statements, type Harness, type SeededUser, type TestDatabase } from './accountSupport.js';
import { admin, installAuditFailure, refuseAudit, seedAdmin, signIn, startAdminHarness, type AdminHarness } from './adminSupport.js';
import { hasInfrastructure } from './support.js';

/**
 * Plans and store products in the admin panel, end to end on PostgreSQL and
 * Valkey: every route with its audit row in the same transaction (a refused
 * audit row leaves the change undone), the permissions (analyst, support
 * and moderator refused; owner, admin and finance allowed), validation, the
 * free plan's rules, archiving (holders keep the plan, its products go
 * off, a plan is never deleted), the paywall wire with a plan made in the
 * panel (0 statements warm, an ETag that moves with every edit), the
 * entitlements of a new plan key, and a second API process that follows
 * the change through `cfg:changed` without a restart.
 */

const DAY = 86_400_000;
const PLAN_TARGET = 15;
const PRODUCT_TARGET = 14;

describe.skipIf(!hasInfrastructure)('admin: plans and store products', () => {
  let db: TestDatabase;
  let h: AdminHarness;
  let second: Harness | null = null;
  const play = new FakeStoreVerifier('play');
  const bazaar = new FakeStoreVerifier('bazaar');
  const realtime = new FakeRealtimePublisher();
  const jobs = new MemoryJobProducer();
  const tokens = new Map<string, string>();
  /** The buyer of the plan made in the panel. */
  let holder: SeededUser | null = null;

  beforeAll(async () => {
    db = await migratedDatabase();
    await installAuditFailure(db);
    h = await startAdminHarness(db, {}, { jobs, realtime, store: { verifiers: { play, bazaar } } });
    for (const role of ['superadmin', 'admin', 'finance', 'analyst', 'support', 'moderator']) {
      tokens.set(role, (await signIn(h, await seedAdmin(h, { roles: [role] }))).accessToken);
    }
  }, 120_000);

  afterAll(async () => {
    await second?.close();
    await h?.close();
    await db?.drop();
  });

  function token(role = 'superadmin'): string {
    const t = tokens.get(role);
    if (!t) throw new Error(`no admin with ${role}`);
    return t;
  }

  async function send(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, body?: unknown, role = 'superadmin'): Promise<LightMyRequestResponse> {
    return admin(h, url, body, { token: token(role), method });
  }

  /** Every process of this harness has loaded the configuration the last write announced. */
  async function settled(target: Harness = h): Promise<void> {
    const version = Number((await h.redis.get(`${h.prefix}cfg:v`)) ?? 0);
    for (let i = 0; i < 500; i += 1) {
      if ((target.app.cfg.peek()?.version ?? -1) >= version) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`configuration version ${version} was not loaded`);
  }

  async function lastAudit(action: string): Promise<{ target_type: number; target_id: string | null; admin_id: number | null; detail: Record<string, unknown> } | null> {
    const { rows } = await db.sql.query(`SELECT target_type, target_id::text, admin_id, detail FROM audit_log WHERE action = $1 ORDER BY id DESC LIMIT 1`, [action]);
    return (rows[0] as never) ?? null;
  }

  /** Until a statement of this database waits for a row lock (the request under test reached its locking read). */
  async function someoneWaits(): Promise<void> {
    for (let i = 0; i < 400; i += 1) {
      const waiting = await row<{ n: number }>(db, `SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
      if (waiting.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('no statement waited for the lock');
  }

  async function auditCount(action: string): Promise<number> {
    return (await row<{ n: number }>(db, `SELECT count(*)::integer AS n FROM audit_log WHERE action = $1`, [action])).n;
  }

  async function products(u: SeededUser, client: string, locale = 'en', headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    return call(h, '/v1/store/products', { token: u.token, client, headers: { 'accept-language': locale, ...headers } });
  }

  const plan = (res: LightMyRequestResponse): AdminPlan => adminPlanSchema.parse(res.json());
  const product = (res: LightMyRequestResponse): AdminProduct => adminProductSchema.parse(res.json());

  async function createProduct(body: Record<string, unknown>): Promise<AdminProduct> {
    const res = await send('POST', '/v1/admin/store-products', body);
    expect(res.statusCode, res.body).toBe(201);
    return product(res);
  }

  it('refuses analysts, support and moderators; owner, admin and finance may read and write', async () => {
    for (const role of ['analyst', 'support', 'moderator']) {
      const list = await send('GET', '/v1/admin/plans', undefined, role);
      expect(list.statusCode, role).toBe(403);
      expect(problemSchemaFor('forbidden').parse(list.json()).code).toBe('forbidden');
      expect((await send('GET', '/v1/admin/store-products', undefined, role)).statusCode, role).toBe(403);
      expect((await send('PATCH', '/v1/admin/plans/plus', { sort: 5 }, role)).statusCode, role).toBe(403);
      expect((await send('POST', '/v1/admin/plans', { key: 'nope', names: { en: 'Nope' } }, role)).statusCode, role).toBe(403);
      expect((await send('POST', '/v1/admin/store-products/1/activate', undefined, role)).statusCode, role).toBe(403);
    }
    expect((await admin(h, '/v1/admin/plans')).statusCode).toBe(401);
    for (const role of ['superadmin', 'admin', 'finance']) {
      expect((await send('GET', '/v1/admin/plans', undefined, role)).statusCode, role).toBe(200);
      expect((await send('PATCH', '/v1/admin/plans/plus', { sort: 1 }, role)).statusCode, role).toBe(200);
    }
    // Nothing changed for anyone: sort was already 1, so no audit row was due.
    expect(await auditCount('plan.update')).toBe(0);
  });

  it('lists every plan with every switch and quota the code knows, in one statement', async () => {
    const res = await send('GET', '/v1/admin/plans');
    expect(res.statusCode).toBe(200);
    expect(statements(res)).toBe(1);
    const body = adminPlanListSchema.parse(res.json());
    expect(body.items.map((p) => [p.key, p.rank, p.onSale])).toEqual([
      ['free', 0, false],
      ['plus', 1, true],
      ['premium', 2, true],
    ]);
    const plus = body.items[1]!;
    expect(plus.names).toEqual({ en: 'Plus', fa: 'پلاس', tr: 'Plus' });
    expect(plus.features).toMatchObject({ see_likes: true, travel_mode: false, audio_calls: true, video_calls: true });
    expect(plus.quotas).toEqual({ daily_likes: 100, weekly_superlikes: 5, daily_dm: 3, weekly_dm_gift: 0, monthly_boosts: 1 });
    expect(body.catalog.flags.map((f) => f.key)).toContain('incognito');
    expect(body.catalog.quotas.map((q) => q.key)).toEqual(['daily_likes', 'weekly_superlikes', 'daily_dm', 'weekly_dm_gift', 'monthly_boosts']);
    const one = await send('GET', '/v1/admin/plans/premium');
    expect(plan(one).quotas.daily_likes).toBe(-1);
    expect((await send('GET', '/v1/admin/plans/gone')).statusCode).toBe(404);
  });

  it('validates what it is given', async () => {
    const bad: [unknown, number][] = [
      [{ key: 'Gold', names: { en: 'Gold' } }, 400],
      [{ key: 'g', names: { en: 'Gold' } }, 400],
      [{ key: `g${'x'.repeat(31)}`, names: { en: 'Gold' } }, 400],
      [{ key: 'gold', names: { tr: 'Altın' } }, 400],
      [{ key: 'gold', names: { en: '' } }, 400],
      [{ key: 'gold', names: { en: 'Gold', de: 'Gold' } }, 400],
      [{ key: 'gold', names: { en: 'Gold' }, features: { teleport: true } }, 400],
      [{ key: 'gold', names: { en: 'Gold' }, quotas: { daily_likes: -2 } }, 400],
      [{ key: 'gold', names: { en: 'Gold' }, quotas: { daily_likes: 1.5 } }, 400],
      [{ key: 'gold', names: { en: 'Gold' }, features: { see_likes: 'yes' } }, 400],
      [{ key: 'gold', names: { en: 'Gold' }, rank: 0 }, 400],
      [{ key: 'gold', names: { en: 'Gold' }, badge: 'shiny' }, 400],
      [{ key: 'gold', names: { en: 'Gold' }, descriptions: { en: 'x'.repeat(201) } }, 400],
      [{ key: 'gold', names: { en: 'Gold\u0007' } }, 400],
      [{ key: 'gold', names: { en: 'Gold' }, copyFrom: 'nothing' }, 422],
      [{ key: 'plus', names: { en: 'Plus again' } }, 409],
      [{ key: 'free', names: { en: 'Free again' } }, 409],
      [{ key: 'gold', names: { en: 'Gold' }, rank: 1 }, 409],
    ];
    for (const [body, status] of bad) {
      const res = await send('POST', '/v1/admin/plans', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(status);
    }
    expect((await send('PATCH', '/v1/admin/plans/plus', { rank: 2 })).statusCode).toBe(409);
    expect((await send('PATCH', '/v1/admin/plans/plus', { quotas: { monthly_boosts: 1_000_001 } })).statusCode).toBe(400);
    expect((await send('PATCH', '/v1/admin/plans/nope', { sort: 3 })).statusCode).toBe(404);
    expect(await row<{ n: number }>(db, `SELECT count(*)::integer AS n FROM plans`)).toEqual({ n: 3 });
    expect(await auditCount('plan.create')).toBe(0);
  });

  it('creates a plan with its audit row, sells it in both stores, and lists it on the paywall with no statement', async () => {
    const created = await send('POST', '/v1/admin/plans', {
      key: 'gold',
      names: { fa: 'طلایی', en: 'Gold' },
      descriptions: { en: 'Unlimited everything.', fa: 'همه چیز نامحدود.' },
      badge: 'best_value',
      sort: 3,
      copyFrom: 'premium',
      features: { priority_likes: false },
      quotas: { monthly_boosts: 10 },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(statements(created)).toBeLessThanOrEqual(4);
    const gold = plan(created);
    expect(gold).toMatchObject({ key: 'gold', rank: 3, sort: 3, active: true, onSale: true, archivedAt: null, badge: 'best_value', hasLiveSubscriptions: false });
    expect(gold.features).toMatchObject({ travel_mode: true, priority_likes: false, see_likes: true });
    expect(gold.quotas).toMatchObject({ daily_likes: -1, monthly_boosts: 10 });
    const audit = await lastAudit('plan.create');
    expect(audit).toMatchObject({ target_type: PLAN_TARGET, target_id: gold.id });
    expect(audit?.admin_id).not.toBeNull();
    expect(audit?.detail).toMatchObject({ key: 'gold', copyFrom: 'premium', after: { rank: 3, quotas: { monthly_boosts: 10 } } });
    // Every switch and quota is a row of its own.
    expect(await row<{ n: number }>(db, `SELECT count(*)::integer AS n FROM plan_features WHERE plan_id = $1`, [Number(gold.id)])).toEqual({ n: 16 });

    const playRow = await createProduct({ store: 'play', kind: 'subscription', productId: 'sub.gold', basePlanId: 'm1', plan: 'gold', period: 'P1M', sort: 30, badge: 'popular', active: true, listPrice: { amountMinor: 999, currency: 'USD' } });
    expect(playRow).toMatchObject({ store: 'play', kind: 'subscription', plan: 'gold', period: 'P1M', active: true, badge: 'popular', hasPurchases: false, listPrice: { amountMinor: 999, currency: 'USD' } });
    expect(await lastAudit('product.create')).toMatchObject({ target_type: PRODUCT_TARGET, target_id: playRow.id });
    await createProduct({ store: 'bazaar', kind: 'subscription', productId: 'sub.gold.1m', plan: 'gold', period: 'P1M', active: true, listPrice: { amountMinor: 50_000_000, currency: 'IRR' } });
    await createProduct({ store: 'play', kind: 'consumable', productId: 'cons.boost.25', item: 'boost', quantity: 25, active: true, sort: 45 });
    await settled();

    const u = await seedUser(h, { store: 1, name: 'Sam' });
    const res = await products(u, 'play/120', 'en');
    expect(res.statusCode).toBe(200);
    expect(statements(res)).toBe(0);
    const body: StoreProducts = storeProductsSchema.parse(res.json());
    expect(body.plans.map((p) => p.key)).toEqual(['gold']);
    expect(body.plans[0]).toMatchObject({ key: 'gold', rank: 3, sort: 3, name: 'Gold', description: 'Unlimited everything.', badge: 'best_value' });
    expect(body.plans[0]!.quotas).toMatchObject({ daily_likes: -1, monthly_boosts: 10 });
    expect(body.subscriptions).toEqual([{ productId: 'sub.gold', basePlanId: 'm1', plan: 'gold', period: 'P1M', badge: 'popular', sort: 30 }]);
    expect(body.consumables.map((c) => c.productId)).toEqual(['cons.boost.25']);
    expect(JSON.stringify(body)).not.toMatch(/price|amountMinor|USD/i);
    // The session's language, then Persian.
    const fa = storeProductsSchema.parse((await products(u, 'play/120', 'fa')).json());
    expect(fa.plans[0]).toMatchObject({ name: 'طلایی', description: 'همه چیز نامحدود.' });
    const tr = storeProductsSchema.parse((await products(u, 'play/120', 'tr')).json());
    expect(tr.plans[0]).toMatchObject({ name: 'طلایی', description: 'همه چیز نامحدود.' });
    // The Bazaar build sees its own row.
    const b = await seedUser(h, { store: 2, name: 'Kim' });
    const theirs = storeProductsSchema.parse((await products(b, 'bazaar/120', 'fa')).json());
    expect(theirs.subscriptions).toEqual([{ productId: 'sub.gold.1m', plan: 'gold', period: 'P1M', sort: 0 }]);
    expect(theirs.plans.map((p) => p.key)).toEqual(['gold']);
    // GET /v1/config names it too.
    const config = configSchema.parse((await call(h, '/v1/config?store=play&locale=en')).json());
    expect(config.planNames).toMatchObject({ plus: 'Plus', premium: 'Premium', gold: 'Gold' });
  });

  it('moves the ETag with every plan or product edit, per language, so a stored 304 never hides one', async () => {
    const u = await seedUser(h, { store: 1, name: 'Ari' });
    const first = await products(u, 'play/120', 'en');
    const etag = String(first.headers['etag']);
    expect(etag).toMatch(/^"p[A-Za-z0-9_-]{12}\.en-[a-z2-7]{13}"$/);
    expect((await products(u, 'play/120', 'en', { 'if-none-match': etag })).statusCode).toBe(304);
    // Another language never answers 304 to this one's ETag.
    expect((await products(u, 'play/120', 'fa', { 'if-none-match': etag })).statusCode).toBe(200);

    const edited = await send('PATCH', '/v1/admin/plans/gold', { quotas: { daily_likes: 777 }, features: { rewind: false }, descriptions: { en: 'Almost everything.' } });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(plan(edited)).toMatchObject({ quotas: { daily_likes: 777 }, features: { rewind: false }, descriptions: { en: 'Almost everything.' } });
    const audit = await lastAudit('plan.update');
    expect(audit?.detail).toMatchObject({ key: 'gold', changed: ['descriptions', 'features.rewind', 'features.daily_likes'], before: { quotas: { daily_likes: -1 } }, after: { quotas: { daily_likes: 777 } } });
    await settled();
    const after = await products(u, 'play/120', 'en', { 'if-none-match': etag });
    expect(after.statusCode).toBe(200);
    expect(statements(after)).toBe(0);
    const body = storeProductsSchema.parse(after.json());
    expect(body.plans[0]).toMatchObject({ description: 'Almost everything.', quotas: { daily_likes: 777 }, features: { rewind: false } });
    const etag2 = String(after.headers['etag']);
    expect(etag2).not.toBe(etag);

    // A product edit moves it too.
    const listed = adminProductListSchema.parse((await send('GET', '/v1/admin/store-products?store=play')).json()).items;
    const row = listed.find((p) => p.productId === 'sub.gold')!;
    expect((await send('PATCH', `/v1/admin/store-products/${row.id}`, { sort: 31 })).statusCode).toBe(200);
    await settled();
    const third = await products(u, 'play/120', 'en', { 'if-none-match': etag2 });
    expect(third.statusCode).toBe(200);
    expect(storeProductsSchema.parse(third.json()).subscriptions[0]?.sort).toBe(31);
  });

  it('gives a buyer of the new plan its key, switches and quotas, and follows a later edit without a new purchase', async () => {
    const u = await seedUser(h, { store: 1, name: 'Noa' });
    holder = u;
    const purchaseToken = `play-gold-token-${u.id}`;
    play.put(purchaseToken, { kind: 'subscription', productId: 'sub.gold', basePlanId: 'm1', accountRef: h.app.publicIds.billing.encode(u.id), expiresAtMs: Date.now() + 30 * DAY });
    const bought = await call(h, '/v1/store/play/purchases', { method: 'POST', token: u.token, client: 'play/120', body: { productId: 'sub.gold', purchaseToken, kind: 'subscription' } });
    expect(bought.statusCode, bought.body).toBe(200);
    const result = purchaseResultSchema.parse(bought.json());
    expect(result.entitlements).toMatchObject({ plan: 'gold', source: 'play', productId: 'sub.gold', basePlanId: 'm1', features: { travel_mode: true, rewind: false } });
    expect(result.entitlements.quotas.likes?.limit).toBe(777);
    expect(result.entitlements.quotas.boosts?.limit).toBe(10);

    const read = await call(h, '/v1/me/entitlements', { token: u.token, client: 'play/120' });
    const etag = String(read.headers['etag']);
    expect(statements(read)).toBe(0);
    expect(entitlementsSchema.parse(read.json()).plan).toBe('gold');

    expect((await send('PATCH', '/v1/admin/plans/gold', { quotas: { daily_likes: 888 }, features: { incognito: false } })).statusCode).toBe(200);
    await settled();
    const again = await call(h, '/v1/me/entitlements', { token: u.token, client: 'play/120', headers: { 'if-none-match': etag } });
    expect(again.statusCode).toBe(200);
    expect(statements(again)).toBe(0);
    const ent = entitlementsSchema.parse(again.json());
    expect(ent.quotas.likes?.limit).toBe(888);
    expect(ent.features.incognito).toBe(false);
    // The admin list now says someone holds it.
    expect(plan(await send('GET', '/v1/admin/plans/gold')).hasLiveSubscriptions).toBe(true);
    // What the product grants is fixed now that a purchase names it.
    const row = adminProductListSchema.parse((await send('GET', '/v1/admin/store-products?store=play')).json()).items.find((p) => p.productId === 'sub.gold')!;
    expect(row.hasPurchases).toBe(true);
    for (const change of [{ productId: 'sub.gold2' }, { basePlanId: 'm2' }, { plan: 'premium' }, { period: 'P3M' }]) {
      const res = await send('PATCH', `/v1/admin/store-products/${row.id}`, change);
      expect(res.statusCode, JSON.stringify(change)).toBe(409);
    }
    const priced = await send('PATCH', `/v1/admin/store-products/${row.id}`, { listPrice: { amountMinor: 1099, currency: 'USD' }, badge: null });
    expect(priced.statusCode).toBe(200);
    expect(product(priced)).toMatchObject({ listPrice: { amountMinor: 1099, currency: 'USD' }, badge: null });
  });

  it('keeps the free plan the baseline: its switches and quotas change, its rank, sale and existence do not', async () => {
    expect((await send('PATCH', '/v1/admin/plans/free', { rank: 5 })).statusCode).toBe(422);
    expect((await send('PATCH', '/v1/admin/plans/free', { active: false })).statusCode).toBe(422);
    expect((await send('POST', '/v1/admin/plans/free/archive')).statusCode).toBe(409);
    expect((await send('POST', '/v1/admin/store-products', { store: 'play', kind: 'subscription', productId: 'sub.free', basePlanId: 'm1', plan: 'free', period: 'P1M' })).statusCode).toBe(422);
    const edited = await send('PATCH', '/v1/admin/plans/free', { quotas: { daily_likes: 30 }, features: { rewind: true }, names: { fa: 'رایگان', en: 'Basic' } });
    expect(edited.statusCode).toBe(200);
    expect(plan(edited)).toMatchObject({ rank: 0, quotas: { daily_likes: 30 }, features: { rewind: true }, names: { fa: 'رایگان', en: 'Basic' } });
    await settled();
    const u = await seedUser(h, { store: 2, name: 'Lee' });
    const ent = entitlementsSchema.parse((await call(h, '/v1/me/entitlements', { token: u.token, client: 'bazaar/120' })).json());
    expect(ent).toMatchObject({ plan: 'free', features: { rewind: true }, quotas: { likes: { limit: 30 } } });
    // A plan is never deleted, not even by hand.
    await expect(db.sql.query(`DELETE FROM plans WHERE key = 'gold'`)).rejects.toThrow(/never deleted/);
  });

  it('reorders plans in one statement, swapping ranks, and refuses an incomplete order', async () => {
    expect((await send('PUT', '/v1/admin/plan-ranks', { order: ['plus', 'gold'] })).statusCode).toBe(422);
    expect((await send('PUT', '/v1/admin/plan-ranks', { order: ['plus', 'premium', 'gold', 'plus'] })).statusCode).toBe(422);
    expect((await send('PUT', '/v1/admin/plan-ranks', { order: ['free', 'plus', 'premium', 'gold'] })).statusCode).toBe(422);
    const res = await send('PUT', '/v1/admin/plan-ranks', { order: ['premium', 'plus', 'gold'] });
    expect(res.statusCode, res.body).toBe(200);
    expect(statements(res)).toBeLessThanOrEqual(7);
    expect(adminPlanListSchema.parse(res.json()).items.map((p) => [p.key, p.rank])).toEqual([
      ['free', 0],
      ['premium', 1],
      ['plus', 2],
      ['gold', 3],
    ]);
    expect((await lastAudit('plan.reorder'))?.detail).toMatchObject({ before: { plus: 1, premium: 2, gold: 3 }, after: { premium: 1, plus: 2, gold: 3 } });
    // The same order again changes nothing and writes no row.
    const before = await auditCount('plan.reorder');
    expect((await send('PUT', '/v1/admin/plan-ranks', { order: ['premium', 'plus', 'gold'] })).statusCode).toBe(200);
    expect(await auditCount('plan.reorder')).toBe(before);
    expect((await send('PUT', '/v1/admin/plan-ranks', { order: ['plus', 'premium', 'gold'] })).statusCode).toBe(200);
  });

  it('archives a plan: off sale, its products off, holders keep it; it comes back off sale', async () => {
    const archived = await send('POST', '/v1/admin/plans/gold/archive');
    expect(archived.statusCode, archived.body).toBe(200);
    expect(plan(archived)).toMatchObject({ active: false, onSale: false, hasLiveSubscriptions: true });
    expect(plan(archived).archivedAt).not.toBeNull();
    const audit = await lastAudit('plan.archive');
    expect(audit?.detail).toMatchObject({ key: 'gold', liveSubscriptions: true });
    const off = (audit?.detail['deactivatedProducts'] as number[]) ?? [];
    expect(off.length).toBe(2);
    expect(await row<{ n: number }>(db, `SELECT count(*)::integer AS n FROM store_products WHERE plan_id = (SELECT id FROM plans WHERE key = 'gold') AND is_active`)).toEqual({ n: 0 });
    expect(await auditCount('product.deactivate')).toBeGreaterThanOrEqual(2);
    // Again: nothing to do.
    expect((await send('POST', '/v1/admin/plans/gold/archive')).statusCode).toBe(200);
    expect(await auditCount('plan.archive')).toBe(1);
    await settled();

    const buyer = await seedUser(h, { store: 1, name: 'Ola' });
    const listing = storeProductsSchema.parse((await products(buyer, 'play/120')).json());
    expect(listing.plans.map((p) => p.key)).not.toContain('gold');
    expect(listing.subscriptions.some((s) => s.plan === 'gold')).toBe(false);
    // The holder from before keeps it, with its switches and quotas, until the period ends.
    if (!holder) throw new Error('no holder of gold');
    const held = entitlementsSchema.parse((await call(h, '/v1/me/entitlements', { token: holder.token, client: 'play/120' })).json());
    expect(held).toMatchObject({ plan: 'gold', source: 'play', quotas: { likes: { limit: 888 } } });

    expect((await send('PATCH', '/v1/admin/plans/gold', { active: true })).statusCode).toBe(409);
    const products_ = adminProductListSchema.parse((await send('GET', '/v1/admin/store-products?store=play')).json()).items;
    const goldRow = products_.find((p) => p.productId === 'sub.gold')!;
    expect((await send('POST', `/v1/admin/store-products/${goldRow.id}/activate`)).statusCode).toBe(409);
    expect((await send('PATCH', `/v1/admin/store-products/${goldRow.id}`, { active: true })).statusCode).toBe(409);
    expect((await send('POST', '/v1/admin/store-products', { store: 'play', kind: 'subscription', productId: 'sub.gold', basePlanId: 'm3', plan: 'gold', period: 'P3M' })).statusCode).toBe(409);

    const back = await send('POST', '/v1/admin/plans/gold/unarchive');
    expect(back.statusCode).toBe(200);
    expect(plan(back)).toMatchObject({ archivedAt: null, active: false, onSale: false });
    expect((await send('PATCH', '/v1/admin/plans/gold', { active: true })).statusCode).toBe(200);
    expect(product(await send('POST', `/v1/admin/store-products/${goldRow.id}/activate`))).toMatchObject({ active: true });
    expect(await lastAudit('product.activate')).toMatchObject({ target_type: PRODUCT_TARGET, target_id: goldRow.id });
  });

  it('holds each store’s product rules', async () => {
    const refusals: [Record<string, unknown>, number][] = [
      [{ store: 'bazaar', kind: 'subscription', productId: 'sub.x.1m', basePlanId: 'm1', plan: 'plus', period: 'P1M' }, 422],
      [{ store: 'bazaar', kind: 'subscription', productId: 'sub.x.1w', plan: 'plus', period: 'P1W' }, 422],
      [{ store: 'play', kind: 'subscription', productId: 'sub.x', plan: 'plus', period: 'P1M' }, 422],
      [{ store: 'play', kind: 'subscription', productId: 'sub.x', basePlanId: 'm1', plan: 'nobody', period: 'P1M' }, 422],
      [{ store: 'play', kind: 'subscription', productId: 'sub.x', basePlanId: 'm1', plan: 'plus', period: 'P2M' }, 400],
      [{ store: 'play', kind: 'subscription', productId: 'Sub.X', basePlanId: 'm1', plan: 'plus', period: 'P1M' }, 400],
      [{ store: 'play', kind: 'consumable', productId: 'cons.x', item: 'gem', quantity: 1 }, 400],
      [{ store: 'play', kind: 'consumable', productId: 'cons.x', item: 'boost', quantity: 0 }, 400],
      [{ store: 'play', kind: 'consumable', productId: 'cons.x', item: 'boost', quantity: 1, plan: 'plus' }, 400],
      [{ store: 'play', kind: 'consumable', productId: 'cons.x', item: 'boost', quantity: 1, listPrice: { amountMinor: 1, currency: 'usd' } }, 400],
      [{ store: 'app_store', kind: 'consumable', productId: 'cons.x', item: 'boost', quantity: 1 }, 400],
      // sub.plus/m1 exists; sub.plus is plus's, so another base plan of it cannot be premium's; cons.boost.1 is a consumable.
      [{ store: 'play', kind: 'subscription', productId: 'sub.plus', basePlanId: 'm1', plan: 'plus', period: 'P1M' }, 409],
      [{ store: 'play', kind: 'subscription', productId: 'sub.plus', basePlanId: 'y1', plan: 'premium', period: 'P12M' }, 422],
      [{ store: 'play', kind: 'subscription', productId: 'cons.boost.1', basePlanId: 'm1', plan: 'plus', period: 'P1M' }, 422],
    ];
    for (const [body, status] of refusals) {
      const res = await send('POST', '/v1/admin/store-products', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(status);
    }
    const year = await createProduct({ store: 'play', kind: 'subscription', productId: 'sub.plus', basePlanId: 'y1', plan: 'plus', period: 'P12M' });
    expect(year).toMatchObject({ active: false, plan: 'plus', basePlanId: 'y1' });
    expect((await send('PATCH', `/v1/admin/store-products/${year.id}`, { item: 'boost' })).statusCode).toBe(422);
    expect((await send('PATCH', `/v1/admin/store-products/${year.id}`, { basePlanId: null })).statusCode).toBe(422);
    expect((await send('PATCH', `/v1/admin/store-products/${year.id}`, { basePlanId: 'm1' })).statusCode).toBe(409);
    expect((await send('PATCH', `/v1/admin/store-products/${year.id}`, { plan: 'premium' })).statusCode).toBe(422);
    // Unused: what it grants may still change.
    expect(product(await send('PATCH', `/v1/admin/store-products/${year.id}`, { basePlanId: 'y2', period: 'P6M' }))).toMatchObject({ basePlanId: 'y2', period: 'P6M' });
    const cons = await createProduct({ store: 'bazaar', kind: 'consumable', productId: 'cons.superlike.50', item: 'superlike', quantity: 50 });
    expect((await send('PATCH', `/v1/admin/store-products/${cons.id}`, { period: 'P1M' })).statusCode).toBe(422);
    expect(product(await send('PATCH', `/v1/admin/store-products/${cons.id}`, { quantity: 60, listPrice: { amountMinor: 120_000_000, currency: 'IRR' } }))).toMatchObject({ quantity: 60, item: 'superlike' });
    expect((await send('PATCH', '/v1/admin/store-products/32000', { sort: 1 })).statusCode).toBe(404);
    expect((await send('PATCH', `/v1/admin/store-products/${cons.id}`, { teleport: 1 })).statusCode).toBe(400);
    const bazaarOnly = adminProductListSchema.parse((await send('GET', '/v1/admin/store-products?store=bazaar')).json()).items;
    expect(bazaarOnly.every((p) => p.store === 'bazaar' && p.basePlanId === null)).toBe(true);
    expect(bazaarOnly.some((p) => p.productId === 'cons.superlike.50')).toBe(true);
    const all = await send('GET', '/v1/admin/store-products');
    expect(statements(all)).toBe(1);
    // Deactivated: not listed any more.
    const boost = adminProductListSchema.parse(all.json()).items.find((p) => p.productId === 'cons.boost.25')!;
    expect(product(await send('POST', `/v1/admin/store-products/${boost.id}/deactivate`))).toMatchObject({ active: false });
    await settled();
    const u = await seedUser(h, { store: 1, name: 'Rin' });
    expect(storeProductsSchema.parse((await products(u, 'play/120')).json()).consumables.some((c) => c.productId === 'cons.boost.25')).toBe(false);
  });

  it('writes nothing when its audit row cannot be written, for every write route', async () => {
    const rows = adminProductListSchema.parse((await send('GET', '/v1/admin/store-products?store=play')).json()).items;
    const inactive = rows.find((p) => !p.active && p.productId === 'cons.boost.25')!;
    const active = rows.find((p) => p.active && p.productId === 'sub.gold')!;
    const snapshot = async () =>
      JSON.stringify([
        (await db.sql.query(`SELECT key, rank, sort, is_active, archived_at, badge, names, descriptions FROM plans ORDER BY id`)).rows,
        (await db.sql.query(`SELECT plan_id, feature, value FROM plan_features ORDER BY plan_id, feature`)).rows,
        (await db.sql.query(`SELECT id, product_id, base_plan_id, plan_id, period, grant_item, grant_qty, badge, sort, is_active, list_price_minor FROM store_products ORDER BY id`)).rows,
      ]);
    const cases: [string, () => Promise<LightMyRequestResponse>][] = [
      ['plan.create', () => send('POST', '/v1/admin/plans', { key: 'silver', names: { en: 'Silver' } })],
      ['plan.update', () => send('PATCH', '/v1/admin/plans/plus', { quotas: { daily_likes: 101 } })],
      ['plan.archive', () => send('POST', '/v1/admin/plans/premium/archive')],
      ['plan.reorder', () => send('PUT', '/v1/admin/plan-ranks', { order: ['gold', 'plus', 'premium'] })],
      ['product.create', () => send('POST', '/v1/admin/store-products', { store: 'play', kind: 'consumable', productId: 'cons.dm.50', item: 'dm', quantity: 50 })],
      ['product.update', () => send('PATCH', `/v1/admin/store-products/${active.id}`, { sort: 77 })],
      ['product.activate', () => send('POST', `/v1/admin/store-products/${inactive.id}/activate`)],
      ['product.deactivate', () => send('POST', `/v1/admin/store-products/${active.id}/deactivate`)],
    ];
    for (const [action, write] of cases) {
      const before = await snapshot();
      const count = await auditCount(action);
      await refuseAudit(db, action);
      const res = await write();
      expect(res.statusCode, `${action}: ${res.body}`).toBe(500);
      expect(await snapshot(), action).toBe(before);
      expect(await auditCount(action), action).toBe(count);
    }
    await refuseAudit(db);
    // The unarchive of an archived plan rolls back the same way.
    expect((await send('POST', '/v1/admin/plans/premium/archive')).statusCode).toBe(200);
    await refuseAudit(db, 'plan.unarchive');
    expect((await send('POST', '/v1/admin/plans/premium/unarchive')).statusCode).toBe(500);
    expect(await row<{ archived: boolean }>(db, `SELECT archived_at IS NOT NULL AS archived FROM plans WHERE key = 'premium'`)).toEqual({ archived: true });
    await refuseAudit(db);
    expect((await send('POST', '/v1/admin/plans/premium/unarchive')).statusCode).toBe(200);
  });

  it('reaches a second API process through cfg:changed, without a restart', async () => {
    second = await startHarness(db, { REDIS_KEY_PREFIX: h.prefix }, { store: { verifiers: { play, bazaar } } });
    await settled(second);
    const u = await seedUser(second, { store: 1, name: 'Two' });
    const before = storeProductsSchema.parse((await call(second, '/v1/store/products', { token: u.token, client: 'play/120' })).json());
    expect(before.plans.map((p) => p.key)).not.toContain('silver');

    const made = await send('POST', '/v1/admin/plans', { key: 'silver', names: { en: 'Silver' }, rank: 50, quotas: { daily_likes: 42 } });
    expect(made.statusCode, made.body).toBe(201);
    await createProduct({ store: 'play', kind: 'subscription', productId: 'sub.silver', basePlanId: 'm1', plan: 'silver', period: 'P1M', active: true });
    await settled(second);
    const res = await call(second, '/v1/store/products', { token: u.token, client: 'play/120', headers: { 'accept-language': 'en' } });
    expect(statements(res)).toBe(0);
    const after = storeProductsSchema.parse(res.json());
    expect(after.plans.find((p) => p.key === 'silver')).toMatchObject({ name: 'Silver', rank: 50, quotas: { daily_likes: 42 } });
    expect(after.subscriptions.some((s) => s.productId === 'sub.silver' && s.plan === 'silver')).toBe(true);
    // The process that wrote it has it too.
    const own = storeProductsSchema.parse((await products(await seedUser(h, { store: 1, name: 'One' }), 'play/120')).json());
    expect(own.plans.map((p) => p.key)).toContain('silver');
  });

  it('reads a plan’s “before” once its lock is held: an edit that waited for another one sees its result', async () => {
    const current = plan(await send('GET', '/v1/admin/plans/plus')).quotas.daily_likes;
    const other = await db.sql.connect();
    let open = false;
    try {
      // Another edit of plus, not committed yet: daily likes to 50.
      await other.query('BEGIN');
      open = true;
      await other.query(`SELECT id FROM plans WHERE key = 'plus' FOR NO KEY UPDATE`);
      await other.query(`UPDATE plan_features SET value = '50' WHERE plan_id = (SELECT id FROM plans WHERE key = 'plus') AND feature = 'daily_likes'`);
      await other.query(`UPDATE plans SET updated_at = now() WHERE key = 'plus'`);
      // This edit sets them back to what it saw: it waits for the lock, then must see 50 and change it.
      const pending = send('PATCH', '/v1/admin/plans/plus', { quotas: { daily_likes: current } });
      await someoneWaits();
      await other.query('COMMIT');
      open = false;
      const res = await pending;
      expect(res.statusCode, res.body).toBe(200);
      expect(plan(res).quotas.daily_likes).toBe(current);
      const stored = await row<{ value: number }>(db, `SELECT value::integer AS value FROM plan_features WHERE plan_id = (SELECT id FROM plans WHERE key = 'plus') AND feature = 'daily_likes'`);
      expect(stored.value).toBe(current);
      expect((await lastAudit('plan.update'))?.detail).toMatchObject({ key: 'plus', changed: ['features.daily_likes'], before: { quotas: { daily_likes: 50 } }, after: { quotas: { daily_likes: current } } });
    } finally {
      if (open) await other.query('ROLLBACK');
      other.release();
    }
  });

  it('reads a product’s purchases once its lock is held: a first purchase in flight fixes what it grants', async () => {
    const raced = await createProduct({ store: 'play', kind: 'subscription', productId: 'sub.race', basePlanId: 'm1', plan: 'plus', period: 'P1M' });
    expect(raced.hasPurchases).toBe(false);
    const other = await db.sql.connect();
    let open = false;
    try {
      // The first purchase naming it, not committed yet (its foreign key holds the product's row FOR KEY SHARE).
      await other.query('BEGIN');
      open = true;
      await other.query(
        `INSERT INTO store_purchases (id, purchased_at, expires_at, product_ref, store, kind, state, token_hash, token)
         VALUES (id_next(), now(), now() + interval '30 days', $1, 1, 1, 11, sha256('race-token-0001'::bytea), 'race-token-0001')`,
        [Number(raced.id)],
      );
      const pending = send('PATCH', `/v1/admin/store-products/${raced.id}`, { period: 'P3M' });
      await someoneWaits();
      await other.query('COMMIT');
      open = false;
      const res = await pending;
      expect(res.statusCode, res.body).toBe(409);
      const after = adminProductListSchema.parse((await send('GET', '/v1/admin/store-products?store=play')).json()).items.find((p) => p.id === raced.id)!;
      expect(after).toMatchObject({ period: 'P1M', hasPurchases: true });
    } finally {
      if (open) await other.query('ROLLBACK');
      other.release();
    }
  });

  it('recomputes who holds which plan when the upgrade order changes, and their entitlements follow at once', async () => {
    const u = await seedUser(h, { store: 1, name: 'Both' });
    for (const key of ['plus', 'premium']) {
      await db.sql.query(
        `INSERT INTO entitlement_grants (id, user_id, starts_at, ends_at, plan_id, reason)
         VALUES (id_next(), $1, now() - interval '1 day', now() + interval '20 days', (SELECT id FROM plans WHERE key = $2), 'support')`,
        [u.id, key],
      );
    }
    await db.sql.query(`SELECT subscription_recompute($1::bigint, 0::smallint)`, [u.id]);
    const held = async () => (await row<{ key: string }>(db, `SELECT p.key FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.user_id = $1 AND s.store = 0`, [u.id])).key;
    const entitled = async () => entitlementsSchema.parse((await call(h, '/v1/me/entitlements', { token: u.token, client: 'play/120' })).json()).plan;
    const ranks = Object.fromEntries(adminPlanListSchema.parse((await send('GET', '/v1/admin/plans')).json()).items.map((p) => [p.key, p.rank]));
    expect(ranks['premium']).toBeGreaterThan(ranks['plus']!);
    expect(await held()).toBe('premium');
    expect(await entitled()).toBe('premium');
    // Cached now: the next read costs no statement.
    expect(statements(await call(h, '/v1/me/entitlements', { token: u.token, client: 'play/120' }))).toBe(0);

    // Plus above premium: the row and the entitlements follow without any purchase or grant event.
    const order = adminPlanListSchema.parse((await send('GET', '/v1/admin/plans')).json()).items.filter((p) => p.key !== 'free' && p.key !== 'premium' && p.key !== 'plus').map((p) => p.key);
    const reordered = await send('PUT', '/v1/admin/plan-ranks', { order: ['premium', 'plus', ...order] });
    expect(reordered.statusCode, reordered.body).toBe(200);
    expect(statements(reordered)).toBeLessThanOrEqual(7);
    expect(await held()).toBe('plus');
    expect((await lastAudit('plan.reorder'))?.detail).toMatchObject({ subscriptionsRecomputed: 1 });
    await settled();
    expect(await entitled()).toBe('plus');

    // One rank by PATCH does the same.
    const patched = await send('PATCH', '/v1/admin/plans/premium', { rank: 60 });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(statements(patched)).toBeLessThanOrEqual(7);
    expect(await held()).toBe('premium');
    expect((await lastAudit('plan.update'))?.detail).toMatchObject({ key: 'premium', changed: ['rank'], subscriptionsRecomputed: 1 });
    await settled();
    expect(await entitled()).toBe('premium');
  });
});
