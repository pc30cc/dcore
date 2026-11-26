import type { Permission } from '@app/shared';
import {
  Ban,
  Contrast,
  FileText,
  Flag,
  Globe,
  Image as ImageIcon,
  Layers,
  LayoutDashboard,
  LifeBuoy,
  Lock,
  Palette,
  Scale,
  ScrollText,
  Server,
  ShoppingBag,
  Smartphone,
  TrendingUp,
  Type,
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

/** The moderation pages, in the order `/moderation` picks the first one an admin may open. */
export const moderationSections: readonly Section[] = [
  { path: 'moderation/photos', label: 'nav.photos', icon: ImageIcon, permission: 'moderation.read' },
  { path: 'moderation/texts', label: 'nav.texts', icon: Type, permission: 'moderation.read' },
  { path: 'moderation/reports', label: 'nav.reports', icon: Flag, permission: 'reports.read' },
  { path: 'moderation/appeals', label: 'nav.appeals', icon: Scale, permission: 'appeals.read' },
  { path: 'moderation/holds', label: 'nav.holds', icon: Lock, permission: 'reports.hold' },
  { path: 'moderation/terms', label: 'nav.terms', icon: Ban, permission: 'moderation.read' },
  { path: 'moderation/device-bans', label: 'nav.deviceBans', icon: Smartphone, permission: 'moderation.read' },
];

/** The panel's navigation, in order. */
export const sectionGroups: readonly SectionGroup[] = [
  { label: 'nav.group.overview', items: [{ path: '', label: 'nav.dashboard', icon: LayoutDashboard, spec: 1 }] },
  {
    label: 'nav.group.operations',
    items: [
      { path: 'users', label: 'nav.users', icon: Users, permission: 'users.read' },
      { path: 'support', label: 'nav.support', icon: LifeBuoy, spec: 8 },
    ],
  },
  { label: 'nav.group.moderation', items: moderationSections },
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
      { path: 'app/appearance', label: 'nav.appearance', icon: Contrast, permission: 'config.read' },
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
      { path: 'system/audit', label: 'nav.audit', icon: ScrollText, permission: 'audit.read' },
      { path: 'system', label: 'nav.system', icon: Server, spec: 9 },
    ],
  },
];

/** Sections whose page is the "not built yet" placeholder. */
export const placeholderSections: readonly Section[] = sectionGroups.flatMap((group) => group.items.filter((item) => item.spec !== undefined));
