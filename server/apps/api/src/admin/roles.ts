import { adminRoleCatalog, type AdminRoleRow, type Pool } from '@app/db';
import { PERMISSION_GRANT, expandGrants, grantsAllow, isPermission, type Permission } from '@app/shared';
import type { FastifyBaseLogger } from 'fastify';

/**
 * The admin roles and their grants (`admin_roles`, `admin_role_permissions`)
 * in process memory: a permission check costs no statement. One statement
 * loads them when the app is ready and after every configuration change
 * (`cfg:changed`); until the first load succeeds a check refuses (the
 * caller answers 503), so a database outage at start never opens a route.
 */

export interface AdminRole {
  id: number;
  key: string;
  names: Record<string, string>;
  grants: readonly string[];
  permissions: readonly Permission[];
}

export class AdminRoleCatalog {
  private roles: ReadonlyMap<string, AdminRole> | null = null;
  private loading: Promise<void> | null = null;
  private readonly pool: Pool;
  private readonly log: FastifyBaseLogger;

  constructor(options: { pool: Pool; log: FastifyBaseLogger }) {
    this.pool = options.pool;
    this.log = options.log;
  }

  /** The roles by key; null until the first load. */
  current(): ReadonlyMap<string, AdminRole> | null {
    return this.roles;
  }

  /** Replaces the roles (tests, and the loader). */
  set(rows: readonly AdminRoleRow[]): void {
    const roles = new Map<string, AdminRole>();
    for (const row of rows) {
      const grants = row.grants.filter((grant) => {
        const known = PERMISSION_GRANT.test(grant) && (grant === '*' || grant.endsWith('.*') || isPermission(grant));
        if (!known) this.log.warn({ role: row.key, grant }, 'admin roles: a grant this build does not know is ignored');
        return known;
      });
      roles.set(row.key, { id: row.id, key: row.key, names: row.names, grants, permissions: expandGrants(grants) });
    }
    this.roles = roles;
  }

  async reload(): Promise<void> {
    this.loading ??= adminRoleCatalog(this.pool)
      .then((rows) => {
        this.set(rows);
        this.log.debug({ roles: rows.length }, 'admin roles loaded');
      })
      .catch((error: unknown) => this.log.error({ err: error }, 'admin roles: load failed; the last copy stays'))
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  /** Whether `roles` grant `permission`; null while nothing is loaded. */
  allows(roles: readonly string[], permission: Permission): boolean | null {
    const known = this.roles;
    if (!known) return null;
    return roles.some((key) => {
      const role = known.get(key);
      return role !== undefined && grantsAllow(role.grants, permission);
    });
  }

  /** Every permission `roles` grant together. */
  permissionsOf(roles: readonly string[]): Permission[] {
    const known = this.roles;
    if (!known) return [];
    return expandGrants(roles.flatMap((key) => [...(known.get(key)?.grants ?? [])]));
  }
}
