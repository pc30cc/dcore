import type { Permission } from '@app/shared';
import {
  Ban,
  Contrast,
  Flag,
  Globe,
  Image as ImageIcon,
  Layers,
  Lock,
  Scale,
  ScrollText,
  ShoppingBag,
  Smartphone,
  Type,
  UserCog,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { MessageKey } from '@/i18n/messages';
import * as app from '@/pages/app/area';
import * as content from '@/pages/content/area';
import * as dashboard from '@/pages/dashboard/area';
import * as growth from '@/pages/growth/area';
import * as revenue from '@/pages/revenue/area';
import * as support from '@/pages/support/area';
import * as system from '@/pages/system/area';

export interface Section {
  /** Path under the panel root; '' is the dashboard. */
  path: string;
  label: MessageKey;
  icon: LucideIcon;
  /** A section not built yet: its number, shown on its placeholder page. */
  spec?: number;
  /** Shown to admins whose roles grant it (the API checks it again). */
  permission?: Permission;
  /** Shown to the owner role only. */
  owner?: boolean;
}

export interface SectionGroup {
  label: MessageKey;
  items: readonly Section[];
}

/** The moderation pages, in the order `/moderation` picks the first one an admin may open. */
export const moderationSections: readonly Section[] = [
  { path: 'moderation/photos', label: 'nav.photos', icon: ImageIcon, permission: 'moderation.read' },
  { path: 'moderation/texts', label: 'nav.texts', icon: Type, permission: 'moderation.read' },
  ...app.reviewSections,
  { path: 'moderation/reports', label: 'nav.reports', icon: Flag, permission: 'reports.read' },
  { path: 'moderation/appeals', label: 'nav.appeals', icon: Scale, permission: 'appeals.read' },
  { path: 'moderation/holds', label: 'nav.holds', icon: Lock, permission: 'reports.hold' },
  { path: 'moderation/terms', label: 'nav.terms', icon: Ban, permission: 'moderation.read' },
  { path: 'moderation/device-bans', label: 'nav.deviceBans', icon: Smartphone, permission: 'moderation.read' },
];

/**
 * The panel's navigation, in order. An area's items come from its own
 * module (`pages/<area>/area.tsx`), spread where they belong in the group.
 */
export const sectionGroups: readonly SectionGroup[] = [
  { label: 'nav.group.overview', items: [...dashboard.sections] },
  {
    label: 'nav.group.operations',
    items: [
      { path: 'users', label: 'nav.users', icon: Users, permission: 'users.read' },
      ...support.sections,
    ],
  },
  { label: 'nav.group.moderation', items: moderationSections },
  {
    label: 'nav.group.revenue',
    items: [
      { path: 'revenue/plans', label: 'nav.plans', icon: Layers, permission: 'billing.read' },
      { path: 'revenue/products', label: 'nav.products', icon: ShoppingBag, permission: 'billing.read' },
      ...revenue.sections,
    ],
  },
  {
    label: 'nav.group.product',
    items: [
      { path: 'app/appearance', label: 'nav.appearance', icon: Contrast, permission: 'config.read' },
      ...content.sections,
      ...growth.sections,
      ...app.sections,
    ],
  },
  {
    label: 'nav.group.system',
    items: [
      { path: 'system/admins', label: 'nav.admins', icon: UserCog, permission: 'admins.read' },
      ...system.roleSections,
      { path: 'hosts', label: 'nav.hosts', icon: Globe, owner: true },
      { path: 'system/audit', label: 'nav.audit', icon: ScrollText, permission: 'audit.read' },
      ...system.jobSections,
    ],
  },
];

/** Sections whose page is the "not built yet" placeholder. */
export const placeholderSections: readonly Section[] = sectionGroups.flatMap((group) => group.items.filter((item) => item.spec !== undefined));
