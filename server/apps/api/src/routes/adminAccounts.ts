import {
  adminAccount,
  adminAccountForUpdate,
  adminAccounts,
  adminActiveOwners,
  adminCreate,
  adminRevokeSessions,
  adminSetState,
  adminUpdate,
  type AdminAccountRow,
  type PoolClient,
} from '@app/db';
import {
  OWNER_ROLE,
  adminAccountSchema,
  adminCreateRequestSchema,
  adminCreatedSchema,
  adminIdSchema,
  adminListSchema,
  adminPasswordResetSchema,
  adminRevokeReason,
  adminRoleListSchema,
  adminUpdateRequestSchema,
  decodeCursor,
  encodeCursor,
  pageQuerySchema,
  type AdminRevokeReason,
  type Permission,
} from '@app/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { adminWrite, type AuditTrail } from '../admin/audit.js';
import { generatePassword } from '../admin/password.js';
import { denyAdminSessions } from '../admin/session.js';
import { HttpProblem } from '../lib/problem.js';
import { accountView, adminIdOf, passwordRefusal } from './adminAuth.js';

/**
 * Management of admin accounts by the owner role (`admins.read`, `admins.manage`:
 * restricted permissions, so only the owner role's `*` holds them unless a
 * role is granted them by name) and the role list:
 *
 *   GET   /v1/admin/admins                     page by id
 *   POST  /v1/admin/admins                     create (a password is made when none is given, answered once)
 *   PATCH /v1/admin/admins/:id                 display name, roles
 *   POST  /v1/admin/admins/:id/disable|enable
 *   POST  /v1/admin/admins/:id/reset-totp      enrols again at the next sign-in
 *   POST  /v1/admin/admins/:id/reset-password  a new password, answered once
 *   GET   /v1/admin/roles                      roles, grants, permissions (memory)
 *
 * `admins.manage` never reaches past the caller's own access: every role
 * a write gives (create, a role change) and every account it changes (its
 * roles as they are) must grant only permissions the caller's roles grant
 * too. A role granted `admins.manage` by name therefore manages the accounts
 * below it, never an owner's (no reset of an owner's password or TOTP, no
 * owner role given, no account made with more than the caller has).
 *
 * Each write locks the account's row, keeps at least one enabled owner,
 * writes its audit row (before/after) in its transaction, and signs the
 * account out everywhere when its access changes (roles, disable, TOTP,
 * password): the sessions are revoked and their access tokens denied at
 * once. An admin changes none of this on their own account here (the
 * `/v1/admin/me` routes, or the bootstrap tool for a locked-out owner).
 */

const idParams = z.object({ id: adminIdSchema });

const cursorKey = z.object({ id: z.number().int().positive() });

function readCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const key = decodeCursor(cursorKey, cursor);
  if (key === null) {
    throw new HttpProblem('validation_failed', { detail: 'The cursor is not valid.', errors: [{ in: 'query', pointer: '/cursor', code: 'invalid', message: 'not a cursor of this list' }] });
  }
  return key.id;
}

function notSelf(request: FastifyRequest, targetId: number): void {
  if (adminIdOf(request) === targetId) {
    throw new HttpProblem('conflict', { detail: 'Change your own account from your profile, not from the admin list.' });
  }
}


/** Refuses a change that would leave no enabled owner (the rows stay locked until the transaction ends). */
async function keepAnOwner(tx: PoolClient, target: AdminAccountRow, losesOwner: boolean): Promise<void> {
  if (!losesOwner || !target.roles.includes(OWNER_ROLE) || target.disabledAtMs !== null) return;
  const owners = await adminActiveOwners(tx, OWNER_ROLE);
  if (!owners.some((id) => id !== Number(target.id))) {
    throw new HttpProblem('conflict', { detail: 'At least one enabled owner must remain.' });
  }
}

async function signOutEverywhere(tx: PoolClient, targetId: number, reason: AdminRevokeReason): Promise<string[]> {
  return adminRevokeSessions(tx, { adminId: targetId }, adminRevokeReason.code(reason));
}

function snapshot(row: AdminAccountRow) {
  return { displayName: row.displayName, roles: row.roles, disabled: row.disabledAtMs !== null, totpEnabled: row.totpEnabled };
}

async function after(tx: PoolClient, trail: AuditTrail, action: string, before: AdminAccountRow, extra: Record<string, unknown> = {}): Promise<AdminAccountRow> {
  const row = await adminAccount(tx, Number(before.id));
  if (!row) throw new Error('admin: the account vanished inside its own transaction');
  trail.record({ action, target: 'admin', targetId: before.id, detail: { before: snapshot(before), after: snapshot(row), ...extra } });
  return row;
}

