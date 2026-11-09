import { z } from 'zod';
import { execute, many, maybeOne, one, sql, type SqlFragment } from '../query.js';
import { defineQuery } from './define.js';

/**
 * The admin panel's own accounts (0002, 0023): roles and their grants,
 * credentials, the sign-in counters, sessions (the refresh cookie) and the
 * owner's account management. Every table here is small; these are rare
 * writes and the panel's own reads, never on an app request path.
 *
 * Codes: admin_sessions.revoke_reason as in 0023's comment. Times leave as
 * epoch milliseconds; ids as decimal strings.
 */

const epochMs = z.number().int().nonnegative();
const id = z.string().regex(/^[1-9][0-9]{0,18}$/);

const ms = (column: SqlFragment) => sql`(extract(epoch FROM ${column}) * 1000)::bigint`;

// ─── Roles ─────────────────────────────────────────────────────────────────

export interface AdminRoleRow {
  id: number;
  key: string;
  names: Record<string, string>;
  /** The stored grants (`users.*`, `*`, `billing.read`). */
  grants: string[];
}

const roleRow = z.object({
  id: z.number().int(),
  key: z.string(),
  names: z.record(z.string(), z.unknown()),
  grants: z.array(z.string()),
});

/** Every role with its grants, in id order. */
export const adminRoleCatalog = defineQuery({ name: 'admin.roles', statements: 1 }, async (db): Promise<AdminRoleRow[]> => {
  const rows = await many(
    db,
    sql`SELECT r.id::integer AS id, r.key, r.names,
               coalesce(array_agg(p.permission ORDER BY p.permission) FILTER (WHERE p.permission IS NOT NULL), '{}') AS grants
          FROM admin_roles r
          LEFT JOIN admin_role_permissions p ON p.role_id = r.id
         GROUP BY r.id
         ORDER BY r.id`,
  );
  return rows.map((row) => {
    const parsed = roleRow.parse(row);
    const names = Object.fromEntries(Object.entries(parsed.names).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    return { ...parsed, names };
  });
});

// ─── The account view ──────────────────────────────────────────────────────

export const adminAccountRowSchema = z.object({
  id,
  email: z.string(),
  displayName: z.string(),
  roles: z.array(z.string()),
  createdAtMs: epochMs,
  createdBy: id.nullable(),
  lastLoginAtMs: epochMs.nullable(),
  totpEnabled: z.boolean(),
  disabledAtMs: epochMs.nullable(),
  lockedUntilMs: epochMs.nullable(),
});
export type AdminAccountRow = z.infer<typeof adminAccountRowSchema>;

/** `u` is the admin_users row in the surrounding statement. */
const rolesOf = sql`coalesce((SELECT array_agg(r.key ORDER BY r.id) FROM admin_user_roles ur JOIN admin_roles r ON r.id = ur.role_id WHERE ur.admin_id = u.id), '{}')`;

const accountView = sql`jsonb_build_object(
    'id', u.id::text,
    'email', u.email,
    'displayName', u.display_name,
    'roles', to_jsonb(${rolesOf}),
    'createdAtMs', ${ms(sql`u.created_at`)},
    'createdBy', u.created_by::text,
    'lastLoginAtMs', ${ms(sql`u.last_login_at`)},
    'totpEnabled', u.totp_enabled_at IS NOT NULL,
    'disabledAtMs', ${ms(sql`u.disabled_at`)},
    'lockedUntilMs', CASE WHEN u.locked_until > now() THEN ${ms(sql`u.locked_until`)} END)`;

/** One admin's account, or null. */
export const adminAccount = defineQuery({ name: 'admin.account', statements: 1 }, async (db, adminId: number): Promise<AdminAccountRow | null> => {
  const row = await maybeOne<{ account: unknown }>(db, sql`SELECT ${accountView} AS account FROM admin_users u WHERE u.id = ${adminId}::integer`);
  return row ? adminAccountRowSchema.parse(row.account) : null;
});

/** One admin's account, locked until the transaction ends (a change reads its "before" this way). */
export const adminAccountForUpdate = defineQuery(
  { name: 'admin.accountForUpdate', statements: 1 },
  async (tx, adminId: number): Promise<AdminAccountRow | null> => {
    const row = await maybeOne<{ account: unknown }>(tx, sql`SELECT ${accountView} AS account FROM admin_users u WHERE u.id = ${adminId}::integer FOR UPDATE`);
    return row ? adminAccountRowSchema.parse(row.account) : null;
  },
);

/** A page of admins by id (keyset: ids after `afterId`). */
export const adminAccounts = defineQuery(
  { name: 'admin.accounts', statements: 1 },
  async (db, page: { afterId: number; limit: number }): Promise<AdminAccountRow[]> => {
    const rows = await many<{ account: unknown }>(
      db,
      sql`SELECT ${accountView} AS account FROM admin_users u WHERE u.id > ${page.afterId}::integer ORDER BY u.id LIMIT ${page.limit}::integer`,
    );
    return rows.map((row) => adminAccountRowSchema.parse(row.account));
  },
);

/**
 * The ids of the enabled admins holding `ownerRole`, locked until the
 * transaction ends: a change that could leave no enabled owner reads them
 * first, so two such changes at once are serialised and the second sees the
 * first's result.
 */
export const adminActiveOwners = defineQuery({ name: 'admin.activeOwners', statements: 1 }, async (tx, ownerRole: string): Promise<number[]> => {
  const rows = await many<{ id: number }>(
    tx,
    sql`SELECT u.id
          FROM admin_users u
          JOIN admin_user_roles ur ON ur.admin_id = u.id
          JOIN admin_roles r ON r.id = ur.role_id
         WHERE r.key = ${ownerRole}::text AND u.disabled_at IS NULL
         ORDER BY u.id
           FOR UPDATE OF u`,
  );
  return rows.map((row) => Number(row.id));
});

// ─── Signing in ────────────────────────────────────────────────────────────

export interface AdminCredentials {
  id: number;
  passwordHash: string | null;
  disabled: boolean;
  locked: boolean;
  totpEnabled: boolean;
}

/** What a password check needs, by e-mail (lower case); null when there is no such admin. */
export const adminCredentials = defineQuery({ name: 'admin.credentials', statements: 1 }, async (db, email: string): Promise<AdminCredentials | null> => {
  const row = await maybeOne<{ id: number; password_hash: string | null; disabled: boolean; locked: boolean; totp_enabled: boolean }>(
    db,
    sql`SELECT u.id, u.password_hash, u.disabled_at IS NOT NULL AS disabled,
               coalesce(u.locked_until > now(), false) AS locked, u.totp_enabled_at IS NOT NULL AS totp_enabled
          FROM admin_users u
         WHERE u.email = ${email}::text`,
  );
  return row ? { id: Number(row.id), passwordHash: row.password_hash, disabled: row.disabled, locked: row.locked, totpEnabled: row.totp_enabled } : null;
});

export interface LockPolicy {
  /** Failures (wrong password or wrong code) that lock the account. */
  maxFailures: number;
  lockSeconds: number;
}

export interface FailureOutcome {
  /** The account is locked now (by this failure or before it). */
  locked: boolean;
  /** Failures counted since the last lock or sign-in (0 once locked). */
  failures: number;
}

/**
 * Counts one failure against an account that is not locked: the failure
 * that reaches the limit locks it for `lockSeconds` and starts the count
 * again. A locked account counts nothing (an attacker cannot extend the
 * lock with more tries).
 */
export const adminRecordFailure = defineQuery(
  { name: 'admin.recordFailure', statements: 1 },
  async (db, adminId: number, policy: LockPolicy): Promise<FailureOutcome> => {
    const row = await maybeOne<{ locked: boolean; failures: number }>(
      db,
      sql`UPDATE admin_users u
             SET failed_logins = CASE WHEN u.failed_logins + 1 >= ${policy.maxFailures}::integer THEN 0 ELSE u.failed_logins + 1 END,
                 locked_until = CASE WHEN u.failed_logins + 1 >= ${policy.maxFailures}::integer
                                     THEN now() + make_interval(secs => ${policy.lockSeconds}::integer) ELSE u.locked_until END
           WHERE u.id = ${adminId}::integer AND (u.locked_until IS NULL OR u.locked_until <= now())
       RETURNING coalesce(u.locked_until > now(), false) AS locked, u.failed_logins::integer AS failures`,
    );
    return row ? { locked: row.locked, failures: row.failures } : { locked: true, failures: 0 };
  },
);

/**
 * The decision of a password that matched: true only when the account is
 * enabled and not locked now, read after the hash was checked (a lock that
 * other attempts wrote while this one was hashing refuses it). The row is
 * locked for the statement (FOR NO KEY UPDATE, or the UPDATE of a rehash),
 * so a failure being counted at that moment is waited for and its lock
 * seen. `rehash`: a newer hash of the same password (the parameters
 * changed), stored in the same statement unless the password changed.
 */
export const adminAcceptPassword = defineQuery(
  { name: 'admin.acceptPassword', statements: 1 },
  async (db, adminId: number, rehash: { oldHash: string; newHash: string } | null): Promise<boolean> => {
    const open = sql`u.id = ${adminId}::integer AND u.disabled_at IS NULL AND (u.locked_until IS NULL OR u.locked_until <= now())`;
    const row = rehash
      ? await maybeOne<{ id: number }>(
          db,
          sql`UPDATE admin_users u
                 SET password_hash = CASE WHEN u.password_hash = ${rehash.oldHash}::text THEN ${rehash.newHash}::text ELSE u.password_hash END
               WHERE ${open}
           RETURNING u.id`,
        )
      : await maybeOne<{ id: number }>(db, sql`SELECT u.id FROM admin_users u WHERE ${open} FOR NO KEY UPDATE`);
    return row !== null;
  },
);

export interface AdminMfaState {
  id: number;
  email: string;
  /** The sealed TOTP secret: the enrolled one, or the one waiting for its first code. */
  totpSecret: Buffer | null;
  totpEnabled: boolean;
  totpLastStep: number | null;
  disabled: boolean;
  locked: boolean;
  failures: number;
}

/** What the second step needs. */
export const adminMfaState = defineQuery({ name: 'admin.mfaState', statements: 1 }, async (db, adminId: number): Promise<AdminMfaState | null> => {
  const row = await maybeOne<{
    id: number;
    email: string;
    totp_secret_enc: Buffer | null;
    totp_enabled: boolean;
    totp_last_step: string | null;
    disabled: boolean;
    locked: boolean;
    failures: number;
  }>(
    db,
    sql`SELECT u.id, u.email, u.totp_secret_enc, u.totp_enabled_at IS NOT NULL AS totp_enabled, u.totp_last_step::text AS totp_last_step,
               u.disabled_at IS NOT NULL AS disabled, coalesce(u.locked_until > now(), false) AS locked, u.failed_logins::integer AS failures
          FROM admin_users u
         WHERE u.id = ${adminId}::integer`,
  );
  if (!row) return null;
  return {
    id: Number(row.id),
    email: row.email,
    totpSecret: row.totp_secret_enc,
    totpEnabled: row.totp_enabled,
    totpLastStep: row.totp_last_step === null ? null : Number(row.totp_last_step),
    disabled: row.disabled,
    locked: row.locked,
    failures: row.failures,
  };
});

/** Stores a new TOTP secret waiting for its first code (only while none is enrolled). */
export const adminSetPendingTotp = defineQuery(
  { name: 'admin.setPendingTotp', statements: 1 },
  async (tx, adminId: number, sealed: Buffer): Promise<boolean> => {
    const written = await execute(
      tx,
      sql`UPDATE admin_users SET totp_secret_enc = ${sealed}::bytea
           WHERE id = ${adminId}::integer AND totp_enabled_at IS NULL AND disabled_at IS NULL`,
    );
    return written === 1;
  },
);

export interface AdminSessionInput {
  id: string;
  refreshHash: Buffer;
  /** The idle window: the session expires this long after its last refresh. */
  idleSeconds: number;
  ip: string | null;
  userAgent: string | null;
}

export interface AdminSignInInput {
  adminId: number;
  /** The time step of the code that was accepted; the stored one must be older. */
  step: number;
  /** The sealed secret the code was checked against: a secret replaced meanwhile refuses the sign-in. */
  secret: Buffer;
  /** First code of a new secret: enrols it. */
  enroll: boolean;
  session: AdminSessionInput;
}

export interface AdminSignedIn {
  expiresAtMs: number;
  roles: string[];
}

/**
 * The second factor passed: records the code's step (a replay of it, or of
 * an older code, finds no row), clears the failure count and the lock,
 * enrols the secret on a first code, and opens the session, in one
 * statement. Null when the account changed meanwhile (disabled, locked, the
 * step already used, another secret), and nothing is written then.
 */
export const adminSignIn = defineQuery({ name: 'admin.signIn', statements: 1 }, async (tx, input: AdminSignInInput): Promise<AdminSignedIn | null> => {
  const { session } = input;
  const row = await maybeOne<{ expires_ms: string; roles: string[] | null }>(
    tx,
    sql`WITH signed AS (
          UPDATE admin_users u
             SET totp_last_step = ${input.step}::bigint, failed_logins = 0, locked_until = NULL, last_login_at = now(),
                 totp_enabled_at = CASE WHEN ${input.enroll}::boolean THEN now() ELSE u.totp_enabled_at END
           WHERE u.id = ${input.adminId}::integer AND u.disabled_at IS NULL
             AND (u.locked_until IS NULL OR u.locked_until <= now())
             AND (u.totp_last_step IS NULL OR u.totp_last_step < ${input.step}::bigint)
             AND u.totp_secret_enc = ${input.secret}::bytea
             AND (u.totp_enabled_at IS NULL) = ${input.enroll}::boolean
       RETURNING u.id
        ), s AS (
          INSERT INTO admin_sessions (id, admin_id, expires_at, refreshed_at, ip, refresh_hash, user_agent)
          SELECT ${session.id}::bigint, signed.id, now() + make_interval(secs => ${session.idleSeconds}::integer), now(),
                 ${session.ip}::inet, ${session.refreshHash}::bytea, ${session.userAgent}::text
            FROM signed
       RETURNING admin_id, expires_at
        )
        SELECT ${ms(sql`s.expires_at`)}::text AS expires_ms,
               (SELECT array_agg(r.key ORDER BY r.id) FROM admin_user_roles ur JOIN admin_roles r ON r.id = ur.role_id WHERE ur.admin_id = s.admin_id) AS roles
          FROM s`,
  );
  return row ? { expiresAtMs: Number(row.expires_ms), roles: row.roles ?? [] } : null;
});

// ─── Sessions ──────────────────────────────────────────────────────────────

export interface AdminRefreshInput {
  sessionId: string;
  oldHash: Buffer;
  newHash: Buffer;
  idleSeconds: number;
  /** No session lives longer than this after it was opened, however often it refreshes. */
  maxSeconds: number;
  /** A rotated token used again within this window is a concurrent refresh, not a reuse. */
  graceSeconds: number;
}

export type AdminRefreshOutcome =
  | { outcome: 'rotated'; adminId: number; expiresAtMs: number; roles: string[] }
  | { outcome: 'reused'; adminId: number }
  | { outcome: 'invalid' };

const refreshRow = z.object({
  outcome: z.enum(['rotated', 'reused', 'invalid']),
  admin_id: z.number().int().nullable(),
  expires_ms: z.string().nullable(),
  roles: z.array(z.string()).nullable(),
});

/**
 * Rotates a refresh token in one statement: the session must be live, its
 * admin enabled and enrolled. The token it replaced, used again after the
 * grace, revokes the session (`reused`: a copy is loose).
 */
export const adminRefresh = defineQuery({ name: 'admin.refresh', statements: 1 }, async (db, input: AdminRefreshInput): Promise<AdminRefreshOutcome> => {
  const row = await one(
    db,
    sql`WITH rotated AS (
          UPDATE admin_sessions s
             SET prev_hash = s.refresh_hash, refresh_hash = ${input.newHash}::bytea, refreshed_at = now(),
                 expires_at = least(now() + make_interval(secs => ${input.idleSeconds}::integer),
                                    s.created_at + make_interval(secs => ${input.maxSeconds}::integer))
            FROM admin_users u
           WHERE s.id = ${input.sessionId}::bigint AND s.refresh_hash = ${input.oldHash}::bytea
             AND s.revoked_at IS NULL AND s.expires_at > now()
             AND u.id = s.admin_id AND u.disabled_at IS NULL AND u.totp_enabled_at IS NOT NULL
       RETURNING s.admin_id, s.expires_at
        ), reused AS (
          UPDATE admin_sessions s
             SET revoked_at = now(), revoke_reason = 3
           WHERE s.id = ${input.sessionId}::bigint AND s.prev_hash = ${input.oldHash}::bytea
             AND s.revoked_at IS NULL AND s.refreshed_at <= now() - make_interval(secs => ${input.graceSeconds}::integer)
       RETURNING s.admin_id
        )
        SELECT CASE WHEN r.admin_id IS NOT NULL THEN 'rotated' WHEN x.admin_id IS NOT NULL THEN 'reused' ELSE 'invalid' END AS outcome,
               coalesce(r.admin_id, x.admin_id) AS admin_id,
               ${ms(sql`r.expires_at`)}::text AS expires_ms,
               CASE WHEN r.admin_id IS NOT NULL THEN
                 coalesce((SELECT array_agg(ar.key ORDER BY ar.id) FROM admin_user_roles ur JOIN admin_roles ar ON ar.id = ur.role_id WHERE ur.admin_id = r.admin_id), '{}')
               END AS roles
          FROM (SELECT 1) one
          LEFT JOIN rotated r ON true
          LEFT JOIN reused x ON true`,
  );
  const parsed = refreshRow.parse(row);
  if (parsed.outcome === 'rotated' && parsed.admin_id !== null && parsed.expires_ms !== null) {
    return { outcome: 'rotated', adminId: parsed.admin_id, expiresAtMs: Number(parsed.expires_ms), roles: parsed.roles ?? [] };
  }
  if (parsed.outcome === 'reused' && parsed.admin_id !== null) return { outcome: 'reused', adminId: parsed.admin_id };
  return { outcome: 'invalid' };
});

export type AdminSessionTarget =
  | { sessionId: string; adminId: number }
  | { adminId: number; exceptSessionId?: string | undefined };

/** Revokes one session of an admin, or all of them (but `exceptSessionId`); returns the ids revoked. */
export const adminRevokeSessions = defineQuery(
  { name: 'admin.revokeSessions', statements: 1 },
  async (db, target: AdminSessionTarget, reason: number): Promise<string[]> => {
    const rows = await many<{ id: string }>(
      db,
      'sessionId' in target
        ? sql`UPDATE admin_sessions SET revoked_at = now(), revoke_reason = ${reason}::smallint
               WHERE id = ${target.sessionId}::bigint AND admin_id = ${target.adminId}::integer AND revoked_at IS NULL
           RETURNING id::text`
        : sql`UPDATE admin_sessions SET revoked_at = now(), revoke_reason = ${reason}::smallint
               WHERE admin_id = ${target.adminId}::integer AND revoked_at IS NULL
                 AND id IS DISTINCT FROM ${target.exceptSessionId ?? null}::bigint
           RETURNING id::text`,
    );
    return rows.map((row) => row.id);
  },
);

export interface AdminLogoutOutcome {
  adminId: number;
  revoked: string[];
}

/**
 * Signs out the session a refresh token names (its current token or the one
 * it replaced), and with `all` every other live session of that admin.
 * Null when the token names no live session.
 */
export const adminLogoutByToken = defineQuery(
  { name: 'admin.logoutByToken', statements: 1 },
  async (tx, input: { sessionId: string; hash: Buffer; all: boolean }): Promise<AdminLogoutOutcome | null> => {
    const row = await maybeOne<{ admin_id: number | null; revoked: string[] | null }>(
      tx,
      sql`WITH own AS (
            UPDATE admin_sessions s SET revoked_at = now(), revoke_reason = ${input.all ? 2 : 1}::smallint
             WHERE s.id = ${input.sessionId}::bigint AND s.revoked_at IS NULL
               AND (s.refresh_hash = ${input.hash}::bytea OR s.prev_hash = ${input.hash}::bytea)
         RETURNING s.id, s.admin_id
          ), rest AS (
            UPDATE admin_sessions s SET revoked_at = now(), revoke_reason = 2
              FROM own
             WHERE ${input.all}::boolean AND s.admin_id = own.admin_id AND s.revoked_at IS NULL AND s.id <> own.id
         RETURNING s.id
          )
          SELECT own.admin_id, array(SELECT own.id::text UNION ALL SELECT rest.id::text FROM rest) AS revoked FROM own`,
    );
    const adminId = row?.admin_id ?? null;
    if (adminId === null) return null;
    return { adminId: Number(adminId), revoked: row?.revoked ?? [] };
  },
);

export const adminSessionRowSchema = z.object({
  id,
  createdAtMs: epochMs,
  refreshedAtMs: epochMs,
  expiresAtMs: epochMs,
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
});
export type AdminSessionRow = z.infer<typeof adminSessionRowSchema>;

/** An admin's live sessions, newest first. */
export const adminSessionList = defineQuery({ name: 'admin.sessions', statements: 1 }, async (db, adminId: number): Promise<AdminSessionRow[]> => {
  const rows = await many<{ session: unknown }>(
    db,
    sql`SELECT jsonb_build_object('id', s.id::text, 'createdAtMs', ${ms(sql`s.created_at`)}, 'refreshedAtMs', ${ms(sql`s.refreshed_at`)},
                                  'expiresAtMs', ${ms(sql`s.expires_at`)}, 'ip', host(s.ip), 'userAgent', s.user_agent) AS session
          FROM admin_sessions s
         WHERE s.admin_id = ${adminId}::integer AND s.revoked_at IS NULL AND s.expires_at > now()
         ORDER BY s.id DESC
         LIMIT 100`,
  );
  return rows.map((row) => adminSessionRowSchema.parse(row.session));
});

// ─── Account management ────────────────────────────────────────────────────

export interface AdminCreateInput {
  email: string;
  displayName: string;
  passwordHash: string;
  roles: readonly string[];
  createdBy: number | null;
}

/** A new admin with its roles, in one statement; null when the e-mail is taken. Throws when a role is unknown. */
export const adminCreate = defineQuery({ name: 'admin.create', statements: 1 }, async (tx, input: AdminCreateInput): Promise<number | null> => {
  const row = await one<{ id: number | null; roles: number }>(
    tx,
    sql`WITH u AS (
          INSERT INTO admin_users (email, display_name, password_hash, created_by)
          VALUES (${input.email}::text, ${input.displayName}::text, ${input.passwordHash}::text, ${input.createdBy}::integer)
          ON CONFLICT (email) DO NOTHING
       RETURNING id
        ), r AS (
          INSERT INTO admin_user_roles (admin_id, role_id)
          SELECT u.id, ar.id FROM u, admin_roles ar WHERE ar.key = ANY(${[...input.roles]}::text[])
       RETURNING role_id
        )
        SELECT (SELECT u.id FROM u) AS id, (SELECT count(r.role_id) FROM r)::integer AS roles`,
  );
  if (row.id === null) return null;
  if (row.roles !== new Set(input.roles).size) throw new Error('admin: an unknown role was named');
  return Number(row.id);
});

/** Changes the display name and/or replaces the roles. Throws when a role is unknown. */
export const adminUpdate = defineQuery(
  { name: 'admin.update', statements: 1 },
  async (tx, adminId: number, patch: { displayName?: string | undefined; roles?: readonly string[] | undefined }): Promise<void> => {
    const setRoles = patch.roles !== undefined;
    const roles = [...(patch.roles ?? [])];
    const row = await one<{ known: number }>(
      tx,
      sql`WITH name AS (
            UPDATE admin_users SET display_name = coalesce(${patch.displayName ?? null}::text, display_name)
             WHERE id = ${adminId}::integer
         RETURNING id
          ), dropped AS (
            DELETE FROM admin_user_roles ur
             WHERE ${setRoles}::boolean AND ur.admin_id = ${adminId}::integer
               AND ur.role_id NOT IN (SELECT ar.id FROM admin_roles ar WHERE ar.key = ANY(${roles}::text[]))
         RETURNING ur.role_id
          ), added AS (
            INSERT INTO admin_user_roles (admin_id, role_id)
            SELECT ${adminId}::integer, ar.id FROM admin_roles ar WHERE ${setRoles}::boolean AND ar.key = ANY(${roles}::text[])
            ON CONFLICT DO NOTHING
         RETURNING role_id
          )
          SELECT (SELECT count(ar.id) FROM admin_roles ar WHERE ar.key = ANY(${roles}::text[]))::integer AS known,
                 (SELECT count(name.id) FROM name) + (SELECT count(dropped.role_id) FROM dropped) + (SELECT count(added.role_id) FROM added) AS touched`,
    );
    if (setRoles && row.known !== new Set(roles).size) throw new Error('admin: an unknown role was named');
  },
);

export interface AdminStateChange {
  /** true disables (keeping the first time), false enables. */
  disabled?: boolean | undefined;
  /** Forgets the TOTP secret: the next sign-in enrols again. */
  resetTotp?: boolean | undefined;
  passwordHash?: string | undefined;
  /** Clears the failure count and the lock. */
  unlock?: boolean | undefined;
}

/** Changes an admin's state; false when there is no such admin. */
export const adminSetState = defineQuery({ name: 'admin.setState', statements: 1 }, async (tx, adminId: number, change: AdminStateChange): Promise<boolean> => {
  const reset = change.resetTotp === true;
  const unlock = change.unlock === true;
  const written = await execute(
    tx,
    sql`UPDATE admin_users
           SET disabled_at = CASE WHEN ${change.disabled ?? null}::boolean IS NULL THEN disabled_at
                                  WHEN ${change.disabled ?? null}::boolean THEN coalesce(disabled_at, now()) ELSE NULL END,
               totp_secret_enc = CASE WHEN ${reset}::boolean THEN NULL ELSE totp_secret_enc END,
               totp_enabled_at = CASE WHEN ${reset}::boolean THEN NULL ELSE totp_enabled_at END,
               totp_last_step = CASE WHEN ${reset}::boolean THEN NULL ELSE totp_last_step END,
               password_hash = coalesce(${change.passwordHash ?? null}::text, password_hash),
               failed_logins = CASE WHEN ${unlock}::boolean THEN 0 ELSE failed_logins END,
               locked_until = CASE WHEN ${unlock}::boolean THEN NULL ELSE locked_until END
         WHERE id = ${adminId}::integer`,
  );
  return written === 1;
});

/** The stored password hash of an admin (changing one's own password checks the current one). */
export const adminPasswordHash = defineQuery({ name: 'admin.passwordHash', statements: 1 }, async (db, adminId: number): Promise<string | null> => {
  const row = await maybeOne<{ password_hash: string | null }>(db, sql`SELECT password_hash FROM admin_users WHERE id = ${adminId}::integer`);
  return row?.password_hash ?? null;
});

/** An admin's id by e-mail (lower case), or null. */
export const adminIdByEmail = defineQuery({ name: 'admin.idByEmail', statements: 1 }, async (db, email: string): Promise<number | null> => {
  const row = await maybeOne<{ id: number }>(db, sql`SELECT id FROM admin_users WHERE email = ${email}::text`);
  return row ? Number(row.id) : null;
});

/** The active brand row's app name (the panel's override of brand.json), or null. */
export const activeBrandAppName = defineQuery({ name: 'admin.activeBrandName', statements: 1 }, async (db): Promise<string | null> => {
  const row = await maybeOne<{ name: string | null }>(db, sql`SELECT b.config->>'appName' AS name FROM brands b WHERE b.is_active`);
  return row?.name && row.name.length > 0 ? row.name : null;
});
