import { currentPlans, type Queryable } from '@app/db';
import type { KeyBuilder } from '@app/shared/server';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { ConfigSnapshot, PlanDefinition } from './cfg.js';

/**
 * The plan a session counts under (its store's subscription and the admin
 * grants, every store's with `billing.cross_store_entitlements`), cached in
 * kv-cache as `ent:<uid>:<st>` for an hour: the swipe path then reads no
 * statement. The cached value holds the plan ids only; the features and
 * limits come from the configuration in memory, so a panel edit of a plan
 * applies at once. Purchases, grants and expiries delete the key (W5).
 */

export const PLAN_CACHE_TTL_SECONDS = 3_600;

const cachedSchema = z.object({ v: z.literal(1), plans: z.array(z.number().int().positive()) });

export interface SessionPlan {
  plan: PlanDefinition | undefined;
  /** Whether the plan came from Valkey (no statement). */
  cached: boolean;
}

export function bestPlan(cfg: ConfigSnapshot, planIds: readonly number[]): PlanDefinition | undefined {
  const ids = new Set(planIds);
  // A plan no longer sold (inactive) still serves the people who hold it.
  const held = cfg.plans.filter((plan) => ids.has(plan.id) || plan.key === 'free');
  return [...held].sort((a, b) => b.rank - a.rank)[0];
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
  const key = lookup.keys.entitlements(userId, storeCode ?? 0);
  try {
    const raw = await lookup.cache.get(key);
    if (raw) {
      const parsed = cachedSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return { plan: bestPlan(cfg, parsed.data.plans), cached: true };
    }
  } catch (error) {
    lookup.log.warn({ err: error }, 'plans: cached plan unreadable');
  }
  if (request.pgTally?.budget !== undefined) request.pgTally.budget += 1;
  const plans = await currentPlans(lookup.db, userId, storeCode ?? null, cfg.app['billing.cross_store_entitlements']);
  try {
    await lookup.cache.set(key, JSON.stringify({ v: 1, plans }), 'EX', PLAN_CACHE_TTL_SECONDS);
  } catch (error) {
    lookup.log.warn({ err: error }, 'plans: plan not cached');
  }
  return { plan: bestPlan(cfg, plans), cached: false };
}

/** A numeric plan feature (a quota; -1 unlimited, missing 0). */
export function planLimit(plan: PlanDefinition | undefined, feature: string): number {
  const value = plan?.features[feature];
  return typeof value === 'number' && Number.isInteger(value) && value >= -1 ? value : 0;
}

export function planFeature(plan: PlanDefinition | undefined, feature: string): boolean {
  return plan?.features[feature] === true;
}
