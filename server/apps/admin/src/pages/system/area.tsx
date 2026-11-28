import { Server, ShieldCheck } from 'lucide-react';
import { Navigate, type RouteObject } from 'react-router';
import { RequirePermission } from '@/components/layout/RequireAdmin';
import type { Section } from '@/lib/sections';
import { Loading } from '@/pages/lazy';
import { JobsPage, RolesPage } from './lazy';

/**
 * The system area of the panel: its navigation items, in two places of the
 * System group (spread by `lib/sections.ts`: `roleSections` after the
 * admins, `jobSections` at the end), and its routes (spread by
 * `routes.tsx`). Its pages are declared here, lazily, so the sign-in page
 * stays small.
 */

export const roleSections: readonly Section[] = [{ path: 'system/roles', label: 'nav.roles', icon: ShieldCheck, permission: 'admins.read' }];

export const jobSections: readonly Section[] = [{ path: 'system/jobs', label: 'nav.system', icon: Server, permission: 'system.read' }];

export const routes: readonly RouteObject[] = [
  { path: 'system', element: <Navigate to="/system/jobs" replace /> },
  {
    path: 'system/jobs',
    element: (
      <RequirePermission permission="system.read">
        <Loading>
          <JobsPage />
        </Loading>
      </RequirePermission>
    ),
  },
  {
    path: 'system/roles',
    element: (
      <RequirePermission permission="admins.read">
        <Loading>
          <RolesPage />
        </Loading>
      </RequirePermission>
    ),
  },
];
