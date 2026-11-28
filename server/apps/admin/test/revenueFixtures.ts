import type { AdminGrant, AdminPurchaseDetail, AdminPurchaseListItem, AdminPurchaseSummary, AdminUserRef, AdminWalletAdjustment, Permission } from '@app/shared';
import { adminWith } from './panel';

/** Purchases, grants and wallet rows as the admin API answers them, for the revenue pages' tests. */

/** The seeded roles' revenue grants, expanded. */
export const FINANCE: Permission[] = ['users.read', 'billing.read', 'billing.write', 'billing.grant', 'billing.refund', 'billing.catalog'];
/** The admin role: reads billing, gives gifts (users.gift through users.*), no write, grant or refund. */
export const ADMIN_ROLE: Permission[] = ['users.read', 'users.gift', 'billing.read', 'billing.catalog'];
export const financeAdmin = adminWith(FINANCE, ['finance']);
export const adminRole = adminWith(ADMIN_ROLE, ['admin']);

export const PERSON = 'dvcfudgve22g7';
export const OTHER = 'nkqn2qh3x5ust';

export const personRef = (id = PERSON, overrides: Partial<AdminUserRef> = {}): AdminUserRef => ({ id, name: 'Daniel Weber', status: 'active', ...overrides });

export function summaryOf(id: string, overrides: Partial<AdminPurchaseSummary> = {}): AdminPurchaseSummary {
  return {
    id,
    store: 'play',
    productId: 'sub.premium',
    basePlanId: 'm1',
    kind: 'subscription',
    plan: 'premium',
    item: null,
    grantQuantity: null,
    quantity: 1,
    state: 'active',
    user: personRef(),
    purchasedAt: '2026-10-18T10:00:00.000Z',
    expiresAt: '2026-12-17T10:00:00.000Z',
    autoRenew: true,
    orderId: 'GPA.3392-1184-0921-55341',
    isTest: false,
    region: 'DE',
    ...overrides,
  };
}

/** A row of a store's list, as the API answers it: no order id. */
export function listItemOf(id: string, overrides: Partial<AdminPurchaseListItem> = {}): AdminPurchaseListItem {
  const { orderId: _orderId, ...item } = summaryOf(id);
  return { ...item, ...overrides };
}

export function purchaseOf(id: string, overrides: Partial<AdminPurchaseDetail> = {}): AdminPurchaseDetail {
  return {
    ...summaryOf(id),
    period: 'P1M',
    acknowledgedAt: '2026-10-18T10:01:00.000Z',
    consumedAt: null,
    creditedAt: null,
    nextCheckAt: '2026-12-17T12:00:00.000Z',
    updatedAt: '2026-11-17T10:00:00.000Z',
    counts: true,
    replaces: null,
    replacedBy: null,
    wallet: null,
    events: {
      items: [
        {
          id: '902',
          at: '2026-11-17T10:00:00.000Z',
          event: 'renewed',
          source: 'rtdn',
          stateFrom: 'active',
          stateTo: 'active',
          expiresAt: '2026-12-17T10:00:00.000Z',
          amount: { micros: '9990000', currency: 'EUR', estimated: false },
          orderId: 'GPA.3392-1184-0921-55341..0',
        },
        {
          id: '901',
          at: '2026-10-18T10:00:00.000Z',
          event: 'verified',
          source: 'app',
          stateFrom: null,
          stateTo: 'active',
          expiresAt: '2026-11-17T10:00:00.000Z',
          amount: { micros: '9990000', currency: 'EUR', estimated: false },
          orderId: 'GPA.3392-1184-0921-55341',
        },
      ],
      nextCursor: null,
    },
    history: [],
    connected: true,
    available: ['recheck', 'cancel', 'refund', 'refund_prorated', 'revoke'],
    ...overrides,
  };
}

export function grantOf(id: string, overrides: Partial<AdminGrant> = {}): AdminGrant {
  return {
    id,
    user: personRef(),
    plan: 'plus',
    startsAt: '2026-11-22T10:00:00.000Z',
    endsAt: '2026-12-22T10:00:00.000Z',
    state: 'active',
    reason: 'Beta tester thank-you',
    grantedBy: { id: '1', displayName: 'Leila Moradi' },
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
    ...overrides,
  };
}

export function adjustmentOf(id: string, overrides: Partial<AdminWalletAdjustment> = {}): AdminWalletAdjustment {
  return {
    id,
    at: '2026-11-25T10:00:00.000Z',
    user: personRef(),
    item: 'superlike',
    store: null,
    delta: 5,
    balanceAfter: 5,
    reason: 'gift',
    admin: { id: '1', displayName: 'Leila Moradi' },
    note: 'Thanks for the bug report',
    ...overrides,
  };
}

/** A page of a list. */
export const pageOf = <T>(items: T[], nextCursor: string | null = null) => ({ items, nextCursor });
