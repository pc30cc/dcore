import { z } from 'zod';
import type { accountStatus } from '../codes.js';
import {
  appStores,
  callKind,
  callOutcome,
  gender,
  intention,
  likeKind,
  matchSource,
  messageKind,
  photoStatus,
  textState,
  visibleModerationKinds,
  appealStatus,
  walletItem,
} from '../codes.js';

/**
 * The objects many routes share (wire format: JSON, camelCase, lowercase
 * enum strings). Response objects leave out what is unknown instead of
 * sending `null`, unless a field is documented as nullable; requests say
 * "clear this" with an explicit `null` where a route allows it.
 *
 * Ids: a user is only ever named by its {@link publicUidSchema}; every other
 * id is a decimal string (JSON numbers above 2^53 lose precision in
 * JavaScript).
 */

/** A user's public id: base32 (RFC 4648, lowercase, no padding) of a keyed permutation of the user id. */
export const PUBLIC_UID_PATTERN = /^[a-z2-7]{13}$/;
export const publicUidSchema = z.string().regex(PUBLIC_UID_PATTERN, 'must be a public user id');
export type PublicUid = z.infer<typeof publicUidSchema>;

/** Every other id (match, message, photo, call, report, purchase, action): a positive 63-bit integer in decimal. */
export const ID_PATTERN = /^[1-9][0-9]{0,18}$/;
export const idSchema = z
  .string()
  .regex(ID_PATTERN, 'must be a decimal id')
  .refine((value) => value.length < 19 || value <= '9223372036854775807', 'must fit in 63 bits');
export type Id = z.infer<typeof idSchema>;

/** RFC 3339 UTC with milliseconds, `2026-11-06T09:14:03.120Z`. */
export const timeSchema = z.iso.datetime({ offset: false, precision: 3 });
export type Time = z.infer<typeof timeSchema>;

/** Formats a time as the wire wants it. */
export function wireTime(value: Date | number): Time {
  return new Date(value).toISOString();
}

/** A calendar date, `1995-04-02` (the birth date, and nothing else). */
export const dateSchema = z.iso.date();

/** ISO 3166-1 alpha-2, upper case. */
export const countrySchema = z.string().regex(/^[A-Z]{2}$/, 'must be an ISO 3166-1 alpha-2 country code');

export const genderSchema = gender.schema;
export const intentionSchema = intention.schema;
export const appStoreNameSchema = z.enum(appStores);
/** The account states a client is told about (a purged account cannot sign in); a test holds it to the code table. */
export const accountStatusSchema = z.enum([
  'onboarding',
  'pending_review',
  'active',
  'snoozed',
  'suspended',
  'banned',
  'deleted',
] as const satisfies readonly (typeof accountStatus.names)[number][]);
export const photoStatusSchema = photoStatus.schema;
export const textStateSchema = textState.schema;
export const messageKindSchema = messageKind.schema;
export const callKindSchema = callKind.schema;
export const callOutcomeSchema = callOutcome.schema;
export const likeKindSchema = likeKind.schema;
export const conversationSourceSchema = matchSource.schema;
export const walletItemSchema = walletItem.schema;

/** Media and CDN links: https in production; http is accepted for a local development CDN. */
export const httpUrl = z.url({ protocol: /^https?$/ });

/** `true` or absent: flags that are only sent when set. */
const onlyTrue = z.literal(true).optional();

/** An approved photo: signed CDN URL (valid 24 h, aligned to day boundaries), size, blurhash. */
export const photoSchema = z.object({
  id: idSchema,
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  blurhash: z.string().max(64),
  url: httpUrl,
});
export type Photo = z.infer<typeof photoSchema>;

export const peerSummarySchema = z.object({
  id: publicUidSchema,
  name: z.string(),
  photo: photoSchema.nullable(),
  verified: z.boolean(),
});
export type PeerSummary = z.infer<typeof peerSummarySchema>;

/** A city of the server's bundled table (GeoNames ids). */
export const citySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  country: countrySchema.optional(),
});
export type City = z.infer<typeof citySchema>;

/** A rounded distance between cell centres; below 2 km the floor is shown with `lessThan`. */
export const distanceSchema = z.object({
  km: z.number().int().nonnegative(),
  lessThan: onlyTrue,
});

export const profilePromptSchema = z.object({
  promptId: z.number().int().positive(),
  answer: z.string().optional(),
  audioMs: z.number().int().positive().optional(),
  audioUrl: httpUrl.optional(),
});

/** One answered field; which value is set follows the field's kind. */
export const profileFieldValueSchema = z.object({
  fieldId: z.number().int().positive(),
  option: z.number().int().min(1).max(255).optional(),
  options: z.array(z.number().int().min(1).max(255)).optional(),
  number: z.number().int().optional(),
  text: z.string().optional(),
});

/**
 * Someone else's profile. Never contains the birth date, a cell, coordinates,
 * a phone number or anything a moderator has not approved.
 */
