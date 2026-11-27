import { Navigate, type RouteObject } from 'react-router';
import { AppShell } from '@/components/layout/AppShell';
import { RequireAdmin, RequirePermission } from '@/components/layout/RequireAdmin';
import { placeholderSections } from '@/lib/sections';
import {
  AdminsPage,
  AppealsPage,
  AppearancePage,
  AuditPage,
  DeviceBansPage,
  EnrollPage,
  HoldsPage,
  HostsPage,
  Loading,
  PhotoQueuePage,
  PlanEditorPage,
  PlansPage,
  ProductsPage,
  ReportPage,
  ReportsPage,
  SecurityPage,
  TermsPage,
  TextQueuePage,
  TotpPage,
  UserPage,
  UsersPage,
} from '@/pages/lazy';
import * as app from '@/pages/app/area';
import * as content from '@/pages/content/area';
import * as dashboard from '@/pages/dashboard/area';
import * as growth from '@/pages/growth/area';
import { CredentialsPage } from '@/pages/login/CredentialsPage';
import { ModerationIndex } from '@/pages/moderation/ModerationIndex';
import { NotFoundPage } from '@/pages/NotFoundPage';
import * as revenue from '@/pages/revenue/area';
import { SectionPage } from '@/pages/SectionPage';
import * as support from '@/pages/support/area';
import * as system from '@/pages/system/area';

/** Every route of the panel; tests mount them in a memory router. An area's routes come from its own module (`pages/<area>/area.tsx`). */
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
      {
        path: 'users',
        element: (
          <RequirePermission permission="users.read">
            <Loading>
              <UsersPage />
            </Loading>
          </RequirePermission>
        ),
      },
      {
        path: 'users/:id',
        element: (
          <RequirePermission permission="users.read">
            <Loading>
              <UserPage />
            </Loading>
          </RequirePermission>
        ),
      },
      ...(
        [
          ['moderation/photos', 'moderation.read', <PhotoQueuePage key="photos" />],
          ['moderation/texts', 'moderation.read', <TextQueuePage key="texts" />],
          ['moderation/reports', 'reports.read', <ReportsPage key="reports" />],
          ['moderation/reports/:id', 'reports.read', <ReportPage key="report" />],
          ['moderation/holds', 'reports.hold', <HoldsPage key="holds" />],
          ['moderation/appeals', 'appeals.read', <AppealsPage key="appeals" />],
          ['moderation/terms', 'moderation.read', <TermsPage key="terms" />],
          ['moderation/device-bans', 'moderation.read', <DeviceBansPage key="device-bans" />],
          ['system/audit', 'audit.read', <AuditPage key="audit" />],
        ] as const
      ).map(([path, permission, page]) => ({
        path,
        element: (
          <RequirePermission permission={permission}>
            <Loading>{page}</Loading>
          </RequirePermission>
        ),
      })),
      { path: 'moderation', element: <ModerationIndex /> },
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
      ...dashboard.routes,
      ...content.routes,
      ...revenue.routes,
      ...growth.routes,
      ...app.routes,
      ...support.routes,
      ...system.routes,
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
