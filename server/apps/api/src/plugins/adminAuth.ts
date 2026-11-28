import type { Permission } from '@app/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AdminPasswords, DEFAULT_HASH_GATE, HashGate, type HashGateOptions } from '../admin/hashing.js';
import { DEFAULT_ARGON2, type Argon2Params } from '../admin/password.js';
import { AdminRoleCatalog } from '../admin/roles.js';
import { TokenError } from '../auth/tokens.js';
import { adminForbidden } from '../admin/problems.js';
import { HttpProblem } from '../lib/problem.js';
import { unauthorized, type AuthGuard } from './auth.js';

/**
 * What the admin routes share:
 *
 * - `app.adminAuth`: the roles in memory, the password operations (through
 *   the process's Argon2 gate), the login limit across every address, the
 *   session limits and the clock of the TOTP check;
 * - `app.requirePermission(permission)`: the preHandler of every admin
 *   route. It needs an admin access token (one exists only after the TOTP
 *   step, so no admin route works before TOTP is enrolled, unless
 *   ADMIN_TOTP_REQUIRED=false) whose roles grant the permission, checked
 *   against the roles in memory: no statement.
 * - the panel's origin: a request to `/v1/admin/*` that carries an `Origin`
 *   other than the panel's (CORS_ADMIN_ORIGINS) is refused outright (403),
 *   on top of CORS not answering it. The routes that read the refresh cookie
 *   also require the `Origin` to be there ({@link requirePanelOrigin}).
 * - the second factor: with ADMIN_TOTP_REQUIRED=false the password alone
 *   signs in (`totpRequired` false, one warning at start). While it is true,
 *   an admin token of a session the password alone opened (`amr` without
 *   `otp`) is no token at all: the request has no principal (401), and the
 *   session's refresh ends it.
 */

export interface LoginLimit {
  cap: number;
  windowMs: number;
}

/**
 * Logins from every address together, per window (on top of each address's
 * own limit): it bounds the hashing a crowd of addresses can ask of the
 * deployment, and a flood stops admin sign-in for a minute at most.
 */
export const DEFAULT_LOGIN_LIMIT: LoginLimit = { cap: 60, windowMs: 60_000 };

export interface AdminAuthRuntime {
  roles: AdminRoleCatalog;
  argon2: Argon2Params;
  /** Hash, verify, the dummy check: each through the gate. */
  passwords: AdminPasswords;
  loginLimit: LoginLimit;
  accessTokenTtlSeconds: number;
  sessionIdleSeconds: number;
  sessionMaxSeconds: number;
  /** ADMIN_TOTP_REQUIRED: false lets the password alone sign in. */
  totpRequired: boolean;
  /** The clock of the TOTP check. */
  now: () => number;
}

export interface AdminAuthOptions {
  /** Cheaper hashing (tests); otherwise RFC 9106's second recommendation. */
  argon2?: Argon2Params | undefined;
  hashGate?: HashGateOptions | undefined;
  loginLimit?: LoginLimit | undefined;
  now?: (() => number) | undefined;
}

declare module 'fastify' {
  interface FastifyInstance {
    adminAuth: AdminAuthRuntime;
    /** preHandler: an admin access token whose roles grant `permission`. */
    requirePermission(permission: Permission): AuthGuard;
    /**
     * preHandler after the permission: while a second factor is required
     * (ADMIN_TOTP_REQUIRED, every deployment by default), the session must
     * have been opened with it (`amr` holds `otp`), else 403 `mfa_required`.
     * The owner-only writes use it (providers, SMS routing, legal values).
     */
    requireMfa: AuthGuard;
    /** The routes that carry {@link requireMfa} (`METHOD /path`), for their test. */
    routesRequiringMfa(): string[];
  }
}

const ADMIN_PATH = /^\/v1\/admin(\/|$)/;

