import { createHash } from 'node:crypto';
import { brandSchema, type Brand, type PublicBrand } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { assetLinks } from '../src/lib/assetLinks';
import { brandConfig } from '../src/lib/brand';
import { contentSecurityPolicy, scriptHash } from '../src/lib/csp';
import { imageSize } from '../src/lib/imageSize';
import { readSettings, SettingsError } from '../src/lib/settings';
import { PLAY_SUBSCRIPTIONS_URL, liveStores, storeOrder, subscriptionCentres } from '../src/lib/stores';
import { FIXTURE_PNG } from './support/fixture';

const fingerprint = (byte: string) => `${`${byte}:`.repeat(31)}${byte}`;

function brandWith(android: Record<string, unknown>): Brand {
  return brandSchema.parse({ ...brandConfig, android: { package: 'com.example.app', ...android } });
}

describe('assetLinks', () => {
  it('lists both store packages with their certificates', () => {
    const brand = brandWith({
      applicationId: { play: 'com.example.play', bazaar: 'com.example.bazaar' },
      signingCertSha256: { play: [fingerprint('aa'), fingerprint('BB')], bazaar: fingerprint('cc') },
    });
    expect(assetLinks(brand)).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: 'com.example.play', sha256_cert_fingerprints: [fingerprint('AA'), fingerprint('BB')] },
      },
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: 'com.example.bazaar', sha256_cert_fingerprints: [fingerprint('CC')] },
      },
    ]);
  });

  it('merges the stores of one application id and drops a store without certificates', () => {
    const brand = brandWith({ signingCertSha256: { play: [fingerprint('AA')], bazaar: [fingerprint('AA'), fingerprint('DD')] } });
    expect(assetLinks(brand)).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: 'com.example.app', sha256_cert_fingerprints: [fingerprint('AA'), fingerprint('DD')] },
      },
    ]);
    expect(assetLinks(brandWith({ signingCertSha256: { play: [], bazaar: [fingerprint('EE')] } }))).toHaveLength(1);
  });

  it('is empty when brand.json has no certificates', () => {
    expect(assetLinks(brandWith({}))).toEqual([]);
    expect(assetLinks(brandWith({ signingCertSha256: { play: [], bazaar: [] } }))).toEqual([]);
    expect(assetLinks(brandConfig)).toEqual([]);
  });
});

describe('build settings', () => {
  it('defaults to the brand API, no Google button and 30 days', () => {
    expect(readSettings({}, brandConfig)).toEqual({
      apiOrigin: `https://${brandConfig.domains.api}`,
      googleWebClientId: undefined,
      deletionGraceDays: 30,
    });
  });

  it('takes an API origin, plain http only for localhost', () => {
    expect(readSettings({ PUBLIC_API_ORIGIN: 'https://staging-api.example.com/' }, brandConfig).apiOrigin).toBe('https://staging-api.example.com');
    expect(readSettings({ PUBLIC_API_ORIGIN: 'http://localhost:3000' }, brandConfig).apiOrigin).toBe('http://localhost:3000');
    expect(() => readSettings({ PUBLIC_API_ORIGIN: 'http://api.example.com' }, brandConfig)).toThrow(SettingsError);
    expect(() => readSettings({ PUBLIC_API_ORIGIN: 'https://api.example.com/v1' }, brandConfig)).toThrow(/without a path/);
    expect(() => readSettings({ PUBLIC_API_ORIGIN: 'api.example.com' }, brandConfig)).toThrow(/not a URL/);
  });

  it('checks the Google client id and the grace period', () => {
    const id = '123-abc.apps.googleusercontent.com';
    expect(readSettings({ PUBLIC_GOOGLE_WEB_CLIENT_ID: id }, brandConfig).googleWebClientId).toBe(id);
    expect(readSettings({}, brandWith({ googleWebClientId: id })).googleWebClientId).toBe(id);
    expect(() => readSettings({ PUBLIC_GOOGLE_WEB_CLIENT_ID: 'not-a-client' }, brandConfig)).toThrow(SettingsError);
    expect(readSettings({ PUBLIC_DELETION_GRACE_DAYS: '14' }, brandConfig).deletionGraceDays).toBe(14);
    expect(() => readSettings({ PUBLIC_DELETION_GRACE_DAYS: '0' }, brandConfig)).toThrow(SettingsError);
    expect(() => readSettings({ PUBLIC_DELETION_GRACE_DAYS: '2.5' }, brandConfig)).toThrow(SettingsError);
  });
});

describe('stores', () => {
  const base: PublicBrand['stores'] = {
    play: { live: true, listingUrl: 'https://play.example/app' },
    bazaar: { live: false, listingUrl: 'https://bazaar.example/app' },
  };
  const brand = (stores: PublicBrand['stores']) => ({ stores }) as PublicBrand;

  it('shows only live stores, Cafe Bazaar first in Persian', () => {
    expect(storeOrder('fa')).toEqual(['bazaar', 'play']);
    expect(storeOrder('en')).toEqual(['play', 'bazaar']);
    expect(liveStores(brand(base), 'fa')).toEqual([{ id: 'play', listingUrl: 'https://play.example/app' }]);
    expect(liveStores(brand({ ...base, bazaar: { live: true, listingUrl: 'https://bazaar.example/app' } }), 'fa').map((s) => s.id)).toEqual(['bazaar', 'play']);
    expect(liveStores(brand({}), 'en')).toEqual([]);
  });

  it('names a subscription centre for each configured store', () => {
    expect(subscriptionCentres(brand(base), 'en')).toEqual([
      { id: 'play', url: PLAY_SUBSCRIPTIONS_URL },
      { id: 'bazaar', url: undefined },
    ]);
    expect(subscriptionCentres(brand({ bazaar: { live: true, subscriptionsUrl: 'https://bazaar.example/subs' } }), 'en')).toEqual([
      { id: 'bazaar', url: 'https://bazaar.example/subs' },
    ]);
    // A brand that names no store still tells subscribers of both where to cancel.
    expect(subscriptionCentres(brand({}), 'fa').map((c) => c.id)).toEqual(['bazaar', 'play']);
  });
});

describe('content security policy', () => {
  it('allows inline scripts only by hash and forms only to the given origin', () => {
    const source = 'console.log(1)';
    expect(scriptHash(source)).toBe(`'sha256-${createHash('sha256').update(source).digest('base64')}'`);
    const policy = contentSecurityPolicy({ inlineScripts: [source], formAction: ['https://api.example.com'] });
    expect(policy).toContain(`script-src ${scriptHash(source)}`);
    expect(policy).toContain("form-action https://api.example.com 'self'");
    expect(policy).toContain("frame-src 'none'");
    expect(contentSecurityPolicy()).toContain("script-src 'none'");
    expect(contentSecurityPolicy()).toContain("form-action 'none'");
    expect(contentSecurityPolicy({ google: true })).toContain('https://accounts.google.com/gsi/client');
  });
});

describe('imageSize', () => {
  it('reads PNG, JPEG and WebP headers', () => {
    expect(imageSize(new Uint8Array(FIXTURE_PNG))).toEqual({ width: 3, height: 2 });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x00, 0xc8, 0x03]);
    expect(imageSize(jpeg)).toEqual({ width: 200, height: 300 });
    const webp = new Uint8Array(30);
    webp.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
    webp.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8);
    webp.set([0x3f, 0x01, 0x00, 0xef, 0x00, 0x00], 24);
    expect(imageSize(webp)).toEqual({ width: 320, height: 240 });
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});
