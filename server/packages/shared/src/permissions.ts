/**
 * Admin permissions: code-defined strings `area.verb`. The database only
 * assigns them to roles (`admin_role_permissions`), where a grant is a
 * permission, `area.*` (every permission of the area) or `*` (everything).
 *
 * A `restricted` permission is never covered by its area's wildcard: only
 * `*` or the permission itself grants it. That keeps provider secrets, test
 * accounts and the admin accounts with the owner role (`*`) even where a
 * role holds `config.*` or `users.*`.
 *
 * Routes name the permission they need (`app.requirePermission('users.ban')`);
 * the catalogue is a type, so a misspelt permission does not compile.
 */

export interface PermissionInfo {
  /** Not covered by `area.*`: only `*` or the exact grant. */
  readonly restricted?: true;
}

export const permissionCatalog = {
  'dashboard.read': {},

  'users.read': {},
  'users.view_phone': {},
  'users.test_account': { restricted: true },
  'users.edit': {},
  'users.warn': {},
  'users.suspend': {},
  'users.ban': {},
  'users.shadowban': {},
  'users.lift': {},
  'users.revoke_sessions': {},
  'users.verify': {},
  'users.gift': {},
  'users.delete': {},
  'users.export': {},

  'moderation.read': {},
  'moderation.decide': {},
  'moderation.terms': {},
  'moderation.device_bans': {},

  'reports.read': {},
  'reports.assign': {},
  'reports.resolve': {},
  'reports.view_chat': {},
  'reports.hold': {},

  'appeals.read': {},
  'appeals.decide': {},

  'content.read': {},
  'content.write': {},

  'billing.read': {},
  /** Plans (features, quotas, names, order, archive) and store products. */
  'billing.catalog': {},
  'billing.write': {},
  'billing.grant': {},
  'billing.refund': {},

  'campaigns.read': {},
  'campaigns.write': {},

  'config.read': {},
  'config.write': {},
  'config.providers': { restricted: true },

  'support.read': {},
  'support.write': {},

  'admins.read': { restricted: true },
  'admins.manage': { restricted: true },

  'audit.read': {},
  'system.read': {},
} as const satisfies Record<string, PermissionInfo>;

export type Permission = keyof typeof permissionCatalog;

export const permissions = Object.keys(permissionCatalog) as Permission[];

/** The key of the role that holds `*` and manages admins (seeded as role 1). */
export const OWNER_ROLE = 'superadmin';

/** A grant as `admin_role_permissions` stores it (its CHECK). */
export const PERMISSION_GRANT = /^(\*|[a-z_]+\.(\*|[a-z_]+))$/;

export function isPermission(value: string): value is Permission {
  return Object.hasOwn(permissionCatalog, value);
}

function isRestricted(permission: Permission): boolean {
  return (permissionCatalog[permission] as PermissionInfo).restricted === true;
}

/** Whether one grant covers `permission`. */
export function grantCovers(grant: string, permission: Permission): boolean {
  if (grant === '*') return true;
  if (grant === permission) return true;
  if (!grant.endsWith('.*') || isRestricted(permission)) return false;
  return permission.startsWith(grant.slice(0, -1));
}

/** Whether any of `grants` covers `permission`. */
export function grantsAllow(grants: Iterable<string>, permission: Permission): boolean {
  for (const grant of grants) if (grantCovers(grant, permission)) return true;
  return false;
}

/** Every catalogue permission `grants` cover, in catalogue order. */
export function expandGrants(grants: Iterable<string>): Permission[] {
  const list = [...grants];
  return permissions.filter((permission) => list.some((grant) => grantCovers(grant, permission)));
}
