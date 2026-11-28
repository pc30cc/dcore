import { adminRevokeRoleHolderSessions, adminRoleForUpdate, adminRoleHolders, adminRoleSetGrants } from '@app/db';
import {
  PERMISSION_GRANT,
  adminRevokeReason,
  adminRoleHoldersSchema,
  adminRoleParamsSchema,
  adminRoleUpdateSchema,
  adminRoleUpdatedSchema,
  expandGrants,
  isKnownGrant,
} from '@app/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { adminWrite } from '../admin/audit.js';
import { afterCommit } from '../admin/effects.js';
import { checkRoleEdit, checkRoleRules, isOwnerLike, normalizeGrants, removedPermissions, type GrantIssue } from '../admin/grants.js';
import { adminConflict, adminForbidden, fieldInvalid } from '../admin/problems.js';
import { denyAdminSessionsOrThrow } from '../admin/session.js';
import { HttpProblem } from '../lib/problem.js';
import { adminIdOf } from './adminAuth.js';

/**
 * The role editor (`admins.read` and `admins.manage`, held by the owner role:
 * restricted; edits also need a session opened with the second factor while
 * the deployment requires one):
 *
 *   GET /v1/admin/roles/holders            enabled admins per role (1 statement)
 *   PUT /v1/admin/roles/:key/permissions   a role's grants, all of them (≤ 5 statements)
 *
 * Roles are edited, never made, renamed or deleted here. The owner role (and
 * any role holding `*`) never changes; nobody edits a role they hold; the
 * rules of `admin/grants.ts` keep every edit within the editor's access and
 * users.chats on the admin role, the analyst on dashboards (the database
 * keeps those rules too). Taking access away from a role is refused to an
 * editor without `*` while any holder of the role has access beyond the
 * editor's (403 `beyond_holders`), as the admins page refuses to change such
 * an account. A save whose `base` is not the stored set is refused (409
 * `role_changed`): someone changed the role meanwhile. Grants a newer build
 * wrote, unknown here, are kept as they are.
 *
 * Taking any permission away signs every holder out at once: their sessions
 * end in the same transaction and their access tokens are denied after the
 * commit, so no API process accepts the old access even before it reloads
 * the roles (a marker not written answers `sideEffects: 'failed'`: those
 * tokens keep working until the processes reload). Then the change is announced (`cfg:changed`): every process
 * reloads its roles within seconds (the minute `cfg:v` poll catches a
 * missed message). The answer is built from what was written.
 */

const tags = ['admin'];

const RULE_HINTS = new Set(['owner_role', 'owner_grant', 'chats_admin_only', 'analyst_dashboards_only']);

function issueProblem(issue: GrantIssue): HttpProblem {
  const messages: Record<GrantIssue['code'], string> = {
    owner_grant: "'*' belongs to the owner role only.",
    unknown_permission: 'This build does not know this grant.',
    chats_admin_only: 'users.chats is held by the admin role only.',
    analyst_dashboards_only: 'The analyst role holds dashboard permissions only.',
  };
  return fieldInvalid(issue.pointer, issue.code, messages[issue.code]);
}

/** The database's role rules, refused as the route would have refused them (a rule the checks above missed). */
function ruleRefusal(error: unknown): never {
  const e = error as { code?: unknown; hint?: unknown };
  if (e?.code === '23514' && typeof e.hint === 'string' && RULE_HINTS.has(e.hint)) {
    if (e.hint === 'owner_role') throw adminForbidden('owner_role', 'The owner role never changes.');
    throw issueProblem({ pointer: '/grants', code: e.hint as GrantIssue['code'] });
  }
  throw error;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((grant) => right.has(grant));
}

