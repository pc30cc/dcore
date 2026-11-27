import { ChartLine, LayoutDashboard } from 'lucide-react';
import type { RouteObject } from 'react-router';
import { RequirePermission } from '@/components/layout/RequireAdmin';
import type { Section } from '@/lib/sections';
import { Loading } from '@/pages/lazy';
import { HomeIndex } from './HomeIndex';
import { StatsPage } from './lazy';

/**
 * The dashboard area of the panel: its navigation items (spread into their
 * group by `lib/sections.ts`) and its routes (spread by `routes.tsx`). Its
 * pages load on their first visit (`./lazy`), so the sign-in page stays small.
 */

export const sections: readonly Section[] = [
  { path: '', label: 'nav.dashboard', icon: LayoutDashboard, permission: 'dashboard.read' },
  { path: 'stats', label: 'nav.stats', icon: ChartLine, permission: 'dashboard.read' },
];

export const routes: readonly RouteObject[] = [
  { index: true, element: <HomeIndex /> },
  {
    path: 'stats',
    element: (
      <RequirePermission permission="dashboard.read">
        <Loading>
          <StatsPage />
        </Loading>
      </RequirePermission>
    ),
  },
];