export const profileCardSchema = z.object({
  id: publicUidSchema,
  /** The card version: a newer one replaces a cached card. */
  v: z.number().int().positive(),
  name: z.string(),
  age: z.number().int().min(18).optional(),
  gender: genderSchema,
  verified: z.boolean(),
  intention: intentionSchema.optional(),
  job: z.string().optional(),
  about: z.string().optional(),
  city: citySchema.pick({ id: true, name: true }).optional(),
  traveling: onlyTrue,
  distance: distanceSchema.optional(),
  activeRecently: onlyTrue,
  /** Only with the see-likes feature, or when it was a super like. */
  likesYou: onlyTrue,
  superliked: onlyTrue,
  photos: z.array(photoSchema),
  prompts: z.array(profilePromptSchema),
  fields: z.array(profileFieldValueSchema),
});
export type ProfileCard = z.infer<typeof profileCardSchema>;

/**
 * One of the account's own photos, in any state. Size, blurhash and URL are
 * absent while it is processing; `rejectReason` is the text the uploader reads.
 */
export const ownPhotoSchema = z.object({
  id: idSchema,
  position: z.number().int().min(0).max(8),
  status: photoStatusSchema,
  rejectReason: z.string().optional(),
  w: z.number().int().positive().optional(),
  h: z.number().int().positive().optional(),
  blurhash: z.string().max(64).optional(),
  url: httpUrl.optional(),
});
export type OwnPhoto = z.infer<typeof ownPhotoSchema>;

export const ownPromptSchema = profilePromptSchema.extend({
  position: z.number().int().min(0).max(2),
  status: textStateSchema,
});

/**
 * The privacy and visibility switches. `modeRomance` is the deck switch
 * (`profiles.mode_match`): off keeps the person out of discovery.
 */
export const settingsSchema = z.object({
  incognito: z.boolean(),
  hideAge: z.boolean(),
  hideDistance: z.boolean(),
  showOnline: z.boolean(),
  acceptCalls: z.boolean(),
  modeRomance: z.boolean(),
  snoozed: z.boolean(),
});
export type Settings = z.infer<typeof settingsSchema>;

/**
 * The account's own profile: the card without the viewer-relative parts,
 * plus what only its holder sees. Name, gender and birth date are absent
 * until onboarding has set them.
 */
export const ownProfileSchema = z.object({
  id: publicUidSchema,
  v: z.number().int().positive(),
  name: z.string().optional(),
  age: z.number().int().min(18).optional(),
  gender: genderSchema.optional(),
  verified: z.boolean(),
  intention: intentionSchema.optional(),
  job: z.string().optional(),
  about: z.string().optional(),
  city: citySchema.pick({ id: true, name: true }).optional(),
  traveling: onlyTrue,
  activeRecently: onlyTrue,
  photos: z.array(ownPhotoSchema),
  textState: textStateSchema,
  prompts: z.array(ownPromptSchema),
  /** Private fields included. */
  fields: z.array(profileFieldValueSchema),
  completeness: z.number().int().min(0).max(100),
  birthDate: dateSchema.optional(),
  settings: settingsSchema,
});
export type OwnProfile = z.infer<typeof ownProfileSchema>;

/** Advanced filters: a field key to option ids, or a number field's key to `[min, max]`. */
export const filtersSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  z.array(z.number().int()).min(1).max(64),
);

export const preferencesSchema = z.object({
  interestedIn: z.array(genderSchema).min(1),
  ageMin: z.number().int().min(18).max(99),
  ageMax: z.number().int().min(18).max(99),
  maxDistanceKm: z.number().int().min(1).max(500),
  wholeCountry: z.boolean(),
  verifiedOnly: z.boolean(),
  intents: z.array(intentionSchema),
  filters: filtersSchema,
});
export type Preferences = z.infer<typeof preferencesSchema>;

export const notificationPrefsSchema = z.object({
  messages: z.boolean(),
  matches: z.boolean(),
  likes: z.boolean(),
  /** The missed-call notification only, never the ring (a match's call consent is what stops calls). */
  calls: z.boolean(),
  offers: z.boolean(),
  /** Message text and names in notifications; off shows generic texts. */
  previews: z.boolean(),
});
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

export const callLineSchema = z.object({
  callId: idSchema,
  kind: callKindSchema,
  outcome: callOutcomeSchema,
  placedAt: timeSchema,
  durationSeconds: z.number().int().nonnegative(),
  caller: publicUidSchema,
});

export const messageMediaSchema = z.object({
  url: httpUrl,
  mime: z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/),
  w: z.number().int().positive().optional(),
  h: z.number().int().positive().optional(),
  durationMs: z.number().int().positive().optional(),
  blurhash: z.string().max(64).optional(),
});

export const messageSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  senderId: publicUidSchema,
  /** The sender's own id for the message, so its outbox can match it whichever way it arrives first. */
  clientId: z.string().min(1).max(64).optional(),
  kind: messageKindSchema,
  body: z.string().optional(),
  refId: idSchema.optional(),
  media: messageMediaSchema.optional(),
  call: callLineSchema.optional(),
  at: timeSchema,
});
export type Message = z.infer<typeof messageSchema>;

