import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { entitlementFeatureKeys, wireTime, type Entitlements } from '../../api/common.js';
import { store as storeCodes, walletItem } from '../../codes.js';
import { realtimeEnvelope, type RealtimeEnvelope } from '../../realtime.js';
import { utcDay, type KeyBuilder } from '../kv/keys.js';
import { isoWeek, quotaPeriod } from '../social/quota.js';
import { FREE_PLAN_KEY } from '../../plans.js';

/**
 * What a session may use: its plan (the best of its store's subscription
 * and the admin grants, every store's with `billing.cross_store_entitlements`),
 * the plan's features and quotas, the wallet it may spend (its store's
 * balance and store 0's, every store's with the flag), and a running boost.
 *
 * Cached per person and session store in kv-cache as `ent:<uid>:<st>`
 * (1 h, never past the earliest expiry it counts): the rows the
 * database gave (subscriptions, balances) as that store sees them. Plan
 * features come from the configuration in memory and the quota counters
 * from kv-core on every read, so neither needs an invalidation. Every
 * write that changes a person's subscriptions moves `entv:<uid>` (kv-core)
 * after it is durable, and every wallet change `entwv:<uid>`; a cached value
 * of another version is not used, so a reader that read the database before
 * a write and stores its value after it cannot serve the old state. The plan
 * gates check only `entv` (a wallet change does not make the next swipe read
 * the database); the entitlements read checks both.
 */

export const ENTITLEMENTS_TTL_SECONDS = 3_600;
/** The version counter lives as long as an own-account version. */
export const ENTITLEMENTS_VERSION_TTL_SECONDS = 30 * 86_400;

export interface SubscriptionRowLike {
  store: number;
  planId: number;
  status: number;
  autoRenew: boolean;
  startedAtMs: number;
  expiresAtMs: number;
  productId: string | null;
  basePlanId: string | null;
}

export interface WalletRowLike {
  item: number;
  store: number;
  balance: number;
}

export interface EntitlementRowsLike {
  subs: readonly SubscriptionRowLike[];
  wallet: readonly WalletRowLike[];
}

export interface PlanLike {
  id: number;
  key: string;
  rank: number;
  features: Readonly<Record<string, number | boolean>>;
}

const countedSchema = z.object({
  store: z.number().int().min(0).max(3),
  planId: z.number().int(),
  status: z.number().int(),
  autoRenew: z.boolean(),
  expiresAtMs: z.number().int(),
  productId: z.string().nullable(),
  basePlanId: z.string().nullable(),
});
export type CountedSubscription = z.infer<typeof countedSchema>;

export const entitlementBaseSchema = z.object({
  v: z.literal(2),
  /** `entv:<uid>` when the rows were read. */
  n: z.number().int().nonnegative(),
  /** `entwv:<uid>` when the rows were read. */
  w: z.number().int().nonnegative(),
  /** billing.cross_store_entitlements when it was built. */
  x: z.boolean(),
  /** The session store it was built for. */
  st: z.number().int().min(0).max(3),
  /** The plan ids that count (read by the plan gates and by a peer's read receipts). */
  plans: z.array(z.number().int()),
  subs: z.array(countedSchema),
  wallet: z.object({ superlike: z.number().int(), boost: z.number().int(), spotlight: z.number().int(), dm: z.number().int() }),
  /** A digest of the rows (part of the ETag). */
  d: z.string(),
});
export type EntitlementBase = z.infer<typeof entitlementBaseSchema>;

/** Whether a subscription row of `rowStore` counts in a session of `sessionStore`. */
export function countsIn(rowStore: number, sessionStore: number, crossStore: boolean): boolean {
  return rowStore === 0 || rowStore === sessionStore || crossStore;
}

/** The base of `ent:<uid>:<st>` from the person's rows (every store) as store `store` sees them. */
export function entitlementBase(
  rows: EntitlementRowsLike,
  store: number,
  crossStore: boolean,
  version: number,
  walletVersion: number,
  now: number = Date.now(),
): EntitlementBase {
  const subs: CountedSubscription[] = rows.subs
    .filter((s) => s.expiresAtMs > now && countsIn(s.store, store, crossStore))
    .map((s) => ({ store: s.store, planId: s.planId, status: s.status, autoRenew: s.autoRenew, expiresAtMs: s.expiresAtMs, productId: s.productId, basePlanId: s.basePlanId }));
  const wallet = { superlike: 0, boost: 0, spotlight: 0, dm: 0 };
  for (const w of rows.wallet) {
    if (w.balance <= 0 || !countsIn(w.store, store, crossStore)) continue;
    const item = walletItem.nameOrUndefined(w.item);
    if (item) wallet[item] += w.balance;
  }
  const d = createHash('sha256').update(JSON.stringify({ subs, wallet })).digest('base64url').slice(0, 12);
  return { v: 2, n: version, w: walletVersion, x: crossStore, st: store, plans: [...new Set(subs.map((s) => s.planId))], subs, wallet, d };
}

