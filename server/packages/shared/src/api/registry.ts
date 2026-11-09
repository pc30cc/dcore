import type { z } from 'zod';
import { authResultSchema, googleNonceSchema, otpChallengeSchema, tokenPairSchema } from './auth.js';
import { callAcceptanceSchema, callBodySchema } from './calls.js';
import {
  conversationBodySchema,
  messageRequestsPageSchema,
  messagesPageSchema,
  sentMessageSchema,
  sentRequestBodySchema,
} from './chat.js';
import { callTokenSchema, conversationSchema, notificationPrefsSchema, ownProfileSchema, preferencesSchema, profileCardSchema, settingsSchema } from './common.js';
import { configSchema } from './config.js';
import { exportStartedSchema, exportStatusSchema } from './dataExport.js';
import { deckPageSchema } from './deck.js';
import { deletionPreflightSchema, deletionScheduledSchema, publicDeletionChallengeSchema } from './deletion.js';
import {
  appealBodySchema,
  cityListSchema,
  consentListSchema,
  locationResultSchema,
  meSchema,
  moderationHistorySchema,
  restoredAccountSchema,
} from './me.js';
import { photoCompletedSchema, photoUploadTicketSchema } from './photos.js';
import { realtimeTokenSchema } from './realtime.js';
import { blockListSchema, reportReceiptSchema } from './safety.js';
import { conversationsPageSchema, likesPageSchema, swipesResponseSchema } from './social.js';

/**
 * The response bodies of the routes this package describes, by the name of
 * their example in `fixtures/v1/<name>.json`. The contract tests validate
 * every example against its schema (the server side) and decode the same
 * files with the app's models (the Android side); the "no raw user id"
 * test walks these schemas.
 */
export const responseSchemas = {
  config: configSchema,
  'otp-start': otpChallengeSchema,
  'auth-result': authResultSchema,
  'token-pair': tokenPairSchema,
  'google-nonce': googleNonceSchema,
  me: meSchema,
  'me-onboarding': meSchema,
  'me-deleted': meSchema,
  'own-profile': ownProfileSchema,
  settings: settingsSchema,
  preferences: preferencesSchema,
  notifications: notificationPrefsSchema,
  location: locationResultSchema,
  cities: cityListSchema,
  consents: consentListSchema,
  'photo-upload': photoUploadTicketSchema,
  'photo-complete': photoCompletedSchema,
  deletion: deletionScheduledSchema,
  'deletion-preflight': deletionPreflightSchema,
  'public-deletion-start': publicDeletionChallengeSchema,
  'restore-account': restoredAccountSchema,
  'realtime-token': realtimeTokenSchema,
  moderation: moderationHistorySchema,
  appeal: appealBodySchema,
  'profile-card': profileCardSchema,
  'deck-page': deckPageSchema,
  'swipes-result': swipesResponseSchema,
  'likes-page': likesPageSchema,
  'conversations-page': conversationsPageSchema,
  blocks: blockListSchema,
  report: reportReceiptSchema,
  'messages-page': messagesPageSchema,
  'sent-message': sentMessageSchema,
  conversation: conversationSchema,
  'conversation-body': conversationBodySchema,
  'message-request-sent': sentRequestBodySchema,
  'message-requests-page': messageRequestsPageSchema,
  'call-body': callBodySchema,
  'call-acceptance': callAcceptanceSchema,
  'call-token': callTokenSchema,
  'export-started': exportStartedSchema,
  'export-status': exportStatusSchema,
} as const satisfies Record<string, z.ZodType>;

export type ResponseFixtureName = keyof typeof responseSchemas;
