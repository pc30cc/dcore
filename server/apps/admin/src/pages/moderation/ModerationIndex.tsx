import { Navigate } from 'react-router';
import { RequirePermission } from '@/components/layout/RequireAdmin';
import { moderationSections } from '@/lib/sections';
import { can } from '@/lib/session';
import { useSession } from '@/lib/useSession';

/** `/moderation`: the first moderation page the admin may open; none, the panel's "No access". */
export function ModerationIndex() {
  const { me } = useSession();
  const first = moderationSections.find((section) => section.permission && can(me, section.permission));
  if (first) return <Navigate to={`/${first.path}`} replace />;
  return <RequirePermission permission="moderation.read">{null}</RequirePermission>;
}
