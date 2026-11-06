/** The second brand the tests build the site for: stores live, signing certificates, Google sign-in, Persian first. */
export const FIXTURE_BRAND_ID = 'webtest';
export const FIXTURE_APP_NAME = 'Fixture Name';
export const FIXTURE_SITE = 'https://fixture.example';
export const FIXTURE_API_ORIGIN = 'https://api.deletion.test';
export const FIXTURE_GOOGLE_CLIENT_ID = '123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com';
export const FIXTURE_GRACE_DAYS = 14;
export const FIXTURE_PLAY_PACKAGE = 'com.example.fixture';
export const FIXTURE_BAZAAR_PACKAGE = 'com.example.fixture.bz';
export const FIXTURE_PLAY_LISTING = 'https://play.google.com/store/apps/details?id=com.example.fixture';
export const FIXTURE_BAZAAR_LISTING = 'https://cafebazaar.ir/app/com.example.fixture.bz';
export const FIXTURE_PLAY_CERTS = [`${'AB:'.repeat(31)}01`, `${'cd:'.repeat(31)}02`];
export const FIXTURE_BAZAAR_CERT = `${'EF:'.repeat(31)}03`;
export const FIXTURE_SCREENSHOT = 'site/shot.png';

/** A 3×2 PNG. */
export const FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEUlEQVR4nGM4YRTwH4YZkDkAsA8Nt+q6YIwAAAAASUVORK5CYII=',
  'base64',
);

export function fixtureBrand(template: Record<string, unknown>): Record<string, unknown> {
  const android = template['android'] as Record<string, unknown>;
  const localized = (en: string, fa: string, tr: string) => ({ en, fa, tr });
  return {
    ...template,
    id: FIXTURE_BRAND_ID,
    appName: FIXTURE_APP_NAME,
    shortName: 'Fixture',
    defaultLocale: 'fa',
    locales: ['fa', 'en', 'tr'],
    android: {
      ...android,
      applicationId: { play: FIXTURE_PLAY_PACKAGE, bazaar: FIXTURE_BAZAAR_PACKAGE },
      signingCertSha256: { play: FIXTURE_PLAY_CERTS, bazaar: FIXTURE_BAZAAR_CERT },
      googleWebClientId: '',
    },
    domains: { api: 'api.fixture.example', links: 'link.fixture.example', legal: 'fixture.example' },
    stores: {
      play: { listingUrl: FIXTURE_PLAY_LISTING, live: true },
      bazaar: { listingUrl: FIXTURE_BAZAAR_LISTING, live: true },
    },
    legal: {
      privacyUrl: 'https://fixture.example/privacy',
      termsUrl: 'https://fixture.example/terms',
      guidelinesUrl: 'https://fixture.example/rules',
      deleteAccountUrl: 'https://fixture.example/account/delete',
      childSafetyUrl: 'https://fixture.example/child-safety',
      supportUrl: 'https://fixture.example/help',
      supportEmail: 'help@fixture.example',
      securityEmail: 'security@fixture.example',
    },
    site: {
      highlights: [{ title: localized('Highlight one', 'نکته‌ی یک', 'Birinci'), body: localized('Body one', 'متن یک', 'Metin bir') }],
      screenshots: [{ file: FIXTURE_SCREENSHOT, alt: localized('The deck', 'کارت‌ها', 'Kartlar') }],
    },
  };
}
