import { lazy } from 'react';

/** The dashboard area's pages, each loaded on its first visit. */

export const DashboardPage = lazy(() => import('./DashboardPage').then((m) => ({ default: m.DashboardPage })));
export const StatsPage = lazy(() => import('./StatsPage').then((m) => ({ default: m.StatsPage })));
