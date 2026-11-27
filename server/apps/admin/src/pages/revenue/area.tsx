import type { RouteObject } from 'react-router';
import type { Section } from '@/lib/sections';

/**
 * The revenue area of the panel: its navigation items (spread into their
 * group by `lib/sections.ts`, after the plans and store products) and its
 * routes (spread by `routes.tsx`). Its pages are declared here, lazily, so
 * the sign-in page stays small.
 */

export const sections: readonly Section[] = [];

export const routes: readonly RouteObject[] = [];