/** Seconds a base may stay cached: an hour, never past the earliest expiry it counts. */
export function entitlementBaseTtl(base: EntitlementBase, now: number = Date.now()): number {
  const earliest = Math.min(...base.subs.map((s) => s.expiresAtMs));
  if (!Number.isFinite(earliest)) return ENTITLEMENTS_TTL_SECONDS;
  return Math.max(1, Math.min(ENTITLEMENTS_TTL_SECONDS, Math.floor((earliest - now) / 1_000)));
}

/**
 * A cached base, or null when it is missing, malformed, of another flag value
 * or version, or counts an expired row. A null `version` skips the version
 * check (kv-core unreadable: a gate still takes the cached plan); an
 * undefined `walletVersion` skips the wallet's (the gates).
 */
export function parseEntitlementBase(
  raw: string | null,
  crossStore: boolean,
  version: number | null,
  walletVersion: number | undefined,
  now: number = Date.now(),
): EntitlementBase | null {
  if (!raw) return null;
  try {
    const parsed = entitlementBaseSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const base = parsed.data;
    if (base.x !== crossStore) return null;
    if (version !== null && base.n !== version) return null;
    if (walletVersion !== undefined && base.w !== walletVersion) return null;
    if (base.subs.some((s) => s.expiresAtMs <= now)) return null;
    return base;
  } catch {
    return null;
  }
}

/** The plan ids a cached base counts, whatever its version (a peer's read receipts are a hint, not a grant). */
export function cachedPlanIds(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; plans?: unknown };
    if (parsed.v !== 2 || !Array.isArray(parsed.plans)) return null;
    return parsed.plans.filter((p): p is number => typeof p === 'number');
  } catch {
    return null;
  }
}

/** The best plan of a set of plan ids (free when none counts); a plan no longer sold still serves who holds it. */
export function bestPlanOf<P extends PlanLike>(plans: readonly P[], planIds: readonly number[]): P | undefined {
  const ids = new Set(planIds);
  return [...plans.filter((p) => ids.has(p.id) || p.key === FREE_PLAN_KEY)].sort((a, b) => b.rank - a.rank)[0];
}

/** A numeric plan feature (a quota; -1 unlimited, missing 0). */
export function planLimitOf(plan: PlanLike | undefined, feature: string): number {
  const value = plan?.features[feature];
  return typeof value === 'number' && Number.isInteger(value) && value >= -1 ? value : 0;
}

export function planHas(plan: PlanLike | undefined, feature: string): boolean {
  return plan?.features[feature] === true;
}

// ─── Quotas ───────────────────────────────────────────────────────────────

/** The boosts allowance counts per calendar month, UTC (`q:boost:<uid>:<yyyymm>`). */
export function boostPeriod(now: number = Date.now()): { period: string; resetsAtMs: number; ttlSeconds: number } {
  const d = new Date(now);
  const resetsAtMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { period: `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`, resetsAtMs, ttlSeconds: 32 * 86_400 };
}

/** The quota keys of a person now: daily likes, weekly super likes, daily direct messages, monthly boosts. */
export function quotaKeys(keys: KeyBuilder, userId: string, now: number = Date.now()) {
  return {
    likes: keys.quota('likes', userId, utcDay(now)),
    superlikes: keys.quota('sl', userId, isoWeek(now)),
    dm: keys.quota('dm', userId, utcDay(now)),
    boosts: keys.quota('boost', userId, boostPeriod(now).period),
  };
}

export interface QuotaCounters {
  likes: number;
  superlikes: number;
  dm: number;
  boosts: number;
  /** A running boost's end (epoch ms), or null. */
  boostEndsMs: number | null;
  /** `entv:<uid>`; null when kv-core could not be read (the cache is then not trusted). */
  version: number | null;
  /** `entwv:<uid>`. */
  walletVersion: number;
}

