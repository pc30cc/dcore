import {
  adminActiveOwners,
  adminCreate,
  adminIdByEmail,
  adminRevokeSessions,
  adminSetPendingTotp,
  adminSetState,
  adminUpdate,
  adminAccount,
  insertAuditRows,
  withTransaction,
  type Pool,
} from '@app/db';
import { OWNER_ROLE, adminEmailSchema, adminDisplayNameSchema, adminRevokeReason, auditTarget } from '@app/shared';
import type { DataSealer } from '@app/shared/server';
import { DEFAULT_ARGON2, generatePassword, hashPassword, passwordProblem, PASSWORD_PROBLEM_TEXT, type Argon2Params } from './password.js';
import { TOTP_SECRET_PURPOSE, base32Encode, generateTotpSecret, otpauthUri } from './totp.js';

/**
 * The first owner, from the command line (`admin:create`): an admin with
 * the owner role, a password (given, or made and shown once) and a TOTP
 * secret waiting for its first code (shown once as an otpauth URI). The
 * panel's sign-in then asks for that first code (`/totp/confirm`), or makes
 * a new secret (`/totp/enroll`) if the URI was lost.
 *
 * Refused while an enabled owner exists, unless `forceReset`: then the
 * account of that e-mail (made when missing) gets the owner role, a new
 * password and TOTP secret, is enabled and unlocked, and its sessions are
 * revoked; this is the way back in for an owner locked out of the panel.
 * Either way one transaction writes the change and its audit row (by the
 * system: no admin id).
 */

export class BootstrapError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 65) {
    super(message);
    this.name = 'BootstrapError';
    this.exitCode = exitCode;
  }
}

export interface BootstrapInput {
  pool: Pool;
  sealer: DataSealer;
  email: string;
  displayName: string;
  /** Omitted: one is made and answered once. */
  password?: string | undefined;
  forceReset: boolean;
  /** The name authenticator apps show (the brand's app name). */
  issuer: string;
  argon2?: Argon2Params | undefined;
}

export interface BootstrapResult {
  adminId: number;
  created: boolean;
  email: string;
  /** Only when the password was made here. */
  generatedPassword: string | null;
  otpauthUri: string;
  secret: string;
  /** Sessions the reset revoked (their access tokens stop at their expiry, or at once with the deny list). */
  revokedSessions: string[];
}

export async function bootstrapOwner(input: BootstrapInput): Promise<BootstrapResult> {
  const email = adminEmailSchema.safeParse(input.email);
  if (!email.success) throw new BootstrapError('--email must be an e-mail address', 64);
  const name = adminDisplayNameSchema.safeParse(input.displayName);
  if (!name.success) throw new BootstrapError('--name must be 1 to 80 characters', 64);
  const generated = input.password === undefined ? generatePassword() : null;
  const password = input.password ?? generated!;
  const problem = passwordProblem(password, email.data);
  if (problem) throw new BootstrapError(`the password is refused: ${PASSWORD_PROBLEM_TEXT[problem]}`, 64);

  const hash = await hashPassword(password, input.argon2 ?? DEFAULT_ARGON2);
  const secret = generateTotpSecret();
  const sealed = input.sealer.seal(secret, TOTP_SECRET_PURPOSE);

  const outcome = await withTransaction(input.pool, async (tx) => {
    const owners = await adminActiveOwners(tx, OWNER_ROLE);
    if (owners.length > 0 && !input.forceReset) {
      throw new BootstrapError('an enabled owner exists already; pass --force-reset to reset (or add) the account of this e-mail');
    }
    let adminId = await adminIdByEmail(tx, email.data);
    let created = false;
    let revoked: string[] = [];
    if (adminId === null) {
      adminId = await adminCreate(tx, { email: email.data, displayName: name.data, passwordHash: hash, roles: [OWNER_ROLE], createdBy: null });
      if (adminId === null) throw new BootstrapError('the account was created by someone else meanwhile; run again');
      created = true;
    } else {
      if (!input.forceReset) throw new BootstrapError('an admin with this e-mail exists; pass --force-reset to reset it');
      const before = await adminAccount(tx, adminId);
      const roles = [...new Set([OWNER_ROLE, ...(before?.roles ?? [])])];
      await adminUpdate(tx, adminId, { roles });
      await adminSetState(tx, adminId, { disabled: false, resetTotp: true, passwordHash: hash, unlock: true });
      revoked = await adminRevokeSessions(tx, { adminId }, adminRevokeReason.code('owner'));
    }
    if (!(await adminSetPendingTotp(tx, adminId, sealed))) throw new Error('bootstrap: the TOTP secret was not stored');
    await insertAuditRows(tx, [
      {
        id: null,
        adminId: null,
        sessionId: null,
        ip: null,
        targetType: auditTarget.code('admin'),
        targetId: String(adminId),
        action: created ? 'admin.bootstrap' : 'admin.force_reset',
        detail: { email: email.data, roles: [OWNER_ROLE], passwordGenerated: generated !== null, signedOutSessions: revoked.length },
      },
    ]);
    return { adminId, created, revoked };
  });

  return {
    adminId: outcome.adminId,
    created: outcome.created,
    email: email.data,
    generatedPassword: generated,
    otpauthUri: otpauthUri(input.issuer, email.data, secret),
    secret: base32Encode(secret),
    revokedSessions: outcome.revoked,
  };
}
