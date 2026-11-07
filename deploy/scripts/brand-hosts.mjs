// Rewrites the host names of a brand.json from the deployment's public
// addresses, so every host comes from the environment and none from a file:
//
//   node brand-hosts.mjs <brand.json in> [<brand.json out>]
//
// Each variable may hold a URL or a bare host; unset or empty keeps the
// file's value. A port in the value is dropped (public endpoints are on 443).
//
//   PUBLIC_API_URL       domains.api
//   PUBLIC_SITE_URL      domains.legal, and the host of every legal.*Url that
//                        pointed at the previous domains.legal
//   PUBLIC_LINKS_URL     domains.links (unset or empty: the site's host, which
//                        serves the app links when no separate host does)
//   PUBLIC_REALTIME_URL  domains.realtime
//   PUBLIC_RTC_URL       domains.rtc
//   PUBLIC_CDN_URL       domains.cdn (falls back to BUNDLED_CDN_URL when
//                        CDN_BASE_URL is empty, as the processes do)
//   PUBLIC_ADMIN_URL     domains.admin
//
// Prints the changed keys (never values that could be secrets: hosts only).
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function hostOf(value, name) {
  if (value === undefined) return undefined;
  let text = String(value).trim().split(',')[0]?.trim() ?? '';
  if (text === '') return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${name} is not a host name or URL: ${value}`);
  }
  const host = url.hostname.toLowerCase();
  if (!HOST.test(host)) throw new Error(`${name} is not a fully qualified host name: ${value}`);
  return host;
}

/** Applies the environment's hosts to a parsed brand; returns the list of changed keys. */
export function applyHosts(brand, env) {
  if (typeof brand !== 'object' || brand === null || typeof brand.domains !== 'object' || brand.domains === null) {
    throw new Error('brand.json has no "domains" object');
  }
  const changed = [];
  const set = (key, host) => {
    if (host === undefined || brand.domains[key] === host) return;
    brand.domains[key] = host;
    changed.push(`domains.${key}=${host}`);
  };
  const cdnSource = env.PUBLIC_CDN_URL || (env.CDN_BASE_URL ? env.CDN_BASE_URL : env.BUNDLED_CDN_URL);

  const previousLegal = brand.domains.legal;
  const site = hostOf(env.PUBLIC_SITE_URL, 'PUBLIC_SITE_URL');
  set('api', hostOf(env.PUBLIC_API_URL, 'PUBLIC_API_URL'));
  set('legal', site);
  set('links', hostOf(env.PUBLIC_LINKS_URL, 'PUBLIC_LINKS_URL') ?? site);
  set('realtime', hostOf(env.PUBLIC_REALTIME_URL, 'PUBLIC_REALTIME_URL'));
  set('rtc', hostOf(env.PUBLIC_RTC_URL, 'PUBLIC_RTC_URL'));
  set('cdn', hostOf(cdnSource, 'PUBLIC_CDN_URL'));
  set('admin', hostOf(env.PUBLIC_ADMIN_URL, 'PUBLIC_ADMIN_URL'));

  if (site !== undefined && site !== previousLegal && typeof brand.legal === 'object' && brand.legal !== null) {
    for (const [key, value] of Object.entries(brand.legal)) {
      if (!key.endsWith('Url') || typeof value !== 'string') continue;
      let url;
      try {
        url = new URL(value);
      } catch {
        continue;
      }
      if (url.hostname.toLowerCase() !== previousLegal) continue;
      url.hostname = site;
      url.port = '';
      brand.legal[key] = url.toString();
      changed.push(`legal.${key}`);
    }
  }
  return changed;
}

function main(argv) {
  const [input, output = input] = argv;
  if (!input) {
    console.error('usage: brand-hosts.mjs <brand.json in> [<brand.json out>]');
    process.exit(64);
  }
  const brand = JSON.parse(readFileSync(input, 'utf8'));
  const changed = applyHosts(brand, process.env);
  const tmp = `${output}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(brand, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, output);
  console.error(changed.length > 0 ? `brand-hosts: ${changed.join(', ')}` : 'brand-hosts: no host changed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`brand-hosts: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(65);
  }
}
