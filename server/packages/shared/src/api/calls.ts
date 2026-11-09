import { z } from 'zod';
import { callKindSchema, callSchema, callTokenSchema, idSchema } from './common.js';

/**
 * Calls between the two people of an active conversation (`/v1/calls`),
 * and the RTC settings of the admin panel (`/v1/admin/providers/rtc`).
 */

export const placeCallSchema = z.strictObject({
  conversationId: idSchema,
  kind: callKindSchema,
});
export type PlaceCall = z.infer<typeof placeCallSchema>;

export const callParamsSchema = z.object({ id: idSchema });

/** Every call route answers with the call as the asker sees it. */
export const callBodySchema = z.object({ call: callSchema });

/** The answer to accepting a ring: the call, now connecting, and the token to join its room. */
export const callAcceptanceSchema = z.object({ call: callSchema, token: callTokenSchema });

/** The routes a phone of the callee calls with nothing in the body. */
export const emptyCallBodySchema = z.strictObject({}).optional();

const turnUrl = z.string().min(1).max(300);

/** What the admin panel shows: the secret only as whether one is stored and its fingerprint. */
export const rtcSettingsViewSchema = z.object({
  /** The signalling URL clients are given, as stored (an origin); null: the brand's `rtc` host. */
  wsUrl: z.string().nullable(),
  /** The signalling URL clients get now (the stored one, else the brand's). */
  effectiveWsUrl: z.string().nullable(),
  turnUrls: z.array(z.string()),
  countries: z.array(z.string()),
  credentialTtlSeconds: z.number().int(),
  maxLiveCalls: z.number().int().nullable(),
  sharedSecret: z.object({
    stored: z.boolean(),
    /** 12 hex digits of the secret's SHA-256; null when none is stored or it cannot be opened. */
    fingerprint: z.string().regex(/^[0-9a-f]{12}$/).nullable(),
  }),
});
export type RtcSettingsView = z.infer<typeof rtcSettingsViewSchema>;

/** A change: absent fields stay; `sharedSecret` is write-only ('' removes it). */
export const rtcSettingsPatchSchema = z.strictObject({
  wsUrl: z.string().max(300).nullable().optional(),
  turnUrls: z.array(turnUrl).max(8).optional(),
  sharedSecret: z.string().max(512).optional(),
  countries: z.array(z.string().max(8)).max(64).optional(),
  credentialTtlSeconds: z.number().int().optional(),
  maxLiveCalls: z.number().int().min(0).max(1_000_000).nullable().optional(),
});
export type RtcSettingsPatchBody = z.infer<typeof rtcSettingsPatchSchema>;
