import { currentPlans, type Queryable } from '@app/db';
import type { ConfigSnapshot } from './cfg.js';

/**
 * Whether a session's plan includes a feature (`plan_features`), for the
 * own-account switches that need one (incognito, advanced filters). One
 * read of `subscriptions`; only the requests that turn such a switch on pay
 * it. The plan is the best by rank of the session store's subscription and
 * the admin grants (every store's when `billing.cross_store_entitlements`
 * is on); without a subscription it is `free`.
 */
export async function planHasFeature(
  db: Queryable,
  cfg: ConfigSnapshot,
  userId: string,
  storeCode: number | undefined,
  feature: string,
): Promise<boolean> {
  const ids = new Set(await currentPlans(db, userId, storeCode ?? null, cfg.app['billing.cross_store_entitlements']));
  // A plan no longer sold (inactive) still serves the people who hold it.
  const held = cfg.plans.filter((plan) => ids.has(plan.id) || plan.key === 'free');
  const best = held.sort((a, b) => b.rank - a.rank)[0];
  return best?.features[feature] === true;
}
