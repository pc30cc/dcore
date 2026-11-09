/**
 * The panel's addresses, read at run time: the container writes `/config.js`
 * when it starts (`window.__APP_CONFIG__ = { apiOrigin, cdnOrigin }`, from the
 * deployment's environment), and index.html loads it before the app, so no
 * host is part of the build and one image serves any domain. A development
 * server has no `/config.js`: it uses `VITE_API_BASE_URL`, else the local
 * API on port 8080.
 */

export interface RuntimeConfig {
  /** The API's origin, e.g. https://api.example.com. */
  apiOrigin: string;
  /** The CDN's origin (photos the panel shows); null when none is configured. */
  cdnOrigin: string | null;
}

export type RuntimeConfigResult = { ok: true; config: RuntimeConfig } | { ok: false; reason: string };

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

/** `scheme://host[:port]` (https, or http for a local address), else null. */
export function originOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL.has(url.hostname));
  if (!secure || url.username !== '' || url.password !== '' || (url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') return null;
  return url.origin;
}

/** Reads the configuration the container wrote; `dev` and `devApiBaseUrl` describe a development server. */
export function readRuntimeConfig(source: unknown, dev: boolean, devApiBaseUrl: string | undefined): RuntimeConfigResult {
  if (source !== undefined && source !== null) {
    const record = source as { apiOrigin?: unknown; cdnOrigin?: unknown };
    const apiOrigin = originOf(record.apiOrigin);
    if (!apiOrigin) return { ok: false, reason: '/config.js names no usable API origin' };
    return { ok: true, config: { apiOrigin, cdnOrigin: originOf(record.cdnOrigin) } };
  }
  if (dev) {
    const apiOrigin = originOf(devApiBaseUrl ?? 'http://localhost:8080');
    if (apiOrigin) return { ok: true, config: { apiOrigin, cdnOrigin: null } };
    return { ok: false, reason: 'VITE_API_BASE_URL is not an origin' };
  }
  return { ok: false, reason: '/config.js was not loaded' };
}

declare global {
  interface Window {
    __APP_CONFIG__?: unknown;
  }
}

let cached: RuntimeConfigResult | null = null;

/** The configuration of this page, read once. */
export function runtimeConfig(): RuntimeConfigResult {
  cached ??= readRuntimeConfig(typeof window === 'undefined' ? undefined : window.__APP_CONFIG__, import.meta.env.DEV, import.meta.env.VITE_API_BASE_URL);
  return cached;
}
