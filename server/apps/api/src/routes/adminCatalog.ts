import {
  catalogPlan,
  catalogPlanArchive,
  catalogPlanCreate,
  catalogPlanForUpdate,
  catalogPlanRanks,
  catalogPlanRef,
  catalogPlanUpdate,
  catalogPlans,
  catalogPlansForUpdate,
  catalogProduct,
  catalogProductCreate,
  catalogProductForUpdate,
  catalogProductSiblings,
  catalogProductUpdate,
  catalogProducts,
  catalogRankDependents,
  catalogRecomputeSubscriptions,
  type CatalogPlanPatch,
  type CatalogPlanRef,
  type CatalogPlanRow,
  type CatalogProductPatch,
  type CatalogProductRow,
  type PoolClient,
  type RankDependent,
} from '@app/db';
import {
  FREE_PLAN_KEY,
  adminPlanCreateSchema,
  adminPlanKeyParamsSchema,
  adminPlanListSchema,
  adminPlanRanksSchema,
  adminPlanSchema,
  adminPlanUpdateSchema,
  adminProductCreateSchema,
  adminProductIdParamsSchema,
  adminProductListQuerySchema,
  adminProductListSchema,
  adminProductSchema,
  adminProductUpdateSchema,
  appStores,
  badgeCode,
  planBadge,
  planFeatureCatalog,
  planFlags,
  planQuotas,
  productBadge,
  productKind,
  store as storeCodes,
  walletItem,
  wireTime,
  type AdminPlan,
  type AdminProduct,
  type AppStore,
} from '@app/shared';
import { planOnSale } from '@app/shared/server';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { adminWrite } from '../admin/audit.js';
import { dbErrorInfo } from '../lib/dbErrors.js';
import { HttpProblem } from '../lib/problem.js';

/**
 * Plans and store products in the admin panel: every field of a plan is
 * editable, plans are created here, and store products are managed per
 * store:
 *
 *   GET   /v1/admin/plans                        every plan by rank, and the switches and quotas the code knows
 *   GET   /v1/admin/plans/:key
 *   POST  /v1/admin/plans                        a new plan (neutral key, never reused)
 *   PATCH /v1/admin/plans/:key                   names, descriptions, rank, sort, on sale, badge, switches, quotas
 *   POST  /v1/admin/plans/:key/archive           off sale for good (its products off); holders keep it
 *   POST  /v1/admin/plans/:key/unarchive         back, still off sale
 *   PUT   /v1/admin/plan-ranks                   the upgrade order of every plan but free
 *   GET   /v1/admin/store-products?store=
 *   POST  /v1/admin/store-products               a Play or Cafe Bazaar row: subscription or consumable
 *   PATCH /v1/admin/store-products/:id
 *   POST  /v1/admin/store-products/:id/activate|deactivate
 *
 * Reads need `billing.read`, writes `billing.catalog` (the superadmin, admin
 * and finance roles by default). Reads go to the database (one statement), so
 * the panel sees its own write at once. Every write locks the rows it
 * changes (and reads its "before" after the lock is held), writes its audit
 * row (before/after) in its transaction, and then announces `cfg:changed`:
 * every API process loads the catalogue again from the database once (the
 * worker within seconds, on its next `cfg:v` look), so apps see the change
 * without a restart and their reads stay in memory. A change of ranks also
 * recomputes, in its transaction, the subscriptions rows of people holding
 * more than one plan in a store, and moves their entitlement versions.
 *
 * Rules the code holds (the database holds the rest with its CHECKs):
 * - the free plan is everyone's baseline: its rank stays 0, it stays on,
 *   and it is never archived or sold; its switches and quotas are editable;
 * - a plan is never deleted; an archived plan is off sale, its products are
 *   turned off, and holders keep it while their subscription or grant lasts;
 * - what a product grants (product id, base plan, plan, period, item,
 *   quantity) is fixed once a purchase names it; store and kind never
 *   change; rows of one product id in a store are of one kind and, for a
 *   subscription, of one plan;
 * - Play subscriptions carry a base plan; Cafe Bazaar rows never do, and
 *   Cafe Bazaar sells no weekly period.
 */

function invalid(pointer: string, code: string, message: string): HttpProblem {
  return new HttpProblem('field_invalid', { detail: message, errors: [{ in: 'body', pointer, code, message }] });
}

