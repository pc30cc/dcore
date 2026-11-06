import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import {
  FIXTURE_API_ORIGIN,
  FIXTURE_BRAND_ID,
  FIXTURE_GOOGLE_CLIENT_ID,
  FIXTURE_GRACE_DAYS,
  FIXTURE_PNG,
  FIXTURE_SCREENSHOT,
  fixtureBrand,
} from './support/fixture';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The site built for the template brand with no build settings. */
    templateDist: string;
    /** The site built for the fixture brand with every build setting. */
    fixtureDist: string;
  }
}

const webRoot = path.resolve(import.meta.dirname, '..');
const repoBrands = path.resolve(webRoot, '..', '..', '..', 'brands');
const astro = path.join(webRoot, 'node_modules', 'astro', 'bin', 'astro.mjs');

function build(outDir: string, env: Record<string, string>): void {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('PUBLIC_') && key !== 'BRAND' && key !== 'BRANDS_DIR'),
  );
  const result = spawnSync(process.execPath, [astro, 'build', '--outDir', outDir], {
    cwd: webRoot,
    // A production build, as deployed (vitest itself runs with NODE_ENV=test).
    env: { ...clean, ...env, NODE_ENV: 'production', ASTRO_TELEMETRY_DISABLED: '1' },
    encoding: 'utf8',
    timeout: 240_000,
  });
  if (result.status !== 0) {
    throw new Error(`astro build failed (${outDir}):\n${result.stdout}\n${result.stderr}`);
  }
}

/** Builds the site twice before the tests: once for the template brand, once for the fixture brand. */
export default function setup(project: TestProject): () => void {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'web-build-'));
  const templateDist = path.join(tmp, 'template');
  const fixtureDist = path.join(tmp, 'fixture');
  const brandsDir = path.join(tmp, 'brands');

  const template = JSON.parse(readFileSync(path.join(repoBrands, '_template', 'brand.json'), 'utf8')) as Record<string, unknown>;
  mkdirSync(path.join(brandsDir, FIXTURE_BRAND_ID, path.dirname(FIXTURE_SCREENSHOT)), { recursive: true });
  writeFileSync(path.join(brandsDir, FIXTURE_BRAND_ID, 'brand.json'), JSON.stringify(fixtureBrand(template), null, 2));
  writeFileSync(path.join(brandsDir, FIXTURE_BRAND_ID, FIXTURE_SCREENSHOT), FIXTURE_PNG);

  // Empty values override any local .env, so this build sees no setting at all.
  build(templateDist, { PUBLIC_API_ORIGIN: '', PUBLIC_GOOGLE_WEB_CLIENT_ID: '', PUBLIC_DELETION_GRACE_DAYS: '' });
  build(fixtureDist, {
    BRAND: FIXTURE_BRAND_ID,
    BRANDS_DIR: brandsDir,
    PUBLIC_API_ORIGIN: FIXTURE_API_ORIGIN,
    PUBLIC_GOOGLE_WEB_CLIENT_ID: FIXTURE_GOOGLE_CLIENT_ID,
    PUBLIC_DELETION_GRACE_DAYS: String(FIXTURE_GRACE_DAYS),
  });

  project.provide('templateDist', templateDist);
  project.provide('fixtureDist', fixtureDist);
  return () => rmSync(tmp, { recursive: true, force: true });
}
