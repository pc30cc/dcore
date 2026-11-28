import { KeyRound, Palette, SlidersHorizontal, UserCheck } from 'lucide-react';
import type { RouteObject } from 'react-router';
import { RequirePermission } from '@/components/layout/RequireAdmin';
import type { Section } from '@/lib/sections';
import { Loading } from '@/pages/lazy';
import { AppConfigPage, BrandPage, ProfileReviewPage, ProvidersPage } from './lazy';

/**
 * The app area of the panel: its navigation items (spread into their group
 * by `lib/sections.ts`: the settings in Product, the new-profile queue in
 * Moderation) and its routes (spread by `routes.tsx`). Its pages are
 * declared here, lazily, so the sign-in page stays small.
 */

export const sections: readonly Section[] = [
  {
    path: 'app/config',
    label: 'nav.appConfig',
    icon: SlidersHorizontal,
    permission: 'config.read',
  },
  {
    path: 'app/brand',
    label: 'nav.appBrand',
    icon: Palette,
    permission: 'config.read',
  },
  {
    path: 'app/providers',
    label: 'nav.providers',
    icon: KeyRound,
    permission: 'config.providers',
  },
];

/** The moderation group's new-profile queue (placed after the text queue). */
export const reviewSections: readonly Section[] = [
  {
    path: 'moderation/profiles',
    label: 'nav.profiles',
    icon: UserCheck,
    permission: 'moderation.read',
  },
];

export const routes: readonly RouteObject[] = [
  {
    path: 'app/config',
    element: (
      <RequirePermission permission="config.read">
        <Loading>
          <AppConfigPage />
        </Loading>
      </RequirePermission>
    ),
  },
  {
    path: 'app/brand',
    element: (
      <RequirePermission permission="config.read">
        <Loading>
          <BrandPage />
        </Loading>
      </RequirePermission>
    ),
  },
  {
    path: 'app/providers',
    element: (
      <RequirePermission permission="config.providers">
        <Loading>
          <ProvidersPage />
        </Loading>
      </RequirePermission>
    ),
  },
  {
    path: 'moderation/profiles',
    element: (
      <RequirePermission permission="moderation.read">
        <Loading>
          <ProfileReviewPage />
        </Loading>
      </RequirePermission>
    ),
  },
];