function strings(texts: Readonly<Record<string, unknown>>): AdminPlan['names'] {
  const out: AdminPlan['names'] = {};
  for (const locale of ['fa', 'en', 'tr'] as const) {
    const value = texts[locale];
    if (typeof value === 'string' && value.length > 0) out[locale] = value;
  }
  return out;
}

function planView(row: CatalogPlanRow): AdminPlan {
  const badge = row.badge > 0 ? planBadge.nameOrUndefined(row.badge) : undefined;
  return {
    id: String(row.id),
    key: row.key,
    rank: row.rank,
    sort: row.sort,
    active: row.active,
    archivedAt: row.archivedAtMs === null ? null : wireTime(row.archivedAtMs),
    onSale: planOnSale(row),
    names: strings(row.names),
    descriptions: strings(row.descriptions),
    badge: badge && badge !== 'none' ? badge : null,
    features: planFlags(row.features),
    quotas: planQuotas(row.features),
    hasLiveSubscriptions: row.live,
    updatedAt: wireTime(row.updatedAtMs),
  };
}

/** What the audit row keeps of a plan (no timestamps). */
function planAudit(row: CatalogPlanRow) {
  const view = planView(row);
  return {
    rank: view.rank,
    sort: view.sort,
    active: view.active,
    archived: view.archivedAt !== null,
    names: view.names,
    descriptions: view.descriptions,
    badge: view.badge,
    features: view.features,
    quotas: view.quotas,
  };
}

function productView(row: CatalogProductRow): AdminProduct {
  const badge = row.badge > 0 ? productBadge.nameOrUndefined(row.badge) : undefined;
  return {
    id: String(row.id),
    store: storeCodes.name(row.store) as AppStore,
    kind: productKind.name(row.kind),
    productId: row.productId,
    basePlanId: row.basePlanId,
    plan: row.planKey,
    period: row.period,
    item: walletItem.nameOrUndefined(row.item) ?? null,
    quantity: row.quantity,
    badge: badge && badge !== 'none' ? badge : null,
    sort: row.sort,
    active: row.active,
    listPrice: row.listPriceMinor === null || row.listCurrency === null ? null : { amountMinor: row.listPriceMinor, currency: row.listCurrency },
    hasPurchases: row.hasPurchases,
    updatedAt: wireTime(row.updatedAtMs),
  };
}

function productAudit(row: CatalogProductRow) {
  const { id: _id, updatedAt: _updatedAt, hasPurchases: _hasPurchases, ...rest } = productView(row);
  return rest;
}

const isAppStore = (code: number): boolean => (appStores as readonly string[]).includes(storeCodes.nameOrUndefined(code) ?? '');

