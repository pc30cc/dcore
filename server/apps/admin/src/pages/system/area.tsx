import { Server } from 'lucide-react';
import type { RouteObject } from 'react-router';
import type { Section } from '@/lib/sections';

/**
 * The system area of the panel: its navigation items, in two places of the
 * System group (spread by `lib/sections.ts`: `roleSections` after the
 * admins, `jobSections` at the end), and its routes (spread by
 * `routes.tsx`). Its pages are declared here, lazily, so the sign-in page
 * stays small.
 */

export const roleSections: readonly Section[] = [];

export const jobSections: readonly Section[] = [{ path: 'system', label: 'nav.system', icon: Server, spec: 9 }];

export const routes: readonly RouteObject[] = [];