export const conversationSchema = z.object({
  /** The match id. */
  id: idSchema,
  peer: peerSummarySchema.extend({ online: onlyTrue, activeRecently: onlyTrue }),
  state: z.enum(['active', 'ended']),
  source: conversationSourceSchema,
  createdAt: timeSchema,
  lastMessage: messageSchema.nullable(),
  unread: z.number().int().nonnegative(),
  /** Absent while the viewer has read nothing. */
  myReadId: idSchema.optional(),
  /** Only when the viewer has read receipts. */
  peerReadId: idSchema.optional(),
  peerDeliveredId: idSchema.optional(),
  callsAllowed: z.object({ me: z.boolean(), peer: z.boolean() }),
  muted: z.boolean(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const callSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  kind: callKindSchema,
  role: z.enum(['caller', 'callee']),
  state: z.enum(['ringing', 'connecting', 'active', 'ended', 'missed', 'cancelled']),
  outcome: callOutcomeSchema.optional(),
  placedAt: timeSchema,
  ringExpiresAt: timeSchema,
  rangAt: timeSchema.optional(),
  answeredAt: timeSchema.optional(),
  endedAt: timeSchema.optional(),
  durationSeconds: z.number().int().nonnegative().optional(),
  endReason: z.string().optional(),
});
export type Call = z.infer<typeof callSchema>;

export const callTokenSchema = z.object({
  token: z.string().min(1),
  expiresAt: timeSchema,
  wsUrl: z.url({ protocol: /^wss?$/ }),
  turn: z
    .object({ urls: z.array(z.string().regex(/^turns?:/)).min(1), username: z.string(), credential: z.string() })
    .nullable(),
  icePolicy: z.enum(['all', 'relay']),
  warnings: z.array(z.string()),
});

export const quotaSchema = z.object({
  /** -1 is unlimited. */
  limit: z.number().int().min(-1),
  used: z.number().int().nonnegative(),
  resetsAt: timeSchema,
});

/** Feature keys are the server's (snake_case), as `plan_features` names them. */
export const entitlementFeatureKeys = [
  'see_likes',
  'rewind',
  'read_receipts',
  'incognito',
  'travel_mode',
  'advanced_filters',
  'profile_views',
  'second_look',
  'priority_likes',
] as const;

/** Store product ids: neutral, lowercase, the same in both stores (`sub.plus`, `cons.boost.5`). */
export const productIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._]{0,98}$/, 'must be a store product id');
/** A Play subscription's base plan (`m1`); Cafe Bazaar has none. */
export const basePlanIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'must be a base plan id');

export const entitlementsSchema = z.object({
  plan: z.enum(['free', 'plus', 'premium']),
  planExpiresAt: timeSchema.optional(),
  autoRenew: z.boolean().optional(),
  source: z.enum(['bazaar', 'play', 'grant']).optional(),
  manageUrl: httpUrl.optional(),
  /**
   * The store product of the subscription that gives the plan, only when it
   * was bought in the store of this view (a plan change in the store names
   * it); never another store's product, never for a grant.
   */
  productId: productIdSchema.optional(),
  /** Its Play base plan, with `productId`; absent for Cafe Bazaar. */
  basePlanId: basePlanIdSchema.optional(),
  features: z.object(
    Object.fromEntries(entitlementFeatureKeys.map((key) => [key, z.boolean()])) as Record<
      (typeof entitlementFeatureKeys)[number],
      z.ZodBoolean
    >,
  ),
  quotas: z.object({
    likes: quotaSchema.optional(),
    superlikes: quotaSchema.optional(),
    dm: quotaSchema.optional(),
    boosts: quotaSchema.optional(),
  }),
  wallet: z.object({
    superlike: z.number().int().nonnegative(),
    boost: z.number().int().nonnegative(),
    spotlight: z.number().int().nonnegative(),
    dm: z.number().int().nonnegative(),
  }),
  boostEndsAt: timeSchema.optional(),
});
export type Entitlements = z.infer<typeof entitlementsSchema>;

export const appealSchema = z.object({
  id: idSchema,
  status: appealStatus.schema,
  decisionText: z.string().optional(),
});
export type Appeal = z.infer<typeof appealSchema>;

/**
 * A warning, suspension or ban, with the reason its holder reads and the
 * appeal filed against it. A shadowban is never sent.
 */
export const moderationActionSchema = z.object({
  id: idSchema,
  kind: z.enum(visibleModerationKinds),
  reasonText: z.string().min(1),
  startsAt: timeSchema,
  endsAt: timeSchema.optional(),
  appeal: appealSchema.optional(),
});
export type ModerationAction = z.infer<typeof moderationActionSchema>;

/** An empty body: what a 204 or a request without fields carries. */
export const emptySchema = z.object({}).strict();

/** The device as sign-in sends it; nothing here names its holder. */
export const deviceInfoSchema = z.object({
  model: z.string().min(1).max(80),
  osVersion: z.string().min(1).max(40),
  appVersion: z.string().min(1).max(40),
  locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
});
