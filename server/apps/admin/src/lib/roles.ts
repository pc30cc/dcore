import {
  OWNER_ROLE,
  expandGrants,
  isPermission,
  isRestrictedPermission,
  permissionAreas,
  permissions,
  type AdminMe,
  type AdminRoleHolders,
  type AdminRoleUpdated,
  type Permission,
} from '@app/shared';
import { useQuery } from '@tanstack/react-query';
import { hasMessage, type Translate } from '@/i18n/translate';
import { apiRequest } from './api';
import { queryClient, queryKeys, type AdminRole } from './queries';

/**
 * The role editor's reads and writes (`/v1/admin/roles/*`) and its rules,
 * the server's own (`admin/grants.ts`) drawn as boxes the editor may or may
 * not tick: `users.chats` on the admin role only and the analyst on
 * dashboards only, for everyone; a box or an area the editor does not hold
 * is not theirs to give; only the owner role gives or takes a restricted
 * permission. A role the editor holds, the owner role and a role beyond the
 * editor's access are not edited at all.
 */

/** The role users.chats is held by, and the one that reads dashboards only (the server's rules). */
export const CHATS_ROLE = 'admin';
export const ANALYST_ROLE = 'analyst';
const CHATS: Permission = 'users.chats';

export const roleKeys = {
  holders: ['roles', 'holders'] as const,
};

/** Enabled admins per role (one statement), read with the roles page. */
export function useRoleHolders(enabled = true) {
  return useQuery({
    queryKey: roleKeys.holders,
    enabled,
    staleTime: 60_000,
    queryFn: ({ signal }) => apiRequest<AdminRoleHolders>('/v1/admin/roles/holders', { signal }),
  });
}

/** Saves a role's grants; `base` is its grants as the editor read them (a different stored set answers 409 `role_changed`). */
export function saveRolePermissions(key: string, grants: readonly string[], base: readonly string[]): Promise<AdminRoleUpdated> {
  return apiRequest<AdminRoleUpdated>(`/v1/admin/roles/${encodeURIComponent(key)}/permissions`, { method: 'PUT', body: { grants, base } });
}

/**
 * A role as the save answered it, in the roles the panel holds (another
 * read right away could still be the answering process's older copy).
 */
export function storeRole(role: AdminRole): void {
  queryClient.setQueryData<{ items: AdminRole[] }>(queryKeys.roles, (list) => (list ? { items: list.items.map((held) => (held.key === role.key ? role : held)) } : list));
  void queryClient.invalidateQueries({ queryKey: roleKeys.holders });
}

// ─── Rules ──────────────────────────────────────────────────────────────────

const areaOf = (permission: string) => permission.slice(0, permission.indexOf('.'));

/** The grants of the roles an admin holds (`*` for the owner). */
export function callerGrants(roles: readonly AdminRole[], me: Pick<AdminMe, 'roles'> | null): string[] {
  if (!me) return [];
  return [...new Set(roles.filter((role) => me.roles.includes(role.key)).flatMap((role) => role.grants))];
}

export interface RoleStanding {
  /** The owner role, or a role holding `*`: never edited. */
  owner: boolean;
  /** The signed-in admin holds it: another admin must change it. */
  yours: boolean;
  /** It holds access the editor does not (a permission, or a wildcard they do not hold themselves). */
  beyond: boolean;
}

export function roleStanding(role: Pick<AdminRole, 'key' | 'grants'>, me: Pick<AdminMe, 'roles'> | null, grants: readonly string[]): RoleStanding {
  const owner = role.key === OWNER_ROLE || role.grants.includes('*');
  const yours = me?.roles.includes(role.key) ?? false;
  let beyond = false;
  if (!owner && !grants.includes('*')) {
    const held = new Set(expandGrants(grants));
    beyond = expandGrants(role.grants).some((permission) => !held.has(permission)) || role.grants.some((grant) => grant.endsWith('.*') && !grants.includes(grant));
  }
  return { owner, yours, beyond };
}

export interface EditorArea {
  area: string;
  permissions: readonly Permission[];
  /** `area.*` covers some of them (an area of restricted permissions only has no switch). */
  wildcard: boolean;
}

/** An area's name in the panel's language (its code for one this build has no words for). */
export function areaLabel(area: string, t: Translate): string {
  const key = `permissionArea.${area}`;
  return hasMessage(key) ? t(key) : area;
}

/** The catalogue's areas in its order, each with its permissions. */
export function editorAreas(): EditorArea[] {
  return permissionAreas.map((area) => {
    const list = permissions.filter((permission) => areaOf(permission) === area);
    return { area, permissions: list, wildcard: list.some((permission) => !isRestrictedPermission(permission)) };
  });
}

/** What the editor has ticked: the areas whose switch is on, and the boxes ticked one by one. */
export interface EditorState {
  areas: ReadonlySet<string>;
  exact: ReadonlySet<Permission>;
}