export const adminAuthPlugin = fp<AdminAuthOptions>(
  async (app, options) => {
    const roles = new AdminRoleCatalog({ pool: app.pg, log: app.log.child({ component: 'admin-roles' }) });
    const argon2 = options.argon2 ?? DEFAULT_ARGON2;
    app.decorate('adminAuth', {
      roles,
      argon2,
      passwords: new AdminPasswords(argon2, new HashGate(options.hashGate ?? DEFAULT_HASH_GATE)),
      loginLimit: options.loginLimit ?? DEFAULT_LOGIN_LIMIT,
      accessTokenTtlSeconds: app.config.admin.accessTokenTtlSeconds,
      sessionIdleSeconds: app.config.admin.sessionIdleSeconds,
      sessionMaxSeconds: app.config.admin.sessionMaxSeconds,
      totpRequired: app.config.admin.totpRequired,
      now: options.now ?? Date.now,
    });
    if (!app.adminAuth.totpRequired) {
      app.log.warn({ adminTotpRequired: false }, 'admin: ADMIN_TOTP_REQUIRED=false: the password alone signs any admin in (no second factor); test stacks only');
    }

    app.decorate('requirePermission', (permission: Permission): AuthGuard => {
      return async (request: FastifyRequest, _reply: FastifyReply) => {
        const principal = request.principal;
        if (principal?.kind !== 'admin') {
          throw unauthorized(principal ? new TokenError('invalid', 'not an admin token') : request.authFailure);
        }
        const allowed = roles.allows(principal.roles, permission);
        if (allowed === null) throw new HttpProblem('service_unavailable', { detail: 'The admin roles are not loaded yet.', headers: { 'retry-after': '5' } });
        if (!allowed) {
          throw adminForbidden('role', 'Your role does not allow this action.', { headers: { 'www-authenticate': 'Bearer error="insufficient_scope"' } });
        }
      };
    });

    const requireMfa: AuthGuard = async (request: FastifyRequest) => {
      const principal = request.principal;
      if (principal?.kind !== 'admin') {
        throw unauthorized(principal ? new TokenError('invalid', 'not an admin token') : request.authFailure);
      }
      if (app.adminAuth.totpRequired && principal.mfa !== true) {
        throw adminForbidden('mfa_required', 'This change needs a session opened with the second factor.');
      }
    };
    app.decorate('requireMfa', requireMfa);
    const mfaRoutes: string[] = [];
    app.addHook('onRoute', (route) => {
      const handlers = ([] as unknown[]).concat(route.preHandler ?? []);
      if (!handlers.includes(requireMfa)) return;
      for (const method of ([] as string[]).concat(route.method)) if (method !== 'HEAD') mfaRoutes.push(`${method} ${route.url}`);
    });
    app.decorate('routesRequiringMfa', () => [...mfaRoutes]);

    // After the token was verified (and the deny list read): a session without a second factor counts only while none is required.
    app.addHook('onRequest', async (request: FastifyRequest) => {
      const principal = request.principal;
      if (principal?.kind !== 'admin' || principal.mfa !== false || !app.adminAuth.totpRequired) return;
      request.principal = null;
      request.authFailure = new TokenError('revoked', 'the session was opened without a second factor, which is required');
    });

    const panelOrigins = new Set(app.config.corsAdminOrigins);
    app.addHook('onRequest', async (request: FastifyRequest) => {
      const origin = request.headers.origin;
      if (origin === undefined || !ADMIN_PATH.test(request.url)) return;
      if (!panelOrigins.has(origin)) throw adminForbidden('origin', 'This origin may not call the admin API.');
    });

    app.addHook('onReady', async () => {
      void app.adminAuth.passwords.prime().catch((error: unknown) => app.log.warn({ err: error }, 'admin: the dummy password hash was not made; the first unknown e-mail makes it'));
      // After every configuration load (cfg:changed covers a change of the roles' grants); once now.
      if (!app.cfg.peek()) void roles.reload();
      app.cfg.onLoad(() => void roles.reload());
    });
  },
  { name: 'admin-auth', fastify: '5.x', dependencies: ['auth', 'account-services'] },
);

/** preHandler of the routes that read the refresh cookie: the request must come from the panel's page. */
export async function requirePanelOrigin(request: FastifyRequest): Promise<void> {
  const origin = request.headers.origin;
  if (origin === undefined || !request.server.config.corsAdminOrigins.includes(origin)) {
    throw adminForbidden('origin', 'Only the admin panel may use this session.');
  }
}
