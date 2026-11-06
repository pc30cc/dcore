import type { Brand } from '@app/shared';
import { brandConfig } from './brand';

/**
 * Build-time settings of the website (environment of `astro build`, or `.env`):
 *
 * - `PUBLIC_API_ORIGIN`: where the deletion forms post, e.g. a staging API
 *   (default `https://<domains.api>`). An origin only; plain http is accepted
 *   for localhost, for local runs.
 * - `PUBLIC_GOOGLE_WEB_CLIENT_ID`: the Google web client id for "signed in
 *   with Google" on the deletion page (default `android.googleWebClientId`;
 *   none, no Google button).
 * - `PUBLIC_DELETION_GRACE_DAYS`: the days between a deletion request and the
 *   purge, as the server's setting has it (default 30).
 */
export interface SiteSettings {
  apiOrigin: string;
  googleWebClientId: string | undefined;
  deletionGraceDays: number;
}

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const googleClientIdPattern = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

function apiOriginFrom(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SettingsError(`PUBLIC_API_ORIGIN is not a URL: "${value}"`);
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && localHosts.has(url.hostname));
  if (!secure) throw new SettingsError(`PUBLIC_API_ORIGIN must be https (http only for localhost): "${value}"`);
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new SettingsError(`PUBLIC_API_ORIGIN must be an origin without a path: "${value}"`);
  }
  return url.origin;
}

export function readSettings(env: Readonly<Record<string, string | undefined>>, config: Brand): SiteSettings {
  const apiOrigin = env['PUBLIC_API_ORIGIN']?.trim() ? apiOriginFrom(env['PUBLIC_API_ORIGIN'].trim()) : `https://${config.domains.api}`;

  const clientId = env['PUBLIC_GOOGLE_WEB_CLIENT_ID']?.trim() || config.android?.googleWebClientId || undefined;
  if (clientId !== undefined && !googleClientIdPattern.test(clientId)) {
    throw new SettingsError(`PUBLIC_GOOGLE_WEB_CLIENT_ID is not a Google OAuth client id: "${clientId}"`);
  }

  const graceText = env['PUBLIC_DELETION_GRACE_DAYS']?.trim();
  const deletionGraceDays = graceText ? Number(graceText) : 30;
  if (!Number.isInteger(deletionGraceDays) || deletionGraceDays < 1 || deletionGraceDays > 365) {
    throw new SettingsError(`PUBLIC_DELETION_GRACE_DAYS must be a whole number of days from 1 to 365: "${graceText}"`);
  }

  return { apiOrigin, googleWebClientId: clientId, deletionGraceDays };
}

/** The process environment wins; PUBLIC_* values may also come from a `.env` file (Vite's `import.meta.env`). */
export const settings: SiteSettings = readSettings({ ...(import.meta.env as Record<string, string | undefined>), ...process.env }, brandConfig);