function count(value: string | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The counters, the boost and the version in one round trip to kv-core. */
export async function readQuotaUse(redis: Redis, keys: KeyBuilder, userId: string, now: number = Date.now()): Promise<QuotaCounters> {
  const q = quotaKeys(keys, userId, now);
  const [likes, superlikes, dm, boosts, boost, version, walletVersion] = await redis.mget(
    q.likes,
    q.superlikes,
    q.dm,
    q.boosts,
    keys.boostActive(userId),
    keys.entitlementsVersion(userId),
    keys.entitlementsWalletVersion(userId),
  );
  const ends = Number(boost ?? 0);
  return {
    likes: count(likes),
    superlikes: count(superlikes),
    dm: count(dm),
    boosts: count(boosts),
    boostEndsMs: Number.isFinite(ends) && ends > now ? ends : null,
    version: count(version),
    walletVersion: count(walletVersion),
  };
}

export interface EntitlementVersions {
  /** `entv:<uid>` */
  version: number;
  /** `entwv:<uid>` */
  walletVersion: number;
}

/** The two versions of a person (one round trip to kv-core). */
export async function readEntitlementVersions(redis: Redis, keys: KeyBuilder, userId: string): Promise<EntitlementVersions> {
  const [version, walletVersion] = await redis.mget(keys.entitlementsVersion(userId), keys.entitlementsWalletVersion(userId));
  return { version: count(version), walletVersion: count(walletVersion) };
}

/**
 * After a write that changed a person's subscriptions (and maybe the
 * wallet) is durable: new versions, and the cached bases go. Answers the
 * versions this call moved them to: a base cached by the writer must carry
 * exactly these (a later writer's move then makes it unusable), never a
 * version read again afterwards.
 */
export async function entitlementsChanged(redis: Redis, cache: Redis, keys: KeyBuilder, userId: string): Promise<EntitlementVersions> {
  const version = keys.entitlementsVersion(userId);
  const wallet = keys.entitlementsWalletVersion(userId);
  const out = await redis.multi().incr(version).expire(version, ENTITLEMENTS_VERSION_TTL_SECONDS).incr(wallet).expire(wallet, ENTITLEMENTS_VERSION_TTL_SECONDS).exec();
  const moved = (i: number): number => {
    const entry = out?.[i];
    if (!entry || entry[0]) throw entry?.[0] ?? new Error('entitlements: version not moved');
    return Number(entry[1]);
  };
  const versions = { version: moved(0), walletVersion: moved(2) };
  await cache.del(keys.entitlements(userId, 0), keys.entitlements(userId, 1), keys.entitlements(userId, 2), keys.entitlements(userId, 3));
  return versions;
}

/**
 * Whether a writer may cache the rows its own transaction read under the
 * versions it moved to: only when nobody else moved either version between
 * the writer's read of them before its transaction (`before`) and its own
 * move (`moved`). Another writer that moved first committed before that
 * read, so the rows include its change; one that moves later makes the
 * cached value unusable.
 */
export function mayPrime(before: EntitlementVersions | null, moved: EntitlementVersions | null): moved is EntitlementVersions {
  return before !== null && moved !== null && moved.version === before.version + 1 && moved.walletVersion === before.walletVersion + 1;
}

/** After a wallet change alone is durable (a use, a give-back, a gift): a new wallet version; the cached plan stays usable. */
export async function walletChanged(redis: Redis, keys: KeyBuilder, userId: string): Promise<void> {
  const wallet = keys.entitlementsWalletVersion(userId);
  await redis.multi().incr(wallet).expire(wallet, ENTITLEMENTS_VERSION_TTL_SECONDS).exec();
}

// ─── The wire object ──────────────────────────────────────────────────────

/** The counted row that gives the plan: the session store's before a grant, then the later expiry. */
export function sourceRow(base: EntitlementBase, planId: number | undefined): CountedSubscription | undefined {
  if (planId === undefined) return undefined;
  return base.subs
    .filter((s) => s.planId === planId)
    .sort((a, b) => Number(b.store === base.st) - Number(a.store === base.st) || Number(b.store !== 0) - Number(a.store !== 0) || b.expiresAtMs - a.expiresAtMs)[0];
}

export interface EntitlementsInput {
  base: EntitlementBase;
  plans: readonly PlanLike[];
  use: QuotaCounters;
  /** The store's subscription centre for the row that gives the plan. */
  manageUrl?: ((store: number, productId: string | null) => string | undefined) | undefined;
  now?: number | undefined;
}

export function buildEntitlements({ base, plans, use, manageUrl, now = Date.now() }: EntitlementsInput): Entitlements {
  const plan = bestPlanOf(plans, base.plans);
  // Any plan key: a plan made in the panel is named as itself.
  const key = plan?.key ?? FREE_PLAN_KEY;
  const row = key === FREE_PLAN_KEY ? undefined : sourceRow(base, plan?.id);
  const source = row ? (row.store === 0 ? 'grant' : storeCodes.nameOrUndefined(row.store)) : undefined;
  const manage = row && row.store !== 0 ? manageUrl?.(row.store, row.productId) : undefined;
  // The plan's own product only for a row of this view's store: a build is never told another store's product.
  const own = row && row.store !== 0 && row.store === base.st ? row : undefined;
  const day = quotaPeriod('likes', now);
  const week = quotaPeriod('superlikes', now);
  const month = boostPeriod(now);
  return {
    plan: key,
    ...(row ? { planExpiresAt: wireTime(row.expiresAtMs), autoRenew: row.autoRenew } : {}),
    ...(source === 'play' || source === 'bazaar' || source === 'grant' ? { source } : {}),
    ...(manage ? { manageUrl: manage } : {}),
    ...(own?.productId ? { productId: own.productId, ...(own.basePlanId ? { basePlanId: own.basePlanId } : {}) } : {}),
    features: Object.fromEntries(entitlementFeatureKeys.map((f) => [f, planHas(plan, f)])) as Entitlements['features'],
    quotas: {
      likes: { limit: planLimitOf(plan, 'daily_likes'), used: use.likes, resetsAt: wireTime(day.resetsAtMs) },
      superlikes: { limit: planLimitOf(plan, 'weekly_superlikes'), used: use.superlikes, resetsAt: wireTime(week.resetsAtMs) },
      dm: { limit: planLimitOf(plan, 'daily_dm'), used: use.dm, resetsAt: wireTime(day.resetsAtMs) },
      boosts: { limit: planLimitOf(plan, 'monthly_boosts'), used: use.boosts, resetsAt: wireTime(month.resetsAtMs) },
    },
    wallet: { ...base.wallet },
    ...(use.boostEndsMs !== null && use.boostEndsMs > now ? { boostEndsAt: wireTime(use.boostEndsMs) } : {}),
  };
}

/** Moves when the wire object gains or changes a field, so a 304 never keeps a body of an older shape. */
const ENTITLEMENTS_WIRE_FORMAT = 3;

/**
 * The ETag of the entitlements a base and the counters give, decided
 * without building the body: the wire format, the version and digest of the
 * rows, the configuration (plan features), the counters and their periods,
 * the boost.
 */
export function entitlementsEtag(base: EntitlementBase, configFingerprint: string, use: QuotaCounters, now: number = Date.now()): string {
  const h = createHash('sha256')
    .update([ENTITLEMENTS_WIRE_FORMAT, base.n, base.w, base.d, base.st, configFingerprint, use.likes, use.superlikes, use.dm, use.boosts, use.boostEndsMs ?? 0].join('|'))
    .update([utcDay(now), isoWeek(now), boostPeriod(now).period].join('|'))
    .digest('base64url')
    .slice(0, 16);
  return `"e${base.n}-${h}"`;
}

export interface LoadedBase {
  base: EntitlementBase;
  /** Whether it came from kv-cache (no statement). */
  cached: boolean;
}

export interface BaseLoader {
  cache: Redis;
  keys: KeyBuilder;
  /** The rows from PostgreSQL (one statement). */
  rows: (userId: string) => Promise<EntitlementRowsLike>;
  /** Called right before the rows are read (the caller raises its statement budget). */
  onMiss?: (() => void) | undefined;
  warn?: ((error: unknown, message: string) => void) | undefined;
}

/**
 * The base of a session: kv-cache when its version is current, else the rows
 * (one statement), stored under the version read before them.
 */
export async function loadEntitlementBase(
  loader: BaseLoader,
  userId: string,
  store: number,
  crossStore: boolean,
  version: number | null,
  walletVersion: number,
  now: number = Date.now(),
): Promise<LoadedBase> {
  const key = loader.keys.entitlements(userId, store);
  let raw: string | null = null;
  try {
    raw = await loader.cache.get(key);
  } catch (error) {
    loader.warn?.(error, 'entitlements: cached value unreadable');
  }
  const cached = version === null ? null : parseEntitlementBase(raw, crossStore, version, walletVersion, now);
  if (cached) return { base: cached, cached: true };
  loader.onMiss?.();
  const rows = await loader.rows(userId);
  const base = entitlementBase(rows, store, crossStore, version ?? 0, walletVersion, now);
  if (version !== null) {
    try {
      await loader.cache.set(key, JSON.stringify(base), 'EX', entitlementBaseTtl(base, now));
    } catch (error) {
      loader.warn?.(error, 'entitlements: not cached');
    }
  }
  return { base, cached: false };
}

/**
 * The `entitlement` event of a view: it goes to every device of the person,
 * so it names the store build whose view it is (`store`); a device of the
 * other build reads its own view again instead of applying this one.
 */
export function entitlementEnvelope(id: string, at: Date | number, entitlements: Entitlements, viewStore: number): RealtimeEnvelope<'entitlement'> {
  const name = storeCodes.nameOrUndefined(viewStore);
  return realtimeEnvelope('entitlement', id, at, { ...entitlements, ...(name === 'play' || name === 'bazaar' ? { store: name } : {}) });
}
