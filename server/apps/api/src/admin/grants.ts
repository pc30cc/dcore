import { OWNER_ROLE, expandGrants, isKnownGrant, isPermission, isRestrictedPermission, type Permission } from '@app/shared';

/**
 * The role editor's rules, pure (the route runs them; the database's
 * `admin_role_rules()` keeps the role rules too):
 *
 * - a role's grants are permissions of the catalogue and `area.*` wildcards
 *   (`*` is the owner role's alone);
 * - `users.chats` is held by the admin role only, and the analyst role
 *   holds dashboard permissions only, whoever edits (the owner included);
 * - an editor never reaches past their own access: the role as it stands
 *   and as requested must be within it, a wildcard is given or kept only by
 *   an editor holding the same wildcard (it covers permissions a later build
 *   adds to the area), and a restricted permission is given or taken by the
 *   owner (`*`) only.
 */

/** The role users.chats is held by. */
export const CHATS_ROLE = 'admin';
/** The role that reads dashboards only. */
export const ANALYST_ROLE = 'analyst';
const CHATS: Permission = 'users.chats';

export type GrantIssue = { pointer: string; code: 'owner_grant' | 'unknown_permission' | 'chats_admin_only' | 'analyst_dashboards_only' };

/**
 * The requested grants, checked and normalised: duplicates dropped, exact
 * permissions a wildcard of the set covers dropped (restricted ones kept:
 * no wildcard covers them), sorted. Refusals point at `/grants/<i>`.
 */
export function normalizeGrants(requested: readonly string[]): { grants: string[] } | { issue: GrantIssue } {
  for (const [i, grant] of requested.entries()) {
    if (grant === '*') return { issue: { pointer: `/grants/${i}`, code: 'owner_grant' } };
    if (!isKnownGrant(grant)) return { issue: { pointer: `/grants/${i}`, code: 'unknown_permission' } };
  }
  const unique = [...new Set(requested)];
  const wildcards = unique.filter((grant) => grant.endsWith('.*'));
  const kept = unique.filter((grant) => {
    if (grant.endsWith('.*') || !isPermission(grant)) return true;
    if (isRestrictedPermission(grant)) return true;
    return !wildcards.some((w) => grant.startsWith(w.slice(0, -1)));
  });
  return { grants: kept.sort() };
}

/** The role rules that hold for every editor: users.chats on the admin role only, the analyst on dashboards only. */
export function checkRoleRules(role: string, requested: readonly string[]): GrantIssue | null {
  for (const [i, grant] of requested.entries()) {
    if (role !== CHATS_ROLE && expandGrants([grant]).includes(CHATS)) return { pointer: `/grants/${i}`, code: 'chats_admin_only' };
    if (role === ANALYST_ROLE && !grant.startsWith('dashboard.')) return { pointer: `/grants/${i}`, code: 'analyst_dashboards_only' };
  }
  return null;
}

export type RoleEditRefusal =
  | { reason: 'beyond_role' }
  | { reason: 'beyond_grants'; permissions: Permission[] }
  | { reason: 'restricted_permission'; permissions: Permission[] };

/** What the editor may not do to the role (null: the edit is within the editor's access). */
export function checkRoleEdit(input: { callerGrants: readonly string[]; stored: readonly string[]; requested: readonly string[] }): RoleEditRefusal | null {
  const { callerGrants, stored, requested } = input;
  const owner = callerGrants.includes('*');
  const callerPermissions = new Set(expandGrants(callerGrants));
  const beyond = (grants: readonly string[]) => expandGrants(grants).filter((permission) => !callerPermissions.has(permission));
  // The role as it stands must be within the editor's access.
  if (beyond(stored).length > 0) return { reason: 'beyond_role' };
  // A wildcard (given or kept) only by an editor holding the same one.
  if (!owner) {
    const foreign = [...new Set([...requested, ...stored])].filter((grant) => grant.endsWith('.*') && !callerGrants.includes(grant));
    if (foreign.length > 0) return { reason: 'beyond_grants', permissions: expandGrants(foreign) };
  }
  const requestedBeyond = beyond(requested);
  if (requestedBeyond.length > 0) return { reason: 'beyond_grants', permissions: requestedBeyond };
  // A restricted permission is given or taken by the owner only.
  if (!owner) {
    const before = new Set(expandGrants(stored));
    const after = new Set(expandGrants(requested));
    const changed = [...new Set([...before, ...after])].filter((permission) => before.has(permission) !== after.has(permission) && isRestrictedPermission(permission));
    if (changed.length > 0) return { reason: 'restricted_permission', permissions: changed };
  }
  return null;
}

/** Whether a role is one the editor never changes: the owner role, or any role holding `*`. */
export function isOwnerLike(key: string, grants: readonly string[]): boolean {
  return key === OWNER_ROLE || grants.includes('*');
}

/** The permissions a change takes away (who loses them is signed out). */
export function removedPermissions(before: readonly string[], after: readonly string[]): Permission[] {
  const kept = new Set(expandGrants(after));
  return expandGrants(before).filter((permission) => !kept.has(permission));
}

