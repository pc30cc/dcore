import { z } from 'zod';
import { pageSchema } from '../pagination.js';
import { idSchema, timeSchema } from './common.js';

/**
 * The admin panel's own account routes (`/v1/admin/auth/*`, `/v1/admin/me*`,
 * `/v1/admin/admins*`, `/v1/admin/roles`). Admin ids are small integers in
 * the database and decimal strings on the wire, like every other id.
 *
 * Sign-in is two steps: e-mail and password give an `mfaToken` (5 minutes,
 * single use), and a TOTP code with it gives the access token (10 minutes,
 * in the panel's memory) and the refresh cookie (HttpOnly, Secure,
 * SameSite=Strict, Path=/v1/admin/auth, rotated on every refresh). An admin
 * without TOTP enrols first (`/totp/enroll`, then `/totp/confirm`); nothing
 * else works before that.
 */

/** Passwords: at least 12 characters (Unicode code points, NFKC), at most 128. */
export const ADMIN_PASSWORD_MIN = 12;
export const ADMIN_PASSWORD_MAX = 128;

export const adminIdSchema = z.string().regex(/^[1-9][0-9]{0,9}$/, 'must be a decimal admin id');
export const adminEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'must be an e-mail address');
export const adminDisplayNameSchema = z.string().trim().min(1).max(80);
/** A role key as `admin_roles.key` holds it. */
export const adminRoleKeySchema = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/);
/** The panel sends what was typed; the policy (length, not the e-mail) is the server's answer. */
export const adminPasswordInputSchema = z.string().min(1).max(1_024);
export const adminMfaTokenSchema = z.string().regex(/^amf1\.[A-Za-z0-9_-]{43}$/, 'must be an MFA token');
export const totpCodeSchema = z.string().regex(/^[0-9]{6}$/, 'must be 6 digits');

// ─── Signing in ────────────────────────────────────────────────────────────

export const adminLoginRequestSchema = z.object({ email: z.string().min(1).max(320), password: adminPasswordInputSchema });

export const adminLoginResultSchema = z.object({
  mfaToken: adminMfaTokenSchema,
  /** No TOTP yet: `/totp/enroll`, then `/totp/confirm`. Otherwise `/totp`. */
  enrollRequired: z.boolean(),
  expiresAt: timeSchema,
});
export type AdminLoginResult = z.infer<typeof adminLoginResultSchema>;

export const adminMfaRequestSchema = z.object({ mfaToken: adminMfaTokenSchema });
export const adminTotpRequestSchema = z.object({ mfaToken: adminMfaTokenSchema, code: totpCodeSchema });

/** Shown once: the QR code's text and the same secret for typing in by hand. */
export const adminTotpEnrollmentSchema = z.object({
  otpauthUri: z.string().startsWith('otpauth://totp/'),
  secret: z.string().regex(/^[A-Z2-7]{32}$/),
});
export type AdminTotpEnrollment = z.infer<typeof adminTotpEnrollmentSchema>;

export const adminAccessTokenSchema = z.object({ accessToken: z.string().min(1), expiresAt: timeSchema });
export type AdminAccessToken = z.infer<typeof adminAccessTokenSchema>;

export const adminLogoutRequestSchema = z.object({
  /** Every session of this admin, not only this one. */
  all: z.boolean().optional(),
});

// ─── Accounts ──────────────────────────────────────────────────────────────

export const adminAccountSchema = z.object({
  id: adminIdSchema,
  email: z.string(),
  displayName: z.string(),
  roles: z.array(adminRoleKeySchema),
  createdAt: timeSchema,
  createdBy: adminIdSchema.nullable(),
  lastLoginAt: timeSchema.nullable(),
  totpEnabled: z.boolean(),
  disabledAt: timeSchema.nullable(),
  /** Set while 5 wrong passwords or codes keep the account locked. */
  lockedUntil: timeSchema.nullable(),
});
export type AdminAccount = z.infer<typeof adminAccountSchema>;

export const adminMeSchema = adminAccountSchema.extend({
  /** Every catalogue permission the roles grant (what the panel may show). */
  permissions: z.array(z.string()),
  sessionId: idSchema,
});
export type AdminMe = z.infer<typeof adminMeSchema>;

export const adminSessionSchema = z.object({
  id: idSchema,
  createdAt: timeSchema,
  refreshedAt: timeSchema,
  expiresAt: timeSchema,
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  current: z.boolean(),
});
export const adminSessionListSchema = z.object({ items: z.array(adminSessionSchema) });

export const adminPasswordChangeRequestSchema = z.object({ currentPassword: adminPasswordInputSchema, newPassword: adminPasswordInputSchema });

export const adminListSchema = pageSchema(adminAccountSchema);

export const adminCreateRequestSchema = z.object({
  email: adminEmailSchema,
  displayName: adminDisplayNameSchema,
  roles: z.array(adminRoleKeySchema).min(1).max(16),
  /** Omitted: the server makes one and answers it once. */
  password: adminPasswordInputSchema.optional(),
});

/** A new account, or a password reset: `initialPassword` is shown once and never stored in clear. */
export const adminCreatedSchema = z.object({ admin: adminAccountSchema, initialPassword: z.string().optional() });
export const adminPasswordResetSchema = z.object({ admin: adminAccountSchema, initialPassword: z.string() });

export const adminUpdateRequestSchema = z
  .object({ displayName: adminDisplayNameSchema.optional(), roles: z.array(adminRoleKeySchema).min(1).max(16).optional() })
  .refine((body) => body.displayName !== undefined || body.roles !== undefined, 'nothing to change');

export const adminRoleSchema = z.object({
  key: adminRoleKeySchema,
  names: z.record(z.string(), z.string()),
  /** The grants as stored (`users.*`, `*`, ...). */
  grants: z.array(z.string()),
  /** Every catalogue permission they cover. */
  permissions: z.array(z.string()),
});
export const adminRoleListSchema = z.object({ items: z.array(adminRoleSchema) });
