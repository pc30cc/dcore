import { entitlementRows, type Queryable } from '@app/db';
import {
  bestPlanOf,
  entitlementBase,
  entitlementBaseTtl,
  parseEntitlementBase,
  planHas,
  planLimitOf,
  type EntitlementBase,
  type KeyBuilder,
} from '@app/shared/server';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import type { ConfigSnapshot, PlanDefinition } from './cfg.js';

/**
 * The plan a session counts under, for every gated feature (see likes,
 * incognito, advanced filters, read receipts, boosts, daily likes and
 * direct messages, weekly super likes): the same computation as
 * `GET /v1/me/entitlements`, from the same cache (`ent:<uid>:<st>`, see
 * `@app/shared/server` billing/entitlements), so a gate and the app never
 * disagree. Warm: two Valkey reads in parallel (the cached base and its
 * versions in kv-core) and no statement; a miss: one statement
 * (`entitlement_rows()`), for which the request's budget is raised only when
 * it happens. Plan features and limits come from the configuration in
 * memory, so a panel edit of a plan applies at once.
 */

export const PLAN_CACHE_TTL_SECONDS = 3_600;

export interface SessionPlan {
  plan: PlanDefinition | undefined;
  /** Whether the plan came from Valkey (no statement). */
  cached: boolean;
  base: EntitlementBase;
}

export function bestPlan(cfg: ConfigSnapshot, planIds: readonly number[]): PlanDefinition | undefined {
  return bestPlanOf(cfg.plans, planIds);
}

export interface PlanLookup {
  cache: Redis;
  keys: KeyBuilder;
  db: Queryable;
  log: FastifyBaseLogger;
}

/** The session's plan: cached, or one statement (the request's budget is raised for it). */
export async function sessionPlan(
  lookup: PlanLookup,
  request: FastifyRequest,
  cfg: ConfigSnapshot,
  userId: string,
  storeCode: number | undefined,
): Promise<SessionPlan> {
  const store = storeCode ?? 0;
  const crossStore = cfg.app['billing.cross_store_entitlements'];
  const now = Date.now();
  const key = lookup.keys.entitlements(userId, store);
  const [raw, versions] = await Promise.all([
    lookup.cache.get(key).catch((error: unknown) => {
      lookup.log.warn({ err: error }, 'plans: cached entitlements unreadable');
      return null;
    }),
    request.server.redis.mget(lookup.keys.entitlementsVersion(userId), lookup.keys.entitlementsWalletVersion(userId)).then(
      ([v, w]) => ({ version: Number(v ?? 0) || 0, wallet: Number(w ?? 0) || 0 }),
      (error: unknown) => {
        lookup.log.warn({ err: error }, 'plans: entitlements version unreadable');
        return null;
      },
    ),
  ]);
  const version = versions?.version ?? null;
  // Without the version (kv-core unreachable) a cached base is still the best guess for a gate; the wallet's version does not matter to a gate.
  const cached = parseEntitlementBase(raw, crossStore, version, undefined, now);
  if (cached) return { plan: bestPlan(cfg, cached.plans), cached: true, base: cached };
  if (request.pgTally?.budget !== undefined) request.pgTally.budget += 1;
  const rows = await entitlementRows(lookup.db, userId);
  const base = entitlementBase(rows, store, crossStore, version ?? 0, versions?.wallet ?? 0, now);
  if (version !== null) {
    await lookup.cache.set(key, JSON.stringify(base), 'EX', entitlementBaseTtl(base, now)).catch((error: unknown) => lookup.log.warn({ err: error }, 'plans: plan not cached'));
  }
  return { plan: bestPlan(cfg, base.plans), cached: false, base };
}

/** A numeric plan feature (a quota; -1 unlimited, missing 0). */
export function planLimit(plan: PlanDefinition | undefined, feature: string): number {
  return planLimitOf(plan, feature);
}

export function planFeature(plan: PlanDefinition | undefined, feature: string): boolean {
  return planHas(plan, feature);
}
