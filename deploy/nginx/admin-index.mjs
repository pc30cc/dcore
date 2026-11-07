// Adds the run-time configuration script to the admin panel's built
// index.html, first in <head>, so window.__APP_CONFIG__ is set before the
// app's module script runs (module scripts are deferred).
//
//   node admin-index.mjs <dist/index.html>
import { readFileSync, writeFileSync } from 'node:fs';

const TAG = '<script src="/config.js"></script>';
const [file] = process.argv.slice(2);
if (!file) throw new Error('usage: admin-index.mjs <index.html>');
const html = readFileSync(file, 'utf8');
if (html.includes(TAG)) process.exit(0);
const at = html.search(/<head(\s[^>]*)?>/i);
if (at < 0) throw new Error(`${file} has no <head>`);
const end = html.indexOf('>', at) + 1;
writeFileSync(file, `${html.slice(0, end)}\n    ${TAG}${html.slice(end)}`);
