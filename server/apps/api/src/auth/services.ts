import {
  FailClosedLimits,
  FakeSmsSender,
  JoseGoogleIdTokenVerifier,
  KavenegarSender,
  LoggingSmsSender,
  OtpStore,
  RefreshGrace,
  SmsIrSender,
  SmsRouter,
  TelnyxSender,
  type GoogleIdTokenVerifier,
  type SmsSender,
} from '@app/shared/server';
import fp from 'fastify-plugin';
import { AuthSettingsHolder } from './settings.js';

/**
 * The sign-in services, built once per process from the configuration and
 * shared by every route that sends or checks a code (sign-in, adding a
 * phone, the public deletion page):
 *
 * - `app.sms`: the SMS providers configured here, routed per number by
 *   app_config `auth.sms_routing`;
 * - `app.otp`: OTP challenges in Valkey; `app.limits`: fail-closed limits;
 * - `app.refreshGrace`: the 30-second refresh grace;
 * - `app.google`: the Google ID-token verifier, null when
 *   GOOGLE_WEB_CLIENT_ID is unset;
 * - `app.authSettings`: the auth settings in memory (the config loader
 *   updates them).
 */

declare module 'fastify' {
  interface FastifyInstance {
    authSettings: AuthSettingsHolder;
    sms: SmsRouter;
    otp: OtpStore;
    limits: FailClosedLimits;
    refreshGrace: RefreshGrace;
    google: GoogleIdTokenVerifier | null;
  }
}

export interface AuthServicesOptions {
  /** Senders to use instead of the configured providers (tests). */
  smsSenders?: readonly SmsSender[] | undefined;
  /** A verifier to use instead of Google's keys (tests). */
  google?: GoogleIdTokenVerifier | undefined;
  authSettings?: AuthSettingsHolder | undefined;
  /** The refresh grace (30 s); tests shorten it. */
  refreshGraceMs?: number | undefined;
}

export const authServicesPlugin = fp<AuthServicesOptions>(
  async (app, options) => {
    const { sms, google } = app.config;
    let senders: SmsSender[];
    let fallback: SmsSender | undefined;
    if (options.smsSenders) {
      senders = [...options.smsSenders];
    } else {
      senders = [];
      if (sms.kavenegar) senders.push(new KavenegarSender({ ...sms.kavenegar, timeoutMs: sms.timeoutMs }));
      if (sms.smsir) senders.push(new SmsIrSender({ ...sms.smsir, timeoutMs: sms.timeoutMs }));
      if (sms.telnyx) senders.push(new TelnyxSender({ ...sms.telnyx, timeoutMs: sms.timeoutMs }));
      // Never in production (the configuration refuses it): routed to as `fake`, and the stand-in for unconfigured providers.
      if (sms.fake === 'memory') fallback = new FakeSmsSender('fake');
      if (sms.fake === 'log') fallback = new LoggingSmsSender((line) => app.log.info(line));
      if (fallback) senders.push(fallback);
    }
    app.log.info({ providers: senders.map((s) => s.name) }, 'sms providers');

    app.decorate('authSettings', options.authSettings ?? new AuthSettingsHolder());
    app.decorate('sms', new SmsRouter(senders, { fallback }));
    app.decorate('otp', new OtpStore({ redis: app.redis, keys: app.keys, hasher: app.secrets.hasher, sealer: app.secrets.sealer }));
    app.decorate('limits', new FailClosedLimits(app.redis));
    app.decorate('refreshGrace', new RefreshGrace({ redis: app.redis, keys: app.keys, graceMs: options.refreshGraceMs }));
    app.decorate('google', options.google ?? (google.webClientId ? new JoseGoogleIdTokenVerifier() : null));
  },
  { name: 'auth-services', fastify: '5.x' },
);
