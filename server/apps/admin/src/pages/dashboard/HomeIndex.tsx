import { Navigate } from 'react-router';
import { RequirePermission } from '@/components/layout/RequireAdmin';
import { sectionGroups, type Section } from '@/lib/sections';
import { can, isOwner } from '@/lib/session';
import { useSession } from '@/lib/useSession';
import { Loading } from '@/pages/lazy';
import { DashboardPage } from './lazy';

/**
 * `/`: the dashboard for an admin who may read it; anyone else goes to the
 * first built page of the navigation their roles reach (none: "No access"),
 * so a sign-in never lands on a refusal.
 */
export function HomeIndex() {
  const { me } = useSession();
  if (can(me, 'dashboard.read')) {
    return (
      <Loading>
        <DashboardPage />
      </Loading>
    );
  }
  const visible = (item: Section) => item.path !== '' && item.spec === undefined && (item.owner ? isOwner(me) : item.permission ? can(me, item.permission) : true);
  const first = sectionGroups.flatMap((group) => group.items).find(visible);
  if (first) return <Navigate to={`/${first.path}`} replace />;
  return <RequirePermission permission="dashboard.read">{null}</RequirePermission>;
}
