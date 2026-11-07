// Copies the non-TypeScript files the server entry reads at run time (Lua
// scripts) next to the compiled modules in dist/.
import { cpSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'src');
const target = join(root, 'dist');

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.lua')) cpSync(path, join(target, relative(source, path)));
  }
}

walk(source);
