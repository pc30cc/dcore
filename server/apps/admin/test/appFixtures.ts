import type { AdminBrand, AdminConfigItem, AdminProfileReviewItem, AdminProvider, AdminProviders, AppConfig, ProviderKind, RtcSettingsView } from '@app/shared';
import { adminConfigKeys } from '@app/shared';
import type { Call } from './panel';

/** Shared fixtures of the app area's pages: settings, brand, providers, the calls network and new profiles. */

/** A version as the API writes them (22 characters of base64url). */
export const v = (n: number | string) => `v${String(n)}`.padEnd(22, 'x').slice(0, 22);

export const STORED: Pick<
  AppConfig,
  | 'app.min_version'
  | 'app.maintenance'
  | 'onboarding.waitlist'
  | 'signup.countries'
  | 'calls.enabled'
  | 'limits.rates'
  | 'legal.versions'
  | 'safety.child_safety_contact'
  | 'retention.deleted_account_days'
  | 'retention.message_requests_days'
  | 'retention.unsent_body_hours'
  | 'retention.report_evidence_days'
  | 'retention.unmatched_messages_days'
  | 'auth.sms_routing'
> = {
  'app.min_version': {
    cafe_bazaar: { required: 41, recommended: 44 },
    google_play: { required: 40, recommended: 44 },
  },
  'app.maintenance': { enabled: false, message: { en: 'Back soon.' } },
  'onboarding.waitlist': { enabled: false },
  'signup.countries': {
    default: { allowed: true },
    countries: [{ code: 'IR', allowed: true, unit: 'km', language: 'fa' }],
  },
  'calls.enabled': { audio: true, video: true },
  'limits.rates': {
    swipes_per_hour: 600,
    messages_per_minute: 60,
    messages_per_conversation: 20,
    reports_per_day: 10,
  },
  'legal.versions': { terms: 2, privacy: 3, guidelines: 1 },
  'safety.child_safety_contact': {
    name: 'Safety Team',
    email: 'safety@example.com',
  },
  'retention.deleted_account_days': 30,
  'retention.message_requests_days': 30,
  'retention.unsent_body_hours': 24,
  'retention.report_evidence_days': 180,
  'retention.unmatched_messages_days': 7,
  'auth.sms_routing': {
    routes: [{ prefix: '+98', providers: ['kavenegar', 'smsir'] }],
    default: ['telnyx'],
  },
};

export function item<K extends keyof typeof STORED>(key: K, value: (typeof STORED)[K] = STORED[key], version = v(key)): AdminConfigItem {
  return {
    key,
    value,
    version,
    write: adminConfigKeys[key].write,
    updatedAt: key === 'app.maintenance' ? '2026-11-20T09:30:00.000Z' : null,
    updatedBy: key === 'app.maintenance' ? { id: '1', displayName: 'Leila Moradi' } : null,
  };
}

/** GET /v1/admin/config: the keys asked for, from `values` (the stored ones unless changed). */
export function configList(values: Partial<typeof STORED> = {}) {
  return (call: Call) => {
    const keys = (call.query['keys'] ?? '').split(',').filter(Boolean) as (keyof typeof STORED)[];
    return {
      items: keys.filter((key) => key in STORED).map((key) => item(key, (values[key] ?? STORED[key]) as never)),
    };
  };
}

/** PUT /v1/admin/config/{key}: the stored value at a new version, as the route answers. */
export function configSaved(into: Call[] = []) {
  return (call: Call) => {
    into.push(call);
    const key = decodeURIComponent(call.path.split('/').pop()!) as keyof typeof STORED;
    return {
      item: item(key, (call.body as { value: never }).value, v(`${key}-2`)),
    };
  };
}

export function brandView(overrides: Partial<AdminBrand> = {}): AdminBrand {
  return {
    version: v('brand'),
    brandId: '_template',
    build: {
      appName: 'Spark',
      supportEmail: 'support@example.com',
      privacyUrl: 'https://example.com/privacy',
      termsUrl: 'https://example.com/terms',
      guidelinesUrl: 'https://example.com/guidelines',
      childSafetyUrl: 'https://example.com/child-safety',
      deleteAccountUrl: 'https://example.com/delete',
    },
    saved: { appName: 'Spark Prime' },
    welcomeImages: ['https://cdn.test/w/1.jpg', 'https://other.test/w/2.jpg'],
    linkHosts: ['api.example.com', 'cdn.test', 'example.com', 'link.example.com'],
    mediaOrigin: 'https://cdn.test',
    colors: {
      brand: { light: '#5B2FD9', dark: '#8F6BFF' },
      onBrand: { light: '#FFFFFF', dark: '#0A090E' },
    },
    fonts: { latin: 'Inter', persian: 'Vazirmatn' },
    updatedAt: '2026-11-21T08:00:00.000Z',
    updatedBy: { id: '1', displayName: 'Leila Moradi' },
    ...overrides,
  };
}

const unset = { set: false, fingerprint: null, unreadable: false };
const fp = (fingerprint: string) => ({
  set: true,
  fingerprint,
  unreadable: false,
});

