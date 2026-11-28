import { adminRoleCatalog, type AdminRoleRow, type Pool } from '@app/db';
import { PERMISSION_GRANT, expandGrants, grantsAllow, isKnownGrant, type Permission } from '@app/shared';
import type { FastifyBaseLogger } from 'fastify';

/**
 * The admin roles and their grants (`admin_roles`, `admin_role_permissions`)
 * in process memory: a permission check costs no statement. One statement
 * loads them when the app is ready and after every configuration change
 * (`cfg:changed`, which the role editor announces too); until the first
 * load succeeds a check refuses (the caller answers 503), so a database
 * outage at start never opens a route.
 *
 * A load asked for while one runs is run again once it ends (the running
 * one may have read the rows before the change that asked); a failed load
 * keeps the last copy and is tried again, 0.5 s doubling to 30 s, until one
 * succeeds. The catalogue remembers the configuration version it was loaded
 * for, which the process report shows next to the settings version.
 */

export interface AdminRole {
  id: number;
  key: string;
  names: Record<string, string>;
  grants: readonly string[];
  permissions: readonly Permission[];
}

export interface AdminRoleCatalogState {
  /** When the roles in memory were loaded (null: never). */
  loadedAtMs: number | null;
  /** The configuration version they were loaded for (null: not known). */
  version: number | null;
  /** The last load failed; it is being tried again. */
  failing: boolean;
}

const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 30_000;

export class AdminRoleCatalog {
  private roles: ReadonlyMap<string, AdminRole> | null = null;
  private loading: Promise<void> | null = null;
  /** The one load that runs after the current one (asked for while it ran). */
  private queued: Promise<void> | null = null;
  /** The highest version asked for while a load ran. */
  private wanted: number | null = null;
  private loadedAtMs: number | null = null;
  private loadedVersion: number | null = null;
  private failures = 0;
  private retry: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly listeners: ((state: AdminRoleCatalogState) => void)[] = [];
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

  state(): AdminRoleCatalogState {
    return { loadedAtMs: this.loadedAtMs, version: this.loadedVersion, failing: this.failures > 0 };
  }

  /** Called after every successful load (the process report follows it). */
  onLoaded(listener: (state: AdminRoleCatalogState) => void): void {
    this.listeners.push(listener);
  }

  /** Replaces the roles (tests, and the loader). */
  set(rows: readonly AdminRoleRow[]): void {
    const roles = new Map<string, AdminRole>();
    for (const row of rows) {
      const grants = row.grants.filter((grant) => {
        const known = PERMISSION_GRANT.test(grant) && isKnownGrant(grant);
        if (!known) this.log.warn({ role: row.key, grant }, 'admin roles: a grant this build does not know is ignored');
        return known;
      });
      roles.set(row.key, { id: row.id, key: row.key, names: row.names, grants, permissions: expandGrants(grants) });
    }
    this.roles = roles;
  }

  /**
   * Loads the roles (for the configuration `version`, when known); see the
   * module comment. Asked for while a load runs, it resolves after the one
   * more load that follows it, which reads what was committed before the
   * call.
   */
  reload(version?: number | null): Promise<void> {
    if (version !== undefined && version !== null) this.wanted = Math.max(this.wanted ?? 0, version);
    if (this.loading) {
      this.queued ??= this.loading.then(() => {
        this.queued = null;
        return this.stopped ? undefined : this.reload();
      });
      return this.queued;
    }
    const target = this.wanted;
    this.loading = adminRoleCatalog(this.pool)
      .then((rows) => {
        this.set(rows);
        this.loadedAtMs = Date.now();
        if (target !== null) this.loadedVersion = Math.max(this.loadedVersion ?? 0, target);
        this.failures = 0;
        this.log.debug({ roles: rows.length, version: this.loadedVersion }, 'admin roles loaded');
        const state = this.state();
        for (const listener of this.listeners) {
          try {
            listener(state);
          } catch (error) {
            this.log.error({ err: error }, 'admin roles: a listener failed');
          }
        }
      })
      .catch((error: unknown) => {
        this.failures += 1;
        this.log.error({ err: error, failures: this.failures }, 'admin roles: load failed; the last copy stays and the load is tried again');
        this.scheduleRetry();
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  /** Stops the retry timer (app close). */
  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retry) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(this.failures - 1, 6));
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.reload();
    }, delay);
    this.retry.unref();
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

  /** The grants `roles` hold together (as stored and known to this build). */
  grantsOf(roles: readonly string[]): string[] {
    const known = this.roles;
    if (!known) return [];
    return [...new Set(roles.flatMap((key) => [...(known.get(key)?.grants ?? [])]))];
  }
}
