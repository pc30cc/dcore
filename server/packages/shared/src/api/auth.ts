import { z } from 'zod';
import { localeSchema } from '../locale.js';
import { accountStatusSchema, deviceInfoSchema, publicUidSchema, timeSchema } from './common.js';

/**
 * Sign-in, refresh and sign-out (`/v1/auth/*`) and adding or changing the
 * phone of a signed-in account (`/v1/me/phone/*`).
 */

/** E.164: `+`, country code, subscriber number, 8-15 digits in all. */
export const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;
export const e164Schema = z.string().regex(E164_PATTERN, 'phone_invalid');

/** The 11-character hash the SMS Retriever API matches an SMS against. */
const smsAppHash = z.string().regex(/^[A-Za-z0-9+/]{11}$/);
/** SHA-256 (hex) of the platform's per-app device id. */
export const deviceKeySchema = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters');
/** A random UUID the app makes once per install. */
export const installIdSchema = z.uuid();
/** An OTP challenge's id: opaque, URL-safe. */
export const challengeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const otpCodeSchema = z.string().regex(/^[0-9]{4,8}$/, 'otp_invalid');

export const otpChannelSchema = z.enum(['sms', 'call']);

export const otpStartRequestSchema = z.object({
  phone: e164Schema,
  channel: otpChannelSchema.optional(),
  locale: localeSchema,
  smsAppHash: smsAppHash.optional(),
  /** A Play Integrity token, in the play build only. */
  integrityToken: z.string().min(1).max(8192).optional(),
});
export type OtpStartRequest = z.infer<typeof otpStartRequestSchema>;

export const otpChallengeSchema = z.object({
  challengeId: challengeIdSchema,
  codeLength: z.number().int().min(4).max(8),
  ttlSeconds: z.number().int().positive(),
  resendAfterSeconds: z.number().int().nonnegative(),
  channel: otpChannelSchema,
});
export type OtpChallenge = z.infer<typeof otpChallengeSchema>;

export const otpVerifyRequestSchema = z.object({
  challengeId: challengeIdSchema,
  code: otpCodeSchema,
  installId: installIdSchema,
  deviceKey: deviceKeySchema,
  device: deviceInfoSchema,
});
export type OtpVerifyRequest = z.infer<typeof otpVerifyRequestSchema>;

/** The account a session belongs to. */
export const authUserSchema = z.object({
  id: publicUidSchema,
  status: accountStatusSchema,
  onboardingStep: z.number().int().min(0).max(50),
});
export type AuthUser = z.infer<typeof authUserSchema>;

/** `rt1.<session id>.<32 random bytes, base64url>`. */
export const REFRESH_TOKEN_PATTERN = /^rt1\.[1-9][0-9]{0,18}\.[A-Za-z0-9_-]{43}$/;
export const refreshTokenSchema = z.string().regex(REFRESH_TOKEN_PATTERN, 'refresh_invalid');

export const tokenPairSchema = z.object({
  accessToken: z.string().min(1),
  accessExpiresAt: timeSchema,
  refreshToken: refreshTokenSchema,
  refreshExpiresAt: timeSchema,
});
export type TokenPair = z.infer<typeof tokenPairSchema>;

export const authResultSchema = tokenPairSchema.extend({
  user: authUserSchema,
  isNew: z.boolean(),
});
export type AuthResult = z.infer<typeof authResultSchema>;

export const googleNonceSchema = z.object({
  nonceId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  ttlSeconds: z.number().int().positive(),
});
export type GoogleNonce = z.infer<typeof googleNonceSchema>;

export const googleSignInRequestSchema = z.object({
  idToken: z.string().min(1).max(8192),
  nonceId: googleNonceSchema.shape.nonceId,
  installId: installIdSchema,
  deviceKey: deviceKeySchema,
  device: deviceInfoSchema,
});
export type GoogleSignInRequest = z.infer<typeof googleSignInRequestSchema>;

export const refreshRequestSchema = z.object({ refreshToken: refreshTokenSchema });

export const logoutRequestSchema = z.object({
  /** Every session of the account, not only this one. */
  all: z.boolean().optional(),
});

export const phoneStartRequestSchema = otpStartRequestSchema.pick({ phone: true, channel: true, locale: true, smsAppHash: true });
export const phoneVerifyRequestSchema = z.object({ challengeId: challengeIdSchema, code: otpCodeSchema });
