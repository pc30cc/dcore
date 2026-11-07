// Writes the nginx snippet with the Content-Security-Policy header of a built
// site, to stdout.
//
//   node csp.mjs admin <dist/index.html> <api origin> [cdn origin]
//   node csp.mjs web
//
// admin: scripts from the site itself plus the SHA-256 of every inline
// <script> of index.html (the theme bootstrap), connections to the API only.
// web: the pages carry their own policy in a <meta> tag (per page, with
// hashes); a <meta> policy cannot set frame-ancestors, so the header adds
// only that, and nothing that could contradict the page's own policy.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

function origin(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL: ${value}`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error(`${name} must be https: ${value}`);
  }
  if (url.origin !== value.replace(/\/+$/, '')) throw new Error(`${name} must be an origin without a path: ${value}`);
  return url.origin;
}

function inlineScriptHashes(html) {
  const hashes = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = match[1] ?? '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    hashes.push(`'sha256-${createHash('sha256').update(match[2] ?? '', 'utf8').digest('base64')}'`);
  }
  return [...new Set(hashes)];
}

function header(policy) {
  if (/["\\\n]/.test(policy)) throw new Error('policy contains a character nginx would misread');
  return `# Generated at build time by csp.mjs.\nadd_header Content-Security-Policy "${policy}" always;\n`;
}

const [kind, ...args] = process.argv.slice(2);
if (kind === 'admin') {
  const [file, api, cdn] = args;
  if (!file || !api) throw new Error('usage: csp.mjs admin <index.html> <api origin> [cdn origin]');
  const html = readFileSync(file, 'utf8');
  const apiOrigin = origin(api, 'API origin');
  const cdnOrigin = cdn ? origin(cdn, 'CDN origin') : '';
  const policy = [
    "default-src 'self'",
    ["script-src 'self'", ...inlineScriptHashes(html)].join(' '),
    // React, Radix and Tailwind set inline styles; scripts stay hash-locked.
    "style-src 'self' 'unsafe-inline'",
    ['img-src', "'self'", 'data:', 'blob:', cdnOrigin].filter(Boolean).join(' '),
    "font-src 'self' data:",
    `connect-src 'self' ${apiOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  process.stdout.write(header(policy));
} else if (kind === 'web') {
  process.stdout.write(header("frame-ancestors 'none'"));
} else {
  throw new Error('usage: csp.mjs admin|web ...');
}
