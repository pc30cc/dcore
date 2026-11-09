/**
 * The admin's access token, in memory only (never in storage, so a page
 * reload asks for it again through the refresh cookie). Admin sign-in is not
 * connected yet, so nothing sets it and every admin call answers "not signed
 * in"; the sign-in flow calls {@link setAccessToken} once it exists.
 */

let token: string | null = null;
const listeners = new Set<() => void>();

export function accessToken(): string | null {
  return token;
}

export function setAccessToken(value: string | null): void {
  token = value;
  for (const listener of listeners) listener();
}

export function onSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
