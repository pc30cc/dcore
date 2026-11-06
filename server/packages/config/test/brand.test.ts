import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { androidApplicationId, toPublicBrand } from '@app/shared';
import { BrandError, TEMPLATE_BRAND_ID, findBrandsDir, loadBrand } from '../src/index.js';

const brandsDir = findBrandsDir(import.meta.dirname);
const tmp = mkdtempSync(path.join(os.tmpdir(), 'brands-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface TemplateJson extends Record<string, unknown> {
  android: Record<string, unknown> & { package: string };
  domains: Record<string, unknown> & { api: string };
}

function readTemplate(): TemplateJson {
  return JSON.parse(readFileSync(path.join(brandsDir, TEMPLATE_BRAND_ID, 'brand.json'), 'utf8')) as TemplateJson;
}

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

  it('reads the store, signing and site settings', () => {
    const template = readTemplate();
    const fingerprint = 'ab:'.repeat(31) + 'cd';
    writeBrand('stores', {
      ...template,
      id: 'stores',
      android: { ...template.android, applicationId: { play: 'com.example.play' }, signingCertSha256: { play: fingerprint, bazaar: [] } },
      stores: { play: { listingUrl: 'https://play.google.com/store/apps/details?id=com.example.play', live: true }, bazaar: {} },
    });
    const brand = loadBrand({ brandId: 'stores', brandsDir: tmp });
    expect(brand.android?.signingCertSha256?.play).toEqual([fingerprint.toUpperCase()]);
    expect(brand.stores?.bazaar?.live).toBe(false);
    expect(androidApplicationId(brand, 'play')).toBe('com.example.play');
    expect(androidApplicationId(brand, 'bazaar')).toBe(template.android.package);
    const pub = toPublicBrand(brand);
    expect(pub.stores.play).toEqual({ live: true, listingUrl: 'https://play.google.com/store/apps/details?id=com.example.play' });
    expect(pub.apiDomain).toBe(template.domains.api);
    expect(pub).not.toHaveProperty('android');
  });

  it('rejects a live store without a listing, a bad fingerprint and asset paths outside the brand', () => {
    const template = readTemplate();
    writeBrand('badstores', {
      ...template,
      id: 'badstores',
      android: { ...template.android, signingCertSha256: { play: ['AB:CD'] } },
      stores: { bazaar: { live: true } },
      site: { screenshots: [{ file: '../other/shot.png', alt: { en: 'x' } }] },
    });
    let message = '';
    try {
      loadBrand({ brandId: 'badstores', brandsDir: tmp });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/stores\.bazaar\.listingUrl: a live store needs listingUrl/);
    expect(message).toMatch(/android\.signingCertSha256\.play/);
    expect(message).toMatch(/site\.screenshots\.0\.file/);
  });

  it('rejects path tricks in the brand id', () => {
    expect(() => loadBrand({ brandId: '../etc', brandsDir })).toThrow(BrandError);
  });
});
