import { OWNER_ROLE, type AdminMe, type Permission } from '@app/shared';

/**
 * The signed-in admin, in memory only. The access token is never written to
 * storage: a reload gets a new one through the refresh cookie (HttpOnly, so
 * no script can read it). The state is a small external store; components
 * read it with `useSession()`.
 *
 * - `unknown`: the page just loaded and the refresh cookie is being tried;
 * - `signedOut`: nobody is signed in (no cookie, or it was refused);
 * - `signedIn`: a token and the admin's account and permissions;
 * - `expired`: the session ended while the panel was open (idle limit,
 *   signed out elsewhere, roles changed): sign in again.
 */

export type SessionStatus = 'unknown' | 'signedOut' | 'signedIn' | 'expired';

export interface SessionState {
  readonly status: SessionStatus;
  readonly me: AdminMe | null;
  /** `signedOut` by the admin's own sign-out (the sign-in page says so). */
  readonly byUser?: boolean;
}

interface Token {
  value: string;
  expiresAtMs: number;
}

let token: Token | null = null;
let state: SessionState = { status: 'unknown', me: null };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** A token is renewed this long before it runs out, so a request never carries one that expires on the way. */
export const TOKEN_MARGIN_MS = 30_000;

export function sessionState(): SessionState {
  return state;
}

/** The access token while it has more than the margin left, else null (the caller refreshes first). */
export function accessToken(now = Date.now()): string | null {
  if (!token || token.expiresAtMs - TOKEN_MARGIN_MS <= now) return null;
  return token.value;
}

/** Any token held, even one about to run out (sign-out sends it with the cookie). */
export function heldToken(): string | null {
  return token?.value ?? null;
}

export function setAccessToken(value: string, expiresAt: string): void {
  const expiresAtMs = Date.parse(expiresAt);
  token = { value, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 60_000 };
}

export function signedIn(me: AdminMe): void {
  state = { status: 'signedIn', me };
  emit();
}

/** Forgets the token and the account: `expired` when the session ended under an open panel. */
export function signedOut(status: 'signedOut' | 'expired' = 'signedOut', byUser = false): void {
  token = null;
  state = byUser ? { status, me: null, byUser } : { status, me: null };
  emit();
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Kept for screens that reload when the session changes. */
export const onSessionChange = subscribeSession;

/** Whether the admin's roles grant `permission` (the API checks it again on every call). */
export function can(me: AdminMe | null, permission: Permission): boolean {
  return me?.permissions.includes(permission) ?? false;
}

export function isOwner(me: AdminMe | null): boolean {
  return me?.roles.includes(OWNER_ROLE) ?? false;
}

/** Tests start from a clean slate. */
export function resetSessionForTests(): void {
  token = null;
  state = { status: 'unknown', me: null };
  emit();
}