/** Turns the constraint a statement broke into the panel's answer; anything else goes on as it is. */
function constraintProblem(error: unknown): never {
  const info = dbErrorInfo(error);
  if (info?.code === '23505' && info.constraint === 'plans_rank_key') {
    throw new HttpProblem('conflict', { detail: 'Another plan holds this rank; reorder with PUT /v1/admin/plan-ranks.' });
  }
  if (info?.code === '23505' && info.constraint === 'store_products_key') {
    throw new HttpProblem('conflict', { detail: 'This store already has a row for this product id and base plan.' });
  }
  if (info?.code === '23514') throw new HttpProblem('field_invalid', { detail: `The change breaks a rule of the catalogue (${info.constraint ?? 'check'}).` });
  throw error;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    return constraintProblem(error);
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * A write that can change ranks takes people's advisory locks and a plan's
 * key lock; a purchase of someone it never saw that also replaces another
 * person's token can still cross it, and PostgreSQL then ends one of the two
 * with a deadlock: the write is run again (its body does nothing outside the
 * transaction).
 */
const RANK_WRITE = { retries: 2 } as const;

export const adminCatalogRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = app.requirePermission('billing.read');
  const write = app.requirePermission('billing.catalog');
  const tags = ['admin'];

  /** After the commit: every process loads the catalogue again (this one too, by the same message). */
  async function announce(request: FastifyRequest): Promise<void> {
    if (!(await app.cfg.announce())) request.log.warn('catalog: saved; the announcement is retried in the background');
  }

  async function lockPlan(tx: PoolClient, key: string): Promise<CatalogPlanRow> {
    const row = await catalogPlanForUpdate(tx, key);
    if (!row) throw new HttpProblem('not_found', { detail: 'No such plan.' });
    return row;
  }

  async function reread(tx: PoolClient, key: string): Promise<CatalogPlanRow> {
    const row = await catalogPlan(tx, key);
    if (!row) throw new Error('catalog: the plan vanished inside its own transaction');
    return row;
  }

  /**
   * A change of ranks in the transaction, with what it moves: each person's
   * subscriptions row names the best plan they hold per store by the ranks
   * of the time it was computed, so the rows of people holding more than one
   * plan in a store are recomputed with the new ranks in the same
   * transaction. Answers the (person, store) pairs whose row changed: their
   * entitlement versions move after the commit ({@link entitlementsMoved}).
   */
  async function changeRanks(tx: PoolClient, change: () => Promise<unknown>): Promise<RankDependent[]> {
    const dependents = await catalogRankDependents(tx);
    await guarded(change);
    return dependents.length > 0 ? catalogRecomputeSubscriptions(tx, dependents) : [];
  }

  /** After the commit: the cached entitlements of the people whose plan moved are not used again (Valkey only). */
  async function entitlementsMoved(request: FastifyRequest, pairs: readonly RankDependent[]): Promise<void> {
    for (const userId of new Set(pairs.map((pair) => pair.userId))) {
      await app.store.entitlements.changed(request, userId, 0, { publish: false });
    }
    if (pairs.length > 0) request.log.info({ subscriptions: pairs.length }, 'catalog: subscriptions recomputed for the new plan ranks');
  }

  // ─── Plans ──────────────────────────────────────────────────────────────

  app.get(
    '/v1/admin/plans',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Every plan, and the switches and quotas the code knows', response: { 200: adminPlanListSchema } },
    },
    async () => ({ items: (await catalogPlans(app.pg)).map(planView), catalog: planFeatureCatalog() }),
  );

  app.get(
    '/v1/admin/plans/:key',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'One plan', params: adminPlanKeyParamsSchema, response: { 200: adminPlanSchema } },
    },
    async (request) => {
      const row = await catalogPlan(app.pg, request.params.key);
      if (!row) throw new HttpProblem('not_found', { detail: 'No such plan.' });
      return planView(row);
    },
  );

  app.post(
    '/v1/admin/plans',
    {
      preHandler: write,
      config: { pgBudget: 4 },
      schema: { tags, summary: 'Create a plan', body: adminPlanCreateSchema, response: { 201: adminPlanSchema } },
    },
    async (request, reply) => {
      const body = request.body;
      const row = await adminWrite(app, request, async (tx, trail) => {
        let start: Record<string, number | boolean> = { ...planFlags(undefined), ...planQuotas(undefined) };
        if (body.copyFrom !== undefined) {
          const source = await catalogPlan(tx, body.copyFrom);
          if (!source) throw invalid('/copyFrom', 'unknown_plan', `No plan ${body.copyFrom} to copy from.`);
          start = { ...planFlags(source.features), ...planQuotas(source.features) };
        }
        const given = Object.entries({ ...body.features, ...body.quotas }).filter((entry): entry is [string, number | boolean] => entry[1] !== undefined);
        const features: Record<string, number | boolean> = { ...start, ...Object.fromEntries(given) };
        const id = await guarded(() =>
          catalogPlanCreate(tx, {
            key: body.key,
            rank: body.rank ?? null,
            sort: body.sort ?? 0,
            active: body.active ?? true,
            badge: body.badge === undefined ? 0 : badgeCode(body.badge),
            names: strings(body.names) as Record<string, string>,
            descriptions: strings(body.descriptions ?? {}) as Record<string, string>,
            features,
          }),
        );
        if (id === null) throw new HttpProblem('conflict', { detail: 'A plan with this key exists (keys are never reused).' });
        const created = await reread(tx, body.key);
        trail.record({ action: 'plan.create', target: 'plan', targetId: id, detail: { key: body.key, after: planAudit(created), ...(body.copyFrom ? { copyFrom: body.copyFrom } : {}) } });
        return created;
      });
      await announce(request);
      request.log.info({ plan: row.key }, 'plan created');
      return reply.code(201).send(planView(row));
    },
  );

  app.patch(
    '/v1/admin/plans/:key',
    {
      preHandler: write,
      // The locking read (2), a rank change's dependents and recompute (2), the update, the reread, the audit row.
      config: { pgBudget: 7 },
      schema: { tags, summary: 'Change a plan', params: adminPlanKeyParamsSchema, body: adminPlanUpdateSchema, response: { 200: adminPlanSchema } },
    },
    async (request) => {
      const body = request.body;
      const key = request.params.key;
      const { row, changed, recomputed } = await adminWrite(app, request, async (tx, trail) => {
        const before = await lockPlan(tx, key);
        const free = before.key === FREE_PLAN_KEY;
        if (free && body.rank !== undefined) throw invalid('/rank', 'free_plan', 'The free plan is the baseline: its rank stays 0.');
        if (free && body.active === false) throw invalid('/active', 'free_plan', 'The free plan is always available.');
        if (before.archivedAtMs !== null && body.active === true) throw new HttpProblem('conflict', { detail: 'The plan is archived: bring it back first (unarchive).' });

        const view = planView(before);
        const patch: CatalogPlanPatch = {};
        const fields: string[] = [];
        if (body.names !== undefined && !same(strings(body.names), view.names)) {
          patch.names = strings(body.names) as Record<string, string>;
          fields.push('names');
        }
        if (body.descriptions !== undefined && !same(strings(body.descriptions), view.descriptions)) {
          patch.descriptions = strings(body.descriptions) as Record<string, string>;
          fields.push('descriptions');
        }
        if (body.rank !== undefined && body.rank !== before.rank) {
          patch.rank = body.rank;
          fields.push('rank');
        }
        if (body.sort !== undefined && body.sort !== before.sort) {
          patch.sort = body.sort;
          fields.push('sort');
        }
        if (body.active !== undefined && body.active !== before.active) {
          patch.active = body.active;
          fields.push('active');
        }
        if (body.badge !== undefined && badgeCode(body.badge) !== before.badge) {
          patch.badge = badgeCode(body.badge);
          fields.push('badge');
        }
        const features: Record<string, number | boolean> = {};
        for (const [name, value] of Object.entries({ ...body.features, ...body.quotas })) {
          const current = (view.features as Record<string, boolean>)[name] ?? (view.quotas as Record<string, number>)[name];
          if (value !== undefined && value !== current) features[name] = value;
        }
        if (Object.keys(features).length > 0) {
          patch.features = features;
          fields.push(...Object.keys(features).map((name) => `features.${name}`));
        }
        if (fields.length === 0) {
          trail.unchanged();
          return { row: before, changed: false, recomputed: [] as RankDependent[] };
        }
        const update = () => catalogPlanUpdate(tx, before.id, patch);
        let recomputed: RankDependent[] = [];
        if (patch.rank !== undefined) recomputed = await changeRanks(tx, update);
        else await guarded(update);
        const after = await reread(tx, key);
        trail.record({
          action: 'plan.update',
          target: 'plan',
          targetId: before.id,
          detail: { key, changed: fields, before: planAudit(before), after: planAudit(after), ...(patch.rank !== undefined ? { subscriptionsRecomputed: recomputed.length } : {}) },
        });
        return { row: after, changed: true, recomputed };
      }, RANK_WRITE);
      if (changed) await announce(request);
      await entitlementsMoved(request, recomputed);
      return planView(row);
    },
  );

  for (const archive of [true, false]) {
    app.post(
      `/v1/admin/plans/:key/${archive ? 'archive' : 'unarchive'}`,
      {
        preHandler: write,
        config: { pgBudget: 5 },
        schema: {
          tags,
          summary: archive ? 'Take a plan off sale for good (holders keep it)' : 'Bring an archived plan back (still off sale)',
          params: adminPlanKeyParamsSchema,
          response: { 200: adminPlanSchema },
        },
      },
      async (request) => {
        const key = request.params.key;
        const { row, changed } = await adminWrite(app, request, async (tx, trail) => {
          const before = await lockPlan(tx, key);
          if (before.key === FREE_PLAN_KEY) throw new HttpProblem('conflict', { detail: 'The free plan is everyone’s baseline: it is never archived.' });
          if ((before.archivedAtMs !== null) === archive) {
            trail.unchanged();
            return { row: before, changed: false };
          }
          const result = await guarded(() => catalogPlanArchive(tx, before.id, archive));
          const after = await reread(tx, key);
          trail.record({
            action: archive ? 'plan.archive' : 'plan.unarchive',
            target: 'plan',
            targetId: before.id,
            detail: { key, before: planAudit(before), after: planAudit(after), liveSubscriptions: before.live, deactivatedProducts: result.deactivated },
          });
          for (const productId of result.deactivated) {
            trail.record({ action: 'product.deactivate', target: 'product', targetId: productId, detail: { reason: 'plan_archived', plan: key } });
          }
          return { row: after, changed: true };
        });
        if (changed) await announce(request);
        return planView(row);
      },
    );
  }

  app.put(
    '/v1/admin/plan-ranks',
    {
      preHandler: write,
      config: { pgBudget: 7 },
      schema: { tags, summary: 'The upgrade order of every plan but free', body: adminPlanRanksSchema, response: { 200: adminPlanListSchema } },
    },
    async (request) => {
      const order = request.body.order;
      const { rows, changed, recomputed } = await adminWrite(app, request, async (tx, trail) => {
        const plans = await catalogPlansForUpdate(tx);
        const others = plans.filter((p) => p.key !== FREE_PLAN_KEY);
        const byKey = new Map(others.map((p) => [p.key, p]));
        const listed = new Set(order);
        const unknown = order.filter((key) => !byKey.has(key));
        const missing = others.filter((p) => !listed.has(p.key)).map((p) => p.key);
        if (listed.size !== order.length || unknown.length > 0 || missing.length > 0) {
          const parts = [
            listed.size !== order.length ? 'a key is listed twice' : '',
            unknown.length > 0 ? `not a plan to order: ${unknown.join(', ')}` : '',
            missing.length > 0 ? `missing: ${missing.join(', ')}` : '',
          ].filter(Boolean);
          throw invalid('/order', 'not_every_plan', `List every plan but free exactly once (${parts.join('; ')}).`);
        }
        const ranks = order.map((key, index) => ({ id: byKey.get(key)!.id, rank: index + 1 }));
        const moved = ranks.filter((r) => others.find((p) => p.id === r.id)?.rank !== r.rank).map((r) => r.id).sort((a, b) => a - b);
        if (moved.length === 0) {
          trail.unchanged();
          return { rows: plans, changed: false, recomputed: [] as RankDependent[] };
        }
        const recomputed = await changeRanks(tx, () => catalogPlanRanks(tx, ranks));
        const after = await catalogPlans(tx);
        trail.record({
          action: 'plan.reorder',
          target: 'plan',
          detail: {
            before: Object.fromEntries(others.map((p) => [p.key, p.rank])),
            after: Object.fromEntries(after.filter((p) => p.key !== FREE_PLAN_KEY).map((p) => [p.key, p.rank])),
            moved,
            subscriptionsRecomputed: recomputed.length,
          },
        });
        return { rows: after, changed: true, recomputed };
      }, RANK_WRITE);
      if (changed) await announce(request);
      await entitlementsMoved(request, recomputed);
      return { items: rows.map(planView), catalog: planFeatureCatalog() };
    },
  );

  // ─── Store products ─────────────────────────────────────────────────────

  async function lockProduct(tx: PoolClient, id: number): Promise<CatalogProductRow> {
    const row = await catalogProductForUpdate(tx, id);
    if (!row || !isAppStore(row.store)) throw new HttpProblem('not_found', { detail: 'No such product.' });
    return row;
  }

  async function rereadProduct(tx: PoolClient, id: number): Promise<CatalogProductRow> {
    const row = await catalogProduct(tx, id);
    if (!row) throw new Error('catalog: the product vanished inside its own transaction');
    return row;
  }

  /** The plan a subscription row names: it exists, is not free, and is not archived (`pointer` for the error). */
  async function salePlan(tx: PoolClient, key: string, pointer: string): Promise<CatalogPlanRef> {
    const plan = await catalogPlanRef(tx, key);
    if (!plan) throw invalid(pointer, 'unknown_plan', `No plan ${key}.`);
    if (plan.key === FREE_PLAN_KEY) throw invalid(pointer, 'free_plan', 'The free plan is not sold.');
    if (plan.archived) throw new HttpProblem('conflict', { detail: `Plan ${key} is archived: it is not sold.` });
    return plan;
  }

  /** Rows sharing (store, product id) are of one kind and, for subscriptions, one plan. */
  async function checkSiblings(tx: PoolClient, store: number, productId: string, kind: number, planId: number | null, self: number | null): Promise<void> {
    const siblings = (await catalogProductSiblings(tx, store, productId)).filter((s) => s.id !== self);
    if (siblings.some((s) => s.kind !== kind)) {
      throw invalid('/productId', 'other_kind', `This product id is a ${productKind.name(siblings[0]!.kind)} in this store.`);
    }
    if (kind === productKind.code('subscription') && siblings.some((s) => s.planId !== planId)) {
      throw invalid('/plan', 'other_plan', 'The base plans of one subscription product belong to one plan.');
    }
  }

  function checkStoreShape(store: AppStore, basePlanId: string | null, period: string | null, subscription: boolean): void {
    if (store === 'bazaar' && basePlanId !== null) throw invalid('/basePlanId', 'bazaar_base_plan', 'Cafe Bazaar has no base plans: one product id per period.');
    if (store === 'bazaar' && period === 'P1W') throw invalid('/period', 'bazaar_period', 'Cafe Bazaar sells no weekly subscription.');
    if (store === 'play' && subscription && basePlanId === null) throw invalid('/basePlanId', 'base_plan_required', 'A Play subscription names its base plan.');
  }

  app.get(
    '/v1/admin/store-products',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Store products of one store or both', querystring: adminProductListQuerySchema, response: { 200: adminProductListSchema } },
    },
    async (request) => {
      const store = request.query.store === undefined ? null : storeCodes.code(request.query.store);
      const rows = await catalogProducts(app.pg, store);
      return { items: rows.filter((row) => isAppStore(row.store)).map(productView) };
    },
  );

  app.post(
    '/v1/admin/store-products',
    {
      preHandler: write,
      config: { pgBudget: 5 },
      schema: { tags, summary: 'Create a store product', body: adminProductCreateSchema, response: { 201: adminProductSchema } },
    },
    async (request, reply) => {
      const body = request.body;
      const store = storeCodes.code(body.store);
      const subscription = body.kind === 'subscription';
      const row = await adminWrite(app, request, async (tx, trail) => {
        let planId: number | null = null;
        if (body.kind === 'subscription') {
          checkStoreShape(body.store, body.basePlanId ?? null, body.period, true);
          planId = (await salePlan(tx, body.plan, '/plan')).id;
        }
        const kind = productKind.code(body.kind);
        await checkSiblings(tx, store, body.productId, kind, planId, null);
        const id = await guarded(() =>
          catalogProductCreate(tx, {
            store,
            kind,
            planId,
            period: body.kind === 'subscription' ? body.period : null,
            item: body.kind === 'consumable' ? walletItem.code(body.item) : null,
            quantity: body.kind === 'consumable' ? body.quantity : null,
            productId: body.productId,
            basePlanId: body.kind === 'subscription' ? (body.basePlanId ?? null) : null,
            badge: body.badge === undefined ? 0 : badgeCode(body.badge),
            sort: body.sort ?? 0,
            active: body.active ?? false,
            listPriceMinor: body.listPrice?.amountMinor ?? null,
            listCurrency: body.listPrice?.currency ?? null,
          }),
        );
        if (id === null) throw new HttpProblem('conflict', { detail: 'This store already has a row for this product id and base plan.' });
        const created = await rereadProduct(tx, id);
        trail.record({ action: 'product.create', target: 'product', targetId: id, detail: { after: productAudit(created) } });
        return created;
      });
      await announce(request);
      request.log.info({ productRef: row.id, store: body.store, subscription }, 'store product created');
      return reply.code(201).send(productView(row));
    },
  );

  app.patch(
    '/v1/admin/store-products/:id',
    {
      preHandler: write,
      config: { pgBudget: 7 },
      schema: { tags, summary: 'Change a store product', params: adminProductIdParamsSchema, body: adminProductUpdateSchema, response: { 200: adminProductSchema } },
    },
    async (request) => {
      const id = Number(request.params.id);
      const body = request.body;
      const { row, changed } = await adminWrite(app, request, async (tx, trail) => {
        const before = await lockProduct(tx, id);
        const view = productView(before);
        const subscription = before.kind === productKind.code('subscription');
        if (subscription && (body.item !== undefined || body.quantity !== undefined)) {
          throw invalid(body.item !== undefined ? '/item' : '/quantity', 'not_a_consumable', 'A subscription grants a plan, not wallet items.');
        }
        if (!subscription && (body.plan !== undefined || body.period !== undefined || (body.basePlanId !== undefined && body.basePlanId !== null))) {
          const pointer = body.plan !== undefined ? '/plan' : body.period !== undefined ? '/period' : '/basePlanId';
          throw invalid(pointer, 'not_a_subscription', 'A consumable grants wallet items, not a plan.');
        }
        const patch: CatalogProductPatch = {};
        const fields: string[] = [];
        const grants: string[] = [];
        if (body.productId !== undefined && body.productId !== before.productId) {
          patch.productId = body.productId;
          grants.push('productId');
        }
        if (subscription && body.basePlanId !== undefined && body.basePlanId !== before.basePlanId) {
          patch.basePlanId = body.basePlanId;
          grants.push('basePlanId');
        }
        if (body.period !== undefined && body.period !== before.period) {
          patch.period = body.period;
          grants.push('period');
        }
        if (body.item !== undefined && walletItem.code(body.item) !== before.item) {
          patch.item = walletItem.code(body.item);
          grants.push('item');
        }
        if (body.quantity !== undefined && body.quantity !== before.quantity) {
          patch.quantity = body.quantity;
          grants.push('quantity');
        }
        let plan: CatalogPlanRef | null = null;
        if (body.plan !== undefined && body.plan !== before.planKey) {
          plan = await salePlan(tx, body.plan, '/plan');
          patch.planId = plan.id;
          grants.push('plan');
        }
        if (grants.length > 0 && before.hasPurchases) {
          throw new HttpProblem('conflict', { detail: `Purchases name this product: what it grants is fixed (${grants.join(', ')}). Make a new product instead.` });
        }
        if (body.badge !== undefined && badgeCode(body.badge) !== before.badge) {
          patch.badge = badgeCode(body.badge);
          fields.push('badge');
        }
        if (body.sort !== undefined && body.sort !== before.sort) {
          patch.sort = body.sort;
          fields.push('sort');
        }
        if (body.listPrice !== undefined && !same(body.listPrice, view.listPrice)) {
          patch.listPrice = body.listPrice;
          fields.push('listPrice');
        }
        const activating = body.active === true && !before.active;
        if (body.active !== undefined && body.active !== before.active) {
          patch.active = body.active;
          fields.push('active');
        }
        fields.unshift(...grants);
        if (fields.length === 0) {
          trail.unchanged();
          return { row: before, changed: false };
        }
        const storeName = storeCodes.name(before.store) as AppStore;
        if (subscription) {
          checkStoreShape(storeName, patch.basePlanId !== undefined ? patch.basePlanId : before.basePlanId, patch.period ?? before.period, true);
          // Turning on a row whose plan is archived would sell it again.
          if (activating && !plan && before.planKey !== null) await salePlan(tx, before.planKey, '/active');
        }
        if (patch.productId !== undefined || patch.planId !== undefined) {
          await checkSiblings(tx, before.store, patch.productId ?? before.productId, before.kind, patch.planId ?? before.planId, before.id);
        }
        await guarded(() => catalogProductUpdate(tx, id, patch));
        const after = await rereadProduct(tx, id);
        trail.record({ action: 'product.update', target: 'product', targetId: id, detail: { changed: fields, before: productAudit(before), after: productAudit(after) } });
        return { row: after, changed: true };
      });
      if (changed) await announce(request);
      return productView(row);
    },
  );

  for (const active of [true, false]) {
    app.post(
      `/v1/admin/store-products/:id/${active ? 'activate' : 'deactivate'}`,
      {
        preHandler: write,
        config: { pgBudget: active ? 6 : 5 },
        schema: {
          tags,
          summary: active ? 'List a store product to apps' : 'Stop listing a store product',
          params: adminProductIdParamsSchema,
          response: { 200: adminProductSchema },
        },
      },
      async (request) => {
        const id = Number(request.params.id);
        const { row, changed } = await adminWrite(app, request, async (tx, trail) => {
          const before = await lockProduct(tx, id);
          if (before.active === active) {
            trail.unchanged();
            return { row: before, changed: false };
          }
          if (active && before.kind === productKind.code('subscription') && before.planKey !== null) await salePlan(tx, before.planKey, '/active');
          await guarded(() => catalogProductUpdate(tx, id, { active }));
          const after = await rereadProduct(tx, id);
          trail.record({ action: active ? 'product.activate' : 'product.deactivate', target: 'product', targetId: id, detail: { before: productAudit(before), after: productAudit(after) } });
          return { row: after, changed: true };
        });
        if (changed) await announce(request);
        return productView(row);
      },
    );
  }
};
