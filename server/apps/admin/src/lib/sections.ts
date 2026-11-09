import type { Permission } from '@app/shared';
import {
  FileText,
  Globe,
  Layers,
  LayoutDashboard,
  LifeBuoy,
  Palette,
  Server,
  ShieldCheck,
  ShoppingBag,
  TrendingUp,
  UserCog,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { MessageKey } from '@/i18n/messages';

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

/** The panel's navigation, in order. */
export const sectionGroups: readonly SectionGroup[] = [
  { label: 'nav.group.overview', items: [{ path: '', label: 'nav.dashboard', icon: LayoutDashboard, spec: 1 }] },
  {
    label: 'nav.group.operations',
    items: [
      { path: 'users', label: 'nav.users', icon: Users, spec: 2 },
      { path: 'moderation', label: 'nav.moderation', icon: ShieldCheck, spec: 3 },
      { path: 'support', label: 'nav.support', icon: LifeBuoy, spec: 8 },
    ],
  },
  {
    label: 'nav.group.revenue',
    items: [
      { path: 'revenue/plans', label: 'nav.plans', icon: Layers, permission: 'billing.read' },
      { path: 'revenue/products', label: 'nav.products', icon: ShoppingBag, permission: 'billing.read' },
    ],
  },
  {
    label: 'nav.group.product',
    items: [
      { path: 'content', label: 'nav.content', icon: FileText, spec: 4 },
      { path: 'growth', label: 'nav.growth', icon: TrendingUp, spec: 6 },
      { path: 'brand', label: 'nav.brand', icon: Palette, spec: 7 },
    ],
  },
  {
    label: 'nav.group.system',
    items: [
      { path: 'system/admins', label: 'nav.admins', icon: UserCog, permission: 'admins.read' },
      { path: 'hosts', label: 'nav.hosts', icon: Globe, owner: true },
      { path: 'system', label: 'nav.system', icon: Server, spec: 9 },
    ],
  },
];

/** Sections whose page is the "not built yet" placeholder. */
export const placeholderSections: readonly Section[] = sectionGroups.flatMap((group) => group.items.filter((item) => item.spec !== undefined));