/** A role's grants as the editor's boxes. */
export function editorState(grants: readonly string[]): EditorState {
  const areas = new Set<string>();
  const exact = new Set<Permission>();
  for (const grant of grants) {
    if (grant.endsWith('.*')) areas.add(grant.slice(0, -2));
    else if (isPermission(grant)) exact.add(grant);
  }
  return { areas, exact };
}

/** The grants the boxes stand for, as the server keeps them: area wildcards, and the boxes no switch covers (restricted ones always), sorted. */
export function toGrants(state: EditorState): string[] {
  const wildcards = [...state.areas].map((area) => `${area}.*`);
  const exact = [...state.exact].filter((permission) => isRestrictedPermission(permission) || !state.areas.has(areaOf(permission)));
  return [...wildcards, ...exact].sort();
}

/** The permissions a change adds and takes away (expanded). */
export function grantsChange(before: readonly string[], after: readonly string[]): { added: Permission[]; removed: Permission[] } {
  const was = new Set(expandGrants(before));
  const now = new Set(expandGrants(after));
  return { added: [...now].filter((permission) => !was.has(permission)), removed: [...was].filter((permission) => !now.has(permission)) };
}

/** Why a box or a switch cannot be changed. */
export type BoxBlock = 'area' | 'adminOnly' | 'dashboardsOnly' | 'ownerOnly' | 'notHeld';

export interface BoxView {
  checked: boolean;
  disabled: boolean;
  block: BoxBlock | null;
}

/** Whether a role may hold a permission at all (users.chats on the admin role only, the analyst dashboards only). */
function ruleBlock(role: string, permission: Permission): BoxBlock | null {
  if (permission === CHATS && role !== CHATS_ROLE) return 'adminOnly';
  if (role === ANALYST_ROLE && areaOf(permission) !== 'dashboard') return 'dashboardsOnly';
  return null;
}

/** One permission's box for an editor holding `grants`. */
export function permissionBox(state: EditorState, role: string, grants: readonly string[], permission: Permission): BoxView {
  const restricted = isRestrictedPermission(permission);
  if (!restricted && state.areas.has(areaOf(permission))) return { checked: true, disabled: true, block: 'area' };
  const checked = state.exact.has(permission);
  const owner = grants.includes('*');
  const rule = ruleBlock(role, permission);
  // A box ticked against the rules (written by hand) may still be cleared.
  if (rule && !checked) return { checked, disabled: true, block: rule };
  if (restricted && !owner) return { checked, disabled: true, block: 'ownerOnly' };
  if (!owner && !expandGrants(grants).includes(permission)) return { checked, disabled: true, block: 'notHeld' };
  return { checked, disabled: false, block: null };
}

/** An area's "All of this area" switch (`area.*`): only an editor holding that wildcard (or `*`) turns it on or off. */
export function areaSwitch(state: EditorState, role: string, grants: readonly string[], area: string): BoxView {
  const checked = state.areas.has(area);
  if (role === ANALYST_ROLE && area !== 'dashboard' && !checked) return { checked, disabled: true, block: 'dashboardsOnly' };
  if (!grants.includes('*') && !grants.includes(`${area}.*`)) return { checked, disabled: true, block: 'notHeld' };
  return { checked, disabled: false, block: null };
}

/**
 * The general reason some boxes of an area cannot change, said once beside
 * the area (the greyed boxes point to it) instead of under each box: not the
 * editor's to give, or dashboards only (the analyst). Null when no box or
 * switch of the area is blocked for such a reason; a reason of one box alone
 * (owner only, admin role only) stays under that box.
 */
export function areaNote(state: EditorState, role: string, grants: readonly string[], area: EditorArea): 'notHeld' | 'dashboardsOnly' | null {
  const blocks = area.permissions.map((permission) => permissionBox(state, role, grants, permission).block);
  if (area.wildcard) blocks.push(areaSwitch(state, role, grants, area.area).block);
  if (blocks.includes('dashboardsOnly')) return 'dashboardsOnly';
  if (blocks.includes('notHeld')) return 'notHeld';
  return null;
}

/** The state with one box ticked or cleared. */
export function withPermission(state: EditorState, permission: Permission, on: boolean): EditorState {
  const exact = new Set(state.exact);
  if (on) exact.add(permission);
  else exact.delete(permission);
  return { areas: state.areas, exact };
}

/** The state with an area's switch turned on or off (the boxes ticked one by one stay as they were under it). */
export function withArea(state: EditorState, area: string, on: boolean): EditorState {
  const areas = new Set(state.areas);
  if (on) areas.add(area);
  else areas.delete(area);
  return { areas, exact: state.exact };
}

/** Whether two grant lists are the same set. */
export function sameGrants(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((grant) => right.has(grant));
}
