import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { brandSchema, type Brand } from '@app/shared';
import { z } from 'zod';

/** The brand used when `BRAND` is unset: neutral placeholder values, never shipped. */
export const TEMPLATE_BRAND_ID = '_template';

export class BrandError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BrandError';
  }
}

/**
 * Finds the repository's `brands/` directory by walking up from `startDir`
 * (the monorepo lives in `server/`, the brands next to it).
 */
export function findBrandsDir(startDir: string = process.cwd()): string {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, 'brands');
    if (existsSync(path.join(candidate, TEMPLATE_BRAND_ID, 'brand.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new BrandError(`no brands/${TEMPLATE_BRAND_ID}/brand.json found above ${startDir}`);
    }
    dir = parent;
  }
}

/** The brand variables of a server process (the API and the worker read the same two). */
export const brandEnvShape = {
  /** The brand served (brands/<id>/brand.json); a process refuses the template in production. */
  BRAND: z.string().regex(/^[a-z0-9_][a-z0-9_-]{0,39}$/).default(TEMPLATE_BRAND_ID),
  /** Where the brands folder is; found by walking up from the working directory when unset. */
  BRANDS_DIR: z.string().min(1).optional(),
};

export interface LoadBrandOptions {
  /** Defaults to the `BRAND` environment variable, then to the template. */
  brandId?: string | undefined;
  /** Defaults to {@link findBrandsDir} from the current directory. */
  brandsDir?: string | undefined;
}

/** Reads and validates `brands/<id>/brand.json`. */
export function loadBrand(options: LoadBrandOptions = {}): Brand {
  const brandId = options.brandId ?? process.env['BRAND'] ?? TEMPLATE_BRAND_ID;
  if (!/^[a-z0-9_][a-z0-9_-]{0,39}$/.test(brandId)) {
    throw new BrandError(`invalid brand id "${brandId}"`);
  }
  const brandsDir = options.brandsDir ?? findBrandsDir();
  const file = path.join(brandsDir, brandId, 'brand.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new BrandError(`cannot read ${file}`, { cause: error });
  }
  const parsed = brandSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new BrandError(`${file} is not a valid brand:\n${issues.join('\n')}`);
  }
  if (parsed.data.id !== brandId) {
    throw new BrandError(`${file} says id "${parsed.data.id}", expected "${brandId}"`);
  }
  return parsed.data;
}
