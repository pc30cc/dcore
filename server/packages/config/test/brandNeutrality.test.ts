import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEMPLATE_BRAND_ID, findBrandsDir, loadBrand } from '../src/index.js';

/**
 * No brand name or brand domain may appear in code. This scans the whole
 * repository, outside `brands/` and `docs/`, for the names and domains of
 * every registered brand.
 */
const brandsDir = findBrandsDir(import.meta.dirname);
const repoRoot = path.dirname(brandsDir);

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.gradle', '.kotlin', '.astro', '.idea', '.vite',
  'coverage', 'brands', 'docs',
]);
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx', '.astro', '.json', '.jsonc', '.html', '.css',
  '.sql', '.md', '.yaml', '.yml', '.toml', '.properties', '.sh', '.kt', '.kts', '.java', '.xml', '.pro', '.txt',
  '.example', '.conf', '.ini',
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function* textFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* textFiles(path.join(dir, entry.name));
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      const file = path.join(dir, entry.name);
      if (statSync(file).size <= MAX_FILE_BYTES) yield file;
    }
  }
}

function registeredBrandTerms(): Map<string, string> {
  const terms = new Map<string, string>();
  for (const entry of readdirSync(brandsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === TEMPLATE_BRAND_ID) continue;
    const brand = loadBrand({ brandId: entry.name, brandsDir });
    for (const term of [brand.appName, brand.shortName, ...Object.values(brand.domains)]) {
      if (typeof term === 'string' && term.length >= 3) terms.set(term, brand.id);
    }
  }
  return terms;
}

describe('brand neutrality', () => {
  it('finds no registered brand name or domain in code', () => {
    const terms = registeredBrandTerms();
    const hits: string[] = [];
    if (terms.size > 0) {
      const escaped = [...terms.keys()].map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${escaped.join('|')})(?![\\p{L}\\p{N}])`, 'u');
      for (const file of textFiles(repoRoot)) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, index) => {
          const match = pattern.exec(line);
          if (match) hits.push(`${path.relative(repoRoot, file)}:${index + 1}: "${match[1]}" (brand ${terms.get(match[1] ?? '')})`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
