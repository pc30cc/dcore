import { storeEventSource, type AppStore } from '@app/shared';
import type { FakeStoreVerifier, FakeStorePurchase, VerifiedPurchase } from '@app/shared/server';
import type { Harness, SeededUser } from './accountSupport.js';

/**
 * Purchases for the revenue suites, written through the purchase core as a
 * store's verified answer (one statement, no store call), and known to the
 * fake store by their token, so a re-check, a refund or a stop of renewal
 * finds them there.
 */

const DAY = 86_400_000;
let counter = 0;

export interface SeedPurchase {
  store?: AppStore;
  kind?: 'subscription' | 'consumable';
  /** null: unclaimed (no account could be attributed). */
  user: SeededUser | null;
  productId?: string;
  basePlanId?: string | null;
  state?: VerifiedPurchase['state'];
  expiresAtMs?: number | null;
  autoRenew?: boolean | null;
  orderId?: string | null;
  linkedPurchaseToken?: string | null;
  token?: string;
  /** Known to this fake store as well (default: the one passed in `fakes` for the purchase's store). */
  fakes?: Partial<Record<AppStore, FakeStoreVerifier>>;
}

export interface SeededPurchase {
  id: string;
  token: string;
  orderId: string | null;
}

/** The catalogue's products the suites use (inactive rows still resolve). */
function productOf(store: AppStore, kind: 'subscription' | 'consumable'): { productId: string; basePlanId: string | null } {
  if (kind === 'consumable') return { productId: 'cons.boost.1', basePlanId: null };
  return store === 'play' ? { productId: 'sub.plus', basePlanId: 'm1' } : { productId: 'sub.plus.1m', basePlanId: null };
}

export async function seedPurchase(h: Harness, options: SeedPurchase): Promise<SeededPurchase> {
  counter += 1;
  const store = options.store ?? 'play';
  const kind = options.kind ?? 'subscription';
  const product = productOf(store, kind);
  const productId = options.productId ?? product.productId;
  const basePlanId = options.basePlanId === undefined ? product.basePlanId : options.basePlanId;
  const token = options.token ?? `revenue-${store}-${kind}-${counter}-${Date.now()}-token`;
  const orderId = options.orderId === undefined ? (store === 'play' ? `GPA.3300-${String(1000 + counter)}-${String(Date.now()).slice(-6)}` : `bz${String(Date.now()).slice(-8)}${counter}`) : options.orderId;
  const now = Date.now();
  const subscription = kind === 'subscription';
  const state = options.state ?? (subscription ? 'active' : 'purchased');
  const expiresAtMs = options.expiresAtMs === undefined ? (subscription ? now + 30 * DAY : null) : options.expiresAtMs;
  const autoRenew = options.autoRenew === undefined ? (subscription ? state === 'active' : null) : options.autoRenew;
  const verified: VerifiedPurchase = {
    kind,
    productId,
    basePlanId,
    state,
    purchasedAtMs: now - 60_000,
    expiresAtMs,
    autoRenew,
    accountRef: null,
    orderId,
    linkedPurchaseToken: options.linkedPurchaseToken ?? null,
    quantity: 1,
    isTest: false,
    region: 'DE',
    acknowledged: true,
    consumed: false,
    eventMs: now - 30_000,
    amount: null,
    nextCheckAtMs: null,
    refundCheckAtMs: null,
    needsAcknowledge: false,
    needsConsume: false,
  };
  const fake = options.fakes?.[store];
  if (fake) {
    const known: FakeStorePurchase = { ...verified, kind, productId, eventMs: now - 30_000 };
    fake.put(token, known);
  }
  const applied = await h.app.store.core.apply(verified, { store, token, callerId: options.user?.id ?? null, source: storeEventSource.code('app') });
  if (applied.outcome === 'foreign_account' || applied.outcome === 'unknown_product') throw new Error(`purchase not seeded: ${applied.outcome}`);
  return { id: applied.purchaseId, token, orderId };
}
