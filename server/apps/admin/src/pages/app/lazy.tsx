import { lazy } from 'react';

/** The app area's pages, each loaded on its first visit. */

export const AppConfigPage = lazy(() => import('./AppConfigPage').then((m) => ({ default: m.AppConfigPage })));
export const BrandPage = lazy(() => import('./BrandPage').then((m) => ({ default: m.BrandPage })));
export const ProvidersPage = lazy(() => import('./ProvidersPage').then((m) => ({ default: m.ProvidersPage })));
export const ProfileReviewPage = lazy(() => import('./ProfileReviewPage').then((m) => ({ default: m.ProfileReviewPage })));
