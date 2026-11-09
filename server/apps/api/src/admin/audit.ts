import { insertAuditRows, withTransaction, type AuditRow, type PoolClient, type TransactionOptions } from '@app/db';
import { auditTarget, type AuditTarget } from '@app/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nextId } from '../auth/sessions.js';

/**
 * The audit writer of admin writes. A route runs its change through
 * {@link adminWrite}: the body gets the transaction and a trail, records
 * what it did (`trail.record({ action, target, targetId, detail })`), and
 * the rows are inserted in the same transaction just before COMMIT. A body
 * that records nothing is refused (the transaction rolls back) unless it
 * says it changed nothing (`trail.unchanged()`), and a row
 * that cannot be written rolls the change back with it: there is never a
 * change without its row, nor a row without its change.
 *
 * `detail` carries the before/after of what changed and never a secret
 * (a sealed value or a password, not even hashed).
 */

export interface AuditEntry {
  /** `area.verb` (`admin.disable`, `plan.update`). */
  action: string;
  target: AuditTarget;
  /** The row the action is about (decimal id), if any. */
  targetId?: string | number | null | undefined;
  detail?: Record<string, unknown> | null | undefined;
}

/** Who acts: an admin and their session (null: the system), and from where. */
export interface AdminActor {
  adminId: number | null;
  sessionId: string | null;
  ip: string | null;
}

export class AuditTrail {
  readonly rows: AuditRow[] = [];
  private actor: AdminActor;
  private readonly mintId: () => string | null;
  private nothingChanged = false;

  constructor(actor: AdminActor, mintId: () => string | null) {
    this.actor = actor;
    this.mintId = mintId;
  }

  /** The acting admin, once the write itself found out who it is (a sign-out by refresh cookie). */
  actAs(adminId: number): void {
    this.actor = { ...this.actor, adminId };
  }

  /** The write found nothing to change (its statements matched no row): no audit row is due. */
  unchanged(): void {
    this.nothingChanged = true;
  }

  get empty(): boolean {
    return this.nothingChanged && this.rows.length === 0;
  }

  record(entry: AuditEntry): void {
    this.rows.push({
      id: this.mintId(),
      adminId: this.actor.adminId,
      sessionId: this.actor.sessionId,
      ip: this.actor.ip,
      targetType: auditTarget.code(entry.target),
      targetId: entry.targetId === undefined || entry.targetId === null ? null : String(entry.targetId),
      action: entry.action,
      detail: entry.detail ?? null,
    });
  }
}

export class UnauditedWriteError extends Error {
  constructor() {
    super('an admin write must record its audit row');
    this.name = 'UnauditedWriteError';
  }
}

const ADMIN_ID = /^[1-9][0-9]{0,9}$/;
const SESSION_ID = /^[1-9][0-9]{0,18}$/;

/** The admin acting on `request` (its access token), or the system when it carries none. */
export function actorOf(request: FastifyRequest): AdminActor {
  const principal = request.principal;
  const admin = principal?.kind === 'admin' ? principal : null;
  return {
    adminId: admin && ADMIN_ID.test(admin.subject) ? Number(admin.subject) : null,
    sessionId: admin && SESSION_ID.test(admin.sessionId) ? admin.sessionId : null,
    ip: request.clientIp,
  };
}

/** Runs `body` in a transaction whose audit rows `actor` signs; see the module comment. */
export async function auditedTransaction<T>(
  app: FastifyInstance,
  actor: AdminActor,
  body: (tx: PoolClient, trail: AuditTrail) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  return withTransaction(
    app.pg,
    async (tx) => {
      const trail = new AuditTrail(actor, () => nextId(app));
      const result = await body(tx, trail);
      if (trail.empty) return result;
      if (trail.rows.length === 0) throw new UnauditedWriteError();
      await insertAuditRows(tx, trail.rows);
      return result;
    },
    options,
  );
}

/** {@link auditedTransaction} as the admin of `request`. */
export async function adminWrite<T>(
  app: FastifyInstance,
  request: FastifyRequest,
  body: (tx: PoolClient, trail: AuditTrail) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  return auditedTransaction(app, actorOf(request), body, options);
}
