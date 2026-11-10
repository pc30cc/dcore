import { lazy, Suspense, type ReactNode } from 'react';
import { TableSkeleton } from '@/components/QueryState';

/** The panel's areas, each loaded on its first visit, so the sign-in page stays small. */

export const TotpPage = lazy(() => import('@/pages/login/TotpPage').then((m) => ({ default: m.TotpPage })));
export const EnrollPage = lazy(() => import('@/pages/login/EnrollPage').then((m) => ({ default: m.EnrollPage })));
export const PlansPage = lazy(() => import('@/pages/plans/PlansPage').then((m) => ({ default: m.PlansPage })));
export const PlanEditorPage = lazy(() => import('@/pages/plans/PlanEditorPage').then((m) => ({ default: m.PlanEditorPage })));
export const ProductsPage = lazy(() => import('@/pages/products/ProductsPage').then((m) => ({ default: m.ProductsPage })));
export const AdminsPage = lazy(() => import('@/pages/admins/AdminsPage').then((m) => ({ default: m.AdminsPage })));
export const SecurityPage = lazy(() => import('@/pages/account/SecurityPage').then((m) => ({ default: m.SecurityPage })));
export const AppearancePage = lazy(() => import('@/pages/appearance/AppearancePage').then((m) => ({ default: m.AppearancePage })));
export const HostsPage = lazy(() => import('@/pages/HostsPage').then((m) => ({ default: m.HostsPage })));

export function Loading({ children }: { children: ReactNode }) {
  return <Suspense fallback={<TableSkeleton rows={5} />}>{children}</Suspense>;
}
