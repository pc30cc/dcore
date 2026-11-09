import type { AdminAccessToken, AdminLoginResult, AdminMe, AdminTotpEnrollment } from '@app/shared';
import { ApiError, send } from './http';
import { heldToken, sessionState, setAccessToken, signedIn, signedOut } from './session';

/**
 * Admin sign-in against `/v1/admin/auth/*`:
 *
 * 1. `login(email, password)` gives a single-use ticket (5 minutes) and says
 *    whether the account still has to set up its authenticator;
 * 2. `verifyCode` (or, the first time, `enroll` then `confirmCode`) turns the
 *    ticket and a 6-digit code into an access token (10 minutes, memory
 *    only) and the refresh cookie (HttpOnly; the browser keeps it);
 * 3. `refreshSession()` trades the cookie for a new token (the cookie is
 *    rotated each time). Concurrent callers share one request.
 */

const AUTH = '/v1/admin/auth';

export function login(email: string, password: string): Promise<AdminLoginResult> {
  return send<AdminLoginResult>(`${AUTH}/login`, { method: 'POST', body: { email: email.trim(), password } });
}

const enrollments = new Map<string, Promise<AdminTotpEnrollment>>();

/**
 * A new authenticator secret for the ticket. Asked once per ticket: a second
 * request would replace the secret already shown (React runs effects twice
 * in development, and a re-render must not change the QR code).
 */
export function enroll(mfaToken: string): Promise<AdminTotpEnrollment> {
  let pending = enrollments.get(mfaToken);
  if (!pending) {
    pending = send<AdminTotpEnrollment>(`${AUTH}/totp/enroll`, { method: 'POST', body: { mfaToken } });
    enrollments.set(mfaToken, pending);
    pending.catch(() => enrollments.delete(mfaToken));
  }
  return pending;
}

async function finish(result: AdminAccessToken): Promise<AdminMe> {
  setAccessToken(result.accessToken, result.expiresAt);
  const me = await loadMe(result.accessToken);
  signedIn(me);
  return me;
}

/** The first code of a new secret: turns it on and signs in. */
export async function confirmCode(mfaToken: string, code: string): Promise<AdminMe> {
  const result = await send<AdminAccessToken>(`${AUTH}/totp/confirm`, { method: 'POST', body: { mfaToken, code }, withCookie: true });
  enrollments.delete(mfaToken);
  return finish(result);
}

export async function verifyCode(mfaToken: string, code: string): Promise<AdminMe> {
  return finish(await send<AdminAccessToken>(`${AUTH}/totp`, { method: 'POST', body: { mfaToken, code }, withCookie: true }));
}

export function loadMe(accessToken: string): Promise<AdminMe> {
  return send<AdminMe>('/v1/admin/me', { token: accessToken });
}

let refreshing: Promise<boolean> | null = null;

/**
 * A new access token from the refresh cookie. True when it worked; false
 * when the cookie was refused (the session is over: `expired` if someone was
 * signed in, else `signedOut`). A network failure throws and changes nothing.
 */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const result = await send<AdminAccessToken>(`${AUTH}/refresh`, { method: 'POST', withCookie: true });
      setAccessToken(result.accessToken, result.expiresAt);
      // The roles may have changed since the last look; one read keeps the menus right.
      signedIn(await loadMe(result.accessToken));
      return true;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        const before = sessionState().status;
        signedOut(before === 'signedIn' || before === 'expired' ? 'expired' : 'signedOut');
        return false;
      }
      throw error;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

let started: Promise<void> | null = null;

/** Once per page: is someone signed in already (a refresh cookie from an earlier visit)? */
export function startSession(): Promise<void> {
  started ??= refreshSession().then(
    () => undefined,
    (error: unknown) => {
      // The API could not be reached: try again on the next look.
      started = null;
      throw error;
    },
  );
  return started;
}

/** Signs out this session (or every session of this admin) and forgets it here, whatever the API answers. */
export async function logout(all = false): Promise<void> {
  try {
    await send<undefined>(`${AUTH}/logout`, { method: 'POST', body: all ? { all: true } : {}, token: heldToken(), withCookie: true });
  } catch {
    // Already over on the server, or unreachable: the token is dropped here either way.
  } finally {
    signedOut('signedOut', true);
  }
}

export function resetAuthForTests(): void {
  enrollments.clear();
  refreshing = null;
  started = null;
}
