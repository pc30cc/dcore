import { Palette } from 'lucide-react';
import type { RouteObject } from 'react-router';
import type { Section } from '@/lib/sections';

/**
 * The app area of the panel: its navigation items (spread into their group
 * by `lib/sections.ts`) and its routes (spread by `routes.tsx`). Its pages
 * are declared here, lazily, so the sign-in page stays small.
 */

export const sections: readonly Section[] = [{ path: 'brand', label: 'nav.brand', icon: Palette, spec: 7 }];

export const routes: readonly RouteObject[] = [];
