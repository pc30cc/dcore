import { FileText } from 'lucide-react';
import type { RouteObject } from 'react-router';
import type { Section } from '@/lib/sections';

/**
 * The content area of the panel: its navigation items (spread into their
 * group by `lib/sections.ts`) and its routes (spread by `routes.tsx`). Its
 * pages are declared here, lazily, so the sign-in page stays small.
 */

export const sections: readonly Section[] = [{ path: 'content', label: 'nav.content', icon: FileText, spec: 4 }];

export const routes: readonly RouteObject[] = [];
