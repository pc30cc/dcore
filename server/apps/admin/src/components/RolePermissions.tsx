import { isPermission } from '@app/shared';
import { Badge } from '@/components/ui/badge';
import { useI18n } from '@/i18n/useI18n';
import { permissionHint, permissionLabel, permissionRestricted } from '@/lib/admins';
import { areaLabel, editorAreas } from '@/lib/roles';
import { cn } from '@/lib/utils';

function RestrictedBadge() {
  const { t } = useI18n();
  return (
    <Badge variant="outline" className="px-1.5 py-0 text-[0.65rem]">
      {t('permission.restricted')}
    </Badge>
  );
}

/**
 * What a role grants, by the panel's names, folded (restricted ones marked).
 * `grouped` lists them under their areas, names only (the roles page);
 * otherwise each with its sentence (the admins dialog).
 */
export function RolePermissions({ permissions, grouped = false, className }: { permissions: readonly string[]; grouped?: boolean; className?: string }) {
  const { t } = useI18n();
  const summary = <summary className="cursor-pointer select-none">{t('admins.role.permissions', { count: permissions.length })}</summary>;
  if (grouped) {
    const held = new Set(permissions);
    const areas = editorAreas()
      .map((area) => ({ area: area.area, list: area.permissions.filter((permission) => held.has(permission)) }))
      .filter((area) => area.list.length > 0);
    // A permission this build has no area for (a newer server's) is shown by its code.
    const other = permissions.filter((permission) => !isPermission(permission));
    return (
      <details className={cn('text-xs text-muted-foreground', className)}>
        {summary}
        <div className="mt-3 grid gap-3">
          {areas.map(({ area, list }) => (
            <div key={area} className="grid gap-1.5">
              <span className="font-medium text-foreground">{areaLabel(area, t)}</span>
              <ul className="flex flex-wrap gap-1.5">
                {list.map((permission) => (
                  <li key={permission}>
                    <span title={permissionHint(permission, t) ?? undefined} className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-foreground">
                      {permissionLabel(permission, t)}
                      {permissionRestricted(permission) && <RestrictedBadge />}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {other.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {other.map((permission) => (
                <li key={permission} dir="ltr" className="font-mono">
                  {permission}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    );
  }
  return (
    <details className={cn('ps-7 text-xs text-muted-foreground', className)}>
      {summary}
      <ul className="mt-2 grid gap-1.5">
        {permissions.map((permission) => (
          <li key={permission} className="grid gap-0.5">
            <span className="flex flex-wrap items-center gap-1.5 text-foreground">
              {permissionLabel(permission, t)}
              {permissionRestricted(permission) && <RestrictedBadge />}
            </span>
            {permissionHint(permission, t) && <span>{permissionHint(permission, t)}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}
