import type { AppConfig } from '@app/shared';

/**
 * The sign-in settings the auth routes read on every request, held in
 * process memory (never read from PostgreSQL on a request path). They start
 * as the values migrations 0003 and 0010 seed; the app_config loader
 * replaces them when the panel changes a key
 * (`app.authSettings.set(authSettingsFromConfig(config))`).
 */
export interface AuthSettings {
  otp: AppConfig['auth.otp'];
  caps: AppConfig['auth.otp_caps'];
  routing: AppConfig['auth.sms_routing'];
  reviewAccounts: AppConfig['auth.review_accounts'];
  /** A refresh session ends after this many days without a refresh. */
  sessionIdleDays: number;
}

export const DEFAULT_AUTH_SETTINGS: AuthSettings = {
  otp: { length: 6, ttl_seconds: 300, max_attempts: 5 },
  caps: {
    resend_seconds: 60,
    phone_daily: 5,
    ip_hourly: 10,
    install_daily: 5,
    verify_ip_hourly: 30,
    prefix_hourly: { '+98': 5000, '+90': 1000, default: 200 },
  },
  routing: { routes: [{ prefix: '+98', providers: ['kavenegar', 'smsir'] }], default: ['telnyx'] },
  reviewAccounts: [],
  sessionIdleDays: 90,
};

export function authSettingsFromConfig(
  config: Pick<AppConfig, 'auth.otp' | 'auth.otp_caps' | 'auth.sms_routing' | 'auth.review_accounts' | 'auth.session_idle_days'>,
): AuthSettings {
  return {
    otp: config['auth.otp'],
    caps: config['auth.otp_caps'],
    routing: config['auth.sms_routing'],
    reviewAccounts: config['auth.review_accounts'],
    sessionIdleDays: config['auth.session_idle_days'],
  };
}

export class AuthSettingsHolder {
  private settings: AuthSettings;

  constructor(initial: AuthSettings = DEFAULT_AUTH_SETTINGS) {
    this.settings = initial;
  }

  get(): AuthSettings {
    return this.settings;
  }

  set(settings: AuthSettings): void {
    this.settings = settings;
  }
}
