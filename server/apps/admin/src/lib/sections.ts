import {
  CreditCard,
  FileText,
  Globe,
  LayoutDashboard,
  LifeBuoy,
  Palette,
  Server,
  ShieldCheck,
  TrendingUp,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { MessageKey } from '@/i18n/messages';

export interface Section {
  /** Path under the panel root; '' is the dashboard. */
  path: string;
  label: MessageKey;
  icon: LucideIcon;
  /** The section's number, shown on its placeholder page. */
  spec: number;
}

/** The panel's sections, in navigation order. */
export const sections: readonly Section[] = [
  { path: '', label: 'nav.dashboard', icon: LayoutDashboard, spec: 1 },
  { path: 'users', label: 'nav.users', icon: Users, spec: 2 },
  { path: 'moderation', label: 'nav.moderation', icon: ShieldCheck, spec: 3 },
  { path: 'content', label: 'nav.content', icon: FileText, spec: 4 },
  { path: 'revenue', label: 'nav.revenue', icon: CreditCard, spec: 5 },
  { path: 'growth', label: 'nav.growth', icon: TrendingUp, spec: 6 },
  { path: 'brand', label: 'nav.brand', icon: Palette, spec: 7 },
  { path: 'support', label: 'nav.support', icon: LifeBuoy, spec: 8 },
  { path: 'system', label: 'nav.system', icon: Server, spec: 9 },
  { path: 'hosts', label: 'nav.hosts', icon: Globe, spec: 9 },
];
