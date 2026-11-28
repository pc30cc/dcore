import { lazy } from 'react';

/** The system area's pages, each loaded on its first visit. */

export const JobsPage = lazy(() => import('./JobsPage').then((m) => ({ default: m.JobsPage })));
export const RolesPage = lazy(() => import('./RolesPage').then((m) => ({ default: m.RolesPage })));
