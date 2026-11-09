import { adminAccount, adminPasswordHash, adminRevokeSessions, adminSessionList, adminSetState, type AdminAccountRow } from '@app/db';
import {
  adminAccessTokenSchema,
  adminLoginRequestSchema,
  adminLoginResultSchema,
  adminLogoutRequestSchema,
  adminMeSchema,
  adminMfaRequestSchema,
  adminPasswordChangeRequestSchema,
  adminRevokeReason,
  adminSessionListSchema,
  adminTotpEnrollmentSchema,
  adminTotpRequestSchema,
  idSchema,
  wireTime,
  type AdminAccount,
} from '@app/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { adminWrite } from '../admin/audit.js';
import { passwordProblem, PASSWORD_PROBLEM_TEXT } from '../admin/password.js';
import { adminCheckTotp, adminEnrollTotp, adminLogin, adminLogout, adminRefreshSession, denyAdminSessions } from '../admin/session.js';
import { HttpProblem } from '../lib/problem.js';
import { requirePanelOrigin } from '../plugins/adminAuth.js';

/**
 * Admin sign-in (`/v1/admin/auth/*`, no token) and the signed-in admin's
 * own account (`/v1/admin/me*`, any admin). Budgets: login 2 (the
 * credentials, then the failure count or the acceptance, which also stores a
 * rehash); enrol 1 read and a
 * transaction of 2; a code 1 read and a failure count or a transaction of
 * 2 (the sign-in and its audit row); refresh 1; logout a transaction of 2.
 */

export function accountView(row: AdminAccountRow): AdminAccount {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    roles: row.roles,
    createdAt: wireTime(row.createdAtMs),
    createdBy: row.createdBy,
    lastLoginAt: row.lastLoginAtMs === null ? null : wireTime(row.lastLoginAtMs),
    totpEnabled: row.totpEnabled,
    disabledAt: row.disabledAtMs === null ? null : wireTime(row.disabledAtMs),
    lockedUntil: row.lockedUntilMs === null ? null : wireTime(row.lockedUntilMs),
  };
}

/** The admin id of the request's admin token (the guard ran before). */
export function adminIdOf(request: FastifyRequest): number {
  const subject = request.principal?.subject ?? '';
  if (request.principal?.kind !== 'admin' || !/^[1-9][0-9]{0,9}$/.test(subject)) throw new HttpProblem('unauthorized');
  return Number(subject);
}

export function passwordRefusal(password: string, email: string, pointer: string): HttpProblem | null {
  const problem = passwordProblem(password, email);
  if (!problem) return null;
  const message = PASSWORD_PROBLEM_TEXT[problem];
  return new HttpProblem('field_invalid', { detail: message, errors: [{ in: 'body', pointer, code: problem, message }] });
}