export const adminRoleRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = app.requirePermission('admins.read');
  const manage = [app.requirePermission('admins.manage'), app.requireMfa];

  function loadedRoles() {
    const known = app.adminAuth.roles.current();
    if (!known) throw new HttpProblem('service_unavailable', { detail: 'The admin roles are not loaded yet.', headers: { 'retry-after': '5' } });
    return known;
  }

  const callerRoles = (request: FastifyRequest): readonly string[] => (request.principal?.kind === 'admin' ? request.principal.roles : []);

  app.get(
    '/v1/admin/roles/holders',
    {
      preHandler: read,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'How many enabled admins hold each role', response: { 200: adminRoleHoldersSchema } },
    },
    async (_request, reply) => {
      const items = await adminRoleHolders(app.pg);
      return reply.header('cache-control', 'no-store').send({ items });
    },
  );

  app.put(
    '/v1/admin/roles/:key/permissions',
    {
      preHandler: manage,
      config: { pgBudget: 5 },
      schema: { tags, summary: "Set a role's grants (the owner role never changes)", params: adminRoleParamsSchema, body: adminRoleUpdateSchema, response: { 200: adminRoleUpdatedSchema } },
    },
    async (request) => {
      const { key } = request.params;
      const known = loadedRoles();
      const role = known.get(key);
      if (!role) throw new HttpProblem('not_found', { detail: 'No such role.' });
      if (isOwnerLike(key, role.grants)) throw adminForbidden('owner_role', 'The owner role never changes.');
      const mine = callerRoles(request);
      if (mine.includes(key)) throw adminConflict('own_role', 'You hold this role: another admin with enough access must change it.');
      const normalized = normalizeGrants(request.body.grants);
      if ('issue' in normalized) throw issueProblem(normalized.issue);
      // Every requested grant is known by now, so the rules read them as sent (their pointers are the request's).
      const rule = checkRoleRules(key, request.body.grants);
      if (rule) throw issueProblem(rule);
      const requested = normalized.grants;
      const callerGrants = app.adminAuth.roles.grantsOf(mine);
      const callerPermissions = new Set(app.adminAuth.roles.permissionsOf(mine));
      /** Whether an admin holding `roles` has access the caller does not (roles in memory, as the guard reads them). */
      const beyondCaller = (roles: readonly string[]) =>
        app.adminAuth.roles.grantsOf(roles).includes('*') || app.adminAuth.roles.permissionsOf(roles).some((permission) => !callerPermissions.has(permission));
      const callerId = adminIdOf(request);

      const outcome = await adminWrite(app, request, async (tx, trail) => {
        const locked = await adminRoleForUpdate(tx, key);
        if (!locked) throw new HttpProblem('not_found', { detail: 'No such role.' });
        if (isOwnerLike(locked.key, locked.grants)) throw adminForbidden('owner_role', 'The owner role never changes.');
        const stored = locked.grants.filter((grant) => PERMISSION_GRANT.test(grant) && isKnownGrant(grant));
        const unknown = locked.grants.filter((grant) => !stored.includes(grant));
        if (!sameSet(request.body.base, stored)) throw adminConflict('role_changed', 'This role was changed meanwhile; read it again.');
        const refusal = checkRoleEdit({ callerGrants, stored, requested });
        if (refusal?.reason === 'beyond_role') {
          throw adminForbidden('beyond_role', 'This role has access your roles do not grant: only an admin holding all of it may change it.');
        }
        if (refusal?.reason === 'beyond_grants') {
          throw adminForbidden('beyond_grants', `You may give only access you hold yourself: ${refusal.permissions.join(', ')}.`, { permissions: refusal.permissions });
        }
        if (refusal?.reason === 'restricted_permission') {
          throw adminForbidden('restricted_permission', `Only the owner gives or takes ${refusal.permissions.join(', ')}.`, { permissions: refusal.permissions });
        }
        if (sameSet(requested, stored)) {
          trail.unchanged();
          return { locked, changed: false, sessionIds: [] as string[], admins: 0 };
        }
        const removed = removedPermissions(stored, requested);
        // Taking access away reaches every holder: none may hold more than the editor (the owner excepted).
        if (removed.length > 0 && !callerGrants.includes('*') && locked.holders.some((roles) => beyondCaller(roles))) {
          throw adminForbidden('beyond_holders', 'An admin holding this role has access your roles do not grant: only an admin holding all of it may take access from this role.');
        }
        const change = await adminRoleSetGrants(tx, locked.id, [...requested, ...unknown]).catch(ruleRefusal);
        const signOut = removed.length > 0 ? await adminRevokeRoleHolderSessions(tx, locked.id, adminRevokeReason.code('owner'), callerId) : { sessionIds: [], admins: 0 };
        trail.record({
          action: 'role.update',
          target: 'config',
          detail: {
            role: key,
            before: locked.grants,
            after: [...requested, ...unknown].sort(),
            added: change.added,
            removed: change.removed,
            permissionsRemoved: removed,
            signedOutAdmins: signOut.admins,
            signedOutSessions: signOut.sessionIds.length,
          },
        });
        return { locked, changed: true, sessionIds: signOut.sessionIds, admins: signOut.admins };
      });

      const view = { key, names: outcome.locked.names, grants: requested, permissions: expandGrants(requested) };
      if (!outcome.changed) return { role: view, signedOut: { admins: 0, sessions: 0 }, announced: false, sideEffects: 'done' as const };
      const sideEffects = await afterCommit(request, 'role holders signed out', () => denyAdminSessionsOrThrow(app, outcome.sessionIds), { role: key, sessions: outcome.sessionIds.length });
      const announced = await app.cfg.announce();
      request.log.info({ role: key, grants: requested.length, signedOut: outcome.sessionIds.length, announced }, 'admin role changed');
      return { role: view, signedOut: { admins: outcome.admins, sessions: outcome.sessionIds.length }, announced, sideEffects };
    },
  );
};
