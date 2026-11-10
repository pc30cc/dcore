import { Navigate, type RouteObject } from 'react-router';
import { AppShell } from '@/components/layout/AppShell';
import { RequireAdmin, RequirePermission } from '@/components/layout/RequireAdmin';
import { placeholderSections } from '@/lib/sections';
import { AdminsPage, AppearancePage, EnrollPage, HostsPage, Loading, PlanEditorPage, PlansPage, ProductsPage, SecurityPage, TotpPage } from '@/pages/lazy';
import { CredentialsPage } from '@/pages/login/CredentialsPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { SectionPage } from '@/pages/SectionPage';

/** Every route of the panel; tests mount them in a memory router. */
export const routes: RouteObject[] = [
  { path: '/login', element: <CredentialsPage /> },
  {
    path: '/login/totp',
    element: (
      <Loading>
        <TotpPage />
      </Loading>
    ),
  },
  {
    path: '/login/enroll',
    element: (
      <Loading>
        <EnrollPage />
      </Loading>
    ),
  },
  {
    path: '/',
    element: (
      <RequireAdmin>
        <AppShell />
      </RequireAdmin>
    ),
    children: [
      ...placeholderSections.map((section) =>
        section.path === '' ? { index: true, element: <SectionPage section={section} /> } : { path: section.path, element: <SectionPage section={section} /> },
      ),
      { path: 'revenue', element: <Navigate to="/revenue/plans" replace /> },
      {
        path: 'revenue/plans',
        element: (
          <RequirePermission permission="billing.read">
            <Loading>
              <PlansPage />
            </Loading>
          </RequirePermission>
        ),
      },
      {
        path: 'revenue/plans/new',
        element: (
          <RequirePermission permission="billing.catalog">
            <Loading>
              <PlanEditorPage mode="create" />
            </Loading>
          </RequirePermission>
        ),
      },
      {
        path: 'revenue/plans/:key',
        element: (
          <RequirePermission permission="billing.read">
            <Loading>
              <PlanEditorPage mode="edit" />
            </Loading>
          </RequirePermission>
        ),
      },
      {
        path: 'revenue/products',
        element: (
          <RequirePermission permission="billing.read">
            <Loading>
              <ProductsPage />
            </Loading>
          </RequirePermission>
        ),
      },
      { path: 'app', element: <Navigate to="/app/appearance" replace /> },
      {
        path: 'app/appearance',
        element: (
          <RequirePermission permission="config.read">
            <Loading>
              <AppearancePage />
            </Loading>
          </RequirePermission>
        ),
      },
      {
        path: 'system/admins',
        element: (
          <RequirePermission permission="admins.read">
            <Loading>
              <AdminsPage />
            </Loading>
          </RequirePermission>
        ),
      },
      {
        path: 'hosts',
        element: (
          <RequirePermission owner>
            <Loading>
              <HostsPage />
            </Loading>
          </RequirePermission>
        ),
      },
      {
        path: 'me/security',
        element: (
          <Loading>
            <SecurityPage />
          </Loading>
        ),
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
