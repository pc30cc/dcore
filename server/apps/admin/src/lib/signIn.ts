/**
 * The sign-in in progress between its steps: the single-use ticket the
 * password step gave (5 minutes), whether the authenticator still has to be
 * set up, and where to go once signed in. Memory only, never storage or the
 * history state: a reload starts again from the e-mail and password.
 */

export interface PendingSignIn {
  mfaToken: string;
  enrollRequired: boolean;
  expiresAtMs: number;
  email: string;
  /** The panel path to open after the code step. */
  returnTo: string;
}

let pending: PendingSignIn | null = null;

export function startPendingSignIn(value: PendingSignIn): void {
  pending = value;
}

/** The ticket while it is still valid, else null. */
export function pendingSignIn(now = Date.now()): PendingSignIn | null {
  if (pending && pending.expiresAtMs <= now) pending = null;
  return pending;
}

export function clearPendingSignIn(): void {
  pending = null;
}

/** Only panel paths are followed after sign-in (never another origin or the sign-in pages). */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/login')) return '/';
  return value;
}

/** What a typed code becomes: ASCII digits only (Persian and Arabic-Indic digits count), at most 6. */
export function normalizeCode(value: string): string {
  return value
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\D/g, '')
    .slice(0, 6);
}

/** The base32 secret in groups of four, for typing it by hand. */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}
