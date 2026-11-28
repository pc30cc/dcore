import { Lock, Pencil, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadError, TableSkeleton } from '@/components/QueryState';
import { RolePermissions } from '@/components/RolePermissions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useI18n } from '@/i18n/useI18n';
import { roleName } from '@/lib/admins';
import { useRoles, type AdminRole } from '@/lib/queries';
import { callerGrants, roleStanding, useRoleHolders } from '@/lib/roles';
import { can } from '@/lib/session';
import { useSession } from '@/lib/useSession';
import { RoleEditorDialog } from './RoleEditorDialog';

/**
 * `/system/roles` (`admins.read`): every role with its admins and its
 * permissions by area; with `admins.manage`, a role's permissions are
 * edited, never the owner role's, a role the editor holds, or one beyond
 * the editor's own access.
 */
export function RolesPage() {
  const { t } = useI18n();
  const { me } = useSession();
  const roles = useRoles();
  const holders = useRoleHolders();
  const [editing, setEditing] = useState<string | null>(null);

  const header = <PageHeader icon={ShieldCheck} title={t('nav.roles')} />;
  if (roles.isPending || roles.isError) {
    return (
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6">
        {header}
        {roles.isPending ? <TableSkeleton rows={7} /> : <LoadError error={roles.error} onRetry={() => void roles.refetch()} />}
      </div>
    );
  }

  const grants = callerGrants(roles.data.items, me);
  const manage = can(me, 'admins.manage');
  const role = editing ? roles.data.items.find((item) => item.key === editing) : undefined;
  // Undefined while the counts are not known (loading or failed): the editor then warns without a number.
  const holdersOf = (key: string) => (holders.data ? (holders.data.items.find((item) => item.key === key)?.admins ?? 0) : undefined);

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6">
      {header}
      <ul className="grid items-start gap-4 md:grid-cols-2">
        {roles.data.items.map((item) => (
          <RoleCard key={item.key} role={item} grants={grants} manage={manage} holders={holders.data ? holdersOf(item.key) : holders.isPending ? undefined : null} onEdit={() => setEditing(item.key)} />
        ))}
      </ul>
      {role && <RoleEditorDialog key={role.key} role={role} grants={grants} holders={holdersOf(role.key)} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RoleCard({ role, grants, manage, holders, onEdit }: { role: AdminRole; grants: readonly string[]; manage: boolean; holders: number | null | undefined; onEdit: () => void }) {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const standing = roleStanding(role, me, grants);
  const name = roleName(role, role.key, locale, t);
  const editable = manage && !standing.owner && !standing.yours && !standing.beyond;
  return (
    <li className="grid min-w-0 content-start gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-xs sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 gap-1">
          <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold">
            <span className="min-w-0 break-words">{name}</span>
            {standing.owner && (
              <Badge variant="muted">
                <Lock aria-hidden="true" />
                {t('roles.locked')}
              </Badge>
            )}
            {standing.yours && <Badge variant="secondary">{t('roles.yours')}</Badge>}
            {standing.beyond && <Badge variant="warning">{t('roles.beyond')}</Badge>}
          </h2>
          {holders === undefined ? <Skeleton aria-hidden="true" className="h-5 w-20" /> : holders !== null && <div className="text-sm text-muted-foreground">{t('roles.holders', { count: holders })}</div>}
        </div>
        {editable && (
          <Button variant="outline" size="sm" onClick={onEdit} aria-label={t('roles.edit.of', { role: name })}>
            <Pencil aria-hidden="true" />
            {t('roles.edit')}
          </Button>
        )}
      </div>
      {standing.owner ? <p className="text-sm text-muted-foreground">{t('admins.role.owner')}</p> : <RolePermissions permissions={role.permissions} grouped />}
    </li>
  );
}