export const adminAuthRoutes: FastifyPluginAsyncZod = async (app) => {
  const signedIn = app.requireAdmin();
  const tags = ['admin'];

  app.post(
    '/v1/admin/auth/login',
    {
      config: { pgBudget: 2 },
      schema: { tags, summary: 'Admin sign-in, first step: e-mail and password', body: adminLoginRequestSchema, response: { 200: adminLoginResultSchema } },
    },
    async (request) => adminLogin(app, request, request.body.email, request.body.password),
  );

  app.post(
    '/v1/admin/auth/totp/enroll',
    {
      config: { pgBudget: 3 },
      schema: { tags, summary: 'A new TOTP secret, shown once (accounts without TOTP)', body: adminMfaRequestSchema, response: { 200: adminTotpEnrollmentSchema } },
    },
    async (request) => adminEnrollTotp(app, request, request.body.mfaToken),
  );

  app.post(
    '/v1/admin/auth/totp/confirm',
    {
      config: { pgBudget: 3 },
      schema: { tags, summary: 'The first code of the new secret: enrols it and signs in', body: adminTotpRequestSchema, response: { 200: adminAccessTokenSchema } },
    },
    async (request, reply) => adminCheckTotp(app, request, reply, { ...request.body, mode: 'confirm' }),
  );

  app.post(
    '/v1/admin/auth/totp',
    {
      config: { pgBudget: 3 },
      schema: { tags, summary: 'Admin sign-in, second step: the TOTP code', body: adminTotpRequestSchema, response: { 200: adminAccessTokenSchema } },
    },
    async (request, reply) => adminCheckTotp(app, request, reply, { ...request.body, mode: 'verify' }),
  );

  app.post(
    '/v1/admin/auth/refresh',
    {
      preHandler: requirePanelOrigin,
      config: { pgBudget: 1 },
      schema: { tags, summary: 'A new access token for the refresh cookie (rotated)', response: { 200: adminAccessTokenSchema } },
    },
    async (request, reply) => adminRefreshSession(app, request, reply),
  );

  app.post(
    '/v1/admin/auth/logout',
    {
      preHandler: requirePanelOrigin,
      config: { pgBudget: 2 },
      schema: { tags, summary: 'Sign out this session, or every session', body: adminLogoutRequestSchema.optional() },
    },
    async (request, reply) => {
      await adminLogout(app, request, reply, request.body?.all === true);
      return reply.code(204).send();
    },
  );

  app.get(
    '/v1/admin/me',
    { preHandler: signedIn, config: { pgBudget: 1 }, schema: { tags, summary: 'The signed-in admin', response: { 200: adminMeSchema } } },
    async (request) => {
      const adminId = adminIdOf(request);
      const row = await adminAccount(app.pg, adminId);
      if (!row) throw new HttpProblem('unauthorized');
      return {
        ...accountView(row),
        permissions: app.adminAuth.roles.permissionsOf(request.principal?.roles ?? []),
        sessionId: request.principal?.sessionId ?? '',
      };
    },
  );

  app.get(
    '/v1/admin/me/sessions',
    { preHandler: signedIn, config: { pgBudget: 1 }, schema: { tags, summary: "The signed-in admin's live sessions", response: { 200: adminSessionListSchema } } },
    async (request) => {
      const adminId = adminIdOf(request);
      const current = request.principal?.sessionId;
      const rows = await adminSessionList(app.pg, adminId);
      return {
        items: rows.map((row) => ({
          id: row.id,
          createdAt: wireTime(row.createdAtMs),
          refreshedAt: wireTime(row.refreshedAtMs),
          expiresAt: wireTime(row.expiresAtMs),
          ip: row.ip,
          userAgent: row.userAgent,
          current: row.id === current,
        })),
      };
    },
  );

  app.delete(
    '/v1/admin/me/sessions/:id',
    {
      preHandler: signedIn,
      config: { pgBudget: 2 },
      schema: { tags, summary: 'Sign out one of my sessions', params: z.object({ id: idSchema }) },
    },
    async (request, reply) => {
      const adminId = adminIdOf(request);
      const sessionId = request.params.id;
      const revoked = await adminWrite(app, request, async (tx, trail) => {
        const ids = await adminRevokeSessions(tx, { sessionId, adminId }, adminRevokeReason.code('logout'));
        if (ids.length === 0) throw new HttpProblem('not_found', { detail: 'No such live session.' });
        trail.record({ action: 'admin.session_revoke', target: 'admin', targetId: adminId, detail: { sessionId } });
        return ids;
      });
      await denyAdminSessions(app, request, revoked);
      return reply.code(204).send();
    },
  );

  app.put(
    '/v1/admin/me/password',
    {
      preHandler: signedIn,
      config: { pgBudget: 5 },
      schema: { tags, summary: 'Change my password (signs out my other sessions)', body: adminPasswordChangeRequestSchema },
    },
    async (request, reply) => {
      const adminId = adminIdOf(request);
      // Guessing the current password with a stolen access token is bounded too (fails closed).
      let verdict;
      try {
        verdict = await app.limits.take([{ name: 'admin_password', key: app.keys.signInIpLimit('admin_password', String(adminId)), cap: 10, windowMs: 3_600_000 }]);
      } catch (error) {
        throw new HttpProblem('service_unavailable', { detail: 'Try again in a moment.', headers: { 'retry-after': '30' }, cause: error });
      }
      if (!verdict.ok) {
        const retryAfterSeconds = Math.max(1, Math.ceil(verdict.retryAfterMs / 1_000));
        throw new HttpProblem('rate_limited', { retryAfterSeconds, headers: { 'retry-after': String(retryAfterSeconds) } });
      }
      const stored = await adminPasswordHash(app.pg, adminId);
      const row = await adminAccount(app.pg, adminId);
      if (!row) throw new HttpProblem('unauthorized');
      if (!stored || !(await app.adminAuth.passwords.verify(request.body.currentPassword, stored))) {
        throw new HttpProblem('field_invalid', {
          detail: 'The current password is not right.',
          errors: [{ in: 'body', pointer: '/currentPassword', code: 'wrong', message: 'The current password is not right.' }],
        });
      }
      const refusal = passwordRefusal(request.body.newPassword, row.email, '/newPassword');
      if (refusal) throw refusal;
      const hash = await app.adminAuth.passwords.hash(request.body.newPassword);
      const current = request.principal?.sessionId;
      const revoked = await adminWrite(app, request, async (tx, trail) => {
        await adminSetState(tx, adminId, { passwordHash: hash });
        const ids = await adminRevokeSessions(tx, { adminId, exceptSessionId: current }, adminRevokeReason.code('password_changed'));
        trail.record({ action: 'admin.password_change', target: 'admin', targetId: adminId, detail: { signedOutSessions: ids.length } });
        return ids;
      });
      await denyAdminSessions(app, request, revoked);
      return reply.code(204).send();
    },
  );
};
