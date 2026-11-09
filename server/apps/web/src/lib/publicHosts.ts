import type { Brand } from '@app/shared';

/**
 * The site's own public hosts from the build's environment, over brand.json's,
 * so any build (the deploy image, CI, a local run) makes its canonical links,
 * sitemap and legal links for the domain it will be served on without
 * editing the brand file:
 *
 * - `PUBLIC_SITE_URL`: the site's origin (`https://example.com`, port 443) →
 *   `domains.legal`, and every `legal.*Url` that pointed at the previous
 *   `domains.legal` moves with it;
 * - `PUBLIC_LINKS_URL`: the app-links host → `domains.links` (unset: the
 *   site's host, when PUBLIC_SITE_URL is set).
 *
 * Unset or empty keeps brand.json's value.
 */

export class PublicHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicHostError';
  }
}

const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

function hostOf(name: string, value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new PublicHostError(`${name} is not a URL: "${text}"`);
  }
  if (url.protocol !== 'https:' || url.port !== '' || (url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    throw new PublicHostError(`${name} must be an https origin on port 443, without a path: "${text}"`);
  }
  if (!HOST.test(url.hostname)) throw new PublicHostError(`${name} must name a fully qualified host: "${text}"`);
  return url.hostname;
}

export function withPublicHosts(config: Brand, env: Readonly<Record<string, string | undefined>>): Brand {
  const site = hostOf('PUBLIC_SITE_URL', env['PUBLIC_SITE_URL']);
  const links = hostOf('PUBLIC_LINKS_URL', env['PUBLIC_LINKS_URL']) ?? site;
  if (site === undefined && links === undefined) return config;
  const previous = config.domains.legal;
  const legal = { ...config.legal };
  if (site !== undefined && site !== previous) {
    for (const [key, value] of Object.entries(legal)) {
      if (!key.endsWith('Url') || typeof value !== 'string') continue;
      try {
        const url = new URL(value);
        if (url.hostname !== previous) continue;
        url.hostname = site;
        url.port = '';
        (legal as Record<string, unknown>)[key] = url.toString();
      } catch {
        // Not a URL: left as it is (the brand schema checked it already).
      }
    }
  }
  return {
    ...config,
    domains: { ...config.domains, ...(site === undefined ? {} : { legal: site }), ...(links === undefined ? {} : { links }) },
    legal,
  };
}
