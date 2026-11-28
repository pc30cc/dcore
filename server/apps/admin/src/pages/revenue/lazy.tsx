import { lazy } from 'react';

/** The revenue area's pages, each loaded on its first visit. */

export const PurchasesPage = lazy(() => import('./PurchasesPage').then((m) => ({ default: m.PurchasesPage })));
export const PurchasePage = lazy(() => import('./PurchasePage').then((m) => ({ default: m.PurchasePage })));
export const GrantsPage = lazy(() => import('./GrantsPage').then((m) => ({ default: m.GrantsPage })));