export const adminAccountRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = app.requirePermission('admins.read');
  const manage = app.requirePermission('admins.manage');
  const tags = ['admin'];

  /** The permissions `roles` grant beyond what the request's admin holds (roles in memory, as the guard reads them). */
  function beyondCaller(request: FastifyRequest, roles: readonly string[]): Permission[] {
    const own = new Set(app.adminAuth.roles.permissionsOf(request.principal?.kind === 'admin' ? request.principal.roles : []));
    return app.adminAuth.roles.permissionsOf(roles).filter((permission) => !own.has(permission));
  }

  /** Refuses roles to give that grant more than the caller holds. */
  function mayGive(request: FastifyRequest, roles: readonly string[]): void {
    const beyond = beyondCaller(request, roles);
    if (beyond.length > 0) {
      throw new HttpProblem('forbidden', { detail: `You may give only access you hold yourself; these roles also grant ${beyond.join(', ')}.` });
    }
  }

  /** The account, locked; refused when its roles grant more than the caller holds. */
  async function lockTarget(tx: PoolClient, request: FastifyRequest, targetId: number): Promise<AdminAccountRow> {
    const row = await adminAccountForUpdate(tx, targetId);
    if (!row) throw new HttpProblem('not_found', { detail: 'No such admin.' });
    if (beyondCaller(request, row.roles).length > 0) {
      throw new HttpProblem('forbidden', { detail: 'This account has access your roles do not grant: only an admin holding all of it may change it.' });
    }
    return row;
  }

  function checkRoles(roles: readonly string[], pointer: string): string[] {
    const known = app.adminAuth.roles.current();
    if (!known) throw new HttpProblem('service_unavailable', { detail: 'The admin roles are not loaded yet.', headers: { 'retry-after': '5' } });
    const unique = [...new Set(roles)];
    const unknown = unique.filter((key) => !known.has(key));
    if (unknown.length > 0) {
      const message = `Unknown role: ${unknown.join(', ')}.`;
      throw new HttpProblem('field_invalid', { detail: message, errors: [{ in: 'body', pointer, code: 'unknown_role', message }] });
    }
    // In role id order, as the account view lists them.
    return unique.sort((a, b) => (known.get(a)?.id ?? 0) - (known.get(b)?.id ?? 0));
  }

  app.get(
    '/v1/admin/admins',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'Admin accounts, by id', querystring: pageQuerySchema, response: { 200: adminListSchema } },
    },
    async (request) => {
      const afterId = readCursor(request.query.cursor);
      const limit = request.query.limit;
      const rows = await adminAccounts(app.pg, { afterId, limit: limit + 1 });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return { items: page.map(accountView), nextCursor: rows.length > limit && last ? encodeCursor({ id: Number(last.id) }) : null };
    },
  );

  app.post(
    '/v1/admin/admins',
    {
      preHandler: manage,
      config: { pgBudget: 3 },
      schema: { tags, summary: 'Create an admin', body: adminCreateRequestSchema, response: { 201: adminCreatedSchema } },
    },
    async (request, reply) => {
      const body = request.body;
      const roles = checkRoles(body.roles, '/roles');
      mayGive(request, roles);
      const generated = body.password === undefined ? generatePassword() : null;
      const password = body.password ?? generated!;
      const refusal = passwordRefusal(password, body.email, '/password');
      if (refusal) throw refusal;
      const hash = await app.adminAuth.passwords.hash(password);
      const createdBy = adminIdOf(request);
      const row = await adminWrite(app, request, async (tx, trail) => {
        const id = await adminCreate(tx, { email: body.email, displayName: body.displayName, passwordHash: hash, roles, createdBy });
        if (id === null) throw new HttpProblem('conflict', { detail: 'An admin with this e-mail exists.' });
        const created = await adminAccount(tx, id);
        if (!created) throw new Error('admin: the new account is not readable');
        trail.record({ action: 'admin.create', target: 'admin', targetId: id, detail: { after: snapshot(created), email: created.email, passwordGenerated: generated !== null } });
        return created;
      });
      request.log.info({ adminId: row.id, roles }, 'admin created');
      return reply.code(201).send({ admin: accountView(row), ...(generated ? { initialPassword: generated } : {}) });
    },
  );

  app.patch(
    '/v1/admin/admins/:id',
    {
      preHandler: manage,
      config: { pgBudget: 6 },
      schema: { tags, summary: "Change an admin's display name or roles", params: idParams, body: adminUpdateRequestSchema, response: { 200: adminAccountSchema } },
    },
    async (request) => {
      const targetId = Number(request.params.id);
      const roles = request.body.roles === undefined ? undefined : checkRoles(request.body.roles, '/roles');
      if (roles !== undefined) {
        notSelf(request, targetId);
        mayGive(request, roles);
      }
      const { row, revoked } = await adminWrite(app, request, async (tx, trail) => {
        const before = await lockTarget(tx, request, targetId);
        const rolesChange = roles !== undefined && JSON.stringify(roles) !== JSON.stringify(before.roles);
        const nameChange = request.body.displayName !== undefined && request.body.displayName !== before.displayName;
        if (!rolesChange && !nameChange) {
          trail.unchanged();
          return { row: before, revoked: [] as string[] };
        }
        if (rolesChange) await keepAnOwner(tx, before, !roles.includes(OWNER_ROLE));
        await adminUpdate(tx, targetId, { displayName: nameChange ? request.body.displayName : undefined, roles: rolesChange ? roles : undefined });
        const ids = rolesChange ? await signOutEverywhere(tx, targetId, 'owner') : [];
        return { row: await after(tx, trail, 'admin.update', before, { signedOutSessions: ids.length }), revoked: ids };
      });
      await denyAdminSessions(app, request, revoked);
      return accountView(row);
    },
  );

  app.post(
    '/v1/admin/admins/:id/disable',
    {
      preHandler: manage,
      config: { pgBudget: 6 },
      schema: { tags, summary: 'Disable an admin (signs them out everywhere)', params: idParams, response: { 200: adminAccountSchema } },
    },
    async (request) => {
      const targetId = Number(request.params.id);
      notSelf(request, targetId);
      const { row, revoked } = await adminWrite(app, request, async (tx, trail) => {
        const before = await lockTarget(tx, request, targetId);
        if (before.disabledAtMs !== null) {
          trail.unchanged();
          return { row: before, revoked: [] as string[] };
        }
        await keepAnOwner(tx, before, true);
        await adminSetState(tx, targetId, { disabled: true });
        const ids = await signOutEverywhere(tx, targetId, 'disabled');
        return { row: await after(tx, trail, 'admin.disable', before, { signedOutSessions: ids.length }), revoked: ids };
      });
      await denyAdminSessions(app, request, revoked);
      return accountView(row);
    },
  );

  app.post(
    '/v1/admin/admins/:id/enable',
    {
      preHandler: manage,
      config: { pgBudget: 4 },
      schema: { tags, summary: 'Enable a disabled admin (and clear a lock)', params: idParams, response: { 200: adminAccountSchema } },
    },
    async (request) => {
      const targetId = Number(request.params.id);
      notSelf(request, targetId);
      const row = await adminWrite(app, request, async (tx, trail) => {
        const before = await lockTarget(tx, request, targetId);
        if (before.disabledAtMs === null && before.lockedUntilMs === null) {
          trail.unchanged();
          return before;
        }
        await adminSetState(tx, targetId, { disabled: false, unlock: true });
        return after(tx, trail, 'admin.enable', before);
      });
      return accountView(row);
    },
  );

  app.post(
    '/v1/admin/admins/:id/reset-totp',
    {
      preHandler: manage,
      config: { pgBudget: 5 },
      schema: { tags, summary: "Forget an admin's TOTP: they enrol again at the next sign-in", params: idParams, response: { 200: adminAccountSchema } },
    },
    async (request) => {
      const targetId = Number(request.params.id);
      notSelf(request, targetId);
      const { row, revoked } = await adminWrite(app, request, async (tx, trail) => {
        const before = await lockTarget(tx, request, targetId);
        await adminSetState(tx, targetId, { resetTotp: true });
        const ids = await signOutEverywhere(tx, targetId, 'totp_reset');
        return { row: await after(tx, trail, 'admin.totp_reset', before, { signedOutSessions: ids.length }), revoked: ids };
      });
      await denyAdminSessions(app, request, revoked);
      return accountView(row);
    },
  );

  app.post(
    '/v1/admin/admins/:id/reset-password',
    {
      preHandler: manage,
      config: { pgBudget: 5 },
      schema: { tags, summary: 'A new password for an admin, answered once (and the lock cleared)', params: idParams, response: { 200: adminPasswordResetSchema } },
    },
    async (request) => {
      const targetId = Number(request.params.id);
      notSelf(request, targetId);
      const password = generatePassword();
      const hash = await app.adminAuth.passwords.hash(password);
      const { row, revoked } = await adminWrite(app, request, async (tx, trail) => {
        const before = await lockTarget(tx, request, targetId);
        await adminSetState(tx, targetId, { passwordHash: hash, unlock: true });
        const ids = await signOutEverywhere(tx, targetId, 'password_changed');
        return { row: await after(tx, trail, 'admin.password_reset', before, { signedOutSessions: ids.length }), revoked: ids };
      });
      await denyAdminSessions(app, request, revoked);
      return { admin: accountView(row), initialPassword: password };
    },
  );

  app.get(
    '/v1/admin/roles',
    {
      preHandler: read,
      config: { pgBudget: 0 },
      schema: { tags, summary: 'The admin roles, their grants and the permissions they cover', response: { 200: adminRoleListSchema } },
    },
    async () => {
      const known = app.adminAuth.roles.current();
      if (!known) throw new HttpProblem('service_unavailable', { detail: 'The admin roles are not loaded yet.', headers: { 'retry-after': '5' } });
      return { items: [...known.values()].map((role) => ({ key: role.key, names: role.names, grants: [...role.grants], permissions: [...role.permissions] })) };
    },
  );
};
