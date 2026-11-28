import { Gift, Receipt } from 'lucide-react';
import type { RouteObject } from 'react-router';
import { RequirePermission } from '@/components/layout/RequireAdmin';
import type { Section } from '@/lib/sections';
import { Loading } from '@/pages/lazy';
import { GrantsPage, PurchasePage, PurchasesPage } from './lazy';

/**
 * The revenue area of the panel: its navigation items (spread into their
 * group by `lib/sections.ts`, after the plans and store products) and its
 * routes (spread by `routes.tsx`). Its pages are declared here, lazily, so
 * the sign-in page stays small.
 */

export const sections: readonly Section[] = [
  { path: 'revenue/purchases', label: 'nav.purchases', icon: Receipt, permission: 'billing.read' },
  { path: 'revenue/grants', label: 'nav.grants', icon: Gift, permission: 'billing.read' },
];

export const routes: readonly RouteObject[] = [
  {
    path: 'revenue/purchases',
    element: (
      <RequirePermission permission="billing.read">
        <Loading>
          <PurchasesPage />
        </Loading>
      </RequirePermission>
    ),
  },
  {
    path: 'revenue/purchases/:id',
    element: (
      <RequirePermission permission="billing.read">
        <Loading>
          <PurchasePage />
        </Loading>
      </RequirePermission>
    ),
  },
  {
    path: 'revenue/grants',
    element: (
      <RequirePermission permission="billing.read">
        <Loading>
          <GrantsPage />
        </Loading>
      </RequirePermission>
    ),
  },
];