export function provider(kind: ProviderKind, overrides: Partial<AdminProvider> = {}): AdminProvider {
  return {
    kind,
    source: 'none',
    version: v(`p-${kind}`),
    updatedAt: null,
    updatedBy: null,
    panel: null,
    env: { known: kind !== 'fcm', set: false },
    applied: [],
    ...overrides,
  };
}

export function providersView(): AdminProviders {
  return {
    items: [
      provider('kavenegar', {
        source: 'panel',
        updatedAt: '2026-11-22T10:00:00.000Z',
        updatedBy: { id: '1', displayName: 'Leila Moradi' },
        panel: {
          enabled: true,
          settings: { template: 'verify-otp' },
          secrets: { apiKey: fp('a1b2c3d4e5f6') },
        },
        env: {
          known: true,
          set: true,
          settings: { template: 'old-otp' },
          secrets: { apiKey: fp('0f0f0f0f0f0f') },
        },
        applied: [
          {
            process: 'api',
            name: 'api-1:12',
            source: 'panel',
            fingerprint: 'a1b2c3d4e5f6',
            at: '2026-11-28T03:00:00.000Z',
          },
          {
            process: 'api',
            name: 'api-2:13',
            source: 'panel',
            fingerprint: 'a1b2c3d4e5f6',
            at: '2026-11-28T03:00:00.000Z',
          },
          {
            process: 'worker',
            name: 'w-1',
            source: 'env',
            fingerprint: '0f0f0f0f0f0f',
            at: '2026-11-28T03:00:00.000Z',
          },
        ],
      }),
      provider('smsir', {
        source: 'env',
        env: {
          known: true,
          set: true,
          settings: { templateId: 100200, parameter: 'CODE' },
          secrets: { apiKey: fp('bbbbbbbbbbbb') },
        },
      }),
      provider('telnyx'),
      provider('play', {
        source: 'unreadable',
        panel: {
          enabled: true,
          settings: {
            packageName: 'app.example',
            rtdnAudience: null,
            rtdnPushServiceAccountEmail: null,
          },
          secrets: {
            serviceAccountJson: {
              set: true,
              fingerprint: null,
              unreadable: true,
            },
          },
        },
      }),
      provider('bazaar', {
        source: 'off',
        panel: {
          enabled: false,
          settings: {
            packageName: 'app.example',
            rsaPublicKey: 'A'.repeat(120),
            auth: 'pishkhan',
            clientId: null,
          },
          secrets: { pishkhanToken: fp('cccccccccccc') },
        },
      }),
      provider('fcm', {
        source: 'env',
        env: { known: false, set: false },
        applied: [
          {
            process: 'worker',
            name: 'w-1',
            source: 'env',
            fingerprint: 'dddddddddddd',
            at: '2026-11-28T03:00:00.000Z',
          },
        ],
      }),
    ],
    readOnly: {
      storage: {
        configured: true,
        endpoint: 'https://s3.example.com',
        region: 'auto',
        privateBucket: 'media-private',
        mediaBucket: 'media',
        pathStyle: true,
        accessKeyId: fp('111111111111'),
        secretAccessKey: fp('222222222222'),
        cdn: {
          baseUrl: 'https://cdn.example.com',
          scheme: 'hmac',
          signingKey: fp('333333333333'),
        },
      },
      livekit: {
        configured: true,
        apiUrl: 'https://livekit.example.com',
        apiKey: 'APIkey1',
        apiSecret: fp('444444444444'),
        identitySecret: unset,
      },
      moderation: { provider: 'fake', autoApprove: false },
    },
    appliedKnown: true,
  };
}

export function rtcView(overrides: Partial<RtcSettingsView> = {}): RtcSettingsView {
  return {
    wsUrl: null,
    effectiveWsUrl: 'wss://rtc.example.com',
    turnUrls: ['turn:relay.example.com:3478'],
    countries: ['IR'],
    credentialTtlSeconds: 3_600,
    maxLiveCalls: null,
    sharedSecret: { stored: true, fingerprint: '9a8b7c6d5e4f' },
    version: v('rtc'),
    ...overrides,
  };
}

export function review(id: string, overrides: Partial<AdminProfileReviewItem> = {}): AdminProfileReviewItem {
  return {
    user: {
      id,
      name: 'Sara Ahmadi',
      status: 'pending_review',
      age: 27,
      gender: 'woman',
      country: 'IR',
      verified: false,
    },
    locale: 'fa',
    signedUpAt: '2026-11-26T08:00:00.000Z',
    state: 'waiting',
    submittedAt: '2026-11-26T08:10:00.000Z',
    rounds: 0,
    about: 'Hiking and tea.',
    job: 'Designer',
    prompts: [
      {
        position: 0,
        promptId: 1,
        question: { en: 'My perfect Sunday', fa: 'یکشنبه‌ی ایده‌آل من' },
        answer: 'A long walk.',
        status: 'approved',
      },
    ],
    photos: [
      {
        id: '9001',
        position: 0,
        status: 'approved',
        thumbUrl: 'https://cdn.test/p/9001.webp',
      },
      { id: '9002', position: 1, status: 'review' },
    ],
    decision: null,
    ...overrides,
  };
}
