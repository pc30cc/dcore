// Adds the run-time configuration script to the admin panel's built pages
// (index.html and its copy per language, index.<locale>.html), first in
// <head>, so window.__APP_CONFIG__ is set before the page's inline script
// and the app's module script run (module scripts are deferred).
//
//   node admin-index.mjs <dist/index.html> [<dist/index.<locale>.html> ...]
import { readFileSync, writeFileSync } from 'node:fs';

const TAG = '<script src="/config.js"></script>';
const files = process.argv.slice(2);
if (files.length === 0) throw new Error('usage: admin-index.mjs <index.html> [...]');
for (const file of files) {
  const html = readFileSync(file, 'utf8');
  if (html.includes(TAG)) continue;
  const at = html.search(/<head(\s[^>]*)?>/i);
  if (at < 0) throw new Error(`${file} has no <head>`);
  const end = html.indexOf('>', at) + 1;
  writeFileSync(file, `${html.slice(0, end)}\n    ${TAG}${html.slice(end)}`);
}
