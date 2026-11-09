import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appConfigSchemas, brandSchema, configSchema, parseAppConfigValue } from '../../src/index.js';

/** brand.json's `welcome` and `origins` blocks, the panel's welcome overrides and the config's welcome. */

const template = JSON.parse(readFileSync(new URL('../../../../../brands/_template/brand.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const withBlock = (key: string, value: unknown) => ({ ...template, [key]: value });
const welcome = template['welcome'] as Record<string, unknown>;
const key = (n: number) => `${'A'.repeat(42)}${'AEIM'[n]}`;

describe('brand.json welcome', () => {
  it('validates the template: texts per locale, the headline marks its emphasis in pairs, three colours, picture files', () => {
    const brand = brandSchema.parse(template);
    expect(brand.welcome?.headline?.en).toContain('*goes here*');
    expect(brand.welcome?.gradient).toEqual({ top: '#A9C2EE', middle: '#F06A3C', bottom: '#2B0A0E' });
    expect(brand.welcome?.images).toEqual([]);
  });

  it('refuses an unpaired asterisk, a colour that is not #RRGGBB and a picture that is not a file name', () => {
    expect(brandSchema.safeParse(withBlock('welcome', { ...welcome, headline: { en: 'One *star' } })).success).toBe(false);
    expect(brandSchema.safeParse(withBlock('welcome', { ...welcome, gradient: { top: 'red', middle: '#F06A3C', bottom: '#2B0A0E' } })).success).toBe(false);
    expect(brandSchema.safeParse(withBlock('welcome', { ...welcome, images: ['../escape.png'] })).success).toBe(false);
    expect(brandSchema.safeParse(withBlock('welcome', { ...welcome, images: ['https://cdn.example.com/a.webp'] })).success).toBe(false);
    expect(brandSchema.safeParse(withBlock('welcome', { ...welcome, images: ['face_1.webp', 'b.jpg'] })).success).toBe(true);
    // The block is optional.
    const { welcome: _omitted, ...without } = template;
    expect(brandSchema.parse(without).welcome).toBeUndefined();
  });
});

describe('brand.json origins', () => {
  it('lists at most two public keys, each id once, and https bootstrap URLs; absent means none', () => {
    expect(brandSchema.parse(template).origins).toEqual({
      $comment: expect.any(String) as string,
      publicKeys: [],
      bootstrap: ['https://cdn.example.com/bootstrap/origins.json'],
    });
    const { origins: _omitted, ...without } = template;
    expect(brandSchema.parse(without).origins).toEqual({ publicKeys: [], bootstrap: [] });
    const two = { publicKeys: [{ kid: 'o1', key: key(0) }, { kid: 'o2', key: key(1) }], bootstrap: [] };
    expect(brandSchema.parse(withBlock('origins', two)).origins.publicKeys).toHaveLength(2);
    expect(brandSchema.safeParse(withBlock('origins', { ...two, publicKeys: [...two.publicKeys, { kid: 'o3', key: key(2) }] })).success).toBe(false);
    expect(brandSchema.safeParse(withBlock('origins', { ...two, publicKeys: [{ kid: 'o1', key: key(0) }, { kid: 'o1', key: key(1) }] })).success).toBe(false);
    expect(brandSchema.safeParse(withBlock('origins', { publicKeys: [{ kid: 'o1', key: 'not-a-key' }] })).success).toBe(false);
    expect(brandSchema.safeParse(withBlock('origins', { bootstrap: ['http://cdn.example.com/o.json'] })).success).toBe(false);
  });
});

describe('the panel\'s welcome overrides (app_config brand.welcome) and the config\'s welcome', () => {
  it('accept texts per locale, colours and https picture URLs, nothing else', () => {
    expect(parseAppConfigValue('brand.welcome', {})).toEqual({});
    const full = {
      eyebrow: { fa: 'خوش آمدید' },
      headline: { en: 'Meet *someone* new' },
      gradient: { top: '#000000', middle: '#111111', bottom: '#222222' },
      images: ['https://cdn.example.com/brand/welcome/a.webp'],
    };
    expect(parseAppConfigValue('brand.welcome', full)).toEqual(full);
    expect(() => parseAppConfigValue('brand.welcome', { images: ['http://cdn.example.com/a.webp'] })).toThrow(/brand\.welcome/);
    expect(() => parseAppConfigValue('brand.welcome', { headline: { en: 'odd *' } })).toThrow(/brand\.welcome/);
    expect(() => parseAppConfigValue('brand.welcome', { extra: true })).toThrow(/brand\.welcome/);
    expect(appConfigSchemas['origins.hosts'].parse(null)).toBeNull();
  });

  it('the config document carries the welcome with https pictures only', () => {
    const doc = JSON.parse(readFileSync(new URL('../../fixtures/v1/config.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    expect(configSchema.parse(doc).welcome?.images).toHaveLength(2);
    expect(configSchema.safeParse({ ...doc, welcome: { images: ['http://cdn.example.com/a.webp'] } }).success).toBe(false);
  });
});
