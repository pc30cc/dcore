import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { toPublicBrand } from '@app/shared';
import { BrandError, TEMPLATE_BRAND_ID, findBrandsDir, loadBrand } from '../src/index.js';

const brandsDir = findBrandsDir(import.meta.dirname);
const tmp = mkdtempSync(path.join(os.tmpdir(), 'brands-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function writeBrand(id: string, data: unknown): void {
  mkdirSync(path.join(tmp, id), { recursive: true });
  writeFileSync(path.join(tmp, id, 'brand.json'), JSON.stringify(data));
}

describe('loadBrand', () => {
  it('validates the template brand', () => {
    const brand = loadBrand({ brandId: TEMPLATE_BRAND_ID, brandsDir });
    expect(brand.id).toBe(TEMPLATE_BRAND_ID);
    expect(brand.locales).toContain(brand.defaultLocale);
    const pub = toPublicBrand(brand);
    expect(pub).not.toHaveProperty('ios');
    expect(pub.legal.supportEmail).toContain('@');
  });

  it('rejects an invalid brand with every issue listed', () => {
    const template = JSON.parse(readFileSync(path.join(brandsDir, TEMPLATE_BRAND_ID, 'brand.json'), 'utf8')) as Record<string, unknown>;
    writeBrand('broken', { ...template, id: 'broken', defaultLocale: 'de', colors: { brand: { light: 'red', dark: '#000000' } } });
    let message = '';
    try {
      loadBrand({ brandId: 'broken', brandsDir: tmp });
    } catch (error) {
      expect(error).toBeInstanceOf(BrandError);
      message = (error as Error).message;
    }
    expect(message).toMatch(/defaultLocale/);
    expect(message).toMatch(/colors\.brand\.light: must be #RRGGBB/);
    expect(message).toMatch(/colors\.onBrand/);
  });

  it('rejects a brand whose id does not match its folder', () => {
    const template = JSON.parse(readFileSync(path.join(brandsDir, TEMPLATE_BRAND_ID, 'brand.json'), 'utf8')) as Record<string, unknown>;
    writeBrand('folder', { ...template, id: 'other' });
    expect(() => loadBrand({ brandId: 'folder', brandsDir: tmp })).toThrow(/expected "folder"/);
  });

  it('rejects path tricks in the brand id', () => {
    expect(() => loadBrand({ brandId: '../etc', brandsDir })).toThrow(BrandError);
  });
});
